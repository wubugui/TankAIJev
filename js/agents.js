import { buildDecision } from './observe.js';
import { Executor } from './executor.js';
import { ruleTactic, ruleDirect, ruleCallout, randomChoice, makeRng } from './policies.js';

// 控制器类型：
//   human            键盘
//   rule / random / idle   浏览器本地 AI
//   remote:<backend> 通过服务端调用 Jev / Laya / 其他兼容 systemone 接口的后端
export const LOCAL_KINDS = {
  human: '人类玩家（键盘）',
  rule: '规则 AI（基准）',
  random: '随机 AI',
  idle: '木桩（不动）',
};

export function kindLabel(kind, backends = []) {
  if (kind.startsWith('remote:')) {
    const b = backends.find((x) => `remote:${x.id}` === kind);
    return b ? b.label : kind.slice(7);
  }
  return LOCAL_KINDS[kind] || kind;
}

export function shortLabel(kind) {
  if (kind.startsWith('remote:')) return kind.slice(7);
  return { human: '你', rule: '规则', random: '随机', idle: '木桩' }[kind] || kind;
}

export class HumanController {
  constructor(tank, keyboard) {
    this.tank = tank;
    this.kind = 'human';
    this.keyboard = keyboard;
    this.stats = newStats();
  }
  update() { return this.keyboard.input(); }
  act() { return this.keyboard.input(); }
  canDecide() { return false; }
  needsDecision() { return false; }
  decide() {}
  abandonPending() {}
  dispose() {}
}

function newStats() {
  return { decisions: 0, errors: 0, invalid: 0, warnings: 0, late: 0, latencies: [], confSum: 0, confN: 0, lastError: null, lastWarning: null, tactics: {} };
}

export class AIController {
  // decide(payload) => Promise<{answers, latency_ms, model, cost_usd}>，仅 remote 需要
  constructor({ tank, kind, decide, settings, seed = 1 }) {
    this.tank = tank;
    this.kind = kind;
    this.backendId = kind.startsWith('remote:') ? kind.slice(7) : null;
    this.decideRemote = decide;
    this.settings = settings; // { mode, intervalMs, callouts }
    this.rng = makeRng(seed);
    this.exec = new Executor(this.rng);
    this.tactic = 'hold_position';
    this.lastProb = null;
    this.lastConf = null;
    this.inFlight = false;
    this.pending = null;
    // settings.stagger（默认关）：远程 AI 同队两辆车错开半个决策周期，2 号车决策时能看到 1 号车刚做的选择。
    // 本想用它避免两车同步做同样的事，但模拟里固定策略对规则 AI 的胜率一致下降 5~10 个点，好处又未验证，
    // 所以默认关闭，只留作实验选项（arena --stagger）。规则 AI 不读队友计划，从不错开。
    const period = settings.mode === 'direct' ? 0.1 : (settings.intervalMs || 400) / 1000;
    this.lastDecisionAt = this.backendId && tank.index === 1 && settings.stagger === true ? -period / 2 : -Infinity;
    this.jitter = 1;
    this.history = [];
    this.calloutMemory = { last: 'none', lastAt: -Infinity, ackedOrderTime: null };
    this.stats = newStats();
    this.disposed = false;
  }

  dispose() { this.disposed = true; }

  needsDecision(game) {
    if (!this.tank.alive || this.inFlight || this.kind === 'idle') return false;
    if (this.settings.mode === 'direct') return this.exec.directDone && game.time - this.lastDecisionAt >= 0.1 * this.jitter;
    return game.time - this.lastDecisionAt >= (this.settings.intervalMs / 1000) * this.jitter;
  }

  canDecide() {
    return this.tank.alive && !this.inFlight && this.kind !== 'idle';
  }

  // 实时模式：自己按时间决策，不等远程答案，当帧就按当前战术执行
  update(game, dt, ctx) {
    if (!this.tank.alive || this.kind === 'idle') return {};
    if (this.needsDecision(game)) this.decide(game, ctx);
    return this.act(game, dt);
  }

  // 只执行当前战术（公平模式下由 Match 统一安排决策时机）
  act(game, dt) {
    if (!this.tank.alive || this.kind === 'idle') return {};
    const current = this.settings.mode === 'direct' ? this.exec.direct?.action : this.tactic;
    return this.exec.run(game, this.tank, current, dt);
  }

  // 公平模式下等太久还没回来的请求作废：答案晚到时局面已经变了，不能再用
  abandonPending() {
    if (this.inFlight) this.abandonedReq = this.reqId;
  }

  decisionContext(ctx) {
    const team = this.tank.team;
    const allyIsHuman = ctx.humanIds?.some((id) => id !== this.tank.id && ctx.teamOf?.[id] === team) || false;
    const allyId = Object.keys(ctx.teamOf || {}).find((id) => id !== this.tank.id && ctx.teamOf[id] === team);
    return {
      allyPlan: allyId ? ctx.plans?.[allyId] ?? null : null,
      promptVersion: this.settings.promptVersion,
      order: allyIsHuman ? ctx.orders?.[team] || null : null,
      allyIsHuman,
      callouts: this.settings.callouts,
      history: this.history,
      style: this.promptStyle(),
    };
  }

  // 提示词风格：界面上强制指定，或按后端默认（Laya 需要精简版）
  promptStyle() {
    const forced = this.settings.promptStyle;
    if (forced && forced !== 'auto') return forced;
    return this.settings.backendStyles?.[this.backendId] || 'full';
  }

  decide(game, ctx) {
    const dctx = this.decisionContext(ctx);
    const dec = buildDecision(game, this.tank, this.settings.mode, dctx);
    this.lastDecisionAt = game.time;
    this.jitter = 0.85 + this.rng() * 0.3;
    if (this.kind === 'rule') {
      const choice = this.settings.mode === 'direct' ? ruleDirect(game, dec, this.tank) : ruleTactic(dec, this.tank);
      this.apply(choice, { prob: 1, conf: 1, latency: 0 }, ctx, game);
      if (dctx.allyIsHuman && dctx.callouts) this.emitCallout(ruleCallout(dec, this.calloutMemory), 1, ctx, game);
      return;
    }
    if (this.kind === 'random') {
      const choice = randomChoice(dec.options, this.rng);
      this.apply(choice, { prob: 1 / Object.keys(dec.options).length, conf: 0, latency: 0 }, ctx, game);
      return;
    }
    if (this.backendId) this.decideViaBackend(game, dec, dctx, ctx);
  }

  decideViaBackend(game, dec, dctx, ctx) {
    this.inFlight = true;
    const req = (this.reqId = (this.reqId || 0) + 1);
    const t0 = performance.now();
    const payload = { backend: this.backendId, agent: this.tank.id, state: dec.state, questions: dec.questions };
    this.pending = this.decideRemote(payload)
      .then((res) => {
        if (this.disposed) return;
        if (this.abandonedReq === req) {
          this.stats.late++;
          return;
        }
        const ans = res.answers?.tactic;
        const choice = ans?.choice;
        if (!choice || !(choice in dec.options)) {
          this.stats.invalid++;
          throw new Error(`后端返回了无效选项: ${JSON.stringify(choice)}`);
        }
        const latency = Math.round(performance.now() - t0);
        if (res.warnings?.length) {
          // 例如 Laya 提示 state 超长被截断：决策仍然有效，但要让人看到
          this.stats.warnings++;
          this.stats.lastWarning = res.warnings.join('; ');
        }
        this.apply(choice, { prob: ans.probabilities?.[choice], conf: ans.confidence, latency, upstream: res.latency_ms, model: res.model, warning: res.warnings?.[0] }, ctx, game);
        const co = res.answers?.callout;
        if (co && co.choice) this.emitCallout(co.choice, co.probabilities?.[co.choice] ?? 0, ctx, game, co.probabilities);
      })
      .catch((err) => {
        if (this.disposed) return;
        this.stats.errors++;
        this.stats.lastError = String(err?.message || err);
        ctx.onDecision?.({ agent: this.tank.id, kind: this.kind, error: this.stats.lastError, time: game.time });
      })
      .finally(() => {
        this.inFlight = false;
        this.pending = null;
      });
  }

  apply(choice, info, ctx, game) {
    if (this.settings.mode === 'direct') this.exec.setDirect(choice);
    else this.tactic = choice;
    this.lastProb = info.prob ?? null;
    this.lastConf = info.conf ?? null;
    this.history.push(choice);
    if (this.history.length > 10) this.history.shift();
    const s = this.stats;
    s.decisions++;
    s.tactics[choice] = (s.tactics[choice] || 0) + 1;
    if (info.latency) {
      s.latencies.push(info.latency);
      if (s.latencies.length > 100) s.latencies.shift();
    }
    if (typeof info.conf === 'number') { s.confSum += info.conf; s.confN++; }
    ctx.onDecision?.({ agent: this.tank.id, kind: this.kind, choice, ...info, time: game.time });
  }

  // 喊话门槛：概率 ≥ 0.4，或者明显高于“不说话”（Laya 的概率分布比 Jev 平得多，
  // 7 个选项里最高常常只有 0.3，绝对阈值会把它的喊话全压掉）
  emitCallout(choice, prob, ctx, game, probs = null) {
    const m = this.calloutMemory;
    if (!choice || choice === 'none') return;
    const pNone = probs?.none ?? 0;
    if (prob < 0.4 && prob < 1.5 * pNone) return;
    if (choice === m.last && game.time - m.lastAt < 8) return;
    m.last = choice;
    m.lastAt = game.time;
    ctx.onCallout?.({ agent: this.tank.id, callout: choice, prob, time: game.time });
  }
}

export function avgLatency(stats) {
  if (!stats.latencies.length) return null;
  return Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length);
}
