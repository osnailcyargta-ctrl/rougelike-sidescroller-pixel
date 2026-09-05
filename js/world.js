// Arena backdrop, platforms, pickups, portal and the wave composer.
import { clamp, lerp, rand, randInt, choice, streamFor, rgba, mixHex, TAU, dist } from './util.js';
import { Theme } from './theme.js';
import { pxRect, glowDot, spawnParticle, burst, linGrad } from './gfx.js';
import { VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER, BLOCK, WAVES, ANVIL, SEEDED_THROUGH_ROOM } from './config.js';
import { ITEMS, RARITY, drawItemIcon } from './items.js';
import { Sfx } from './audio.js';
import { Options } from './settings.js';

// --- background ----------------------------------------------------------

const stars = [];
const motes = [];
const fog = [];
// Three tower layers at different depths; each scrolls at its own rate.
const TOWER_LAYERS = [
  { count: 9, minH: 70, maxH: 130, minW: 18, maxW: 30, alpha: 0.34, par: 0.10, tint: 0.0, lit: 0.10 },
  { count: 7, minH: 100, maxH: 175, minW: 26, maxW: 44, alpha: 0.52, par: 0.22, tint: 0.30, lit: 0.26 },
  { count: 5, minH: 130, maxH: 215, minW: 34, maxW: 58, alpha: 0.72, par: 0.38, tint: 0.6, lit: 0.45 },
];
const towers = [];

for (let i = 0; i < 90; i++) {
  stars.push({
    x: rand(VIEW_W), y: rand(GROUND_Y - 30), s: Math.random() < 0.2 ? 2 : 1,
    p: rand(TAU), sp: rand(0.6, 2.4), warm: Math.random() < 0.25,
  });
}
for (let i = 0; i < 46; i++) {
  motes.push({
    x: rand(VIEW_W), y: rand(VIEW_H), vy: rand(-11, -3), vx: rand(-7, 7),
    s: Math.random() < 0.18 ? 2 : 1, p: rand(TAU), depth: rand(0.4, 1),
    warm: Math.random() < 0.3,
  });
}
for (let i = 0; i < 7; i++) {
  fog.push({ x: rand(VIEW_W), y: rand(GROUND_Y - 90, GROUND_Y + 10), r: rand(60, 130), vx: rand(-5, 5), a: rand(0.05, 0.12) });
}

// Deterministic per-room tower layout, rebuilt only when the room changes.
let towerRoom = -1;
function buildTowers(roomIndex) {
  towers.length = 0;
  let seed = roomIndex * 9871 + 13;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let l = 0; l < TOWER_LAYERS.length; l++) {
    const L = TOWER_LAYERS[l];
    for (let i = 0; i < L.count; i++) {
      const w = L.minW + rnd() * (L.maxW - L.minW);
      towers.push({
        layer: l,
        x: (i + rnd() * 0.7) * (VIEW_W / L.count) - 20,
        w,
        h: L.minH + rnd() * (L.maxH - L.minH),
        seed: rnd() * 10,
        windows: Math.floor(2 + rnd() * 4),
      });
    }
  }
  towerRoom = roomIndex;
}

// `frozen` holds the platforms still while the game is paused - an inventory,
// the fold wheel, the forge, the pause menu. Ambience keeps drifting, because
// nothing rides on it.
export function updateWorld(dt, frozen = false) {
  // drifting platforms: record dx so riders can be carried with them
  for (const p of PLATFORMS) {
    if (!p.drift) continue;
    if (frozen) { p.dx = 0; continue; }
    const d = p.drift;
    const before = p.x;
    p.x += d.speed * d.dir * dt;
    if (p.x <= d.min) { p.x = d.min; d.dir = 1; }
    if (p.x >= d.max) { p.x = d.max; d.dir = -1; }
    p.dx = p.x - before;
  }
  for (const m of motes) {
    m.x += m.vx * dt * m.depth;
    m.y += m.vy * dt * m.depth;
    if (m.y < -4) { m.y = VIEW_H + 4; m.x = rand(VIEW_W); }
    if (m.x < -4) m.x = VIEW_W + 4;
    if (m.x > VIEW_W + 4) m.x = -4;
  }
  for (const f of fog) {
    f.x += f.vx * dt;
    if (f.x < -f.r) f.x = VIEW_W + f.r;
    if (f.x > VIEW_W + f.r) f.x = -f.r;
  }
}

export function drawBackground(ctx, t, roomIndex) {
  // --- sky
  ctx.fillStyle = linGrad(ctx, 'sky', 0, 0, 0, VIEW_H, [
    [0, Theme.bgFar], [0.45, Theme.bgMid], [0.82, Theme.bgNear], [1, Theme.fog],
  ]);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // horizon bloom behind the skyline
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const hg = ctx.createRadialGradient(VIEW_W / 2, GROUND_Y - 10, 0, VIEW_W / 2, GROUND_Y - 10, 260);
  hg.addColorStop(0, rgba(Theme.platformGlow, 0.08));
  hg.addColorStop(1, rgba(Theme.platformGlow, 0));
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.restore();

  // --- stars
  for (const s of stars) {
    const a = 0.3 + 0.5 * Math.sin(t * s.sp + s.p);
    pxRect(ctx, s.x, s.y, s.s, s.s, rgba(s.warm ? Theme.uiAccent : Theme.star, a));
  }

  // --- light shafts falling from above
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const x = ((i * 173 + roomIndex * 61) % VIEW_W);
    const sway = Math.sin(t * 0.35 + i * 2) * 12;
    const w = 26 + i * 10;
    const sg = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sg.addColorStop(0, rgba(Theme.platformGlow, 0.05));
    sg.addColorStop(1, rgba(Theme.platformGlow, 0));
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(x - w / 3 + sway, 0);
    ctx.lineTo(x + w / 3 + sway, 0);
    ctx.lineTo(x + w + sway * 1.6, GROUND_Y);
    ctx.lineTo(x - w + sway * 1.6, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // --- parallax skyline
  if (towerRoom !== roomIndex) buildTowers(roomIndex);
  for (let l = 0; l < TOWER_LAYERS.length; l++) {
    const L = TOWER_LAYERS[l];
    ctx.save();
    ctx.globalAlpha = L.alpha;
    for (const tw of towers) {
      if (tw.layer !== l) continue;
      const x = Math.round(tw.x + Math.sin(t * 0.05 + tw.seed) * 2 * L.par);
      const top = Math.round(GROUND_Y - tw.h);
      const body = mixHex(mixHex(Theme.fog, Theme.bgFar, 0.45), Theme.bgNear, 1 - L.tint);
      pxRect(ctx, x, top, tw.w, tw.h, body);
      // lit cap and a rim on the light side
      pxRect(ctx, x, top, tw.w, 2, rgba(Theme.platformGlow, 0.10 + L.lit * 0.20));
      pxRect(ctx, x, top, 1, tw.h, rgba(Theme.platformGlow, 0.06 + L.lit * 0.10));
      // windows
      for (let k = 0; k < tw.windows; k++) {
        const wy = top + 14 + k * 26;
        if (wy > GROUND_Y - 14) break;
        const flick = 0.10 + L.lit * 0.35 * (0.6 + 0.4 * Math.sin(t * (1 + k * 0.4) + tw.seed * 3));
        pxRect(ctx, x + 4, wy, 3, 6, rgba(Theme.platformGlow, flick));
        if (tw.w > 30) pxRect(ctx, x + tw.w - 8, wy + 6, 3, 6, rgba(Theme.uiAccent, flick * 0.6));
      }
    }
    ctx.restore();
  }

  // --- fog banks
  ctx.save();
  for (const f of fog) {
    const fg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
    fg.addColorStop(0, rgba(Theme.fog, f.a));
    fg.addColorStop(1, rgba(Theme.fog, 0));
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // near haze band just above the floor
  ctx.fillStyle = linGrad(ctx, 'haze', 0, GROUND_Y - 52, 0, GROUND_Y, [
    [0, rgba(Theme.bgNear, 0)], [1, rgba(Theme.bgNear, 0.5)],
  ]);
  ctx.fillRect(0, GROUND_Y - 52, VIEW_W, 52);

  // --- ambient motes, brighter the closer they are
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    const a = (0.16 + 0.34 * Math.sin(t * 2 + m.p)) * m.depth;
    pxRect(ctx, m.x, m.y, m.s, m.s, rgba(m.warm ? Theme.uiAccent : Theme.platformGlow, a));
  }
  ctx.restore();
}

// Slow shafts of light raking down through the room. Drawn under everything,
// over the skyline, and they drift on their own clock.
const SHAFTS = [];
for (let i = 0; i < 5; i++) {
  SHAFTS.push({
    x: 40 + i * 96 + rand(-24, 24),
    w: rand(26, 58),
    lean: rand(-0.34, 0.34),
    speed: rand(2.6, 7.5),
    phase: rand(0, TAU),
    a: rand(0.030, 0.062),
  });
}

export function drawLightShafts(ctx, t) {
  const amt = Options.shafts ?? 1;
  if (amt <= 0.001) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sh of SHAFTS) {
    const drift = Math.sin(t * 0.09 + sh.phase) * 26;
    const x = sh.x + drift;
    const breathe = 0.65 + 0.35 * Math.sin(t * 0.31 + sh.phase);
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, rgba(Theme.platformGlow, sh.a * breathe * amt));
    g.addColorStop(0.65, rgba(Theme.platformGlow, sh.a * breathe * 0.35 * amt));
    g.addColorStop(1, rgba(Theme.platformGlow, 0));
    ctx.fillStyle = g;
    const spread = sh.w * 1.9;
    ctx.beginPath();
    ctx.moveTo(x - sh.w / 2, -4);
    ctx.lineTo(x + sh.w / 2, -4);
    ctx.lineTo(x + spread / 2 + sh.lean * GROUND_Y, GROUND_Y);
    ctx.lineTo(x - spread / 2 + sh.lean * GROUND_Y, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    // dust caught in the beam
    const dustN = 3;
    for (let i = 0; i < dustN; i++) {
      const k = ((t * sh.speed * 0.02 + i / dustN + sh.phase) % 1);
      const dy = k * GROUND_Y;
      const dx = x + sh.lean * dy + Math.sin(t * 0.7 + i * 2 + sh.phase) * sh.w * 0.35;
      pxRect(ctx, dx, dy, 1, 1, rgba('#ffffff', (1 - k) * 0.20 * breathe * amt));
    }
  }
  ctx.restore();
}

export function drawArena(ctx, t) {
  // --- floor
  ctx.fillStyle = linGrad(ctx, 'floor', 0, GROUND_Y, 0, VIEW_H, [
    [0, Theme.ground], [1, mixHex(Theme.ground, '#000000', 0.45)],
  ]);
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  pxRect(ctx, 0, GROUND_Y, VIEW_W, 1, Theme.groundTop);
  pxRect(ctx, 0, GROUND_Y + 1, VIEW_W, 2, mixHex(Theme.groundTop, Theme.ground, 0.5));

  // wet sheen: a soft reflection of the light above the floor line
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = linGrad(ctx, 'sheen', 0, GROUND_Y, 0, GROUND_Y + 16, [
    [0, rgba(Theme.groundEdge, 0.16)], [1, rgba(Theme.groundEdge, 0)],
  ]);
  ctx.fillRect(0, GROUND_Y, VIEW_W, 16);
  ctx.restore();

  // glow line and travelling runes along the floor
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba(Theme.groundEdge, 0.14);
  ctx.fillRect(0, GROUND_Y - 5, VIEW_W, 5);
  ctx.restore();
  for (let x = 6; x < VIEW_W; x += BLOCK) {
    const a = 0.2 + 0.4 * Math.sin(t * 2 + x * 0.07);
    pxRect(ctx, x, GROUND_Y + 5, 4, 1, rgba(Theme.groundEdge, a));
  }
  // brick seams, offset per row
  for (let row = 0; row < 3; row++) {
    const y = GROUND_Y + 3 + row * 11;
    if (y > VIEW_H) break;
    pxRect(ctx, 0, y, VIEW_W, 1, rgba('#000000', 0.22));
    for (let x = row % 2 ? 0 : 8; x < VIEW_W; x += 16) {
      pxRect(ctx, x, y, 1, 11, rgba('#000000', 0.26));
      pxRect(ctx, x + 1, y + 1, 1, 9, rgba(Theme.groundTop, 0.05));
    }
  }

  // --- platforms
  for (const p of PLATFORMS) {
    // light pooling on the ground beneath each platform
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pool = ctx.createRadialGradient(p.x + p.w / 2, p.y + p.h + 6, 0, p.x + p.w / 2, p.y + p.h + 6, p.w * 0.6);
    pool.addColorStop(0, rgba(Theme.platformGlow, 0.10));
    pool.addColorStop(1, rgba(Theme.platformGlow, 0));
    ctx.fillStyle = pool;
    ctx.fillRect(p.x - 20, p.y, p.w + 40, 40);
    ctx.restore();

    ctx.fillStyle = linGrad(ctx, 'plat' + p.y, 0, p.y, 0, p.y + p.h, [
      [0, Theme.platformTop], [0.3, Theme.platform], [1, mixHex(Theme.platform, '#000000', 0.4)],
    ]);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.w), Math.round(p.h));
    pxRect(ctx, p.x, p.y, p.w, 1, mixHex(Theme.platformTop, Theme.platformGlow, 0.45));   // rim light
    const a = 0.35 + 0.3 * Math.sin(t * 2.4 + p.x * 0.05);
    pxRect(ctx, p.x, p.y + p.h, p.w, 1, rgba(Theme.platformGlow, a));

    if (p.drift) {
      const pulse = 0.35 + 0.25 * Math.sin(t * 8 + p.x * 0.1);
      for (const ox of [10, p.w / 2, p.w - 10]) {
        pxRect(ctx, p.x + ox - 1, p.y + p.h, 2, 3, rgba(Theme.platformGlow, pulse));
        glowDot(ctx, p.x + ox, p.y + p.h + 3, 8, Theme.platformGlow, pulse * 0.55);
      }
      const dir = p.drift.dir;
      for (let i = 0; i < 3; i++) {
        const cx2 = p.x + p.w / 2 + (i - 1) * 8 + Math.sin(t * 3 + i) * 1;
        pxRect(ctx, cx2, p.y + 3, 2, 2, rgba(Theme.groundEdge, 0.5));
        pxRect(ctx, cx2 + dir * 2, p.y + 4, 2, 2, rgba(Theme.groundEdge, 0.3));
      }
    } else {
      pxRect(ctx, p.x + 4, p.y + p.h, 2, 5, rgba(Theme.platform, 0.7));
      pxRect(ctx, p.x + p.w - 6, p.y + p.h, 2, 5, rgba(Theme.platform, 0.7));
    }
    for (let x = p.x + BLOCK; x < p.x + p.w; x += BLOCK) {
      pxRect(ctx, x, p.y, 1, p.h, rgba('#000000', 0.28));
      pxRect(ctx, x + 1, p.y + 1, 1, p.h - 2, rgba(Theme.platformTop, 0.12));
    }
  }
}

// Spawn pads glow while a wave is inbound.
export function drawSpawnPads(ctx, t, active) {
  const pads = [SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    const on = active.includes(i);
    const a = on ? 0.4 + 0.4 * Math.sin(t * 9 + i) : 0.12;
    pxRect(ctx, p.x - 10, p.y - 1, 20, 1, rgba(Theme.enemyGrunt, a));
    if (on) {
      glowDot(ctx, p.x, p.y - 4, 16, Theme.enemyGrunt, a * 0.5);
      if (Math.random() < 0.3) {
        spawnParticle({
          x: p.x + rand(-9, 9), y: p.y - 1, vx: rand(-6, 6), vy: rand(-30, -10),
          life: rand(0.3, 0.7), size: 1, color: Theme.enemyGrunt, gravity: -20, kind: 'shrink',
        });
      }
    }
  }
}

// --- pickups -------------------------------------------------------------

export class Pickup {
  constructor(itemId, x, y, group = null, opts = {}) {
    this.itemId = itemId;
    this.x = x;
    this.y = y;
    this.t = rand(0, 5);
    this.dead = false;
    this.born = 0;
    this.group = group;      // choice pickups share a group id
    this.disabled = false;   // the offer you did not take
    // A drop torn out of an enemy falls from where it died; the ones placed on
    // the centre platform are simply put there and never move.
    this.falling = !!opts.falling;
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? 0;
    this.landed = !this.falling;
  }

  // Simple arc: gravity, one soft bounce, then it settles wherever it lands.
  updateFall(dt) {
    this.vy += 620 * dt;
    const py = this.y;
    this.x = clamp(this.x + this.vx * dt, 6, VIEW_W - 6);
    this.y += this.vy * dt;
    this.vx *= Math.pow(0.25, dt);
    let floor = GROUND_Y;
    for (const pl of PLATFORMS) {
      if (this.x < pl.x - 2 || this.x > pl.x + pl.w + 2) continue;
      const top = pl.y;
      if (py <= top + 1 && this.y >= top && this.vy > 0) floor = Math.min(floor, top);
    }
    if (this.y >= floor) {
      this.y = floor;
      if (this.vy > 90) {
        this.vy *= -0.34;                       // one small bounce
        this.vx *= 0.5;
        burst(this.x, this.y, 6, {
          color: RARITY[ITEMS[this.itemId].rarity].color, speedMin: 20, speedMax: 80,
          lifeMin: 0.15, lifeMax: 0.4, gravity: 300, angle: -Math.PI / 2, spread: 1.1,
        });
      } else {
        this.vy = 0;
        this.vx = 0;
        this.falling = false;
        this.landed = true;
      }
    }
  }

  update(dt) {
    this.t += dt;
    this.born += dt;
    if (this.disabled) return;
    if (this.falling) {
      this.updateFall(dt);
      if (Math.random() < dt * 40) {
        spawnParticle({
          x: this.x + rand(-3, 3), y: this.y - 8 + rand(-4, 4), vx: rand(-12, 12), vy: rand(-8, 8),
          life: rand(0.15, 0.4), size: 1, color: RARITY[ITEMS[this.itemId].rarity].color,
          gravity: 0, kind: 'streak',
        });
      }
      return;
    }
    if (Math.random() < dt * 6) {
      spawnParticle({
        x: this.x + rand(-6, 6), y: this.y + rand(-8, 2), vx: rand(-5, 5), vy: rand(-22, -8),
        life: rand(0.3, 0.7), size: 1, color: RARITY[ITEMS[this.itemId].rarity].color, gravity: -15, kind: 'shrink',
      });
    }
  }
  draw(ctx) {
    const def = ITEMS[this.itemId];
    const col = RARITY[def.rarity].color;
    const bob = this.disabled ? 0 : Math.sin(this.t * 2.4) * 2.5;
    const y = this.y - 14 + bob;
    const pop = clamp(this.born * 4, 0, 1);
    if (this.disabled) {
      // the offer you passed on: greyed out and dimmed, still visible
      ctx.save();
      ctx.globalAlpha = 0.8;
      if ('filter' in ctx) ctx.filter = 'grayscale(1)';
      ctx.translate(this.x, y + 6);
      drawItemIcon(ctx, this.itemId, -6, -6, 12, 0);
      ctx.restore();
      return;
    }
    glowDot(ctx, this.x, y + 6, 18 * pop, col, 0.4);
    // an orbit of motes around the item, which is what makes it read as loot
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const a = this.t * 1.5 + (i / 5) * TAU;
      const rr = 9 + Math.sin(this.t * 2 + i) * 2;
      const oy2 = Math.sin(a) * rr * 0.34;
      const depth = 0.35 + 0.65 * ((Math.sin(a) + 1) / 2);
      pxRect(ctx, this.x + Math.cos(a) * rr, y + 6 + oy2, 1, 1, rgba(col, depth * 0.85));
    }
    ctx.restore();
    // beam of light
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grd = ctx.createLinearGradient(0, y - 30, 0, this.y);
    grd.addColorStop(0, rgba(col, 0));
    grd.addColorStop(1, rgba(col, 0.28));
    ctx.fillStyle = grd;
    ctx.fillRect(this.x - 5, y - 30, 10, 30 + 14);
    ctx.restore();
    ctx.save();
    ctx.translate(this.x, y + 6);
    ctx.scale(pop, pop);
    drawItemIcon(ctx, this.itemId, -6, -6, 12, this.t);
    ctx.restore();
  }
}

// An anvil bolted to the drifting platform, so it slides with it. Every second
// room has one; right-click it to open the forge.
export class Anvil {
  constructor(platform) {
    this.platform = platform;
    this.x = platform.x + platform.w / 2;
    this.y = platform.y;
    this.t = 0;
    this.spark = 0;
    this.near = 0;                 // eased: is the player close enough to use it
  }

  update(dt, player) {
    this.t += dt;
    // ride the platform exactly, however it drifts
    this.x = this.platform.x + this.platform.w / 2;
    this.y = this.platform.y;
    const inReach = player && !player.dead &&
      Math.hypot(player.x - this.x, player.cy - (this.y - 8)) < ANVIL.reach;
    this.near += ((inReach ? 1 : 0) - this.near) * Math.min(1, dt * 8);

    // it is always working: embers off the hot face, and sparks when struck
    if (Math.random() < dt * 26) {
      spawnParticle({
        x: this.x + rand(-9, 9), y: this.y - 15,
        vx: rand(-12, 12), vy: rand(-34, -10), life: rand(0.5, 1.4),
        size: 1, color: Math.random() < 0.35 ? '#fff0a0' : '#ff8a3c',
        gravity: -18, drag: 0.97, kind: 'shrink',
      });
    }
    this.spark -= dt;
    if (this.spark <= 0) {
      this.spark = rand(0.7, 2.0);
      for (let i = 0; i < 8; i++) {
        spawnParticle({
          x: this.x + rand(-7, 7), y: this.y - 16,
          vx: rand(-90, 90), vy: rand(-130, -40), life: rand(0.25, 0.6),
          size: 1, color: i % 3 === 0 ? '#ffffff' : '#ffb43c',
          gravity: 420, drag: 0.92, kind: 'streak',
        });
      }
    }
  }

  draw(ctx) {
    const bob = Math.sin(this.t * 1.6) * 0.6;
    const y = Math.round(this.y - 20 + bob);
    const x = Math.round(this.x);
    const pulse = 0.6 + 0.4 * Math.sin(this.t * 2.6);

    // the light it throws: a column above and a pool on the platform
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const col = ctx.createLinearGradient(0, y - 26, 0, this.y + 4);
    col.addColorStop(0, rgba('#ff8a3c', 0));
    col.addColorStop(1, rgba('#ff8a3c', 0.20 + pulse * 0.08));
    ctx.fillStyle = col;
    ctx.fillRect(x - 20, y - 26, 40, 34);
    ctx.restore();
    glowDot(ctx, x, y + 12, 34 + pulse * 6, '#ff8a3c', 0.26);
    glowDot(ctx, x, y + 6, 16, '#fff0a0', 0.22 * pulse);

    // the block. Wide face, waist, splayed base, and a horn on the left
    pxRect(ctx, x - 15, y + 15, 30, 3, rgba('#000000', 0.45));        // contact shadow
    pxRect(ctx, x - 11, y + 12, 22, 5, '#3d4452');                     // base
    pxRect(ctx, x - 11, y + 12, 22, 1, '#5b6473');
    pxRect(ctx, x - 5, y + 6, 10, 6, '#525a69');                       // waist
    pxRect(ctx, x - 14, y, 28, 7, '#6b7484');                          // face
    pxRect(ctx, x - 14, y, 28, 2, '#aeb8c9');                          // top light
    pxRect(ctx, x - 14, y + 6, 28, 1, '#2c3140');
    // horn
    pxRect(ctx, x - 20, y + 1, 6, 4, '#6b7484');
    pxRect(ctx, x - 20, y + 1, 6, 1, '#aeb8c9');
    pxRect(ctx, x - 21, y + 2, 1, 2, '#8d97a8');
    // the heat still in the metal, and a hammer resting on it
    pxRect(ctx, x - 12, y + 1, 24, 1, rgba('#ffb43c', 0.4 + pulse * 0.4));
    pxRect(ctx, x + 2, y - 4, 8, 4, '#5b6473');
    pxRect(ctx, x + 2, y - 4, 8, 1, '#aeb8c9');
    pxRect(ctx, x - 4, y - 3, 7, 2, '#7a4a2a');

    // an ingot glowing on the face
    const hot = 0.5 + 0.5 * Math.sin(this.t * 4);
    pxRect(ctx, x - 10, y - 1, 7, 2, '#ff8a3c');
    pxRect(ctx, x - 9, y - 1, 5, 1, rgba('#fff0a0', hot));

    // in reach: a ring and a prompt-free chevron, so it reads as usable
    if (this.near > 0.02) {
      ctx.save();
      ctx.globalAlpha = this.near;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba('#ffb43c', 0.5 + 0.4 * Math.sin(this.t * 7));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, y + 8, 24, 16, 0, 0, TAU);
      ctx.stroke();
      const cy = y - 12 - Math.sin(this.t * 5) * 1.5;
      ctx.fillStyle = rgba('#ffd76a', 0.9);
      ctx.beginPath();
      ctx.moveTo(x, cy + 4); ctx.lineTo(x - 4, cy - 2); ctx.lineTo(x + 4, cy - 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

export class Portal {
  constructor(x, y) {
    this.x = x; this.y = y; this.t = 0; this.open = 0;
  }
  update(dt) {
    this.t += dt;
    this.open = Math.min(1, this.open + dt * 1.6);
    if (Math.random() < dt * 20) {
      const a = rand(0, TAU);
      spawnParticle({
        x: this.x + Math.cos(a) * 12, y: this.y - 16 + Math.sin(a) * 16,
        vx: -Math.cos(a) * 22, vy: -Math.sin(a) * 22,
        life: rand(0.3, 0.6), size: 1, color: Theme.platformGlow, gravity: 0, kind: 'shrink',
      });
    }
  }
  draw(ctx) {
    const k = this.open;
    const h = 34 * k, w = 20 * k;
    const cy = this.y - 18;
    const breathe = 1 + Math.sin(this.t * 2.2) * 0.05;

    // a pool of its light on the floor
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pool = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, 40 * k);
    pool.addColorStop(0, rgba(Theme.platformGlow, 0.28 * k));
    pool.addColorStop(1, rgba(Theme.platformGlow, 0));
    ctx.fillStyle = pool;
    ctx.fillRect(this.x - 44, this.y - 22, 88, 30);

    // nested haloes
    for (let i = 5; i >= 0; i--) {
      const a = 0.09 + 0.05 * Math.sin(this.t * 3 + i);
      ctx.fillStyle = rgba(i % 2 ? Theme.platformGlow : Theme.uiAccent, a);
      ctx.beginPath();
      ctx.ellipse(this.x, cy, (w / 2) * (1 + i * 0.13) * breathe, (h / 2) * (1 + i * 0.13) * breathe, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // the mouth: dark, with a swirl turning inside it
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(this.x, cy, (w / 2) * breathe, (h / 2) * breathe, 0, 0, TAU);
    ctx.clip();
    ctx.fillStyle = rgba(Theme.bgFar, 0.92);
    ctx.fillRect(this.x - w, cy - h, w * 2, h * 2);
    ctx.globalCompositeOperation = 'lighter';
    for (let arm = 0; arm < 3; arm++) {
      ctx.strokeStyle = rgba(arm % 2 ? Theme.uiAccent : Theme.platformGlow, 0.30);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 22; i++) {
        const u = i / 22;
        const ang = this.t * 1.5 + arm * (TAU / 3) + u * 5.2;
        const rr = u * (w / 2);
        const px = this.x + Math.cos(ang) * rr;
        const py = cy + Math.sin(ang) * rr * (h / w);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();

    // rim, with a bright travelling highlight
    ctx.strokeStyle = rgba(Theme.platformGlow, 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(this.x, cy, (w / 2) * breathe, (h / 2) * breathe, 0, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 10; i++) {
      const a = this.t * 1.6 + (i / 10) * TAU;
      const bright = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(a - this.t * 3)), 6);
      pxRect(ctx, this.x + Math.cos(a) * (w / 2 - 1) * breathe,
             cy + Math.sin(a) * (h / 2 - 1) * breathe, 1, 1, rgba('#ffffff', bright));
    }
  }
}

// --- wave composition ----------------------------------------------------

// The first two rooms are a deliberately soft on-ramp: 1 then 2 enemies in
// room 1, 2 then 3 in room 2. From room 3 the normal scaling takes over.
const EARLY_WAVE_COUNTS = { 1: [1, 2], 2: [2, 3] };

export function buildWave(roomIndex, waveIndex) {
  const pool = ['grunt'];
  // From room 10 the plain Stinger stops turning up at all: what comes out of
  // the dark instead is the Mutant, and what it leaves behind is more of them.
  if (roomIndex >= 2 || waveIndex === 2) pool.push(roomIndex >= 10 ? 'mutantstinger' : 'stinger');
  if (roomIndex >= 2) pool.push('brute');
  if (roomIndex >= 3) pool.push('lurker');
  if (roomIndex >= 4) pool.push('spitter');
  if (roomIndex >= 6) pool.push('shardling');   // golem wreckage, post room 5
  if (roomIndex >= 6) pool.push('wisp');        // and its lamplighter
  // Past room 12 the enemies stop getting stronger, so the rooms get fuller
  // instead. A wave never sends more than the cap, however deep you are.
  const base = 3 + Math.floor((roomIndex - 1) / 2) + Math.max(0, roomIndex - 12);
  const early = EARLY_WAVE_COUNTS[roomIndex];
  const count = early ? early[waveIndex - 1]
    : clamp(base + (waveIndex === 2 ? 2 : 0), 3, WAVES.maxPerWave);
  const spawns = waveIndex === 1
    ? [SPAWN_LEFT, SPAWN_RIGHT]
    : [SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER];
  const list = [];
  // Through room 15 this wave has its own stream, so the same seed always
  // sends the same enemies to the same places no matter what you did on the
  // way here. Past it the rooms go off-script and use the loose generator.
  const seeded = roomIndex <= SEEDED_THROUGH_ROOM;
  const r = seeded ? streamFor(`wave:${roomIndex}:${waveIndex}`) : null;
  const pick = (arr) => (r ? arr[Math.floor(r() * arr.length)] : choice(arr));
  const jitter = () => (r ? -14 + r() * 28 : rand(-14, 14));
  for (let i = 0; i < count; i++) {
    let type = i === 0 && roomIndex === 1 && waveIndex === 1 ? 'grunt' : pick(pool);
    if (roomIndex >= 2 && waveIndex === 2 && i === count - 1) type = 'brute';
    // a Wisp with nothing to feed is just a free kill, so never lead with one
    if (type === 'wisp' && (i === 0 || list.filter((e) => e.type === 'wisp').length >= 1)) {
      type = pick(pool.filter((id) => id !== 'wisp'));
    }
    const p = spawns[i % spawns.length];
    list.push({ type, x: p.x + jitter(), y: p.y, delay: i * 0.45 });
  }
  return list;
}

export function activeSpawnPads(waveIndex) {
  return waveIndex === 1 ? [0, 1] : [0, 1, 2];
}
