import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, resolveRelayTarget } from '../server/index.js';
import { loadBackends } from '../server/backends.js';

const SERVER_JEV_KEY = 'server-jev-key-123';
const SERVER_LAYA_KEY = 'server-laya-key-456';
const PAGES = 'https://wubugui.github.io';
let upstream;
let upstreamPort;
let seen = []; // 上游收到的请求：{ path, auth, body }
let app;
let base;
let dir;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  // 假上游：同时扮演 Jev（/jev/v1/systemone）和局域网 Laya（/v1/systemone）
  //   /health 不用鉴权；没带密钥返回 Laya 格式的 401；成功时带 Jev 没有的字段；每次报告 1000 个输入 token
  upstream = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', loaded: { laya: 'cpu' } }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization;
      seen.push({ path: req.url, auth, body: JSON.parse(body || '{}') });
      if (!auth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }));
      }
      const q = JSON.parse(body).questions;
      const answers = Object.fromEntries(Object.entries(q).map(([k, v]) => {
        const first = Object.keys(v.criteria)[0];
        return [k, { type: 'choice', choice: first, probabilities: { [first]: 1 }, confidence: 1, action: 'act' }];
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'fake-1', answers,
        usage: { input_tokens: 1000, output_tokens: 10, cost: 0, state_tokens: 300 },
        routing: { model: 'fake-1', reason: 'test' }, latency_ms: 42, warnings: ['state truncated to 512 tokens'],
      }));
    });
  });
  upstreamPort = await listen(upstream);

  dir = mkdtempSync(path.join(tmpdir(), 'tank-test-'));
  writeFileSync(path.join(dir, 'backends.json'), JSON.stringify({
    backends: [
      { id: 'laya', url: 'http://127.0.0.1:1/v1/systemone', healthUrl: 'http://127.0.0.1:1/health', baseUrlEnv: 'LAYA_BASE_URL', apiKeyEnv: 'LAYA_API_KEY', model: 'laya', pricePerMTok: 0, maxRps: 100 },
      { id: 'jev', url: `http://127.0.0.1:${upstreamPort}/jev/v1/systemone`, model: 'jev-latest', apiKeyEnv: 'JEV_API_KEY', apiKeyRequired: true, pricePerMTok: 1, maxRps: 100 },
    ],
  }));
  // 用服务端 key 调 Jev 每次 $0.001；上限 $0.0022 → 第 3 次被拦下
  app = createApp({
    port: 3999,
    env: { JEV_API_KEY: SERVER_JEV_KEY, LAYA_BASE_URL: `http://127.0.0.1:${upstreamPort}/`, LAYA_API_KEY: SERVER_LAYA_KEY },
    backendsFile: path.join(dir, 'backends.json'),
    budgetFile: path.join(dir, 'usage.json'),
    logDir: path.join(dir, 'logs'),
    budgetUsd: 0.0022,
  });
  base = `http://127.0.0.1:${await listen(app.server)}`;
});

after(() => {
  app.server.close();
  upstream.close();
});

const question = { tactic: { type: 'choice', instructions: 'pick', criteria: { a: 'A', b: 'B' } } };
async function relay(body, { origin = PAGES, contentType = 'application/json' } = {}) {
  const headers = { 'Content-Type': contentType };
  if (origin) headers.Origin = origin;
  const r = await fetch(`${base}/api/relay`, { method: 'POST', headers, body: JSON.stringify({ state: { you: 1 }, questions: question, ...body }) });
  return { status: r.status, json: await r.json(), headers: r.headers };
}

test('健康检查只说有没有配置，不泄露 key 和地址', async () => {
  const r = await fetch(`${base}/api/health`, { headers: { Origin: PAGES } });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), PAGES);
  for (const secret of [SERVER_JEV_KEY, SERVER_LAYA_KEY, String(upstreamPort)]) assert.ok(!text.includes(secret), `不应包含 ${secret}`);
  const j = JSON.parse(text);
  assert.equal(j.app, 'npc-tank-relay');
  assert.deepEqual(j.server, { jev: { hasKey: true }, laya: { hasUrl: true, hasKey: true } });
});

test('跨域：白名单来源放行（含 Chrome 私有网络预检），其它来源一律 403', async () => {
  const pre = await fetch(`${base}/api/relay`, {
    method: 'OPTIONS',
    headers: { Origin: PAGES, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), PAGES);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  assert.match(pre.headers.get('access-control-allow-headers'), /Content-Type/i);
  const local = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:3999' } });
  assert.equal(local.status, 200, '本机页面（同端口）也放行');
  const evil = await relay({ backend: 'jev' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const evilPre = await fetch(`${base}/api/relay`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(evilPre.status, 403);
  assert.equal(evilPre.headers.get('access-control-allow-origin'), null);
});

test('只接受 JSON：防止别的网页用“简单请求”驱动中转', async () => {
  const before = seen.length;
  const r = await relay({ backend: 'jev' }, { contentType: 'text/plain' });
  assert.equal(r.status, 415);
  assert.equal(seen.length, before, '没有转发到上游');
});

test('Jev：页面带 key 就用页面的 key，不计服务端账本；不带就用 .env 的 key 并受 BUDGET_USD 约束', async () => {
  seen = [];
  const withKey = await relay({ backend: 'jev', apiKey: 'player-key' });
  assert.equal(withKey.status, 200);
  assert.equal(seen.at(-1).auth, 'Bearer player-key');
  assert.equal(withKey.json.cost_usd, 0.001, '花费照样算出来返回给页面');
  assert.equal(app.budget.snapshot().spent_usd, 0, '页面自己的 key 不计入服务端账本');

  const a = await relay({ backend: 'jev' });
  const b = await relay({ backend: 'jev' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(seen.at(-1).auth, `Bearer ${SERVER_JEV_KEY}`);
  assert.equal(app.budget.snapshot().spent_usd, 0.002);
  const c = await relay({ backend: 'jev' });
  assert.equal(c.status, 402);
  assert.equal(c.json.budgetExhausted, true);
  const d = await relay({ backend: 'jev', apiKey: 'player-key' });
  assert.equal(d.status, 200, '服务端预算用完不影响玩家用自己的 key');
});

test('Jev 的地址不能被页面改掉；model 可以指定', async () => {
  seen = [];
  const r = await relay({ backend: 'jev', apiKey: 'k', url: 'https://evil.example/v1/systemone', model: 'jev-1.13.0' });
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).path, '/jev/v1/systemone');
  assert.equal(seen.at(-1).body.model, 'jev-1.13.0');
});

test('Laya：页面填的 endpoint 和 key 优先；.env 的 key 只用于 .env 里的那个地址', async () => {
  seen = [];
  const envUrl = `http://127.0.0.1:${upstreamPort}/v1/systemone`;
  // 1) 页面什么都不填 → .env 的地址 + .env 的 key
  const a = await relay({ backend: 'laya' });
  assert.equal(a.status, 200);
  assert.equal(seen.at(-1).auth, `Bearer ${SERVER_LAYA_KEY}`);
  assert.deepEqual(a.json.warnings, ['state truncated to 512 tokens']);
  assert.equal(a.json.upstream_latency_ms, 42);
  assert.equal(a.json.routing.model, 'fake-1');
  // 2) 页面填了同一个地址但没填 key → 仍用 .env 的 key
  await relay({ backend: 'laya', url: envUrl });
  assert.equal(seen.at(-1).auth, `Bearer ${SERVER_LAYA_KEY}`);
  // 3) 页面填了别的地址 → 不能带上 .env 的 key
  const other = `http://localhost:${upstreamPort}/v1/systemone`;
  const c = await relay({ backend: 'laya', url: other });
  assert.equal(seen.at(-1).auth, undefined, '不同地址不带服务端 key');
  assert.equal(c.status, 401);
  assert.match(c.json.error, /authentication_error: invalid api key/);
  // 4) 页面带了自己的 key
  await relay({ backend: 'laya', url: other, apiKey: 'player-laya' });
  assert.equal(seen.at(-1).auth, 'Bearer player-laya');
});

test('中转目标校验：只能是 jev/laya，路径必须是 systemone，协议只能 http(s)', async () => {
  assert.equal((await relay({ backend: 'mock' })).status, 400);
  assert.equal((await relay({ backend: 'laya', url: `http://127.0.0.1:${upstreamPort}/admin` })).status, 400);
  assert.equal((await relay({ backend: 'laya', url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await relay({ backend: 'laya', url: 'not a url' })).status, 400);
  assert.equal((await relay({ backend: 'jev', questions: {} })).status, 400);
  const backends = loadBackends(path.join(dir, 'backends.json'), {}, 3000);
  assert.throws(() => resolveRelayTarget({ backend: 'jev' }, backends), /没有 Jev key/);
});

test('连不上的 Laya 返回 502，不会挂住', async () => {
  const r = await relay({ backend: 'laya', url: 'http://127.0.0.1:1/v1/systemone' });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /调用 laya 失败/);
});

test('决策日志写入 jsonl，记录用的是谁的 key（不记录 key 本身）', async () => {
  await new Promise((r) => setTimeout(r, 100));
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, 'logs', `decisions-${day}.jsonl`);
  assert.ok(existsSync(file));
  const raw = readFileSync(file, 'utf8');
  for (const secret of [SERVER_JEV_KEY, SERVER_LAYA_KEY, 'player-key', 'player-laya']) assert.ok(!raw.includes(secret));
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.backend === 'jev' && l.key === 'client'));
  assert.ok(lines.some((l) => l.backend === 'jev' && l.key === 'server'));
  assert.ok(lines.some((l) => l.backend === 'laya' && l.warnings.length === 1));
});

test('静态文件不允许越出 public 目录；首页能打开', async () => {
  const r = await fetch(`${base}/..%2F.env`);
  assert.notEqual(r.status, 200);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /坦克大战/);
});
