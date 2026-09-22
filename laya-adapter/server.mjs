// Laya 本地适配服务（Node 版）
// 把 @receptron/laya 包装成与 Jev 相同的 HTTP 接口：
//   POST /v1/systemone  {model, state, questions} → {model, answers, usage}
//   GET  /health
// 用法：cd laya-adapter && npm install && npm start
// 环境变量：
//   LAYA_PORT      端口，默认 8790
//   LAYA_MODEL_DIR 使用本地导出的 ONNX 目录，不从 Hugging Face 下载
//   LAYA_SUBFOLDER 选择变体，例如 multilingual
//   LAYA_CACHE     权重缓存目录，默认 ~/.cache/receptron-laya
//   LAYA_FAKE=1 或 --fake  不加载模型、返回随机结果，只用来测试适配器本身
import http from 'node:http';

const PORT = Number(process.env.LAYA_PORT || 8790);
const HOST = process.env.LAYA_HOST || '127.0.0.1';
const MAX_QUEUE = Number(process.env.LAYA_MAX_QUEUE || 4);
const FAKE = process.env.LAYA_FAKE === '1' || process.argv.includes('--fake');
const MODEL_NAME = FAKE ? 'laya-fake' : `laya${process.env.LAYA_SUBFOLDER ? '-' + process.env.LAYA_SUBFOLDER : ''}`;

async function loadModel() {
  if (FAKE) {
    console.log('假模型模式：不加载 Laya，返回随机结果（仅用于测试适配器本身）');
    return {
      async systemOne(state, questions) {
        const answers = {};
        for (const [id, q] of Object.entries(questions)) {
          if (q.type !== 'choice') { answers[id] = { type: q.type, noul: 0.5, score: 0 }; continue; }
          const keys = Object.keys(q.criteria);
          const w = keys.map(() => Math.random());
          const sum = w.reduce((a, b) => a + b, 0);
          const probabilities = Object.fromEntries(keys.map((k, i) => [k, w[i] / sum]));
          const choice = keys.reduce((m, k) => (probabilities[k] > probabilities[m] ? k : m), keys[0]);
          answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
        }
        return { answers, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  let Laya;
  try {
    ({ Laya } = await import('@receptron/laya'));
  } catch {
    console.error('找不到 @receptron/laya。请先在 laya-adapter 目录执行：npm install');
    process.exit(1);
  }
  const opts = {};
  if (process.env.LAYA_MODEL_DIR) opts.modelDir = process.env.LAYA_MODEL_DIR;
  if (process.env.LAYA_SUBFOLDER) opts.subfolder = process.env.LAYA_SUBFOLDER;
  if (process.env.LAYA_CACHE) opts.cacheDir = process.env.LAYA_CACHE;
  let lastPct = {};
  opts.onProgress = ({ file, received, total }) => {
    if (!total) return;
    const pct = Math.floor((received / total) * 20) * 5;
    if (pct !== lastPct[file]) {
      lastPct[file] = pct;
      console.log(`  下载 ${file} ${pct}%`);
    }
  };
  console.log('正在加载 Laya 模型（首次运行会从 Hugging Face 下载约 1.7 GB 权重）…');
  const t0 = Date.now();
  const laya = await Laya.load(opts);
  console.log(`模型已加载，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  return laya;
}

const laya = await loadModel();

// 串行推理：同一时间只跑一个，排队超过 MAX_QUEUE 直接返回 429（游戏会沿用上一个决策）
let queue = Promise.resolve();
let waiting = 0;

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: MODEL_NAME, queue: waiting });
  if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(res, 404, { detail: 'not found' });
  let body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { detail: '请求体不是合法 JSON' });
  }
  if (body.state === undefined || !body.questions) return send(res, 422, { detail: '需要 state 和 questions' });
  if (waiting >= MAX_QUEUE) return send(res, 429, { detail: `Laya 忙（排队 ${waiting}）` });
  waiting++;
  const t0 = performance.now();
  const job = queue.then(() => laya.systemOne(body.state, body.questions));
  queue = job.catch(() => {});
  try {
    const result = await job;
    send(res, 200, {
      model: MODEL_NAME,
      answers: result.answers,
      usage: result.usage || { input_tokens: 0, output_tokens: 0 },
      latency_ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    send(res, 422, { detail: String(err?.message || err) });
  } finally {
    waiting--;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Laya 适配服务已启动：http://${HOST}:${PORT}/v1/systemone （健康检查 /health）`);
});
