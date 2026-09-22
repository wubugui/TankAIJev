import { Match, STEP } from './match.js';
import { LOCAL_KINDS, kindLabel, shortLabel, avgLatency } from './agents.js';
import { Renderer } from './render.js';
import { tacticLabel, CALLOUT_ZH, ORDER_ZH, REASON_ZH, TEAM_ZH } from './labels.js';
import {
  BACKENDS, loadSettings, saveSettings, clearSavedSettings, defaultSettings, loadLedger, resetLedger,
  probeRelay, describeBackend, callBackend, testBackend, normalizeRelayUrl,
} from './connection.js';
import { DEFAULT_RELAY_URL } from './site-config.js';

const $ = (sel) => document.querySelector(sel);
const SLOT_IDS = ['B1', 'B2', 'R1', 'R2'];
const STORE_KEY = 'npc-tank-setup-v1';

const app = {
  backends: [],
  conn: null, // 玩家的连接设置（key / endpoint），见 connection.js
  relay: { ok: false, note: '' },
  sameOriginRelay: false, // 页面是不是由本项目的 npm start 提供的（那样中转就是同源）
  budgetExhausted: false,
  match: null,
  config: null, // 最近一次开局的设置，重开时复用
  paused: false,
  raf: 0,
  lastPanel: 0,
  renderer: new Renderer($('#canvas')),
  log: [],
};

// ---------- 键盘 ----------
const KEY_DIR = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
const keyboard = {
  held: [],
  fire: false,
  input() {
    return { move: this.held[this.held.length - 1] || null, fire: this.fire };
  },
  reset() { this.held = []; this.fire = false; },
};

window.addEventListener('keydown', (e) => {
  if (!app.match || $('#play').hidden) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  const dir = KEY_DIR[e.code];
  if (dir) {
    e.preventDefault();
    if (!keyboard.held.includes(dir)) keyboard.held.push(dir);
    return;
  }
  if (e.code === 'Space' || e.code === 'KeyJ') { e.preventDefault(); keyboard.fire = true; return; }
  if (e.repeat) return;
  const orders = { Digit1: 'attack', Digit2: 'defend', Digit3: 'follow', Digit4: 'free', Numpad1: 'attack', Numpad2: 'defend', Numpad3: 'follow', Numpad4: 'free' };
  if (orders[e.code]) return issueOrder(orders[e.code]);
  if (e.code === 'KeyP') return togglePause();
  if (e.code === 'KeyR') return restart();
  if (e.code === 'Escape') return backToSetup();
});
window.addEventListener('keyup', (e) => {
  const dir = KEY_DIR[e.code];
  if (dir) keyboard.held = keyboard.held.filter((d) => d !== dir);
  if (e.code === 'Space' || e.code === 'KeyJ') keyboard.fire = false;
});
window.addEventListener('blur', () => keyboard.reset());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.match && !app.match.game.over && !app.paused) togglePause();
});

// ---------- 后端、连接设置与花费 ----------
// 重新探测中转并算出每个后端的可用状态（不发决策请求）
async function refreshBackends() {
  app.relay = await probeRelay(app.conn.relayUrl);
  app.backends = Object.values(BACKENDS).map((def) => ({
    id: def.id,
    label: def.label,
    paid: def.pricePerMTok > 0,
    pricePerMTok: def.pricePerMTok,
    promptStyle: def.promptStyle,
    health: describeBackend(def.id, app.conn, app.relay),
  }));
  renderConnStatus();
}

function updateBudgetBadge() {
  const spent = loadLedger().spent_usd;
  const limit = Number(app.conn.jev.budgetUsd);
  const badge = $('#budgetBadge');
  const money = spent > 0 && spent < 0.01 ? spent.toFixed(6) : spent.toFixed(4);
  badge.textContent = `Jev 花费 $${money} / 上限 $${Number.isFinite(limit) ? limit : '∞'}（本浏览器）`;
  const near = Number.isFinite(limit) && spent >= limit * 0.999;
  badge.className = 'badge' + (near ? ' bad' : Number.isFinite(limit) && spent > limit * 0.8 ? ' warn' : '');
  app.budgetExhausted = near;
  $('#jevSpent').textContent = `已花 $${money}`;
}

async function decideRemote(payload) {
  try {
    const res = await callBackend(payload.backend, payload, app.conn);
    if (res.cost_usd) updateBudgetBadge();
    return res;
  } catch (err) {
    if (err.budgetExhausted) {
      updateBudgetBadge();
      app.budgetExhausted = true;
      showWarning(`Jev 花费已到本浏览器的上限 $${app.conn.jev.budgetUsd}，已停止调用。可在“AI 连接设置”里调高上限或清零。`);
    }
    throw err;
  }
}

// ---------- AI 连接设置面板 ----------
function fillConnForm() {
  const s = app.conn;
  $('#relayUrl').value = s.relayUrl;
  $('#relayUrl').placeholder = app.sameOriginRelay ? '留空 = 本页面自己的服务' : DEFAULT_RELAY_URL;
  $('#jevKey').value = s.jev.key;
  $('#jevModel').value = s.jev.model;
  $('#jevBudget').value = s.jev.budgetUsd;
  $('#layaUrl').value = s.laya.url;
  $('#layaKey').value = s.laya.key;
  $('#layaModel').value = s.laya.model;
  $('#layaRoute').value = s.laya.route;
  $('#connRemember').checked = s.remember;
}

function readConnForm() {
  const budget = Number($('#jevBudget').value);
  return {
    remember: $('#connRemember').checked,
    relayUrl: normalizeRelayUrl($('#relayUrl').value),
    jev: { key: $('#jevKey').value.trim(), model: $('#jevModel').value.trim(), budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 1 },
    laya: { url: $('#layaUrl').value.trim(), key: $('#layaKey').value.trim(), model: $('#layaModel').value.trim(), route: $('#layaRoute').value },
  };
}

function setStatus(el, ok, text) {
  el.textContent = text;
  el.className = `conn-status ${ok === null ? '' : ok ? 'ok' : 'bad'}`;
}

function renderConnStatus() {
  const byId = Object.fromEntries(app.backends.map((b) => [b.id, b.health]));
  const isDefault = !app.sameOriginRelay && normalizeRelayUrl(app.conn.relayUrl) === DEFAULT_RELAY_URL;
  const which = isDefault ? '默认中转' : app.conn.relayUrl ? '自定义中转' : '本页面的服务';
  setStatus($('#relayStatus'), app.relay.ok, app.relay.ok ? `✓ ${which} ${app.relay.note}` : `✗ ${which} ${app.relay.note || '连不上'}`);
  setStatus($('#jevStatus'), byId.jev.ok, `${byId.jev.ok ? '✓' : '✗'} ${byId.jev.note}`);
  setStatus($('#layaStatus'), byId.laya.ok, `${byId.laya.ok ? '✓' : '✗'} ${byId.laya.note}`);
  const ready = app.backends.filter((b) => b.id !== 'mock' && b.health.ok).map((b) => b.label);
  $('#connSummary').textContent = ready.length ? `可用：${ready.join('、')}` : '还没有可用的模型（规则 AI 照样能玩）';
  updateBudgetBadge();
}

let connTimer = 0;
function onConnChange() {
  app.conn = readConnForm();
  saveSettings(app.conn);
  clearTimeout(connTimer);
  connTimer = setTimeout(async () => {
    await refreshBackends();
    // 下拉框里的状态提示跟着刷新，保留当前选择
    for (const id of SLOT_IDS) {
      const sel = $(`#slot-${id}`);
      fillSelect(sel, id, sel.value);
    }
    updateEstimate();
  }, 300);
}

for (const id of ['relayUrl', 'jevKey', 'jevModel', 'jevBudget', 'layaUrl', 'layaKey', 'layaModel']) $(`#${id}`).addEventListener('input', onConnChange);
for (const id of ['layaRoute', 'connRemember']) $(`#${id}`).addEventListener('change', onConnChange);

async function runTest(id, statusEl, btn) {
  btn.disabled = true;
  setStatus(statusEl, null, '测试中…');
  try {
    app.conn = readConnForm();
    if (id === 'jev' || app.conn.laya.route === 'relay') app.relay = await probeRelay(app.conn.relayUrl);
    setStatus(statusEl, true, `✓ ${await testBackend(id, app.conn)}`);
    updateBudgetBadge();
  } catch (err) {
    setStatus(statusEl, false, `✗ ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
$('#jevTest').addEventListener('click', (e) => runTest('jev', $('#jevStatus'), e.currentTarget));
$('#layaTest').addEventListener('click', (e) => runTest('laya', $('#layaStatus'), e.currentTarget));
$('#jevReset').addEventListener('click', () => {
  resetLedger();
  updateBudgetBadge();
  showWarning('');
});
$('#connClear').addEventListener('click', () => {
  clearSavedSettings();
  app.conn = defaultSettings(app.sameOriginRelay);
  fillConnForm();
  onConnChange();
});

function showWarning(text) {
  const w = $('#warning');
  w.textContent = text;
  w.hidden = !text;
}

// ---------- 设置页 ----------
// 每辆坦克的控制者选项，分三组：决策模型（Laya / Jev …）、基准（规则 AI）、测试用（随机 / 木桩 / Mock）
const TEST_KINDS = new Set(['random', 'idle', 'remote:mock']);

function kindChoices(slotId) {
  const groups = { 决策模型: [], 基准: [], 测试用: [] };
  if (slotId === 'B1') groups.基准.push({ value: 'human', label: LOCAL_KINDS.human }); // 只有一套键盘，人类固定开 B1
  for (const b of app.backends) {
    const value = `remote:${b.id}`;
    const status = b.health?.ok ? '' : `（${b.health?.note || '不可用'}）`;
    (TEST_KINDS.has(value) ? groups.测试用 : groups.决策模型).push({ value, label: `${b.label}${status}` });
  }
  groups.基准.push({ value: 'rule', label: LOCAL_KINDS.rule });
  for (const k of ['random', 'idle']) groups.测试用.push({ value: k, label: LOCAL_KINDS[k] });
  return groups;
}

function fillSelect(sel, slotId, value) {
  sel.innerHTML = '';
  for (const [name, items] of Object.entries(kindChoices(slotId))) {
    if (!items.length) continue;
    const group = document.createElement('optgroup');
    group.label = name;
    for (const c of items) {
      const opt = document.createElement('option');
      opt.value = c.value;
      opt.textContent = c.label;
      group.append(opt);
    }
    sel.append(group);
  }
  if ([...sel.options].some((o) => o.value === value)) sel.value = value;
}

// 默认队友：局域网 Laya 在线就用 Laya（免费），否则配了密钥的 Jev，再否则规则 AI
function defaultKinds() {
  const laya = app.backends.find((b) => b.id === 'laya');
  const jev = app.backends.find((b) => b.id === 'jev');
  const mate = laya?.health?.ok ? 'remote:laya' : jev?.health?.ok ? 'remote:jev' : 'rule';
  return { B1: 'human', B2: mate, R1: 'rule', R2: 'rule' };
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
function save(cfg) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* 忽略 */ }
}

function renderSetup() {
  const saved = loadSaved();
  const kinds = { ...defaultKinds(), ...(saved?.kinds || {}) };
  for (const id of SLOT_IDS) fillSelect($(`#slot-${id}`), id, kinds[id]);
  if (saved?.settings) {
    $('#mode').value = saved.settings.mode;
    $('#interval').value = saved.settings.intervalMs;
    $('#callouts').checked = saved.settings.callouts;
    if (saved.settings.promptStyle) $('#promptStyle').value = saved.settings.promptStyle;
    if (saved.settings.promptVersion) $('#promptVersion').value = saved.settings.promptVersion;
    if (saved.settings.timing) $('#timing').value = saved.settings.timing;
  }
  if (saved?.rules) {
    $('#matchSeconds').value = saved.rules.matchSeconds;
    $('#baseHp').value = saved.rules.baseHp;
  }
  const status = $('#backendStatus');
  status.innerHTML = '';
  for (const b of app.backends) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.innerHTML = `<span class="dot ${b.health?.ok ? 'ok' : 'bad'}"></span>${b.label}：${b.health?.note || ''}${b.paid ? ` · $${b.pricePerMTok}/百万 token` : ' · 免费'}`;
    status.append(pill);
  }
  updateEstimate();
}

function readSetup() {
  const kinds = Object.fromEntries(SLOT_IDS.map((id) => [id, $(`#slot-${id}`).value]));
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const settings = {
    mode: $('#mode').value,
    intervalMs: clamp(Number($('#interval').value), 150, 5000, 400),
    callouts: $('#callouts').checked,
    promptStyle: $('#promptStyle').value,
    promptVersion: $('#promptVersion').value,
    timing: $('#timing').value,
  };
  const rules = {
    matchSeconds: clamp(Number($('#matchSeconds').value), 30, 900, 180),
    baseHp: clamp(Number($('#baseHp').value), 1, 50, 10),
  };
  return { kinds, settings, rules };
}

// 粗略估算付费后端的花费：每次请求约 1100 个输入 token（实测 900~1100）
function updateEstimate() {
  const { kinds, settings, rules } = readSetup();
  let perSecond = 0;
  for (const kind of Object.values(kinds)) {
    const b = app.backends.find((x) => `remote:${x.id}` === kind);
    if (!b || !b.paid) continue;
    const rps = settings.mode === 'direct' ? 1.6 : 1000 / settings.intervalMs;
    const style = settings.promptStyle === 'auto' ? b.promptStyle : settings.promptStyle;
    perSecond += rps * (style === 'compact' ? 700 : 1100) * b.pricePerMTok / 1e6;
  }
  const el = $('#costEstimate');
  if (!perSecond) { el.textContent = ''; return; }
  const perMatch = perSecond * rules.matchSeconds;
  el.textContent = `预计付费调用：约 $${(perSecond * 60).toFixed(4)}/分钟，整局最多约 $${perMatch.toFixed(4)}（实际按 Jev 返回的 token 数记账）`;
}

const PRESETS = {
  coopLaya: { B1: 'human', B2: 'remote:laya', R1: 'rule', R2: 'rule' },
  versusLaya: { B1: 'human', B2: 'rule', R1: 'remote:laya', R2: 'remote:laya' },
  layaVsRule: { B1: 'remote:laya', B2: 'remote:laya', R1: 'rule', R2: 'rule' },
  coop: { B1: 'human', B2: 'remote:jev', R1: 'rule', R2: 'rule' },
  versus: { B1: 'human', B2: 'rule', R1: 'remote:jev', R2: 'remote:jev' },
  jevVsLaya: { B1: 'remote:jev', B2: 'remote:jev', R1: 'remote:laya', R2: 'remote:laya' },
  jevVsRule: { B1: 'remote:jev', B2: 'remote:jev', R1: 'rule', R2: 'rule' },
};

for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    for (const id of SLOT_IDS) $(`#slot-${id}`).value = p[id];
    updateEstimate();
  });
}
for (const el of document.querySelectorAll('#setup select, #setup input')) el.addEventListener('change', updateEstimate);
$('#startBtn').addEventListener('click', () => {
  const cfg = readSetup();
  save(cfg);
  startMatch(cfg);
});

// ---------- 对局 ----------
function startMatch(cfg) {
  stopMatch();
  app.config = cfg;
  app.paused = false;
  app.waiting = false;
  app.log = [];
  keyboard.reset();
  const settings = { ...cfg.settings, backendStyles: Object.fromEntries(app.backends.map((b) => [b.id, b.promptStyle])) };
  app.match = new Match({ kinds: cfg.kinds, settings, rules: cfg.rules, decide: decideRemote, keyboard, seed: (Math.random() * 1e9) | 0 });
  app.match.on('decision', onDecision);
  app.match.on('callout', onCallout);
  app.renderer.resize(app.match.game);
  app.renderer.effects = [];
  app.renderer.bubbles.clear();
  $('#setup').hidden = true;
  $('#play').hidden = false;
  $('#banner').hidden = true;
  $('#logList').innerHTML = '';
  showWarning(startWarnings(cfg.kinds));
  $('#orders').hidden = cfg.kinds.B1 !== 'human';
  buildCards();
  updateOrderUi();
  let last = performance.now();
  let acc = 0;
  const frame = (now) => {
    const m = app.match;
    if (!m) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!app.paused && !m.game.over && !app.waiting) {
      acc += dt;
      while (acc >= STEP && !m.game.over) {
        if (m.settings.timing === 'realtime') { m.tick(STEP); acc -= STEP; continue; }
        // 公平模式：要等 AI 时世界停住，答案回来后这一帧才走完；等待的时间不累积，恢复后不快进
        const wait = m.tickFair(STEP);
        acc -= STEP;
        if (wait) {
          app.waiting = true;
          app.waitStart = now;
          acc = 0;
          wait.finally(() => { if (app.match === m) app.waiting = false; });
          break;
        }
      }
    }
    app.renderer.consumeEvents(m.game, now);
    app.renderer.draw(m, now, { paused: app.paused, thinkingMs: app.waiting ? now - app.waitStart : 0 });
    if (now - app.lastPanel > 200) { updatePanel(); app.lastPanel = now; }
    if (m.game.over && $('#banner').hidden) showResult();
    app.raf = requestAnimationFrame(frame);
  };
  app.raf = requestAnimationFrame(frame);
}

// 开局前检查：选了模型但没配好的坦克会原地不动，先提醒
function startWarnings(kinds) {
  const problems = [];
  for (const [id, kind] of Object.entries(kinds)) {
    if (!kind.startsWith('remote:')) continue;
    const b = app.backends.find((x) => `remote:${x.id}` === kind);
    if (b && !b.health.ok) problems.push(`${id} 用的 ${b.label}：${b.health.note}`);
    if (b?.paid && app.budgetExhausted) problems.push(`${id} 用的 ${b.label}：本浏览器花费已到上限`);
  }
  return problems.length ? `这些坦克可能不会行动——${problems.join('；')}（在“AI 连接设置”里配置）` : '';
}

function stopMatch() {
  cancelAnimationFrame(app.raf);
  if (app.match) app.match.dispose();
  app.match = null;
}

function restart() {
  if (app.config) startMatch(app.config);
}

async function backToSetup() {
  stopMatch();
  $('#play').hidden = true;
  $('#setup').hidden = false;
  await refreshBackends();
  renderSetup();
}

function togglePause() {
  if (!app.match || app.match.game.over) return;
  app.paused = !app.paused;
  $('#pauseBtn').textContent = app.paused ? '继续 (P)' : '暂停 (P)';
}

function issueOrder(order) {
  const m = app.match;
  if (!m || m.kindOf('B1') !== 'human') return;
  m.issueOrder('blue', order);
  updateOrderUi();
  addLog({ html: `<span class="blue-text">你</span> 命令：${ORDER_ZH[order]}`, cls: 'callout', time: m.game.time });
}

function updateOrderUi() {
  const o = app.match?.orders.blue?.order || 'free';
  $('#currentOrder').textContent = `当前：${ORDER_ZH[o]}`;
  for (const b of document.querySelectorAll('[data-order]')) b.classList.toggle('active', b.dataset.order === o);
}

for (const b of document.querySelectorAll('[data-order]')) b.addEventListener('click', () => issueOrder(b.dataset.order));
$('#pauseBtn').addEventListener('click', togglePause);
$('#restartBtn').addEventListener('click', restart);
$('#backBtn').addEventListener('click', backToSetup);
$('#logLocal').addEventListener('change', renderLog);

// ---------- 右侧面板 ----------
function buildCards() {
  const wrap = $('#tankCards');
  wrap.innerHTML = '';
  for (const t of app.match.game.tanks) {
    const card = document.createElement('div');
    card.className = `tank-card ${t.team}`;
    card.id = `card-${t.id}`;
    card.innerHTML = `
      <div class="head"><b>${t.id}</b><select></select></div>
      <div class="tactic">当前：<b data-f="tactic">—</b> <span data-f="prob" class="muted"></span></div>
      <div class="meta">
        <span data-f="hp"></span><span data-f="kd"></span><span data-f="dec"></span><span data-f="lat"></span><span data-f="conf"></span>
      </div>
      <div class="err" data-f="err"></div>`;
    const sel = card.querySelector('select');
    fillSelect(sel, t.id, app.match.kindOf(t.id));
    sel.addEventListener('change', () => {
      app.match.setController(t.id, sel.value);
      app.config.kinds[t.id] = sel.value;
      $('#orders').hidden = app.match.kindOf('B1') !== 'human';
      addLog({ html: `${teamSpan(t)} 切换为 ${kindLabel(sel.value, app.backends)}`, cls: 'callout', time: app.match.game.time });
      sel.blur();
    });
    wrap.append(card);
  }
}

function teamSpan(t) {
  return `<span class="${t.team}-text">${t.id}</span>`;
}

function updatePanel() {
  const m = app.match;
  if (!m) return;
  const g = m.game;
  const left = Math.max(0, g.rules.matchSeconds - g.time);
  $('#hudTime').textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  $('#hudBlue').textContent = `蓝 ${g.teamKills('blue')} 杀`;
  $('#hudRed').textContent = `红 ${g.teamKills('red')} 杀`;
  $('#hudBases').textContent = `基地血量　蓝 ${g.bases.blue.hp}/${g.rules.baseHp}　红 ${g.bases.red.hp}/${g.rules.baseHp}`;
  const fz = m.freeze;
  $('#hudTiming').textContent = m.settings.timing === 'realtime'
    ? '实时模式：不等 AI，远程 AI 按晚到的局面决策'
    : `公平模式：AI 思考时暂停，共等 ${(fz.totalMs / 1000).toFixed(1)} 秒${fz.count ? `，平均每次 ${Math.round(fz.totalMs / fz.count)} 毫秒` : ''}`;
  for (const t of g.tanks) {
    const card = $(`#card-${t.id}`);
    if (!card) continue;
    const c = m.controllers.get(t.id);
    const f = (name) => card.querySelector(`[data-f="${name}"]`);
    card.classList.toggle('dead', !t.alive);
    const isAi = c.kind !== 'human';
    const current = m.settings.mode === 'direct' ? c.exec?.direct?.action : c.tactic;
    f('tactic').textContent = isAi ? tacticLabel(c.kind === 'idle' ? null : current) : '人类操控';
    f('prob').textContent = isAi && c.lastProb != null && c.kind.startsWith('remote:') ? `${Math.round(c.lastProb * 100)}%` : '';
    f('hp').textContent = t.alive ? `血 ${t.hp}/${g.rules.tankHp}` : t.lives > 0 ? `复活 ${Math.max(0, t.respawnAt - g.time).toFixed(1)}s` : '阵亡';
    f('kd').textContent = `命 ${t.lives} · 杀 ${t.kills}`;
    const s = c.stats;
    f('dec').textContent = isAi ? `决策 ${s.decisions}${s.late ? ` · 超时作废 ${s.late}` : ''}` : '';
    const lat = avgLatency(s);
    f('lat').textContent = lat != null ? `延迟 ${lat}ms${c.inFlight ? ' …' : ''}` : '';
    f('conf').textContent = s.confN && c.kind.startsWith('remote:') ? `置信 ${(s.confSum / s.confN).toFixed(2)}` : '';
    f('err').textContent = s.errors ? `错误 ${s.errors} 次：${s.lastError}` : s.warnings ? `后端提示 ${s.warnings} 次：${s.lastWarning}` : '';
  }
}

// ---------- 决策日志 ----------
function onDecision(e) {
  const t = app.match.game.getTank(e.agent);
  const kind = e.kind;
  const who = `${teamSpan(t)}·${shortLabel(kind)}`;
  if (e.error) {
    addLog({ html: `${who} ✗ ${escapeHtml(e.error)}`, cls: 'err', time: e.time, remote: true });
    return;
  }
  const prob = e.prob != null && kind.startsWith('remote:') ? ` ${Math.round(e.prob * 100)}%` : '';
  const lat = e.latency ? ` ${e.latency}ms` : '';
  const text = `${who} ${tacticLabel(e.choice)}${prob}${lat}`;
  // 同一辆车连续做同一个选择时合并成一行
  const prev = app.log[0];
  if (prev && prev.agent === e.agent && prev.choice === e.choice && !prev.cls) {
    prev.count++;
    prev.html = `${text} ×${prev.count}`;
    prev.time = e.time;
    renderLog();
    return;
  }
  addLog({ html: text, time: e.time, agent: e.agent, choice: e.choice, count: 1, remote: kind.startsWith('remote:') });
}

function onCallout(e) {
  const t = app.match.game.getTank(e.agent);
  app.renderer.bubble(e.agent, e.callout, performance.now());
  addLog({ html: `${teamSpan(t)} 喊话：${CALLOUT_ZH[e.callout] || e.callout}`, cls: 'callout', time: e.time, remote: true });
}

function addLog(entry) {
  app.log.unshift({ remote: true, ...entry });
  if (app.log.length > 120) app.log.pop();
  renderLog();
}

function renderLog() {
  const showLocal = $('#logLocal').checked;
  const list = $('#logList');
  list.innerHTML = app.log
    .filter((e) => showLocal || e.remote)
    .slice(0, 60)
    .map((e) => `<li class="${e.cls || ''}">[${e.time.toFixed(1)}s] ${e.html}</li>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------- 结算 ----------
function showResult() {
  const m = app.match;
  const g = m.game;
  const title = g.winner === 'draw' ? '平局' : `${TEAM_ZH[g.winner]}胜利`;
  const color = g.winner === 'blue' ? 'var(--blue)' : g.winner === 'red' ? 'var(--red)' : 'var(--text)';
  const rows = g.tanks.map((t) => {
    const c = m.controllers.get(t.id);
    const lat = avgLatency(c.stats);
    const acc = t.shots ? `${Math.round((t.hits / t.shots) * 100)}%` : '—';
    return `<tr><td class="${t.team}-text">${t.id}</td><td>${kindLabel(c.kind, app.backends)}</td><td>${t.kills}</td><td>${t.deaths}</td><td>${t.baseDamage}</td><td>${acc}</td><td>${c.stats.decisions}</td><td>${lat != null ? lat + 'ms' : '—'}</td><td>${c.stats.errors}</td></tr>`;
  }).join('');
  const banner = $('#banner');
  banner.innerHTML = `
    <h2 style="color:${color}">${title}</h2>
    <div class="muted">${REASON_ZH[g.reason] || ''} · 用时 ${g.time.toFixed(1)} 秒 · 基地 蓝 ${g.bases.blue.hp} / 红 ${g.bases.red.hp}</div>
    <table class="stats"><tr><th>坦克</th><th>控制者</th><th>击杀</th><th>阵亡</th><th>拆家</th><th>命中率</th><th>决策</th><th>平均延迟</th><th>错误</th></tr>${rows}</table>
    <div class="controls"><button id="againBtn" class="primary">再来一局 (R)</button><button id="setupBtn">返回设置 (Esc)</button></div>`;
  banner.hidden = false;
  $('#againBtn').addEventListener('click', restart);
  $('#setupBtn').addEventListener('click', backToSetup);
  updateBudgetBadge();
}

// ---------- 调试入口 ----------
// 页面在后台时 requestAnimationFrame 不会触发（这也是设计：后台自动停，不空耗调用）。
// 自动化测试可以用 __tankDebug.advance(秒) 手动推进。
window.__tankDebug = {
  app,
  async advance(seconds) {
    const m = app.match;
    if (!m) return null;
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n && !m.game.over && !app.paused; i++) {
      if (m.settings.timing === 'realtime') m.tick(STEP);
      else { const wait = m.tickFair(STEP); if (wait) await wait; }
    }
    const now = performance.now();
    app.renderer.consumeEvents(m.game, now);
    app.renderer.draw(m, now, { paused: app.paused });
    updatePanel();
    if (m.game.over && $('#banner').hidden) showResult();
    return { time: m.game.time, over: m.game.over, winner: m.game.winner };
  },
};

// ---------- 启动 ----------
// 页面由本项目的 npm start 提供时，同源的 /api/health 能通，中转默认就用同源；GitHub Pages 上则默认 localhost:3000
app.sameOriginRelay = (await probeRelay('')).ok;
app.conn = loadSettings(app.sameOriginRelay);
fillConnForm();
await refreshBackends();
renderSetup();
