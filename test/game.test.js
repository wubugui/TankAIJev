import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/js/game.js';
import { DEFAULT_MAP, parseMap } from '../public/js/map.js';
import { T } from '../public/js/constants.js';
import { dijkstra, distTo, scanLine } from '../public/js/nav.js';

// 把地图清空成只有基地的空地，方便摆测试场景
function emptyGame(rules = {}) {
  const g = new Game({ rules });
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.tileAt(x, y) !== T.BASE) g.setTile(x, y, T.EMPTY);
  return g;
}

function place(g, id, x, y, dir) {
  const t = g.getTank(id);
  Object.assign(t, { x, y, fx: x, fy: y, dir, moving: null, shieldUntil: 0 });
  return t;
}

function park(g, ...ids) {
  // 把不参与测试的坦克挪到角落
  const spots = [[0, 7], [18, 7], [0, 6], [18, 6]];
  ids.forEach((id, i) => place(g, id, spots[i][0], spots[i][1], 'up'));
}

test('地图 180° 旋转对称', () => {
  const h = DEFAULT_MAP.length;
  const w = DEFAULT_MAP[0].length;
  const swap = { b: 'r', r: 'b', B: 'R', R: 'B' };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = DEFAULT_MAP[y][x];
      const b = DEFAULT_MAP[h - 1 - y][w - 1 - x];
      assert.equal(swap[a] || a, b, `(${x},${y}) 与对称位置不一致`);
    }
  }
});

test('出生点都能走到对方基地附近', () => {
  const g = new Game();
  for (const t of g.tanks) {
    const nav = dijkstra(g, t.x, t.y, t);
    const foe = g.bases[t.team === 'blue' ? 'red' : 'blue'];
    assert.ok(distTo(nav, foe.x, foe.y + (t.team === 'blue' ? 2 : -2)) < Infinity, `${t.id} 走不到对方基地前`);
  }
});

test('子弹打碎砖墙，被钢墙挡住', () => {
  const g = emptyGame();
  park(g, 'B2', 'R1', 'R2');
  place(g, 'B1', 5, 10, 'up');
  g.setTile(5, 8, T.BRICK);
  g.setTile(5, 6, T.STEEL);
  g.setInput('B1', { fire: true });
  for (let i = 0; i < 30; i++) g.step(1 / 60);
  assert.equal(g.tileAt(5, 8), T.EMPTY, '砖应被打碎');
  g.setInput('B1', { fire: true });
  for (let i = 0; i < 90; i++) g.step(1 / 60);
  assert.equal(g.tileAt(5, 6), T.STEEL, '钢墙不应被打坏');
});

test('友军子弹不伤队友，但会打坏自家基地', () => {
  const g = emptyGame();
  park(g, 'R1', 'R2');
  place(g, 'B1', 9, 10, 'down'); // 蓝方基地在 (9,14)
  place(g, 'B2', 9, 12, 'up');
  g.setInput('B1', { fire: true });
  for (let i = 0; i < 30; i++) g.step(1 / 60);
  assert.equal(g.getTank('B2').hp, 3, '队友不掉血');
  place(g, 'B2', 3, 3, 'up');
  g.setInput('B1', { fire: false });
  for (let i = 0; i < 60; i++) g.step(1 / 60);
  g.setInput('B1', { fire: true });
  for (let i = 0; i < 40; i++) g.step(1 / 60);
  assert.equal(g.bases.blue.hp, g.rules.baseHp - 1, '自家基地掉 1 血');
});

test('坦克被打爆后扣命并按时复活', () => {
  const g = emptyGame({ tankHp: 1 });
  park(g, 'B2', 'R2');
  place(g, 'B1', 4, 10, 'up');
  place(g, 'R1', 4, 5, 'down');
  g.setInput('B1', { fire: true });
  for (let i = 0; i < 40; i++) g.step(1 / 60);
  const r1 = g.getTank('R1');
  assert.equal(r1.alive, false);
  assert.equal(r1.lives, g.rules.lives - 1);
  assert.equal(g.getTank('B1').kills, 1);
  g.setInput('B1', {});
  for (let i = 0; i < 60 * (g.rules.respawnDelay + 0.2); i++) g.step(1 / 60);
  assert.equal(r1.alive, true, '应已复活');
  assert.deepEqual([r1.x, r1.y], [r1.spawn.x, r1.spawn.y]);
});

test('胜负判定：拆家 / 全歼 / 超时', () => {
  const a = new Game();
  a.bases.red.hp = 0;
  a.step(1 / 60);
  assert.deepEqual([a.winner, a.reason], ['blue', 'base']);

  const b = new Game();
  for (const t of b.tanks.filter((t) => t.team === 'blue')) Object.assign(t, { alive: false, lives: 0 });
  b.step(1 / 60);
  assert.deepEqual([b.winner, b.reason], ['red', 'eliminated']);

  const c = new Game({ rules: { matchSeconds: 1 } });
  c.bases.blue.hp = 5;
  for (let i = 0; i < 70; i++) c.step(1 / 60);
  assert.deepEqual([c.winner, c.reason], ['red', 'timeout']);
});

test('scanLine 能看到砖墙后面的基地', () => {
  const g = emptyGame();
  park(g, 'B1', 'B2', 'R2');
  const r1 = place(g, 'R1', 9, 10, 'down');
  g.setTile(9, 13, T.BRICK);
  const s = scanLine(g, r1.x, r1.y, 'down', r1);
  assert.equal(s.first.kind, 'brick');
  assert.equal(s.target.kind, 'enemy_base');
});

test('parseMap 拒绝缺基地的地图', () => {
  assert.throws(() => parseMap(['...', '...']));
});

test('引擎对称：镜像位置的坦克用同样的随机数，开局一段时间内逐帧互为 180° 镜像', async () => {
  const { Match, STEP } = await import('../public/js/match.js');
  const { makeRng } = await import('../public/js/policies.js');
  const FLIP = { up: 'down', down: 'up', left: 'right', right: 'left' };
  for (const seed of [1, 2, 3]) {
    const m = new Match({ kinds: { B1: 'rule', B2: 'rule', R1: 'rule', R2: 'rule' }, settings: { mode: 'tactical', intervalMs: 400 }, seed });
    const g = m.game;
    const W = g.w - 1;
    const H = g.h - 1;
    for (const [b, r] of [['B1', 'R1'], ['B2', 'R2']]) {
      const s = seed * 31 + m.controllers.get(b).tank.index * 7;
      for (const id of [b, r]) { const c = m.controllers.get(id); c.rng = makeRng(s); c.exec.rng = c.rng; }
    }
    // 前 3 秒双方还没有正面相遇，不会出现“同一帧抢同一格”这种只能交替裁决的情况，必须严格对称
    for (let f = 0; f < 60 * 3; f++) {
      m.tick(STEP);
      for (const [b, r] of [['B1', 'R1'], ['B2', 'R2']]) {
        const B = g.getTank(b);
        const R = g.getTank(r);
        assert.ok(Math.abs(B.fx - (W - R.fx)) < 1e-6 && Math.abs(B.fy - (H - R.fy)) < 1e-6, `seed ${seed} 第 ${f} 帧 ${b}/${r} 位置不对称`);
        assert.equal(B.dir, FLIP[R.dir], `seed ${seed} 第 ${f} 帧 ${b}/${r} 朝向不对称`);
      }
    }
  }
});
