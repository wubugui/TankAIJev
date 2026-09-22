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

test('决策请求格式：选项合法、精简版不超 Laya 的题目预算、state 可序列化', () => {
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
      // Laya 英文版每题的题目+选项上限 192 token；按 1 token ≈ 3.2 字符粗估，留余量
      for (const q of Object.values(compact.questions)) {
        const header = q.instructions + Object.entries(q.criteria).map(([k, v]) => `${k} ${v}`).join(' ');
        assert.ok(header.length < 560, `精简版题目过长：${header.length} 字符`);
      }
      if (mode === 'tactical') assert.ok(full.options.attack_enemy_base && full.options.defend_our_base && full.options.hold_position);
      else assert.equal(Object.keys(full.options).length, 9);
    }
  }
});

test('v2 提示词：角色、队友计划、基地态势；v1 保持原样', () => {
  const m = new Match({ kinds: RULE, settings: { mode: 'tactical', intervalMs: 400 }, seed: 3 });
  for (let i = 0; i < 60 * 9; i++) m.tick(STEP);
  const ctx = m.context();
  assert.equal(ctx.plans.R1, m.controllers.get('R1').tactic, '上下文里带着每辆车当前的战术');
  const r2 = m.game.getTank('R2');
  const v2 = buildDecision(m.game, r2, 'tactical', { promptVersion: 'v2', allyPlan: 'attack_enemy_base' });
  assert.equal(v2.state.you.role, 'guard');
  assert.equal(m.game.getTank('R1').index, 0);
  assert.equal(v2.state.teammate.current_plan, 'attacking the enemy base');
  assert.ok('lost_hp_last_5s' in v2.state.our_base && 'in_danger' in v2.state.our_base && 'walls_left' in v2.state.enemy_base);
  assert.match(v2.questions.tactic.instructions, /Priorities/);
  const v1 = buildDecision(m.game, r2, 'tactical', { promptVersion: 'v1' });
  assert.equal(v1.state.you.role, undefined);
  assert.equal(v1.state.our_base.in_danger, undefined);
  assert.doesNotMatch(v1.questions.tactic.instructions, /Priorities/);
  assert.deepEqual(Object.keys(v1.options).sort(), Object.keys(v2.options).sort(), '两个版本的选项 id 一致');
});

test('基地近 5 秒掉血会被标记为告急', () => {
  const m = new Match({ kinds: { B1: 'idle', B2: 'idle', R1: 'idle', R2: 'idle' }, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 });
  const g = m.game;
  for (let i = 0; i < 60; i++) m.tick(STEP);
  g.bases.blue.hitTimes.push(g.time);
  const d = buildDecision(g, g.getTank('B2'), 'tactical', {});
  assert.equal(d.state.our_base.lost_hp_last_5s, 1);
  assert.equal(d.state.our_base.in_danger, true);
  assert.match(d.options.defend_our_base, /lost 1 hp in the last 5s/);
  assert.match(buildDecision(g, g.getTank('B2'), 'tactical', { promptVersion: 'v2' }).options.defend_our_base, /URGENT/);
  for (let i = 0; i < 60 * 6; i++) m.tick(STEP);
  assert.equal(buildDecision(g, g.getTank('B2'), 'tactical', {}).state.our_base.lost_hp_last_5s, 0);
});

test('队友没命了角色变成 solo', () => {
  const m = new Match({ kinds: RULE, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 });
  Object.assign(m.game.getTank('B2'), { alive: false, lives: 0 });
  assert.equal(buildDecision(m.game, m.game.getTank('B1'), 'tactical', { promptVersion: 'v2' }).state.you.role, 'solo');
});

test('v3 提示词：协作开关 teammate_covering_base，不加角色和优先级，不用催促措辞', () => {
  const m = new Match({ kinds: { B1: 'idle', B2: 'idle', R1: 'idle', R2: 'idle' }, settings: { mode: 'tactical', intervalMs: 400 }, seed: 1 });
  const g = m.game;
  const b2 = g.getTank('B2');
  const r1 = g.getTank('R1');
  Object.assign(r1, { x: 9, y: 11, fx: 9, fy: 11 }); // 蓝方基地在 (9,14)，R1 距离 3 格
  // 队友在追别的车、离基地远 → 没人照看基地
  const d = buildDecision(g, b2, 'tactical', { promptVersion: 'v3', allyPlan: 'hunt_R2' });
  assert.equal(d.state.you.role, undefined);
  assert.equal(d.state.teammate.current_plan, 'hunting enemy R2');
  assert.equal(d.state.our_base.in_danger, true);
  assert.equal(d.state.teammate_covering_base, false);
  assert.match(d.questions.tactic.instructions, /exactly one defender/);
  assert.doesNotMatch(d.questions.tactic.instructions, /Priorities|Your role/);
  assert.doesNotMatch(d.options.defend_our_base, /URGENT/);
  assert.doesNotMatch(d.options.attack_enemy_base, /walls left/);
  assert.match(d.options.hunt_R1, /3 tiles from OUR base/);
  assert.doesNotMatch(d.options.hunt_R2, /OUR base/);
  // 队友正在追靠近基地的 R1 → 算作已照看
  const covered = buildDecision(g, b2, 'tactical', { promptVersion: 'v3', allyPlan: 'hunt_R1' });
  assert.equal(covered.state.teammate_covering_base, true);
  assert.match(covered.options.defend_our_base, /already covering/);
  const compact = buildDecision(g, b2, 'tactical', { promptVersion: 'v3', style: 'compact', allyPlan: 'defend_our_base' });
  assert.match(compact.options.hunt_R1, /near OUR base/);
  assert.match(compact.options.defend_our_base, /teammate already covers/);
  // v2 保留催促措辞和 walls left
  const v2 = buildDecision(g, b2, 'tactical', { promptVersion: 'v2' });
  assert.match(v2.options.defend_our_base, /URGENT/);
  assert.match(v2.options.attack_enemy_base, /walls left/);
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
