import { DIRS, T, DEFAULT_RULES, otherTeam, snap, tileAlong, makeRng } from './constants.js';
import { parseMap } from './map.js';

export const DEFAULT_SLOTS = [
  { id: 'B1', team: 'blue' },
  { id: 'B2', team: 'blue' },
  { id: 'R1', team: 'red' },
  { id: 'R2', team: 'red' },
];

// 纯游戏逻辑：确定性、无随机、无 DOM。坐标单位是“格”，坦克中心在整数格上。
export class Game {
  constructor(options = {}) {
    this.rules = { ...DEFAULT_RULES, ...(options.rules || {}) };
    const map = parseMap(options.map);
    this.w = map.w;
    this.h = map.h;
    this.tiles = map.tiles;
    this.spawns = map.spawns;
    this.bases = {
      blue: { team: 'blue', ...map.bases.blue, hp: this.rules.baseHp, lastHitBy: null, hitTimes: [] },
      red: { team: 'red', ...map.bases.red, hp: this.rules.baseHp, lastHitBy: null, hitTimes: [] },
    };
    this.tanks = [];
    const counters = { blue: 0, red: 0 };
    for (const slot of options.slots || DEFAULT_SLOTS) {
      const index = counters[slot.team]++;
      const list = this.spawns[slot.team];
      const spawn = list[index % list.length];
      const tank = {
        id: slot.id,
        team: slot.team,
        index,
        spawn,
        x: spawn.x, y: spawn.y, // 逻辑所在格（移动中为出发格）
        fx: spawn.x, fy: spawn.y, // 连续坐标
        dir: slot.team === 'blue' ? 'up' : 'down',
        moving: null,
        hp: this.rules.tankHp,
        lives: this.rules.lives,
        alive: true,
        respawnAt: 0,
        shieldUntil: this.rules.spawnShield,
        cooldown: 0,
        kills: 0, deaths: 0, shots: 0, hits: 0, baseDamage: 0,
        trail: [], // 最近 2 秒的位置（每 0.25 秒一个点），用来判断移动方向和意图
      };
      this.tanks.push(tank);
    }
    this.inputs = new Map();
    this.bullets = [];
    this.time = 0;
    this.over = false;
    this.winner = null; // 'blue' | 'red' | 'draw'
    this.reason = null; // 'base' | 'eliminated' | 'timeout'
    this.events = [];
    this.nextId = 1;
    this.frame = 0;
    // 每帧随机决定坦克的更新顺序（按种子，可复现）。两辆车同一帧想开进同一格时，先更新的先占到。
    // 以前是“偶数帧蓝先、奇数帧红先”轮流，但双方走对称路线时总在同一帧相遇，结果永远是同一方占到——规则 AI 对打红方赢了 2/3。
    this.orderRng = makeRng((options.seed ?? 1) * 7919 + 1);
    this.updateOrder = [...this.tanks];
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  tileAt(x, y) { return this.inBounds(x, y) ? this.tiles[y * this.w + x] : T.STEEL; }
  setTile(x, y, tile) { this.tiles[y * this.w + x] = tile; }
  getTank(id) { return this.tanks.find((t) => t.id === id); }
  baseAt(x, y) {
    for (const team of ['blue', 'red']) {
      const b = this.bases[team];
      if (b.x === x && b.y === y) return b;
    }
    return null;
  }

  // 占据某格的活着的坦克（出发格和目标格都算占据）
  tankAt(x, y, except = null) {
    for (const t of this.tanks) {
      if (!t.alive || t === except) continue;
      if (t.x === x && t.y === y) return t;
      if (t.moving && t.moving.x === x && t.moving.y === y) return t;
    }
    return null;
  }

  isPassable(x, y, except = null) {
    return this.tileAt(x, y) === T.EMPTY && !this.tankAt(x, y, except);
  }

  setInput(id, input) { this.inputs.set(id, input || {}); }

  step(dt) {
    if (this.over) return;
    this.time += dt;
    this.frame++;
    const order = this.updateOrder;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.orderRng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const t of order) this.updateTank(t, dt);
    this.updateBullets(dt);
    this.recordTrails();
    this.checkEnd();
  }

  updateTank(t, dt) {
    if (!t.alive) {
      if (t.lives > 0 && this.time >= t.respawnAt) this.tryRespawn(t);
      return;
    }
    t.cooldown = Math.max(0, t.cooldown - dt);
    const input = this.inputs.get(t.id) || {};
    if (!t.moving) {
      if (input.move && DIRS[input.move]) {
        t.dir = input.move;
        const d = DIRS[input.move];
        const nx = t.x + d.dx;
        const ny = t.y + d.dy;
        if (this.isPassable(nx, ny, t)) t.moving = { x: nx, y: ny };
      } else if (input.face && DIRS[input.face]) {
        t.dir = input.face;
      }
    }
    if (input.fire) this.tryFire(t);
    if (t.moving) {
      const step = snap(this.rules.tankSpeed * dt);
      const dx = t.moving.x - t.fx;
      const dy = t.moving.y - t.fy;
      // 剩余距离也要对齐后再比，否则往两个方向走的坦克会差一帧到达
      if (snap(Math.abs(dx) + Math.abs(dy)) <= step) {
        t.fx = t.x = t.moving.x;
        t.fy = t.y = t.moving.y;
        t.moving = null;
      } else {
        t.fx = snap(t.fx + Math.sign(dx) * step);
        t.fy = snap(t.fy + Math.sign(dy) * step);
      }
    }
  }

  recordTrails() {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const last = t.trail[t.trail.length - 1];
      if (last && this.time - last.time < 0.25) continue;
      t.trail.push({ time: this.time, x: t.fx, y: t.fy });
      if (t.trail.length > 9) t.trail.shift();
    }
  }

  canFire(t) {
    return t.alive && t.cooldown <= 0 && !this.bullets.some((b) => b.owner === t.id);
  }

  tryFire(t) {
    if (!this.canFire(t)) return false;
    const d = DIRS[t.dir];
    this.bullets.push({
      id: this.nextId++,
      owner: t.id,
      team: t.team,
      x: t.fx + d.dx * 0.45,
      y: t.fy + d.dy * 0.45,
      dir: t.dir,
      alive: true,
    });
    t.cooldown = this.rules.fireCooldown;
    t.shots++;
    this.events.push({ type: 'fire', x: t.fx, y: t.fy, tank: t.id });
    return true;
  }

  tryRespawn(t) {
    const sp = t.spawn;
    if (this.tankAt(sp.x, sp.y, t)) return;
    Object.assign(t, {
      x: sp.x, y: sp.y, fx: sp.x, fy: sp.y,
      dir: t.team === 'blue' ? 'up' : 'down',
      moving: null,
      hp: this.rules.tankHp,
      alive: true,
      cooldown: 0,
      shieldUntil: this.time + this.rules.spawnShield,
      trail: [],
    });
    this.events.push({ type: 'spawn', x: sp.x, y: sp.y, tank: t.id });
  }

  updateBullets(dt) {
    const travel = this.rules.bulletSpeed * dt;
    const subSteps = Math.max(1, Math.ceil(travel / 0.2));
    const s = travel / subSteps;
    for (let i = 0; i < subSteps; i++) {
      for (const b of this.bullets) {
        if (!b.alive) continue;
        const d = DIRS[b.dir];
        b.x = snap(b.x + d.dx * s);
        b.y = snap(b.y + d.dy * s);
        this.collideBullet(b);
      }
      // 子弹互相抵消
      for (let a = 0; a < this.bullets.length; a++) {
        const b1 = this.bullets[a];
        if (!b1.alive) continue;
        for (let c = a + 1; c < this.bullets.length; c++) {
          const b2 = this.bullets[c];
          if (!b2.alive || b1.team === b2.team) continue;
          if (snap(Math.abs(b1.x - b2.x)) < 0.35 && snap(Math.abs(b1.y - b2.y)) < 0.35) {
            b1.alive = b2.alive = false;
            this.events.push({ type: 'spark', x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 });
          }
        }
      }
    }
    this.bullets = this.bullets.filter((b) => b.alive);
  }

  collideBullet(b) {
    // 子弹所在格：先消掉浮点累积误差，正好在两格交界时算作“还在正要离开的那一格”。
    // 直接用 Math.round 会让 +x/+y 方向（红方往下打）的子弹比 -x/-y 方向提前一步进入下一格，
    // 平时看不出来，但闪避的时机一被放大，就会让一方系统性占便宜。
    const d = DIRS[b.dir];
    const tx = tileAlong(b.x, d.dx);
    const ty = tileAlong(b.y, d.dy);
    if (!this.inBounds(tx, ty)) { b.alive = false; return; }
    const tile = this.tileAt(tx, ty);
    if (tile === T.BRICK) {
      this.setTile(tx, ty, T.EMPTY);
      b.alive = false;
      this.events.push({ type: 'brick', x: tx, y: ty });
      return;
    }
    if (tile === T.STEEL) {
      b.alive = false;
      this.events.push({ type: 'spark', x: b.x, y: b.y });
      return;
    }
    if (tile === T.BASE) {
      const base = this.baseAt(tx, ty);
      b.alive = false;
      if (base && base.hp > 0) {
        base.hp--;
        base.lastHitBy = b.owner;
        base.hitTimes.push(this.time);
        if (base.hitTimes.length > 20) base.hitTimes.shift();
        const shooter = this.getTank(b.owner);
        if (shooter && shooter.team !== base.team) shooter.baseDamage++;
        this.events.push({ type: base.hp <= 0 ? 'baseDestroyed' : 'baseHit', x: tx, y: ty, team: base.team, by: b.owner });
      }
      return;
    }
    for (const t of this.tanks) {
      if (!t.alive || t.id === b.owner) continue;
      if (snap(Math.abs(t.fx - b.x)) < 0.45 && snap(Math.abs(t.fy - b.y)) < 0.45) {
        b.alive = false;
        if (t.team === b.team) { this.events.push({ type: 'spark', x: b.x, y: b.y }); return; }
        if (this.time < t.shieldUntil) { this.events.push({ type: 'shield', x: t.fx, y: t.fy }); return; }
        this.damageTank(t, b.owner);
        return;
      }
    }
  }

  damageTank(t, attackerId) {
    const attacker = this.getTank(attackerId);
    t.hp--;
    if (attacker) attacker.hits++;
    this.events.push({ type: 'hit', x: t.fx, y: t.fy, tank: t.id, by: attackerId });
    if (t.hp <= 0) {
      t.alive = false;
      t.moving = null;
      t.lives--;
      t.deaths++;
      if (attacker && attacker.team !== t.team) attacker.kills++;
      t.respawnAt = this.time + this.rules.respawnDelay;
      this.events.push({ type: 'explode', x: t.fx, y: t.fy, tank: t.id, by: attackerId });
    }
  }

  teamKills(team) { return this.tanks.filter((t) => t.team === team).reduce((s, t) => s + t.kills, 0); }

  checkEnd() {
    const lost = [];
    for (const team of ['blue', 'red']) {
      if (this.bases[team].hp <= 0) lost.push(team);
    }
    if (lost.length) return this.finish(lost.length === 2 ? 'draw' : otherTeam(lost[0]), 'base');
    for (const team of ['blue', 'red']) {
      const members = this.tanks.filter((t) => t.team === team);
      if (members.length && members.every((t) => !t.alive && t.lives <= 0)) lost.push(team);
    }
    if (lost.length) return this.finish(lost.length === 2 ? 'draw' : otherTeam(lost[0]), 'eliminated');
    if (this.time >= this.rules.matchSeconds) {
      const hpDiff = this.bases.blue.hp - this.bases.red.hp;
      const killDiff = this.teamKills('blue') - this.teamKills('red');
      let winner = 'draw';
      if (hpDiff !== 0) winner = hpDiff > 0 ? 'blue' : 'red';
      else if (killDiff !== 0) winner = killDiff > 0 ? 'blue' : 'red';
      return this.finish(winner, 'timeout');
    }
    return null;
  }

  finish(winner, reason) {
    this.over = true;
    this.winner = winner;
    this.reason = reason;
    this.events.push({ type: 'over', winner, reason });
    return winner;
  }

  summary() {
    return {
      winner: this.winner,
      reason: this.reason,
      time: Math.round(this.time * 10) / 10,
      bases: { blue: this.bases.blue.hp, red: this.bases.red.hp },
      kills: { blue: this.teamKills('blue'), red: this.teamKills('red') },
      tanks: this.tanks.map((t) => ({ id: t.id, kills: t.kills, deaths: t.deaths, shots: t.shots, hits: t.hits, baseDamage: t.baseDamage })),
    };
  }
}
