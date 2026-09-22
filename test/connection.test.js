import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callBackend, describeBackend, systemOneUrl, mixedContentProblem, normalizeRelayUrl,
  defaultSettings, loadSettings, saveSettings, clearSavedSettings, loadLedger, resetLedger, probeRelay,
} from '../public/js/connection.js';
import { DEFAULT_RELAY_URL } from '../public/js/site-config.js';

// Node 里没有 localStorage / sessionStorage，补一个内存版
class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
});

// 假 fetch：记录请求，按 url 返回
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers || {}, body });
    const { status = 200, json } = await handler(url, body, init);
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
const payload = { state: { a: 1 }, questions: { tactic: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } } } };
const answer = { answers: { tactic: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.5 } } };

test('地址处理：Laya 根地址自动补 /v1/systemone，完整地址保持不变', () => {
  assert.equal(systemOneUrl('http://192.168.1.2:8790'), 'http://192.168.1.2:8790/v1/systemone');
  assert.equal(systemOneUrl('http://192.168.1.2:8790/'), 'http://192.168.1.2:8790/v1/systemone');
  assert.equal(systemOneUrl('https://h/prefix/v1/systemone'), 'https://h/prefix/v1/systemone');
  assert.equal(systemOneUrl('https://h/api/alpha/decisions'), 'https://h/api/alpha/decisions');
  assert.equal(systemOneUrl(''), '');
  assert.equal(systemOneUrl('not a url'), '');
  assert.equal(normalizeRelayUrl(' http://localhost:3000/ '), 'http://localhost:3000');
});

test('混合内容：https 页面不能直连 http 局域网地址，但 localhost 可以', () => {
  assert.match(mixedContentProblem('http://192.168.1.2:8790/v1/systemone', 'https:'), /拦截/);
  assert.equal(mixedContentProblem('http://localhost:8790/v1/systemone', 'https:'), null);
  assert.equal(mixedContentProblem('http://127.0.0.1:8790/v1/systemone', 'https:'), null);
  assert.equal(mixedContentProblem('https://laya.example/v1/systemone', 'https:'), null);
  assert.equal(mixedContentProblem('http://192.168.1.2:8790/v1/systemone', 'http:'), null);
});

test('设置：勾“记住”存 localStorage，不勾存 sessionStorage；清除后恢复默认', () => {
  const s = defaultSettings();
  s.jev.key = 'k1';
  saveSettings(s);
  assert.ok(localStorage.getItem('npc-tank-connection-v1').includes('k1'));
  assert.equal(sessionStorage.getItem('npc-tank-connection-v1'), null);
  s.remember = false;
  saveSettings(s);
  assert.equal(localStorage.getItem('npc-tank-connection-v1'), null);
  assert.ok(sessionStorage.getItem('npc-tank-connection-v1').includes('k1'));
  assert.equal(loadSettings().jev.key, 'k1');
  clearSavedSettings();
  assert.equal(loadSettings().jev.key, '');
  assert.equal(loadSettings(true).relayUrl, '', '同源中转时默认留空');
  assert.equal(loadSettings(false).relayUrl, DEFAULT_RELAY_URL, '线上版默认用站点配置的中转');
});

test('状态说明：Jev 必须经中转且要有 key；Laya 直连会检查混合内容', () => {
  const s = defaultSettings();
  const online = { ok: true, server: {} };
  assert.match(describeBackend('jev', s, { ok: false }).note, /必须经中转/);
  assert.equal(describeBackend('jev', s, online).ok, false);
  assert.equal(describeBackend('jev', s, { ok: true, server: { jev: { hasKey: true } } }).ok, true, '中转服务端有 key 也行');
  s.jev.key = 'k';
  assert.equal(describeBackend('jev', s, online).ok, true);
  assert.equal(describeBackend('laya', s, online).ok, false, '没填 endpoint');
  s.laya.url = 'http://192.168.1.2:8790';
  assert.equal(describeBackend('laya', s, online).ok, true, '经本地中转可以用局域网 http 地址');
  assert.match(describeBackend('laya', s, { ok: true, kind: 'worker', server: {} }).note, /只能转发 https/, 'Cloudflare 中转访问不到局域网');
  s.laya.url = 'https://laya.example';
  assert.equal(describeBackend('laya', s, { ok: true, kind: 'worker', server: {} }).ok, true);
  s.laya.url = 'http://192.168.1.2:8790';
  s.laya.route = 'direct';
  globalThis.location = { protocol: 'https:' };
  assert.equal(describeBackend('laya', s, online).ok, false);
  delete globalThis.location;
  assert.equal(describeBackend('mock', s, null).ok, true);
});

test('Jev 经中转：请求体带 key 和 model，按 usage 记本浏览器账本', async () => {
  const s = defaultSettings();
  s.jev.key = 'player-key';
  s.jev.model = 'jev-1.13.0';
  const f = fakeFetch(() => ({ json: { ...answer, model: 'jev-1.13.0', usage: { input_tokens: 1000 }, latency_ms: 250 } }));
  const r = await callBackend('jev', payload, s, f);
  assert.equal(f.calls[0].url, `${DEFAULT_RELAY_URL}/api/relay`);
  assert.equal(f.calls[0].body.backend, 'jev');
  assert.equal(f.calls[0].body.apiKey, 'player-key');
  assert.equal(f.calls[0].body.model, 'jev-1.13.0');
  assert.equal(f.calls[0].headers.Authorization, undefined, 'key 只在请求体里给中转，不走 Authorization');
  assert.equal(r.answers.tactic.choice, 'a');
  assert.equal(r.cost_usd, 0.000042);
  assert.equal(r.upstream_latency_ms, 250);
  assert.equal(loadLedger().requests, 1);
  assert.equal(Math.round(loadLedger().spent_usd * 1e6), 42);
});

test('Jev 本浏览器花费上限：到了就不再发请求', async () => {
  const s = defaultSettings();
  s.jev.key = 'k';
  s.jev.budgetUsd = 0.0001;
  const f = fakeFetch(() => ({ json: { ...answer, usage: { input_tokens: 2000 } } }));
  await callBackend('jev', payload, s, f); // 花 $0.000084
  await assert.rejects(callBackend('jev', payload, s, f), (e) => e.budgetExhausted === true);
  assert.equal(f.calls.length, 1);
  resetLedger();
  await callBackend('jev', payload, s, f);
  assert.equal(f.calls.length, 2, '清零后可以继续');
});

test('Laya 直连：Authorization 头带 key，错误格式 {error:{type,message}} 能读出来', async () => {
  const s = defaultSettings();
  s.laya = { url: 'http://localhost:8790', key: 'laya-k', model: '', route: 'direct' };
  const ok = fakeFetch(() => ({ json: { ...answer, model: 'laya', latency_ms: 900, warnings: ['state truncated'] } }));
  const r = await callBackend('laya', payload, s, ok);
  assert.equal(ok.calls[0].url, 'http://localhost:8790/v1/systemone');
  assert.equal(ok.calls[0].headers.Authorization, 'Bearer laya-k');
  assert.equal(ok.calls[0].body.model, 'laya');
  assert.deepEqual(r.warnings, ['state truncated']);
  assert.equal(r.cost_usd, 0);
  const bad = fakeFetch(() => ({ status: 401, json: { error: { message: 'invalid api key', type: 'authentication_error' } } }));
  await assert.rejects(callBackend('laya', payload, s, bad), /authentication_error: invalid api key/);
});

test('Laya 经中转：endpoint 和 key 放在请求体里交给中转', async () => {
  const s = defaultSettings();
  s.relayUrl = 'https://my-relay.workers.dev';
  s.laya = { url: 'https://laya.example', key: 'lk', model: 'laya-multilingual', route: 'relay' };
  const f = fakeFetch(() => ({ json: answer }));
  await callBackend('laya', payload, s, f);
  assert.equal(f.calls[0].url, 'https://my-relay.workers.dev/api/relay');
  assert.deepEqual(
    { backend: f.calls[0].body.backend, url: f.calls[0].body.url, apiKey: f.calls[0].body.apiKey, model: f.calls[0].body.model },
    { backend: 'laya', url: 'https://laya.example/v1/systemone', apiKey: 'lk', model: 'laya-multilingual' },
  );
});

test('连不上时给出可读的错误，不会抛出奇怪的异常', async () => {
  const s = defaultSettings();
  s.laya = { url: 'http://localhost:1', key: '', model: '', route: 'direct' };
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(callBackend('laya', payload, s, down), /连不上/);
  const relay = await probeRelay('http://localhost:1', down);
  assert.equal(relay.ok, false);
  assert.equal(relay.note, '连不上');
  assert.match((await probeRelay('https://x.y.workers.dev', down)).note, /workers.dev 域名在中国大陆等地区被屏蔽/);
  const notOurs = await probeRelay('http://x', fakeFetch(() => ({ json: { hello: 1 } })));
  assert.equal(notOurs.note, '不是本项目的中转服务');
});

test('Mock 在浏览器内运行，不联网', async () => {
  const f = fakeFetch(() => ({ json: {} }));
  const r = await callBackend('mock', payload, defaultSettings(), f);
  assert.equal(f.calls.length, 0);
  assert.ok(['a', 'b'].includes(r.answers.tactic.choice));
});
