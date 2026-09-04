// On-screen controls for touch devices: two sticks, six buttons, and the
// gesture layer that turns finger drags into the same key presses the
// keyboard produces.
//
// Three rules shape the whole thing:
//
//  1. A touch is CLAIMED once, when it lands, and keeps that claim until the
//     finger comes up. A thumb that starts on the move stick stays on the
//     move stick even if it wanders across the screen, so the sticks and the
//     buttons can never steal each other's fingers mid-drag.
//  2. The stick bases never move. The ring is drawn where it lives and the
//     knob is the finger's offset from that ring's centre, clamped to its
//     radius - so what you see and what you are steering are the same circle.
//  3. Every gameplay action is delivered as a virtual key press through
//     input.js, never by poking gameplay state directly. Dash, ground slam,
//     drop-through and hold-to-move then work on touch for free, because they
//     are the keyboard's own double-tap and hold rules running unmodified.
import { VIEW_W, VIEW_H } from './config.js';
import { Input, Binds, virtualKeyDown, virtualKeyUp, virtualKeyTap } from './input.js';
import { Options } from './settings.js';
import { Theme } from './theme.js';
import { clamp, rgba, TAU } from './util.js';
import { drawText } from './font.js';
import { pxRect, glowDot } from './gfx.js';
import { Sfx } from './audio.js';
import { HOTBAR_SIZE } from './items.js';
import { padLayout, hotbarSlotRect } from './layout.js';

// How far the stick has to lean before an action engages, and how far back it
// has to come before it lets go. The gap between the two is what stops a thumb
// resting on the threshold from stuttering the key on and off every frame.
const AXES = {
  left:  { bind: 'left',  on: 0.26, off: 0.16, of: (s) => -s.x },
  right: { bind: 'right', on: 0.26, off: 0.16, of: (s) => s.x },
  jump:  { bind: 'jump',  on: 0.52, off: 0.34, of: (s) => -s.y },
  down:  { bind: 'down',  on: 0.52, off: 0.34, of: (s) => s.y },
};

// The aim stick steers a free crosshair rather than swinging a fixed arm
// around the player: it is a speed, not an angle, so the aim can be put
// anywhere on the screen and left there.
const AIM_DEAD = 0.14;       // thumb noise below this does not move the aim
const AIM_SPEED = 340;       // px/s at full throw
const AIM_EDGE = 6;          // keep the crosshair on screen

export const Pad = {
  active: false,           // the pad is live this frame (playing, no modal)
  touches: new Map(),      // id -> { claim, vx, vy, wx, wy }
  axes: new Set(),         // which AXES entries are currently engaged
  left: { x: 0, y: 0, mag: 0, active: false },
  right: { x: 0, y: 0, mag: 0, active: false },
  cursor: { x: 0, y: 0 },  // the free crosshair, in world space
  cursorReady: false,      // seeded from the player once the pad comes up
  autoFire: false,         // the AUTO toggle
  geom: null,
  _mouseLeft: false,       // mouse buttons the pad is currently holding down
  _mouseRight: false,
};

// --- claiming -------------------------------------------------------------

function hit(t, c) { return Math.hypot(t.vx - c.x, t.vy - c.y) <= c.r; }

function claimFor(t, g, game) {
  if (hit(t, g.pause)) return 'btn:pause';
  for (const b of g.buttons) if (hit(t, { x: b.x, y: b.y, r: b.r + 4 })) return 'btn:' + b.id;
  // the hotbar is the one piece of HUD you still need mid-fight
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    const r = hotbarSlotRect(i);
    if (t.vx >= r.x - 2 && t.vx < r.x + r.w + 2 && t.vy >= r.y - 2 && t.vy < r.y + r.h + 2) return 'slot:' + i;
  }
  if (Math.hypot(t.vx - g.left.x, t.vy - g.left.y) <= g.left.grab) return 'stick:left';
  if (Math.hypot(t.vx - g.right.x, t.vy - g.right.y) <= g.right.grab) return 'stick:right';
  return 'none';
}

// A touch that is not steering the pad drives the cursor instead, so menus,
// the inventory, the fold wheel and the forge are all usable by hand.
function uiPoint(t) {
  Input.mouse.sx = t.sx;
  Input.mouse.sy = t.sy;
  Input.mouse.x = t.wx;
  Input.mouse.y = t.wy;
}

function drainTouches(game, g, active) {
  for (const ev of Input.touchQueue) {
    if (ev.type === 'start') {
      const claim = Pad.active ? claimFor(ev, g, game) : 'ui';
      // ox/oy is where this finger landed: the anchor every drag is measured from
      Pad.touches.set(ev.id, {
        claim, vx: ev.vx, vy: ev.vy, ox: ev.vx, oy: ev.vy,
        wx: ev.wx, wy: ev.wy, sx: ev.sx, sy: ev.sy,
      });
      if (claim === 'ui') {
        // the cursor has to be under the finger before the click lands, or the
        // button being tapped will not consider itself hovered this frame
        uiPoint(ev);
        Input.mouse.left = true;
        Input.mouseDown.left = true;
      } else if (claim.startsWith('slot:')) {
        const i = Number(claim.slice(5));
        if (game.player && game.player.inventory.selected !== i) {
          game.player.inventory.selected = i;
          Sfx.ui();
        }
      } else if (claim === 'btn:pause') {
        virtualKeyTap('Escape');
      } else if (claim === 'btn:autoFire') {
        Pad.autoFire = !Pad.autoFire;
        Sfx.ui();
      } else if (claim === 'btn:grapple') {
        virtualKeyTap(Binds.grapple);
      } else if (claim === 'btn:inventory') {
        virtualKeyTap(Binds.inventory);
      }
    } else if (ev.type === 'move') {
      const t = Pad.touches.get(ev.id);
      if (!t) continue;
      t.vx = ev.vx; t.vy = ev.vy; t.wx = ev.wx; t.wy = ev.wy; t.sx = ev.sx; t.sy = ev.sy;
      if (t.claim === 'ui') uiPoint(ev);
    } else {
      const t = Pad.touches.get(ev.id);
      if (!t) continue;
      Pad.touches.delete(ev.id);
      if (t.claim === 'ui') {
        uiPoint(ev);
        Input.mouse.left = false;
        Input.mouseUp.left = true;
      }
    }
    // Edges are taken per event, not once per frame. A flick fast enough to
    // put the release and the next press inside a single frame would otherwise
    // look like one unbroken hold, and the dash would never fire - which is
    // exactly the gesture most likely to land that way on a slow frame.
    syncSticks(active, g);
  }
  Input.touchQueue.length = 0;
}

// --- sticks ---------------------------------------------------------------

// The throw is measured from where the finger LANDED, not from the middle of
// the ring, so putting a thumb down never yanks the stick over - it only
// answers to an actual drag. Past full throw the origin is dragged along
// behind the finger, so reversing direction responds at once instead of
// having to unwind all the slack first.
function readStick(claim, c) {
  for (const t of Pad.touches.values()) {
    if (t.claim !== claim) continue;
    let dx = t.vx - t.ox, dy = t.vy - t.oy;
    const d = Math.hypot(dx, dy);
    if (d > c.r) {
      const pull = (d - c.r) / d;
      t.ox += dx * pull;
      t.oy += dy * pull;
      dx = t.vx - t.ox;
      dy = t.vy - t.oy;
    }
    return { x: dx / c.r, y: dy / c.r, mag: Math.min(1, Math.hypot(dx, dy) / c.r), active: true };
  }
  return { x: 0, y: 0, mag: 0, active: false };
}

function applyAxes(stick) {
  // If something else let go of the keyboard behind our back - a window blur
  // clears every held key - forget the axes we thought we were holding, so
  // the next lean presses them again instead of assuming they are still down.
  for (const name of Pad.axes) {
    if (!Input.keys.has(Binds[AXES[name].bind])) Pad.axes.delete(name);
  }
  for (const [name, ax] of Object.entries(AXES)) {
    const key = Binds[ax.bind];
    const was = Pad.axes.has(name);
    const v = ax.of(stick);
    const on = was ? v > ax.off : v > ax.on;
    if (on && !was) { Pad.axes.add(name); virtualKeyDown(key); }
    else if (!on && was) { Pad.axes.delete(name); virtualKeyUp(key); }
  }
}

// Re-read both sticks from whatever fingers are currently down and hand the
// move stick to the edge detector. Safe to call as often as you like: the
// engaged-axis set makes it idempotent.
function syncSticks(active, g) {
  const off = { x: 0, y: 0, mag: 0, active: false };
  Pad.left = active ? readStick('stick:left', g.left) : off;
  Pad.right = active ? readStick('stick:right', g.right) : off;
  applyAxes(Pad.left);
}

// Mouse buttons are only touched on the frame they change, and only for the
// ones the pad itself is holding, so a real mouse plugged into the same
// session is never fought over.
function setMouse(side, want) {
  const owned = side === 'left' ? Pad._mouseLeft : Pad._mouseRight;
  if (want === owned) return;
  if (side === 'left') {
    Pad._mouseLeft = want;
    Input.mouse.left = want;
    if (want) Input.mouseDown.left = true; else Input.mouseUp.left = true;
  } else {
    Pad._mouseRight = want;
    Input.mouse.right = want;
    if (want) Input.mouseDown.right = true; else Input.mouseUp.right = true;
  }
}

function heldButton(id) {
  if (!Pad.active) return false;
  for (const t of Pad.touches.values()) if (t.claim === 'btn:' + id) return true;
  return false;
}

export function updateTouchPad(game, dt = 0) {
  const g = padLayout();
  Pad.geom = g;

  const p = game.player;
  Pad.active = !!Options.mobileControls && game.screen === 'playing'
    && !game.invOpen && !game.fold && !game.forge && !game.debugOpen
    && !game.cutscene.active && !!p && !p.dead;

  drainTouches(game, g, Pad.active);

  // Settle the frame. A pad that just went inactive still has to let go of
  // everything it was holding, or the player keeps running after the
  // inventory opens.
  syncSticks(Pad.active, g);

  if (Pad.active) {
    if (!Pad.cursorReady) {
      Pad.cursor.x = p.x + (p.facing < 0 ? -48 : 48);
      Pad.cursor.y = p.cy;
      Pad.cursorReady = true;
    }
    // squared response: fine placement near the middle of the throw, quick
    // sweeps out at the edge
    const m = Math.max(0, (Pad.right.mag - AIM_DEAD) / (1 - AIM_DEAD));
    if (m > 0) {
      const speed = (m * m * 0.75 + m * 0.25) * AIM_SPEED * dt / Math.max(Pad.right.mag, 1e-6);
      Pad.cursor.x += Pad.right.x * speed;
      Pad.cursor.y += Pad.right.y * speed;
    }
    Pad.cursor.x = clamp(Pad.cursor.x, AIM_EDGE, VIEW_W - AIM_EDGE);
    Pad.cursor.y = clamp(Pad.cursor.y, AIM_EDGE, VIEW_H - AIM_EDGE);
    // the pad owns the cursor while it is up: there is no real one to respect
    Input.mouse.x = Pad.cursor.x;
    Input.mouse.y = Pad.cursor.y;
  } else {
    Pad.cursorReady = false;
  }

  // AUTO fires while the aim thumb is down, whether or not it is moving, so
  // you can hold the crosshair on something and keep hitting it
  setMouse('left', heldButton('shoot') || (Pad.active && Pad.autoFire && Pad.right.active));
  setMouse('right', heldButton('interact'));
}

// --- drawing --------------------------------------------------------------

function ring(ctx, x, y, r, color, a, width = 1) {
  ctx.strokeStyle = rgba(color, a);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
}

function disc(ctx, x, y, r, color, a) {
  ctx.fillStyle = rgba(color, a);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function drawStick(ctx, c, vec, color, label, a) {
  disc(ctx, c.x, c.y, c.r, '#000000', 0.30 * a);
  ring(ctx, c.x, c.y, c.r, color, 0.55 * a);
  // compass ticks, so the throw of the stick is readable at a glance
  for (let i = 0; i < 4; i++) {
    const ang = i * (TAU / 4);
    const ix = c.x + Math.cos(ang) * (c.r - 4), iy = c.y + Math.sin(ang) * (c.r - 4);
    pxRect(ctx, ix - 0.5, iy - 0.5, 1, 1, rgba(color, 0.5 * a));
  }
  const kx = c.x + vec.x * c.r, ky = c.y + vec.y * c.r;
  if (vec.active) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, kx, ky, c.knob * 2.2, color, 0.20 * a);
    ctx.restore();
  }
  disc(ctx, kx, ky, c.knob, color, (vec.active ? 0.55 : 0.28) * a);
  ring(ctx, kx, ky, c.knob, color, (vec.active ? 1 : 0.6) * a);
  if (!vec.active) drawText(ctx, label, c.x, c.y - 3, rgba(color, 0.5 * a), 1, 'center');
}

function drawButton(ctx, b, down, lit, a, enabled = true) {
  const tint = enabled ? b.tint : Theme.uiDim;
  const k = down ? 1.12 : 1;
  const r = b.r * k;
  const fill = down ? 0.42 : lit ? 0.30 : 0.16;
  if (down || lit) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, b.x, b.y, r * 2.1, tint, (down ? 0.22 : 0.12) * a);
    ctx.restore();
  }
  disc(ctx, b.x, b.y, r, '#000000', 0.34 * a);
  disc(ctx, b.x, b.y, r, tint, fill * a);
  ring(ctx, b.x, b.y, r, tint, (down || lit ? 1 : 0.62) * a);
  drawText(ctx, b.label, b.x, b.y - 3, rgba(enabled ? '#ffffff' : Theme.uiDim, (down || lit ? 1 : 0.8) * a), 1, 'center');
}

export function drawTouchPad(ctx, game) {
  if (!Pad.active || !Pad.geom) return;
  const g = Pad.geom;
  const a = clamp(Options.touchOpacity ?? 0.6, 0.15, 1);
  const p = game.player;

  drawStick(ctx, g.left, Pad.left, Theme.ui, 'MOVE', a);
  drawStick(ctx, g.right, Pad.right, Theme.uiAccent, 'AIM', a);

  for (const b of g.buttons) {
    const down = heldButton(b.id);
    let lit = false;
    let enabled = true;
    if (b.id === 'autoFire') lit = Pad.autoFire;
    if (b.id === 'grapple') enabled = !!p && p.inventory.has('graplinghook');
    drawButton(ctx, b, down, lit, a, enabled);
  }

  // pause draws its own glyph: the font has no bar character
  const q = g.pause;
  disc(ctx, q.x, q.y, q.r, '#000000', 0.34 * a);
  disc(ctx, q.x, q.y, q.r, Theme.uiDim, 0.16 * a);
  ring(ctx, q.x, q.y, q.r, Theme.uiDim, 0.62 * a);
  const bh = Math.round(q.r * 0.72), bw = Math.max(1, Math.round(q.r * 0.16));
  pxRect(ctx, q.x - bw * 2, q.y - bh / 2, bw, bh, rgba('#ffffff', 0.8 * a));
  pxRect(ctx, q.x + bw, q.y - bh / 2, bw, bh, rgba('#ffffff', 0.8 * a));
}
