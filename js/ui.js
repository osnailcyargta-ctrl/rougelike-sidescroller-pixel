// Immediate-mode UI drawn straight onto the 480x270 pixel canvas so the
// post-processing chain (and any user shader) affects the interface too.
import { clamp, lerp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { drawText, drawTextShadow, drawTextFit, textWidth, fitScale } from './font.js';
import { pxRect, glowDot, Camera } from './gfx.js';
import { VIEW_W, VIEW_H, BOW, SHARDGUN, STINGER_GUN, PLAYER, ENEMY_TYPES, BOSS_TYPES,
  FINAL_ROOM, BOSS_ROOM_INTERVAL } from './config.js';
import { ENEMY_TINT } from './entities.js';
import { Options } from './settings.js';
import { drawBossPreview, bossIdForRoom } from './boss.js';
import { SOUL_TINT } from './entities.js';
import { ITEMS, RARITY, INV_COLS, INV_ROWS, INV_SIZE, HOTBAR_SIZE, ARMOR_SLOTS, Inventory, drawItemIcon } from './items.js';
import { Input, Binds, BIND_ORDER, BIND_LABELS, bindLabel } from './input.js';
import { hotbarSlotRect, hudInset, forgeLayout, forgeRowRect, forgeTrackRect, closeRect, codexLayout, codexRowRect } from './layout.js';
import { Sfx } from './audio.js';

export const UI = {
  hovered: null,
  focus: null,             // id of the focused text field, if any
  rebinding: null,         // action currently waiting for a key
  drag: null,          // { from, item }
  tooltip: null,
  t: 0,
  dt: 0,
  dbgScroll: { items: 0, mobs: 0 },
  dbgRoom: 1,              // the room the debug menu's teleport is pointed at
  shaderScroll: 0,         // first visible row of the saved-shader list
  shaderDrag: null,        // an in-progress drag of that list
  pressedId: null,         // which button the pointer went down on
  fps: 0,
  tab: 'indicator',        // which settings tab is showing
};

export function uiBeginFrame(dt) {
  // a smoothed frame rate, so the readout does not flicker every frame
  if (dt > 0) UI.fps = UI.fps ? lerp(UI.fps, 1 / dt, 0.08) : 1 / dt;
  UI.dt = dt;
  UI.t += dt;
  UI.hovered = null;
  UI.tooltip = null;
  Input.captureText = false;
}

export function inside(x, y, w, h) {
  const m = Input.mouse;
  return m.x >= x && m.x < x + w && m.y >= y && m.y < y + h;
}

// The X every popup wears in its top right corner. Hit testing lives with
// the popup's own update, so this only paints; hot is passed in.
export function closeButton(ctx, r, hot) {
  ctx.fillStyle = rgba(hot ? Theme.hp : '#000000', hot ? 0.30 : 0.45);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = hot ? Theme.hp : rgba(Theme.uiDim, 0.85);
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  const col = hot ? '#ffffff' : Theme.uiDim;
  for (let i = 0; i < 6; i++) {
    pxRect(ctx, r.x + 3 + i, r.y + 3 + i, 1, 1, col);
    pxRect(ctx, r.x + 8 - i, r.y + 3 + i, 1, 1, col);
  }
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

// Hover state is eased per button rather than snapped, so the whole front end
// feels sprung instead of binary. The eased value lives in a map keyed by id.
const HOVER = new Map();

function hoverAmount(id, hot, dt) {
  const cur = HOVER.get(id) ?? 0;
  const next = cur + ((hot ? 1 : 0) - cur) * Math.min(1, dt * 16);
  HOVER.set(id, next);
  if (HOVER.size > 400) HOVER.clear();
  return next;
}

export function button(ctx, id, x, y, w, h, label, opts = {}) {
  const hot = inside(x, y, w, h) && !opts.disabled;
  if (hot) UI.hovered = id;
  const sel = opts.selected;
  const k = hoverAmount(id, hot, UI.dt);
  // the whole button leans out toward the cursor as it lights up
  const grow = k * 1.5;
  const bx = Math.round(x - grow), by = Math.round(y - grow * 0.5);
  const bw = Math.round(w + grow * 2), bh = Math.round(h + grow);

  if (k > 0.02) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, x + w / 2, y + h / 2, w * 0.55, Theme.uiAccent, 0.10 * k);
    ctx.restore();
  }
  const base = opts.disabled ? rgba('#000000', 0.4)
    : sel ? rgba(Theme.platformGlow, 0.16) : rgba('#000000', 0.45);
  ctx.fillStyle = base;
  ctx.fillRect(bx, by, bw, bh);
  if (k > 0.02) {
    ctx.fillStyle = rgba(Theme.uiAccent, 0.22 * k);
    ctx.fillRect(bx, by, bw, bh);
  }
  const edge = opts.disabled ? rgba(Theme.uiDim, 0.4)
    : sel ? Theme.platformGlow : rgba(Theme.uiDim, 0.8);
  ctx.strokeStyle = k > 0.02 ? mixRgba(edge, Theme.uiAccent, k) : edge;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  // corner ticks that grow in with the hover
  if (k > 0.02) {
    const c = Math.round(3 + k * 3);
    ctx.strokeStyle = rgba(Theme.uiAccent, k);
    ctx.beginPath();
    for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const px = bx + (sx ? bw : 0) + 0.5, py = by + (sy ? bh : 0) + 0.5;
      ctx.moveTo(px + (sx ? -c : c), py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + (sy ? -c : c));
    }
    ctx.stroke();
  }
  const col = opts.disabled ? Theme.uiDim : k > 0.35 ? Theme.uiAccent : Theme.ui;
  // every button in the game comes through here, so a label that does not fit
  // shrinks rather than running off both ends of its own box
  drawTextFit(ctx, label, x + w / 2, y + (h - 7) / 2, col, w - 8, opts.scale ?? 1, 'center');
  if (k > 0.05) {
    const p = Math.sin(UI.t * 8) * 1;
    const slide = (1 - k) * 6;
    ctx.save();
    ctx.globalAlpha = k;
    drawText(ctx, '>', x + 4 + p - slide, y + (h - 7) / 2, Theme.uiAccent, 1);
    drawText(ctx, '<', x + w - 9 - p + slide, y + (h - 7) / 2, Theme.uiAccent, 1);
    ctx.restore();
  }
  // Two ways to fire. By default a button acts the moment it is pressed,
  // which is what every menu here has always done. `release` waits for the
  // finger to come up on the same button it went down on, so a list can tell
  // a tap from the start of a drag - and `suppress` is how the list says the
  // press turned into one.
  if (hot && Input.mouseDown.left) UI.pressedId = id;
  const clicked = opts.release
    ? (hot && Input.mouseUp.left && UI.pressedId === id && !opts.suppress)
    : (hot && Input.mouseDown.left && !opts.suppress);
  if (clicked) { UI.pressedId = null; Sfx.ui(); }
  return clicked;
}

// Blend two css colours for the eased border tint.
function mixRgba(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  if (!pa || !pb) return t > 0.5 ? b : a;
  const r = Math.round(lerp(pa[0], pb[0], t));
  const g = Math.round(lerp(pa[1], pb[1], t));
  const bl = Math.round(lerp(pa[2], pb[2], t));
  const al = lerp(pa[3], pb[3], t);
  return `rgba(${r},${g},${bl},${al})`;
}

function parseHex(c) {
  if (typeof c !== 'string') return null;
  if (c[0] === '#' && c.length >= 7) {
    const n = parseInt(c.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return null;
  const parts = m[1].split(',').map(Number);
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
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

// A canvas text field. Click to focus; typing is consumed from Input.typed so
// it never leaks into gameplay. Returns the (possibly edited) value.
export function textField(ctx, id, x, y, w, h, value, opts = {}) {
  const focused = UI.focus === id;
  const hot = inside(x, y, w, h);
  if (hot) UI.hovered = id;
  if (Input.mouseDown.left) {
    if (hot) { UI.focus = id; Sfx.ui(); }
    else if (focused) UI.focus = null;
  }
  ctx.fillStyle = rgba('#000000', 0.55);
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.strokeStyle = focused ? Theme.uiAccent : hot ? Theme.ui : rgba(Theme.uiDim, 0.8);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);

  let out = value;
  if (focused) {
    Input.captureText = true;
    for (const ch of Input.typed) {
      if (ch === 'Backspace') out = out.slice(0, -1);
      else if (ch === 'Enter') UI.focus = null;
      else if (out.length < (opts.max ?? 12) && /[a-z0-9 \-]/i.test(ch)) out += ch.toUpperCase();
    }
  }
  const shown = out.length ? out : (opts.placeholder ?? '');
  drawText(ctx, shown, x + 4, y + (h - 7) / 2, out.length ? Theme.ui : rgba(Theme.uiDim, 0.8), 1);
  if (focused && Math.floor(UI.t * 2.5) % 2 === 0) {
    pxRect(ctx, x + 4 + textWidth(out, 1) + 1, y + 3, 1, h - 6, Theme.uiAccent);
  }
  return out;
}

// --- HUD -----------------------------------------------------------------

export function drawHUD(ctx, game) {
  const p = game.player;
  if (!p) return;
  const t = UI.t;

  // health. The touch pad parks a pause button in the corner, so the whole
  // block slides right to leave it clear.
  const bw = 118;
  const px = hudInset();
  const bx = px + 5;
  panel(ctx, px, 6, bw + 10, 22, { alpha: 0.55 });
  // Name what is in your hand, not the class you picked at the start - and
  // not only weapons: a placeable in the hotbar is still something you hold.
  const slot = p.inventory.selectedItem();
  const held = slot ? ITEMS[slot.id] : null;
  // long names shrink to fit rather than being cut off - the readout to the
  // right owns the rest of the panel
  const heldName = held ? held.name.toUpperCase() : 'UNARMED';
  const hpText = `${Math.ceil(p.hp)}/${p.maxHp}`;
  drawTextFit(ctx, heldName, bx, 9, Theme.uiDim, bw - textWidth(hpText, 1) - 5, 1);
  const hpFrac = clamp(p.hp / p.maxHp, 0, 1);
  pxRect(ctx, bx, 18, bw, 5, Theme.hpBack);
  const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  grad.addColorStop(0, Theme.hp);
  grad.addColorStop(1, '#ff9ab0');
  ctx.fillStyle = grad;
  ctx.fillRect(bx, 18, Math.round(bw * hpFrac), 5);
  if (hpFrac < 0.3) {
    ctx.fillStyle = rgba('#ffffff', 0.25 + 0.25 * Math.sin(t * 9));
    ctx.fillRect(bx, 18, Math.round(bw * hpFrac), 5);
  }
  ctx.strokeStyle = rgba(Theme.uiDim, 0.8);
  ctx.strokeRect(bx - 0.5, 17.5, bw + 1, 6);
  drawTextShadow(ctx, hpText, bx + bw, 9, Theme.ui, 1, 'right');
  if (p.shieldMax > 0) {
    const sw = Math.round(bw * clamp(p.shield / p.shieldMax, 0, 1));
    pxRect(ctx, bx, 24, bw, 2, rgba('#0b2438', 0.9));
    pxRect(ctx, bx, 24, sw, 2, '#8fd8ff');
    if (sw > 0) glowDot(ctx, bx + sw, 25, 6, '#8fd8ff', 0.35);
  }

  // run status: where you are, which wave, how many are left
  drawTextShadow(ctx, `ROOM ${game.roomIndex}`, VIEW_W - 7, 8, Theme.ui, 1, 'right');
  if (Options.showWaveCounter) {
    const label = game.roomCleared ? 'CLEARED' : `WAVE ${game.waveIndex}/${game.wavesInRoom()}`;
    drawTextShadow(ctx, label, VIEW_W - 7, 18, game.roomCleared ? Theme.uiAccent : Theme.uiDim, 1, 'right');
    if (!game.roomCleared) {
      const alive = game.enemies.filter((e) => !e.dead).length + game.pendingSpawns.length;
      drawTextShadow(ctx, `LEFT ${alive}`, VIEW_W - 7, 28, Theme.uiDim, 1, 'right');
    }
  }
  if (Options.showFps) {
    drawTextShadow(ctx, `${Math.round(UI.fps)} FPS`, 4, VIEW_H - 10,
                   UI.fps < 45 ? Theme.hp : Theme.uiDim, 1);
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
  drawTextFit(ctx, boss.name, VIEW_W / 2, y - 10, Theme.uiAccent, VIEW_W - 24, 1, 'center', '#000000cc');
  pxRect(ctx, x - 1, y - 1, w + 2, 8, rgba('#000000', 0.7));
  pxRect(ctx, x, y, w, 6, Theme.hpBack);
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, boss.phase === 2 ? '#ff8a3c' : Theme.enemyBrute);
  g.addColorStop(1, boss.phase === 2 ? Theme.hp : '#b18cff');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, Math.round(w * k), 6);
  // phase threshold tick, only for bosses that actually have a second phase
  if (boss.phase2At > 0) {
    pxRect(ctx, x + Math.round(w * phaseK), y - 2, 1, 10, boss.phase === 2 ? rgba(Theme.uiDim, 0.6) : Theme.uiAccent);
  }
  ctx.strokeStyle = rgba(Theme.uiDim, 0.9);
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, 7);
  if (boss.phase2At > 0) drawTextShadow(ctx, `PHASE ${boss.phase}`, x + w + 6, y, Theme.uiDim, 1);
  if (Options.showBossHpNum) {
    drawTextShadow(ctx, `${Math.ceil(Math.max(0, boss.hp))}/${boss.maxHp}`,
                   x - 6, y, Theme.ui, 1, 'right');
  }
  // some bosses carry a title under the bar
  if (boss.title) drawTextFit(ctx, boss.title, VIEW_W / 2, y + 9, rgba(Theme.uiDim, 0.95), VIEW_W - 24, 1, 'center', '#000000cc');
  // a boss on a clock shows how much of it is left
  if (Options.showBossTimer && boss.def?.crushAfter && !boss.crushArmed) {
    const left = Math.max(0, boss.def.crushAfter - (boss.fightT ?? 0));
    const mins = Math.floor(left / 60);
    const secs = Math.floor(left % 60);
    const hot = left < 30;
    drawTextShadow(ctx, `${mins}:${String(secs).padStart(2, '0')}`,
                   x + w + 6, y, hot ? Theme.hp : Theme.uiDim, 1);
  }
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
    const x = hotbarSlotRect(i).x;
    slotBox(ctx, x, y, s, i === p.inventory.selected, p.inventory.slots[i], UI.t);
    drawText(ctx, i + 1, x + 2, y + 2, rgba(Theme.uiDim, 0.9), 1);
    if (inside(x, y, s, s) && p.inventory.slots[i]) UI.tooltip = { id: p.inventory.slots[i].id, x: x + s / 2, y: y - 4 };
  }
  // ammo / reload for the bow
  const w = p.inventory.selectedWeapon();
  if (w && w.weapon === 'paper') {
    const ax = x0 + total + 8;
    const have = p.inventory.countOf('paper');
    const lift = Math.sin(UI.t * 2.5) * 0.6;
    // sheet first, count after it, so a three-digit stack never collides
    pxRect(ctx, ax - 1, y + 2 + lift, 9, 11, '#141018');
    pxRect(ctx, ax, y + 3 + lift, 7, 9, '#f4f0e6');
    pxRect(ctx, ax + 1, y + 5 + lift, 4, 1, '#141018');
    pxRect(ctx, ax + 1, y + 7 + lift, 3, 1, '#3a3340');
    drawTextShadow(ctx, String(have), ax + 12, y + 4, have > 0 ? '#f4f0e6' : Theme.hp, 2);
  }
  const gun = w && (w.weapon === 'bow' ? BOW : w.weapon === 'shardgun' ? SHARDGUN
    : w.weapon === 'stingergun' ? STINGER_GUN : null);
  if (gun) {
    const ax = x0 + total + 8;
    if (p.reloadT > 0) {
      drawTextShadow(ctx, 'RELOAD', ax, y + 2, Theme.uiAccent, 1);
      const k = 1 - p.reloadT / gun.reload;
      pxRect(ctx, ax, y + 12, 40, 3, rgba('#000000', 0.7));
      pxRect(ctx, ax, y + 12, Math.round(40 * k), 3, Theme.uiAccent);
    } else if (gun.ammo === 1) {
      // a single shell reads better as one loaded slug than as one tick
      const hot = p.ammo > 0;
      pxRect(ctx, ax, y + 3, 7, 10, hot ? '#a98cff' : rgba(Theme.uiDim, 0.3));
      pxRect(ctx, ax + 1, y + 4, 5, 4, hot ? '#ffffff' : rgba(Theme.uiDim, 0.4));
    } else if (w.weapon === 'stingergun') {
      // Darts stand in a row with a bead on the point, so a full three reads
      // differently from three arrows at a glance. The bead turns soul-blue
      // while there are Soul Darts on the hotbar - which is the only warning
      // that the next shot will be the loaded kind.
      const souls = p.inventory.countInHotbar('souldart');
      const bead = souls > 0 ? SOUL_TINT : '#a8e04a';
      for (let i = 0; i < gun.ammo; i++) {
        const live = i < p.ammo;
        const dx = ax + i * 6;
        pxRect(ctx, dx, y + 4, 2, 7, live ? Theme.steel : rgba(Theme.uiDim, 0.35));
        pxRect(ctx, dx, y + 3, 2, 2, live ? bead : rgba(Theme.uiDim, 0.3));
        pxRect(ctx, dx - 1, y + 11, 4, 1, live ? Theme.steelDark : rgba(Theme.uiDim, 0.25));
      }
      if (souls > 0) {
        drawTextShadow(ctx, String(souls), ax + gun.ammo * 6 + 2, y + 4, SOUL_TINT, 1);
      }
    } else {
      for (let i = 0; i < gun.ammo; i++) {
        pxRect(ctx, ax + (i % 5) * 5, y + 3 + Math.floor(i / 5) * 7, 2, 5, i < p.ammo ? Theme.steel : rgba(Theme.uiDim, 0.35));
      }
    }
  }
}

// The fold wheel: a carousel of the folds you know, hanging over the player
// while the world holds its breath. Scroll to spin it; the slice that lands on
// top is the one you are about to throw.
export function drawFoldWheel(ctx, game) {
  const f = game.fold;
  const p = game.player;
  if (!f || !p) return;
  const t = UI.t;
  const pop = clamp(f.t * 7, 0, 1);
  const ease = 1 - Math.pow(1 - pop, 3);
  // the wheel is drawn in screen space, so it stays put while the camera drifts
  const scr = Camera.project(p.x, p.cy - 44);
  const cx = Math.round(clamp(scr.x, 60, VIEW_W - 60));
  const cy = Math.round(clamp(scr.y, 52, VIEW_H - 66));
  const R = 32 * ease;
  const n = f.options.length;
  const step = TAU / n;
  const have = p.inventory.countOf('paper');

  ctx.save();
  ctx.fillStyle = rgba('#05060c', 0.5 * ease);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // --- the paper mandala behind it
  ctx.globalCompositeOperation = 'lighter';
  glowDot(ctx, cx, cy, 66 * ease, '#f4f0e6', 0.10 * ease);
  glowDot(ctx, cx, cy, 26 * ease, '#f4f0e6', 0.08 * ease + f.spin * 0.10);
  for (let i = 0; i < 3; i++) {
    // guard the radius: on the first frame the ring is still at zero size
    const rr = Math.max(0.5, R + i * 6 + Math.sin(t * 2 + i) * 1.5);
    ctx.strokeStyle = rgba('#f4f0e6', (0.24 - i * 0.06) * ease);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rr, rr * 0.97, f.rot * (0.35 + i * 0.25) + t * 0.12, 0, TAU);
    ctx.stroke();
  }
  // creases sweeping round with the ring, brighter the faster it is turning
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i / (n * 2)) * TAU + f.rot;
    ctx.strokeStyle = rgba('#f4f0e6', (0.10 + f.spin * 0.22) * ease);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11);
    ctx.lineTo(cx + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15));
    ctx.stroke();
  }
  // motion arcs while it spins
  if (f.spin > 0.02) {
    for (let i = 0; i < 3; i++) {
      const rr = R - 4 + i * 4;
      ctx.strokeStyle = rgba('#ffffff', f.spin * 0.3 * ease);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.5, rr), f.rot + i, f.rot + i + 0.9 * f.spin);
      ctx.stroke();
    }
  }
  ctx.restore();

  // --- the slices themselves
  for (let i = 0; i < n; i++) {
    const o = f.options[i];
    const a = -Math.PI / 2 + i * step + f.rot;
    // how close this slice is to the top, 1 at the notch
    const up = clamp((Math.cos(a + Math.PI / 2) * -1 + 1) / 2, 0, 1);
    const near = Math.pow(clamp(1 - Math.abs(shortWrap(a + Math.PI / 2)) / Math.PI, 0, 1), 3);
    const rr = R + near * 5;
    const ox = cx + Math.cos(a) * rr;
    const oy = cy + Math.sin(a) * rr * 0.9;
    const afford = have >= o.cost;
    const sel = i === f.sel;
    const col = !afford ? Theme.uiDim : sel ? '#f4f0e6' : '#cdc7b8';
    const sc = (0.72 + near * 0.5) * ease;

    ctx.save();
    ctx.globalAlpha = ease * (afford ? 0.45 + near * 0.55 : 0.3 + near * 0.3);
    if (sel) glowDot(ctx, ox, oy, 26, col, 0.5 * ease);
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);
    // each card counter-rotates a little as the ring turns, like a real carousel
    ctx.rotate(Math.sin(f.rot * 0.5 + i) * 0.12 * (0.4 + f.spin));
    ctx.fillStyle = rgba('#000000', 0.62);
    ctx.fillRect(-10, -10, 20, 20);
    ctx.strokeStyle = rgba(col, sel ? 1 : 0.55);
    ctx.lineWidth = sel ? 1.4 : 1;
    ctx.strokeRect(-9.5, -9.5, 19, 19);
    drawItemIcon(ctx, o.id === 'missile' ? 'bookmissile' : 'bookairplane', -6, -6, 12, t);
    ctx.restore();

    // cost and the number key, only readable on the cards near the front
    if (near > 0.35) {
      ctx.save();
      ctx.globalAlpha = ease * near;
      drawText(ctx, String(o.cost), ox + 11, oy + 5, afford ? col : Theme.hp, 1, 'right');
      drawText(ctx, String(i + 1), ox - 11, oy - 10, rgba(Theme.uiDim, 0.9), 1);
      ctx.restore();
    }
  }

  // --- the pointer notch, over the cards so it always reads
  ctx.save();
  ctx.globalAlpha = ease;
  ctx.fillStyle = rgba('#f4f0e6', 0.75 + 0.25 * Math.sin(t * 5));
  ctx.beginPath();
  ctx.moveTo(cx, cy - R - 6);
  ctx.lineTo(cx - 4, cy - R - 13);
  ctx.lineTo(cx + 4, cy - R - 13);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // --- the label under the notch
  const cur = f.options[f.sel];
  if (cur) {
    ctx.save();
    ctx.globalAlpha = ease;
    drawTextFit(ctx, cur.name, cx, cy - R - 25, '#f4f0e6', VIEW_W - 20, 1, 'center', '#000000cc');
    const afford = have >= cur.cost;
    drawText(ctx, `${cur.cost} / ${have} SHEETS`, cx, cy + R + 18,
             afford ? Theme.ui : Theme.hp, 1, 'center');
    if (f.touchHint) {
      drawText(ctx, f.holdK > 0.001 ? 'HOLD TO FOLD' : (n > 1 ? 'DRAG UP OR DOWN' : 'HOLD TO FOLD'),
               cx, cy + R + 30, rgba(f.holdK > 0.001 ? Theme.uiAccent : Theme.uiDim, 0.9), 1, 'center');
    } else if (n > 1) {
      drawText(ctx, 'SCROLL TO TURN', cx, cy + R + 30, rgba(Theme.uiDim, 0.8), 1, 'center');
    }
    ctx.restore();
  }

  // --- the hold-to-commit ring, drawn only while a finger is actually down
  if (f.holdK > 0.001) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba('#ffd76a', 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.5, R + 9), -Math.PI / 2, -Math.PI / 2 + TAU * f.holdK);
    ctx.stroke();
    glowDot(ctx, cx, cy, (R + 12) * f.holdK, '#ffd76a', 0.12 * f.holdK);
    ctx.restore();
  }
  if (f.close) closeButton(ctx, f.close, !!f.closeHot);
}

// Wrap an angle into -PI..PI without importing the whole util surface.
function shortWrap(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// The forge: one scrolling list of what this anvil can do with what you are
// carrying. Wheel or W/S to move, left click to commit, right click to leave.
export function drawForge(ctx, game) {
  const f = game.forge;
  const p = game.player;
  if (!f || !p) return;
  const t = UI.t;
  const ease = 1 - Math.pow(1 - clamp(f.t * 7, 0, 1), 3);

  ctx.save();
  ctx.fillStyle = rgba('#05060c', 0.55 * ease);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.restore();

  const g = f.geom ?? forgeLayout(f.list.length);
  const { x, y, w, h, rowH } = g;
  ctx.save();
  ctx.globalAlpha = ease;
  panel(ctx, x, y, w, h, { accent: '#ffb43c', alpha: 0.95 });
  drawTextShadow(ctx, 'ANVIL', x + w / 2, y + 6, '#ffb43c', 2, 'center');

  const bars = p.inventory.countOf('ironbar');
  const paper = p.inventory.countOf('paper');
  drawText(ctx, `${bars} BARS`, x + 8, y + 24, '#ccd6e6', 1);
  drawText(ctx, `${paper} PAPER`, x + w - 8, y + 24, '#f4f0e6', 1, 'right');
  // the two rarer materials, tallied between them
  const shells = p.inventory.countOf('stingereggshell');
  const souls = p.inventory.countOf('soul');
  drawText(ctx, `${shells} SHELL ${souls} SOUL`, x + w / 2, y + 24,
           shells || souls ? '#9fd8c4' : rgba(Theme.uiDim, 0.7), 1, 'center');
  pxRect(ctx, x + 8, y + 34, w - 16, 1, rgba(Theme.uiDim, 0.5));

  if (!f.list.length) {
    drawText(ctx, 'NOTHING TO WORK WITH', x + w / 2, y + 46, Theme.uiDim, 1, 'center');
  }
  // Only a window of the list is on screen; everything below indexes into the
  // full list through the scroll offset the update pass settled on.
  const top = clamp(f.top ?? Math.round(f.scroll ?? 0), 0, Math.max(0, f.list.length - g.visible));
  for (let i = 0; i < g.visible; i++) {
    const idx = top + i;
    if (idx >= f.list.length) break;
    const e = f.list[idx];
    const rr = forgeRowRect(g, i);
    const ry = rr.y;
    const sel = idx === f.sel;
    if (sel) {
      ctx.fillStyle = rgba('#ffb43c', 0.16);
      ctx.fillRect(rr.x, ry, rr.w, rowH - 1);
      ctx.strokeStyle = rgba('#ffb43c', 0.8);
      ctx.strokeRect(rr.x + 0.5, ry + 0.5, rr.w - 1, rowH - 2);
    }
    drawItemIcon(ctx, e.icon, rr.x + 4, ry + 1, 12, t);
    const col = e.owned ? Theme.uiDim : e.ok ? (sel ? '#ffd76a' : Theme.ui) : Theme.uiDim;
    const costW = textWidth(e.cost, 1);
    drawTextFit(ctx, e.label, rr.x + 20, ry + 4, col, rr.w - 28 - costW, 1);
    drawText(ctx, e.cost, rr.x + rr.w - 4, ry + 4,
             e.owned ? Theme.uiDim : e.ok ? '#8ce88c' : Theme.hp, 1, 'right');
    // what the piece actually does, on the highlighted row
    if (sel && (ITEMS[e.id]?.armor || ITEMS[e.id]?.place)) {
      // above the panel, so it never covers the rows you are choosing between
      UI.tooltip = { id: e.id, x: x + w / 2, y: y - 2 };
    }
  }

  // the scrollbar, and a hint at what is still off each end
  if (g.scrolls) {
    const tr = forgeTrackRect(g);
    pxRect(ctx, tr.x, tr.y, tr.w, tr.h, rgba('#000000', 0.55));
    const span = Math.max(0, f.list.length - g.visible);
    const th = Math.max(6, Math.round(tr.h * g.visible / f.list.length));
    const ty = tr.y + Math.round((tr.h - th) * (span ? top / span : 0));
    pxRect(ctx, tr.x, ty, tr.w, th, rgba('#ffb43c', 0.85));
    const arrow = 0.4 + 0.3 * Math.sin(t * 5);
    if (top > 0) drawText(ctx, '^', x + w / 2, y + 34, rgba('#ffb43c', arrow), 1, 'center');
    if (top < span) drawText(ctx, 'v', x + w / 2, y + h - 19, rgba('#ffb43c', arrow), 1, 'center');
  }
  drawText(ctx, g.scrolls ? 'DRAG TO SCROLL - TAP A ROW TO MAKE IT' : 'TAP A ROW TO MAKE IT',
           x + w / 2, y + h - 11, rgba(Theme.uiDim, 0.85), 1, 'center');
  closeButton(ctx, closeRect(x, y, w), !!f.closeHot);
  ctx.restore();
  if (UI.tooltip) { drawTooltip(ctx, UI.tooltip); UI.tooltip = null; }
}

// --- the codex ------------------------------------------------------------
// A book held open: the running order down the left leaf, the page you have
// turned to on the right. The only thing you have to earn is the tick.
//
// The palette is deliberately dark. A cream page is the obvious choice for a
// book and completely the wrong one here: the bloom pass takes anything that
// bright and turns the whole spread into a white haze you cannot read.

const CODEX_PAGE = '#2a2417';
const CODEX_PAGE2 = '#221d13';
const CODEX_INK = '#e4d8b4';
const CODEX_FADE = '#9a8a63';
const CODEX_GOLD = '#c9a227';
const CODEX_LEATHER = '#4a3520';

export function drawCodex(ctx, game) {
  const c = game.codex;
  if (!c) return;
  const t = UI.t;
  const ease = 1 - Math.pow(1 - clamp(c.t * 6, 0, 1), 3);
  const g = c.geom ?? codexLayout();

  ctx.save();
  ctx.fillStyle = rgba('#05060c', 0.78 * ease);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = ease;
  const { x, y, w, h, spine } = g;
  // the cover, then the two leaves, then a shadow gathering into the spine so
  // it reads as folded rather than as one flat rectangle
  pxRect(ctx, x - 4, y - 4, w + 8, h + 8, '#1a1109');
  pxRect(ctx, x - 3, y - 3, w + 6, h + 6, CODEX_LEATHER);
  pxRect(ctx, x - 3, y - 3, w + 6, 1, '#6b5334');
  pxRect(ctx, x, y, w, h, CODEX_PAGE);
  pxRect(ctx, x, y, spine - x, h, CODEX_PAGE2);
  for (const dir of [-1, 1]) {
    const gr = ctx.createLinearGradient(spine, 0, spine + dir * 24, 0);
    gr.addColorStop(0, rgba('#000000', 0.5));
    gr.addColorStop(1, rgba('#000000', 0));
    ctx.fillStyle = gr;
    ctx.fillRect(dir < 0 ? spine - 24 : spine, y, 24, h);
  }
  pxRect(ctx, spine - 1, y, 2, h, '#160e07');
  for (let i = 0; i < 7; i++) pxRect(ctx, spine, y + 8 + i * ((h - 16) / 6), 1, 4, CODEX_GOLD);

  // the running head sits on the left leaf so it cannot land on the page title
  drawText(ctx, 'BESTIARY', g.left.x, y + 8, CODEX_GOLD, 1);
  pxRect(ctx, g.left.x, y + 17, g.left.w, 1, rgba(CODEX_GOLD, 0.45));

  drawCodexList(ctx, c, g, t);
  drawCodexPage(ctx, game, c, g, t);

  closeButton(ctx, closeRect(x, y, w), !!c.closeHot);
  ctx.restore();
}

function drawCodexList(ctx, c, g, t) {
  const beaten = c.entries.filter((e) => e.beaten).length;
  drawText(ctx, `${beaten}/${c.entries.length} FELLED`, g.left.x + g.left.w, g.left.y - 14,
           CODEX_FADE, 1, 'right');
  for (let i = 0; i < c.entries.length; i++) {
    const e = c.entries[i];
    const r = codexRowRect(g, i);
    const sel = i === c.sel;
    if (sel) {
      ctx.fillStyle = rgba(CODEX_GOLD, 0.16);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      pxRect(ctx, r.x, r.y, 2, r.h, CODEX_GOLD);
    }
    // the tick: drawn, not typed, so it still reads as a check at this size
    const bx = r.x + 5, by = r.y + 4;
    pxRect(ctx, bx, by, 9, 9, rgba('#000000', 0.55));
    ctx.strokeStyle = rgba(e.beaten ? '#6cd67f' : CODEX_FADE, 0.9);
    ctx.strokeRect(bx + 0.5, by + 0.5, 8, 8);
    if (e.beaten) {
      for (const [dx, dy] of [[2, 4], [3, 5], [4, 6], [5, 5], [6, 4], [7, 3]]) {
        pxRect(ctx, bx + dx, by + dy, 1, 1, '#6cd67f');
      }
    }
    const whereW = textWidth(e.where, 1);
    drawTextFit(ctx, e.name, bx + 13, r.y + 4, sel ? CODEX_INK : rgba(CODEX_INK, 0.75),
                r.w - 26 - whereW, 1);
    drawText(ctx, e.where, r.x + r.w - 2, r.y + 4, sel ? CODEX_GOLD : CODEX_FADE, 1, 'right');
    // the thread running down the order
    if (i < c.entries.length - 1) {
      pxRect(ctx, bx + 4, r.y + r.h, 1, g.rowH - r.h, rgba(CODEX_FADE, 0.45));
    }
  }
}

function drawCodexPage(ctx, game, c, g, t) {
  const e = c.entries[c.sel];
  if (!e) return;
  const R = g.right;
  ctx.save();
  // nothing on this page can spill past the edge of the book, whatever a
  // future entry decides to say
  ctx.beginPath();
  ctx.rect(R.x - 2, R.y - 12, R.w + 4, R.h + 12);
  ctx.clip();

  let y = R.y - 10;
  drawTextFit(ctx, e.name, R.x, y, CODEX_INK, R.w - textWidth(e.where, 1) - 6, 1);
  drawText(ctx, e.where, R.x + R.w, y, CODEX_GOLD, 1, 'right');
  y += 11;

  // the portrait, with the phase tabs under it when there are two
  const boxH = 48;
  pxRect(ctx, R.x, y, R.w, boxH, '#151009');
  ctx.strokeStyle = rgba(CODEX_FADE, 0.55);
  ctx.strokeRect(R.x + 0.5, y + 0.5, R.w - 1, boxH - 1);
  drawCodexPortrait(ctx, game, c, R.x, y, R.w, boxH, t);
  y += boxH + 3;
  c.phaseRects.length = 0;
  if (e.twoPhases) {
    for (let i = 0; i < 2; i++) {
      const bw2 = 46, bx = R.x + i * (bw2 + 4);
      const on = c.phase === i + 1;
      c.phaseRects[i] = { x: bx, y, w: bw2, h: 11 };
      ctx.fillStyle = rgba(on ? CODEX_GOLD : '#000000', on ? 0.3 : 0.35);
      ctx.fillRect(bx, y, bw2, 11);
      ctx.strokeStyle = rgba(on ? CODEX_GOLD : CODEX_FADE, on ? 0.9 : 0.5);
      ctx.strokeRect(bx + 0.5, y + 0.5, bw2 - 1, 10);
      drawText(ctx, `PHASE ${i + 1}`, bx + bw2 / 2, y + 3, on ? CODEX_INK : CODEX_FADE, 1, 'center');
    }
    y += 14;
  }

  // Two columns: what it hits for on the left, what it leaves on the right.
  // Stacked they did not fit, and a page that runs off the book is worse than
  // a page that is a little dense.
  // the damage column only holds short labels; the drops column holds whole
  // item names, so it gets the larger share
  const colW = Math.floor((R.w - 8) * 0.42);
  const cx2 = R.x + colW + 8;
  const dropW = R.x + R.w - cx2;
  let ly = y, ry = y;
  drawText(ctx, `HP ${e.hp}`, R.x, ly, CODEX_GOLD, 1); ly += 10;
  for (const [label, val] of e.damage) {
    const vw = textWidth(val, 1);
    drawTextFit(ctx, label, R.x, ly, rgba(CODEX_INK, 0.8), colW - vw - 4, 1);
    drawText(ctx, val, R.x + colW, ly, CODEX_INK, 1, 'right');
    ly += 8;
  }
  drawText(ctx, 'DROPS', cx2, ry, CODEX_GOLD, 1); ry += 10;
  for (const d of e.drops) { drawTextFit(ctx, d, cx2, ry, rgba(CODEX_INK, 0.8), dropW, 1); ry += 8; }
  y = Math.max(ly, ry) + 3;

  y = codexBlock(ctx, 'HOW IT ARRIVES', e.spawn, R, y);
  codexBlock(ctx, 'NOTES', e.phases, R, y);
  ctx.restore();
}

function codexBlock(ctx, head, lines, R, y) {
  pxRect(ctx, R.x, y, R.w, 1, rgba(CODEX_GOLD, 0.35));
  drawText(ctx, head, R.x, y + 4, CODEX_GOLD, 1);
  y += 13;
  for (const l of lines) {
    drawTextFit(ctx, l, R.x, y, rgba(CODEX_INK, 0.85), R.w, 1);
    y += 8;
  }
  return y + 3;
}

// The real boss, drawn small. Its parts were pulled out of the room when the
// preview was built, so this is the fight's own art and cannot drift from it.
function drawCodexPortrait(ctx, game, c, x, y, w, h, t) {
  const boss = c.preview;
  if (!boss) {
    drawText(ctx, 'NO IMAGE', x + w / 2, y + h / 2 - 3, CODEX_FADE, 1, 'center');
    return;
  }
  const v = c.view;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y + 1, w - 2, h - 2);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(v.zoom, v.zoom);
  ctx.translate(-v.cx, -v.cy);
  drawBossPreview(ctx, boss, t);
  ctx.restore();
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

const ARMOR_LABEL = { helmet: 'HEAD', chest: 'BODY', legs: 'LEGS' };

export function drawInventory(ctx, game) {
  const p = game.player;
  const inv = p.inventory;
  ctx.fillStyle = rgba('#000000', 0.6);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const s = 22, gap = 4;
  const gw = INV_COLS * s + (INV_COLS - 1) * gap;
  const gh = INV_ROWS * s + (INV_ROWS - 1) * gap;
  // the armour column sits to the left of the grid, so shift the whole thing
  const armW = s + 22;
  const px = Math.round((VIEW_W - gw - armW) / 2) - 12 + armW;
  const py = 54;
  const panX = px - armW - 6, panY = py - 22, panW = gw + 24 + armW + 6;
  panel(ctx, panX, panY, panW, gh + 32);
  drawTextShadow(ctx, 'INVENTORY', px + (gw + 24) / 2, py - 16, Theme.uiAccent, 1, 'center');

  // Close button in the top right corner. On a phone there is no ESC key and
  // the pad is hidden while the inventory is up, so without this the only way
  // out is the BAG button you may not remember pressing.
  const cbr = closeRect(panX, panY, panW);
  // a drag in flight owns the cursor: dropping an item must not close the panel
  const cbHot = !UI.drag && inside(cbr.x, cbr.y, cbr.w, cbr.h);
  closeButton(ctx, cbr, cbHot);
  if (cbHot) {
    UI.hovered = 'inv-close';
    if (Input.mouseDown.left) {
      game.invOpen = false;
      Sfx.ui();
    }
  }

  // --- armour slots
  const ax = px - armW - 2;
  let hoverArmor = null;
  drawText(ctx, 'WORN', ax + s / 2, py - 16, Theme.uiDim, 1, 'center');
  for (let i = 0; i < ARMOR_SLOTS.length; i++) {
    const key = ARMOR_SLOTS[i];
    const y = py + i * (s + gap);
    const item = UI.drag && UI.drag.armor === key ? null : inv.armor[key];
    slotBox(ctx, ax, y, s, false, item, UI.t);
    // an empty slot says what belongs in it
    if (!item) drawText(ctx, ARMOR_LABEL[key], ax + s / 2, y + s / 2 - 3, rgba(Theme.uiDim, 0.65), 1, 'center');
    if (inside(ax, y, s, s)) {
      hoverArmor = key;
      ctx.strokeStyle = Theme.uiAccent;
      ctx.strokeRect(ax + 0.5, y + 0.5, s - 1, s - 1);
      if (item) UI.tooltip = { id: item.id, x: ax + s / 2, y: y - 4 };
    }
  }
  // defence and the set bonus, under the column
  const setName = inv.activeSet();
  const dy = py + ARMOR_SLOTS.length * (s + gap) + 2;
  drawText(ctx, `DEF ${p.defense}`, ax + s / 2, dy, p.defense > 0 ? '#8ce88c' : Theme.uiDim, 1, 'center');
  if (setName) {
    drawText(ctx, `${setName.toUpperCase()} SET`, ax + s / 2, dy + 10, Theme.uiAccent, 1, 'center');
  }

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

  // --- drag & drop, across the grid and the armour column both
  if (Input.mouseDown.left && !UI.drag) {
    if (hoverIdx >= 0 && inv.slots[hoverIdx]) { UI.drag = { from: hoverIdx }; Sfx.ui(); }
    else if (hoverArmor && inv.armor[hoverArmor]) { UI.drag = { armor: hoverArmor }; Sfx.ui(); }
  }
  if (UI.drag) {
    const item = UI.drag.armor ? inv.armor[UI.drag.armor] : inv.slots[UI.drag.from];
    if (item) {
      drawItemIcon(ctx, item.id, Input.mouse.x - 6, Input.mouse.y - 6, 12, UI.t);
      if (item.count > 1) drawTextShadow(ctx, item.count, Input.mouse.x + 8, Input.mouse.y + 2, Theme.ui, 1);
      // the slot it would land in lights up while you hold it
      const key = Inventory.armorSlot(item.id);
      if (key && !UI.drag.armor) {
        const i = ARMOR_SLOTS.indexOf(key);
        const y = py + i * (s + gap);
        ctx.strokeStyle = rgba('#8ce88c', 0.5 + 0.4 * Math.sin(UI.t * 8));
        ctx.strokeRect(ax - 0.5, y - 0.5, s + 1, s + 1);
      }
    }
    if (Input.mouseUp.left) {
      if (UI.drag.armor) {
        // dropping a worn piece: onto the grid, or back where it came from
        if (hoverIdx >= 0) inv.unequip(UI.drag.armor, inv.slots[hoverIdx] ? -1 : hoverIdx);
        else if (!hoverArmor) inv.unequip(UI.drag.armor);
      } else if (hoverArmor) {
        // only into its own slot; anything else just falls back
        const item2 = inv.slots[UI.drag.from];
        if (item2 && Inventory.armorSlot(item2.id) === hoverArmor) inv.equip(UI.drag.from);
        else Sfx.ui();
      } else if (hoverIdx >= 0) {
        inv.swap(UI.drag.from, hoverIdx);
      }
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
  const wide = Math.max(textWidth(def.name, 1), ...lines.map((l) => textWidth(l, 1))) + 12;
  const w = Math.min(wide, VIEW_W - 6);
  const h = 24 + lines.length * 9;
  const x = clamp(tip.x - w / 2, 3, VIEW_W - w - 3);
  const y = clamp(tip.below ? tip.y : tip.y - h, 3, VIEW_H - h - 3);
  panel(ctx, x, y, w, h, { alpha: 0.95, accent: RARITY[def.rarity].color });
  drawTextFit(ctx, def.name, x + 6, y + 5, RARITY[def.rarity].color, w - 12, 1);
  drawText(ctx, RARITY[def.rarity].name, x + 6, y + 14, Theme.uiDim, 1);
  for (let i = 0; i < lines.length; i++) {
    drawTextFit(ctx, lines[i], x + 6, y + 25 + i * 9, Theme.ui, w - 12, 1);
  }
}


// --- debug menu (ctrl+m) -------------------------------------------------

// Everything that exists, so a new entry shows up here without another edit.
const DEBUG_ITEMS = Object.keys(ITEMS);
const DEBUG_MOBS = Object.keys(ENEMY_TYPES).filter((k) => !ENEMY_TYPES[k].boss);
const DEBUG_BOSSES = Object.keys(BOSS_TYPES);

// One row of anything, and a wheel to see the rest. The lists grow every time
// something is added to the game, so the panel is sized to a fixed number of
// rows rather than to the content - nothing ever spills out of the card.
const DEBUG_ROWS = 1;

// Scroll a grid under the cursor and draw its bar. Returns the first row to
// draw, so the caller just offsets by it.
function gridScroll(key, gx, gy, gw, gh, rows, visible) {
  const max = Math.max(0, rows - visible);
  if (max === 0) { UI.dbgScroll[key] = 0; return 0; }
  const over = inside(gx, gy, gw, gh);
  if (over && Input.wheel !== 0) {
    UI.dbgScroll[key] = clamp((UI.dbgScroll[key] ?? 0) + Math.sign(Input.wheel), 0, max);
    Sfx.ui();
  }
  return clamp(UI.dbgScroll[key] ?? 0, 0, max);
}

function scrollBar(ctx, x, y, h, rows, visible, off) {
  const max = Math.max(0, rows - visible);
  if (max === 0) return;
  pxRect(ctx, x, y, 2, h, rgba('#000000', 0.6));
  const knob = Math.max(6, Math.round(h * (visible / rows)));
  const ky = Math.round(y + (h - knob) * (off / max));
  pxRect(ctx, x, ky, 2, knob, Theme.uiAccent);
  // little arrows so it is obvious there is more
  if (off > 0) pxRect(ctx, x - 1, y - 3, 4, 1, rgba(Theme.uiAccent, 0.8));
  if (off < max) pxRect(ctx, x - 1, y + h + 2, 4, 1, rgba(Theme.uiAccent, 0.8));
}

export function drawDebugMenu(ctx, game) {
  ctx.fillStyle = rgba('#000000', 0.55);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // six wider columns: bigger targets, and the list actually scrolls
  const cell = 28, gap = 3, cols = 6;
  const bw2 = 54, bh2 = 14, bgap = 3, bcols = 4;
  const itemsH = DEBUG_ROWS * (cell + gap) - gap;
  const mobsH = DEBUG_ROWS * (bh2 + bgap) - bgap;

  const w = 268;
  const h = 60 + itemsH + 26 + mobsH + 44;
  const x = Math.round((VIEW_W - w) / 2);
  const y = Math.round((VIEW_H - h) / 2);
  panel(ctx, x, y, w, h, { accent: '#8ce88c' });
  drawTextShadow(ctx, 'DEBUG', x + w / 2, y + 6, '#8ce88c', 2, 'center');

  const d = game.debug;
  // god mode is both halves: nothing touches you, and nothing survives you
  if (button(ctx, 'dbg-god', x + 12, y + 24, 116, 15, `GOD MODE: ${d.god ? 'ON' : 'OFF'}`, { selected: d.god })) {
    d.god = !d.god;
  }
  if (button(ctx, 'dbg-inf', x + 140, y + 24, 116, 15, `INF HEALTH: ${d.infHealth ? 'ON' : 'OFF'}`, { selected: d.infHealth })) {
    d.infHealth = !d.infHealth;
  }

  const live = !!game.player && game.screen !== 'menu' && game.screen !== 'classSelect';

  // --- items, three rows at a time
  const itemRows = Math.ceil(DEBUG_ITEMS.length / cols);
  const gx = x + 12, gy = y + 54;
  const gw = cols * (cell + gap) - gap;
  drawText(ctx, 'SPAWN ITEM', gx, y + 44, live ? Theme.uiAccent : Theme.uiDim, 1);
  if (!live) drawText(ctx, '(START A RUN FIRST)', gx + 76, y + 44, Theme.uiDim, 1);
  const iOff = gridScroll('items', gx, gy, gw + 10, itemsH, itemRows, DEBUG_ROWS);
  scrollBar(ctx, gx + gw + 7, gy, itemsH, itemRows, DEBUG_ROWS, iOff);

  ctx.save();
  ctx.beginPath();
  ctx.rect(gx - 1, gy - 1, gw + 2, itemsH + 2);
  ctx.clip();
  for (let i = 0; i < DEBUG_ITEMS.length; i++) {
    const row = Math.floor(i / cols) - iOff;
    if (row < 0 || row >= DEBUG_ROWS) continue;
    const id = DEBUG_ITEMS[i];
    const cx = gx + (i % cols) * (cell + gap);
    const cy = gy + row * (cell + gap);
    const hot = live && inside(cx, cy, cell, cell);
    ctx.fillStyle = rgba('#000000', hot ? 0.25 : 0.5);
    ctx.fillRect(cx, cy, cell, cell);
    ctx.strokeStyle = hot ? Theme.uiAccent : rgba(Theme.uiDim, live ? 0.8 : 0.35);
    ctx.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);
    ctx.save();
    if (!live) ctx.globalAlpha = 0.35;
    drawItemIcon(ctx, id, cx + (cell - 18) / 2, cy + (cell - 18) / 2, 18, UI.t);
    ctx.restore();
    if (hot) {
      // parked under the panel so it never covers the buttons
      UI.tooltip = { id, x: VIEW_W / 2, y: y + h + 4, below: true };
      if (Input.mouseDown.left) {
        game.player.inventory.add(id, 1);
        game.player.recomputeStats();
        Sfx.pickup();
      }
    }
  }
  ctx.restore();

  // --- mobs and bosses, same treatment
  // two enemies can share a display name (the room's Shardling and the one
  // Alphads summons), so fall back to the id when the label is ambiguous
  const nameCount = {};
  for (const id of DEBUG_MOBS) {
    const n = ENEMY_TYPES[id].name.toUpperCase();
    nameCount[n] = (nameCount[n] ?? 0) + 1;
  }
  const entries = [
    ...DEBUG_MOBS.map((id) => {
      const n = ENEMY_TYPES[id].name.toUpperCase();
      return { id, boss: false, label: nameCount[n] > 1 ? id.toUpperCase().slice(0, 9) : n };
    }),
    ...DEBUG_BOSSES.map((id) => ({ id, boss: true, label: (BOSS_TYPES[id].short ?? BOSS_TYPES[id].name).toUpperCase() })),
  ];
  const mobRows = Math.ceil(entries.length / bcols);
  const by0 = gy + itemsH + 20;
  const mw = bcols * (bw2 + bgap) - bgap;
  drawText(ctx, 'SPAWN MOB', gx, by0 - 10, live ? Theme.uiAccent : Theme.uiDim, 1);
  drawText(ctx, 'WHEEL TO SCROLL', x + w - 12, by0 - 10, rgba(Theme.uiDim, 0.9), 1, 'right');
  const mOff = gridScroll('mobs', gx, by0, mw + 10, mobsH, mobRows, DEBUG_ROWS);
  scrollBar(ctx, gx + mw + 7, by0, mobsH, mobRows, DEBUG_ROWS, mOff);

  ctx.save();
  ctx.beginPath();
  ctx.rect(gx - 1, by0 - 1, mw + 2, mobsH + 2);
  ctx.clip();
  for (let i = 0; i < entries.length; i++) {
    const row = Math.floor(i / bcols) - mOff;
    if (row < 0 || row >= DEBUG_ROWS) continue;
    const e = entries[i];
    const bx = gx + (i % bcols) * (bw2 + bgap);
    const by = by0 + row * (bh2 + bgap);
    const tint = e.boss ? Theme.uiAccent : (ENEMY_TINT[e.id] ?? Theme.ui);
    if (button(ctx, 'dbg-mob-' + e.id, bx, by, bw2, bh2, e.label, { disabled: !live, accent: tint })) {
      if (e.boss) game.debugSpawnBoss(e.id);
      else game.debugSpawnEnemy(e.id);
    }
    if (live) pxRect(ctx, bx + 1, by + 1, 2, bh2 - 2, tint);
  }
  ctx.restore();

  // --- drop straight into a room
  const ry = by0 + mobsH + 14;
  const maxRoom = live ? game.lastRoom : FINAL_ROOM;
  UI.dbgRoom = clamp(Math.round(UI.dbgRoom ?? 1), 1, maxRoom);
  drawText(ctx, 'GO TO ROOM', gx, ry - 10, live ? Theme.uiAccent : Theme.uiDim, 1);
  if (button(ctx, 'dbg-room-less', gx, ry, 15, 15, '-', { disabled: !live || UI.dbgRoom <= 1 })) {
    UI.dbgRoom = Math.max(1, UI.dbgRoom - 1);
  }
  // the number itself takes the wheel, so a long way up the tower is one flick
  const nx = gx + 18, nw = 38;
  pxRect(ctx, nx, ry, nw, 15, rgba('#000000', 0.5));
  ctx.strokeStyle = rgba(live ? Theme.uiAccent : Theme.uiDim, 0.8);
  ctx.strokeRect(nx + 0.5, ry + 0.5, nw - 1, 14);
  drawText(ctx, `${UI.dbgRoom}/${maxRoom}`, nx + nw / 2, ry + 5, live ? Theme.ui : Theme.uiDim, 1, 'center');
  if (live && inside(nx, ry, nw, 15) && Input.wheel !== 0) {
    UI.dbgRoom = clamp(UI.dbgRoom - Math.sign(Input.wheel), 1, maxRoom);
    Sfx.ui();
  }
  if (button(ctx, 'dbg-room-more', nx + nw + 3, ry, 15, 15, '+', { disabled: !live || UI.dbgRoom >= maxRoom })) {
    UI.dbgRoom = Math.min(maxRoom, UI.dbgRoom + 1);
  }
  // where you would land, since a room number on its own says little
  const bossAt = live && game.mode === 'bossrush'
    ? (BOSS_TYPES[game.rushBossFor(UI.dbgRoom)] ?? null)
    : (UI.dbgRoom % BOSS_ROOM_INTERVAL === 0 ? BOSS_TYPES[bossIdForRoom(UI.dbgRoom)] ?? null : null);
  const note = bossAt ? (bossAt.short ?? bossAt.name).toUpperCase() : 'NORMAL WAVES';
  drawTextFit(ctx, note, nx + nw + 24, ry + 5, live ? Theme.uiDim : rgba(Theme.uiDim, 0.5), 84, 1);
  if (button(ctx, 'dbg-room-go', x + w - 84, ry, 72, 15, 'TELEPORT', { disabled: !live })) {
    game.debugGoToRoom(UI.dbgRoom);
  }

  // --- the row of actions, always inside the panel
  const ay = y + h - 20;
  if (live && button(ctx, 'dbg-heal', x + 12, ay, 74, 15, 'FULL HEAL')) {
    game.player.hp = game.player.maxHp;
    game.player.shield = game.player.shieldMax;
  }
  if (live && button(ctx, 'dbg-kill', x + 92, ay, 74, 15, 'KILL WAVE')) {
    game.pendingSpawns.length = 0;
    for (const e of [...game.enemies]) if (!e.dead) e.kill();
  }
  if (button(ctx, 'dbg-close', x + w - 84, ay, 72, 15, 'CLOSE')) game.debugOpen = false;

  drawTextShadow(ctx, 'CTRL+M', x + w - 8, y + 6, Theme.uiDim, 1, 'right');
  if (UI.tooltip) drawTooltip(ctx, UI.tooltip);
}
