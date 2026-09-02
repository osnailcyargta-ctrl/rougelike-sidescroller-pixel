// Arena backdrop, platforms, pickups, portal and the wave composer.
import { clamp, lerp, rand, randInt, choice, srand, schoice, rgba, mixHex, TAU, dist } from './util.js';
import { Theme } from './theme.js';
import { pxRect, glowDot, spawnParticle, burst, linGrad } from './gfx.js';
import { VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER, BLOCK } from './config.js';
import { ITEMS, RARITY, drawItemIcon } from './items.js';
import { Sfx } from './audio.js';

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
  if (roomIndex >= 6) pool.push('shardling');   // golem wreckage, post room 5
  if (roomIndex >= 6) pool.push('wisp');        // and its lamplighter
  const base = 3 + Math.floor((roomIndex - 1) / 2);
  const early = EARLY_WAVE_COUNTS[roomIndex];
  const count = early ? early[waveIndex - 1] : clamp(base + (waveIndex === 2 ? 2 : 0), 3, 9);
  const spawns = waveIndex === 1
    ? [SPAWN_LEFT, SPAWN_RIGHT]
    : [SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER];
  const list = [];
  // every roll here is seeded, so the same seed always sends the same waves
  for (let i = 0; i < count; i++) {
    let type = i === 0 && roomIndex === 1 && waveIndex === 1 ? 'grunt' : schoice(pool);
    if (roomIndex >= 2 && waveIndex === 2 && i === count - 1) type = 'brute';
    // a Wisp with nothing to feed is just a free kill, so never lead with one
    if (type === 'wisp' && (i === 0 || list.filter((e) => e.type === 'wisp').length >= 1)) {
      type = schoice(pool.filter((id) => id !== 'wisp'));
    }
    const p = spawns[i % spawns.length];
    list.push({ type, x: p.x + srand(-14, 14), y: p.y, delay: i * 0.45 });
  }
  return list;
}

export function activeSpawnPads(waveIndex) {
  return waveIndex === 1 ? [0, 1] : [0, 1, 2];
}
