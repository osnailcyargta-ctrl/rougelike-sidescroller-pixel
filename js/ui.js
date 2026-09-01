// Immediate-mode UI drawn straight onto the 480x270 pixel canvas so the
// post-processing chain (and any user shader) affects the interface too.
import { clamp, lerp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { drawText, drawTextShadow, textWidth } from './font.js';
import { pxRect, glowDot } from './gfx.js';
import { VIEW_W, VIEW_H, BOW, PLAYER } from './config.js';
import { ITEMS, RARITY, INV_COLS, INV_ROWS, INV_SIZE, HOTBAR_SIZE, drawItemIcon } from './items.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';

export const UI = {
  hovered: null,
  drag: null,          // { from, item }
  tooltip: null,
  t: 0,
};

export function uiBeginFrame(dt) {
  UI.t += dt;
  UI.hovered = null;
  UI.tooltip = null;
}

function inside(x, y, w, h) {
  const m = Input.mouse;
  return m.x >= x && m.x < x + w && m.y >= y && m.y < y + h;
}

export function panel(ctx, x, y, w, h, opts = {}) {
  const a = opts.alpha ?? 0.92;
  ctx.fillStyle = rgba(Theme.uiPanel, a);
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.strokeStyle = rgba(opts.border ?? Theme.uiDim, 0.9);
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  // corner ticks
  const c = opts.accent ?? Theme.uiAccent;
  pxRect(ctx, x, y, 3, 1, c); pxRect(ctx, x, y, 1, 3, c);
  pxRect(ctx, x + w - 3, y, 3, 1, c); pxRect(ctx, x + w - 1, y, 1, 3, c);
  pxRect(ctx, x, y + h - 1, 3, 1, c); pxRect(ctx, x, y + h - 3, 1, 3, c);
  pxRect(ctx, x + w - 3, y + h - 1, 3, 1, c); pxRect(ctx, x + w - 1, y + h - 3, 1, 3, c);
}

export function button(ctx, id, x, y, w, h, label, opts = {}) {
  const hot = inside(x, y, w, h) && !opts.disabled;
  if (hot) UI.hovered = id;
  const sel = opts.selected;
  const bg = opts.disabled ? rgba('#000000', 0.4)
    : hot ? rgba(Theme.uiAccent, 0.22)
    : sel ? rgba(Theme.platformGlow, 0.16) : rgba('#000000', 0.45);
  ctx.fillStyle = bg;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.strokeStyle = opts.disabled ? rgba(Theme.uiDim, 0.4)
    : hot ? Theme.uiAccent : sel ? Theme.platformGlow : rgba(Theme.uiDim, 0.8);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  const col = opts.disabled ? Theme.uiDim : hot ? Theme.uiAccent : Theme.ui;
  drawText(ctx, label, x + w / 2, y + (h - 7) / 2, col, opts.scale ?? 1, 'center');
  if (hot) {
    const p = Math.round(Math.sin(UI.t * 8) * 1);
    drawText(ctx, '>', x + 4 + p, y + (h - 7) / 2, Theme.uiAccent, 1);
    drawText(ctx, '<', x + w - 9 - p, y + (h - 7) / 2, Theme.uiAccent, 1);
  }
  const clicked = hot && Input.mouseDown.left;
  if (clicked) Sfx.ui();
  return clicked;
}

export function slider(ctx, id, x, y, w, value, opts = {}) {
  const h = 7;
  const hot = inside(x - 2, y - 4, w + 4, h + 8);
  if (hot) UI.hovered = id;
  pxRect(ctx, x, y + 3, w, 1, rgba(Theme.uiDim, 0.7));
  const kx = Math.round(x + w * clamp(value, 0, 1));
  pxRect(ctx, x, y + 3, kx - x, 1, Theme.uiAccent);
  pxRect(ctx, kx - 1, y, 3, 7, hot ? Theme.uiAccent : Theme.ui);
  if (hot && Input.mouse.left) {
    return clamp((Input.mouse.x - x) / w, 0, 1);
  }
  return value;
}

// --- HUD -----------------------------------------------------------------

export function drawHUD(ctx, game) {
  const p = game.player;
  if (!p) return;
  const t = UI.t;

  // health
  const bw = 96;
  panel(ctx, 6, 6, bw + 10, 22, { alpha: 0.55 });
  drawText(ctx, p.classId === 'melee' ? 'BLADE' : 'RANGER', 11, 9, Theme.uiDim, 1);
  const hpFrac = clamp(p.hp / p.maxHp, 0, 1);
  pxRect(ctx, 11, 18, bw, 5, Theme.hpBack);
  const grad = ctx.createLinearGradient(11, 0, 11 + bw, 0);
  grad.addColorStop(0, Theme.hp);
  grad.addColorStop(1, '#ff9ab0');
  ctx.fillStyle = grad;
  ctx.fillRect(11, 18, Math.round(bw * hpFrac), 5);
  if (hpFrac < 0.3) {
    ctx.fillStyle = rgba('#ffffff', 0.25 + 0.25 * Math.sin(t * 9));
    ctx.fillRect(11, 18, Math.round(bw * hpFrac), 5);
  }
  ctx.strokeStyle = rgba(Theme.uiDim, 0.8);
  ctx.strokeRect(10.5, 17.5, bw + 1, 6);
  drawTextShadow(ctx, `${Math.ceil(p.hp)}/${p.maxHp}`, 11 + bw, 9, Theme.ui, 1, 'right');
  if (p.shieldMax > 0) {
    const sw = Math.round(bw * clamp(p.shield / p.shieldMax, 0, 1));
    pxRect(ctx, 11, 24, bw, 2, rgba('#0b2438', 0.9));
    pxRect(ctx, 11, 24, sw, 2, '#8fd8ff');
    if (sw > 0) glowDot(ctx, 11 + sw, 25, 6, '#8fd8ff', 0.35);
  }

  // run status: where you are, which wave, how many are left
  const label = game.roomCleared ? 'CLEARED' : `WAVE ${game.waveIndex}/${game.wavesInRoom()}`;
  drawTextShadow(ctx, `ROOM ${game.roomIndex}`, VIEW_W - 7, 8, Theme.ui, 1, 'right');
  drawTextShadow(ctx, label, VIEW_W - 7, 18, game.roomCleared ? Theme.uiAccent : Theme.uiDim, 1, 'right');
  if (!game.roomCleared) {
    const alive = game.enemies.filter((e) => !e.dead).length + game.pendingSpawns.length;
    drawTextShadow(ctx, `LEFT ${alive}`, VIEW_W - 7, 28, Theme.uiDim, 1, 'right');
  }

  drawHotbar(ctx, game);
  drawPerkStrip(ctx, game);
  drawBossBar(ctx, game);
}

function drawBossBar(ctx, game) {
  const boss = game.boss;
  if (!boss || boss.dead) return;
  const w = 220;
  const x = Math.round((VIEW_W - w) / 2);
  const y = 16;
  const k = clamp(boss.hp / boss.maxHp, 0, 1);
  const phaseK = clamp(boss.phase2At / boss.maxHp, 0, 1);
  drawTextShadow(ctx, boss.name, VIEW_W / 2, y - 10, Theme.uiAccent, 1, 'center');
  pxRect(ctx, x - 1, y - 1, w + 2, 8, rgba('#000000', 0.7));
  pxRect(ctx, x, y, w, 6, Theme.hpBack);
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, boss.phase === 2 ? '#ff8a3c' : Theme.enemyBrute);
  g.addColorStop(1, boss.phase === 2 ? Theme.hp : '#b18cff');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, Math.round(w * k), 6);
  // phase threshold tick
  pxRect(ctx, x + Math.round(w * phaseK), y - 2, 1, 10, boss.phase === 2 ? rgba(Theme.uiDim, 0.6) : Theme.uiAccent);
  ctx.strokeStyle = rgba(Theme.uiDim, 0.9);
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, 7);
  drawTextShadow(ctx, `PHASE ${boss.phase}`, x + w + 6, y, Theme.uiDim, 1);
}

function slotBox(ctx, x, y, s, selected, item, t) {
  ctx.fillStyle = rgba('#000000', 0.55);
  ctx.fillRect(x, y, s, s);
  ctx.strokeStyle = selected ? Theme.uiAccent : rgba(Theme.uiDim, 0.7);
  ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  if (selected) {
    glowDot(ctx, x + s / 2, y + s / 2, s * 0.9, Theme.uiAccent, 0.18);
    pxRect(ctx, x, y - 2, s, 1, Theme.uiAccent);
  }
  if (item) {
    const def = ITEMS[item.id];
    pxRect(ctx, x + 1, y + 1, s - 2, 1, rgba(RARITY[def.rarity].color, 0.6));
    drawItemIcon(ctx, item.id, x + (s - 12) / 2, y + (s - 12) / 2, 12, t);
    if (item.count > 1) drawTextShadow(ctx, item.count, x + s - 2, y + s - 8, Theme.ui, 1, 'right');
  }
}

function drawHotbar(ctx, game) {
  const p = game.player;
  const s = 20, gap = 3;
  const total = HOTBAR_SIZE * s + (HOTBAR_SIZE - 1) * gap;
  const x0 = Math.round((VIEW_W - total) / 2);
  const y = VIEW_H - 26;
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    const x = x0 + i * (s + gap);
    slotBox(ctx, x, y, s, i === p.inventory.selected, p.inventory.slots[i], UI.t);
    drawText(ctx, i + 1, x + 2, y + 2, rgba(Theme.uiDim, 0.9), 1);
    if (inside(x, y, s, s) && p.inventory.slots[i]) UI.tooltip = { id: p.inventory.slots[i].id, x: x + s / 2, y: y - 4 };
  }
  // ammo / reload for the bow
  const w = p.inventory.selectedWeapon();
  if (w && w.weapon === 'bow') {
    const ax = x0 + total + 8;
    if (p.reloadT > 0) {
      drawTextShadow(ctx, 'RELOAD', ax, y + 2, Theme.uiAccent, 1);
      const k = 1 - p.reloadT / BOW.reload;
      pxRect(ctx, ax, y + 12, 40, 3, rgba('#000000', 0.7));
      pxRect(ctx, ax, y + 12, Math.round(40 * k), 3, Theme.uiAccent);
    } else {
      for (let i = 0; i < BOW.ammo; i++) {
        pxRect(ctx, ax + (i % 5) * 5, y + 3 + Math.floor(i / 5) * 7, 2, 5, i < p.ammo ? Theme.steel : rgba(Theme.uiDim, 0.35));
      }
    }
  }
}

function drawPerkStrip(ctx, game) {
  const inv = game.player.inventory;
  const perks = [];
  for (const id of ['lifecrystal', 'fireyblade', 'lightningarrow', 'wetslime']) {
    const n = inv.countOf(id);
    if (n > 0) perks.push([id, n]);
  }
  if (!perks.length) return;
  const y = 34;
  for (let i = 0; i < perks.length; i++) {
    const x = 8, yy = y + i * 15;
    ctx.fillStyle = rgba('#000000', 0.35);
    ctx.fillRect(x, yy, 13, 13);
    drawItemIcon(ctx, perks[i][0], x + 0.5, yy + 0.5, 12, UI.t);
    drawTextShadow(ctx, `x${perks[i][1]}`, x + 15, yy + 3, Theme.uiDim, 1);
    if (inside(x, yy, 13, 13)) UI.tooltip = { id: perks[i][0], x: x + 30, y: yy + 14, below: true };
  }
}

// --- inventory -----------------------------------------------------------

export function drawInventory(ctx, game) {
  const inv = game.player.inventory;
  ctx.fillStyle = rgba('#000000', 0.6);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const s = 22, gap = 4;
  const gw = INV_COLS * s + (INV_COLS - 1) * gap;
  const gh = INV_ROWS * s + (INV_ROWS - 1) * gap;
  const px = Math.round((VIEW_W - gw) / 2) - 12;
  const py = 54;
  panel(ctx, px, py - 22, gw + 24, gh + 32);
  drawTextShadow(ctx, 'INVENTORY', px + (gw + 24) / 2, py - 16, Theme.uiAccent, 1, 'center');

  let hoverIdx = -1;
  for (let i = 0; i < INV_SIZE; i++) {
    const cx = i % INV_COLS, cy = Math.floor(i / INV_COLS);
    const x = px + 12 + cx * (s + gap);
    const y = py + cy * (s + gap);
    const isHot = i < HOTBAR_SIZE;
    const item = UI.drag && UI.drag.from === i ? null : inv.slots[i];
    slotBox(ctx, x, y, s, i === inv.selected, item, UI.t);
    if (isHot) pxRect(ctx, x, y + s, s, 1, rgba(Theme.platformGlow, 0.7));
    if (inside(x, y, s, s)) {
      hoverIdx = i;
      ctx.strokeStyle = Theme.uiAccent;
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      if (item) UI.tooltip = { id: item.id, x: x + s / 2, y: y - 4 };
    }
  }

  // drag & drop
  if (Input.mouseDown.left && hoverIdx >= 0 && inv.slots[hoverIdx] && !UI.drag) {
    UI.drag = { from: hoverIdx };
    Sfx.ui();
  }
  if (UI.drag) {
    const item = inv.slots[UI.drag.from];
    if (item) {
      drawItemIcon(ctx, item.id, Input.mouse.x - 6, Input.mouse.y - 6, 12, UI.t);
      if (item.count > 1) drawTextShadow(ctx, item.count, Input.mouse.x + 8, Input.mouse.y + 2, Theme.ui, 1);
    }
    if (Input.mouseUp.left) {
      if (hoverIdx >= 0) inv.swap(UI.drag.from, hoverIdx);
      UI.drag = null;
      game.player.recomputeStats();
    }
  }
  if (UI.tooltip) drawTooltip(ctx, UI.tooltip);
}

export function drawTooltip(ctx, tip) {
  const def = ITEMS[tip.id];
  if (!def) return;
  const lines = def.desc;
  const w = Math.max(textWidth(def.name, 1), ...lines.map((l) => textWidth(l, 1))) + 12;
  const h = 24 + lines.length * 9;
  const x = clamp(tip.x - w / 2, 3, VIEW_W - w - 3);
  const y = clamp(tip.below ? tip.y : tip.y - h, 3, VIEW_H - h - 3);
  panel(ctx, x, y, w, h, { alpha: 0.95, accent: RARITY[def.rarity].color });
  drawText(ctx, def.name, x + 6, y + 5, RARITY[def.rarity].color, 1);
  drawText(ctx, RARITY[def.rarity].name, x + 6, y + 14, Theme.uiDim, 1);
  for (let i = 0; i < lines.length; i++) {
    drawText(ctx, lines[i], x + 6, y + 25 + i * 9, Theme.ui, 1);
  }
}
