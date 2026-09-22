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

export const TEAMS = ['blue', 'red'];
export const otherTeam = (team) => (team === 'blue' ? 'red' : 'blue');
