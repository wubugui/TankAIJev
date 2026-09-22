import { Executor } from './executor.js';

// 规则 AI：作为基准线（baseline），与模型面对完全相同的选项。
export function ruleTactic(dec, tank) {
  const o = dec.options;
  const a = dec.analysis;
  if (o.dodge && a.incoming && a.incoming.dist <= 3) return 'dodge';
  if (o.shoot_now && a.gunReady) return 'shoot_now';
  // 2 号车负责看家，敌人靠近基地 6 格就回防；1 号车只在 4 格内回防
  if (a.baseThreat && a.baseThreat.distToOurBase <= (tank.index === 1 ? 6 : 4)) return 'defend_our_base';
  if (a.order) {
    if (a.order.order === 'attack') return 'attack_enemy_base';
    if (a.order.order === 'defend') return 'defend_our_base';
    if (a.order.order === 'follow' && o.follow_teammate) return 'follow_teammate';
  }
  if (tank.hp === 1 && o.retreat && a.nearestEnemy && a.nearestEnemy.path <= 4) return 'retreat';
  // 分工：1 号车拆家，2 号车先清附近的敌人
  if (tank.index === 0) return 'attack_enemy_base';
  if (a.nearestEnemy && a.nearestEnemy.path <= 7) return `hunt_${a.nearestEnemy.id}`;
  return 'attack_enemy_base';
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

// 可复现的随机数（mulberry32）
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
