// The Paper Meteor: the one fold that does not fly away.
//
// Twenty sheets buy a lump of burning paper that falls on the cursor, hits
// whatever is standing there, shakes the ground around it - and then stays.
// For three seconds it is a solid block in the middle of the room: something to
// stand on, something in the way, and something that burns anything touching
// it, its owner included.
//
// Being solid is not a special case here. The world already decides what you
// can stand on by walking PLATFORMS, so a landed meteor puts itself in that
// list and takes itself back out when it burns away - which means jumping on
// one, shadows falling on it and enemies landing on it all work without a line
// of code that knows a meteor exists.

import { clamp, dist, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, spawnParticle, impactRing, floatText, pxRect, glowDot, dropShadow } from './gfx.js';
import { Sfx } from './audio.js';
import { PLATFORMS, GROUND_Y, VIEW_W, ORIGAMI, BLOCK } from './config.js';
import { surfaceBelow } from './entities.js';

const CORE = '#ff8a3c';
const HOT = '#ffe9a8';
const CHAR = '#3a2a24';

export class PaperMeteor {
  /**
   * @param x     where the cursor was; it comes straight down onto it
   * @param owner the player who folded it, so their own numbers apply
   */
  constructor(game, x, owner) {
    const cfg = ORIGAMI.forms.meteor;
    this.game = game;
    this.cfg = cfg;
    this.owner = owner;
    this.w = cfg.w;
    this.h = cfg.h;
    this.x = clamp(x, this.w / 2 + 2, VIEW_W - this.w / 2 - 2);
    this.y = cfg.fallFrom;
    this.vy = cfg.fallSpeed;
    this.state = 'falling';
    this.t = 0;
    this.dead = false;
    this.platform = null;      // the entry it puts into PLATFORMS once it lands
    this.hitLog = new Set();   // it is one impact, not one per frame
    this.spin = rand(0, TAU);
    // Damage is the player's: a Damage Booster lifts a meteor the same way it
    // lifts every other fold.
    const buff = 1 + (owner?.armorBuff?.origamiDamage ?? 0);
    this.damage = Math.round((owner ? owner.boosted(cfg.damage, 'paper') : cfg.damage) * buff);
    this.blastDamage = Math.round((owner ? owner.boosted(cfg.blastDamage, 'paper') : cfg.blastDamage) * buff);
  }

  get cx() { return this.x; }
  get cy() { return this.y - this.h / 2; }

  update(dt) {
    this.t += dt;
    if (this.state === 'falling') {
      this.y += this.vy * dt;
      this.trail();
      // Anything it passes through on the way down takes the full hit. It is
      // falling faster than a frame is long, so the test is the span it
      // crossed this frame rather than where it happens to be now.
      this.sweep(this.y - this.vy * dt, this.y);
      const floor = surfaceBelow(this.x, this.y - this.h);
      if (this.y >= floor) {
        this.y = floor;
        this.land();
      }
      return;
    }

    this.t >= this.cfg.linger ? this.burnOut() : this.smoulder(dt);
  }

  /** Everything the falling lump ran through between two heights. */
  sweep(fromY, toY) {
    const half = this.w / 2;
    const top = Math.min(fromY, toY) - this.h;
    const bottom = Math.max(fromY, toY);
    for (const e of this.game.enemies) {
      if (e.dead || e.spawnT > 0 || e.untargetable || this.hitLog.has(e)) continue;
      if (Math.abs(e.cx - this.x) > half + e.w / 2) continue;
      if (e.cy < top || e.cy > bottom) continue;
      this.hitLog.add(e);
      e.damage(this.damage, { color: CORE, angle: Math.PI / 2, knockback: 60 });
      if (!e.dead) e.applyBurn();
    }
    const p = this.game.player;
    if (p && !p.dead && !this.hitLog.has(p) &&
        Math.abs(p.x - this.x) < half + p.w / 2 && p.cy >= top && p.cy <= bottom) {
      // Your own meteor is still a meteor. It falls where you pointed, so
      // standing there is a choice you made.
      this.hitLog.add(p);
      p.hurt(this.damage, this.x);
      p.applyBurn?.();
    }
  }

  land() {
    this.state = 'landed';
    this.t = 0;
    Sfx.hit();
    Camera.add(9);
    Camera.punch(1.6);
    this.game.hitstop(0.05);

    // the ring it drives into the floor
    const r = this.cfg.blastRadius;
    impactRing(this.x, this.y, { color: CORE, r0: 4, r1: r, life: 0.4, width: 3 });
    impactRing(this.x, this.y, { color: HOT, r0: 2, r1: r * 0.6, life: 0.26, width: 2 });
    burst(this.x, this.y, 26, {
      color: CORE, color2: HOT, speedMin: 60, speedMax: 260,
      lifeMin: 0.25, lifeMax: 0.7, sizeMax: 2, gravity: 320,
    });
    burst(this.x, this.y, 12, {
      color: CHAR, kind: 'smoke', speedMin: 20, speedMax: 90, lifeMin: 0.5, lifeMax: 1.2,
      sizeMin: 2, sizeMax: 4, gravity: -26, drag: 0.9, glow: false,
    });

    // and what the ring does to everything standing in it
    for (const e of this.game.enemies) {
      if (e.dead || e.spawnT > 0 || e.untargetable) continue;
      if (dist(e.cx, e.cy, this.x, this.y) > r) continue;
      e.damage(this.blastDamage, { color: CORE, fromX: this.x, knockback: 90 });
      if (!e.dead) e.applyBurn();
    }
    const p = this.game.player;
    if (p && !p.dead && dist(p.x, p.cy, this.x, this.y) <= r) {
      p.hurt(this.blastDamage, this.x);
      p.applyBurn?.();
    }

    // From here it is ground. PLATFORMS is what the world walks to decide
    // what anything can stand on, so joining that list is the whole of it -
    // no collision code anywhere else needs to know.
    this.platform = {
      x: Math.round(this.x - this.w / 2), y: Math.round(this.y - this.h),
      w: this.w, h: this.h,
      homeX: Math.round(this.x - this.w / 2), homeY: Math.round(this.y - this.h),
      dx: 0, dy: 0, off: false, phase: 0, motion: 'none',
      hangFrom: null, style: 'meteor', meteor: true, tag: null,
    };
    PLATFORMS.push(this.platform);
  }

  /** Sitting there, burning whatever leans on it. */
  smoulder(dt) {
    const half = this.w / 2 + 1;
    const top = this.y - this.h - 1;
    const touching = (e, ew, eh, ey) =>
      Math.abs(e - this.x) < half + ew / 2 && ey > top - eh && ey < this.y + 2;

    for (const en of this.game.enemies) {
      if (en.dead || en.spawnT > 0) continue;
      if (touching(en.cx, en.w, en.h, en.y)) en.applyBurn();
    }
    const p = this.game.player;
    if (p && !p.dead && touching(p.x, p.w, p.h, p.y)) p.applyBurn?.();

    // it looks like it is going out, because it is
    const left = 1 - this.t / this.cfg.linger;
    if (Math.random() < dt * (14 + left * 26)) {
      spawnParticle({
        x: this.x + rand(-half, half), y: this.y - rand(0, this.h),
        vx: rand(-14, 14), vy: rand(-46, -14), life: rand(0.3, 0.8),
        size: 1, color: Math.random() < 0.5 ? CORE : HOT, gravity: -40, kind: 'shrink',
      });
    }
    if (Math.random() < dt * 8) {
      spawnParticle({
        x: this.x + rand(-half, half), y: this.y - this.h,
        vx: rand(-8, 8), vy: rand(-24, -6), life: rand(0.5, 1.1),
        size: 2, color: CHAR, kind: 'smoke', gravity: -18, drag: 0.9, glow: false,
      });
    }
  }

  burnOut() {
    this.release();
    this.dead = true;
    burst(this.x, this.y - this.h / 2, 16, {
      color: CHAR, color2: CORE, kind: 'smoke', speedMin: 14, speedMax: 70,
      lifeMin: 0.4, lifeMax: 1.0, sizeMin: 2, sizeMax: 4, gravity: -40, drag: 0.9, glow: false,
    });
    burst(this.x, this.y - this.h / 2, 10, {
      color: CORE, speedMin: 20, speedMax: 90, lifeMin: 0.2, lifeMax: 0.5, gravity: 120,
    });
  }

  /** Take the block back out of the world. Safe to call twice. */
  release() {
    if (!this.platform) return;
    const i = PLATFORMS.indexOf(this.platform);
    if (i >= 0) PLATFORMS.splice(i, 1);
    this.platform = null;
  }

  trail() {
    for (let i = 0; i < 2; i++) {
      spawnParticle({
        x: this.x + rand(-6, 6), y: this.y - rand(0, this.h) + rand(-10, 10),
        vx: rand(-20, 20), vy: rand(-90, -30), life: rand(0.2, 0.5),
        size: rand(1, 2) | 0, color: Math.random() < 0.4 ? HOT : CORE,
        gravity: -60, drag: 0.94, kind: 'shrink',
      });
    }
  }

  draw(ctx) {
    const cfg = this.cfg;
    const falling = this.state === 'falling';
    // how much of it is left to burn, for the glow to die down with
    const left = falling ? 1 : clamp(1 - this.t / cfg.linger, 0, 1);
    const flick = 0.75 + Math.sin(this.t * 24 + this.spin) * 0.25;

    if (falling) {
      // where it is going to land, so nobody is hit by something they could
      // not see coming
      const floor = surfaceBelow(this.x, this.y - this.h);
      const k = 0.35 + Math.sin(this.t * 18) * 0.2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(CORE, k);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(this.x, floor - 1, this.w * 0.7, 3.5, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
      glowDot(ctx, this.x, floor - 2, 22, CORE, 0.12 * k);
      // and the streak behind it
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(0, this.y - this.h - 46, 0, this.y);
      g.addColorStop(0, rgba(CORE, 0));
      g.addColorStop(1, rgba(CORE, 0.45));
      ctx.fillStyle = g;
      ctx.fillRect(this.x - this.w * 0.32, this.y - this.h - 46, this.w * 0.64, 46);
      ctx.restore();
    } else {
      dropShadow(ctx, this.x, this.y, this.w * 0.6, 0);
    }

    const top = this.y - this.h;
    ctx.save();
    ctx.globalAlpha = falling ? 1 : 0.35 + left * 0.65;

    // a charred lump of folded paper: a dark body, hot seams, a bright core
    pxRect(ctx, this.x - this.w / 2, top, this.w, this.h, CHAR);
    pxRect(ctx, this.x - this.w / 2 + 2, top + 2, this.w - 4, this.h - 4, rgba(CORE, 0.5 + 0.4 * flick * left));
    pxRect(ctx, this.x - 3, top + this.h / 2 - 2, 6, 4, rgba(HOT, 0.7 * flick));
    // the folds, still visible under the char
    pxRect(ctx, this.x - this.w / 2, top + 4, this.w, 1, rgba('#000000', 0.45));
    pxRect(ctx, this.x - 1, top, 2, this.h, rgba('#000000', 0.35));
    // a lip along the top, so it reads as something you can stand on
    pxRect(ctx, this.x - this.w / 2, top, this.w, 1, rgba(HOT, 0.5 + 0.3 * flick));
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, this.x, top + this.h / 2, 26, CORE, (falling ? 0.5 : 0.3 * left) * flick);
    ctx.restore();
  }
}
