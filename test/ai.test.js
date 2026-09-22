import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, STEP } from '../public/js/match.js';
import { buildDecision } from '../public/js/observe.js';

function play(kinds, seed, settings = {}) {
  const m = new Match({ kinds, settings: { mode: 'tactical', intervalMs: 400, callouts: false, ...settings }, seed });
  const ownBaseHits = { blue: 0, red: 0 };
  while (!m.game.over) {
    m.tick(STEP);
    for (const e of m.game.events) {
      if ((e.type === 'baseHit' || e.type === 'baseDestroyed') && m.game.getTank(e.by)?.team === e.team) ownBaseHits[e.team]++;
    }
    m.game.events.length = 0;
  }
  return { winner: m.game.winner, time: m.game.time, ownBaseHits };
}

const RULE = { B1: 'rule', B2: 'rule', R1: 'rule', R2: 'rule' };

test('规则 AI 对打时红蓝双方机会均等', () => {
  let blue = 0;
  const n = 60;
  for (let seed = 1; seed <= n; seed++) if (play(RULE, seed).winner === 'blue') blue++;
  assert.ok(blue >= n * 0.3 && blue <= n * 0.7, `蓝方赢了 ${blue}/${n}，偏差过大`);
});

test('规则 AI 明显强于随机 AI（两种模式、换边）', () => {
  for (const mode of ['tactical', 'direct']) {
    let wins = 0;
    for (let seed = 1; seed <= 6; seed++) {
      if (play({ B1: 'rule', B2: 'rule', R1: 'random', R2: 'random' }, seed, { mode }).winner === 'blue') wins++;
      if (play({ B1: 'random', B2: 'random', R1: 'rule', R2: 'rule' }, seed, { mode }).winner === 'red') wins++;
    }
    assert.ok(wins >= 10, `${mode}：规则 AI 只赢了 ${wins}/12`);
  }
});

test('战术层执行器从不打自家基地', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = play(RULE, seed);
    assert.deepEqual(r.ownBaseHits, { blue: 0, red: 0 }, `seed ${seed}`);
  }
});

test('对局都能在时限内结束', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = play({ B1: 'idle', B2: 'random', R1: 'random', R2: 'idle' }, seed);
    assert.ok(r.time <= 180 + 0.1);
  }
});

test('决策请求格式：选项合法、精简版不超 Laya 的长度预算、state 可序列化', () => {
  const m = new Match({ kinds: RULE, settings: { mode: 'tactical', intervalMs: 400 }, seed: 3 });
  for (let i = 0; i < 60 * 8; i++) m.tick(STEP);
  for (const mode of ['tactical', 'direct']) {
    for (const t of m.game.tanks.filter((x) => x.alive)) {
      const full = buildDecision(m.game, t, mode, { allyIsHuman: true, callouts: true, order: { order: 'attack', time: 1 } });
      const compact = buildDecision(m.game, t, mode, { style: 'compact', allyIsHuman: true, callouts: true });
      for (const d of [full, compact]) {
        assert.deepEqual(Object.keys(d.questions.tactic.criteria), Object.keys(d.options));
        assert.ok(Object.keys(d.options).length >= 2 && Object.keys(d.options).length < 20);
        const json = JSON.stringify(d.state);
        assert.ok(!/NaN|Infinity/.test(json), json);
      }
      assert.deepEqual(Object.keys(full.options).sort(), Object.keys(compact.options).sort(), '两种风格的选项 id 必须一致');
      // Laya 英文版：题目+选项上限约 192 token，state 约 316 token。用局域网 Laya 实测：题目约 3.1 字符/token，state 约 2.8 字符/token，都留余量
      for (const q of Object.values(compact.questions)) {
        const header = q.instructions + Object.entries(q.criteria).map(([k, v]) => `${k} ${v}`).join(' ');
        assert.ok(header.length < 560, `精简版题目过长：${header.length} 字符`); // 实测约 3 字符/token → 约 185 token
      }
      assert.ok(JSON.stringify(compact.state).length < 650, `精简版 state 过长：${JSON.stringify(compact.state).length} 字符`);
      if (mode === 'tactical') {
        assert.ok(full.options.defend_our_base && full.options.hold_position);
        assert.ok(Object.keys(full.options).some((k) => k.startsWith('attack_')));
        for (const low of ['shoot_now', 'dodge']) assert.equal(full.options[low], undefined, `战术层不应再有底层动作 ${low}`);
      } else assert.equal(Object.keys(full.options).length, 9);
    }
  }
});

test('全局视野：每辆车的位置、区域、移动方向、推断的意图，以及双方基地态势', () => {
  const m = new Match({ kinds: { B1: 'idle', B2: 'idle', R1: 'idle', R2: 'idle' }, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 });
  const g = m.game;
  const r1 = g.getTank('R1');
  // R1 从 (9,7) 一路往下开到 (9,10)，逼近蓝方基地 (9,14)
  for (const [i, y] of [7, 8, 9, 10].entries()) {
    Object.assign(r1, { x: 9, y, fx: 9, fy: y });
    g.time = 1 + i * 0.3;
    g.recordTrails();
  }
  const b2 = g.getTank('B2');
  const d = buildDecision(g, b2, 'tactical', { allyPlan: 'attack_left', selfPlan: 'hold_position' });
  const e = d.state.enemies.find((x) => x.id === 'R1');
  assert.deepEqual(e.tile, [9, 10]);
  assert.equal(e.zone, 'near our base');
  assert.equal(e.heading, 'moving toward our base');
  assert.equal(e.intent, 'attacking our base');
  assert.deepEqual(d.state.our_base.threatened_by, ['R1']);
  assert.equal(d.state.teammate.plan, 'attacking the enemy base from the left');
  assert.equal(d.state.you.current_plan, 'holding position');
  assert.match(d.state.you.zone, /right lane, our half/, 'B2 在 (16,14) 以东，对蓝方来说是右路');
  // 同一辆车，从红方视角看：在“我方半场”的反面
  const red = buildDecision(g, g.getTank('R2'), 'tactical', {});
  assert.match(red.state.you.zone, /lane, our half/);
  assert.match(red.options.hunt_B1 || '', /B1/);
});

test('区域左右以各自朝向为准：同一侧对红蓝双方是镜像的', async () => {
  const { zoneOf } = await import('../public/js/observe.js');
  const g = new Match({ kinds: RULE, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 }).game;
  assert.equal(zoneOf(g, 1, 10, 'blue'), 'left lane, our half');
  assert.equal(zoneOf(g, 17, 4, 'red'), 'left lane, our half', '旋转 180° 后的对称位置');
  assert.equal(zoneOf(g, 9, 7, 'blue'), 'center, midfield');
});

test('基地近 5 秒掉血会被标记为告急；队友已在照看时守家选项会注明', () => {
  const m = new Match({ kinds: { B1: 'idle', B2: 'idle', R1: 'idle', R2: 'idle' }, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 });
  const g = m.game;
  for (let i = 0; i < 60; i++) m.tick(STEP);
  g.bases.blue.hitTimes.push(g.time);
  const d = buildDecision(g, g.getTank('B2'), 'tactical', {});
  assert.equal(d.state.our_base.lost_hp_last_5s, 1);
  assert.match(d.options.defend_our_base, /lost 1 hp in the last 5s/);
  assert.doesNotMatch(d.options.defend_our_base, /URGENT/);
  const covered = buildDecision(g, g.getTank('B2'), 'tactical', { allyPlan: 'defend_our_base' });
  assert.equal(covered.state.teammate_covering_base, true);
  assert.match(covered.options.defend_our_base, /already covering/);
  assert.match(covered.questions.tactic.instructions, /at most one defender/);
  for (let i = 0; i < 60 * 6; i++) m.tick(STEP);
  assert.equal(buildDecision(g, g.getTank('B2'), 'tactical', {}).state.our_base.lost_hp_last_5s, 0);
});

test('进攻路线：三侧射击位各自可达，执行层会往选定的那一侧走', async () => {
  const { attackSideSpots } = await import('../public/js/observe.js');
  const g = new Match({ kinds: RULE, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 }).game;
  const left = attackSideSpots(g, 'blue', 'left');
  const right = attackSideSpots(g, 'blue', 'right');
  const front = attackSideSpots(g, 'blue', 'front');
  assert.ok(left.length && right.length && front.length);
  assert.ok(left.every((s) => s.x < 9 && s.y === 0), '蓝方的左 = 红方基地的西侧');
  assert.ok(right.every((s) => s.x > 9 && s.y === 0));
  assert.ok(front.every((s) => s.x === 9));
  const redLeft = attackSideSpots(g, 'red', 'left');
  assert.ok(redLeft.every((s) => s.x > 9 && s.y === 14), '红方朝下，它的左 = 蓝方基地的东侧');
});

test('反射层：子弹 3 格内飞来就闪，敌车在射线上就打（不管当前计划）', async () => {
  const { Executor } = await import('../public/js/executor.js');
  const m = new Match({ kinds: { B1: 'idle', B2: 'idle', R1: 'idle', R2: 'idle' }, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 });
  const g = m.game;
  const t = g.getTank('B1');
  Object.assign(t, { x: 3, y: 13, fx: 3, fy: 13, moving: null, dir: 'up' }); // (3,13) 左右都是空地
  // 子弹从上方 2 格处往下飞
  g.bullets.push({ id: 99, owner: 'R1', team: 'red', x: 3, y: 11, dir: 'down', alive: true });
  const dodge = new Executor(() => 0).run(g, t, 'attack_front', STEP);
  assert.ok(dodge.move === 'left' || dodge.move === 'right', `应该横向闪开，实际 ${JSON.stringify(dodge)}`);
  g.bullets.length = 0;
  // 敌车在右边同一行、中间无遮挡
  const r1 = g.getTank('R1');
  Object.assign(r1, { x: 6, y: 13, fx: 6, fy: 13 });
  const shot = new Executor(() => 0).run(g, t, 'defend_our_base', STEP);
  assert.deepEqual(shot, { face: 'right', fire: true });
});

test('远程 AI 同队两辆车的决策时间错开半个周期，规则 AI 不错开', async () => {
  const decide = async () => ({ answers: { tactic: { choice: 'hold_position', probabilities: { hold_position: 1 }, confidence: 1 } } });
  const m = new Match({ kinds: { B1: 'remote:t', B2: 'remote:t', R1: 'rule', R2: 'rule' }, settings: { mode: 'tactical', intervalMs: 400, stagger: true }, decide, seed: 1 });
  const times = { B1: [], B2: [], R1: [], R2: [] };
  m.on('decision', (e) => times[e.agent].push(e.time));
  for (let i = 0; i < 60; i++) { m.tick(STEP); await Promise.all(m.pendingDecisions()); }
  assert.ok(times.B1[0] < 0.02, 'B1 开局立刻决策');
  assert.ok(times.B2[0] > 0.15 && times.B2[0] < 0.25, `B2 应在约 0.2s 时首次决策，实际 ${times.B2[0]}`);
  assert.ok(times.R1[0] < 0.02 && times.R2[0] < 0.02, '规则 AI 两辆车都立刻决策');
  // 默认不错开
  const m2 = new Match({ kinds: { B1: 'remote:t', B2: 'remote:t', R1: 'rule', R2: 'rule' }, settings: { mode: 'tactical', intervalMs: 400 }, decide, seed: 1 });
  const first = {};
  m2.on('decision', (e) => { first[e.agent] ??= e.time; });
  for (let i = 0; i < 20; i++) { m2.tick(STEP); await Promise.all(m2.pendingDecisions()); }
  assert.ok(first.B2 < 0.02, `默认情况下 B2 也立刻决策，实际 ${first.B2}`);
});

test('远程后端出错时保持上一个战术并计数', async () => {
  let calls = 0;
  const decide = async () => {
    calls++;
    if (calls === 1) return { answers: { tactic: { choice: 'defend_our_base', probabilities: { defend_our_base: 0.9 }, confidence: 0.8 } }, latency_ms: 5 };
    if (calls === 2) throw new Error('boom');
    return { answers: { tactic: { choice: 'not_an_option' } } };
  };
  const m = new Match({ kinds: { B1: 'rule', B2: 'remote:test', R1: 'idle', R2: 'idle' }, settings: { mode: 'tactical', intervalMs: 200 }, decide, seed: 1 });
  const c = m.controllers.get('B2');
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 20; k++) m.tick(STEP);
    await Promise.all(m.pendingDecisions());
  }
  assert.equal(c.tactic, 'defend_our_base');
  assert.equal(c.stats.decisions, 1);
  assert.equal(c.stats.errors, 2);
  assert.equal(c.stats.invalid, 1);
});
