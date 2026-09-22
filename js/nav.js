import { DIRS, T, dirOrder } from './constants.js';

const BRICK_COST = 2.5; // 打穿一块砖大约多花的“步数”

// 基地周围 8 格内的砖是自家城墙，自己寻路时不去拆
export function isWallOf(game, team, x, y) {
  const b = game.bases[team];
  return Math.abs(b.x - x) <= 1 && Math.abs(b.y - y) <= 1;
}

function stepCost(game, x, y, self) {
  const tile = game.tileAt(x, y);
  if (tile === T.STEEL || tile === T.WATER || tile === T.BASE) return Infinity;
  let c = 1;
  if (tile === T.BRICK) {
    if (self && isWallOf(game, self.team, x, y)) return Infinity;
    c += BRICK_COST;
  }
  const other = game.tankAt(x, y, self);
  if (other) c += other.team === self?.team ? 4 : 3;
  return c;
}

// 网格很小（15×13），用 O(n²) 的 Dijkstra 足够快
export function dijkstra(game, sx, sy, self) {
  const n = game.w * game.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[sy * game.w + sx] = 0;
  const dirs = dirOrder(self?.team);
  const reverse = self?.team === 'red'; // 红方倒序扫描 = 旋转 180° 后的顺序
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k;
      if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    }
    if (u < 0) break;
    done[u] = 1;
    const ux = u % game.w;
    const uy = (u / game.w) | 0;
    for (const dir of dirs) {
      const d = DIRS[dir];
      const vx = ux + d.dx;
      const vy = uy + d.dy;
      if (!game.inBounds(vx, vy)) continue;
      const c = stepCost(game, vx, vy, self);
      if (c === Infinity) continue;
      const v = vy * game.w + vx;
      if (best + c < dist[v]) { dist[v] = best + c; prev[v] = u; }
    }
  }
  return { dist, prev, w: game.w, start: sy * game.w + sx };
}

export function distTo(nav, x, y) {
  return nav.dist[y * nav.w + x];
}

// 在目标集合里找最近的，返回 { goal, cost, step: 第一步的坐标 }
export function routeTo(nav, goals) {
  let best = null;
  for (const g of goals) {
    const c = distTo(nav, g.x, g.y);
    if (c < Infinity && (!best || c < best.cost)) best = { goal: g, cost: c };
  }
  if (!best) return null;
  let v = best.goal.y * nav.w + best.goal.x;
  if (v === nav.start) return { ...best, step: null };
  while (nav.prev[v] !== nav.start && nav.prev[v] !== -1) v = nav.prev[v];
  return { ...best, step: { x: v % nav.w, y: (v / nav.w) | 0 } };
}

export function dirBetween(ax, ay, bx, by) {
  if (bx > ax) return 'right';
  if (bx < ax) return 'left';
  if (by > ay) return 'down';
  if (by < ay) return 'up';
  return null;
}

// 同一行/列时返回方向，否则 null
export function alignedDir(ax, ay, bx, by) {
  if (ax === bx && ay !== by) return by > ay ? 'down' : 'up';
  if (ay === by && ax !== bx) return bx > ax ? 'right' : 'left';
  return null;
}

// 从 (x,y) 沿 dir 看出去：
//   first  = 子弹第一个会撞上的东西（砖/钢/坦克/基地/边界）
//   target = 越过砖墙后第一个“非砖”的东西（用来判断砖后面有没有基地）
export function scanLine(game, x, y, dir, self) {
  const d = DIRS[dir];
  let cx = x + d.dx;
  let cy = y + d.dy;
  let dist = 1;
  let bricks = 0;
  let first = null;
  const tanksByTile = new Map();
  for (const t of game.tanks) {
    if (!t.alive || t === self) continue;
    tanksByTile.set(`${Math.round(t.fx)},${Math.round(t.fy)}`, t);
  }
  while (game.inBounds(cx, cy)) {
    const tile = game.tileAt(cx, cy);
    const tank = tanksByTile.get(`${cx},${cy}`);
    let hit = null;
    if (tank) hit = { kind: tank.team === self.team ? 'ally' : 'enemy', id: tank.id, ownBaseBehind: ownBaseExposedBeyond(game, cx, cy, d, self.team) };
    else if (tile === T.BASE) hit = { kind: game.baseAt(cx, cy).team === self.team ? 'own_base' : 'enemy_base' };
    else if (tile === T.STEEL) hit = { kind: 'steel' };
    if (hit) {
      const target = { ...hit, dist, x: cx, y: cy, bricks };
      return { first: first || target, target };
    }
    if (tile === T.BRICK) {
      if (!first) first = { kind: 'brick', dist, x: cx, y: cy, ownWall: isWallOf(game, self.team, cx, cy) };
      bricks++;
    }
    cx += d.dx; cy += d.dy; dist++;
  }
  const target = { kind: 'edge', dist, bricks };
  return { first: first || target, target };
}

// 目标坦克身后是否直接暴露着自家基地（目标一走开，子弹就会打到基地）
function ownBaseExposedBeyond(game, x, y, d, team) {
  let cx = x + d.dx;
  let cy = y + d.dy;
  while (game.inBounds(cx, cy)) {
    const tile = game.tileAt(cx, cy);
    if (tile === T.BRICK || tile === T.STEEL) return false;
    if (tile === T.BASE) return game.baseAt(cx, cy).team === team;
    cx += d.dx; cy += d.dy;
  }
  return false;
}

// 这一枪打出去安全吗（不打自家基地、不打队友、不拆自家城墙）
export function safeToFire(scan) {
  const f = scan.first;
  if (f.kind === 'own_base' || f.kind === 'ally') return false;
  if (f.ownBaseBehind) return false;
  if (f.kind === 'brick' && f.ownWall) return false;
  return true;
}

// 能站上去且能看到 (tx,ty) 的格子：沿四个方向找，最多 range 格
// allowBricks=true 时砖墙也算（需要先打穿），用于攻击基地
export function firingSpots(game, tx, ty, range, allowBricks, team) {
  const spots = [];
  for (const dir of dirOrder(team)) {
    const d = DIRS[dir];
    let cx = tx + d.dx;
    let cy = ty + d.dy;
    for (let i = 1; i <= range && game.inBounds(cx, cy); i++) {
      const tile = game.tileAt(cx, cy);
      if (tile === T.STEEL || tile === T.BASE) break;
      if (tile === T.BRICK && !allowBricks) break;
      if (tile === T.EMPTY || tile === T.BRICK) spots.push({ x: cx, y: cy });
      cx += d.dx; cy += d.dy;
    }
  }
  return spots;
}
