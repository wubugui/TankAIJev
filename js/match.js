import { Game, DEFAULT_SLOTS } from './game.js';
import { AIController, HumanController } from './agents.js';
import { makeRng } from './constants.js';

export const STEP = 1 / 60;
// 公平模式下最多等远程 AI 多久；超时的答案作废，世界照常往下走
export const FAIR_MAX_WAIT_MS = 4000;

// 一局比赛：游戏状态 + 每辆坦克的控制器。浏览器和 arena（无界面批量对战）共用。
//
// 两种推进方式：
//   tick()      实时：世界不等 AI。远程 AI 的答案晚到多少，就按多旧的局面在决策——体验真实网络延迟用。
//   tickFair()  公平：所有 AI 在同一时刻、基于同一个局面一起决策；有远程 AI 在思考就暂停世界，
//               答案全部回来后这一帧才执行。延迟只影响等待时间，不影响对局，规则 AI 和模型站在同一起跑线。
export class Match {
  constructor({ kinds, settings, rules, decide, keyboard, seed = 1, map }) {
    this.settings = settings;
    this.decide = decide;
    this.keyboard = keyboard;
    this.seed = seed;
    this.game = new Game({ rules, slots: DEFAULT_SLOTS, seed, map });
    this.controllers = new Map();
    this.orders = { blue: null, red: null };
    this.listeners = { decision: [], callout: [] };
    this.rng = makeRng(seed * 131 + 17); // 公平模式的共同决策时钟用（间隔 ±15% 抖动，让不同种子的对局有变化）
    this.nextDecisionAt = 0;
    this.freeze = { count: 0, totalMs: 0, lastMs: 0 }; // 公平模式下为等 AI 暂停的次数和时长
    this.disposed = false;
    for (const t of this.game.tanks) this.setController(t.id, kinds[t.id] || 'rule');
  }

  on(event, fn) { this.listeners[event].push(fn); }

  setController(id, kind) {
    const tank = this.game.getTank(id);
    const old = this.controllers.get(id);
    if (old) old.dispose();
    const ctrl = kind === 'human'
      ? new HumanController(tank, this.keyboard)
      : new AIController({ tank, kind, decide: this.decide, settings: this.settings, seed: this.seed * 31 + tank.index * 7 + (tank.team === 'red' ? 101 : 0) });
    this.controllers.set(id, ctrl);
    return ctrl;
  }

  kindOf(id) { return this.controllers.get(id)?.kind; }

  issueOrder(team, order) {
    this.orders[team] = order === 'free' ? null : { order, time: this.game.time };
  }

  context() {
    const humanIds = [];
    const teamOf = {};
    const plans = {}; // 每辆 AI 坦克当前在执行的战术，给队友参考
    for (const t of this.game.tanks) {
      teamOf[t.id] = t.team;
      const c = this.controllers.get(t.id);
      if (c.kind === 'human') humanIds.push(t.id);
      else if (c.kind !== 'idle') plans[t.id] = this.settings.mode === 'direct' ? c.exec?.direct?.action || null : c.tactic;
    }
    return {
      orders: this.orders,
      humanIds,
      teamOf,
      plans,
      onDecision: (e) => this.listeners.decision.forEach((fn) => fn(e)),
      onCallout: (e) => this.listeners.callout.forEach((fn) => fn(e)),
    };
  }

  // 实时推进一帧
  tick(dt = STEP) {
    if (this.game.over) return;
    const ctx = this.context();
    for (const t of this.game.tanks) {
      const input = this.controllers.get(t.id).update(this.game, dt, ctx);
      this.game.setInput(t.id, input);
    }
    this.game.step(dt);
  }

  // 公平推进一帧。不用等 AI 时同步完成、返回 undefined；要等时返回 Promise，完成后这一帧才走完。
  tickFair(dt = STEP) {
    if (this.game.over) return undefined;
    const g = this.game;
    const ctx = this.context();
    const ais = [...this.controllers.values()].filter((c) => c.kind !== 'human');
    if (this.settings.mode === 'direct') {
      // 直接控制：每辆车的单步动作做完就决策下一步
      for (const c of ais) if (c.needsDecision(g)) c.decide(g, ctx);
    } else if (g.time >= this.nextDecisionAt) {
      // 战术层：共同的决策时刻，所有 AI 基于同一个局面一起决策
      for (const c of ais) if (c.canDecide()) c.decide(g, ctx);
      this.nextDecisionAt = g.time + ((this.settings.intervalMs || 400) / 1000) * (0.85 + this.rng() * 0.3);
    }
    const pending = this.pendingDecisions();
    if (!pending.length) {
      this.finishTick(dt);
      return undefined;
    }
    const t0 = performance.now();
    const maxWait = this.settings.maxWaitMs ?? FAIR_MAX_WAIT_MS;
    let timer = null;
    const all = Promise.all(pending);
    const waited = Number.isFinite(maxWait)
      ? Promise.race([all, new Promise((resolve) => { timer = setTimeout(resolve, maxWait); })])
      : all;
    return waited.then(() => {
      clearTimeout(timer);
      for (const c of this.controllers.values()) c.abandonPending();
      const ms = performance.now() - t0;
      this.freeze.count++;
      this.freeze.totalMs += ms;
      this.freeze.lastMs = ms;
      if (!this.game.over && !this.disposed) this.finishTick(dt);
    });
  }

  finishTick(dt) {
    for (const t of this.game.tanks) this.game.setInput(t.id, this.controllers.get(t.id).act(this.game, dt));
    this.game.step(dt);
  }

  pendingDecisions() {
    return [...this.controllers.values()].map((c) => c.pending).filter(Boolean);
  }

  dispose() {
    this.disposed = true;
    for (const c of this.controllers.values()) c.dispose();
  }
}
