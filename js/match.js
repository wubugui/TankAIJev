import { Game, DEFAULT_SLOTS } from './game.js';
import { AIController, HumanController } from './agents.js';

export const STEP = 1 / 60;

// 一局比赛：游戏状态 + 每辆坦克的控制器。浏览器和 arena（无界面批量对战）共用。
export class Match {
  constructor({ kinds, settings, rules, decide, keyboard, seed = 1 }) {
    this.settings = settings;
    this.decide = decide;
    this.keyboard = keyboard;
    this.seed = seed;
    this.game = new Game({ rules, slots: DEFAULT_SLOTS });
    this.controllers = new Map();
    this.orders = { blue: null, red: null };
    this.listeners = { decision: [], callout: [] };
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

  tick(dt = STEP) {
    if (this.game.over) return;
    const ctx = this.context();
    for (const t of this.game.tanks) {
      const input = this.controllers.get(t.id).update(this.game, dt, ctx);
      this.game.setInput(t.id, input);
    }
    this.game.step(dt);
  }

  pendingDecisions() {
    return [...this.controllers.values()].map((c) => c.pending).filter(Boolean);
  }

  dispose() {
    for (const c of this.controllers.values()) c.dispose();
  }
}
