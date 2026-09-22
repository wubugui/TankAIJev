// 游戏常量：浏览器和 Node（测试 / arena）共用，不能依赖 DOM。

export const TILE_PX = 40;

export const DIRS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};
export const DIR_LIST = ['up', 'down', 'left', 'right'];
export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const RED_DIR_LIST = DIR_LIST.map((d) => OPPOSITE[d]);
// 平局时按这个顺序挑方向。红方用旋转 180° 后的顺序，保证双方在各自视角下行为完全对称。
export const dirOrder = (team) => (team === 'red' ? RED_DIR_LIST : DIR_LIST);

// 地块类型
export const T = { EMPTY: 0, BRICK: 1, STEEL: 2, WATER: 3, BASE: 4 };

export const DEFAULT_RULES = {
  tankSpeed: 3.0, // 格/秒
  bulletSpeed: 9, // 格/秒
  fireCooldown: 0.8, // 秒
  tankHp: 3,
  lives: 3, // 每辆坦克的总命数（含第一条）
  baseHp: 10,
  respawnDelay: 3,
  spawnShield: 1.5,
  matchSeconds: 180,
};

// 坐标、距离在比较前对齐到 1e-6：消掉浮点累积误差。
// 否则往 +方向 和往 -方向 走的物体误差方向相反，在“正好 3 格”这类临界点上会系统性偏向一边。
export const snap = (v) => Math.round(v * 1e6) / 1e6;

// 移动方向为 dir（+1/-1/0）的物体所在的格：正好在两格交界时算“还在正要离开的那一格”。
// 不能直接 Math.round：它总往大的方向取整，往 +方向 和往 -方向 走的物体会被区别对待。
export function tileAlong(v, dir) {
  const x = snap(v);
  return dir > 0 ? Math.ceil(x - 0.5) : Math.floor(x + 0.5);
}

// 坦克现在算在哪一格：静止时就是所在格；移动中走过一半算目标格，否则算出发格（按走过的距离判断，与方向无关）
export function tankTile(t) {
  if (!t.moving) return { x: t.x, y: t.y };
  const progress = snap(Math.abs(t.fx - t.x) + Math.abs(t.fy - t.y));
  return progress >= 0.5 ? { x: t.moving.x, y: t.moving.y } : { x: t.x, y: t.y };
}

// 可复现的随机数（mulberry32）
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TEAMS = ['blue', 'red'];
export const otherTeam = (team) => (team === 'blue' ? 'red' : 'blue');
