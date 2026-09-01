// Arena backdrop, platforms, pickups, portal and the wave composer.
import { clamp, lerp, rand, randInt, choice, rgba, TAU, dist } from './util.js';
import { Theme } from './theme.js';
import { pxRect, glowDot, spawnParticle, burst } from './gfx.js';
import { VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER, BLOCK } from './config.js';
import { ITEMS, RARITY, drawItemIcon } from './items.js';
import { Sfx } from './audio.js';

// --- background ----------------------------------------------------------

const stars = [];
const motes = [];
for (let i = 0; i < 70; i++) {
  stars.push({ x: rand(VIEW_W), y: rand(GROUND_Y - 20), s: Math.random() < 0.25 ? 2 : 1, p: rand(TAU), sp: rand(0.6, 2.2) });
}
for (let i = 0; i < 40; i++) {
  motes.push({ x: rand(VIEW_W), y: rand(VIEW_H), vy: rand(-9, -3), vx: rand(-6, 6), s: Math.random() < 0.2 ? 2 : 1, p: rand(TAU) });
}

export function updateWorld(dt) {
  // drifting platforms: record dx so riders can be carried with them
  for (const p of PLATFORMS) {
    if (!p.drift) continue;
    const d = p.drift;
    const before = p.x;
    p.x += d.speed * d.dir * dt;
    if (p.x <= d.min) { p.x = d.min; d.dir = 1; }
    if (p.x >= d.max) { p.x = d.max; d.dir = -1; }
    p.dx = p.x - before;
  }
  for (const m of motes) {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.y < -4) { m.y = VIEW_H + 4; m.x = rand(VIEW_W); }
    if (m.x < -4) m.x = VIEW_W + 4;
    if (m.x > VIEW_W + 4) m.x = -4;
  }
}

export function drawBackground(ctx, t, roomIndex) {
  // sky gradient
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, Theme.bgFar);
  g.addColorStop(0.55, Theme.bgMid);
  g.addColorStop(1, Theme.bgNear);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // stars
  for (const s of stars) {
    const a = 0.35 + 0.45 * Math.sin(t * s.sp + s.p);
    pxRect(ctx, s.x, s.y, s.s, s.s, rgba(Theme.star, a));
  }

  // far arches / pillars (parallax by room so each room reads differently)
  const seed = roomIndex * 37;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 6; i++) {
    const w = 26 + ((seed + i * 53) % 5) * 6;
    const x = ((i * 97 + seed * 13) % (VIEW_W + 60)) - 30;
    const h = 90 + ((seed + i * 31) % 7) * 12;
    pxRect(ctx, x, GROUND_Y - h, w, h, Theme.fog);
    pxRect(ctx, x, GROUND_Y - h, w, 3, rgba(Theme.platformGlow, 0.25));
    // window slits
    for (let k = 0; k < 3; k++) {
      pxRect(ctx, x + w / 2 - 2, GROUND_Y - h + 18 + k * 22, 4, 8, rgba(Theme.platformGlow, 0.18 + 0.12 * Math.sin(t * 1.5 + i + k)));
    }
  }
  ctx.restore();

  // nearer haze band
  ctx.fillStyle = rgba(Theme.bgNear, 0.55);
  ctx.fillRect(0, GROUND_Y - 46, VIEW_W, 46);

  // floating motes
  for (const m of motes) {
    const a = 0.25 + 0.35 * Math.sin(t * 2 + m.p);
    pxRect(ctx, m.x, m.y, m.s, m.s, rgba(Theme.platformGlow, a));
  }
}

export function drawArena(ctx, t) {
  // ground
  pxRect(ctx, 0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y, Theme.ground);
  pxRect(ctx, 0, GROUND_Y, VIEW_W, 3, Theme.groundTop);
  // glowing rune line along the floor
  for (let x = 6; x < VIEW_W; x += BLOCK) {
    const a = 0.25 + 0.35 * Math.sin(t * 2 + x * 0.07);
    pxRect(ctx, x, GROUND_Y + 5, 4, 1, rgba(Theme.groundEdge, a));
  }
  // floor bricks
  for (let x = 0; x < VIEW_W; x += 16) {
    pxRect(ctx, x, GROUND_Y + 3, 1, VIEW_H - GROUND_Y - 3, rgba('#000000', 0.25));
  }
  ctx.fillStyle = rgba(Theme.groundEdge, 0.12);
  ctx.fillRect(0, GROUND_Y - 6, VIEW_W, 6);

  // platforms
  for (const p of PLATFORMS) {
    pxRect(ctx, p.x, p.y, p.w, p.h, Theme.platform);
    pxRect(ctx, p.x, p.y, p.w, 2, Theme.platformTop);
    const a = 0.35 + 0.3 * Math.sin(t * 2.4 + p.x * 0.05);
    pxRect(ctx, p.x, p.y + p.h, p.w, 1, rgba(Theme.platformGlow, a));
    if (p.drift) {
      // no struts - it floats, with thrusters underneath
      const pulse = 0.35 + 0.25 * Math.sin(t * 8 + p.x * 0.1);
      for (const ox of [10, p.w / 2, p.w - 10]) {
        pxRect(ctx, p.x + ox - 1, p.y + p.h, 2, 3, rgba(Theme.platformGlow, pulse));
        glowDot(ctx, p.x + ox, p.y + p.h + 3, 7, Theme.platformGlow, pulse * 0.5);
      }
      // direction chevrons on the deck
      const dir = p.drift.dir;
      for (let i = 0; i < 3; i++) {
        const cx2 = p.x + p.w / 2 + (i - 1) * 8 + Math.sin(t * 3 + i) * 1;
        pxRect(ctx, cx2, p.y + 3, 2, 2, rgba(Theme.groundEdge, 0.5));
        pxRect(ctx, cx2 + dir * 2, p.y + 4, 2, 2, rgba(Theme.groundEdge, 0.3));
      }
    } else {
      // support struts
      pxRect(ctx, p.x + 4, p.y + p.h, 2, 5, rgba(Theme.platform, 0.7));
      pxRect(ctx, p.x + p.w - 6, p.y + p.h, 2, 5, rgba(Theme.platform, 0.7));
    }
    // block seams (4-block center platform reads clearly)
    for (let x = p.x + BLOCK; x < p.x + p.w; x += BLOCK) {
      pxRect(ctx, x, p.y, 1, p.h, rgba('#000000', 0.28));
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
  constructor(itemId, x, y, group = null) {
    this.itemId = itemId;
    this.x = x;
    this.y = y;
    this.t = rand(0, 5);
    this.dead = false;
    this.born = 0;
    this.group = group;      // choice pickups share a group id
    this.disabled = false;   // the offer you did not take
  }
  update(dt) {
    this.t += dt;
    this.born += dt;
    if (this.disabled) return;
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
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 4; i >= 0; i--) {
      const a = 0.10 + 0.05 * Math.sin(this.t * 3 + i);
      ctx.fillStyle = rgba(i % 2 ? Theme.platformGlow : Theme.uiAccent, a);
      ctx.beginPath();
      ctx.ellipse(this.x, cy, (w / 2) * (1 + i * 0.12), (h / 2) * (1 + i * 0.12), 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = rgba(Theme.bgFar, 0.85);
    ctx.beginPath();
    ctx.ellipse(this.x, cy, w / 2, h / 2, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(Theme.platformGlow, 0.9);
    ctx.lineWidth = 1;
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = this.t * 1.6 + (i / 8) * TAU;
      pxRect(ctx, this.x + Math.cos(a) * (w / 2 - 2), cy + Math.sin(a) * (h / 2 - 2), 1, 1, rgba('#ffffff', 0.8));
    }
  }
}

// --- wave composition ----------------------------------------------------

// The first two rooms are a deliberately soft on-ramp: 1 then 2 enemies in
// room 1, 2 then 3 in room 2. From room 3 the normal scaling takes over.
const EARLY_WAVE_COUNTS = { 1: [1, 2], 2: [2, 3] };

export function buildWave(roomIndex, waveIndex) {
  const pool = ['grunt'];
  if (roomIndex >= 2 || waveIndex === 2) pool.push('stinger');
  if (roomIndex >= 2) pool.push('brute');
  if (roomIndex >= 3) pool.push('lurker');
  if (roomIndex >= 4) pool.push('spitter');
  const base = 3 + Math.floor((roomIndex - 1) / 2);
  const early = EARLY_WAVE_COUNTS[roomIndex];
  const count = early ? early[waveIndex - 1] : clamp(base + (waveIndex === 2 ? 2 : 0), 3, 9);
  const spawns = waveIndex === 1
    ? [SPAWN_LEFT, SPAWN_RIGHT]
    : [SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER];
  const list = [];
  for (let i = 0; i < count; i++) {
    let type = i === 0 && roomIndex === 1 && waveIndex === 1 ? 'grunt' : choice(pool);
    if (roomIndex >= 2 && waveIndex === 2 && i === count - 1) type = 'brute';
    const p = spawns[i % spawns.length];
    list.push({ type, x: p.x + rand(-14, 14), y: p.y, delay: i * 0.45 });
  }
  return list;
}

export function activeSpawnPads(waveIndex) {
  return waveIndex === 1 ? [0, 1] : [0, 1, 2];
}
