import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../relay/cloudflare-worker.js';

const PAGES = 'https://wubugui.github.io';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// 把 Worker 里对上游的 fetch 换成假的
function stubUpstream(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    const { status = 200, json } = handler(String(url));
    return new Response(JSON.stringify(json), { status });
  };
  return calls;
}
const question = { tactic: { type: 'choice', instructions: 'pick', criteria: { a: 'A', b: 'B' } } };
function req(pathname, { method = 'POST', origin = PAGES, body, contentType = 'application/json' } = {}) {
  const headers = { 'Content-Type': contentType };
  if (origin) headers.Origin = origin;
  return new Request(`https://relay.example${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

test('Worker 健康检查与跨域白名单', async () => {
  const h = await worker.fetch(req('/api/health', { method: 'GET' }), {});
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('access-control-allow-origin'), PAGES);
  assert.equal((await h.json()).kind, 'worker');
  assert.equal((await worker.fetch(req('/api/health', { method: 'GET', origin: 'https://evil.example' }), {})).status, 403);
  const custom = await worker.fetch(req('/api/health', { method: 'GET', origin: 'https://me.example' }), { CORS_ORIGINS: 'https://me.example' });
  assert.equal(custom.status, 200);
  const pre = await worker.fetch(req('/api/relay', { method: 'OPTIONS' }), {});
  assert.equal(pre.status, 204);
});

test('Worker 转发 Jev：固定官方地址，必须带页面的 key', async () => {
  const calls = stubUpstream(() => ({ json: { model: 'jev-1.13.0', answers: { tactic: { choice: 'a' } }, usage: { input_tokens: 1000 } } }));
  const noKey = await worker.fetch(req('/api/relay', { body: { backend: 'jev', state: {}, questions: question } }), {});
  assert.equal(noKey.status, 400);
  const r = await worker.fetch(req('/api/relay', { body: { backend: 'jev', apiKey: 'pk', url: 'https://evil.example/v1/systemone', state: {}, questions: question } }), {});
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].auth, 'Bearer pk');
  const j = await r.json();
  assert.equal(j.answers.tactic.choice, 'a');
  assert.equal(j.cost_usd, 0.000042);
});

test('Worker 转发 Laya：只接受 https + systemone 路径，错误格式透传', async () => {
  stubUpstream(() => ({ status: 401, json: { error: { message: 'invalid api key', type: 'authentication_error' } } }));
  const http = await worker.fetch(req('/api/relay', { body: { backend: 'laya', url: 'http://192.168.1.2:8790/v1/systemone', state: {}, questions: question } }), {});
  assert.equal(http.status, 400);
  const path = await worker.fetch(req('/api/relay', { body: { backend: 'laya', url: 'https://laya.example/admin', state: {}, questions: question } }), {});
  assert.equal(path.status, 400);
  const bad = await worker.fetch(req('/api/relay', { body: { backend: 'laya', url: 'https://laya.example/v1/systemone', state: {}, questions: question } }), {});
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).error, /authentication_error: invalid api key/);
  const text = await worker.fetch(req('/api/relay', { contentType: 'text/plain', body: { backend: 'jev' } }), {});
  assert.equal(text.status, 415);
});
