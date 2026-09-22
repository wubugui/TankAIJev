import { readFileSync } from 'node:fs';
import { estimateTokens } from './budget.js';

// 读取 config/backends.json，并用环境变量覆盖地址 / 模型 / 密钥。
// 地址有两种覆盖方式：
//   baseUrlEnv  只给服务根地址（如 http://192.168.x.x:8790），接口路径和健康检查路径沿用配置里的
//   urlEnv      直接给完整接口地址
export function loadBackends(file, env = process.env, port = 3000) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return raw.backends.map((b) => {
    const pick = (key) => (b[`${key}Env`] && env[b[`${key}Env`]]) || b[key];
    const sub = (s) => (s ? String(s).replace('${PORT}', String(port)) : s);
    let url = sub(pick('url'));
    let healthUrl = sub(pick('healthUrl'));
    const base = b.baseUrlEnv && env[b.baseUrlEnv] ? env[b.baseUrlEnv].trim().replace(/\/+$/, '') : null;
    if (base) {
      url = base + new URL(sub(b.url)).pathname;
      healthUrl = b.healthUrl ? base + new URL(sub(b.healthUrl)).pathname : null;
    } else if (b.urlEnv && env[b.urlEnv] && b.healthUrl && !(b.healthUrlEnv && env[b.healthUrlEnv])) {
      // 只改了接口地址、没单独给健康检查地址时，健康检查跟着接口的主机走
      healthUrl = new URL('/health', url).href;
    }
    return {
      id: b.id,
      label: b.label || b.id,
      url,
      healthUrl,
      urlFromEnv: Boolean((b.baseUrlEnv && env[b.baseUrlEnv]) || (b.urlEnv && env[b.urlEnv])),
      model: pick('model'),
      apiKey: b.apiKeyEnv ? env[b.apiKeyEnv] || '' : '',
      needsKey: b.apiKeyRequired === true, // 没配密钥就拒绝调用（云端付费服务）；未标记的后端密钥可有可无
      pricePerMTok: Number(b.pricePerMTok || 0),
      maxRps: Number(b.maxRps || 20),
      timeoutMs: Number(b.timeoutMs || 3000),
      promptStyle: b.promptStyle === 'compact' ? 'compact' : 'full',
    };
  });
}

export class BackendError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// 限流按后端 id 共享（中转时会基于配置派生出新的后端对象，计数不能跟着对象走）
const recent = new Map();
function takeRateSlot(b) {
  const now = Date.now();
  const list = (recent.get(b.id) || []).filter((t) => now - t < 1000);
  if (list.length >= b.maxRps) { recent.set(b.id, list); return false; }
  list.push(now);
  recent.set(b.id, list);
  return true;
}

// 从各种错误响应里取出可读信息：
//   Jev:      {"detail": ...}
//   Laya 服务: {"error": {"message": ..., "type": ...}}
function errorText(json) {
  if (!json) return '';
  const e = json.error;
  if (e && typeof e === 'object') return [e.type, e.message].filter(Boolean).join(': ');
  const v = json.detail ?? e ?? json.message ?? json.raw ?? '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// 调用一个 systemone 兼容后端。
// opts.charge（默认 true）：付费后端是否计入这里的预算账本。中转时用的是页面自己的 key 就传 false，
// 花费仍然按 usage 算出来返回给页面，由页面自己的上限管。
// 返回值只取 model / answers / usage，外加 warnings / routing / 服务端耗时；其它未知字段忽略。
export async function callBackend(b, { state, questions }, budget, opts = {}) {
  if (b.needsKey && !b.apiKey) throw new BackendError(503, `后端 ${b.id} 没有配置密钥`);
  if (!takeRateSlot(b)) throw new BackendError(429, `后端 ${b.id} 超过本地限流 ${b.maxRps} 次/秒`, { local: true });

  const body = { model: b.model, state, questions };
  const paid = b.pricePerMTok > 0 && opts.charge !== false;
  const estimate = paid ? (estimateTokens(body) * b.pricePerMTok) / 1e6 : 0;
  if (paid && !budget.reserve(estimate)) {
    throw new BackendError(402, `预算已用完（上限 $${budget.limitUsd}），已停止调用付费后端`, { budgetExhausted: true });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (b.apiKey) headers.Authorization = `Bearer ${b.apiKey}`;
  const t0 = performance.now();
  let res;
  let json = null;
  try {
    // Node 的 fetch 不读 HTTP_PROXY 等环境变量，局域网地址直连
    res = await fetch(b.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(b.timeoutMs) });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  } catch (err) {
    if (paid) budget.release(estimate);
    budget.record(b.id, { ok: false });
    const reason = err.name === 'TimeoutError' ? `超时（>${b.timeoutMs}ms）` : err.cause?.code || err.message;
    throw new BackendError(502, `调用 ${b.id} 失败：${reason}（${b.url}）`);
  }
  const latencyMs = Math.round(performance.now() - t0);
  if (paid) budget.release(estimate);

  if (!res.ok) {
    budget.record(b.id, { ok: false });
    const status = res.status === 429 || res.status === 529 ? 429 : res.status === 401 ? 401 : 502;
    throw new BackendError(status, `${b.id} 返回 HTTP ${res.status} ${errorText(json)}`.slice(0, 400));
  }

  const inputTokens = json?.usage?.input_tokens || 0;
  const outputTokens = json?.usage?.output_tokens || 0;
  // 按实际 usage 记账；万一后端没给 usage，就按估算值记，宁多勿少
  const costUsd = b.pricePerMTok > 0 ? ((inputTokens || estimateTokens(body)) * b.pricePerMTok) / 1e6 : 0;
  if (paid || !(b.pricePerMTok > 0)) budget.record(b.id, { inputTokens, outputTokens, costUsd: paid ? costUsd : 0, ok: true });
  const warnings = Array.isArray(json.warnings) ? json.warnings.map((w) => (typeof w === 'string' ? w : w?.message || JSON.stringify(w))) : [];
  return {
    model: json.model || b.model,
    answers: json.answers || {},
    usage: json.usage || null,
    latency_ms: latencyMs,
    upstream_latency_ms: typeof json.latency_ms === 'number' ? json.latency_ms : null,
    routing: json.routing || null,
    warnings,
    cost_usd: costUsd,
  };
}
