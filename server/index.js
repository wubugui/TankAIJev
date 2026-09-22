import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBackends, callBackend, BackendError } from './backends.js';
import { Budget } from './budget.js';

// 本地服务 = 静态文件服务器 + 中转（relay）。
// 中转存在的原因：Jev 拒绝浏览器跨域调用；https 页面也不能访问 http 局域网地址。
// 页面（本机 http://localhost:3000，或 GitHub Pages）把 { backend, url?, apiKey?, state, questions } 发到 POST /api/relay，
// 这里再转发给 Jev / Laya。页面没带 key 时，用 .env 里配置的 key（只对 .env 里配置的那个地址生效）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const RELAY_PATHS = ['/v1/systemone', '/alpha/decisions', '/api/alpha/decisions'];
export const DEFAULT_CORS_ORIGINS = ['https://wubugui.github.io'];

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BackendError(413, '请求体太大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BackendError(400, '请求体不是合法 JSON');
  }
}

function validateDecision(body) {
  if (!body || typeof body !== 'object') return '缺少请求体';
  if (typeof body.backend !== 'string') return '缺少 backend';
  if (body.state === undefined) return '缺少 state';
  if (!body.questions || typeof body.questions !== 'object') return '缺少 questions';
  const n = Object.keys(body.questions).length;
  if (n < 1 || n > 8) return 'questions 数量应为 1~8';
  return null;
}

// 允许跨域访问中转的网页来源：.env 的 CORS_ORIGINS（逗号分隔）+ 本机页面
export function corsOrigins(env, port) {
  const list = env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CORS_ORIGINS;
  return new Set([...list.map((o) => o.replace(/\/+$/, '')), `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

// 算出这次中转要打到哪里、用谁的 key
export function resolveRelayTarget(body, backends) {
  const conf = backends.find((b) => b.id === body.backend);
  if (!conf || (conf.id !== 'jev' && conf.id !== 'laya')) throw new BackendError(400, 'backend 只能是 jev 或 laya');
  // Jev 的地址固定（官方地址或 .env 的 JEV_URL），不接受页面指定，免得被当成任意转发器
  const raw = conf.id === 'laya' && typeof body.url === 'string' && body.url.trim() ? body.url.trim() : conf.url;
  let url;
  try { url = new URL(raw); } catch { throw new BackendError(400, `endpoint 不是合法地址：${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BackendError(400, 'endpoint 只能是 http 或 https');
  if (!RELAY_PATHS.some((p) => url.pathname.endsWith(p))) throw new BackendError(400, `endpoint 路径必须以 ${RELAY_PATHS.join(' / ')} 结尾`);
  const clientKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const sameAsServer = url.href === new URL(conf.url).href;
  const apiKey = clientKey || (sameAsServer ? conf.apiKey : '');
  if (conf.id === 'jev' && !apiKey) throw new BackendError(400, '没有 Jev key：请在游戏的“AI 连接设置”里填写');
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : conf.model;
  return { target: { ...conf, url: url.href, apiKey, model }, serverKey: !clientKey && Boolean(apiKey) };
}

export function createApp({ port = 3000, env = process.env, backendsFile, budgetFile, logDir, budgetUsd } = {}) {
  const backends = loadBackends(backendsFile || path.join(ROOT, 'config', 'backends.json'), env, port);
  const limit = budgetUsd ?? Number(env.BUDGET_USD || 1);
  const budget = new Budget(budgetFile || path.join(ROOT, 'data', 'usage.json'), limit);
  const logsDir = logDir === null ? null : logDir || path.join(ROOT, 'data', 'logs');
  const logEnabled = logsDir && env.DECISION_LOG !== '0';
  const origins = corsOrigins(env, port);

  async function logDecision(entry) {
    if (!logEnabled) return;
    try {
      await mkdir(logsDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      await appendFile(path.join(logsDir, `decisions-${day}.jsonl`), JSON.stringify(entry) + '\n');
    } catch {
      // 日志失败不影响游戏
    }
  }

  function health() {
    const jev = backends.find((b) => b.id === 'jev');
    const laya = backends.find((b) => b.id === 'laya');
    return {
      ok: true,
      app: 'npc-tank-relay',
      kind: 'local',
      // 只说“有没有”，绝不返回 key 或内网地址本身
      server: {
        jev: { hasKey: Boolean(jev?.apiKey) },
        laya: { hasUrl: Boolean(laya?.urlFromEnv), hasKey: Boolean(laya?.apiKey) },
      },
      budget: budget.snapshot(),
    };
  }

  async function relay(req, res, cors) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      // 强制 JSON：浏览器对 JSON 请求一定先发跨域预检，别的网站就没法用“简单请求”偷偷驱动中转
      return sendJson(res, 415, { error: '只接受 application/json' }, cors);
    }
    const body = await readBody(req);
    const bad = validateDecision(body);
    if (bad) return sendJson(res, 400, { error: bad }, cors);
    const { target, serverKey } = resolveRelayTarget(body, backends);
    // 用 .env 里的 key 时受 BUDGET_USD 约束；用页面填的 key 时由页面自己的上限管
    const result = await callBackend(target, body, budget, { charge: serverKey });
    logDecision({
      ts: new Date().toISOString(),
      backend: target.id,
      key: serverKey ? 'server' : target.apiKey ? 'client' : 'none',
      model: result.model,
      agent: body.agent,
      latency_ms: result.latency_ms,
      upstream_latency_ms: result.upstream_latency_ms,
      routing: result.routing,
      warnings: result.warnings,
      usage: result.usage,
      state: body.state,
      options: Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, q.criteria])),
      answers: result.answers,
    });
    return sendJson(res, 200, result, cors);
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isApi = url.pathname.startsWith('/api/');
    const origin = req.headers.origin;
    let cors = {};
    try {
      if (isApi && origin) {
        if (!origins.has(origin)) return sendJson(res, 403, { error: `来源 ${origin} 不在 CORS_ORIGINS 白名单里` });
        cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
      }
      if (isApi && req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          // Chrome 的 Private Network Access：公网页面访问 localhost 要这个头
          ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
        });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, health(), cors);
      if (req.method === 'GET' && url.pathname === '/api/usage') return sendJson(res, 200, budget.snapshot(), cors);
      if (req.method === 'POST' && url.pathname === '/api/relay') return await relay(req, res, cors);
      if (isApi) return sendJson(res, 404, { error: 'not found' }, cors);
      await serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof BackendError ? err.status : 500;
      if (!(err instanceof BackendError)) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message, budgetExhausted: err.budgetExhausted || false }, cors);
    }
  });

  return { server, backends, budget, origins };
}

// 直接运行：node server/index.js
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const { server, backends, budget, origins } = createApp({ port });
  server.listen(port, host, () => {
    console.log(`坦克大战 NPC 测试台已启动: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  中转接口 POST /api/relay，允许的网页来源：${[...origins].join(', ')}`);
    for (const b of backends.filter((x) => x.id === 'jev' || x.id === 'laya')) {
      const key = b.apiKey ? '.env 里配置了 key' : '.env 里没有 key（需要页面填写）';
      const where = b.id === 'laya' ? (b.urlFromEnv ? '，.env 里配置了 endpoint' : '，endpoint 由页面填写') : '';
      console.log(`  ${b.id.padEnd(5)}：${key}${where}`);
    }
    const s = budget.snapshot();
    console.log(`  用 .env 里 Jev key 的花费：$${s.spent_usd} / 上限 $${s.limit_usd}`);
  });
  // 每次记账都已立即写盘，退出时不再写（避免用旧数据覆盖另一个进程的记账）
  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
