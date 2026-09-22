// 离线模拟一个 Jev 兼容的 systemone 接口：随机概率 + 随机延迟。
// 用来在不花钱的情况下测试整条“游戏 → 服务端 → 后端”链路。
export async function mockSystemOne(body) {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
  const answers = {};
  for (const [id, q] of Object.entries(body.questions || {})) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria || {});
      const weights = keys.map(() => -Math.log(Math.random() + 1e-9));
      const sum = weights.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, weights[i] / sum]));
      const choice = keys.reduce((m, k) => (probabilities[k] > probabilities[m] ? k : m), keys[0]);
      answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    } else if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: Math.random() };
    } else if (q.type === 'score') {
      const n = (q.criteria || []).length || 2;
      const level = Math.floor(Math.random() * n);
      answers[id] = {
        type: 'score',
        score: level,
        legend: Object.fromEntries((q.criteria || []).map((c, i) => [String(i), String(c)])),
        probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === level ? 1 : 0])),
        confidence: 1,
      };
    }
  }
  return { model: 'mock-0', answers, usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 0 } };
}
