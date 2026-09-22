import { DIRS, T, otherTeam, dirOrder } from './constants.js';
import { dijkstra, routeTo, pathTo, stepCost, dirBetween, alignedDir, scanLine, safeToFire, firingSpots } from './nav.js';

// 换路的门槛：新路线要比“继续走原路线”至少便宜这么多步才换。
// 没有它，坦克的路径代价会随别的坦克挪动而来回变（有车占着的格子更贵），
// 两条差不多的路线就会每走一格翻一次，坦克在两格之间来回抖、永远到不了。
const REPLAN_MARGIN = 2;
import { guardPosts, incomingBullet, attackSideSpots } from './observe.js';

// 执行层：把决策模型选出的“计划”或“单步动作”翻译成每帧的 {move, face, fire}。
// 所有 AI（规则 / 随机 / Jev / Laya）共用同一个执行层，只有“选什么”不同，便于公平对比。
//
// 分两层：
//   反射层：每到一个格子中心先看——子弹 3 格内朝自己飞来就闪（闪不开就迎着开火抵消），
//           有敌车在射线上就转过去打。这些对延迟敏感，不等模型。
//   计划层：执行模型选的计划（从哪侧进攻、守家、追谁、支援、撤退、坚守），负责寻路和破墙。
export class Executor {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.stuckFor = 0;
    this.lastTile = null;
    this.path = null; // 正在走的路线 { tiles, goal }，只在明显更好或走不通时才换
    this.visits = []; // 最近到达的格子，用来发现两格之间来回抖
    this.direct = null; // 直接控制模式下正在执行的单步动作
  }

  setDirect(action) {
    this.direct = { action, started: false, done: false };
  }

  get directDone() {
    return !this.direct || this.direct.done;
  }

  run(game, tank, tactic, dt) {
    if (!tank.alive) return {};
    if (tactic && isDirect(tactic)) return this.runDirect(game, tank);
    if (tank.moving) return { fire: this.opportunisticFire(game, tank) };

    const key = `${tank.x},${tank.y}`;
    if (key !== this.lastTile) {
      this.visits.push(key);
      if (this.visits.length > 8) this.visits.shift();
    }
    this.stuckFor = key === this.lastTile ? this.stuckFor + dt : 0;
    this.lastTile = key;

    const reflex = this.reflex(game, tank);
    if (reflex) return reflex;

    let input = this.runTactic(game, tank, tactic || 'hold_position');
    // 想走却一直原地不动（被队友/敌人堵住）→ 随机挪一步
    if (input.move || input.wantMove) {
      // 堵住不动，或者最近 8 次到达只在两个格子之间来回 → 随机挪一步、丢掉原路线
      const dithering = this.visits.length >= 8 && new Set(this.visits).size <= 2;
      if (this.stuckFor > 1.2 || dithering) {
        this.path = null;
        this.visits = [];
        const free = dirOrder(tank.team).filter((d) => game.isPassable(tank.x + DIRS[d].dx, tank.y + DIRS[d].dy, tank));
        if (free.length) input = { move: free[Math.floor(this.rng() * free.length)] };
        this.stuckFor = 0;
      }
    }
    delete input.wantMove;
    if (!input.fire) input.fire = this.opportunisticFire(game, tank, input.face || input.move);
    return input;
  }

  // 反射：闪避和开火，不管当前计划是什么
  reflex(game, tank) {
    const inc = incomingBullet(game, tank, 3);
    if (inc) {
      const vertical = inc.travelDir === 'up' || inc.travelDir === 'down';
      const sides = dirOrder(tank.team).filter((d) => (vertical ? d === 'left' || d === 'right' : d === 'up' || d === 'down'))
        .filter((d) => game.isPassable(tank.x + DIRS[d].dx, tank.y + DIRS[d].dy, tank));
      if (sides.length) return { move: sides[Math.floor(this.rng() * sides.length)] };
      if (game.canFire(tank)) return { face: inc.from, fire: true }; // 躲不开就迎着子弹开火，子弹相撞会抵消
    }
    if (game.canFire(tank)) {
      for (const dir of dirOrder(tank.team)) {
        const s = scanLine(game, tank.x, tank.y, dir, tank);
        if (s.first.kind === 'enemy' && s.first.dist <= 8 && safeToFire(s)) return { face: dir, fire: true };
      }
    }
    return null;
  }

  // 朝向上有敌方坦克/基地且不会误伤 → 顺手开火（移动途中也会）
  opportunisticFire(game, tank, dir = tank.dir) {
    if (!game.canFire(tank)) return false;
    const s = scanLine(game, tank.x, tank.y, dir || tank.dir, tank);
    if (!safeToFire(s)) return false;
    return (s.first.kind === 'enemy' && s.first.dist <= 10) || (s.first.kind === 'enemy_base' && s.first.dist <= 8);
  }

  runDirect(game, tank) {
    const job = this.direct;
    if (!job || job.done) return {};
    if (tank.moving) return {};
    const [verb, dir] = job.action.split('_');
    if (verb === 'wait') { job.done = true; return {}; }
    if (verb === 'fire') {
      // 直接控制模式不做安全拦截：模型选了就执行，误伤也算它的
      job.done = true;
      return { face: dir, fire: true };
    }
    if (verb === 'move') {
      if (job.started) { job.done = true; return {}; }
      job.started = true;
      return { move: dir };
    }
    job.done = true;
    return {};
  }

  // 走向目标集合中最近的一个；下一步是砖就先打掉
  goTo(game, tank, goals) {
    const nav = dijkstra(game, tank.x, tank.y, tank);
    const r = routeTo(nav, goals);
    if (!r) { this.path = null; return null; }
    if (!r.step) { this.path = null; return { arrived: true }; }
    const step = this.followPath(game, tank, goals, r.cost) || this.newPath(nav, r);
    const dir = dirBetween(tank.x, tank.y, step.x, step.y);
    const tile = game.tileAt(step.x, step.y);
    if (tile === T.BRICK) {
      const s = scanLine(game, tank.x, tank.y, dir, tank);
      return { face: dir, fire: safeToFire(s) };
    }
    if (game.tankAt(step.x, step.y, tank)) return { face: dir, wantMove: true };
    return { move: dir };
  }

  // 继续走原路线的下一步；原路线失效（离开了路线、终点不再是目标、有格子走不通、
  // 或者比当前最优路线贵出 REPLAN_MARGIN 以上）就返回 null
  followPath(game, tank, goals, bestCost) {
    const p = this.path;
    if (!p) return null;
    if (!goals.some((g) => g.x === p.goal.x && g.y === p.goal.y)) return null;
    let i = p.tiles.findIndex((t) => t.x === tank.x && t.y === tank.y);
    if (i < 0) {
      // 刚出发：还站在路线起点上
      if (p.from.x !== tank.x || p.from.y !== tank.y) return null;
      i = -1;
    }
    const rest = p.tiles.slice(i + 1);
    if (!rest.length) return null;
    let cost = 0;
    for (const t of rest) {
      const c = stepCost(game, t.x, t.y, tank);
      if (c === Infinity) return null;
      cost += c;
    }
    if (cost > bestCost + REPLAN_MARGIN) return null;
    return rest[0];
  }

  newPath(nav, r) {
    const tiles = pathTo(nav, r.goal);
    const start = { x: nav.start % nav.w, y: (nav.start / nav.w) | 0 };
    this.path = tiles ? { tiles, goal: r.goal, from: start } : null;
    return r.step;
  }

  // 与目标同行/同列且中间无遮挡 → 转过去开火
  aimAt(game, tank, enemy) {
    const dir = alignedDir(tank.x, tank.y, enemy.x, enemy.y);
    if (!dir) return null;
    const s = scanLine(game, tank.x, tank.y, dir, tank);
    if (s.first.kind !== 'enemy' || s.first.id !== enemy.id) return null;
    if (!safeToFire(s)) return null; // 敌人身后紧挨着自家基地时不开火：打偏就是打自己
    return { face: dir, fire: true };
  }

  runTactic(game, tank, tactic) {
    const foe = otherTeam(tank.team);
    if (tactic.startsWith('hunt_')) return this.hunt(game, tank, tactic.slice(5));
    switch (tactic) {
      case 'attack_left': return this.attackBase(game, tank, 'left');
      case 'attack_front': return this.attackBase(game, tank, 'front');
      case 'attack_right': return this.attackBase(game, tank, 'right');
      case 'attack_enemy_base': return this.attackBase(game, tank, null);
      case 'defend_our_base': return this.defend(game, tank);
      case 'retreat': {
        const r = this.goTo(game, tank, guardPosts(game, tank.team));
        if (!r || r.arrived) return this.hold(game, tank);
        return r;
      }
      case 'follow_teammate': {
        const ally = game.tanks.find((t) => t.team === tank.team && t !== tank && t.alive);
        if (!ally) return this.hold(game, tank);
        if (Math.abs(ally.x - tank.x) + Math.abs(ally.y - tank.y) <= 2) return this.hold(game, tank);
        const goals = [];
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = ally.x + dx;
            const y = ally.y + dy;
            if (Math.abs(dx) + Math.abs(dy) <= 2 && (dx || dy) && game.tileAt(x, y) === T.EMPTY) goals.push({ x, y });
          }
        }
        const r = this.goTo(game, tank, goals);
        if (!r || r.arrived) return this.hold(game, tank);
        return r;
      }
      case 'hold_position':
      default:
        return this.hold(game, tank);
    }
  }

  // 进攻基地：去指定一侧的射击位（这一侧到不了就去任意一侧）；已经对准基地就开火
  attackBase(game, tank, side) {
    const base = game.bases[otherTeam(tank.team)];
    const dir = alignedDir(tank.x, tank.y, base.x, base.y);
    if (dir) {
      const s = scanLine(game, tank.x, tank.y, dir, tank);
      if (s.target.kind === 'enemy_base' && s.target.dist <= 5 && safeToFire(s)) return { face: dir, fire: true };
    }
    const spots = side ? attackSideSpots(game, tank.team, side) : [];
    return this.goTo(game, tank, spots.length ? spots : attackSideSpots(game, tank.team, null))
      || this.goTo(game, tank, attackSideSpots(game, tank.team, null))
      || this.hold(game, tank);
  }

  // 守家：敌人逼近基地（5 格内）就去追杀它——hunt 会从任意方向找射击位，通常是侧翼，
  // 敌人的炮口对着基地打不到侧面；没有威胁时在基地旁的岗位待命。
  // 曾试过两种“更聪明”的做法，模拟结果都更差：
  //   站在基地射击通道上正面迎击 → 替基地挨子弹，一攻一守对规则 AI 从 68% 掉到 45%；
  //   没威胁时也站在通道上待命   → 掉到 40%。
  defend(game, tank) {
    const foe = otherTeam(tank.team);
    const base = game.bases[tank.team];
    const threat = game.tanks
      .filter((t) => t.team === foe && t.alive)
      .map((t) => ({ t, d: Math.abs(t.x - base.x) + Math.abs(t.y - base.y) }))
      .sort((p, q) => p.d - q.d)[0];
    if (threat && threat.d <= 5) return this.hunt(game, tank, threat.t.id);
    const r = this.goTo(game, tank, guardPosts(game, tank.team));
    if (!r || r.arrived) return this.hold(game, tank);
    return r;
  }

  hunt(game, tank, id) {
    const enemy = game.getTank(id);
    if (!enemy || !enemy.alive || enemy.team === tank.team) return this.hold(game, tank);
    const shot = this.aimAt(game, tank, enemy);
    if (shot) return shot;
    let goals = firingSpots(game, enemy.x, enemy.y, 7, false, tank.team);
    if (!goals.length) goals = [{ x: enemy.x, y: enemy.y }];
    const r = this.goTo(game, tank, goals);
    if (!r || r.arrived) return this.hold(game, tank);
    return r;
  }

  // 原地：有能打的就转过去打，否则面向最近的敌人
  hold(game, tank) {
    let best = null;
    for (const dir of dirOrder(tank.team)) {
      const s = scanLine(game, tank.x, tank.y, dir, tank);
      if (!safeToFire(s)) continue;
      if (s.first.kind === 'enemy' && s.first.dist <= 10 && (!best || s.first.dist < best.dist)) best = { dir, dist: s.first.dist };
    }
    if (best) return { face: best.dir, fire: true };
    const foe = otherTeam(tank.team);
    const enemies = game.tanks.filter((t) => t.team === foe && t.alive);
    if (!enemies.length) return {};
    const e = enemies.reduce((m, t) => (Math.abs(t.x - tank.x) + Math.abs(t.y - tank.y) < Math.abs(m.x - tank.x) + Math.abs(m.y - tank.y) ? t : m));
    const dx = e.x - tank.x;
    const dy = e.y - tank.y;
    const face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    return { face };
  }
}

export function isDirect(action) {
  return action === 'wait' || action.startsWith('move_') || action.startsWith('fire_');
}
