import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, STEP } from '../public/js/match.js';
import { buildDecision } from '../public/js/observe.js';
import { ruleTactic } from '../public/js/policies.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// “远程版规则 AI”：按请求那一刻的局面算出规则 AI 的选择，但要等 delayMs 真实时间才返回
function remoteRule(getMatch, delayMs) {
  return async (payload) => {
    const m = getMatch();
    const tank = m.game.getTank(payload.agent);
    const choice = ruleTactic(buildDecision(m.game, tank, 'tactical', {}), tank);
    await sleep(typeof delayMs === 'function' ? delayMs() : delayMs);
    return { answers: { tactic: { choice, probabilities: { [choice]: 1 }, confidence: 1 } } };
  };
}

async function playFair(kinds, seed, decide, maxSteps = 60 * 40) {
  let m;
  m = new Match({ kinds, settings: { mode: 'tactical', intervalMs: 400, callouts: false }, decide: decide && decide(() => m), seed });
  for (let i = 0; i < maxSteps && !m.game.over; i++) {
    const wait = m.tickFair(STEP);
    if (wait) await wait;
  }
  return m;
}

const RULE = { B1: 'rule', B2: 'rule', R1: 'rule', R2: 'rule' };
const REMOTE_BLUE = { B1: 'remote:x', B2: 'remote:x', R1: 'rule', R2: 'rule' };

test('公平模式：远程 AI 的延迟不影响对局——结果和零延迟的同一个 AI 逐帧一致', async () => {
  for (const seed of [1, 2, 3]) {
    const base = await playFair(RULE, seed);
    let jitter = 0;
    const remote = await playFair(REMOTE_BLUE, seed, (get) => remoteRule(get, () => (jitter = (jitter + 17) % 41)));
    const a = base.game.summary();
    const b = remote.game.summary();
    assert.deepEqual(b, a, `seed ${seed}：有延迟的远程 AI 打出了不同的对局`);
    assert.ok(remote.freeze.count > 0, '确实等过远程 AI');
  }
});

test('公平模式：答案生效时游戏时间一步都没走，所有 AI 在同一时刻决策', async () => {
  const times = { B1: [], B2: [], R1: [], R2: [] };
  const m = await playFair(REMOTE_BLUE, 5, (get) => {
    const inner = remoteRule(get, 15);
    return async (payload) => {
      const asked = get().game.time;
      const res = await inner(payload);
      assert.equal(get().game.time, asked, '等答案期间世界不能动');
      return res;
    };
  }, 60 * 3);
  // 前 3 秒只检查“等待期间世界不动”；再跑 2 秒，记录每辆车的决策时刻
  m.on('decision', (e) => times[e.agent].push(e.time));
  for (let i = 0; i < 120 && !m.game.over; i++) { const w = m.tickFair(STEP); if (w) await w; }
  for (let k = 0; k < times.B1.length; k++) {
    assert.equal(times.B2[k], times.B1[k]);
    assert.equal(times.R1[k], times.B1[k], '规则 AI 和远程 AI 在同一时刻决策');
  }
  assert.ok(times.B1.length >= 3);
});

test('公平模式：等太久的答案作废，晚到也不会生效', async () => {
  let calls = 0;
  let m;
  m = new Match({
    kinds: { B1: 'remote:x', B2: 'rule', R1: 'idle', R2: 'idle' },
    settings: { mode: 'tactical', intervalMs: 400, callouts: false, maxWaitMs: 30 },
    decide: async () => {
      calls++;
      await sleep(calls === 1 ? 120 : 1); // 第一次故意超时
      return { answers: { tactic: { choice: 'defend_our_base', probabilities: { defend_our_base: 1 }, confidence: 1 } } };
    },
    seed: 1,
  });
  const c = m.controllers.get('B1');
  const w = m.tickFair(STEP);
  assert.ok(w, '第一帧要等远程 AI');
  await w; // 30ms 后放弃等待，世界继续
  assert.equal(c.tactic, 'hold_position');
  for (let i = 0; i < 5; i++) { const x = m.tickFair(STEP); if (x) await x; }
  await sleep(150); // 晚到的答案回来了
  assert.equal(c.tactic, 'hold_position', '晚到的答案被丢弃');
  assert.equal(c.stats.late, 1);
  assert.equal(c.stats.decisions, 0);
});

test('实时模式对照：远程答案回来时世界已经往前走了', async () => {
  let m;
  const asked = [];
  const applied = [];
  m = new Match({
    kinds: { B1: 'remote:x', B2: 'idle', R1: 'idle', R2: 'idle' },
    settings: { mode: 'tactical', intervalMs: 400, callouts: false },
    decide: async () => {
      asked.push(m.game.time);
      await sleep(40);
      return { answers: { tactic: { choice: 'hold_position', probabilities: { hold_position: 1 }, confidence: 1 } } };
    },
    seed: 1,
  });
  m.on('decision', (e) => applied.push(e.time));
  for (let i = 0; i < 30; i++) { m.tick(STEP); await sleep(3); }
  assert.ok(applied.length >= 1);
  assert.ok(applied[0] > asked[0], '实时模式下答案生效时游戏时间已经推进');
});
