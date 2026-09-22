// 浏览器端的 AI 连接：玩家自己的 key / endpoint、调用 Jev / Laya / 中转、本浏览器的花费账本。
//
// 这些配置只存在本浏览器里（localStorage 或 sessionStorage），不会上传到本站；
// 只会随请求发给玩家自己填写的服务（Laya 直连）或玩家自己的中转服务。
//
// 为什么需要中转：
//   - Jev 的 API 拒绝所有第三方网页的跨域请求（CORS 返回 "Disallowed CORS origin"），浏览器无法直接调用；
//   - https 页面不能访问 http 的局域网地址（混合内容），而且 Laya 服务本身不一定支持 CORS。
// 中转服务就是本项目的 `npm start`（server/index.js）或 relay/cloudflare-worker.js，接口是 POST /api/relay。
import { mockSystemOne } from './mock.js';
import { DEFAULT_RELAY_URL } from './site-config.js';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const SYSTEMONE_PATHS = ['/v1/systemone', '/alpha/decisions', '/api/alpha/decisions'];

export const BACKENDS = {
  laya: { id: 'laya', label: 'Laya', pricePerMTok: 0, promptStyle: 'compact', maxRps: 50, timeoutMs: 10000, defaultModel: 'laya' },
  jev: { id: 'jev', label: 'Jev（TypeSafe）', pricePerMTok: 0.042, promptStyle: 'full', maxRps: 12, timeoutMs: 5000, defaultModel: 'jev-latest' },
  mock: { id: 'mock', label: 'Mock（离线随机）', pricePerMTok: 0, promptStyle: 'full', maxRps: 100, timeoutMs: 2000, local: true },
};

const SETTINGS_KEY = 'npc-tank-connection-v1';
const LEDGER_KEY = 'npc-tank-jev-ledger-v1';

export class ConnectionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

// ---------- 存储（所有读写都包在 try 里：隐私模式下可能不可用） ----------
function storageGet(store, key) {
  try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; }
}
function storageSet(store, key, value) {
  try { store.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
}
function storageRemove(store, key) {
  try { store.removeItem(key); } catch { /* 忽略 */ }
}
const local = () => (typeof localStorage === 'undefined' ? null : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? null : sessionStorage);

export function defaultSettings(sameOriginRelay = false) {
  return {
    remember: true,
    relayUrl: sameOriginRelay ? '' : DEFAULT_RELAY_URL, // '' = 本页面自己的服务端（npm start）
    jev: { key: '', model: '', budgetUsd: 1 },
    laya: { url: '', key: '', model: '', route: 'relay' },
  };
}

// 先看 localStorage（勾了“记住”），再看 sessionStorage（本标签页）
export function loadSettings(sameOriginRelay = false) {
  const base = defaultSettings(sameOriginRelay);
  const saved = (local() && storageGet(local(), SETTINGS_KEY)) || (session() && storageGet(session(), SETTINGS_KEY));
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    jev: { ...base.jev, ...(saved.jev || {}) },
    laya: { ...base.laya, ...(saved.laya || {}) },
  };
}

export function saveSettings(s) {
  if (s.remember) {
    if (local()) storageSet(local(), SETTINGS_KEY, s);
    if (session()) storageRemove(session(), SETTINGS_KEY);
  } else {
    if (session()) storageSet(session(), SETTINGS_KEY, s);
    if (local()) storageRemove(local(), SETTINGS_KEY);
  }
}

export function clearSavedSettings() {
  if (local()) storageRemove(local(), SETTINGS_KEY);
  if (session()) storageRemove(session(), SETTINGS_KEY);
}

// ---------- Jev 花费账本（本浏览器） ----------
export function loadLedger() {
  const l = local() && storageGet(local(), LEDGER_KEY);
  return { spent_usd: 0, requests: 0, input_tokens: 0, ...(l || {}) };
}
function saveLedger(l) {
  if (local()) storageSet(local(), LEDGER_KEY, l);
}
export function resetLedger() {
  saveLedger({ spent_usd: 0, requests: 0, input_tokens: 0 });
}

// 保守估算输入 token：按 3 个字符 1 个 token，再加上服务端固定开销（与 server/budget.js 一致）
export function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body).length / 3) + 400;
}

// ---------- 地址处理 ----------
export function normalizeRelayUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

// Laya：可以只填服务根地址（http://host:8790），也可以填完整接口地址
export function systemOneUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const url = new URL(s);
    if (SYSTEMONE_PATHS.some((p) => url.pathname.endsWith(p))) return url.href;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/v1/systemone`;
  } catch {
    return '';
  }
}

const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

// 浏览器会不会拦截这个直连地址（https 页面访问非本机的 http 地址 = 混合内容）
export function mixedContentProblem(targetUrl, pageProtocol = globalThis.location?.protocol) {
  try {
    const u = new URL(targetUrl);
    if (pageProtocol === 'https:' && u.protocol === 'http:' && !isLoopback(u.hostname)) {
      return '本页面是 https，浏览器会拦截对 http 局域网地址的请求：请改用 https 地址，或者改成“经中转”';
    }
  } catch { /* 地址不合法，别处会提示 */ }
  return null;
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// ---------- 状态探测 ----------
export async function probeRelay(relayUrl, fetchImpl = fetch) {
  const base = normalizeRelayUrl(relayUrl);
  try {
    const r = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, note: `HTTP ${r.status}` };
    const j = await r.json();
    if (j?.app !== 'npc-tank-relay') return { ok: false, note: '不是本项目的中转服务' };
    return { ok: true, kind: j.kind, note: j.kind === 'worker' ? '在线（Cloudflare Worker）' : '在线（本地服务）', server: j.server || {} };
  } catch {
    if (!base) return { ok: false, note: '本页面没有中转服务' };
    // *.workers.dev 在中国大陆等地区被 DNS 污染，不开代理连不上
    const blockedHint = /\.workers\.dev$/i.test(hostOf(base)) ? '（workers.dev 域名在中国大陆等地区被屏蔽，需要开代理，或换成自己的中转）' : '';
    return { ok: false, note: `连不上${blockedHint}` };
  }
}

// 每个后端现在能不能用、为什么
export function describeBackend(id, s, relay) {
  if (id === 'mock') return { ok: true, note: '浏览器内随机，不联网' };
  if (id === 'jev') {
    if (!relay?.ok) return { ok: false, note: 'Jev 必须经中转，中转连不上' };
    if (s.jev.key) return { ok: true, note: '经中转 · 用你填的 key' };
    if (relay.server?.jev?.hasKey) return { ok: true, note: '经中转 · 用中转服务端配置的 key' };
    return { ok: false, note: '没填 key' };
  }
  if (id === 'laya') {
    const url = systemOneUrl(s.laya.url);
    if (s.laya.route === 'direct') {
      if (!url) return { ok: false, note: '没填 endpoint' };
      const mixed = mixedContentProblem(url);
      if (mixed) return { ok: false, note: mixed };
      return { ok: true, note: '浏览器直连（服务需支持 CORS）' };
    }
    if (!relay?.ok) return { ok: false, note: '经中转，但中转连不上' };
    if (url && relay.kind === 'worker' && !url.startsWith('https:')) {
      return { ok: false, note: 'Cloudflare 中转只能转发 https 地址，访问不到局域网：局域网 Laya 请在本机运行 npm start，并把中转地址改成 http://localhost:3000' };
    }
    if (url) return { ok: true, note: '经中转' };
    if (relay.server?.laya?.hasUrl) return { ok: true, note: '经中转 · 用中转服务端配置的 endpoint' };
    return { ok: false, note: '没填 endpoint' };
  }
  return { ok: false, note: '未知后端' };
}

// ---------- 调用 ----------
const recent = new Map(); // 后端 id → 最近 1 秒的请求时间戳
function takeRateSlot(id, maxRps) {
  const now = Date.now();
  const list = (recent.get(id) || []).filter((t) => now - t < 1000);
  if (list.length >= maxRps) { recent.set(id, list); return false; }
  list.push(now);
  recent.set(id, list);
  return true;
}

let reservedUsd = 0; // 正在进行中的 Jev 请求的预估花费

function errorText(json, status) {
  const e = json?.error;
  if (e && typeof e === 'object') return [e.type, e.message].filter(Boolean).join(': ');
  const v = e ?? json?.detail ?? json?.message ?? json?.raw ?? '';
  return (typeof v === 'string' ? v : JSON.stringify(v)) || `HTTP ${status}`;
}

async function postJson(url, body, headers, timeoutMs, fetchImpl) {
  let res;
  let json = null;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? `超时（>${timeoutMs}ms）` : '连不上（服务没开，或被浏览器的跨域/混合内容规则拦截）';
    throw new ConnectionError(`${why}：${url}`);
  }
  if (!res.ok) throw new ConnectionError(errorText(json, res.status), { status: res.status, budgetExhausted: json?.budgetExhausted });
  return json;
}

// 统一返回 { model, answers, usage, latency_ms, upstream_latency_ms, routing, warnings, cost_usd }
export async function callBackend(id, { state, questions, agent }, s, fetchImpl = fetch) {
  const def = BACKENDS[id];
  if (!def) throw new ConnectionError(`未知后端 ${id}`);
  if (def.local) return { ...(await mockSystemOne({ state, questions })), latency_ms: 0 };
  if (!takeRateSlot(id, def.maxRps)) throw new ConnectionError(`${def.label} 超过本地限流 ${def.maxRps} 次/秒`);

  const relay = normalizeRelayUrl(s.relayUrl);
  const t0 = performance.now();
  let json;
  if (id === 'jev') {
    const body = { backend: 'jev', model: s.jev.model || undefined, apiKey: s.jev.key || undefined, state, questions, agent };
    // 本浏览器的 Jev 花费上限：先按保守估算预留，返回后按实际 usage 记账
    const limit = Number(s.jev.budgetUsd);
    const estimate = (estimateTokens({ model: body.model, state, questions }) * def.pricePerMTok) / 1e6;
    const ledger = loadLedger();
    if (Number.isFinite(limit) && ledger.spent_usd + reservedUsd + estimate > limit) {
      throw new ConnectionError(`Jev 花费已到本浏览器的上限 $${limit}，已停止调用（可在“AI 连接设置”里调高或清零）`, { budgetExhausted: true });
    }
    reservedUsd += estimate;
    try {
      json = await postJson(`${relay}/api/relay`, body, {}, def.timeoutMs + 1000, fetchImpl);
    } finally {
      reservedUsd = Math.max(0, reservedUsd - estimate);
    }
    const tokens = json?.usage?.input_tokens || estimateTokens({ model: body.model, state, questions });
    const cost = (tokens * def.pricePerMTok) / 1e6;
    const l = loadLedger();
    saveLedger({ spent_usd: l.spent_usd + cost, requests: l.requests + 1, input_tokens: l.input_tokens + tokens });
    json = { ...json, cost_usd: cost };
  } else {
    const url = systemOneUrl(s.laya.url);
    if (s.laya.route === 'direct') {
      if (!url) throw new ConnectionError('Laya 没填 endpoint');
      const mixed = mixedContentProblem(url);
      if (mixed) throw new ConnectionError(mixed);
      const headers = s.laya.key ? { Authorization: `Bearer ${s.laya.key}` } : {};
      json = await postJson(url, { model: s.laya.model || def.defaultModel, state, questions }, headers, def.timeoutMs, fetchImpl);
    } else {
      const body = { backend: 'laya', url: url || undefined, model: s.laya.model || undefined, apiKey: s.laya.key || undefined, state, questions, agent };
      json = await postJson(`${relay}/api/relay`, body, {}, def.timeoutMs + 1000, fetchImpl);
    }
    json = { ...json, cost_usd: 0 };
  }
  const warnings = Array.isArray(json.warnings) ? json.warnings.map((w) => (typeof w === 'string' ? w : w?.message || JSON.stringify(w))) : [];
  return {
    model: json.model,
    answers: json.answers || {},
    usage: json.usage || null,
    latency_ms: Math.round(performance.now() - t0),
    upstream_latency_ms: typeof json.upstream_latency_ms === 'number' ? json.upstream_latency_ms : typeof json.latency_ms === 'number' ? json.latency_ms : null,
    routing: json.routing || null,
    warnings,
    cost_usd: json.cost_usd,
  };
}

// “测试连接”：问一道最简单的选择题
export async function testBackend(id, s, fetchImpl = fetch) {
  const res = await callBackend(id, {
    state: { note: 'connection test' },
    questions: { ok: { type: 'choice', instructions: 'Answer yes.', criteria: { yes: 'yes', no: 'no' } } },
  }, s, fetchImpl);
  const a = res.answers.ok;
  if (!a?.choice) throw new ConnectionError('返回里没有答案');
  return `${res.model || id} 回答 ${a.choice}，用时 ${res.latency_ms}ms${res.cost_usd ? `，花费 $${res.cost_usd.toFixed(6)}` : ''}`;
}
