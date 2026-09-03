// Player, enemies and projectiles: physics, combat, status effects, drawing.
import {
  clamp, lerp, rand, randInt, choice, dist, distToSegment, shortAngle, sign, rgba, TAU,
} from './util.js';
import { Theme } from './theme.js';
import {
  Camera, burst, floatText, spawnParticle, impactRing, dropShadow, ribbon,
  makeChain, stepChain, limb, pxRect, glowDot, boltPath, strokeBolt, drawBoomerang, screenFlash,
} from './gfx.js';
import { Sfx } from './audio.js';
import {
  VIEW_W, VIEW_H, GRAVITY, GROUND_Y, PLATFORMS, PLAYER, SWORD, BOW, SHARDGUN, TWINDAGGER, ORIGAMI, NUKERANG, GRAPPLE,
  ENEMY_TYPES, PERK, ROOM_SCALING, roomScaleSteps,
} from './config.js';
import { ITEMS, Inventory } from './items.js';
import { Binds, Input } from './input.js';

// --- shared physics ------------------------------------------------------

function moveAndCollide(e, dt, opts = {}) {
  e.x += e.vx * dt;
  const half = e.w / 2;
  if (e.x < half) { e.x = half; e.vx = Math.max(0, e.vx); }
  if (e.x > VIEW_W - half) { e.x = VIEW_W - half; e.vx = Math.min(0, e.vx); }

  const prevBottom = e.y;
  e.y += e.vy * dt;
  const wasGround = e.onGround;
  e.onGround = false;

  if (e.vy >= 0 && e.y >= GROUND_Y) {
    e.y = GROUND_Y;
    e.vy = 0;
    e.onGround = true;
    e.platform = null;
  } else if (e.vy >= 0 && !opts.ignorePlatforms) {
    for (const p of PLATFORMS) {
      if (prevBottom <= p.y + 0.5 && e.y >= p.y &&
          e.x + half > p.x && e.x - half < p.x + p.w) {
        e.y = p.y;
        e.vy = 0;
        e.onGround = true;
        e.platform = p;
        break;
      }
    }
  }
  if (!e.onGround) e.platform = null;
  return { wasGround };
}

export function groundLevelAt(x) {
  let best = GROUND_Y;
  for (const p of PLATFORMS) {
    if (x > p.x && x < p.x + p.w && p.y < best) best = p.y;
  }
  return best;
}

// Nearest surface at or below y - where an entity's shadow belongs.
export function surfaceBelow(x, y) {
  let best = GROUND_Y;
  for (const p of PLATFORMS) {
    if (x > p.x && x < p.x + p.w && p.y >= y - 1 && p.y < best) best = p.y;
  }
  return best;
}

// --- status effects ------------------------------------------------------

export class Status {
  constructor() {
    this.burn = 0; this.burnTick = 0;
    this.slow = 0; this.slowAmount = 0;
    this.mark = 0;
    this.electrified = 0; this.elecTick = 0; this.elecInterval = 1.3;
  }
  get slowFactor() { return this.slow > 0 ? 1 - this.slowAmount : 1; }
}

// --- enemies -------------------------------------------------------------

export const SHARD_TINT = '#a98cff';

// What each class considers its own weapons, for the Damage Booster.
const CLASS_WEAPONS = {
  melee: ['melee', 'boomerang'],
  ranger: ['bow', 'shardgun'],
  origamist: ['paper'],
};

export const ENEMY_TINT = {
  get grunt() { return Theme.enemyGrunt; },
  get brute() { return Theme.enemyBrute; },
  get stinger() { return Theme.enemyStinger; },
  get lurker() { return '#ff7a3c'; },
  get shardling() { return '#a98cff'; },
  get aetherShardling() { return '#a98cff'; },
  get wisp() { return '#7bf0d8'; },
  get spitter() { return '#a8e04a'; },
  get golemBody() { return Theme.enemyBrute; },
  get golemHead() { return Theme.lightning; },
};

let ENEMY_UID = 1;

export class Enemy {
  constructor(type, x, y, game) {
    const def = ENEMY_TYPES[type];
    this.uid = ENEMY_UID++;
    this.type = type;
    this.def = def;
    this.game = game;
    this.x = x; this.y = y;
    this.w = def.w; this.h = def.h;
    this.vx = 0; this.vy = 0;
    this.onGround = false;
    this.platform = null;
    // Base stats until room 6, then one step up every two rooms.
    const room = Math.max(1, game?.roomIndex ?? 1);
    const steps = roomScaleSteps(room);
    this.hpScale = 1 + ROOM_SCALING.hpPerStep * steps;
    this.dmgScale = 1 + ROOM_SCALING.damagePerStep * steps;
    this.maxHp = Math.round(def.hp * this.hpScale);
    this.hp = this.maxHp;
    this.dmg = Math.round(def.damage * this.dmgScale);
    this.facing = x < VIEW_W / 2 ? 1 : -1;
    this.st = new Status();
    this.attackTimer = rand(0.3, 0.9);
    this.hurtFlash = 0;
    this.dead = false;
    this.anim = rand(0, 10);
    this.spawnT = 0.45;         // materialise animation
    this.state = 'idle';
    this.stateT = 0;
    this.hover = rand(0, TAU);
    this.knockT = 0;
    this.telegraph = 0;
    this.squash = 0;
    this.guardFlash = 0;
    this.wasGround = false;
    // bosses shrug off the whole lightning package: no marks, no electrified,
    // and the arc passes through them
    this.immuneLightning = !!def.boss;
  }

  get cx() { return this.x; }
  get cy() { return this.y - this.h / 2; }
  get radius() { return Math.max(this.w, this.h) / 2; }
  // Which behaviour to run. Two types can share one AI and one sprite while
  // staying separate creatures everywhere else (spawn caps, drops).
  get ai() { return this.def.ai ?? this.type; }

  // Subclasses (boss parts) override this to share one HP pool.
  applyRawDamage(amount) {
    this.hp -= amount;
    if (this.hp <= 0) this.kill();
  }

  damage(amount, opts = {}) {
    if (this.dead) return;
    // a plated front turns most of a hit that comes at it head on
    let guarded = false;
    if (this.def.frontGuard && opts.angle !== undefined &&
        Math.cos(opts.angle) * this.facing < -0.2) {
      guarded = true;
      amount = Math.max(1, Math.round(amount * this.def.frontGuard));
      Sfx.ui();
      burst(this.cx + this.facing * 7, this.cy, 10, {
        color: '#ffffff', color2: Theme.steel, kind: 'streak',
        speedMin: 90, speedMax: 240, lifeMin: 0.08, lifeMax: 0.2,
        gravity: 0, drag: 0.85, angle: opts.angle + Math.PI, spread: 1.0,
      });
      impactRing(this.cx + this.facing * 7, this.cy, {
        color: '#ffffff', r0: 2, r1: 14, life: 0.18, width: 1.5,
        arc: 0.9, angle: this.facing > 0 ? 0 : Math.PI,
      });
      this.guardFlash = 0.18;
    }
    this.hurtFlash = 0.16;
    const crit = !!opts.crit;
    floatText(this.cx + rand(-3, 3), this.cy - 8, Math.round(amount), opts.color ?? (crit ? Theme.uiAccent : '#ffffff'), { crit });
    burst(this.cx, this.cy, crit ? 12 : 7, {
      color: opts.color ?? Theme.blood, color2: '#ffffff',
      speedMin: 30, speedMax: 150, lifeMin: 0.2, lifeMax: 0.45, sizeMax: 2,
      angle: opts.angle, spread: opts.spread ?? Math.PI,
    });
    burst(this.cx, this.cy, crit ? 7 : 4, {
      color: '#ffffff', color2: opts.color ?? Theme.spark, kind: 'streak',
      speedMin: 120, speedMax: 300, lifeMin: 0.1, lifeMax: 0.22, sizeMax: 2,
      gravity: 0, drag: 0.86, angle: opts.angle, spread: opts.spread ?? Math.PI,
    });
    impactRing(this.cx, this.cy, {
      color: opts.color ?? '#ffffff',
      r0: 2, r1: crit ? 30 : 18, life: crit ? 0.34 : 0.24, width: crit ? 2.5 : 1.5,
      arc: opts.angle !== undefined ? 1.1 : 0, angle: opts.angle ?? 0,
    });
    Camera.punch(crit ? 0.9 : 0.35);
    if (opts.knockback) {
      const dir = opts.dir ?? (sign(this.cx - (opts.fromX ?? this.cx)) || 1);
      this.vx += opts.knockback * dir;
      this.knockT = 0.12;
      if (!this.def.flying) this.vy = Math.min(this.vy, -110);
    }
    Sfx.hit();
    Camera.add(opts.shake ?? 2);
    this.applyRawDamage(amount);
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    Sfx.die();
    Camera.add(4);
    this.game.hitstop(0.055);
    const c = ENEMY_TINT[this.type] ?? ENEMY_TINT[this.ai] ?? Theme.enemyGrunt;
    burst(this.cx, this.cy, 26, {
      color: c, color2: '#ffffff', speedMin: 40, speedMax: 210,
      lifeMin: 0.3, lifeMax: 0.8, sizeMax: 3, gravity: 300,
    });
    burst(this.cx, this.cy, 10, { color: '#ffffff', speedMin: 10, speedMax: 60, lifeMin: 0.2, lifeMax: 0.5, kind: 'shrink', sizeMax: 4, gravity: 0 });
    burst(this.cx, this.cy, 8, {
      color: c, kind: 'smoke', speedMin: 8, speedMax: 44, lifeMin: 0.5, lifeMax: 1.1,
      sizeMin: 2, sizeMax: 4, gravity: -30, drag: 0.9, glow: false,
    });
    burst(this.cx, this.cy, 10, {
      color: '#ffffff', color2: c, kind: 'streak', speedMin: 140, speedMax: 320,
      lifeMin: 0.12, lifeMax: 0.3, gravity: 0, drag: 0.88,
    });
    impactRing(this.cx, this.cy, { color: c, r0: 3, r1: 40, life: 0.4, width: 3 });
    impactRing(this.cx, this.cy, { color: '#ffffff', r0: 2, r1: 22, life: 0.26, width: 2 });
    Camera.punch(1.4);
    if (this.def.dropId) this.game.rollEnemyDrop(this);
    this.game.onEnemyKilled(this);
  }

  applyBurn() {
    if (this.st.burn <= 0) this.st.burnTick = 0;
    this.st.burn = PERK.burnDuration;   // refresh, never stacks
  }

  applyMark() {
    if (this.immuneLightning) return;
    this.st.mark = PERK.markDuration;
  }

  applyElectrified() {
    if (this.immuneLightning) return;
    this.st.electrified = PERK.electrifiedDuration;
    this.st.elecInterval = rand(PERK.electrifiedIntervalMin, PERK.electrifiedIntervalMax);
  }

  applySlow(amount, duration) {
    this.st.slow = Math.max(this.st.slow, duration);
    this.st.slowAmount = Math.max(this.st.slowAmount, amount);
  }

  updateStatus(dt) {
    const st = this.st;
    if (st.burn > 0) {
      st.burn -= dt;
      st.burnTick += dt;
      while (st.burnTick >= PERK.burnTick) {
        st.burnTick -= PERK.burnTick;
        this.applyRawDamage(PERK.burnTickDamage);
        if (Math.random() < 0.5) {
          spawnParticle({
            x: this.cx + rand(-this.w / 2, this.w / 2), y: this.cy + rand(-6, 6),
            vx: rand(-12, 12), vy: rand(-46, -18), life: rand(0.25, 0.5), size: randInt(1, 2),
            color: Theme.fireHot, color2: Theme.fire, gravity: -40, kind: 'shrink',
          });
        }
        if (this.dead) return;
      }
    }
    if (st.slow > 0) {
      st.slow -= dt;
      if (st.slow <= 0) st.slowAmount = 0;
      else if (Math.random() < 0.25) {
        spawnParticle({
          x: this.cx + rand(-this.w / 2, this.w / 2), y: this.y - rand(0, this.h),
          vx: rand(-8, 8), vy: rand(6, 22), life: 0.4, size: 1,
          color: Theme.slime, gravity: 60, kind: 'shrink',
        });
      }
    }
    if (st.mark > 0) st.mark -= dt;
    if (st.electrified > 0) {
      st.electrified -= dt;
      st.elecTick += dt;
      if (st.elecTick >= st.elecInterval) {
        st.elecTick = 0;
        st.elecInterval = rand(PERK.electrifiedIntervalMin, PERK.electrifiedIntervalMax);
        this.damage(PERK.electrifiedDamage, { color: Theme.lightning, shake: 1 });
        Sfx.zap();
        for (let i = 0; i < 6; i++) {
          spawnParticle({
            x: this.cx, y: this.cy, vx: rand(-90, 90), vy: rand(-90, 90),
            life: rand(0.1, 0.25), size: 1, color: Theme.lightning, gravity: 0, kind: 'line',
          });
        }
      }
    }
  }

  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.knockT = Math.max(0, this.knockT - dt);
    this.squash = Math.max(0, this.squash - dt * 4.5);
    this.guardFlash = Math.max(0, this.guardFlash - dt * 4);
    if (this.onGround && !this.wasGround && !this.def.flying) {
      this.squash = 1;
      burst(this.x, this.y, 4, {
        color: Theme.groundEdge, kind: 'smoke', speedMin: 10, speedMax: 40,
        lifeMin: 0.25, lifeMax: 0.5, sizeMin: 1, sizeMax: 3, gravity: -10, glow: false,
      });
    }
    this.wasGround = this.onGround;
    if (this.spawnT > 0) {
      this.spawnT -= dt;
      return;
    }
    this.updateStatus(dt);
    if (this.dead) return;

    const p = this.game.player;
    // a Wisp's aura decays the instant it stops being fed
    this.auraT = Math.max(0, (this.auraT ?? 0) - dt);
    if (this.auraT <= 0) this.auraSpeed = 0;
    const slow = this.st.slowFactor * (1 + (this.auraSpeed ?? 0));
    this.attackTimer -= dt;
    this.stateT += dt;

    if (this.def.flying) this.updateFlyer(dt, p, slow);
    else this.updateWalker(dt, p, slow);
  }

  updateWalker(dt, p, slow) {
    if (this.type === 'lurker') return this.updateLurker(dt, p, slow);
    if (this.type === 'spitter') return this.updateSpitter(dt, p, slow);
    const target = p && !p.dead ? p : null;
    const speed = (this.state === 'charge' ? (this.def.chargeSpeed ?? this.def.speed) : this.def.speed) * slow;

    if (target && this.knockT <= 0) {
      const dx = target.x - this.x;
      this.facing = sign(dx) || this.facing;
      const gap = Math.abs(dx);
      if (this.telegraph > 0) {
        this.telegraph -= dt;
        this.vx = lerp(this.vx, 0, 1 - Math.pow(0.001, dt));
        if (this.telegraph <= 0) this.strike(target);
      } else if (gap > this.def.attackRange * 0.7) {
        this.vx = lerp(this.vx, this.facing * speed, 1 - Math.pow(0.0015, dt));
        // hop up to platforms / over gaps
        if (this.onGround && target.y < this.y - 20 && Math.random() < dt * 1.6) {
          this.vy = -300;
        }
      } else {
        this.vx = lerp(this.vx, 0, 1 - Math.pow(0.002, dt));
        if (this.attackTimer <= 0) {
          this.telegraph = this.type === 'brute' ? 0.38 : 0.22;
          this.attackTimer = this.def.attackCooldown;
          this.state = 'wind';
          this.stateT = 0;
        }
      }
      // brute occasionally charges
      if (this.type === 'brute' && this.state === 'idle' && gap > 60 && Math.random() < dt * 0.35) {
        this.state = 'charge';
        this.stateT = 0;
      }
      if (this.state === 'charge' && this.stateT > 1.4) this.state = 'idle';
    } else {
      this.vx = lerp(this.vx, 0, 1 - Math.pow(0.004, dt));
    }

    this.vy += GRAVITY * dt;
    // drop off the platform edge when chasing downward
    const ignore = target && target.y > this.y + 8 && this.onGround && this.platform && Math.random() < dt * 3;
    if (ignore) this.y += 2;
    moveAndCollide(this, dt);
  }

  updateFlyer(dt, p, slow) {
    if (this.ai === 'shardling') return this.updateShardling(dt, p, slow);
    if (this.ai === 'wisp') return this.updateWisp(dt, p, slow);
    this.hover += dt * 3;
    const target = p && !p.dead ? p : null;
    if (target) {
      const desiredX = target.x - sign(target.x - this.x) * 70;
      const desiredY = target.y - target.h - 44 + Math.sin(this.hover) * 8;
      this.vx = lerp(this.vx, clamp((desiredX - this.x) * 2.2, -this.def.speed, this.def.speed) * slow, 1 - Math.pow(0.002, dt));
      this.vy = lerp(this.vy, clamp((desiredY - this.y) * 2.2, -this.def.speed, this.def.speed) * slow, 1 - Math.pow(0.002, dt));
      this.facing = sign(target.x - this.x) || this.facing;
      if (this.attackTimer <= 0 && dist(this.cx, this.cy, target.x, target.y - target.h / 2) < this.def.attackRange) {
        this.attackTimer = this.def.attackCooldown / slow;
        this.telegraph = 0;
        this.shoot(target);
      }
    }
    moveAndCollide(this, dt, { ignorePlatforms: true });
    this.y = clamp(this.y, 30, GROUND_Y - 6);
  }

  // Wisp: never attacks. It hangs off the far side of the pack from you and
  // pours speed into the allies nearest to you, so the room gets faster the
  // longer you leave it alive.
  updateWisp(dt, p, slow) {
    const d = this.def;
    this.hover += dt * 3.4;
    this.auraLinks = [];

    // find the allies closest to the player, and hide behind the pack
    let anchorX = null, anchorY = null;
    const buffed = [];
    for (const e of this.game.enemies) {
      if (e === this || e.dead || e.spawnT > 0 || e.def.ai === 'wisp') continue;
      const gap = dist(e.cx, e.cy, this.cx, this.cy);
      if (gap < d.auraRange) buffed.push({ e, gap });
      if (anchorX === null && p) { anchorX = e.x; anchorY = e.y; }
    }
    buffed.sort((a, b) => a.gap - b.gap);
    for (let i = 0; i < Math.min(d.auraMax, buffed.length); i++) {
      const e = buffed[i].e;
      e.auraSpeed = d.auraSpeed;
      e.auraT = 0.2;                        // refreshed every frame it is in range
      this.auraLinks.push(e);
    }

    // position: opposite the player, at orbit distance from the pack
    const target = p && !p.dead ? p : null;
    if (target) {
      const px = anchorX ?? target.x;
      const py = anchorY ?? target.y;
      const away = sign(px - target.x) || 1;
      const wantX = clamp(px + away * d.orbit * 0.55, 22, VIEW_W - 22);
      const wantY = clamp(py - 54 + Math.sin(this.hover) * 9, 26, GROUND_Y - 20);
      this.vx = lerp(this.vx, clamp((wantX - this.x) * 2.4, -d.speed, d.speed) * slow, 1 - Math.pow(0.004, dt));
      this.vy = lerp(this.vy, clamp((wantY - this.y) * 2.4, -d.speed, d.speed) * slow, 1 - Math.pow(0.004, dt));
      this.facing = sign(target.x - this.x) || this.facing;
    }
    moveAndCollide(this, dt, { ignorePlatforms: true });
    this.y = clamp(this.y, 24, GROUND_Y - 6);

    if (Math.random() < dt * 26) {
      const a = rand(0, TAU);
      spawnParticle({
        x: this.cx + Math.cos(a) * 7, y: this.cy + Math.sin(a) * 7,
        vx: Math.cos(a) * 22, vy: Math.sin(a) * 22 - 10, life: rand(0.3, 0.8),
        size: 1, color: ENEMY_TINT.wisp, gravity: -14, drag: 0.96, kind: 'shrink',
      });
    }
  }

  // Shardling: drifts at stand-off with its plate toward you, winds up, then
  // commits to one straight charge. It cannot steer once it has launched.
  updateShardling(dt, p, slow) {
    const d = this.def;
    const target = p && !p.dead ? p : null;
    this.hover += dt * 2.4;

    if (this.state === 'charge') {
      this.chargeT -= dt;
      if (Math.random() < dt * 70) {
        spawnParticle({
          x: this.cx + rand(-5, 5), y: this.cy + rand(-5, 5),
          vx: -this.vx * 0.12, vy: -this.vy * 0.12, life: rand(0.1, 0.28),
          size: randInt(1, 2), color: ENEMY_TINT.shardling, gravity: 0, kind: 'streak',
        });
      }
      if (target && Math.abs(target.x - this.x) < (this.w + target.w) / 2 + 2 &&
          Math.abs((target.y - target.h / 2) - this.cy) < (this.h + target.h) / 2) {
        target.hurt(this.dmg, this.x);
        this.chargeT = 0;
      }
      if (this.chargeT <= 0) {
        this.state = 'idle';
        this.vx *= 0.2;
        this.vy *= 0.2;
        this.attackTimer = d.attackCooldown / Math.max(0.2, slow);
      }
      moveAndCollide(this, dt, { ignorePlatforms: true });
      this.x = clamp(this.x, this.w / 2, VIEW_W - this.w / 2);
      this.y = clamp(this.y, 24, GROUND_Y - 2);
      return;
    }

    if (this.telegraph > 0) {
      this.telegraph -= dt;
      // pull back a little, the way a fist cocks before it swings
      if (target) {
        const a = Math.atan2((target.y - target.h / 2) - this.cy, target.x - this.x);
        this.facing = sign(Math.cos(a)) || this.facing;
        this.vx = lerp(this.vx, -Math.cos(a) * 40, 1 - Math.pow(0.004, dt));
        this.vy = lerp(this.vy, -Math.sin(a) * 40, 1 - Math.pow(0.004, dt));
        this.aimAngle = a;
      }
      if (Math.random() < dt * 30) {
        const ang = rand(0, TAU);
        spawnParticle({
          x: this.cx + Math.cos(ang) * 18, y: this.cy + Math.sin(ang) * 18,
          vx: -Math.cos(ang) * 70, vy: -Math.sin(ang) * 70, life: 0.25,
          size: 1, color: ENEMY_TINT.shardling, gravity: 0, kind: 'shrink',
        });
      }
      if (this.telegraph <= 0 && target) {
        this.state = 'charge';
        this.chargeT = d.chargeTime;
        const a = this.aimAngle ?? 0;
        this.vx = Math.cos(a) * d.chargeSpeed * slow;
        this.vy = Math.sin(a) * d.chargeSpeed * slow;
        this.facing = sign(this.vx) || this.facing;
        Sfx.dash();
        Camera.add(2);
      }
      moveAndCollide(this, dt, { ignorePlatforms: true });
      return;
    }

    if (target) {
      // keep its plate between you and its core
      const dx = target.x - this.x;
      const dy = (target.y - target.h / 2) - this.cy;
      const gap = Math.hypot(dx, dy) || 1;
      const want = (gap - d.standOff) / gap;
      const bob = Math.sin(this.hover) * 26;
      this.vx = lerp(this.vx, clamp(dx * want * 2.2, -d.speed, d.speed) * slow, 1 - Math.pow(0.003, dt));
      this.vy = lerp(this.vy, clamp(dy * want * 2.2 + bob, -d.speed, d.speed) * slow, 1 - Math.pow(0.003, dt));
      this.facing = sign(dx) || this.facing;
      this.attackTimer -= 0;
      if (this.attackTimer <= 0 && gap < d.attackRange) {
        this.telegraph = d.windUp;
        this.attackTimer = d.attackCooldown;
        this.state = 'wind';
      }
    } else {
      this.vx = lerp(this.vx, 0, 1 - Math.pow(0.004, dt));
      this.vy = lerp(this.vy, 0, 1 - Math.pow(0.004, dt));
    }
    moveAndCollide(this, dt, { ignorePlatforms: true });
    this.y = clamp(this.y, 24, GROUND_Y - 2);
  }

  // Lurker: hover at stand-off range, crouch, then commit to a long lunge.
  updateLurker(dt, p, slow) {
    const d = this.def;
    const target = p && !p.dead ? p : null;
    this.vy += GRAVITY * dt;

    if (this.state === 'lunge') {
      this.stateT += 0;
      this.lungeT -= dt;
      if (Math.random() < dt * 60) {
        spawnParticle({
          x: this.cx + rand(-4, 4), y: this.cy + rand(-6, 6), vx: rand(-20, 20), vy: rand(-20, 20),
          life: rand(0.12, 0.3), size: 1, color: ENEMY_TINT.lurker, gravity: 0, kind: 'shrink',
        });
      }
      if (target && Math.abs(target.x - this.x) < (this.w + target.w) / 2 + 2 &&
          Math.abs((target.y - target.h / 2) - this.cy) < 20) {
        target.hurt(this.dmg, this.x);
        this.lungeT = 0;
      }
      if (this.lungeT <= 0) {
        this.state = 'idle';
        this.vx *= 0.25;
        this.attackTimer = d.attackCooldown / Math.max(0.2, slow);
      }
      moveAndCollide(this, dt);
      return;
    }

    if (this.telegraph > 0) {
      this.telegraph -= dt;
      this.vx = lerp(this.vx, 0, 1 - Math.pow(0.0005, dt));
      if (this.telegraph <= 0 && target) {
        this.state = 'lunge';
        this.lungeT = d.lungeTime;
        const a = Math.atan2((target.y - target.h / 2) - this.cy, target.x - this.x);
        this.vx = Math.cos(a) * d.lungeSpeed * slow;
        this.vy = Math.min(this.vy, Math.sin(a) * d.lungeSpeed * 0.5);
        this.facing = sign(this.vx) || this.facing;
        Sfx.dash();
        burst(this.cx, this.cy, 10, {
          color: ENEMY_TINT.lurker, speedMin: 30, speedMax: 120, lifeMin: 0.15, lifeMax: 0.4,
          angle: a + Math.PI, spread: 0.7, gravity: 0,
        });
      }
      moveAndCollide(this, dt);
      return;
    }

    if (target && this.knockT <= 0) {
      const dx = target.x - this.x;
      this.facing = sign(dx) || this.facing;
      const gap = Math.abs(dx);
      // circle in and out of the stand-off band
      const want = gap > d.standOff + 14 ? this.facing : gap < d.standOff - 14 ? -this.facing : 0;
      this.vx = lerp(this.vx, want * d.speed * slow, 1 - Math.pow(0.002, dt));
      if (this.onGround && target.y < this.y - 20 && Math.random() < dt * 1.4) this.vy = -300;
      this.attackTimer -= 0;
      if (this.attackTimer <= 0 && gap < d.attackRange) {
        this.telegraph = d.windUp;
        this.attackTimer = d.attackCooldown;
        this.state = 'wind';
      }
    } else {
      this.vx = lerp(this.vx, 0, 1 - Math.pow(0.004, dt));
    }
    moveAndCollide(this, dt);
  }

  // Spitter: holds a long stand-off and lobs acid on a high arc.
  updateSpitter(dt, p, slow) {
    const d = this.def;
    const target = p && !p.dead ? p : null;
    this.vy += GRAVITY * dt;

    if (this.telegraph > 0) {
      this.telegraph -= dt;
      this.vx = lerp(this.vx, 0, 1 - Math.pow(0.0005, dt));
      if (Math.random() < dt * 25) {
        spawnParticle({
          x: this.cx + rand(-5, 5), y: this.cy - 6, vx: rand(-8, 8), vy: rand(-24, -8),
          life: rand(0.2, 0.5), size: 1, color: ENEMY_TINT.spitter, gravity: -20, kind: 'shrink',
        });
      }
      if (this.telegraph <= 0 && target) this.lobAcid(target);
      moveAndCollide(this, dt);
      return;
    }

    if (target && this.knockT <= 0) {
      const dx = target.x - this.x;
      this.facing = sign(dx) || this.facing;
      const gap = Math.abs(dx);
      const want = gap > d.standOff + 20 ? this.facing : gap < d.standOff - 20 ? -this.facing : 0;
      this.vx = lerp(this.vx, want * d.speed * slow, 1 - Math.pow(0.003, dt));
      if (this.attackTimer <= 0 && gap < d.attackRange) {
        this.telegraph = d.windUp;
        this.attackTimer = d.attackCooldown / Math.max(0.2, slow);
        this.state = 'wind';
      }
    } else {
      this.vx = lerp(this.vx, 0, 1 - Math.pow(0.004, dt));
    }
    moveAndCollide(this, dt);
  }

  lobAcid(target) {
    const ox = this.cx, oy = this.cy - 6;
    const tx = target.x, ty = target.y - target.h / 2;
    const flight = clamp(dist(ox, oy, tx, ty) / this.def.projectileSpeed, 0.55, 1.5);
    const vx = (tx - ox) / flight;
    const vy = (ty - oy - 0.5 * 620 * flight * flight) / flight;
    this.game.projectiles.push(new Projectile({
      x: ox, y: oy, vx, vy, gravity: 620, damage: this.dmg,
      team: 'enemy', kind: 'acid', life: flight + 1.4, game: this.game,
    }));
    Sfx.slime();
    this.state = 'shoot';
    this.stateT = 0;
  }

  strike(target) {
    this.state = 'strike';
    this.stateT = 0;
    Sfx.swing();
    const reach = this.def.attackRange + 6;
    if (Math.abs(target.x - this.x) < reach && Math.abs((target.y - target.h / 2) - this.cy) < 24) {
      target.hurt(this.dmg, this.x);
    }
    burst(this.x + this.facing * 10, this.cy, 6, {
      color: Theme.enemyDark, color2: '#ffffff', speedMin: 20, speedMax: 80,
      lifeMin: 0.12, lifeMax: 0.3, angle: this.facing > 0 ? 0 : Math.PI, spread: 0.8, gravity: 60,
    });
  }

  shoot(target) {
    const a = Math.atan2((target.y - target.h / 2) - this.cy, target.x - this.cx);
    this.game.projectiles.push(new Projectile({
      x: this.cx, y: this.cy,
      vx: Math.cos(a) * this.def.projectileSpeed,
      vy: Math.sin(a) * this.def.projectileSpeed,
      damage: this.dmg,
      team: 'enemy', kind: 'bolt', life: 3, game: this.game,
    }));
    Sfx.bow();
    this.state = 'shoot';
    this.stateT = 0;
  }

  draw(ctx) {
    const t = this.anim;
    if (this.spawnT > 0) {
      // it assembles: a seam of light opens, the body climbs out of it, and
      // sparks fall back into the floor behind it
      const k = 1 - this.spawnT / 0.45;
      const ease = 1 - Math.pow(1 - k, 3);
      const c = ENEMY_TINT[this.type] ?? ENEMY_TINT[this.ai] ?? Theme.enemyGrunt;
      const cy = this.y - this.h / 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // the seam: a hot horizontal slit that widens then thins away
      const seamW = this.w * (0.4 + ease * 1.9) * (1 - ease * 0.45);
      const seamA = Math.sin(Math.min(1, k * 1.4) * Math.PI) * 0.9;
      ctx.fillStyle = rgba('#ffffff', seamA);
      ctx.fillRect(this.x - seamW / 2, this.y - 1, seamW, 1);
      ctx.fillStyle = rgba(c, seamA * 0.7);
      ctx.fillRect(this.x - seamW * 0.75, this.y - 2, seamW * 1.5, 3);
      // a rising column of light it climbs out of
      const g = ctx.createLinearGradient(0, this.y, 0, this.y - this.h - 8);
      g.addColorStop(0, rgba(c, 0.45 * (1 - ease)));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(this.x - this.w * 0.7, this.y - this.h - 8, this.w * 1.4, this.h + 8);
      ctx.restore();
      glowDot(ctx, this.x, cy, 26 * (1 - ease) + 8, c, 0.75);
      // the body itself, wiping up out of the seam
      ctx.globalAlpha = 0.35 + ease * 0.65;
      pxRect(ctx, this.x - this.w / 2, this.y - this.h * ease, this.w, this.h * ease, rgba(c, 0.75));
      pxRect(ctx, this.x - this.w / 2, this.y - this.h * ease, this.w, 1, rgba('#ffffff', 0.9));
      ctx.globalAlpha = 1;
      if (Math.random() < 0.5) {
        const a = rand(0, TAU);
        spawnParticle({
          x: this.x + Math.cos(a) * this.w * 0.7, y: this.y - rand(0, this.h),
          vx: Math.cos(a) * 26, vy: rand(-40, -8), life: rand(0.2, 0.5),
          size: 1, color: Math.random() < 0.4 ? '#ffffff' : c,
          gravity: 140, drag: 0.92, kind: 'shrink',
        });
      }
      return;
    }
    const shadowY = surfaceBelow(this.x, this.y);
    dropShadow(ctx, this.x, shadowY, this.w * (this.def.flying ? 0.4 : 0.55), shadowY - this.y);
    ctx.save();
    // squash on landing, stretch while falling
    const sq = this.squash;
    const air = this.def.flying ? 0 : clamp(this.vy / 620, -1, 1);
    // a hit briefly pinches the body in - it eases out over the flash
    const hit = clamp(this.hurtFlash / 0.16, 0, 1);
    const pinch = Math.sin(hit * Math.PI) * 0.16;
    const sx = 1 + sq * 0.28 - Math.abs(air) * 0.08 - pinch;
    const sy = 1 - sq * 0.24 + Math.abs(air) * 0.12 + pinch * 0.8;
    if (Math.abs(sx - 1) > 0.004 || Math.abs(sy - 1) > 0.004) {
      ctx.translate(this.x, this.y);
      ctx.scale(sx, sy);
      ctx.translate(-this.x, -this.y);
    }
    if (this.hurtFlash > 0) ctx.globalAlpha = 1;
    const flash = this.hurtFlash > 0;
    if (this.type === 'grunt') this.drawGrunt(ctx, t, flash);
    else if (this.type === 'brute') this.drawBrute(ctx, t, flash);
    else if (this.type === 'lurker') this.drawLurker(ctx, t, flash);
    else if (this.type === 'spitter') this.drawSpitter(ctx, t, flash);
    else if (this.ai === 'shardling') this.drawShardling(ctx, t, flash);
    else if (this.ai === 'wisp') this.drawWisp(ctx, t, flash);
    else this.drawStinger(ctx, t, flash);
    ctx.restore();

    this.drawStatusFx(ctx, t);
    this.drawHpBar(ctx);
  }

  drawHpBar(ctx) {
    if (this.hp >= this.maxHp) return;
    const w = Math.max(14, this.w + 4);
    const x = Math.round(this.x - w / 2);
    const y = Math.round(this.y - this.h - 7);
    pxRect(ctx, x - 1, y - 1, w + 2, 4, '#00000099');
    pxRect(ctx, x, y, w, 2, Theme.hpBack);
    pxRect(ctx, x, y, Math.round(w * clamp(this.hp / this.maxHp, 0, 1)), 2, Theme.hp);
  }

  drawStatusFx(ctx, t) {
    const st = this.st;
    if (st.mark > 0) {
      const a = 0.5 + 0.5 * Math.sin(t * 8);
      const y = this.y - this.h - 12 + Math.sin(t * 3) * 1.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      pxRect(ctx, this.x - 1, y, 2, 4, rgba(Theme.lightning, a));
      pxRect(ctx, this.x - 3, y + 3, 6, 1, rgba(Theme.lightning, a));
      pxRect(ctx, this.x, y + 4, 2, 3, rgba('#ffffff', a));
      ctx.restore();
      glowDot(ctx, this.x, y + 3, 7, Theme.lightning, 0.25 * a);
    }
    if (st.burn > 0) glowDot(ctx, this.cx, this.cy, 14, Theme.fire, 0.22);
    if (st.electrified > 0) {
      const pts = boltPath(this.x - this.w / 2, this.cy + rand(-6, 6), this.x + this.w / 2, this.cy + rand(-6, 6), 4, 4, t * 30);
      strokeBolt(ctx, pts, Theme.lightning, 1, 0.7);
    }
    if (st.slow > 0) glowDot(ctx, this.cx, this.cy, 12, Theme.slime, 0.18);
  }

  drawGrunt(ctx, t, flash) {
    const c = flash ? '#ffffff' : Theme.enemyGrunt;
    const d = flash ? '#ffffff' : Theme.enemyDark;
    const moving = Math.abs(this.vx) > 6;
    const cyc = t * (moving ? 9 : 2.4);
    const bob = Math.sin(cyc * 2) * (moving ? 1.2 : 0.6);
    const x = Math.round(this.x), y = Math.round(this.y + bob);
    const f = this.facing;
    // legs
    limb(ctx, x - 2, y - 7, Math.PI / 2 + Math.sin(cyc) * 0.7, 7, 3, d);
    limb(ctx, x + 2, y - 7, Math.PI / 2 - Math.sin(cyc) * 0.7, 7, 3, d);
    // body
    pxRect(ctx, x - 5, y - 15, 10, 9, c);
    pxRect(ctx, x - 5, y - 15, 10, 2, flash ? '#fff' : '#ff90b0');
    // head
    pxRect(ctx, x - 4, y - 21, 8, 6, c);
    pxRect(ctx, x - 4 + (f > 0 ? 4 : 0), y - 20, 3, 2, flash ? '#fff' : Theme.eye);
    // horn
    pxRect(ctx, x - 4, y - 23, 2, 2, d);
    pxRect(ctx, x + 2, y - 23, 2, 2, d);
    // weapon arm
    const swing = this.telegraph > 0 ? -0.9 - (0.22 - this.telegraph) * 2
      : this.state === 'strike' && this.stateT < 0.18 ? 1.1 : Math.sin(cyc + 1) * 0.3;
    limb(ctx, x + f * 3, y - 13, (f > 0 ? 0 : Math.PI) + swing * f, 8, 3, d);
    const hx = x + f * 3 + Math.cos((f > 0 ? 0 : Math.PI) + swing * f) * 8;
    const hy = y - 13 + Math.sin((f > 0 ? 0 : Math.PI) + swing * f) * 8;
    limb(ctx, hx, hy, (f > 0 ? -0.5 : Math.PI + 0.5) + swing * f, 8, 2, flash ? '#fff' : Theme.steel);
  }

  drawBrute(ctx, t, flash) {
    const c = flash ? '#ffffff' : Theme.enemyBrute;
    const d = flash ? '#ffffff' : Theme.enemyDark;
    const moving = Math.abs(this.vx) > 6;
    const cyc = t * (moving ? 6 : 1.8);
    const bob = Math.sin(cyc * 2) * (moving ? 1.6 : 0.8);
    const x = Math.round(this.x), y = Math.round(this.y + bob);
    const f = this.facing;
    limb(ctx, x - 4, y - 9, Math.PI / 2 + Math.sin(cyc) * 0.5, 9, 5, d);
    limb(ctx, x + 4, y - 9, Math.PI / 2 - Math.sin(cyc) * 0.5, 9, 5, d);
    pxRect(ctx, x - 8, y - 20, 16, 12, c);
    pxRect(ctx, x - 8, y - 20, 16, 3, flash ? '#fff' : '#b18cff');
    pxRect(ctx, x - 6, y - 26, 12, 7, c);
    pxRect(ctx, x - 6 + (f > 0 ? 6 : 1), y - 24, 5, 2, flash ? '#fff' : Theme.eye);
    pxRect(ctx, x - 8, y - 29, 3, 4, d);
    pxRect(ctx, x + 5, y - 29, 3, 4, d);
    const wind = this.telegraph > 0 ? -1.4 : this.state === 'strike' && this.stateT < 0.2 ? 1.3 : Math.sin(cyc) * 0.25;
    limb(ctx, x + f * 6, y - 18, (f > 0 ? 0.2 : Math.PI - 0.2) + wind * f, 12, 5, c);
    const fx = x + f * 6 + Math.cos((f > 0 ? 0.2 : Math.PI - 0.2) + wind * f) * 12;
    const fy = y - 18 + Math.sin((f > 0 ? 0.2 : Math.PI - 0.2) + wind * f) * 12;
    pxRect(ctx, fx - 3, fy - 3, 6, 6, d);
    if (this.state === 'charge') glowDot(ctx, x, y - 12, 20, Theme.enemyBrute, 0.3);
  }

  drawLurker(ctx, t, flash) {
    const c = flash ? '#ffffff' : ENEMY_TINT.lurker;
    const d = flash ? '#ffffff' : '#2a1020';
    const crouch = this.telegraph > 0 ? clamp(1 - this.telegraph / this.def.windUp, 0, 1) * 4 : 0;
    const lunging = this.state === 'lunge';
    const cyc = t * (Math.abs(this.vx) > 6 ? 12 : 3);
    const x = Math.round(this.x);
    const y = Math.round(this.y + Math.sin(cyc * 2) * 0.6);
    const f = this.facing;
    // long back legs
    limb(ctx, x - 3, y - 6 + crouch, Math.PI / 2 + 0.7 + Math.sin(cyc) * 0.5, 7, 2, d);
    limb(ctx, x + 3, y - 6 + crouch, Math.PI / 2 - 0.7 - Math.sin(cyc) * 0.5, 7, 2, d);
    // low slung body, leaning into the lunge
    const lean = lunging ? f * 2 : 0;
    pxRect(ctx, x - 6 + lean, y - 12 + crouch, 12, 6, c);
    pxRect(ctx, x - 6 + lean, y - 12 + crouch, 12, 2, flash ? '#fff' : '#ffb07a');
    // head thrust forward
    pxRect(ctx, x + f * 4 + lean, y - 14 + crouch, 6, 5, c);
    pxRect(ctx, x + f * 5 + lean, y - 13 + crouch, 3, 1, flash ? '#fff' : '#fff3b0');
    // tail
    limb(ctx, x - f * 6 + lean, y - 10 + crouch, f > 0 ? Math.PI - 0.5 : 0.5, 9, 2, d);
    if (this.telegraph > 0) {
      const k = 1 - this.telegraph / this.def.windUp;
      glowDot(ctx, x, y - 10, 10 + k * 12, ENEMY_TINT.lurker, 0.15 + k * 0.35);
    }
    if (lunging) glowDot(ctx, x, y - 9, 16, ENEMY_TINT.lurker, 0.4);
  }

  drawSpitter(ctx, t, flash) {
    const c = flash ? '#ffffff' : ENEMY_TINT.spitter;
    const d = flash ? '#ffffff' : '#1d3a12';
    const charge = this.telegraph > 0 ? clamp(1 - this.telegraph / this.def.windUp, 0, 1) : 0;
    const breathe = Math.sin(t * 2.5) * 1 + charge * 2;
    const x = Math.round(this.x), y = Math.round(this.y);
    const f = this.facing;
    limb(ctx, x - 4, y - 5, Math.PI / 2 + 0.5, 6, 3, d);
    limb(ctx, x + 4, y - 5, Math.PI / 2 - 0.5, 6, 3, d);
    // bulbous sac
    pxRect(ctx, x - 8, y - 13 - breathe, 16, 9 + breathe, c);
    pxRect(ctx, x - 6, y - 15 - breathe, 12, 3, flash ? '#fff' : '#d6ff8a');
    pxRect(ctx, x - 4, y - 8, 3, 3, d);
    pxRect(ctx, x + 2, y - 8, 3, 3, d);
    // spout
    limb(ctx, x + f * 6, y - 12 - breathe, f > 0 ? -0.5 : Math.PI + 0.5, 7, 4, d);
    if (charge > 0) {
      const px2 = x + f * (6 + Math.cos(f > 0 ? -0.5 : Math.PI + 0.5) * 7);
      glowDot(ctx, px2, y - 15 - breathe, 6 + charge * 8, ENEMY_TINT.spitter, 0.2 + charge * 0.5);
    }
  }

  drawShardling(ctx, t, flash) {
    const c = flash ? '#ffffff' : ENEMY_TINT.shardling;
    const dark = flash ? '#ffffff' : '#3a2a58';
    const plate = flash ? '#ffffff' : '#cfc0ff';
    const x = Math.round(this.x);
    const y = Math.round(this.y - this.h / 2 + Math.sin(this.hover * 1.6) * 1.5);
    const f = this.facing;
    const winding = this.telegraph > 0;
    const k = winding ? 1 - this.telegraph / this.def.windUp : 0;

    // orbiting debris
    for (let i = 0; i < 3; i++) {
      const a = t * 1.6 + i * (TAU / 3);
      const r = 13 + Math.sin(t * 2 + i) * 2;
      pxRect(ctx, x + Math.cos(a) * r, y + Math.sin(a) * r * 0.6, 2, 2, dark);
    }

    // core
    glowDot(ctx, x, y, 12 + k * 12, ENEMY_TINT.shardling, 0.25 + k * 0.45);
    pxRect(ctx, x - 5, y - 6, 10, 12, c);
    pxRect(ctx, x - 5, y - 6, 10, 2, plate);
    pxRect(ctx, x - 2, y - 2, 4, 4, flash ? '#fff' : Theme.eye);

    // the front plate: a slab of golem armour, angled
    const px = x + f * 6;
    pxRect(ctx, px - 1, y - 9, 4, 18, dark);
    pxRect(ctx, px + f * 1, y - 8, 3, 16, plate);
    pxRect(ctx, px + f * 2, y - 5, 2, 10, flash ? '#fff' : '#8f7fd0');
    if (this.guardFlash > 0) {
      glowDot(ctx, px + f * 2, y, 16, '#ffffff', this.guardFlash * 2);
    }
    // brace arms holding the plate on
    limb(ctx, x + f * 3, y - 4, f > 0 ? -0.5 : Math.PI + 0.5, 5, 2, dark);
    limb(ctx, x + f * 3, y + 4, f > 0 ? 0.5 : Math.PI - 0.5, 5, 2, dark);
    if (winding) {
      const a = this.aimAngle ?? 0;
      // a thin sight line showing exactly where it will go
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(ENEMY_TINT.shardling, 0.15 + k * 0.4);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * 120, y + Math.sin(a) * 120);
      ctx.stroke();
      ctx.restore();
    }
  }

  // A lantern of cold light with a slow rotating shell and a tether to every
  // ally it is feeding.
  drawWisp(ctx, t, flash) {
    const c = flash ? '#ffffff' : ENEMY_TINT.wisp;
    const x = this.cx, y = this.cy;
    const pulse = 0.6 + 0.4 * Math.sin(t * 4);

    // tethers first, under the body
    if (this.auraLinks && this.auraLinks.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const e of this.auraLinks) {
        if (!e || e.dead) continue;
        const g = ctx.createLinearGradient(x, y, e.cx, e.cy);
        g.addColorStop(0, rgba(ENEMY_TINT.wisp, 0.55 * pulse));
        g.addColorStop(1, rgba(ENEMY_TINT.wisp, 0.06));
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.lineDashOffset = -t * 22;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(e.cx, e.cy);
        ctx.stroke();
        ctx.setLineDash([]);
        // a bead running down the tether
        const k = (t * 0.8 + e.uid * 0.13) % 1;
        pxRect(ctx, lerp(x, e.cx, k) - 1, lerp(y, e.cy, k) - 1, 2, 2, rgba('#ffffff', 0.7));
      }
      ctx.restore();
    }

    glowDot(ctx, x, y, 22 + pulse * 10, c, 0.4);
    // rotating shell
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const a = t * (1.4 + i * 0.5) + i * 2.1;
      const r = 7 + i;
      ctx.strokeStyle = rgba(c, 0.35 - i * 0.07);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.42, a, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    // core
    pxRect(ctx, x - 3, y - 3, 6, 6, c);
    pxRect(ctx, x - 2, y - 2, 4, 4, '#ffffff');
    pxRect(ctx, x - 1, y - 5 - pulse, 2, 2, rgba('#ffffff', 0.8));
  }

  drawStinger(ctx, t, flash) {
    const c = flash ? '#ffffff' : Theme.enemyStinger;
    const d = flash ? '#ffffff' : Theme.enemyDark;
    const x = Math.round(this.x), y = Math.round(this.y - 6 + Math.sin(this.hover) * 1.5);
    const wing = Math.sin(t * 34) * 4;
    ctx.save();
    ctx.globalAlpha = 0.65;
    limb(ctx, x - 3, y - 4, -0.6 + wing * 0.12, 9, 4, flash ? '#fff' : '#bffff0');
    limb(ctx, x + 3, y - 4, Math.PI + 0.6 - wing * 0.12, 9, 4, flash ? '#fff' : '#bffff0');
    ctx.restore();
    pxRect(ctx, x - 5, y - 4, 10, 8, c);
    pxRect(ctx, x - 5, y - 4, 10, 2, flash ? '#fff' : '#9dffe0');
    pxRect(ctx, x - 3, y + 4, 6, 3, d);
    pxRect(ctx, x + (this.facing > 0 ? 1 : -3), y - 2, 3, 2, flash ? '#fff' : Theme.eye);
    // stinger tail
    limb(ctx, x - this.facing * 5, y + 2, this.facing > 0 ? Math.PI - 0.4 : 0.4, 7, 2, d);
    glowDot(ctx, x, y, 12, Theme.enemyStinger, 0.16);
  }
}

// --- projectiles ---------------------------------------------------------

export class Projectile {
  constructor(o) {
    Object.assign(this, {
      x: 0, y: 0, vx: 0, vy: 0, damage: 5, team: 'player', kind: 'arrow',
      life: 2, t: 0, dead: false, traveled: 0, maxDist: Infinity, gravity: 0,
      mark: false, slow: false, homing: 0, target: null, trail: [],
      spent: false, stuck: false, stuckT: 0, spin: 0,
      phase: 'out', owner: null, hitLog: null, wobble: 0,
      keepTop: false,        // arrow rain arcs above the screen and falls back
      fold: null,            // origami: which fold this sheet became
      bounces: 0, flutter: 0,
      shardPhase: null,      // shardgun: 'fly' -> 'hover' -> 'splinter' / 'fragment'
      hoverT: 0, baseDamage: 0, splinterAim: null,
    }, o);
    this.angle = Math.atan2(this.vy, this.vx);
  }

  update(dt) {
    this.t += dt;
    if (this.kind === 'nukerang') { this.updateNukerang(dt); return; }
    if (this.kind === 'shard') { this.updateShard(dt); return; }
    if (this.kind === 'origami') { this.updateOrigami(dt); return; }
    if (this.t >= this.life) { this.dead = true; return; }
    if (this.homing && this.target && !this.target.dead) {
      const a = Math.atan2(this.target.cy - this.y, this.target.cx - this.x);
      const cur = Math.atan2(this.vy, this.vx);
      const na = cur + shortAngle(cur, a) * clamp(this.homing * dt, 0, 1);
      const sp = Math.hypot(this.vx, this.vy);
      this.vx = Math.cos(na) * sp;
      this.vy = Math.sin(na) * sp;
    }
    // A spent arrow stuck in the floor just counts down and fades.
    if (this.stuck) {
      this.stuckT += dt;
      if (this.stuckT > 1.6) this.dead = true;
      return;
    }

    this.vy += this.gravity * dt;
    const dx = this.vx * dt, dy = this.vy * dt;
    this.x += dx; this.y += dy;
    this.traveled += Math.hypot(dx, dy);
    this.angle = this.spent ? this.angle + this.spin * dt : Math.atan2(this.vy, this.vx);
    if (this.spent) {
      // ease the tumble back into line with the fall so it lands point first
      const fall = Math.atan2(this.vy, this.vx);
      this.angle += shortAngle(this.angle, fall) * clamp(dt * 4.5, 0, 1);
      this.spin *= Math.pow(0.2, dt);
      const surface = surfaceBelow(this.x, this.y);
      if (this.y >= surface) {
        this.y = surface;
        this.stuck = true;
        this.vx = this.vy = 0;
        this.trail.length = 0;
        burst(this.x, this.y, 5, {
          color: Theme.groundEdge, kind: 'smoke', speedMin: 8, speedMax: 34,
          lifeMin: 0.2, lifeMax: 0.45, sizeMin: 1, sizeMax: 2, gravity: -8, glow: false,
        });
        return;
      }
    } else if (this.traveled >= this.maxDist) {
      this.goSpent();
      return;
    }
    if (this.x < -8 || this.x > VIEW_W + 8 || this.y > GROUND_Y + 4 ||
        (this.y < -20 && !this.keepTop)) {
      this.expire();
      return;
    }
    if (this.keepTop && this.y < -400) { this.dead = true; return; }
    this.trail.push([this.x, this.y]);
    if (this.trail.length > 8) this.trail.shift();

    if (this.kind === 'acid' && Math.random() < dt * 45) {
      spawnParticle({
        x: this.x, y: this.y, vx: rand(-8, 8), vy: rand(-6, 14), life: rand(0.2, 0.4),
        size: 1, color: '#a8e04a', gravity: 180, kind: 'shrink',
      });
    }
    if (this.kind === 'laser' && Math.random() < dt * 70) {
      spawnParticle({
        x: this.x, y: this.y, vx: rand(-14, 14), vy: rand(-14, 14), life: rand(0.1, 0.25),
        size: 1, color: Theme.lightning, gravity: 0, kind: 'shrink',
      });
    }
    if (this.kind === 'slime' && Math.random() < dt * 40) {
      spawnParticle({ x: this.x, y: this.y, vx: rand(-10, 10), vy: rand(-10, 10), life: 0.3, size: 1, color: Theme.slime, gravity: 40, kind: 'shrink' });
    }
  }

  // Shardgun round. Three acts: fly out five blocks, hang there for 0.87s
  // gathering light, then re-form as a splinter and streak at the cursor.
  updateShard(dt) {
    const C = SHARDGUN;
    if (this.t >= this.life) { this.expire(); return; }

    if (this.shardPhase === 'fly') {
      const dx = this.vx * dt, dy = this.vy * dt;
      this.x += dx; this.y += dy;
      this.traveled += Math.hypot(dx, dy);
      this.angle = Math.atan2(this.vy, this.vx);
      this.pushTrail();
      if (Math.random() < dt * 50) {
        spawnParticle({
          x: this.x, y: this.y, vx: -this.vx * 0.08, vy: -this.vy * 0.08, life: rand(0.1, 0.26),
          size: 1, color: SHARD_TINT, gravity: 0, kind: 'streak',
        });
      }
      if (this.traveled >= C.range) {
        this.shardPhase = 'hover';
        this.hoverT = C.hoverTime;
        this.vx = this.vy = 0;
        this.trail.length = 0;
        impactRing(this.x, this.y, { color: SHARD_TINT, r0: 1, r1: 14, life: 0.28, width: 1.5 });
        burst(this.x, this.y, 6, {
          color: SHARD_TINT, color2: '#ffffff', speedMin: 20, speedMax: 70,
          lifeMin: 0.1, lifeMax: 0.3, gravity: 0, kind: 'shrink',
        });
      }
      return;
    }

    if (this.shardPhase === 'hover') {
      this.hoverT -= dt;
      // it trembles harder the closer it gets to letting go
      const k = 1 - clamp(this.hoverT / C.hoverTime, 0, 1);
      this.angle += dt * (3 + k * 26);
      if (Math.random() < dt * (14 + k * 60)) {
        const a = rand(0, TAU), r = 10 + k * 10;
        spawnParticle({
          x: this.x + Math.cos(a) * r, y: this.y + Math.sin(a) * r,
          vx: -Math.cos(a) * (40 + k * 90), vy: -Math.sin(a) * (40 + k * 90),
          life: rand(0.12, 0.3), size: 1, color: k > 0.6 ? '#ffffff' : SHARD_TINT,
          gravity: 0, kind: 'shrink',
        });
      }
      if (this.hoverT <= 0) this.becomeSplinter();
      return;
    }

    // splinter / fragment: straight, fast, and nothing stops it but a hit
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle = Math.atan2(this.vy, this.vx);
    this.pushTrail();
    if (Math.random() < dt * 70) {
      spawnParticle({
        x: this.x, y: this.y, vx: rand(-16, 16), vy: rand(-16, 16), life: rand(0.06, 0.18),
        size: 1, color: this.shardPhase === 'fragment' ? '#ffffff' : SHARD_TINT,
        gravity: 0, kind: 'streak',
      });
    }
    if (this.x < -40 || this.x > VIEW_W + 40 || this.y < -40 || this.y > GROUND_Y + 20) {
      this.dead = true;
    }
  }

  // Folded paper. The plane glides and kicks off walls; the missile builds
  // speed until it hits something and goes off.
  updateOrigami(dt) {
    const cfg = ORIGAMI.forms[this.fold];
    this.flutter += dt * (this.fold === 'missile' ? 26 : 9);
    if (this.t >= this.life) { this.expire(); return; }

    if (this.fold === 'missile') {
      const sp = Math.hypot(this.vx, this.vy) || 1;
      const want = Math.min(cfg.maxSpeed, sp + cfg.accel * dt);
      this.vx = (this.vx / sp) * want;
      this.vy = (this.vy / sp) * want;
      // thicker exhaust the faster it goes
      const heat = clamp((want - cfg.speed) / (cfg.maxSpeed - cfg.speed), 0, 1);
      if (Math.random() < dt * (30 + heat * 90)) {
        spawnParticle({
          x: this.x - (this.vx / want) * 5, y: this.y - (this.vy / want) * 5,
          vx: -this.vx * 0.14 + rand(-20, 20), vy: -this.vy * 0.14 + rand(-20, 20),
          life: rand(0.15, 0.5), size: randInt(1, 2),
          color: Math.random() < 0.4 ? '#ffe9a8' : '#ff8a5c', gravity: -30, drag: 0.9,
          kind: Math.random() < 0.4 ? 'streak' : 'shrink',
        });
      }
      if (Math.random() < dt * 22) {
        spawnParticle({
          x: this.x, y: this.y, vx: rand(-14, 14), vy: rand(-14, 4), life: rand(0.4, 1.0),
          size: randInt(1, 3), color: '#3a3550', gravity: -22, drag: 0.92,
          kind: 'smoke', glow: false,
        });
      }
    } else {
      // the plane sinks, and its nose follows the sink
      this.vy += cfg.drop * dt;
      if (Math.random() < dt * 14) {
        spawnParticle({
          x: this.x, y: this.y, vx: rand(-10, 10), vy: rand(-6, 10), life: rand(0.2, 0.5),
          size: 1, color: '#efeade', gravity: 12, drag: 0.96, kind: 'shrink',
        });
      }
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle = Math.atan2(this.vy, this.vx);
    this.pushTrail();

    // walls: the plane kicks off them, the missile detonates on them
    const left = 3, right = VIEW_W - 3;
    if (this.x < left || this.x > right) {
      if (this.fold === 'missile') { this.detonate(); return; }
      this.x = clamp(this.x, left, right);
      this.vx = -this.vx;
      this.vy -= ORIGAMI.forms.airplane.bounceKick;    // a little lift off the kick
      this.bounces++;
      Sfx.ui();
      impactRing(this.x, this.y, { color: '#efeade', r0: 2, r1: 22, life: 0.25, width: 1.5 });
      burst(this.x, this.y, 10, {
        color: '#efeade', color2: '#ffffff', speedMin: 40, speedMax: 150,
        lifeMin: 0.12, lifeMax: 0.35, gravity: 90, drag: 0.88, kind: 'streak',
      });
      if (this.bounces > cfg.bounces) { this.expire(); return; }
    }

    // ground and platforms end a plane, and set a missile off
    const surface = surfaceBelow(this.x, this.y);
    if (this.y >= surface || this.y > GROUND_Y) {
      this.y = Math.min(this.y, surface);
      if (this.fold === 'missile') this.detonate();
      else this.crumple();
      return;
    }
    if (this.y < -30) { this.dead = true; }
  }

  // A plane that runs out of sky: it crumples and falls apart.
  crumple() {
    if (this.dead) return;
    this.dead = true;
    Sfx.ui();
    burst(this.x, this.y, 14, {
      color: '#efeade', color2: '#b9b2a2', speedMin: 20, speedMax: 120,
      lifeMin: 0.3, lifeMax: 0.9, sizeMax: 2, gravity: 320, drag: 0.9,
    });
    impactRing(this.x, this.y, { color: '#efeade', r0: 1, r1: 18, life: 0.24, width: 1.2, squash: 0.4 });
  }

  detonate() {
    if (this.dead) return;
    this.dead = true;
    if (this.game) this.game.paperBlast(this.x, this.y, this.damage);
  }

  pushTrail() {
    this.trail.push([this.x, this.y]);
    if (this.trail.length > 9) this.trail.shift();
  }

  // The hover ends: it points itself at wherever the cursor is right now.
  becomeSplinter() {
    const C = SHARDGUN;
    const aim = this.splinterAim ? this.splinterAim() : { x: this.x, y: this.y - 1 };
    const a = Math.atan2(aim.y - this.y, aim.x - this.x);
    this.shardPhase = 'splinter';
    this.vx = Math.cos(a) * C.splinterSpeed;
    this.vy = Math.sin(a) * C.splinterSpeed;
    this.damage = Math.max(1, Math.round(this.baseDamage * C.splinterDamage));
    this.life = this.t + C.splinterLife;
    this.trail.length = 0;
    Sfx.zap();
    impactRing(this.x, this.y, { color: '#ffffff', r0: 1, r1: 20, life: 0.22, width: 2 });
    burst(this.x, this.y, 8, {
      color: '#ffffff', color2: SHARD_TINT, kind: 'streak', speedMin: 120, speedMax: 300,
      lifeMin: 0.06, lifeMax: 0.16, gravity: 0, angle: a, spread: 0.5, drag: 0.85,
    });
  }

  // Out five blocks, then home back to the hand that threw it.
  updateNukerang(dt) {
    const o = this.owner;
    this.wobble += dt;
    this.angle += NUKERANG.spin * dt * (this.phase === 'out' ? 1 : 1.25);

    if (this.phase === 'out') {
      const sp = Math.hypot(this.vx, this.vy);
      // decelerate over the throw so the turnaround reads as a real arc
      const k = clamp(1 - this.traveled / NUKERANG.range, 0, 1);
      const want = NUKERANG.speed * (0.25 + 0.75 * k);
      const scale = sp > 1 ? want / sp : 1;
      this.vx *= scale;
      this.vy *= scale;
      const dx = this.vx * dt, dy = this.vy * dt;
      this.x += dx; this.y += dy;
      this.traveled += Math.hypot(dx, dy);
      if (this.traveled >= NUKERANG.range || this.x < 4 || this.x > VIEW_W - 4 || this.y < 4 || this.y > GROUND_Y) {
        this.phase = 'back';
      }
    } else {
      if (!o || o.dead) { this.dead = true; return; }
      const tx = o.x, ty = o.cy;
      const a = Math.atan2(ty - this.y, tx - this.x);
      const sp = NUKERANG.returnSpeed;
      this.vx = lerp(this.vx, Math.cos(a) * sp, 1 - Math.pow(0.0005, dt));
      this.vy = lerp(this.vy, Math.sin(a) * sp, 1 - Math.pow(0.0005, dt));
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (dist(this.x, this.y, tx, ty) < NUKERANG.catchRadius) {
        this.dead = true;
        if (o) {
          o.boomerangOut = null;
          o.attackCd = Math.max(o.attackCd, NUKERANG.cooldown);
          o.catchT = NUKERANG.catchTime;
        }
        Sfx.hit();
        Camera.add(2);
        Camera.punch(0.5);
        impactRing(this.x, this.y, { color: Theme.steel, r0: 2, r1: 16, life: 0.2, width: 1.5 });
        burst(this.x, this.y, 9, {
          color: Theme.steel, color2: '#ffffff', speedMin: 30, speedMax: 110,
          lifeMin: 0.1, lifeMax: 0.28, gravity: 0, kind: 'streak', drag: 0.85,
        });
        return;
      }
    }

    this.trail.push([this.x, this.y]);
    if (this.trail.length > 10) this.trail.shift();
    if (Math.random() < dt * 30) {
      spawnParticle({
        x: this.x + rand(-3, 3), y: this.y + rand(-3, 3), vx: rand(-14, 14), vy: rand(-14, 14),
        life: rand(0.12, 0.3), size: 1, color: Theme.fire, gravity: 0, kind: 'shrink',
      });
    }
  }

  // The nukerang keeps flying through enemies, but one enemy cannot set it
  // off again until the re-hit delay has passed.
  canHit(e) {
    if (this.kind !== 'nukerang') return true;
    if (!this.hitLog) this.hitLog = new Map();
    const last = this.hitLog.get(e.uid) ?? -99;
    return this.t - last >= NUKERANG.reHitDelay;
  }

  // Out of range: the arrow loses its drive, hangs for a beat, then drops.
  goSpent() {
    if (this.spent) return;
    this.spent = true;
    this.mark = false;
    this.gravity = 620;
    this.vx *= 0.34;
    this.vy = this.vy * 0.2 - 26;      // a small upward hitch before it falls
    this.spin = rand(-3.5, 3.5);
    this.t = 0;
    this.life = 4;
    this.trail.length = 0;
    // a puff of spent energy where the shot runs out
    burst(this.x, this.y, 6, {
      color: Theme.steel, color2: '#ffffff', speedMin: 10, speedMax: 55,
      lifeMin: 0.15, lifeMax: 0.35, sizeMax: 1, gravity: 120, kind: 'shrink',
    });
  }

  expire() {
    if (this.dead) return;
    this.dead = true;
    if (this.kind === 'acid') {
      burst(this.x, this.y, 16, {
        color: '#a8e04a', color2: '#e6ffb0', speedMin: 30, speedMax: 130,
        lifeMin: 0.2, lifeMax: 0.6, gravity: 380, angle: -Math.PI / 2, spread: 1.3,
      });
      Sfx.slime();
      return;
    }
    if (this.kind === 'godarrow') {
      // gold splash and a low ring wherever a god-arrow lands
      burst(this.x, this.y, 14, {
        color: '#ffd76a', color2: '#ffffff', speedMin: 40, speedMax: 200,
        lifeMin: 0.15, lifeMax: 0.5, gravity: 420, angle: -Math.PI / 2, spread: 1.2, drag: 0.9,
      });
      burst(this.x, this.y, 6, {
        color: '#ffffff', kind: 'streak', speedMin: 90, speedMax: 240,
        lifeMin: 0.06, lifeMax: 0.16, gravity: 0, angle: -Math.PI / 2, spread: 1.4, drag: 0.82,
      });
      impactRing(this.x, this.y, { color: '#ffe9a8', r0: 2, r1: 26, life: 0.28, width: 1.5, squash: 0.35 });
      return;
    }
    if (this.kind === 'shard') {
      burst(this.x, this.y, 8, {
        color: SHARD_TINT, color2: '#ffffff', speedMin: 30, speedMax: 140,
        lifeMin: 0.1, lifeMax: 0.3, gravity: 0, drag: 0.88, kind: 'shrink',
      });
      return;
    }
    if (this.kind === 'laser') {
      burst(this.x, this.y, 8, {
        color: Theme.lightning, color2: '#ffffff', speedMin: 20, speedMax: 110,
        lifeMin: 0.1, lifeMax: 0.3, gravity: 0, kind: 'line',
      });
      return;
    }
    const col = this.kind === 'slime' ? Theme.slime : this.team === 'enemy' ? Theme.enemyStinger : Theme.steel;
    burst(this.x, this.y, 5, { color: col, speedMin: 10, speedMax: 60, lifeMin: 0.1, lifeMax: 0.3, sizeMax: 1 });
  }

  onHit(target, game) {
    if (this.spent) return;
    if (this.kind === 'nukerang') {
      if (!this.hitLog) this.hitLog = new Map();
      this.hitLog.set(target.uid, this.t);
      game.nukerangBlast(this.x, this.y, this.owner);
      // a contact nudges it off course, which makes the return arc livelier
      const a = Math.atan2(this.y - target.cy, this.x - target.cx);
      this.vx += Math.cos(a) * 40;
      this.vy += Math.sin(a) * 40;
      return;
    }
    if (this.kind === 'origami' && this.fold === 'missile') { this.detonate(); return; }
    this.dead = true;
    if (this.team === 'player') {
      if (this.kind === 'slime') {
        target.applySlow(PERK.slimeSlow, PERK.slimeSlowDuration);
        Sfx.slime();
        burst(this.x, this.y, 10, { color: Theme.slime, speedMin: 20, speedMax: 90, lifeMin: 0.2, lifeMax: 0.5, gravity: 260 });
      } else {
        target.damage(this.damage, { angle: this.angle, spread: 0.9, knockback: 30, dir: sign(this.vx) });
        if (this.game?.player) this.game.player.registerHit();
        if (this.mark) target.applyMark();
      }
    } else {
      target.hurt(this.damage, this.x);
      burst(this.x, this.y, 8, { color: Theme.enemyStinger, speedMin: 20, speedMax: 90, lifeMin: 0.15, lifeMax: 0.4 });
    }
  }

  draw(ctx) {
    ctx.save();
    if (this.kind === 'slime') {
      const wob = Math.sin(this.t * 22) * 1;
      glowDot(ctx, this.x, this.y, 8, Theme.slime, 0.35);
      pxRect(ctx, this.x - 3, this.y - 2 + wob, 6, 5, Theme.slime);
      pxRect(ctx, this.x - 1, this.y - 3 + wob, 3, 2, '#dfffe6');
    } else if (this.kind === 'acid') {
      const wob = Math.sin(this.t * 18) * 1;
      glowDot(ctx, this.x, this.y, 10, '#a8e04a', 0.35);
      pxRect(ctx, this.x - 4, this.y - 3 + wob, 8, 6, '#a8e04a');
      pxRect(ctx, this.x - 2, this.y - 4 + wob, 4, 2, '#e6ffb0');
      pxRect(ctx, this.x - 5, this.y + wob, 2, 2, '#7ab52e');
    } else if (this.kind === 'laser') {
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      ctx.globalCompositeOperation = 'lighter';
      pxRect(ctx, -7, -2, 14, 4, rgba(Theme.lightning, 0.35));
      pxRect(ctx, -6, -1, 12, 2, Theme.lightning);
      pxRect(ctx, -2, -1, 6, 2, '#ffffff');
    } else if (this.kind === 'origami') {
      const plane = this.fold === 'airplane';
      // trail
      for (let i = 0; i < this.trail.length; i++) {
        const k = i / this.trail.length;
        pxRect(ctx, this.trail[i][0] - 1, this.trail[i][1] - 1, 2, 2,
               rgba(plane ? '#efeade' : '#ff8a5c', k * 0.4 * Theme.trail));
      }
      if (!plane) {
        glowDot(ctx, this.x, this.y, 16, '#ff8a5c', 0.45);
        glowDot(ctx, this.x, this.y, 7, '#ffe9a8', 0.6);
      } else {
        glowDot(ctx, this.x, this.y, 9, '#ffffff', 0.16);
      }
      ctx.translate(Math.round(this.x), Math.round(this.y));
      // planes bank as they glide; missiles just shudder
      ctx.rotate(this.angle + (plane ? Math.sin(this.flutter) * 0.10 : Math.sin(this.flutter) * 0.05));
      if (plane) {
        // a dart seen from the side: two folded wings and a keel
        ctx.fillStyle = '#efeade';
        ctx.beginPath();
        ctx.moveTo(7, 0); ctx.lineTo(-6, -4); ctx.lineTo(-3, 0); ctx.lineTo(-6, 4);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#c9c2b2';
        ctx.beginPath();
        ctx.moveTo(7, 0); ctx.lineTo(-6, 4); ctx.lineTo(-3, 0);
        ctx.closePath(); ctx.fill();
        pxRect(ctx, -3, -1, 10, 1, '#ffffff');
      } else {
        pxRect(ctx, -5, -2, 11, 4, '#efeade');
        pxRect(ctx, -5, -2, 11, 1, '#ffffff');
        pxRect(ctx, 5, -1, 3, 2, '#ff8a5c');
        pxRect(ctx, -6, -4, 3, 3, '#d7d0c0');
        pxRect(ctx, -6, 1, 3, 3, '#d7d0c0');
        ctx.globalCompositeOperation = 'lighter';
        pxRect(ctx, -12, -1, 7, 2, rgba('#ff8a5c', 0.7));
        pxRect(ctx, -9, -1, 4, 2, rgba('#ffe9a8', 0.9));
      }
    } else if (this.kind === 'shard') {
      const frag = this.shardPhase === 'fragment';
      const hover = this.shardPhase === 'hover';
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this.trail.length; i++) {
        const k = (i / this.trail.length);
        const w = frag ? 1 : 2;
        pxRect(ctx, this.trail[i][0] - w / 2, this.trail[i][1] - w / 2, w, w,
               rgba(SHARD_TINT, k * 0.55 * Theme.trail));
      }
      if (hover) {
        // suspended: a caged shard with a ring winding in around it
        const k = 1 - clamp(this.hoverT / SHARDGUN.hoverTime, 0, 1);
        glowDot(ctx, this.x, this.y, 8 + k * 16, SHARD_TINT, 0.3 + k * 0.5);
        ctx.strokeStyle = rgba('#ffffff', 0.25 + k * 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(this.x, this.y, 12 - k * 9, 0, TAU);
        ctx.stroke();
      } else {
        glowDot(ctx, this.x, this.y, frag ? 6 : 10, frag ? '#ffffff' : SHARD_TINT, 0.45);
      }
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      const L = frag ? 2 : this.shardPhase === 'splinter' ? 5 : 4;
      const H = frag ? 1 : 2;
      pxRect(ctx, -L, -H / 2, L * 2, H, SHARD_TINT);
      pxRect(ctx, -1, -H / 2, L, H, '#ffffff');
    } else if (this.kind === 'godarrow') {
      // a shaft of light with a gold head - it reads at a glance against the rain
      ctx.globalCompositeOperation = 'lighter';
      glowDot(ctx, this.x, this.y, 11, '#ffd76a', 0.4);
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      pxRect(ctx, -11, -1, 14, 2, rgba('#ffe9a8', 0.5));
      pxRect(ctx, -7, 0, 9, 1, '#ffd76a');
      pxRect(ctx, 1, -2, 4, 4, '#fff6d8');
      pxRect(ctx, 2, -1, 3, 2, '#ffffff');
      pxRect(ctx, -8, -2, 3, 1, rgba('#ffe9a8', 0.85));
      pxRect(ctx, -8, 1, 3, 1, rgba('#ffe9a8', 0.85));
    } else if (this.team === 'enemy') {
      glowDot(ctx, this.x, this.y, 9, Theme.enemyStinger, 0.4);
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      pxRect(ctx, -4, -1, 8, 2, Theme.enemyStinger);
      pxRect(ctx, 2, -2, 3, 4, '#ffffff');
    } else if (this.kind === 'nukerang') {
      for (let i = 0; i < this.trail.length; i++) {
        const a = (i / this.trail.length) * 0.4 * Theme.trail;
        pxRect(ctx, this.trail[i][0] - 1, this.trail[i][1] - 1, 2, 2, rgba(Theme.fire, a));
      }
      glowDot(ctx, this.x, this.y, 11, Theme.fire, 0.32);
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      drawBoomerang(ctx, 9, 4, Theme.steel, Theme.steelDark, Theme.fireHot);
    } else if (this.stuck) {
      // planted in the floor, fading out
      const k = clamp(1 - (this.stuckT - 1.0) / 0.6, 0, 1);
      ctx.globalAlpha = k;
      dropShadow(ctx, this.x, this.y, 4, 0);
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      pxRect(ctx, -9, 0, 9, 1, '#6d4a28');
      pxRect(ctx, -10, -2, 3, 1, rgba('#dfe9ff', 0.8));
      pxRect(ctx, -10, 1, 3, 1, rgba('#dfe9ff', 0.8));
      ctx.globalAlpha = 1;
    } else if (this.spent) {
      // tumbling, dimmer than a live shot
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      pxRect(ctx, -6, 0, 9, 1, '#6d4a28');
      pxRect(ctx, 3, -1, 3, 2, rgba(Theme.steel, 0.75));
      pxRect(ctx, -7, -2, 3, 1, rgba('#dfe9ff', 0.7));
      pxRect(ctx, -7, 1, 3, 1, rgba('#dfe9ff', 0.7));
    } else {
      // trail
      for (let i = 0; i < this.trail.length; i++) {
        const a = (i / this.trail.length) * 0.5 * Theme.trail;
        pxRect(ctx, this.trail[i][0] - 1, this.trail[i][1] - 1, 2, 2, rgba(this.mark ? Theme.lightning : Theme.steel, a));
      }
      if (this.mark) glowDot(ctx, this.x, this.y, 9, Theme.lightning, 0.45);
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      pxRect(ctx, -6, 0, 9, 1, '#8a5a32');
      pxRect(ctx, 3, -1, 4, 2, this.mark ? Theme.lightning : Theme.steel);
      pxRect(ctx, -7, -2, 3, 1, '#dfe9ff');
      pxRect(ctx, -7, 1, 3, 1, '#dfe9ff');
    }
    ctx.restore();
  }
}

// --- player --------------------------------------------------------------

export class Player {
  constructor(game, classId) {
    this.game = game;
    this.classId = classId;
    this.x = VIEW_W / 2;
    this.y = GROUND_Y;
    this.w = PLAYER.w;
    this.h = PLAYER.h;
    this.vx = 0; this.vy = 0;
    this.onGround = true;
    this.platform = null;
    this.facing = 1;
    this.baseMaxHp = PLAYER.maxHp;
    this.maxHp = PLAYER.maxHp;
    this.hp = PLAYER.maxHp;
    this.dead = false;
    this.anim = 0;
    this.invuln = 0;
    this.dashT = 0;
    this.dashCd = 0;
    this.dropT = 0;
    this.slamming = false;
    this.attackCd = 0;
    this.swing = null;
    this.ammo = BOW.ammo;
    this.reloadT = 0;
    this.lastGunId = null;
    this.daggerHits = 0;
    this.emberDash = 0;
    this.slimeT = PERK.slimeInterval;
    this.chainCd = 0;
    this.shield = 0;
    this.shieldMax = 0;
    this.shieldRegenT = 0;
    this.hitStreak = 0;
    this.boomerangOut = null;
    this.nukeBlasts = 0;
    this.throwWind = 0;
    this.throwAim = 0;
    this.catchT = 0;
    this.grapple = null;
    this.grappleCd = 0;
    this.afterimages = [];
    this.dashPath = [];
    this.dashDir = 1;
    this.scarf = makeChain(4, this.x, this.y - 16);
    this.cape = makeChain(5, this.x, this.y - 14);
    this.bladeTrail = [];
    this.dustT = 0;
    this.stepT = 0;
    this.aim = 0;
    this.controls = true;
    this.landSquash = 0;
    this.hurtFlash = 0;
    this.inventory = new Inventory();
    if (classId === 'origamist') {
      // paper is the weapon; the book is the manual it is folded from
      this.inventory.add('paper', ORIGAMI.startPaper);
      this.inventory.add('bookairplane', 1);
    } else {
      this.inventory.add(classId === 'melee' ? 'sword' : 'bow', 1);
    }
    this.recomputeStats();
    this.hp = this.maxHp;
  }

  get cx() { return this.x; }
  get cy() { return this.y - this.h / 2; }

  recomputeStats() {
    const aegis = this.inventory.countOf('aegis');
    const newShieldMax = aegis * PERK.aegisShield;
    if (newShieldMax > this.shieldMax) this.shield += newShieldMax - this.shieldMax;
    this.shieldMax = newShieldMax;
    this.shield = clamp(this.shield, 0, this.shieldMax);
    const stacks = Math.min(this.inventory.countOf('lifecrystal'), PERK.lifeCrystalMaxStacks);
    // the Damage Booster pays for its punch out of your health bar
    const boosters = this.inventory.countOf('damagebooster');
    this.classDamageMult = 1 + boosters * PERK.boosterDamage;
    const newMax = Math.max(10,
      this.baseMaxHp + stacks * PERK.lifeCrystalHp - boosters * PERK.boosterMaxHp);
    if (newMax !== this.maxHp) {
      const diff = newMax - this.maxHp;
      this.maxHp = newMax;
      this.hp = clamp(this.hp + Math.max(0, diff), 1, this.maxHp);
    }
    this.hp = Math.min(this.hp, this.maxHp);
  }

  // Which weapon families your chosen class counts as its own. The Damage
  // Booster only lifts these, so it never turns a stray pickup into the build.
  get classWeapons() {
    if (this.classId === 'ranger') return CLASS_WEAPONS.ranger;
    if (this.classId === 'origamist') return CLASS_WEAPONS.origamist;
    return CLASS_WEAPONS.melee;
  }

  // Scale a weapon's damage by the booster, if that weapon is your class's.
  boosted(amount, weaponKind) {
    const mult = this.classDamageMult ?? 1;
    if (mult === 1 || !this.classWeapons.includes(weaponKind)) return amount;
    return Math.max(1, Math.round(amount * mult));
  }

  // Every hit you land; Bloodstone pays out on each fifth one.
  registerHit() {
    const stacks = this.inventory.countOf('bloodstone');
    if (stacks <= 0) { this.hitStreak = 0; return; }
    this.hitStreak++;
    if (this.hitStreak < PERK.bloodstoneHits) return;
    this.hitStreak = 0;
    const heal = PERK.bloodstoneHeal + (stacks - 1) * PERK.bloodstoneStackHeal;
    if (this.hp >= this.maxHp) return;
    this.hp = clamp(this.hp + heal, 0, this.maxHp);
    floatText(this.cx, this.cy - 18, `+${heal}`, '#8ce88c', { life: 0.7 });
    burst(this.cx, this.cy, 8, {
      color: Theme.hp, color2: '#8ce88c', speedMin: 15, speedMax: 70,
      lifeMin: 0.2, lifeMax: 0.5, gravity: -60,
    });
  }

  hurt(amount, fromX) {
    if (this.dead || this.invuln > 0 || this.dashT > 0) return;
    if (this.game.debug?.god) return;
    this.shieldRegenT = PERK.aegisRegenDelay;
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, amount);
      this.shield -= soaked;
      amount -= soaked;
      floatText(this.cx, this.cy - 20, `-${Math.round(soaked)}`, '#8fd8ff', { life: 0.7 });
      burst(this.cx, this.cy, 12, {
        color: '#8fd8ff', color2: '#ffffff', speedMin: 30, speedMax: 130,
        lifeMin: 0.2, lifeMax: 0.5,
      });
      Sfx.hit();
      Camera.add(4);
      if (amount <= 0) {
        this.invuln = PLAYER.invulnTime * 0.6;
        return;
      }
    }
    this.hp -= amount;
    this.invuln = PLAYER.invulnTime;
    this.hurtFlash = 0.25;
    this.vx += sign(this.x - fromX) * 90;
    this.vy = Math.min(this.vy, -130);
    Camera.add(6);
    this.game.postfx.hit = 1;
    this.game.hitstop(0.07);
    Sfx.hurt();
    floatText(this.cx, this.cy - 12, `-${Math.round(amount)}`, Theme.hp, { crit: true });
    burst(this.cx, this.cy, 12, { color: Theme.hp, color2: '#ffffff', speedMin: 30, speedMax: 140, lifeMin: 0.2, lifeMax: 0.5 });
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.releaseGrapple(true);
      Sfx.die();
      Camera.add(12);
      burst(this.cx, this.cy, 40, { color: Theme.player, color2: Theme.hp, speedMin: 30, speedMax: 220, lifeMin: 0.4, lifeMax: 1.1, sizeMax: 3 });
      this.game.onPlayerDeath();
    }
  }

  heal(n) {
    this.hp = clamp(this.hp + n, 0, this.maxHp);
    floatText(this.cx, this.cy - 14, `+${n}`, '#8ce88c');
  }

  // Restores a fraction of max HP. Returns how much was actually restored.
  healPct(frac) {
    if (this.dead) return 0;
    const before = this.hp;
    this.hp = clamp(this.hp + this.maxHp * frac, 0, this.maxHp);
    const gained = Math.round(this.hp - before);
    if (gained <= 0) return 0;
    floatText(this.cx, this.cy - 16, `+${gained}`, '#8ce88c', { life: 1.1, crit: true });
    burst(this.cx, this.cy, 18, {
      color: '#8ce88c', color2: '#ffffff', speedMin: 18, speedMax: 90,
      lifeMin: 0.3, lifeMax: 0.8, gravity: -90, sizeMax: 2,
    });
    Sfx.pickup();
    return gained;
  }

  update(dt, input) {
    this.anim += dt * Theme.animSpeed;
    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.dropT = Math.max(0, this.dropT - dt);
    this.landSquash = Math.max(0, this.landSquash - dt * 5.5);
    this.chainCd = Math.max(0, this.chainCd - dt);
    this.catchT = Math.max(0, this.catchT - dt);
    if (this.throwWind > 0) {
      this.throwWind -= dt;
      if (this.throwWind <= 0) { this.throwWind = 0; this.releaseNukerang(); }
    }
    if (this.swing) {
      this.swing.t += dt;
      if (this.swing.t > SWORD.swingTime * 1.6) this.swing = null;
    }
    for (let i = this.afterimages.length - 1; i >= 0; i--) {
      this.afterimages[i].t += dt;
      if (this.afterimages[i].t > 0.28) this.afterimages.splice(i, 1);
    }
    this.updateSecondaryMotion(dt);
    if (this.dead) {
      this.vy += GRAVITY * dt;
      this.vx *= 0.9;
      moveAndCollide(this, dt);
      return;
    }

    this.recomputeStats();
    if (this.game.debug?.infHealth) {
      this.hp = this.maxHp;
      this.shield = this.shieldMax;
    } else if (this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + PLAYER.regenPerSecond * dt);
    }
    this.updateReload(dt);
    this.updatePerks(dt);

    const c = this.controls ? input : null;
    this.aim = Math.atan2(input.mouse.y - this.cy, input.mouse.x - this.x);
    if (c) {
      this.facing = Math.abs(input.mouse.x - this.x) > 4 ? sign(input.mouse.x - this.x) : this.facing;
    }

    // --- horizontal movement
    let move = 0;
    if (c) {
      if (c.keys.has(Binds.left)) move -= 1;
      if (c.keys.has(Binds.right)) move += 1;
    }
    if (this.emberDash > 0) {
      // the dagger dash burns as it goes, and scorches what it passes
      this.emberDash -= dt;
      if (Math.random() < dt * 140) {
        spawnParticle({
          x: this.x + rand(-6, 6), y: this.cy + rand(-9, 9),
          vx: rand(-40, 40) - this.dashDir * 60, vy: rand(-70, -10),
          life: rand(0.2, 0.6), size: randInt(1, 2),
          color: Math.random() < 0.5 ? Theme.fireHot : Theme.fire,
          gravity: -90, drag: 0.92, kind: Math.random() < 0.5 ? 'streak' : 'shrink',
        });
      }
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      // a continuous smear of where the body has been, not just stamps
      this.dashPath.push([this.x, this.cy]);
      if (this.dashPath.length > 14) this.dashPath.shift();
      if (Math.random() < dt * 70) {
        this.afterimages.push({ x: this.x, y: this.y, facing: this.facing, t: 0 });
      }
      // speed lines drawn out behind, parallel to the dash
      if (Math.random() < dt * 90 * Theme.dashStreaks) {
        spawnParticle({
          x: this.x - this.dashDir * rand(0, 10), y: this.cy + rand(-9, 9),
          vx: -this.dashDir * rand(160, 340), vy: rand(-12, 12),
          life: rand(0.1, 0.24), size: randInt(1, 2), color: Theme.dashCore,
          color2: Theme.dashGlow, gravity: 0, drag: 0.84, kind: 'streak',
        });
      }
      spawnParticle({
        x: this.x + rand(-4, 4), y: this.y - rand(0, this.h), vx: rand(-20, 20), vy: rand(-20, 20),
        life: rand(0.15, 0.35), size: 1, color: Theme.dashGlow, gravity: 0, kind: 'shrink',
      });
      if (this.dashT <= 0) {
        this.vx *= 0.4;
        this.endDashFlourish();
      }
    } else {
      if (this.dashPath.length) this.dashPath.shift();
      const swinging = this.grapple && this.grapple.state === 'attached';
      const accel = (this.onGround ? PLAYER.accel : PLAYER.airAccel) *
        (swinging ? GRAPPLE.airControl : 1);
      if (move !== 0) {
        this.vx += move * accel * dt;
        this.vx = clamp(this.vx, -PLAYER.speed, PLAYER.speed);
      } else if (this.onGround && !swinging) {
        this.vx = Math.abs(this.vx) < PLAYER.friction * dt ? 0 : this.vx - sign(this.vx) * PLAYER.friction * dt;
      } else if (!swinging) {
        this.vx *= Math.pow(0.6, dt * 4);
      }
    }

    // --- dash. Fires only on the frame a genuine second tap lands. No
    // buffering, no alternate key, nothing that can go off later: if the tap
    // arrives while the dash is on cooldown it is simply dropped.
    if (c && this.dashCd <= 0 && this.dashT <= 0) {
      if (c.doubleTap.has(Binds.left)) this.startDash(-1);
      else if (c.doubleTap.has(Binds.right)) this.startDash(1);
    }

    // --- jump
    if (c && c.pressed.has(Binds.jump) && this.onGround && !this.slamming) {
      this.vy = -PLAYER.jumpVel;
      this.onGround = false;
      Sfx.jump();
      burst(this.x, this.y, 7, { color: Theme.platformGlow, speedMin: 20, speedMax: 70, lifeMin: 0.15, lifeMax: 0.35, gravity: 120, angle: -Math.PI / 2, spread: 1.1 });
    }

    // --- drop through / ground slam
    if (c && c.doubleTap.has(Binds.down) && !this.onGround && !this.slamming) {
      this.slamming = true;
      this.vy = PLAYER.slamVel;
      this.vx *= 0.3;
      Sfx.dash();
      burst(this.x, this.cy, 10, { color: Theme.uiAccent, speedMin: 20, speedMax: 90, lifeMin: 0.15, lifeMax: 0.4, gravity: -60, angle: -Math.PI / 2, spread: 1.4 });
    } else if (c && c.pressed.has(Binds.down) && this.onGround && this.platform) {
      this.dropT = PLAYER.dropTime;
      this.y += 2;
      this.onGround = false;
      this.platform = null;
    }

    if (this.slamming) {
      spawnParticle({
        x: this.x + rand(-4, 4), y: this.cy, vx: rand(-30, 30), vy: rand(-90, -30),
        life: rand(0.15, 0.35), size: randInt(1, 2), color: Theme.uiAccent, gravity: 0, kind: 'shrink',
      });
    }

    // --- grapple
    this.grappleCd = Math.max(0, this.grappleCd - dt);
    if (c && c.pressed.has(Binds.grapple)) this.toggleGrapple();
    this.updateGrapple(dt);

    // --- attacks
    if (c && input.mouse.left && this.attackCd <= 0) this.attack();
    if (c && c.pressed.has(Binds.reload)) this.startReload();

    // --- gravity + collide
    if (this.dashT <= 0) this.vy += GRAVITY * dt;
    else this.vy = lerp(this.vy, 0, 1 - Math.pow(0.0001, dt));
    this.vy = Math.min(this.vy, 900);
    const before = this.onGround;
    moveAndCollide(this, dt, { ignorePlatforms: this.dropT > 0 });
    this.applyRopeConstraint();
    if (!before && this.onGround) this.onLand();
  }

  releaseNukerang() {
    const a = this.throwAim;
    const pr = new Projectile({
      x: this.x + Math.cos(a) * 10, y: this.cy + Math.sin(a) * 10,
      vx: Math.cos(a) * NUKERANG.speed, vy: Math.sin(a) * NUKERANG.speed,
      damage: NUKERANG.hitDamage, kind: 'nukerang', team: 'player',
      life: 99, owner: this, game: this.game,
    });
    this.boomerangOut = pr;
    this.game.projectiles.push(pr);
    this.swing = { t: 0, angle: a, kind: 'throw' };
    Sfx.bow();
    Camera.add(2.5);
    Camera.punch(-0.7);
    // a crescent of release sparks along the throwing arc
    impactRing(this.x + Math.cos(a) * 12, this.cy + Math.sin(a) * 12, {
      color: Theme.fire, r0: 3, r1: 22, life: 0.26, width: 2, arc: 1.0, angle: a,
    });
    burst(this.x + Math.cos(a) * 12, this.cy + Math.sin(a) * 12, 10, {
      color: '#ffffff', color2: Theme.fire, kind: 'streak',
      speedMin: 120, speedMax: 300, lifeMin: 0.1, lifeMax: 0.26,
      angle: a, spread: 0.45, gravity: 0, drag: 0.86,
    });
  }

  // --- grappling hook ----------------------------------------------------

  toggleGrapple() {
    if (!this.inventory.has('graplinghook')) return;
    if (this.grapple) { this.releaseGrapple(); return; }
    if (this.grappleCd > 0) return;
    const a = this.aim;
    this.grapple = {
      state: 'flying',
      x: this.x + Math.cos(a) * 8,
      y: this.cy + Math.sin(a) * 8,
      vx: Math.cos(a) * GRAPPLE.hookSpeed,
      vy: Math.sin(a) * GRAPPLE.hookSpeed,
      len: 0,
      angle: a,
      t: 0,
    };
    Sfx.bow();
    burst(this.x + Math.cos(a) * 10, this.cy + Math.sin(a) * 10, 5, {
      color: Theme.hookColor, speedMin: 20, speedMax: 80, lifeMin: 0.1, lifeMax: 0.24,
      angle: a, spread: 0.4, gravity: 0,
    });
  }

  releaseGrapple(silent = false) {
    if (!this.grapple) return;
    const g = this.grapple;
    if (g.state === 'attached' && !silent) {
      burst(g.x, g.y, 8, {
        color: Theme.hookColor, color2: '#ffffff', speedMin: 25, speedMax: 110,
        lifeMin: 0.1, lifeMax: 0.3, gravity: 180, kind: 'shrink',
      });
      Sfx.ui();
    }
    this.grapple = null;
    this.grappleCd = GRAPPLE.cooldown;
  }

  // Terrain the hook can bite: the floor, the arena edges, and any platform.
  hookHit(x, y) {
    if (y >= GROUND_Y) return { x, y: GROUND_Y };
    if (y <= 2) return { x, y: 2 };
    if (x <= 2) return { x: 2, y };
    if (x >= VIEW_W - 2) return { x: VIEW_W - 2, y };
    for (const p of PLATFORMS) {
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return { x, y };
    }
    return null;
  }

  updateGrapple(dt) {
    const g = this.grapple;
    if (!g) return;
    g.t += dt;

    if (g.state === 'flying' || g.state === 'falling') {
      if (g.state === 'falling') {
        // out of reach: it stops driving forward and drops, but it is still a
        // live hook - anything it lands on still catches and still pulls
        g.vx *= Math.pow(0.35, dt);
        g.vy += GRAPPLE.fallGravity * dt;
      }
      // step in small slices so a fast hook cannot tunnel through a platform
      const steps = Math.max(1, Math.ceil((Math.hypot(g.vx, g.vy) * dt) / 4));
      for (let i = 0; i < steps; i++) {
        const px = g.x, py = g.y;
        g.x += (g.vx * dt) / steps;
        g.y += (g.vy * dt) / steps;
        g.len = dist(this.x, this.cy, g.x, g.y);
        const bite = this.hookHit(g.x, g.y);
        if (bite) {
          g.x = bite.x;
          g.y = bite.y;
          g.state = 'attached';
          g.len = Math.max(GRAPPLE.minLength, dist(this.x, this.cy, g.x, g.y));
          Sfx.hit();
          Camera.add(2);
          Camera.punch(0.4);
          impactRing(g.x, g.y, { color: Theme.hookColor, r0: 2, r1: 14, life: 0.2, width: 1.5 });
          burst(g.x, g.y, 7, {
            color: Theme.groundEdge, color2: '#ffffff', speedMin: 25, speedMax: 100,
            lifeMin: 0.1, lifeMax: 0.3, gravity: 240,
            angle: Math.atan2(-g.vy, -g.vx), spread: 1.0,
          });
          break;
        }
        if (g.state === 'flying' && g.len >= GRAPPLE.maxLength) {
          g.state = 'falling';
          g.vx *= GRAPPLE.fallDrag;
          g.vy = Math.min(g.vy * GRAPPLE.fallDrag, 0);
          burst(g.x, g.y, 5, {
            color: Theme.hookColor, speedMin: 8, speedMax: 40, lifeMin: 0.1, lifeMax: 0.28,
            gravity: 120, kind: 'shrink',
          });
        }
        if (g.len >= GRAPPLE.maxLength * GRAPPLE.maxRope) {
          // the line itself finally runs out
          this.releaseGrapple(true);
          burst(px, py, 4, {
            color: Theme.hookColor, speedMin: 10, speedMax: 50, lifeMin: 0.1, lifeMax: 0.25,
            gravity: 200, kind: 'shrink',
          });
          return;
        }
      }
      return;
    }

    // attached: reel the rope in and haul yourself along it
    const dx = g.x - this.x, dy = g.y - this.cy;
    const d = Math.hypot(dx, dy) || 0.0001;
    g.len = Math.max(GRAPPLE.minLength, g.len - GRAPPLE.reelSpeed * dt);
    const nx = dx / d, ny = dy / d;
    this.vx += nx * GRAPPLE.pull * dt;
    this.vy += ny * GRAPPLE.pull * dt;
    if (Math.random() < dt * 22) {
      const k = rand(0.2, 0.9);
      spawnParticle({
        x: lerp(this.x, g.x, k), y: lerp(this.cy, g.y, k),
        vx: rand(-10, 10), vy: rand(-16, 4), life: rand(0.15, 0.35),
        size: 1, color: Theme.ropeCore, gravity: 20, kind: 'shrink',
      });
    }
    if (d < GRAPPLE.minLength + 4) this.releaseGrapple();
  }

  // Run after movement: keep the body inside the rope and kill the outward
  // velocity, which is what turns a taut rope into a swing.
  applyRopeConstraint() {
    const g = this.grapple;
    if (!g || g.state !== 'attached') return;
    const dx = this.x - g.x, dy = this.cy - g.y;
    const d = Math.hypot(dx, dy);
    if (d <= g.len || d < 0.001) return;
    const nx = dx / d, ny = dy / d;
    const pull = d - g.len;
    this.x -= nx * pull;
    this.y -= ny * pull;
    const radial = this.vx * nx + this.vy * ny;
    if (radial > 0) {
      this.vx -= nx * radial;
      this.vy -= ny * radial;
    }
    this.x = clamp(this.x, this.w / 2, VIEW_W - this.w / 2);
  }

  drawGrapple(ctx) {
    const g = this.grapple;
    if (!g) return;
    const sx = this.x, sy = this.cy;
    const d = dist(sx, sy, g.x, g.y);
    const slack = g.state === 'attached' ? clamp((g.len - d) / 30, 0, 1)
      : g.state === 'falling' ? 0.85 : 0.35;
    const segs = 10;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      // a rope hangs; the slacker it is, the deeper the belly
      const sag = Math.sin(k * Math.PI) * slack * 14;
      pts.push([lerp(sx, g.x, k), lerp(sy, g.y, k) + sag]);
    }
    ctx.save();
    ctx.strokeStyle = rgba(Theme.ropeColor, 0.95);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= segs; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.strokeStyle = rgba(Theme.ropeCore, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // the claw, pointing the way it flew
    const ang = g.state === 'attached'
      ? Math.atan2(g.y - pts[segs - 1][1], g.x - pts[segs - 1][0])
      : Math.atan2(g.vy, g.vx);
    ctx.save();
    ctx.translate(Math.round(g.x), Math.round(g.y));
    ctx.rotate(ang);
    pxRect(ctx, -4, -1, 6, 2, Theme.hookColor);
    limb(ctx, 1, 0, -0.9, 5, 2, Theme.hookColor);
    limb(ctx, 1, 0, 0.9, 5, 2, Theme.hookColor);
    ctx.restore();
    if (g.state === 'attached') glowDot(ctx, g.x, g.y, 9, Theme.hookColor, 0.3);
  }

  // Snap the trailing chains to the body, after a teleport or a room change.
  resetChains() {
    for (const c of [this.scarf, this.cape]) {
      for (const n of c) { n.x = this.x; n.y = this.y - 15; n.px = n.x; n.py = n.y; }
    }
    this.bladeTrail.length = 0;
  }

  // Scarf and cape hang off verlet chains, the blade tip leaves a ribbon.
  updateSecondaryMotion(dt) {
    const step = Math.min(dt, 1 / 50);
    // trail behind the direction of travel, and always drift a little backwards
    const wind = -this.vx * 1.3 - this.facing * 45 - (this.dashT > 0 ? this.facing * 260 : 0);
    stepChain(this.scarf, this.x + this.facing * 1, this.y - 16, step, {
      seg: 2.8, gravity: 80, damping: 0.9, windX: wind,
    });
    stepChain(this.cape, this.x - this.facing * 3, this.y - 15, step, {
      seg: 3.0, gravity: 120, damping: 0.88, windX: wind * 0.8,
    });
    // never let cloth sink through the floor the character stands on
    const floor = this.y - 2;
    for (const c of [this.scarf, this.cape]) {
      for (let i = 1; i < c.length; i++) if (c[i].y > floor) c[i].y = floor;
    }

    const sw = this.swing;
    if (sw && sw.kind === 'melee') {
      const p = clamp(sw.t / SWORD.swingTime, 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const a = sw.angle - sw.arc * 0.95 + e * sw.arc * 1.9;
      const reach = 24;
      this.bladeTrail.push([this.x + Math.cos(a) * reach, (this.y - 13) + Math.sin(a) * reach]);
      if (this.bladeTrail.length > 9) this.bladeTrail.shift();
    } else if (this.dashT > 0 && this.inventory.selectedWeapon()?.weapon === 'melee') {
      // the lunge draws a ribbon too, straight along the dash
      this.bladeTrail.push([this.x + this.facing * 28, this.y - 13]);
      if (this.bladeTrail.length > 9) this.bladeTrail.shift();
    } else if (this.bladeTrail.length) {
      this.bladeTrail.shift();
    }

    // running dust
    if (this.onGround && Math.abs(this.vx) > 55 && !this.dead) {
      this.dustT -= dt;
      if (this.dustT <= 0) {
        this.dustT = 0.09;
        spawnParticle({
          x: this.x - sign(this.vx) * 3, y: this.y - 1,
          vx: -sign(this.vx) * rand(10, 40), vy: rand(-14, -2),
          life: rand(0.28, 0.5), size: randInt(1, 3), color: Theme.groundEdge,
          gravity: -12, drag: 0.9, kind: 'smoke', glow: false,
        });
      }
    }
  }

  // A short bloom of light where the dash lets go, so it ends on a beat.
  endDashFlourish() {
    impactRing(this.x, this.cy, {
      color: Theme.dashGlow, r0: 3, r1: 20 * Theme.dashRingScale, life: 0.22,
      width: 1.5, squash: 0.5,
    });
    burst(this.x, this.cy, 6, {
      color: Theme.dashCore, color2: Theme.dashGlow, kind: 'shrink',
      speedMin: 15, speedMax: 70, lifeMin: 0.1, lifeMax: 0.3, gravity: 0,
    });
  }

  startDash(dir) {
    this.dashPath.length = 0;
    this.dashDir = dir;
    this.dashT = PLAYER.dashTime;
    this.dashCd = PLAYER.dashCooldown;
    this.facing = dir;
    this.vx = dir * PLAYER.dashSpeed;
    this.vy = Math.min(this.vy, 0) * 0.2;
    this.invuln = Math.max(this.invuln, PLAYER.dashTime + 0.05);
    Sfx.dash();
    Camera.add(2);
    Camera.punch(-0.9);
    burst(this.x, this.cy, 12, {
      color: Theme.dashGlow, color2: Theme.dashCore, speedMin: 40, speedMax: 150,
      lifeMin: 0.15, lifeMax: 0.4, angle: dir > 0 ? Math.PI : 0, spread: 0.7, gravity: 0,
    });
    burst(this.x, this.cy, 10, {
      color: Theme.dashCore, color2: Theme.dashGlow, kind: 'streak',
      speedMin: 150, speedMax: 340, lifeMin: 0.1, lifeMax: 0.26, gravity: 0, drag: 0.85,
      angle: dir > 0 ? Math.PI : 0, spread: 0.45,
    });
    // a flat ring thrown out sideways: reads as a launch, not an explosion
    impactRing(this.x, this.cy, {
      color: Theme.dashGlow, r0: 4, r1: 30 * Theme.dashRingScale, life: 0.3, width: 2,
      squash: 0.32, rotate: 0,
    });
    impactRing(this.x, this.cy, {
      color: Theme.dashCore, r0: 2, r1: 18 * Theme.dashRingScale, life: 0.2, width: 1.5,
      squash: 0.32, rotate: 0,
    });
  }

  onLand() {
    this.landSquash = 1;
    if (this.slamming) {
      this.slamming = false;
      Sfx.slam();
      Camera.add(11);
      this.game.hitstop(0.07);
      this.game.shockwaves.push({ x: this.x, y: this.y, t: 0, r: PLAYER.slamRadius });
      Camera.punch(2.6);
      impactRing(this.x, this.y - 2, { color: Theme.uiAccent, r0: 6, r1: 74, life: 0.42, width: 3, squash: 0.34 });
      impactRing(this.x, this.y - 2, { color: '#ffffff', r0: 3, r1: 40, life: 0.26, width: 2, squash: 0.34 });
      burst(this.x, this.y, 12, {
        color: Theme.groundEdge, kind: 'smoke', speedMin: 30, speedMax: 120,
        lifeMin: 0.4, lifeMax: 0.9, sizeMin: 2, sizeMax: 4, gravity: -20, drag: 0.88, glow: false,
      });
      burst(this.x, this.y, 32, {
        color: Theme.uiAccent, color2: Theme.fire, speedMin: 60, speedMax: 240,
        lifeMin: 0.2, lifeMax: 0.6, sizeMax: 3, gravity: 420, angle: -Math.PI / 2, spread: 1.5,
      });
      for (const e of this.game.enemies) {
        if (e.dead || e.spawnT > 0) continue;
        if (e.untargetable || e.def.slamImmune) continue;   // nothing airborne and holy cares
        if (dist(e.cx, e.cy, this.x, this.y) < PLAYER.slamRadius + e.radius) {
          e.damage(PLAYER.slamDamage, {
            knockback: 170, fromX: this.x, color: Theme.uiAccent, shake: 0, crit: true,
          });
        }
      }
    } else {
      burst(this.x, this.y, 5, { color: Theme.groundEdge, speedMin: 10, speedMax: 50, lifeMin: 0.1, lifeMax: 0.3, angle: -Math.PI / 2, spread: 1.4, gravity: 200 });
      burst(this.x, this.y, 3, {
        color: Theme.groundEdge, kind: 'smoke', speedMin: 12, speedMax: 46,
        lifeMin: 0.3, lifeMax: 0.6, sizeMin: 1, sizeMax: 3, gravity: -12, glow: false,
      });
      impactRing(this.x, this.y - 1, { color: Theme.groundEdge, r0: 3, r1: 18, life: 0.22, width: 1.2, squash: 0.3 });
    }
  }

  // Both guns share one magazine model; only the numbers differ.
  gunCfg(weapon = this.inventory.selectedWeapon()) {
    if (!weapon) return null;
    if (weapon.weapon === 'bow') return BOW;
    if (weapon.weapon === 'shardgun') return SHARDGUN;
    return null;
  }

  updateReload(dt) {
    // Swapping guns hands you a fresh magazine of the right size and drops any
    // reload that was in progress on the other one.
    const w = this.inventory.selectedWeapon();
    const id = w ? w.id : null;
    if (id !== this.lastGunId) {
      this.lastGunId = id;
      const cfg = this.gunCfg(w);
      if (cfg) { this.ammo = cfg.ammo; this.reloadT = 0; }
    }
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.ammo = (this.gunCfg() ?? BOW).ammo;
        Sfx.reload();
      }
    }
  }

  startReload() {
    const cfg = this.gunCfg();
    if (!cfg) return;
    if (this.reloadT > 0 || this.ammo >= cfg.ammo) return;
    this.reloadT = cfg.reload;
    Sfx.reload();
  }

  updatePerks(dt) {
    const inv = this.inventory;
    // aegis shield refills once you have been left alone long enough
    if (this.shieldMax > 0) {
      if (this.shieldRegenT > 0) this.shieldRegenT -= dt;
      else if (this.shield < this.shieldMax) {
        this.shield = clamp(this.shield + PERK.aegisRegenRate * dt, 0, this.shieldMax);
      }
    } else {
      this.shield = 0;
    }
    // wet slime: auto-fire a slowing glob at the nearest enemy
    if (inv.has('wetslime')) {
      this.slimeT -= dt;
      if (this.slimeT <= 0) {
        const target = this.game.nearestEnemy(this.x, this.cy);
        if (target) {
          this.slimeT = PERK.slimeInterval;
          const a = Math.atan2(target.cy - this.cy, target.cx - this.x);
          this.game.projectiles.push(new Projectile({
            x: this.x, y: this.cy - 2,
            vx: Math.cos(a) * PERK.slimeSpeed, vy: Math.sin(a) * PERK.slimeSpeed,
            damage: 0, kind: 'slime', team: 'player', life: 2.5, homing: 3, target, game: this.game,
          }));
          Sfx.slime();
        }
      }
    } else {
      this.slimeT = PERK.slimeInterval;
    }

    // lightning arrow: arc between marked enemies
    if (inv.has('lightningarrow') && this.chainCd <= 0) {
      const marked = this.game.enemies.filter((e) => !e.dead && e.spawnT <= 0 && e.st.mark > 0);
      if (marked.length >= 2) {
        this.chainCd = PERK.chainCooldown;
        marked.sort((a, b) => a.x - b.x);
        for (let i = 0; i < marked.length - 1; i++) {
          this.game.chainLightning(marked[i], marked[i + 1]);
        }
      }
    }
  }

  attack() {
    const weapon = this.inventory.selectedWeapon();
    if (!weapon) {
      this.attackCd = 0.35;
      this.doSwing(SWORD.range * 0.5, this.boosted(PLAYER.punchDamage, 'melee'), 0.9);
      return;
    }
    if (weapon.weapon === 'boomerang') {
      if (this.boomerangOut && !this.boomerangOut.dead) return;   // still in flight
      if (this.throwWind > 0) return;                             // already winding up
      // cock the arm back first; the throw itself fires when the wind-up ends
      this.throwWind = NUKERANG.windUp;
      this.throwAim = this.aim;
      this.attackCd = NUKERANG.windUp + NUKERANG.cooldown;
      this.swing = { t: 0, angle: this.aim, kind: 'wind' };
      Sfx.swing();
      return;
    }
    if (weapon.weapon === 'melee') {
      if (weapon.id === 'twindagger') {
        this.attackCd = TWINDAGGER.cooldown;
        this.daggerAlt = !this.daggerAlt;
        this.doSwing(TWINDAGGER.range, this.boosted(TWINDAGGER.damage, 'melee'), TWINDAGGER.arc,
                     { fiery: true, countHits: true });
      } else {
        this.attackCd = SWORD.cooldown;
        this.doSwing(SWORD.range, this.boosted(SWORD.damage, 'melee'), SWORD.arc);
      }
    } else if (weapon.weapon === 'paper') {
      // paper never fires directly: it opens the fold wheel and waits
      this.game.openFoldWheel();
    } else if (weapon.weapon === 'bow') {
      if (this.reloadT > 0) return;
      if (this.ammo <= 0) { this.startReload(); return; }
      this.attackCd = BOW.cooldown;
      this.ammo--;
      const a = this.aim;
      const mark = this.inventory.has('lightningarrow');
      this.game.projectiles.push(new Projectile({
        x: this.x + Math.cos(a) * 8, y: this.cy + Math.sin(a) * 8,
        vx: Math.cos(a) * BOW.speed, vy: Math.sin(a) * BOW.speed,
        damage: this.boosted(BOW.damage, 'bow'), kind: 'arrow', team: 'player',
        maxDist: BOW.range, life: 3, mark, game: this.game,
      }));
      this.swing = { t: 0, angle: a, kind: 'bow' };
      Sfx.bow();
      Camera.add(1.2);
      burst(this.x + Math.cos(a) * 10, this.cy + Math.sin(a) * 10, 5, {
        color: mark ? Theme.lightning : Theme.steel, speedMin: 20, speedMax: 80,
        lifeMin: 0.1, lifeMax: 0.25, angle: a, spread: 0.5, gravity: 0,
      });
      if (this.ammo <= 0) this.startReload();
    } else if (weapon.weapon === 'shardgun') {
      this.fireShardgun();
    }
  }

  // One shell, five shards in a cone. Each one carries the base damage so the
  // splinters and fragments it turns into can scale off it later.
  fireShardgun() {
    const C = SHARDGUN;
    if (this.reloadT > 0) return;
    if (this.ammo <= 0) { this.startReload(); return; }
    this.attackCd = C.cooldown;
    this.ammo--;
    const a = this.aim;
    const mark = this.inventory.has('lightningarrow');
    const game = this.game;
    const aimAt = () => ({ x: Input.mouse.x, y: Input.mouse.y });
    for (let i = 0; i < C.pellets; i++) {
      const spread = ((i / (C.pellets - 1)) - 0.5) * 2 * C.spread + rand(-0.02, 0.02);
      const ang = a + spread;
      const sp = C.speed * rand(0.92, 1.08);
      game.projectiles.push(new Projectile({
        x: this.x + Math.cos(a) * 9, y: this.cy + Math.sin(a) * 9,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        damage: this.boosted(C.damage, 'shardgun'), baseDamage: this.boosted(C.damage, 'shardgun'),
        kind: 'shard', shardPhase: 'fly',
        team: 'player', life: 6, mark, splinterAim: aimAt, game,
      }));
    }
    this.swing = { t: 0, angle: a, kind: 'bow' };
    Sfx.bow();
    Camera.add(5);
    Camera.punch(1.1);
    this.vx -= Math.cos(a) * 70;              // it kicks
    const mx = this.x + Math.cos(a) * 12, my = this.cy + Math.sin(a) * 12;
    burst(mx, my, 18, {
      color: SHARD_TINT, color2: '#ffffff', kind: 'streak', speedMin: 90, speedMax: 320,
      lifeMin: 0.07, lifeMax: 0.2, angle: a, spread: C.spread * 2.2, gravity: 0, drag: 0.84,
    });
    burst(mx, my, 6, {
      color: '#3a3550', kind: 'smoke', speedMin: 20, speedMax: 70, lifeMin: 0.25, lifeMax: 0.6,
      sizeMin: 1, sizeMax: 3, angle: a, spread: 0.9, gravity: -20, glow: false,
    });
    impactRing(mx, my, { color: SHARD_TINT, r0: 2, r1: 26, life: 0.22, width: 2 });
    if (this.ammo <= 0) this.startReload();
  }

  doSwing(range, damage, arc, opts = {}) {
    const a = this.aim;
    this.swing = { t: 0, angle: a, kind: 'melee', range, arc };
    Sfx.swing();
    // some blades carry the burn themselves and never miss the roll
    const alwaysFiery = !!opts.fiery;
    const fiery = alwaysFiery || this.inventory.has('fireyblade');
    let hits = 0;
    for (const e of this.game.enemies) {
      if (e.dead || e.spawnT > 0 || e.untargetable) continue;
      // measure to the nearest point on the body, not its centre - a boss that
      // is three hundred pixels wide should not be reachable from anywhere
      const nx = clamp(this.x, e.cx - e.w / 2, e.cx + e.w / 2);
      const ny = clamp(this.cy, e.cy - e.h / 2, e.cy + e.h / 2);
      const d = dist(this.x, this.cy, nx, ny);
      if (d > range) continue;
      const ang = Math.atan2(ny - this.cy, nx - this.x);
      if (d > 2 && Math.abs(shortAngle(a, ang)) > arc) continue;
      hits++;
      this.registerHit();
      const burned = fiery && (alwaysFiery || Math.random() < PERK.burnChance);
      e.damage(damage, {
        knockback: 130, fromX: this.x, angle: ang, spread: 0.8,
        color: burned ? Theme.fire : '#ffffff', shake: 3,
      });
      if (burned && !e.dead) {
        e.applyBurn();
        burst(e.cx, e.cy, 10, { color: Theme.fireHot, color2: Theme.fire, speedMin: 20, speedMax: 90, lifeMin: 0.2, lifeMax: 0.6, gravity: -60 });
      }
    }
    if (hits > 0) {
      this.game.hitstop(0.045);
      Camera.add(3);
      if (opts.countHits) this.onDaggerHits(hits);
    }
    return hits;
  }

  // Firey Twin Dagger: fifteen connects and it throws you forward, burning.
  onDaggerHits(n) {
    this.daggerHits = (this.daggerHits ?? 0) + n;
    if (this.daggerHits < TWINDAGGER.dashEvery) return;
    this.daggerHits -= TWINDAGGER.dashEvery;
    const a = this.aim;
    const dir = Math.cos(a) >= 0 ? 1 : -1;
    this.facing = dir;
    this.vx = Math.cos(a) * TWINDAGGER.dashSpeed;
    this.vy = Math.min(this.vy, Math.sin(a) * TWINDAGGER.dashSpeed * 0.45);
    this.dashT = Math.max(this.dashT, TWINDAGGER.dashTime);
    this.invuln = Math.max(this.invuln, TWINDAGGER.dashTime);
    this.emberDash = 0.34;
    Sfx.dash();
    Camera.add(8);
    Camera.punch(1.6);
    this.game.hitstop(0.05);
    screenFlash(0.22, '#ffb060', 0.16);
    impactRing(this.x, this.cy, { color: Theme.fireHot, r0: 3, r1: 54, life: 0.36, width: 3 });
    impactRing(this.x, this.cy, { color: Theme.fire, r0: 2, r1: 86, life: 0.5, width: 2 });
    burst(this.x, this.cy, 30, {
      color: Theme.fireHot, color2: Theme.fire, kind: 'streak', speedMin: 120, speedMax: 380,
      lifeMin: 0.08, lifeMax: 0.26, gravity: 0, angle: a + Math.PI, spread: 0.8, drag: 0.84,
    });
    // and it carves everything it passes through
    for (const e of this.game.enemies) {
      if (e.dead || e.spawnT > 0 || e.untargetable) continue;
      if (dist(this.x, this.cy, e.cx, e.cy) > TWINDAGGER.range + e.radius + 18) continue;
      e.damage(this.boosted(TWINDAGGER.dashDamage, 'melee'), {
        knockback: 90, fromX: this.x, angle: a, spread: 0.9, color: Theme.fire, shake: 2, crit: true,
      });
      if (!e.dead) e.applyBurn();
    }
  }

  drawChain(ctx, chain, colorNear, colorFar, w0, w1) {
    for (let i = 1; i < chain.length; i++) {
      const k = i / (chain.length - 1);
      const a = chain[i - 1], b = chain[i];
      const th = Math.max(1, Math.round(lerp(w0, w1, k)));
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      limb(ctx, a.x, a.y, ang, len, th, k > 0.55 ? colorFar : colorNear);
    }
  }

  draw(ctx) {
    const shadowY = surfaceBelow(this.x, this.y);
    dropShadow(ctx, this.x, shadowY, this.w * 0.62, shadowY - this.y);
    this.drawGrapple(ctx);

    // the dash smear: one continuous tapered ribbon through the path
    if (this.dashPath.length > 1) {
      ribbon(ctx, this.dashPath, Theme.dashGlow, 15 * Theme.dashRibbonWidth, 0.30);
      ribbon(ctx, this.dashPath, Theme.dashCore, 5 * Theme.dashRibbonWidth, 0.42);
    }

    // dash afterimages
    for (const a of this.afterimages) {
      const k = 1 - a.t / 0.28;
      ctx.globalAlpha = k * 0.4 * Theme.trail * Theme.dashGhostAlpha;
      this.drawBody(ctx, a.x, a.y, a.facing, true);
      ctx.globalAlpha = 1;
    }
    // Blink only for damage i-frames. A dash also grants invulnerability, and
    // blinking through it hid the dash pose behind its own afterimages.
    if (this.dashT <= 0 && this.invuln > 0 && !this.dead && Math.floor(this.invuln * 22) % 2 === 0) return;

    // cape hangs behind the body
    this.drawChain(ctx, this.cape, Theme.clothDark, Theme.clothDark, 6, 2);

    ctx.save();
    const sq = this.landSquash;
    const air = this.onGround ? 0 : clamp(this.vy / 620, -1, 1);
    const sx = 1 + sq * 0.30 - Math.abs(air) * 0.10;
    const sy = 1 - sq * 0.26 + Math.abs(air) * 0.14;
    if (Math.abs(sx - 1) > 0.004 || Math.abs(sy - 1) > 0.004) {
      ctx.translate(this.x, this.y);
      ctx.scale(sx, sy);
      ctx.translate(-this.x, -this.y);
    }
    this.drawBody(ctx, this.x, this.y, this.facing, false);
    ctx.restore();

    // scarf streams in front
    this.drawChain(ctx, this.scarf, Theme.playerAccent, Theme.playerAccent, 4, 1);

    // blade ribbon
    if (this.bladeTrail.length > 1) {
      const hot = this.inventory.has('fireyblade');
      ribbon(ctx, this.bladeTrail, hot ? Theme.fire : Theme.steel, 5, 0.55);
      ribbon(ctx, this.bladeTrail, '#ffffff', 2, 0.5);
    }
    this.drawSwingFx(ctx);
    if (this.shield > 0) {
      const k = this.shield / Math.max(1, this.shieldMax);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba('#8fd8ff', 0.25 + 0.3 * k);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(this.x, this.cy, 10, 13, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBody(ctx, px, py, facing, ghost) {
    const t = this.anim;
    const moving = Math.abs(this.vx) > 8 && this.onGround;
    const cyc = t * (moving ? 11 : 2.2);
    const squash = 0;    // handled by the scale transform in draw()
    const bob = this.onGround ? Math.sin(cyc * 2) * (moving ? 1 : 0.5) : 0;
    const x = Math.round(px);
    const y = Math.round(py + bob + squash * 2);
    const f = facing;
    const body = ghost ? Theme.dashGhost : Theme.cloth;
    const bodyDark = ghost ? Theme.dashGhost : Theme.clothDark;
    const skin = ghost ? Theme.dashGhost : Theme.skin;
    const hair = ghost ? Theme.dashGhost : Theme.player;

    const flash = this.hurtFlash > 0 && !ghost;
    const C = (c) => (flash ? '#ffffff' : c);

    // A dash gets its own pose: body pitched into the direction of travel,
    // legs swept back together, head tucked behind the leading shoulder.
    const dashing = this.dashT > 0;
    const swordDash = dashing && this.inventory.selectedWeapon()?.weapon === 'melee';
    if (dashing) {
      ctx.save();
      ctx.translate(x, y - 8);
      ctx.rotate(f * (swordDash ? 0.30 : 0.22));
      ctx.translate(-x, -(y - 8));
    }

    // legs
    if (dashing) {
      // swept back, one slightly trailing the other
      limb(ctx, x - f * 1, y - 8, Math.PI / 2 + f * 0.95, 9, 3, C(bodyDark));
      limb(ctx, x - f * 2, y - 8, Math.PI / 2 + f * 0.62, 8, 3, C(bodyDark));
    } else if (this.slamming) {
      limb(ctx, x - 2, y - 8, Math.PI / 2 + 0.9, 7, 3, C(bodyDark));
      limb(ctx, x + 2, y - 8, Math.PI / 2 - 0.9, 7, 3, C(bodyDark));
    } else if (!this.onGround) {
      const k = clamp(this.vy / 300, -1, 1);
      limb(ctx, x - 2, y - 8, Math.PI / 2 + 0.5 - k * 0.4, 8, 3, C(bodyDark));
      limb(ctx, x + 2, y - 8, Math.PI / 2 - 0.4 + k * 0.5, 8, 3, C(bodyDark));
    } else {
      limb(ctx, x - 1, y - 8, Math.PI / 2 + Math.sin(cyc) * (moving ? 0.8 : 0.1), 8 - squash * 2, 3, C(bodyDark));
      limb(ctx, x + 1, y - 8, Math.PI / 2 - Math.sin(cyc) * (moving ? 0.8 : 0.1), 8 - squash * 2, 3, C(bodyDark));
    }

    // torso
    const lean = dashing ? f * 2.2 : clamp(this.vx / PLAYER.speed, -1, 1) * 1.4;
    pxRect(ctx, x - 4 + lean * 0.5, y - 15 + squash, 8, 8, C(body));
    pxRect(ctx, x - 4 + lean * 0.5, y - 15 + squash, 8, 2, C(ghost ? body : '#5c8ef0'));
    pxRect(ctx, x - 4 + lean * 0.5, y - 15 + squash, 1, 8, C(ghost ? body : '#7fa8ff'));   // rim light
    if (ghost) {
      limb(ctx, x - f * 3, y - 14, (f > 0 ? Math.PI - 0.4 : 0.4) + Math.sin(t * 7) * 0.18 * Theme.wobble, 10, 5, C(bodyDark));
    }

    // head - tucked down and forward through a dash
    const hx = lean + (dashing ? f * 1 : 0);
    const hy = dashing ? 1 : 0;
    pxRect(ctx, x - 3 + hx, y - 22 + squash + hy, 7, 7, C(skin));
    pxRect(ctx, x - 3 + hx, y - 22 + squash + hy, 7, 1, C(ghost ? skin : '#fff0d8'));       // rim light
    pxRect(ctx, x - 4 + hx, y - 23 + squash + hy, 9, 3, C(hair));
    pxRect(ctx, x - 4 + hx + (f > 0 ? 6 : 0), y - 21 + squash + hy, 2, 2, flash ? '#fff' : '#233');
    // collar
    pxRect(ctx, x - 4 + hx, y - 16 + squash + hy, 8, 2, C(ghost ? body : Theme.playerAccent));

    if (!ghost) this.drawWeapon(ctx, x, y + squash, f, dashing, swordDash);
    if (dashing) ctx.restore();
  }

  drawWeapon(ctx, x, y, f, dashing = false, swordDash = false) {
    const w = this.inventory.selectedWeapon();
    const sw = this.swing;
    const shoulderY = y - 13;

    // Sword dash: a committed lunge. Front arm punched straight out with the
    // blade level, back arm thrown behind for counterweight.
    if (swordDash) {
      const a = f > 0 ? -0.06 : Math.PI + 0.06;
      const back = f > 0 ? Math.PI - 0.55 : 0.55;
      limb(ctx, x - f * 2, shoulderY + 1, back, 7, 3, Theme.skin);
      limb(ctx, x, shoulderY, a, 9, 3, Theme.skin);
      const gx = x + Math.cos(a) * 9;
      const gy = shoulderY + Math.sin(a) * 9;
      const fiery = this.inventory.has('fireyblade');
      limb(ctx, gx, gy, a, 3, 4, '#7a4a2a');
      limb(ctx, gx + Math.cos(a) * 3, gy + Math.sin(a) * 3, a, 16, 3, fiery ? Theme.fire : Theme.steel, 1.6);
      const tipX = gx + Math.cos(a) * 19, tipY = gy + Math.sin(a) * 19;
      glowDot(ctx, tipX, tipY, 12, fiery ? Theme.fire : Theme.platformGlow, 0.5);
      // a wedge of speed lines off the blade
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(fiery ? Theme.fire : Theme.steel, 0.5);
      ctx.lineWidth = 1;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(tipX - f * 2, tipY + i * 3);
        ctx.lineTo(tipX - f * (14 + Math.abs(i) * 5), tipY + i * 5);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // Unarmed / bow dash: both arms streamlined back along the body.
    if (dashing) {
      const back = f > 0 ? Math.PI - 0.35 : 0.35;
      limb(ctx, x, shoulderY, back, 8, 3, Theme.skin);
      limb(ctx, x - f * 2, shoulderY + 2, back + f * 0.25, 7, 2, Theme.skin);
      if (w && w.weapon === 'bow') {
        const bx = x + Math.cos(back) * 8, by = shoulderY + Math.sin(back) * 8;
        ctx.save();
        ctx.translate(Math.round(bx), Math.round(by));
        ctx.rotate(back);
        ctx.strokeStyle = '#a86a3a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 7, -1.9, 1.9);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    if (w && w.weapon === 'boomerang') {
      // while it is in the air the hand is empty
      if (this.boomerangOut && !this.boomerangOut.dead) {
        const back = f > 0 ? Math.PI - 0.5 : 0.5;
        limb(ctx, x, shoulderY, back, 7, 3, Theme.skin);
        return;
      }
      // wind-up drags the arm back past the shoulder, the release snaps it
      // through the aim, and a catch reaches out and recoils.
      const wind = this.throwWind > 0 ? clamp(this.throwWind / NUKERANG.windUp, 0, 1) : 0;
      const throwing = sw && sw.kind === 'throw' ? clamp(1 - sw.t / 0.22, 0, 1) : 0;
      const catching = this.catchT > 0 ? clamp(this.catchT / NUKERANG.catchTime, 0, 1) : 0;
      let a;
      let reach = 8;
      if (wind > 0) {
        a = this.throwAim + f * (2.1 * wind);          // hauled back behind the head
        reach = 7 - wind * 2;
      } else if (throwing > 0) {
        a = sw.angle - f * (0.9 * throwing);           // snapping through the release
        reach = 9 + throwing * 4;
      } else if (catching > 0) {
        a = this.aim;
        reach = 8 + catching * 5;                      // arm still extended from the grab
      } else {
        a = this.aim * 0.3 + (f > 0 ? -0.3 : Math.PI + 0.3);
      }
      limb(ctx, x, shoulderY, a, reach, 3, Theme.skin);
      const gx = x + Math.cos(a) * reach, gy = shoulderY + Math.sin(a) * reach;
      // it spools up while winding, and is still spinning down after a catch
      const spin = wind > 0 ? this.anim * (6 + 40 * (1 - wind))
        : catching > 0 ? this.anim * (6 + 34 * catching)
        : a + Math.PI * 0.5;
      glowDot(ctx, gx, gy, 7 + wind * 6 + catching * 5, Theme.fire, 0.28 + wind * 0.3 + catching * 0.3);
      ctx.save();
      ctx.translate(Math.round(gx), Math.round(gy));
      ctx.rotate(spin);
      drawBoomerang(ctx, 7, 3, Theme.steel, Theme.steelDark, Theme.fire);
      ctx.restore();
      if (wind > 0) {
        // charge motes sucked into the blade
        if (Math.random() < 0.6) {
          const ang = rand(0, TAU);
          spawnParticle({
            x: gx + Math.cos(ang) * 14, y: gy + Math.sin(ang) * 14,
            vx: -Math.cos(ang) * 70, vy: -Math.sin(ang) * 70, life: 0.2,
            size: 1, color: Theme.fire, gravity: 0, kind: 'shrink',
          });
        }
      }
      return;
    }
    if (!w) {
      const p = sw && sw.kind === 'melee' ? clamp(sw.t / SWORD.swingTime, 0, 1) : 0;
      const a = sw ? sw.angle - 0.9 + p * 1.8 : this.aim * 0.3;
      limb(ctx, x, shoulderY, a, 7, 3, Theme.skin);
      return;
    }
    if (w.weapon === 'paper') {
      // a sheet held ready, creasing between the fingers
      const a = this.aim;
      const th = sw && sw.kind === 'throw' ? clamp(1 - sw.t / 0.22, 0, 1) : 0;
      const reach = 7 + th * 4;
      const hx = x + Math.cos(a) * reach, hy = shoulderY + Math.sin(a) * reach;
      limb(ctx, x, shoulderY, a, reach, 3, Theme.skin);
      ctx.save();
      ctx.translate(Math.round(hx), Math.round(hy));
      ctx.rotate(a + Math.sin(this.anim * 3) * 0.12 - th * 0.6);
      pxRect(ctx, -1, -4, 6, 8, '#efeade');
      pxRect(ctx, -1, -4, 6, 1, '#ffffff');
      pxRect(ctx, 2, -4, 1, 8, '#c9c2b2');
      if (th > 0) glowDot(ctx, 4, 0, 10 * th, '#ffffff', 0.4 * th);
      ctx.restore();
      return;
    }

    if (w.id === 'twindagger') {
      // two short blades, both alight, alternating on the swing
      const a = this.aim;
      const p0 = sw && sw.kind === 'melee' ? clamp(sw.t / TWINDAGGER.cooldown, 0, 1) : 1;
      const swingA = a + (1 - p0) * (this.daggerAlt ? 1 : -1) * 0.9;
      for (const [ang, len, lead] of [[swingA, 10, true], [a - (swingA - a) * 0.6, 8, false]]) {
        const gx = x + Math.cos(ang) * 6, gy = shoulderY + Math.sin(ang) * 6;
        limb(ctx, x, shoulderY, ang, 6, 3, Theme.skin);
        limb(ctx, gx, gy, ang, 3, 3, '#7a4a2a');
        limb(ctx, gx + Math.cos(ang) * 3, gy + Math.sin(ang) * 3, ang, len, 2, Theme.steel, 1.4);
        const tx = gx + Math.cos(ang) * (3 + len), ty = gy + Math.sin(ang) * (3 + len);
        glowDot(ctx, tx, ty, lead ? 11 : 8, Theme.fire, 0.5);
        glowDot(ctx, tx, ty, 4, Theme.fireHot, 0.7);
        if (Math.random() < 0.4) {
          spawnParticle({
            x: tx, y: ty, vx: rand(-16, 16), vy: rand(-40, -8), life: rand(0.15, 0.45),
            size: 1, color: Math.random() < 0.5 ? Theme.fireHot : Theme.fire,
            gravity: -60, drag: 0.94, kind: 'shrink',
          });
        }
      }
      return;
    }

    if (w.weapon === 'shardgun') {
      const a = this.aim;
      const kick = sw && sw.kind === 'bow' ? clamp(1 - sw.t / 0.22, 0, 1) : 0;
      const reach = 9 - kick * 4;
      const hx = x + Math.cos(a) * reach;
      const hy = shoulderY + Math.sin(a) * reach;
      limb(ctx, x, shoulderY, a, reach, 3, Theme.skin);
      limb(ctx, x - f * 2, shoulderY + 2, a + (f > 0 ? 0.5 : -0.5), 6, 3, Theme.skin);
      ctx.save();
      ctx.translate(Math.round(hx), Math.round(hy));
      ctx.rotate(a + kick * (f > 0 ? -0.28 : 0.28));
      pxRect(ctx, -5, -3, 12, 5, Theme.steelDark);
      pxRect(ctx, -5, -3, 11, 1, Theme.steel);
      pxRect(ctx, 6, -2, 4, 3, Theme.steel);
      pxRect(ctx, -6, 1, 4, 4, '#7a4a2a');
      if (this.reloadT > 0) {
        // the breech hangs open while it reloads
        pxRect(ctx, 0, -6, 5, 3, Theme.steelDark);
      } else if (this.ammo > 0) {
        pxRect(ctx, 2, -2, 3, 3, SHARD_TINT);
      }
      if (kick > 0) {
        glowDot(ctx, 11, 0, 10 + kick * 12, SHARD_TINT, 0.35 + kick * 0.45);
        pxRect(ctx, 9, -1, 4 + kick * 6, 2, '#ffffff');
      }
      ctx.restore();
      return;
    }

    if (w.weapon === 'bow') {
      const a = this.aim;
      const recoil = sw && sw.kind === 'bow' ? clamp(1 - sw.t / 0.18, 0, 1) : 0;
      const hx = x + Math.cos(a) * (8 - recoil * 3);
      const hy = shoulderY + Math.sin(a) * (8 - recoil * 3);
      limb(ctx, x, shoulderY, a, 8 - recoil * 3, 3, Theme.skin);
      ctx.save();
      ctx.translate(Math.round(hx), Math.round(hy));
      ctx.rotate(a);
      // bow limbs
      ctx.strokeStyle = '#a86a3a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 7, -1.9, 1.9);
      ctx.stroke();
      ctx.strokeStyle = Theme.steel;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const pull = 3 - recoil * 3;
      ctx.moveTo(Math.cos(-1.9) * 7, Math.sin(-1.9) * 7);
      ctx.lineTo(-pull, 0);
      ctx.lineTo(Math.cos(1.9) * 7, Math.sin(1.9) * 7);
      ctx.stroke();
      ctx.restore();
      // back arm pulling the string
      limb(ctx, x, shoulderY, a + Math.PI * 0.75, 5, 2, Theme.skin);
      return;
    }
    // sword
    let a;
    if (sw && sw.kind === 'melee') {
      const p = clamp(sw.t / SWORD.swingTime, 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      a = sw.angle - sw.arc * 0.95 + e * sw.arc * 1.9;
    } else {
      a = this.aim * 0.25 + (f > 0 ? -0.5 : Math.PI + 0.5);
    }
    limb(ctx, x, shoulderY, a, 7, 3, Theme.skin);
    const hx = x + Math.cos(a) * 7;
    const hy = shoulderY + Math.sin(a) * 7;
    const fiery = this.inventory.has('fireyblade');
    limb(ctx, hx, hy, a, 3, 4, '#7a4a2a');
    limb(ctx, hx + Math.cos(a) * 3, hy + Math.sin(a) * 3, a, 14, 3, fiery ? Theme.fire : Theme.steel, 1.6);
    if (fiery) {
      const tipX = hx + Math.cos(a) * 15, tipY = hy + Math.sin(a) * 15;
      glowDot(ctx, tipX, tipY, 10, Theme.fire, 0.45);
      if (Math.random() < 0.5) {
        spawnParticle({
          x: tipX + rand(-3, 3), y: tipY + rand(-3, 3), vx: rand(-14, 14), vy: rand(-40, -12),
          life: rand(0.2, 0.45), size: 1, color: Theme.fireHot, color2: Theme.fire, gravity: -30, kind: 'shrink',
        });
      }
    }
  }

  drawSwingFx(ctx) {
    const sw = this.swing;
    if (!sw || sw.kind !== 'melee') return;
    const p = clamp(sw.t / (SWORD.swingTime * 1.4), 0, 1);
    if (p >= 1) return;
    const e = 1 - Math.pow(1 - p, 3);
    const a0 = sw.angle - sw.arc * 0.95;
    const a1 = a0 + e * sw.arc * 1.9;
    const r = sw.range;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(this.inventory.has('fireyblade') ? Theme.fire : Theme.steel, (1 - p) * 0.75);
    ctx.lineWidth = 3 * (1 - p) + 1;
    ctx.beginPath();
    ctx.arc(this.x, this.cy, r * 0.85, a1 - 0.55, a1);
    ctx.stroke();
    ctx.strokeStyle = rgba('#ffffff', (1 - p) * 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.x, this.cy, r * 0.85, a1 - 0.3, a1);
    ctx.stroke();
    ctx.restore();
  }
}
