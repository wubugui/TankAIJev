import { T } from './constants.js';

// 图例：. 空地  # 砖墙(可打碎)  S 钢墙  ~ 水(挡坦克不挡子弹)
//       B 蓝方基地  R 红方基地  b 蓝方出生点  r 红方出生点
// 地图关于中心 180° 旋转对称，保证双方公平。
export const DEFAULT_MAP = [
  '..r.....#R#.....r..',
  '........###........',
  '.##.S.#.....#.S.##.',
  '.##...#.S.S.#...##.',
  '.....S...#...S.....',
  '~~.#...##.##...#.~~',
  '...#.S...S...S.#...',
  'S~..#..#...#..#..~S',
  '...#.S...S...S.#...',
  '~~.#...##.##...#.~~',
  '.....S...#...S.....',
  '.##...#.S.S.#...##.',
  '.##.S.#.....#.S.##.',
  '........###........',
  '..b.....#B#.....b..',
];

export function parseMap(rows = DEFAULT_MAP) {
  const h = rows.length;
  const w = rows[0].length;
  const tiles = new Uint8Array(w * h);
  const bases = {};
  const spawns = { blue: [], red: [] };
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`map row ${y} has length ${rows[y].length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      let tile = T.EMPTY;
      if (ch === '#') tile = T.BRICK;
      else if (ch === 'S') tile = T.STEEL;
      else if (ch === '~') tile = T.WATER;
      else if (ch === 'B') { tile = T.BASE; bases.blue = { x, y }; }
      else if (ch === 'R') { tile = T.BASE; bases.red = { x, y }; }
      else if (ch === 'b') spawns.blue.push({ x, y });
      else if (ch === 'r') spawns.red.push({ x, y });
      tiles[y * w + x] = tile;
    }
  }
  if (!bases.blue || !bases.red) throw new Error('map needs both bases');
  // 让 B1↔R1、B2↔R2 的出生点互为旋转对称
  spawns.blue.sort((a, b) => a.x - b.x);
  spawns.red.sort((a, b) => b.x - a.x);
  return { w, h, tiles, bases, spawns };
}
