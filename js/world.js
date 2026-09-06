// Arena backdrop, platforms, pickups, portal and the wave composer.
import { clamp, lerp, rand, randInt, choice, streamFor, rgba, mixHex, TAU, dist } from './util.js';
import { Theme, ThemeRev } from './theme.js';
import { pxRect, glowDot, spawnParticle, burst, linGrad, bakedLayer } from './gfx.js';
import { VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, SPAWN_LEFT, SPAWN_RIGHT, SPAWN_CENTER, BLOCK, WAVES, ANVIL, SEEDED_THROUGH_ROOM, chapterFor } from './config.js';
import { bakeSky, bakeFloor, drawPlatform, drawChapterAmbience, updatePlatforms, drawExit, exitTint, PAL } from './chapters.js';
import { ITEMS, RARITY, drawItemIcon } from './items.js';
import { Sfx } from './audio.js';
import { Options } from './settings.js';

// --- background ----------------------------------------------------------

// A few things drift over every chapter: dust in the air, and whatever the
// chapter itself wants to do on top of its baked backdrop.
const motes = [];
for (let i = 0; i < 34; i++) {
  motes.push({
    x: rand(VIEW_W), y: rand(VIEW_H), vy: rand(-11, -3), vx: rand(-7, 7),
    s: Math.random() < 0.18 ? 2 : 1, p: rand(TAU), depth: rand(0.4, 1),
    warm: Math.random() < 0.3,
  });
}

// `frozen` holds the platforms still while the game is paused - an inventory,
// the fold wheel, the forge, the pause menu. Ambience keeps drifting, because
// nothing rides on it.
export function updateWorld(dt, frozen = false, t = 0) {
  updatePlatforms(dt, t, frozen);
  for (const m of motes) {
    m.x += m.vx * dt * m.depth;
    m.y += m.vy * dt * m.depth;
    if (m.y < -4) { m.y = VIEW_H + 4; m.x = rand(VIEW_W); }
    if (m.x < -4) m.x = VIEW_W + 4;
    if (m.x > VIEW_W + 4) m.x = -4;
  }
}

export function drawBackground(ctx, t, roomIndex) {
  // the whole backdrop of this chapter, painted once and blitted after that
  ctx.drawImage(bakedLayer('sky', `${roomIndex}:${ThemeRev.n}`, (c) => bakeSky(c, roomIndex)), 0, 0);
  drawChapterAmbience(ctx, t, roomIndex);

  // dust, which every chapter has some of
  const ch = chapterFor(roomIndex);
  const tint = ch.id === 'field' ? PAL.field.grassLit
    : ch.id === 'castle' ? PAL.castle.torch
    : ch.id === 'hell' ? PAL.hell.lavaHot : PAL.aether.glow;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    const a = (0.14 + 0.3 * Math.sin(t * 2 + m.p)) * m.depth * (ch.id === 'aether' ? 0.6 : 1);
    pxRect(ctx, m.x, m.y, m.s, m.s, rgba(m.warm ? tint : Theme.platformGlow, a));
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

export function drawLightShafts(ctx, t, roomIndex = 1) {
  const amt = Options.shafts ?? 1;
  if (amt <= 0.001) return;
  const ch = chapterFor(roomIndex);
  // sunlight through leaves, torchlight through dust, firelight, or whatever
  // it is that falls in the Aether
  const col = ch.id === 'field' ? PAL.field.sunGlow
    : ch.id === 'castle' ? PAL.castle.torch
    : ch.id === 'hell' ? PAL.hell.lava : '#ffffff';
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sh of SHAFTS) {
    const drift = Math.sin(t * 0.09 + sh.phase) * 26;
    const x = sh.x + drift;
    const breathe = 0.65 + 0.35 * Math.sin(t * 0.31 + sh.phase);
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, rgba(col, sh.a * breathe * amt * 1.6));
    g.addColorStop(0.65, rgba(col, sh.a * breathe * 0.5 * amt));
    g.addColorStop(1, rgba(col, 0));
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

export function drawArena(ctx, t, roomIndex = 1) {
  ctx.drawImage(bakedLayer('floor', `${roomIndex}:${ThemeRev.n}`, (c) => bakeFloor(c, roomIndex)), 0, 0);
  for (const p of PLATFORMS) drawPlatform(ctx, p, t, roomIndex);
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
      if (pl.off) continue;
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
  constructor(x, y, kind = 'stair') {
    this.x = x; this.y = y; this.t = 0; this.open = 0;
    this.kind = kind;              // what the way out looks like here
  }
  update(dt) {
    this.t += dt;
    this.open = Math.min(1, this.open + dt * 1.6);
    if (Math.random() < dt * 14) {
      const a = rand(0, TAU);
      spawnParticle({
        x: this.x + Math.cos(a) * 12, y: this.y - 16 + Math.sin(a) * 16,
        vx: -Math.cos(a) * 22, vy: -Math.sin(a) * 22,
        life: rand(0.3, 0.6), size: 1, color: exitTint(this.kind), gravity: 0, kind: 'shrink',
      });
    }
  }
  draw(ctx) { drawExit(ctx, this); }
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
