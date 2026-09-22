import { DIRS, DIR_LIST, T, otherTeam, snap, tileAlong, tankTile } from './constants.js';
import { dijkstra, distTo, scanLine, alignedDir, firingSpots } from './nav.js';

// 把局面整理成给决策模型的 { state, questions }。
//
// 分工（战术层）：模型只做高层决定——从哪一侧进攻、守家、追谁、支援队友、撤退、坚守；
// 瞄准、开火、闪避、寻路、破墙全部由执行层（executor.js）处理，这些对延迟敏感，不交给模型。
// 为了让模型能判断策略，state 里给出整个战场：每辆坦克在哪、往哪走、看起来在干什么。
//
// 给模型看的文字全部用英文：Jev 和 Laya（英文版）对英文最准。

export const ORDER_TEXT = {
  attack: 'attack the enemy base',
  defend: 'defend our base',
  follow: 'stay close to me and cover me',
};

export const CALLOUTS = {
  none: 'Say nothing right now.',
  roger: 'Acknowledge the latest order from the human teammate.',
  need_help: 'Ask the teammate for help (you are hurt or outnumbered).',
  enemy_near_base: 'Warn that an enemy is close to our base.',
  attacking: 'Tell the teammate you are pushing the enemy base.',
  defending: 'Tell the teammate you are going back to defend.',
};

export const CALLOUTS_COMPACT = {
  none: 'say nothing',
  roger: 'acknowledge the order',
  need_help: 'ask for help',
  enemy_near_base: 'warn: enemy near our base',
  attacking: 'say you are attacking',
  defending: 'say you are defending',
};

export const ATTACK_SIDES = ['left', 'front', 'right'];

const round1 = (v) => (v === Infinity ? null : Math.round(v * 10) / 10);
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tileOf = (t) => { const at = tankTile(t); return [at.x, at.y]; };
const zoneOfTank = (game, t, team) => { const at = tankTile(t); return zoneOf(game, at.x, at.y, team); };

// ---------- 子弹（执行层的本能闪避也用它） ----------
// 离坦克最近、正朝它飞来且中间没有遮挡的敌方子弹
export function incomingBullet(game, tank, maxDist = 7) {
  let best = null;
  for (const b of game.bullets) {
    if (b.team === tank.team) continue;
    const d = DIRS[b.dir];
    const along = snap((tank.fx - b.x) * d.dx + (tank.fy - b.y) * d.dy); // 子弹前方的距离
    const across = snap(Math.abs((tank.fx - b.x) * d.dy) + Math.abs((tank.fy - b.y) * d.dx));
    if (along <= 0 || along > maxDist || across > 0.6) continue;
    let blocked = false; // 路径上有砖/钢就挡住了
    for (let s = 1; s < along; s++) {
      const tile = game.tileAt(tileAlong(b.x + d.dx * s, d.dx), tileAlong(b.y + d.dy * s, d.dy));
      if (tile === T.BRICK || tile === T.STEEL) { blocked = true; break; }
    }
    if (blocked) continue;
    if (!best || along < best.dist) {
      const from = { up: 'down', down: 'up', left: 'right', right: 'left' }[b.dir];
      best = { dist: Math.round(along * 10) / 10, from, travelDir: b.dir };
    }
  }
  return best;
}

// ---------- 区域、移动、意图（都以观察者所在队伍的视角描述） ----------
const LANE_EDGE = 5; // x ≤ 5、x ≥ w-6 算两侧通道

// 例如 "left lane, our half" / "center, midfield" / "near enemy base"
// 左右以“面朝敌方基地”为准：蓝方朝上，西边是左；红方朝下，东边是左
export function zoneOf(game, x, y, team) {
  const own = game.bases[team];
  const foe = game.bases[otherTeam(team)];
  if (manhattan({ x, y }, own) <= 4) return 'near our base';
  if (manhattan({ x, y }, foe) <= 4) return 'near enemy base';
  const west = x <= LANE_EDGE;
  const east = x >= game.w - 1 - LANE_EDGE;
  const lane = west ? (team === 'blue' ? 'left lane' : 'right lane') : east ? (team === 'blue' ? 'right lane' : 'left lane') : 'center';
  const mid = (game.h - 1) / 2;
  const ours = own.y > mid ? y > mid : y < mid;
  const half = Math.abs(y - mid) < 0.5 ? 'midfield' : ours ? 'our half' : 'enemy half';
  return `${lane}, ${half}`;
}

// 最近约 1 秒的位移（来自 game.js 记录的轨迹）
function recentMove(game, t) {
  const past = (t.trail || []).find((p) => game.time - p.time <= 1.25);
  if (!past || game.time - past.time < 0.4) return { past: null, dist: 0 };
  return { past, dist: Math.abs(t.fx - past.x) + Math.abs(t.fy - past.y) };
}

// 相对观察方两座基地的移动方向
function headingOf(game, t, team) {
  if (!t.alive) return 'dead';
  const { past, dist } = recentMove(game, t);
  if (!past || dist < 0.6) return 'stationary';
  const own = game.bases[team];
  const foe = game.bases[otherTeam(team)];
  const pos = { x: t.fx, y: t.fy };
  if (manhattan(past, own) - manhattan(pos, own) >= 0.8) return 'moving toward our base';
  if (manhattan(past, foe) - manhattan(pos, foe) >= 0.8) return 'moving toward enemy base';
  return 'moving sideways';
}

// 程序推断的敌车意图（观察方视角）
function enemyIntent(game, e, team) {
  if (!e.alive) return e.lives > 0 ? 'dead, respawning' : 'out of lives';
  const own = game.bases[team];
  const theirs = game.bases[otherTeam(team)];
  const pos = { x: e.fx, y: e.fy };
  const { past, dist } = recentMove(game, e);
  if (manhattan(pos, own) <= 4) return 'attacking our base';
  if (past && manhattan(past, own) - manhattan(pos, own) >= 1) return 'advancing toward our base';
  if (manhattan(pos, theirs) <= 4) return 'guarding their base';
  if (past) {
    for (const o of game.tanks) {
      if (o.team !== team || !o.alive) continue;
      const now = manhattan(pos, { x: o.fx, y: o.fy });
      if (now <= 7 && manhattan(past, { x: o.fx, y: o.fy }) - now >= 1) return `chasing ${o.id}`;
    }
    if (manhattan(past, theirs) - manhattan(pos, theirs) >= 1) return 'falling back';
  }
  return dist < 0.6 ? 'holding position' : 'repositioning';
}

const PLAN_TEXT = {
  attack_left: 'attacking the enemy base from the left',
  attack_front: 'attacking the enemy base from the front',
  attack_right: 'attacking the enemy base from the right',
  attack_enemy_base: 'attacking the enemy base',
  defend_our_base: 'defending our base',
  follow_teammate: 'supporting its teammate',
  retreat: 'falling back to regroup',
  hold_position: 'holding position',
  wait: 'waiting',
};

export function planText(plan) {
  if (!plan) return 'none yet';
  if (plan.startsWith('hunt_')) return `hunting enemy ${plan.slice(5)}`;
  if (plan.startsWith('move_')) return `moving ${plan.slice(5)}`;
  if (plan.startsWith('fire_')) return `firing ${plan.slice(5)}`;
  return PLAN_TEXT[plan] || plan;
}

// ---------- 进攻路线：敌方基地的左侧 / 正面 / 右侧射击位 ----------
// 射击位 = 与基地同行或同列、5 格以内、中间只有砖（可打穿）的格子
export function attackSideSpots(game, team, side) {
  const base = game.bases[otherTeam(team)];
  const spots = firingSpots(game, base.x, base.y, 5, true, team);
  if (!side) return spots;
  return spots.filter((s) => sideOfSpot(base, s, team) === side);
}

// 从射击位打到基地要先打穿几块砖（射击位本身是砖也算，得先打掉才能站上去）
export function wallsToBase(game, spot, base) {
  const dx = Math.sign(base.x - spot.x);
  const dy = Math.sign(base.y - spot.y);
  let n = 0;
  for (let x = spot.x, y = spot.y; x !== base.x || y !== base.y; x += dx, y += dy) {
    if (game.tileAt(x, y) === T.BRICK) n++;
  }
  return n;
}

function sideOfSpot(base, s, team) {
  if (s.x === base.x) return 'front';
  const west = s.x < base.x;
  return west === (team === 'blue') ? 'left' : 'right';
}

// 基地周围 8 格的砖墙数、近 5 秒掉的血
function baseStatus(game, team) {
  const b = game.bases[team];
  const lost5 = (b.hitTimes || []).filter((t) => game.time - t <= 5).length;
  let walls = 0;
  let spots = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = b.x + dx;
      const y = b.y + dy;
      if (!game.inBounds(x, y)) continue;
      spots++;
      if (game.tileAt(x, y) === T.BRICK) walls++;
    }
  }
  return { lost5, walls, spots };
}

// 基地前方的站岗点：距基地 2~3 格的空地
export function guardPosts(game, team) {
  const b = game.bases[team];
  const posts = [];
  for (let y = 0; y < game.h; y++) {
    for (let x = 0; x < game.w; x++) {
      const d = Math.abs(x - b.x) + Math.abs(y - b.y);
      if (d >= 2 && d <= 3 && game.tileAt(x, y) === T.EMPTY) posts.push({ x, y });
    }
  }
  return team === 'red' ? posts.reverse() : posts;
}

// ---------- 分析：做决策需要的全部事实 ----------
export function analyze(game, tank, ctx = {}) {
  const team = tank.team;
  const foe = otherTeam(team);
  const nav = dijkstra(game, tank.x, tank.y, tank);
  const ally = game.tanks.find((t) => t.team === team && t !== tank) || null;
  const enemies = game.tanks.filter((t) => t.team === foe);
  const lines = {};
  for (const dir of DIR_LIST) lines[dir] = scanLine(game, tank.x, tank.y, dir, tank);

  const ownBase = game.bases[team];
  const enemyBase = game.bases[foe];
  const pathDist = (x, y) => distTo(nav, x, y);
  const minSpot = (spots) => spots.reduce((m, s) => Math.min(m, pathDist(s.x, s.y)), Infinity);

  const enemyInfo = enemies.map((e) => ({
    tank: e,
    id: e.id,
    alive: e.alive,
    path: e.alive ? pathDist(e.x, e.y) : Infinity,
    distToOurBase: e.alive ? manhattan(e, ownBase) : Infinity,
    distToTheirBase: e.alive ? manhattan(e, enemyBase) : Infinity,
    intent: enemyIntent(game, e, team),
  }));
  const aliveEnemies = enemyInfo.filter((e) => e.alive);
  const nearestEnemy = aliveEnemies.reduce((m, e) => (!m || e.path < m.path ? e : m), null);
  const baseThreat = aliveEnemies.reduce((m, e) => (!m || e.distToOurBase < m.distToOurBase ? e : m), null);

  // 三条进攻路线：到最近射击位的路程、从那里还要打穿几块砖，以及附近有哪些敌车
  const attackSides = {};
  for (const side of ATTACK_SIDES) {
    const spots = attackSideSpots(game, team, side);
    const near = aliveEnemies.filter((e) => spots.some((s) => manhattan(s, e.tank) <= 4)).map((e) => e.id);
    const best = spots.reduce((m, s) => (pathDist(s.x, s.y) < (m ? pathDist(m.x, m.y) : Infinity) ? s : m), null);
    attackSides[side] = { dist: best ? pathDist(best.x, best.y) : Infinity, walls: best ? wallsToBase(game, best, enemyBase) : 0, near };
  }
  const attackDist = Math.min(...ATTACK_SIDES.map((s) => attackSides[s].dist));

  const order = ctx.order && ctx.order.order !== 'free' ? ctx.order : null;
  const ownStatus = baseStatus(game, team);
  const enemyStatus = baseStatus(game, foe);
  // 基地告急：最近 5 秒掉过血，或有敌人在 4 格内
  const baseDanger = ownStatus.lost5 > 0 || Boolean(baseThreat && baseThreat.distToOurBase <= 4);
  // 队友是否已经在照看基地：正在守家、正在追最靠近基地的敌车、或人就在基地附近
  const allyCovering = Boolean(ally && ally.alive && (
    ctx.allyPlan === 'defend_our_base'
    || (baseThreat && ctx.allyPlan === `hunt_${baseThreat.id}`)
    || manhattan(ally, ownBase) <= 4));

  return {
    tank, team, foe, nav, ally, lines, ownBase, enemyBase,
    ownStatus, enemyStatus, baseDanger, allyCovering,
    enemies: enemyInfo, nearestEnemy, baseThreat,
    attackSides, attackDist,
    incoming: incomingBullet(game, tank),
    guardDist: minSpot(guardPosts(game, team)),
    allyDist: ally && ally.alive ? pathDist(ally.x, ally.y) : Infinity,
    gunReady: game.canFire(tank),
    order,
    timeLeft: Math.max(0, game.rules.matchSeconds - game.time),
  };
}

// ---------- state ----------
function stateFull(game, a, ctx) {
  const t = a.tank;
  const hp = (x) => `${x.hp}/${game.rules.tankHp}`;
  const respawn = (x) => (x.lives > 0 ? Math.max(0, Math.round((x.respawnAt - game.time) * 10) / 10) : null);
  const threatening = a.enemies.filter((e) => e.alive && e.distToOurBase <= 5).map((e) => e.id);
  const guarding = a.enemies.filter((e) => e.alive && e.distToTheirBase <= 4).map((e) => e.id);
  return {
    you: {
      id: t.id,
      team: t.team,
      tile: [t.x, t.y],
      zone: zoneOf(game, t.x, t.y, a.team),
      facing: t.dir,
      hp: hp(t),
      lives_left: t.lives,
      current_plan: planText(ctx.selfPlan),
    },
    teammate: a.ally
      ? {
          id: a.ally.id,
          driver: ctx.allyIsHuman ? 'human player' : 'AI',
          alive: a.ally.alive,
          ...(a.ally.alive
            ? {
                tile: tileOf(a.ally),
                zone: zoneOfTank(game, a.ally, a.team),
                hp: hp(a.ally),
                plan: ctx.allyIsHuman ? 'decided by the human' : planText(ctx.allyPlan),
                heading: headingOf(game, a.ally, a.team),
                distance: round1(a.allyDist),
              }
            : { respawn_in_s: respawn(a.ally) }),
          lives_left: a.ally.lives,
        }
      : null,
    teammate_order: a.order ? `${ORDER_TEXT[a.order.order]} (given ${Math.round(game.time - a.order.time)}s ago)` : 'none',
    teammate_covering_base: a.allyCovering,
    enemies: a.enemies.map((e) => (e.alive
      ? {
          id: e.id,
          tile: tileOf(e.tank),
          zone: zoneOfTank(game, e.tank, a.team),
          hp: hp(e.tank),
          lives_left: e.tank.lives,
          heading: headingOf(game, e.tank, a.team),
          intent: e.intent,
          distance_from_you: round1(e.path),
          distance_to_our_base: e.distToOurBase,
        }
      : { id: e.id, alive: false, lives_left: e.tank.lives, respawn_in_s: respawn(e.tank) })),
    our_base: {
      hp: `${a.ownBase.hp}/${game.rules.baseHp}`,
      walls_left: `${a.ownStatus.walls}/${a.ownStatus.spots}`,
      lost_hp_last_5s: a.ownStatus.lost5,
      threatened_by: threatening,
      your_distance: round1(a.guardDist),
    },
    enemy_base: {
      hp: `${a.enemyBase.hp}/${game.rules.baseHp}`,
      walls_left: `${a.enemyStatus.walls}/${a.enemyStatus.spots}`,
      lost_hp_last_5s: a.enemyStatus.lost5,
      guarded_by: guarding,
    },
    time_left_s: Math.round(a.timeLeft),
    kills: { ours: game.teamKills(a.team), theirs: game.teamKills(a.foe) },
  };
}

// 精简版：Laya 英文版只能读约 316 token 的 state，用短句代替 JSON 字段
function stateCompact(game, a, ctx) {
  const t = a.tank;
  const zone = (x) => zoneOfTank(game, x, a.team);
  const enemies = a.enemies.map((e) => (e.alive
    ? `${e.id} hp ${e.tank.hp}, ${zone(e.tank)}, ${e.intent}, ${e.distToOurBase} from our base, ${round1(e.path)} from you`
    : `${e.id} dead${e.tank.lives > 0 ? ', respawning' : ', out'}`));
  const threatening = a.enemies.filter((e) => e.alive && e.distToOurBase <= 5).map((e) => e.id);
  const guarding = a.enemies.filter((e) => e.alive && e.distToTheirBase <= 4).map((e) => e.id);
  let mate = 'none';
  if (a.ally) {
    mate = a.ally.alive
      ? `${a.ally.id} ${ctx.allyIsHuman ? 'human' : 'AI'} hp ${a.ally.hp}, ${zone(a.ally)}, ${ctx.allyIsHuman ? 'human decides' : planText(ctx.allyPlan)}, ${round1(a.allyDist)} away`
      : `${a.ally.id} dead`;
  }
  const state = {
    you: `${t.id} hp ${t.hp}, ${zoneOf(game, t.x, t.y, a.team)}, ${planText(ctx.selfPlan)}`,
    mate,
    covered: a.allyCovering,
    enemies,
    our_base: `hp ${a.ownBase.hp}/${game.rules.baseHp}, walls ${a.ownStatus.walls}/${a.ownStatus.spots}${a.ownStatus.lost5 ? `, lost ${a.ownStatus.lost5} hp in 5s` : ''}${threatening.length ? `, threatened by ${threatening.join(' ')}` : ''}`,
    enemy_base: `hp ${a.enemyBase.hp}/${game.rules.baseHp}, walls ${a.enemyStatus.walls}/${a.enemyStatus.spots}${guarding.length ? `, guarded by ${guarding.join(' ')}` : ''}`,
  };
  if (a.order) state.order = ORDER_TEXT[a.order.order];
  return state;
}

// ---------- 战术层选项：只有高层计划 ----------
function tacticalOptions(game, a, style) {
  const o = {};
  const c = style === 'compact';
  const tiles = (v) => (v === Infinity ? 'unreachable' : `${round1(v)} tile${round1(v) === 1 ? '' : 's'}`);
  for (const side of ATTACK_SIDES) {
    const info = a.attackSides[side];
    if (info.dist === Infinity) continue; // 这一侧没有能到达的射击位
    // 精简版不写附近的敌车（state 里已有每辆敌车的位置），给 Laya 的题目长度（约 192 token）留余量
    const near = info.near.length && !c ? `; enemy ${info.near.join(' and ')} is near that side` : '';
    const walls = `${info.walls} wall${info.walls === 1 ? '' : 's'}`;
    o[`attack_${side}`] = c
      ? `attack ${side} (${tiles(info.dist)}, ${walls})`
      : `Attack the enemy base from its ${side} side (${tiles(info.dist)} to a firing spot, then ${walls} to shoot through before the base${near}).`;
  }
  const why = a.ownStatus.lost5 > 0
    ? (c ? `lost ${a.ownStatus.lost5} hp in 5s` : `it lost ${a.ownStatus.lost5} hp in the last 5s`)
    : a.baseThreat && a.baseThreat.distToOurBase <= 5 ? (c ? `${a.baseThreat.id} ${a.baseThreat.distToOurBase} tiles from it` : `enemy ${a.baseThreat.id} is ${a.baseThreat.distToOurBase} tiles from it`) : '';
  const covered = a.allyCovering ? (c ? ', teammate covers it' : '; your teammate is already covering it') : '';
  o.defend_our_base = c
    ? (why ? `defend base (${why}${covered})` : `guard base (${tiles(a.guardDist)}, safe${covered})`)
    : (why ? `Go back and defend our base (${why}; you are ${tiles(a.guardDist)} away${covered}).` : `Go back and guard our base (${tiles(a.guardDist)} away; nothing threatens it right now${covered}).`);
  for (const e of a.enemies) {
    if (!e.alive) continue;
    o[`hunt_${e.id}`] = c
      ? `hunt ${e.id} (${e.intent}, ${round1(e.path)})`
      : `Hunt enemy tank ${e.id} (${e.intent}, hp ${e.tank.hp}/${game.rules.tankHp}, ${tiles(e.path)} away).`;
  }
  if (a.ally && a.ally.alive) {
    o.follow_teammate = c
      ? `join ${a.ally.id}`
      : `Join teammate ${a.ally.id} and fight alongside them (${tiles(a.allyDist)} away).`;
  }
  if (a.tank.hp < game.rules.tankHp || (a.nearestEnemy && a.nearestEnemy.path <= 6)) {
    o.retreat = c ? 'retreat to regroup' : `Fall back to our base and regroup (your hp ${a.tank.hp}/${game.rules.tankHp}).`;
  }
  o.hold_position = c ? 'hold here' : 'Hold your current position and shoot enemies that come into line.';
  return o;
}

// ---------- 直接控制（实验）：模型每一步选移动 / 开火 ----------
function describeTile(game, a, x, y, c) {
  const tile = game.tileAt(x, y);
  if (!game.inBounds(x, y)) return c ? 'blocked' : 'blocked by the map edge';
  if (tile === T.STEEL) return c ? 'steel' : 'blocked by steel';
  if (tile === T.WATER) return c ? 'water' : 'blocked by water';
  if (tile === T.BASE) return c ? 'base' : 'blocked by a base';
  if (tile === T.BRICK) return c ? 'brick' : 'brick wall (shoot it first; you will only turn)';
  const other = game.tankAt(x, y, a.tank);
  if (other) return c ? `${other.id} there` : `occupied by ${other.team === a.team ? 'teammate' : 'enemy'} ${other.id} (you will only turn)`;
  return 'open';
}

function directOptions(game, a, style) {
  const o = {};
  const c = style === 'compact';
  const t = a.tank;
  const spots = attackSideSpots(game, a.team, null);
  for (const dir of DIR_LIST) {
    const d = DIRS[dir];
    const nx = t.x + d.dx;
    const ny = t.y + d.dy;
    const parts = [describeTile(game, a, nx, ny, c)];
    if (game.isPassable(nx, ny, t)) {
      const probe = dijkstra(game, nx, ny, t);
      const after = spots.reduce((m, s) => Math.min(m, distTo(probe, s.x, s.y)), Infinity);
      if (after < a.attackDist) parts.push(c ? 'closer to enemy base' : 'gets closer to the enemy base');
      else if (after > a.attackDist) parts.push(c ? 'away from enemy base' : 'moves away from the enemy base');
      const threatened = a.enemies.some((e) => {
        if (!e.alive) return false;
        const toward = alignedDir(nx, ny, e.tank.x, e.tank.y);
        return toward && scanLine(game, nx, ny, toward, t).first.id === e.id;
      });
      if (threatened) parts.push(c ? 'in enemy fire line' : 'that tile is in an enemy line of fire');
    }
    o[`move_${dir}`] = c ? `move ${dir}: ${parts.join(', ')}` : `Move ${dir}: ${parts.join('; ')}.`;
  }
  for (const dir of DIR_LIST) {
    const s = a.lines[dir];
    const f = s.first;
    let what;
    if (f.kind === 'enemy') {
      what = c ? `hits enemy ${f.id}` : `hits enemy tank ${f.id} at ${f.dist} tiles`;
      if (f.ownBaseBehind) what += c ? ', OUR BASE behind it' : ' (WARNING: our own base is right behind it; a miss hits our base)';
    } else if (f.kind === 'ally') what = c ? 'blocked by teammate' : `WARNING: blocked by teammate ${f.id}`;
    else if (f.kind === 'own_base') what = c ? 'HITS OUR BASE' : 'WARNING: hits OUR OWN base';
    else if (f.kind === 'enemy_base') what = c ? 'hits enemy base' : `hits the enemy base at ${f.dist} tiles`;
    else if (f.kind === 'brick') {
      if (f.ownWall) what = c ? 'breaks OUR wall' : 'WARNING: breaks our own base wall';
      else what = c ? 'breaks brick' : `breaks a brick at ${f.dist} tiles`;
      if (s.target.kind === 'enemy_base') what += c ? ', enemy base behind' : ' (the enemy base is behind it)';
      if (s.target.kind === 'enemy') what += c ? `, ${s.target.id} behind` : ` (enemy ${s.target.id} is behind it)`;
    } else if (f.kind === 'steel') what = c ? 'hits steel' : 'hits steel, no effect';
    else what = 'hits nothing';
    const reload = a.gunReady ? '' : c ? ' (reloading)' : ' (gun reloading, no shot)';
    o[`fire_${dir}`] = c ? `fire ${dir}: ${what}${reload}` : `Turn ${dir} and fire: ${what}${reload}.`;
  }
  o.wait = c ? 'wait' : 'Stay still this turn.';
  return o;
}

// ---------- 说明 ----------
export function instructionsFor(game, a, ctx, mode, style = 'full') {
  const c = style === 'compact';
  if (mode === 'direct') {
    const order = ctx.allyIsHuman ? (c ? ' Obey order.' : ' Your teammate is a human player: follow their teammate_order unless it is clearly suicidal.') : '';
    return c
      ? `You are tank ${a.tank.id} (${a.team}) in a 2v2 tank battle. Destroy the enemy base or all enemy tanks; protect our base.${order} Pick your next action.`
      : `You drive tank ${a.tank.id} on the ${a.team} team in a 2v2 grid tank battle (Battle City style). A team wins by destroying the enemy base or every enemy tank. Bullets break brick walls; steel stops bullets; tanks cannot cross water. Friendly bullets do not hurt teammates but DO damage your own base.${order} Pick your next single action (one tile move, or turn and fire).`;
  }
  if (c) {
    const order = ctx.allyIsHuman ? ' Obey order.' : '';
    return `Tank ${a.tank.id} (${a.team}), 2v2 tank battle; autopilot aims, fires, dodges. Destroy the enemy base. Split work with teammate; if covered, don't defend.${order} Pick a plan.`;
  }
  const humanNote = ctx.allyIsHuman
    ? ' Your teammate is a human player: follow their teammate_order unless it is clearly suicidal.'
    : '';
  return `You command tank ${a.tank.id} on the ${a.team} team in a 2v2 grid tank battle. You choose the plan; the tank's autopilot handles movement, aiming, firing, dodging and breaking walls by itself. A team wins by destroying the enemy base (${game.rules.baseHp} hp behind brick walls) or every enemy tank; each tank has limited lives and respawns at home. Read the whole battlefield: where every tank is, where it is heading and what it seems to be doing. Coordinate with your teammate instead of duplicating them: our base needs at most one defender, so if teammate_covering_base is true do not pick defend_our_base.${humanNote} Pick your plan for the next few seconds.`;
}

// ---------- 统一的决策请求：{ state, questions }，格式与 Jev / Laya 的 systemone 接口一致 ----------
// ctx.style: 'full'（默认）| 'compact'
export function buildDecision(game, tank, mode = 'tactical', ctx = {}) {
  const style = ctx.style === 'compact' ? 'compact' : 'full';
  const a = analyze(game, tank, ctx);
  const options = mode === 'direct' ? directOptions(game, a, style) : tacticalOptions(game, a, style);
  const questions = {
    tactic: { type: 'choice', instructions: instructionsFor(game, a, ctx, mode, style), criteria: options },
  };
  if (ctx.allyIsHuman && ctx.callouts) {
    questions.callout = style === 'compact'
      ? { type: 'choice', instructions: 'What to radio to your human teammate? Usually none.', criteria: CALLOUTS_COMPACT }
      : { type: 'choice', instructions: 'What should you radio to your human teammate right now? Prefer none unless something changed.', criteria: CALLOUTS };
  }
  const state = style === 'compact' ? stateCompact(game, a, ctx) : stateFull(game, a, ctx);
  return { state, questions, options, analysis: a, style };
}
