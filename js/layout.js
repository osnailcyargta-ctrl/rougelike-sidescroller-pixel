// Where the screen furniture sits. Pure geometry, no drawing and no state, so
// the code that paints a control and the code that decides whether a finger
// landed on it are reading the exact same numbers.
import { VIEW_W, VIEW_H } from './config.js';
import { HOTBAR_SIZE } from './items.js';
import { Options } from './settings.js';
import { Theme } from './theme.js';
import { clamp } from './util.js';

export const STICK_R = 30;      // the ring you steer inside
export const KNOB_R = 10;
export const STICK_GRAB = 26;   // slop outside the ring that still counts
export const BTN_R = 15;
export const PAUSE_R = 12;

export function hotbarSlotRect(i) {
  const s = 20, gap = 3;
  const total = HOTBAR_SIZE * s + (HOTBAR_SIZE - 1) * gap;
  const x0 = Math.round((VIEW_W - total) / 2);
  return { x: x0 + i * (s + gap), y: VIEW_H - 26, w: s, h: s };
}

export function padScale() { return clamp(Options.touchScale ?? 1, 0.7, 1.5); }

// Controls grow away from the corner they are anchored to, so the thumb rests
// stay in the corners at every size.
function grow(x, y, ax, ay, s) {
  return { x: ax + (x - ax) * s, y: ay + (y - ay) * s };
}

export function padLayout() {
  const s = padScale();
  const L = { ax: 0, ay: VIEW_H }, R = { ax: VIEW_W, ay: VIEW_H };
  const stick = (x, y, a) => ({
    ...grow(x, y, a.ax, a.ay, s),
    r: STICK_R * s, knob: KNOB_R * s, grab: (STICK_R + STICK_GRAB) * s,
  });
  const btn = (id, x, y, a, label, mode, tint) => ({
    id, ...grow(x, y, a.ax, a.ay, s), r: BTN_R * s, label, mode, tint,
  });
  return {
    s,
    left: stick(52, 212, L),
    right: stick(VIEW_W - 52, 212, R),
    buttons: [
      // right thumb: an arc above the aim stick, primary action nearest
      btn('shoot', VIEW_W - 22, 148, R, 'FIRE', 'hold', Theme.uiAccent),
      btn('grapple', VIEW_W - 71, 143, R, 'HOOK', 'tap', Theme.hookColor),
      btn('interact', VIEW_W - 107, 176, R, 'USE', 'tap', Theme.platformGlow),
      // left thumb: mirrored, so both hands learn the same shape
      btn('autoFire', 71, 143, L, 'AUTO', 'toggle', Theme.uiAccent),
      btn('inventory', 107, 176, L, 'BAG', 'tap', Theme.ui),
    ],
    pause: { id: 'pause', ...grow(17, 17, 0, 0, s), r: PAUSE_R * s },
  };
}

// How far the HUD has to step aside for the pause button in the corner.
// Derived from the button itself so the two can never drift apart.
export function hudInset() {
  if (!Options.mobileControls) return 6;
  const q = padLayout().pause;
  return Math.round(q.x + q.r + 5);
}

// --- the anvil popup ------------------------------------------------------
// Shared so the row you tap and the row that gets forged are the same row.
// They used to disagree: the hover was worked out while drawing, so a touch
// that arrived and clicked inside one frame was matched against the previous
// frame's cursor position and forged whatever had been selected before.

export const FORGE_W = 236;
export const FORGE_ROW_H = 15;
export const CLOSE_SIZE = 12;

export function forgeLayout(rows) {
  const w = FORGE_W, rowH = FORGE_ROW_H;
  const h = 40 + Math.max(1, rows) * rowH + 16;
  return { x: Math.round((VIEW_W - w) / 2), y: Math.round((VIEW_H - h) / 2), w, h, rowH };
}

export function forgeRowRect(g, i) {
  return { x: g.x + 6, y: g.y + 40 + i * g.rowH, w: g.w - 12, h: g.rowH - 1 };
}

// The close button every popup puts in its top right corner.
export function closeRect(x, y, w) {
  return { x: x + w - CLOSE_SIZE - 4, y: y + 4, w: CLOSE_SIZE, h: CLOSE_SIZE };
}

export function inRect(r, mx, my) {
  return mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h;
}
