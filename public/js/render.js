import { TILE_PX, T } from './constants.js';
import { shortLabel } from './agents.js';
import { CALLOUT_ZH } from './labels.js';

const COLORS = {
  floor: '#10151f',
  grid: 'rgba(255,255,255,0.035)',
  brick: '#a4502b',
  brickDark: '#6e3119',
  steel: '#8a95a3',
  steelLight: '#c3ccd6',
  water: '#1b4f9c',
  blue: '#3b82f6',
  blueDark: '#1e3a8a',
  red: '#ef4444',
  redDark: '#7f1d1d',
  bullet: '#fde047',
};

const ANGLE = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.effects = [];
    this.bubbles = new Map(); // tankId -> { text, until }
  }

  resize(game) {
    this.canvas.width = game.w * TILE_PX;
    this.canvas.height = game.h * TILE_PX;
  }

  bubble(tankId, text, now) {
    this.bubbles.set(tankId, { text, until: now + 2600 });
  }

  consumeEvents(game, now) {
    for (const e of game.events) {
      const x = (e.x + 0.5) * TILE_PX;
      const y = (e.y + 0.5) * TILE_PX;
      if (e.type === 'explode') this.effects.push({ kind: 'boom', x, y, t0: now, life: 650, r: 30 });
      else if (e.type === 'hit') this.effects.push({ kind: 'ring', x, y, t0: now, life: 250, r: 20, color: '#fca5a5' });
      else if (e.type === 'brick') this.effects.push({ kind: 'debris', x, y, t0: now, life: 350 });
      else if (e.type === 'spark' || e.type === 'shield') this.effects.push({ kind: 'ring', x, y, t0: now, life: 160, r: 8, color: '#fef08a' });
      else if (e.type === 'baseHit') this.effects.push({ kind: 'ring', x, y, t0: now, life: 350, r: 24, color: '#fdba74' });
      else if (e.type === 'baseDestroyed') this.effects.push({ kind: 'boom', x, y, t0: now, life: 1200, r: 60 });
      else if (e.type === 'spawn') this.effects.push({ kind: 'ring', x, y, t0: now, life: 400, r: 26, color: '#a7f3d0' });
    }
    game.events.length = 0;
  }

  draw(match, now, overlay = {}) {
    const { game } = match;
    const ctx = this.ctx;
    const P = TILE_PX;
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x <= game.w; x++) { ctx.beginPath(); ctx.moveTo(x * P + 0.5, 0); ctx.lineTo(x * P + 0.5, game.h * P); ctx.stroke(); }
    for (let y = 0; y <= game.h; y++) { ctx.beginPath(); ctx.moveTo(0, y * P + 0.5); ctx.lineTo(game.w * P, y * P + 0.5); ctx.stroke(); }

    for (let y = 0; y < game.h; y++) {
      for (let x = 0; x < game.w; x++) {
        const tile = game.tileAt(x, y);
        if (tile === T.BRICK) this.drawBrick(x * P, y * P);
        else if (tile === T.STEEL) this.drawSteel(x * P, y * P);
        else if (tile === T.WATER) this.drawWater(x * P, y * P, now);
      }
    }
    for (const team of ['blue', 'red']) this.drawBase(game.bases[team], game.rules.baseHp);

    for (const t of game.tanks) {
      if (t.alive) this.drawTank(t, match, now, game);
      else if (t.lives > 0) this.drawRespawnTimer(t, game);
    }

    for (const b of game.bullets) {
      const x = (b.x + 0.5) * P;
      const y = (b.y + 0.5) * P;
      ctx.fillStyle = 'rgba(253,224,71,0.25)';
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.bullet;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }

    this.drawEffects(now);
    this.drawBubbles(game, now);

    if (overlay.paused) this.drawCenterText('已暂停（按 P 继续）');
  }

  drawBrick(px, py) {
    const ctx = this.ctx;
    const P = TILE_PX;
    ctx.fillStyle = COLORS.brickDark;
    ctx.fillRect(px, py, P, P);
    ctx.fillStyle = COLORS.brick;
    const h = P / 4;
    for (let r = 0; r < 4; r++) {
      const off = r % 2 ? P / 4 : 0;
      for (let c = -1; c < 2; c++) {
        const bx = px + off + c * (P / 2) + 1;
        const x0 = Math.max(px, bx);
        const x1 = Math.min(px + P, bx + P / 2 - 2);
        if (x1 > x0) ctx.fillRect(x0, py + r * h + 1, x1 - x0, h - 2);
      }
    }
  }

  drawSteel(px, py) {
    const ctx = this.ctx;
    const P = TILE_PX;
    ctx.fillStyle = COLORS.steel;
    ctx.fillRect(px + 1, py + 1, P - 2, P - 2);
    ctx.fillStyle = COLORS.steelLight;
    ctx.fillRect(px + 8, py + 8, P - 16, P - 16);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeRect(px + 1.5, py + 1.5, P - 3, P - 3);
  }

  drawWater(px, py, now) {
    const ctx = this.ctx;
    const P = TILE_PX;
    ctx.fillStyle = COLORS.water;
    ctx.fillRect(px, py, P, P);
    ctx.strokeStyle = 'rgba(147,197,253,0.45)';
    ctx.lineWidth = 2;
    const phase = (now / 400) % (Math.PI * 2);
    for (let i = 0; i < 3; i++) {
      const yy = py + 8 + i * 12;
      ctx.beginPath();
      for (let xx = 0; xx <= P; xx += 4) {
        const y = yy + Math.sin(phase + xx / 6 + i) * 2;
        if (xx === 0) ctx.moveTo(px + xx, y); else ctx.lineTo(px + xx, y);
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  drawBase(base, maxHp) {
    const ctx = this.ctx;
    const P = TILE_PX;
    const cx = (base.x + 0.5) * P;
    const cy = (base.y + 0.5) * P;
    const color = base.team === 'blue' ? COLORS.blue : COLORS.red;
    if (base.hp <= 0) {
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(base.x * P + 4, base.y * P + 4, P - 8, P - 8);
      ctx.strokeStyle = '#a1a1aa';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10);
      ctx.moveTo(cx + 10, cy - 10); ctx.lineTo(cx - 10, cy + 10);
      ctx.stroke();
      ctx.lineWidth = 1;
      return;
    }
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(base.x * P + 2, base.y * P + 2, P - 4, P - 4);
    ctx.fillStyle = color;
    this.star(cx, cy - 2, 13, 6);
    // 血条
    const w = P - 8;
    ctx.fillStyle = '#111827';
    ctx.fillRect(base.x * P + 4, base.y * P + P - 7, w, 4);
    ctx.fillStyle = base.hp / maxHp > 0.4 ? '#22c55e' : '#f97316';
    ctx.fillRect(base.x * P + 4, base.y * P + P - 7, (w * base.hp) / maxHp, 4);
  }

  star(cx, cy, outer, inner) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? inner : outer;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  drawTank(t, match, now, game) {
    const ctx = this.ctx;
    const P = TILE_PX;
    const cx = (t.fx + 0.5) * P;
    const cy = (t.fy + 0.5) * P;
    const main = t.team === 'blue' ? COLORS.blue : COLORS.red;
    const dark = t.team === 'blue' ? COLORS.blueDark : COLORS.redDark;
    const kind = match.kindOf(t.id) || '';
    const isHuman = kind === 'human';

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ANGLE[t.dir]);
    ctx.fillStyle = dark;
    ctx.fillRect(-16, -16, 8, 32);
    ctx.fillRect(8, -16, 8, 32);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const tread = ((t.fx + t.fy) * 16) % 6;
    for (let k = -16 + tread; k < 16; k += 6) {
      ctx.fillRect(-16, k, 8, 2);
      ctx.fillRect(8, k, 8, 2);
    }
    ctx.fillStyle = main;
    ctx.fillRect(-9, -12, 18, 26);
    ctx.fillStyle = isHuman ? '#fde68a' : '#e5e7eb';
    ctx.beginPath(); ctx.arc(0, 2, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d1d5db';
    ctx.fillRect(-2.5, -21, 5, 17);
    ctx.restore();

    if (isHuman) {
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 19, cy - 19, 38, 38);
      ctx.lineWidth = 1;
    }
    if (game.time < t.shieldUntil) {
      ctx.strokeStyle = 'rgba(167,243,208,0.8)';
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -now / 40;
      ctx.beginPath(); ctx.arc(cx, cy, 21, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 血量点
    for (let i = 0; i < game.rules.tankHp; i++) {
      ctx.fillStyle = i < t.hp ? '#22c55e' : '#374151';
      ctx.fillRect(cx - 12 + i * 9, cy + 20, 7, 3);
    }
    // 标签
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const label = `${t.id}·${shortLabel(kind)}`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const w = ctx.measureText(label).width + 6;
    ctx.fillRect(cx - w / 2, cy - 33, w, 13);
    ctx.fillStyle = t.team === 'blue' ? '#bfdbfe' : '#fecaca';
    ctx.fillText(label, cx, cy - 23);
  }

  drawRespawnTimer(t, game) {
    const ctx = this.ctx;
    const P = TILE_PX;
    const left = Math.max(0, t.respawnAt - game.time);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${t.id} ${left.toFixed(1)}s`, (t.spawn.x + 0.5) * P, (t.spawn.y + 0.5) * P + 4);
  }

  drawEffects(now) {
    const ctx = this.ctx;
    this.effects = this.effects.filter((e) => now - e.t0 < e.life);
    for (const e of this.effects) {
      const k = (now - e.t0) / e.life;
      if (e.kind === 'boom') {
        ctx.fillStyle = `rgba(251,146,60,${0.7 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + k), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(254,240,138,${0.8 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.5 * (0.4 + k), 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'ring') {
        ctx.strokeStyle = e.color;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.5 + k * 0.7), 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      } else if (e.kind === 'debris') {
        ctx.fillStyle = `rgba(164,80,43,${1 - k})`;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.fillRect(e.x + Math.cos(a) * 18 * k - 3, e.y + Math.sin(a) * 18 * k - 3, 6, 6);
        }
      }
    }
  }

  drawBubbles(game, now) {
    const ctx = this.ctx;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const [id, b] of this.bubbles) {
      if (now > b.until) { this.bubbles.delete(id); continue; }
      const t = game.getTank(id);
      if (!t || !t.alive) continue;
      const text = CALLOUT_ZH[b.text] || b.text;
      const cx = (t.fx + 0.5) * TILE_PX;
      const cy = (t.fy + 0.5) * TILE_PX - 46;
      const w = ctx.measureText(text).width + 14;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(ctx, cx - w / 2, cy - 11, w, 20, 6);
      ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx - 5, cy + 9); ctx.lineTo(cx + 5, cy + 9); ctx.lineTo(cx, cy + 15); ctx.fill();
      ctx.fillStyle = '#111827';
      ctx.fillText(text, cx, cy + 3);
    }
  }

  drawCenterText(text) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, this.canvas.height / 2 - 30, this.canvas.width, 60);
    ctx.fillStyle = '#f9fafb';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2 + 8);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
