// 界面上显示的中文文案

const TACTIC_ZH = {
  attack_enemy_base: '进攻敌方基地',
  defend_our_base: '回防基地',
  shoot_now: '立即开火',
  dodge: '闪避子弹',
  retreat: '撤退',
  follow_teammate: '跟随队友',
  hold_position: '原地坚守',
  move_up: '↑ 移动',
  move_down: '↓ 移动',
  move_left: '← 移动',
  move_right: '→ 移动',
  fire_up: '↑ 开火',
  fire_down: '↓ 开火',
  fire_left: '← 开火',
  fire_right: '→ 开火',
  wait: '等待',
};

export function tacticLabel(id) {
  if (!id) return '—';
  if (id.startsWith('hunt_')) return `追击 ${id.slice(5)}`;
  return TACTIC_ZH[id] || id;
}

export const CALLOUT_ZH = {
  roger: '收到！',
  need_help: '需要支援！',
  enemy_near_base: '敌人靠近基地！',
  attacking: '我去进攻！',
  defending: '我回防！',
};

export const ORDER_ZH = {
  attack: '进攻',
  defend: '回防',
  follow: '跟我',
  free: '自由行动',
};

export const REASON_ZH = {
  base: '摧毁基地',
  eliminated: '全歼对手',
  timeout: '时间到',
};

export const TEAM_ZH = { blue: '蓝方', red: '红方', draw: '平局' };
