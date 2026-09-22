import { Executor } from './executor.js';

// 规则 AI：作为基准线（baseline），与模型面对完全相同的选项；闪避和开火由执行层的反射层处理。
export function ruleTactic(dec, tank) {
  const o = dec.options;
  const a = dec.analysis;
  // 2 号车负责看家，敌人靠近基地 6 格就回防；1 号车只在 4 格内回防
  if (a.baseThreat && a.baseThreat.distToOurBase <= (tank.index === 1 ? 6 : 4)) return 'defend_our_base';
  if (a.order) {
    if (a.order.order === 'attack') return bestAttack(o, a, tank);
    if (a.order.order === 'defend') return 'defend_our_base';
    if (a.order.order === 'follow' && o.follow_teammate) return 'follow_teammate';
  }
  if (tank.hp === 1 && o.retreat && a.nearestEnemy && a.nearestEnemy.path <= 4) return 'retreat';
  // 分工：1 号车拆家，2 号车先清附近的敌人
  if (tank.index === 0) return bestAttack(o, a, tank);
  if (a.nearestEnemy && a.nearestEnemy.path <= 7) return `hunt_${a.nearestEnemy.id}`;
  return bestAttack(o, a, tank);
}

// 夹击：1 号车从左、2 号车从右进攻；这一侧到不了就选路程最短的一侧。
// 这是固定打法，可以被针对：当前地图上两辆敌车一起正面冲时它赢不了（见 README 的策略循环赛）。
function bestAttack(o, a, tank) {
  const want = tank.index === 0 ? 'attack_left' : 'attack_right';
  if (o[want]) return want;
  let best = null;
  for (const side of ['front', 'left', 'right']) {
    if (!o[`attack_${side}`]) continue;
    if (!best || a.attackSides[side].dist < a.attackSides[best].dist) best = side;
  }
  return best ? `attack_${best}` : 'hold_position';
}

// 直接控制模式下的规则 AI：先按战术规则想，再取执行层算出的第一步
export function ruleDirect(game, dec, tank) {
  const tactic = ruleTactic(dec, tank);
  const input = new Executor(() => 0.5).runTactic(game, tank, tactic);
  if (input.move) return `move_${input.move}`;
  if (input.fire) return `fire_${input.face || tank.dir}`;
  return 'wait';
}

export function ruleCallout(dec, memory) {
  const a = dec.analysis;
  if (a.order && a.order.time !== memory.ackedOrderTime) {
    memory.ackedOrderTime = a.order.time;
    return 'roger';
  }
  if (a.baseThreat && a.baseThreat.distToOurBase <= 4) return 'enemy_near_base';
  if (a.tank.hp === 1) return 'need_help';
  return 'none';
}

export function randomChoice(options, rng) {
  const keys = Object.keys(options);
  return keys[Math.floor(rng() * keys.length)];
}

export { makeRng } from './constants.js';
