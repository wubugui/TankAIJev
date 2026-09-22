// 坦克大战 NPC 测试台 · 中转服务（Cloudflare Worker 版）
//
// 作用：GitHub Pages 上的游戏页面不能直接调用 Jev（Jev 拒绝浏览器跨域请求），
// 把这个 Worker 部署到你自己的 Cloudflare 账号，在游戏的“AI 连接设置”里把中转地址填成 Worker 的网址即可。
//
// 部署：Cloudflare 控制台 → Workers & Pages → 创建 Worker → 把本文件内容粘贴进去 → 部署。
// 可选环境变量：
//   CORS_ORIGINS  允许调用的网页来源，逗号分隔，默认 https://wubugui.github.io
//
// 安全说明：
//   - Worker 不保存、不记录任何 key；key 由页面随请求带来，只转发给 Jev / 页面填写的 Laya 地址；
//   - 不支持“服务端 key”：否则任何能打开游戏页面的人都会花你的钱；
//   - Jev 的地址固定为官方地址；Laya 地址必须是 https 且路径以 /v1/systemone 结尾（Worker 访问不到你的局域网）。
//
// 接口与本地服务（npm start）一致：
//   GET  /api/health
//   POST /api/relay  { backend: 'jev'|'laya', url?, model?, apiKey, state, questions }

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const RELAY_PATHS = ['/v1/systemone', '/alpha/decisions', '/api/alpha/decisions'];
const DEFAULT_ORIGINS = 'https://wubugui.github.io';
const DEFAULTS = {
  jev: { model: 'jev-latest', timeoutMs: 5000, pricePerMTok: 0.042 },
  laya: { model: 'laya', timeoutMs: 10000, pricePerMTok: 0 },
};

function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function errorText(j, status) {
  const e = j?.error;
  if (e && typeof e === 'object') return [e.type, e.message].filter(Boolean).join(': ');
  const v = e ?? j?.detail ?? j?.message ?? j?.raw ?? '';
  return (typeof v === 'string' ? v : JSON.stringify(v)) || `HTTP ${status}`;
}

async function relay(request, cors) {
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return json(415, { error: '只接受 application/json' }, cors);
  let body;
  try { body = await request.json(); } catch { return json(400, { error: '请求体不是合法 JSON' }, cors); }
  if (!body || typeof body !== 'object' || body.state === undefined || !body.questions || typeof body.questions !== 'object') {
    return json(400, { error: '需要 backend、state 和 questions' }, cors);
  }
  const n = Object.keys(body.questions).length;
  if (n < 1 || n > 8) return json(400, { error: 'questions 数量应为 1~8' }, cors);
  const conf = DEFAULTS[body.backend];
  if (!conf) return json(400, { error: 'backend 只能是 jev 或 laya' }, cors);

  let target;
  if (body.backend === 'jev') {
    target = JEV_URL;
  } else {
    if (typeof body.url !== 'string' || !body.url.trim()) return json(400, { error: '没填 Laya endpoint' }, cors);
    try { target = new URL(body.url.trim()); } catch { return json(400, { error: 'Laya endpoint 不是合法地址' }, cors); }
    if (target.protocol !== 'https:') return json(400, { error: 'Worker 只能转发到 https 的 Laya 地址（局域网地址请用本地中转 npm start）' }, cors);
    if (!RELAY_PATHS.some((p) => target.pathname.endsWith(p))) return json(400, { error: `Laya endpoint 路径必须以 ${RELAY_PATHS.join(' / ')} 结尾` }, cors);
    target = target.href;
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (body.backend === 'jev' && !apiKey) return json(400, { error: '没有 Jev key：请在游戏的“AI 连接设置”里填写' }, cors);
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : conf.model;

  const t0 = Date.now();
  let res;
  let data;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, state: body.state, questions: body.questions }),
      signal: AbortSignal.timeout(conf.timeoutMs),
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  } catch (err) {
    return json(502, { error: `调用 ${body.backend} 失败：${err?.name === 'TimeoutError' ? `超时（>${conf.timeoutMs}ms）` : err?.message || err}` }, cors);
  }
  if (!res.ok) {
    const status = res.status === 429 || res.status === 529 ? 429 : res.status === 401 ? 401 : 502;
    return json(status, { error: `${body.backend} 返回 HTTP ${res.status} ${errorText(data, res.status)}`.slice(0, 400) }, cors);
  }
  const inputTokens = data?.usage?.input_tokens || 0;
  return json(200, {
    model: data.model || model,
    answers: data.answers || {},
    usage: data.usage || null,
    latency_ms: Date.now() - t0,
    upstream_latency_ms: typeof data.latency_ms === 'number' ? data.latency_ms : null,
    routing: data.routing || null,
    warnings: Array.isArray(data.warnings) ? data.warnings.map((w) => (typeof w === 'string' ? w : w?.message || JSON.stringify(w))) : [],
    cost_usd: (inputTokens * conf.pricePerMTok) / 1e6,
  }, cors);
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const origins = new Set(String(env.CORS_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
    const origin = request.headers.get('Origin');
    let cors = {};
    if (origin) {
      if (!origins.has(origin)) return json(403, { error: `来源 ${origin} 不在 CORS_ORIGINS 白名单里` });
      cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(200, { ok: true, app: 'npc-tank-relay', kind: 'worker', server: { jev: { hasKey: false }, laya: { hasUrl: false, hasKey: false } } }, cors);
    }
    if (request.method === 'POST' && url.pathname === '/api/relay') return relay(request, cors);
    return json(404, { error: 'not found' }, cors);
  },
};
