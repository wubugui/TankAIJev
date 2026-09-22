// 无界面批量对战：比较不同决策后端的效果。
//
//   npm run arena -- --blue jev,jev --red rule,rule --matches 3
//   npm run arena -- --blue jev,jev --red laya,laya --matches 5 --swap --style compact
//
// 参数：
//   --blue a,b / --red c,d   每辆坦克的控制者：rule | random | idle | 后端 id（jev、laya、mock …）
//   --matches N              局数（默认 3）
//   --swap                   每局再交换双方颜色打一次，抵消地图/出生点带来的偏差
//   --mode tactical|direct   决策模式（默认 tactical）
//   --interval ms            战术层决策间隔（默认 400）
//   --seconds S              每局时长（默认 180）
//   --style auto|full|compact 提示词风格（默认 auto：按后端配置）
//   --prompt v1|v2|v3        提示词版本（默认 v3）
//   --stagger                远程 AI 同队两车错开半个决策周期（实验选项，默认关）
//   --realtime               按真实时间推进（模型延迟会影响战局）；默认“公平/锁步”：所有 AI 同一时刻决策，等答案回来再推进，只比决策质量
//   --yes                    预计花费超过 $0.05 时不再询问确认
//
// 付费后端与网页版共用 data/usage.json 账本和 BUDGET_USD 上限。
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { Match, STEP } from '../public/js/match.js';
import { loadBackends, callBackend } from '../server/backends.js';
import { Budget } from '../server/budget.js';
import { mockSystemOne } from '../public/js/mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = ['rule', 'random', 'idle'];

function parseArgs(argv) {
  const args = { blue: 'rule,rule', red: 'rule,rule', matches: 3, swap: false, mode: 'tactical', interval: 400, seconds: 180, style: 'auto', prompt: 'v3', stagger: false, realtime: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--blue') args.blue = next();
    else if (a === '--red') args.red = next();
    else if (a === '--matches') args.matches = Number(next());
    else if (a === '--swap') args.swap = true;
    else if (a === '--mode') args.mode = next();
    else if (a === '--interval') args.interval = Number(next());
    else if (a === '--seconds') args.seconds = Number(next());
    else if (a === '--style') args.style = next();
    else if (a === '--prompt') args.prompt = next();
    else if (a === '--stagger') args.stagger = true;
    else if (a === '--realtime') args.realtime = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--help' || a === '-h') { console.log(readHelp()); process.exit(0); }
    else throw new Error(`未知参数 ${a}`);
  }
  return args;
}

function readHelp() {
  return 'npm run arena -- --blue jev,jev --red rule,rule --matches 3 [--swap] [--mode direct] [--interval 400] [--seconds 180] [--style compact] [--prompt v1] [--realtime]';
}

const toKind = (k) => (LOCAL.includes(k) ? k : `remote:${k}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backends = loadBackends(path.join(ROOT, 'config', 'backends.json'), process.env, Number(process.env.PORT || 3000));
  const budget = new Budget(path.join(ROOT, 'data', 'usage.json'), Number(process.env.BUDGET_USD || 1));
  const blue = args.blue.split(',');
  const red = args.red.split(',');
  if (blue.length !== 2 || red.length !== 2) throw new Error('--blue 和 --red 各需要两个控制者，用逗号分隔');
  for (const k of [...blue, ...red]) {
    if (!LOCAL.includes(k) && !backends.some((b) => b.id === k)) throw new Error(`不认识的控制者 ${k}（可选：${[...LOCAL, ...backends.map((b) => b.id)].join(', ')}）`);
  }

  // 花费预估：每次请求约 1100 token（精简版约 900）
  const perDecisionTokens = args.style === 'compact' ? 900 : 1100;
  const decisionsPerAgent = args.mode === 'direct' ? args.seconds * 2.5 : (args.seconds * 1000) / args.interval;
  const paidAgents = [...blue, ...red].map((k) => backends.find((b) => b.id === k)).filter((b) => b && b.pricePerMTok > 0);
  const rounds = args.matches * (args.swap ? 2 : 1);
  const worst = paidAgents.reduce((s, b) => s + decisionsPerAgent * perDecisionTokens * b.pricePerMTok / 1e6, 0) * rounds;
  const snap = budget.snapshot();
  console.log(`对阵：蓝 [${blue.join(', ')}] vs 红 [${red.join(', ')}]，${rounds} 局，模式 ${args.mode}，提示词 ${args.prompt}，${args.realtime ? '实时' : '锁步'}`);
  if (worst > 0) {
    console.log(`付费调用预估：最多约 $${worst.toFixed(4)}（通常更少，基地被拆会提前结束）；账本已花 $${snap.spent_usd} / 上限 $${snap.limit_usd}`);
    if (worst > 0.05 && !args.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question('继续吗？(y/N) ');
      rl.close();
      if (!/^y/i.test(ans.trim())) return;
    }
  }

  const decide = async (payload) => {
    const b = backends.find((x) => x.id === payload.backend);
    if (b.id === 'mock') return { ...(await mockSystemOne(payload)), latency_ms: 0 };
    return callBackend(b, payload, budget);
  };

  const results = [];
  for (let i = 0; i < args.matches; i++) {
    for (const swapped of args.swap ? [false, true] : [false]) {
      // A 队 = 命令行里 --blue 的那组；换边时 A 队开红方
      const [blueSide, redSide] = swapped ? [red, blue] : [blue, red];
      const kinds = { B1: toKind(blueSide[0]), B2: toKind(blueSide[1]), R1: toKind(redSide[0]), R2: toKind(redSide[1]) };
      const settings = {
        mode: args.mode,
        intervalMs: args.interval,
        callouts: false,
        promptStyle: args.style,
        promptVersion: args.prompt,
        stagger: args.stagger,
        timing: args.realtime ? 'realtime' : 'fair',
        maxWaitMs: Infinity, // 批量评测不设等待上限，每个答案都等到
        backendStyles: Object.fromEntries(backends.map((b) => [b.id, b.promptStyle])),
      };
      const match = new Match({ kinds, settings, rules: { matchSeconds: args.seconds }, decide, seed: 1000 + i });
      const t0 = performance.now();
      if (args.realtime) {
        let last = performance.now();
        while (!match.game.over) {
          await new Promise((r) => setTimeout(r, 10));
          const now = performance.now();
          let acc = (now - last) / 1000;
          last = now;
          while (acc >= STEP && !match.game.over) { match.tick(STEP); acc -= STEP; }
        }
      } else {
        // 公平模式（锁步）：所有 AI 在同一时刻决策，等答案回来再推进，和网页的公平模式同一套代码
        while (!match.game.over) {
          const wait = match.tickFair(STEP);
          if (wait) await wait;
        }
      }
      await Promise.all(match.pendingDecisions());
      const s = match.game.summary();
      // 统一换算成“A 队（--blue 那组）”的视角
      const aTeam = swapped ? 'red' : 'blue';
      const outcome = s.winner === 'draw' ? 'draw' : s.winner === aTeam ? 'A' : 'B';
      const perTank = {};
      for (const [id, c] of match.controllers) {
        const lat = c.stats.latencies.length ? Math.round(c.stats.latencies.reduce((x, y) => x + y, 0) / c.stats.latencies.length) : null;
        perTank[id] = { kind: c.kind, decisions: c.stats.decisions, errors: c.stats.errors, avgLatencyMs: lat, lastError: c.stats.lastError };
      }
      results.push({ match: i + 1, swapped, outcome, ...s, perTank, wallSeconds: Math.round((performance.now() - t0) / 100) / 10 });
      const label = outcome === 'A' ? `A 胜（${args.blue}）` : outcome === 'B' ? `B 胜（${args.red}）` : '平局';
      const errs = Object.values(perTank).reduce((x, p) => x + p.errors, 0);
      console.log(`第 ${i + 1} 局${swapped ? '（换边）' : ''}：${label}，${s.reason}，${s.time}s，基地 蓝${s.bases.blue}/红${s.bases.red}，击杀 蓝${s.kills.blue}/红${s.kills.red}${errs ? `，决策错误 ${errs} 次` : ''}，耗时 ${results.at(-1).wallSeconds}s`);
      match.dispose();
    }
  }

  const count = (o) => results.filter((r) => r.outcome === o).length;
  console.log('\n==== 汇总 ====');
  console.log(`A [${args.blue}] 胜 ${count('A')}　B [${args.red}] 胜 ${count('B')}　平 ${count('draw')}（共 ${results.length} 局）`);
  const lat = {};
  for (const r of results) {
    for (const p of Object.values(r.perTank)) {
      if (p.avgLatencyMs == null) continue;
      (lat[p.kind] ||= []).push(p.avgLatencyMs);
    }
  }
  for (const [k, v] of Object.entries(lat)) console.log(`${k} 平均决策延迟 ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}ms`);
  const after = budget.snapshot();
  console.log(`付费调用本次花费 $${(after.spent_usd - snap.spent_usd).toFixed(6)}，账本累计 $${after.spent_usd} / 上限 $${after.limit_usd}`);
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const file = path.join(ROOT, 'data', `arena-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ args, results }, null, 2));
  console.log(`详细结果：${path.relative(ROOT, file)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
