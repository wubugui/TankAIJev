import { DIRS, DIR_LIST, T, otherTeam, dirOrder } from './constants.js';
import { dijkstra, distTo, scanLine, safeToFire, alignedDir, firingSpots } from './nav.js';

// 给决策模型看的文字全部用英文：Jev 和 Laya（英文版）对英文最准。
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

// 提示词版本（按功能开关组合）：
//   v1 初版
//   v2 角色分工 + 优先级 + 队友计划 + 基地态势（实测把 Jev 带成了规则 AI 的打法，反而更差）
//   v3 只补 v1 的短板：基地告急时至少一辆车处理，并标出靠近我方基地的敌车；不改变它爱追杀的打法
export const PROMPT_VERSIONS = ['v1', 'v2', 'v3'];
export const DEFAULT_PROMPT_VERSION = 'v3';
const FEATURES = {
  v1: {},
  v2: { roles: true, plan: true, baseStatus: true, priorities: true, urgent: true },
  v3: { plan: true, baseStatus: true, coverGate: true, huntNearBase: true },
};
// 开关含义：
//   roles        状态里给出角色（striker / guard / solo）
//   plan         状态里给出队友当前在执行的战术
//   baseStatus   双方基地态势（近 5 秒掉血、剩余城墙、是否告急）
//   priorities   说明里写死优先级（v2 的做法，实测让 Jev 扎堆守家）
//   urgent       守家选项用 "URGENT / DEFEND NOW" 措辞（同样会引起扎堆守家）
//   coverGate    状态里给出 teammate_covering_base 布尔值，说明里只写一条协作规则：队友已在照看基地就别再守
//   huntNearBase 追击选项里标出该敌车离我方基地多远
const featuresOf = (ctx) => FEATURES[ctx.promptVersion] || FEATURES[DEFAULT_PROMPT_VERSION];

const round1 = (v) => (v === Infinity ? null : Math.round(v * 10) / 10);
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// 离我最近、正朝我飞来且中间没有遮挡的敌方子弹
function incomingBullet(game, tank) {
  let best = null;
  for (const b of game.bullets) {
    if (b.team === tank.team) continue;
    const d = DIRS[b.dir];
    const along = (tank.fx - b.x) * d.dx + (tank.fy - b.y) * d.dy; // 子弹前方的距离
    const across = Math.abs((tank.fx - b.x) * d.dy) + Math.abs((tank.fy - b.y) * d.dx);
    if (along <= 0 || along > 7 || across > 0.6) continue;
    // 路径上有砖/钢就挡住了
    let blocked = false;
    for (let s = 1; s < along; s++) {
      const tx = Math.round(b.x + d.dx * s);
      const ty = Math.round(b.y + d.dy * s);
      const tile = game.tileAt(tx, ty);
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

// 计算一辆坦克做决策需要的全部事实
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
  const attackSpots = firingSpots(game, enemyBase.x, enemyBase.y, 5, true, team);
  const guardSpots = guardPosts(game, team);

  const pathDist = (x, y) => distTo(nav, x, y);
  const minSpot = (spots) => spots.reduce((m, s) => Math.min(m, pathDist(s.x, s.y)), Infinity);

  const enemyInfo = enemies.map((e) => ({
    tank: e,
    id: e.id,
    alive: e.alive,
    path: e.alive ? pathDist(e.x, e.y) : Infinity,
    distToOurBase: e.alive ? manhattan(e, ownBase) : Infinity,
  }));
  const aliveEnemies = enemyInfo.filter((e) => e.alive);
  const nearestEnemy = aliveEnemies.reduce((m, e) => (!m || e.path < m.path ? e : m), null);
  const baseThreat = aliveEnemies.reduce((m, e) => (!m || e.distToOurBase < m.distToOurBase ? e : m), null);

  // 当前能直接打中的目标（中间无砖）
  let shot = null;
  for (const dir of dirOrder(team)) {
    const s = lines[dir];
    if (!safeToFire(s)) continue;
    const f = s.first;
    if (f.kind === 'enemy' && f.dist <= 10 && (!shot || shot.kind !== 'enemy' || f.dist < shot.dist)) shot = { dir, kind: 'enemy', id: f.id, dist: f.dist };
    if (f.kind === 'enemy_base' && f.dist <= 8 && !shot) shot = { dir, kind: 'enemy_base', dist: f.dist };
  }

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
    role: roleOf(game, tank),
    enemies: enemyInfo, nearestEnemy, baseThreat, shot,
    incoming: incomingBullet(game, tank),
    attackDist: minSpot(attackSpots),
    guardDist: minSpot(guardSpots),
    allyDist: ally && ally.alive ? pathDist(ally.x, ally.y) : Infinity,
    gunReady: game.canFire(tank),
    order,
    timeLeft: Math.max(0, game.rules.matchSeconds - game.time),
  };
}

// 基地态势：近 5 秒掉了几血、周围还剩几块砖墙
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

// 分工：1 号车主攻、2 号车看家；队友没命了就一个人全包
export const ROLE_TEXT = {
  striker: 'striker: pressure the enemy base; go back only if our base is in danger and your teammate cannot cover it',
  guard: 'guard: protect our base and kill tanks that come near it; push the enemy base when nothing threatens ours',
  solo: 'solo (teammate is out of lives): defend when our base is threatened, otherwise attack',
};

export function roleOf(game, tank) {
  const ally = game.tanks.find((t) => t.team === tank.team && t !== tank);
  if (!ally || (!ally.alive && ally.lives <= 0)) return 'solo';
  return tank.index === 0 ? 'striker' : 'guard';
}

const PLAN_TEXT = {
  attack_enemy_base: 'attacking the enemy base',
  defend_our_base: 'defending our base',
  shoot_now: 'shooting at a target',
  dodge: 'dodging a bullet',
  retreat: 'retreating',
  follow_teammate: 'following you',
  hold_position: 'holding position',
  wait: 'waiting',
};

function planText(plan) {
  if (!plan) return 'unknown';
  if (plan.startsWith('hunt_')) return `hunting enemy ${plan.slice(5)}`;
  if (plan.startsWith('move_')) return `moving ${plan.slice(5)}`;
  if (plan.startsWith('fire_')) return `firing ${plan.slice(5)}`;
  return PLAN_TEXT[plan] || plan;
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

function stateFor(game, a, ctx) {
  const f = featuresOf(ctx);
  const state = stateV1(game, a, ctx);
  if (f === FEATURES.v1) return state;
  if (f.roles) state.you.role = a.role;
  if (f.plan && state.teammate) state.teammate.current_plan = ctx.allyIsHuman ? 'human decides' : a.ally.alive ? planText(ctx.allyPlan) : 'dead';
  if (f.baseStatus) addBaseStatus(state, a);
  if (f.coverGate) state.teammate_covering_base = a.allyCovering;
  if (ctx.style === 'compact') {
    // Laya 英文版 state 只能读约 316 token（实测：JSON 大约 2.2 个字符一个 token），超出会被截断。
    // 去掉次要字段，留出余量；保留的字段以 v3 说明里点名的为准（teammate_covering_base / in_danger 等）
    delete state.you.tile;
    delete state.you.facing;
    delete state.your_recent_choices;
    delete state.kills;
    delete state.time_left_s;
    for (const e of state.enemies) delete e.lives_left;
    if (state.teammate) delete state.teammate.driver;
    if (state.our_base) { delete state.our_base.walls_left; delete state.our_base.nearest_enemy_distance; }
    if (state.enemy_base) { delete state.enemy_base.walls_left; delete state.enemy_base.lost_hp_last_5s; }
  }
  return state;
}

// 双方基地态势：近 5 秒掉血、剩余城墙、是否告急
function addBaseStatus(state, a) {
  const nearest = a.baseThreat ? a.baseThreat.distToOurBase : null;
  state.our_base = {
    hp: state.our_base.hp,
    lost_hp_last_5s: a.ownStatus.lost5,
    walls_left: `${a.ownStatus.walls}/${a.ownStatus.spots}`,
    nearest_enemy_distance: nearest,
    in_danger: a.baseDanger,
    your_distance: state.our_base.your_distance,
  };
  state.enemy_base = {
    hp: state.enemy_base.hp,
    lost_hp_last_5s: a.enemyStatus.lost5,
    walls_left: `${a.enemyStatus.walls}/${a.enemyStatus.spots}`,
    your_distance: state.enemy_base.your_distance,
  };
}

function stateV1(game, a, ctx) {
  const t = a.tank;
  const hist = ctx.history || [];
  return {
    you: {
      id: t.id,
      team: t.team,
      hp: `${t.hp}/${game.rules.tankHp}`,
      lives_left: t.lives,
      tile: [t.x, t.y],
      facing: t.dir,
      gun_ready: a.gunReady,
    },
    teammate: a.ally
      ? {
          id: a.ally.id,
          driver: ctx.allyIsHuman ? 'human player' : 'AI',
          alive: a.ally.alive,
          hp: a.ally.alive ? `${a.ally.hp}/${game.rules.tankHp}` : '0',
          distance: round1(a.allyDist),
        }
      : null,
    teammate_order: a.order ? `${ORDER_TEXT[a.order.order]} (given ${Math.round(game.time - a.order.time)}s ago)` : 'none',
    enemies: a.enemies.map((e) => ({
      id: e.id,
      alive: e.alive,
      hp: e.alive ? `${e.tank.hp}/${game.rules.tankHp}` : '0',
      lives_left: e.tank.lives,
      distance: round1(e.path),
      distance_to_our_base: e.alive ? e.distToOurBase : null,
    })),
    our_base: { hp: `${a.ownBase.hp}/${game.rules.baseHp}`, your_distance: round1(a.guardDist) },
    enemy_base: { hp: `${a.enemyBase.hp}/${game.rules.baseHp}`, your_distance: round1(a.attackDist) },
    incoming_bullet: a.incoming ? `from ${a.incoming.from}, ${a.incoming.dist} tiles away` : 'none',
    your_recent_choices: hist.slice(-3),
    time_left_s: Math.round(a.timeLeft),
    kills: { ours: game.teamKills(a.team), theirs: game.teamKills(a.foe) },
  };
}

// style: 'full' 给 Jev 这类上下文大的模型；'compact' 给 Laya（每道题的题目+选项只能占约 192 token）
function tacticalOptions(game, a, style, f) {
  const o = {};
  const c = style === 'compact';
  const fmt = (v) => (v === Infinity ? 'unreachable' : `${round1(v)} tiles${c ? '' : ' away'}`);
  const threat = a.baseThreat && a.baseThreat.distToOurBase <= 5 ? a.baseThreat : null;
  // 基地告急的原因（事实陈述，不带催促语气）
  const why = a.ownStatus.lost5 > 0
    ? (c ? `lost ${a.ownStatus.lost5} hp recently` : `it lost ${a.ownStatus.lost5} hp in the last 5s`)
    : a.baseThreat ? (c ? `enemy ${a.baseThreat.id} is ${a.baseThreat.distToOurBase} from it` : `enemy ${a.baseThreat.id} is ${a.baseThreat.distToOurBase} tiles from it`) : '';
  const covered = f.coverGate && a.allyCovering ? (c ? ', teammate already covers it' : '; your teammate is already covering it') : '';
  if (c) {
    o.attack_enemy_base = `attack enemy base (${fmt(a.attackDist)})`;
    if (f.baseStatus && a.baseDanger) o.defend_our_base = f.urgent ? 'DEFEND NOW: our base is under attack' : `defend our base (${why}${covered})`;
    else if (f.baseStatus) o.defend_our_base = `guard our base (${fmt(a.guardDist)}, no threat now)`;
    else o.defend_our_base = threat ? `defend base, enemy ${threat.id} is ${threat.distToOurBase} from it` : `guard our base (${fmt(a.guardDist)})`;
    for (const e of a.enemies) {
      if (!e.alive) continue;
      const near = f.huntNearBase && e.distToOurBase <= 5 ? ', near OUR base' : '';
      o[`hunt_${e.id}`] = `chase enemy ${e.id} (hp ${e.tank.hp}, ${fmt(e.path)}${near})`;
    }
    if (a.shot) o.shoot_now = `fire ${a.shot.dir} now at ${a.shot.kind === 'enemy' ? `enemy ${a.shot.id}` : 'enemy base'}`;
    if (a.incoming) o.dodge = 'sidestep the incoming bullet';
    if (a.nearestEnemy && a.nearestEnemy.path <= 6) o.retreat = 'retreat toward our base';
    if (a.ally && a.ally.alive) o.follow_teammate = `stay with teammate ${a.ally.id}`;
    o.hold_position = 'hold position';
    return o;
  }
  // “walls left” 只在 v2 里出现：实测这句话让 Jev 觉得进攻没戏（v3 里进攻比例掉到 0%）
  o.attack_enemy_base = `Advance on the enemy base and shoot it (${fmt(a.attackDist)}, base hp ${a.enemyBase.hp}/${game.rules.baseHp}${f.priorities ? `, walls left ${a.enemyStatus.walls}` : ''}).`;
  if (f.baseStatus && a.baseDanger) {
    o.defend_our_base = f.urgent
      ? `URGENT: rush back and defend our base (${why}; you are ${fmt(a.guardDist)}).`
      : `Go back and defend our base (${why}; you are ${fmt(a.guardDist)}${covered}).`;
  } else if (f.baseStatus) {
    o.defend_our_base = `Go back and guard our base (${fmt(a.guardDist)}; nothing threatens it right now).`;
  } else {
    o.defend_our_base = threat
      ? `Rush back to defend our base: enemy ${threat.id} is ${threat.distToOurBase} tiles from it (you are ${fmt(a.guardDist)}).`
      : `Go back and guard our base (${fmt(a.guardDist)}; no enemy is near it).`;
  }
  for (const e of a.enemies) {
    if (!e.alive) continue;
    const near = f.huntNearBase && e.distToOurBase <= 5 ? `; it is ${e.distToOurBase} tiles from OUR base` : '';
    o[`hunt_${e.id}`] = `Chase and shoot enemy tank ${e.id} (hp ${e.tank.hp}/${game.rules.tankHp}, ${fmt(e.path)}${near}).`;
  }
  if (a.shot) {
    const what = a.shot.kind === 'enemy' ? `enemy tank ${a.shot.id}` : 'the enemy base';
    o.shoot_now = `Turn ${a.shot.dir} and fire now: ${what} is ${a.shot.dist} tiles away in a clear line${a.gunReady ? '' : ' (gun reloading)'}.`;
  }
  if (a.incoming) {
    o.dodge = `Sidestep: an enemy bullet is coming from the ${a.incoming.from}, ${a.incoming.dist} tiles away.`;
  }
  if (a.nearestEnemy && a.nearestEnemy.path <= 6) {
    o.retreat = `Fall back toward our base, away from enemy ${a.nearestEnemy.id} (your hp ${a.tank.hp}/${game.rules.tankHp}).`;
  }
  if (a.ally && a.ally.alive) {
    o.follow_teammate = `Move next to teammate ${a.ally.id} (${fmt(a.allyDist)}) and support them.`;
  }
  o.hold_position = 'Stay here and shoot anything that lines up.';
  return o;
}

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
  const spots = firingSpots(game, a.enemyBase.x, a.enemyBase.y, 5, true, a.team);
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
    }
    else if (f.kind === 'ally') what = c ? 'blocked by teammate' : `WARNING: blocked by teammate ${f.id}`;
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

export function instructionsFor(game, a, ctx, mode, style = 'full') {
  const f = featuresOf(ctx);
  if (f.priorities) return instructionsV2(a, ctx, mode, style);
  if (style === 'compact') {
    const order = ctx.allyIsHuman ? ' Obey teammate_order.' : '';
    const what = mode === 'direct' ? 'Pick your next action.' : 'Pick the best tactic now.';
    const gate = f.coverGate ? ' If teammate_covering_base is true, do not defend; attack.' : '';
    return `You are tank ${a.tank.id} (${a.team}) in a 2v2 tank battle. Destroy the enemy base or all enemy tanks; protect our base.${gate}${order} ${what}`;
  }
  const humanNote = ctx.allyIsHuman
    ? ' Your teammate is a human player: follow their teammate_order unless it is clearly suicidal.'
    : '';
  const what = mode === 'direct'
    ? 'Pick your next single action (one tile move, or turn and fire).'
    : 'Pick the tactic you will carry out for the next moment.';
  // 唯一的协作规则：基地只需要一个守卫。用布尔值而不是让模型自己从队友计划里推断——实测它推断不出来
  const gate = f.coverGate
    ? ' Coordination rule: our base needs exactly one defender. If teammate_covering_base is true, do not pick defend_our_base; attack or hunt instead. If it is false and our_base.in_danger is true, defend our base, or hunt the enemy that is near it.'
    : '';
  return `You drive tank ${a.tank.id} on the ${a.team} team in a 2v2 grid tank battle (Battle City style). A team wins by destroying the enemy base or every enemy tank. Bullets break brick walls; steel stops bullets; tanks cannot cross water. Friendly bullets do not hurt teammates but DO damage your own base.${gate}${humanNote} ${what}`;
}

// v2：写明角色和优先级，并提示看队友的 current_plan 来分工
function instructionsV2(a, ctx, mode, style) {
  const what = mode === 'direct'
    ? (style === 'compact' ? 'Pick your next action.' : 'Pick your next single action (one tile move, or turn and fire).')
    : (style === 'compact' ? 'Pick the best tactic now.' : 'Pick the tactic you will carry out for the next moment.');
  if (style === 'compact') {
    const order = ctx.allyIsHuman ? ' Obey teammate_order.' : '';
    return `You are tank ${a.tank.id} (${a.team}), role ${a.role}. Win by destroying the enemy base. If our base is in danger, defend; else do your role and attack.${order} ${what}`;
  }
  const humanNote = ctx.allyIsHuman
    ? ' Your teammate is a human player: follow their teammate_order unless it is clearly suicidal.'
    : ' Look at teammate.current_plan and do not duplicate it: if they are already defending a safe base, you attack, and vice versa.';
  return `You drive tank ${a.tank.id} on the ${a.team} team in a 2v2 grid tank battle (Battle City style). A team wins by destroying the enemy base or every enemy tank; a team that only defends cannot win. Bullets break brick walls; steel stops bullets; tanks cannot cross water. Friendly bullets do not hurt teammates but DO damage your own base. Your role: ${ROLE_TEXT[a.role]}. Priorities: 1) if our_base.in_danger is true, defending is urgent; 2) otherwise follow your role and keep pressure on the enemy base; 3) chase an enemy tank only when it is close or weak; 4) dodge a bullet that is about to hit you.${humanNote} ${what}`;
}

export const CALLOUTS_COMPACT = {
  none: 'say nothing',
  roger: 'acknowledge the order',
  need_help: 'ask for help',
  enemy_near_base: 'warn: enemy near our base',
  attacking: 'say you are attacking',
  defending: 'say you are defending',
};

// 统一的决策请求：{ state, questions }，格式与 Jev / Laya 的 systemone 接口一致
// ctx.style: 'full'（默认）| 'compact'
export function buildDecision(game, tank, mode = 'tactical', ctx = {}) {
  const style = ctx.style === 'compact' ? 'compact' : 'full';
  const a = analyze(game, tank, ctx);
  const options = mode === 'direct' ? directOptions(game, a, style) : tacticalOptions(game, a, style, featuresOf(ctx));
  const questions = {
    tactic: { type: 'choice', instructions: instructionsFor(game, a, ctx, mode, style), criteria: options },
  };
  if (ctx.allyIsHuman && ctx.callouts) {
    questions.callout = style === 'compact'
      ? { type: 'choice', instructions: 'What to radio to your human teammate? Usually none.', criteria: CALLOUTS_COMPACT }
      : { type: 'choice', instructions: 'What should you radio to your human teammate right now? Prefer none unless something changed.', criteria: CALLOUTS };
  }
  return { state: stateFor(game, a, ctx), questions, options, analysis: a, style };
}
