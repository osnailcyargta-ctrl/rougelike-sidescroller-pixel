// Player, enemies and projectiles: physics, combat, status effects, drawing.
import {
  clamp, lerp, rand, randInt, choice, dist, distToSegment, shortAngle, sign, rgba, TAU,
} from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, floatText, spawnParticle, limb, pxRect, glowDot, boltPath, strokeBolt } from './gfx.js';
import { Sfx } from './audio.js';
import {
  VIEW_W, VIEW_H, GRAVITY, GROUND_Y, PLATFORMS, PLAYER, SWORD, BOW, ENEMY_TYPES, PERK,
  ROOM_SCALING,
} from './config.js';
import { ITEMS, Inventory } from './items.js';

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

export const ENEMY_TINT = {
  get grunt() { return Theme.enemyGrunt; },
  get brute() { return Theme.enemyBrute; },
  get stinger() { return Theme.enemyStinger; },
  get lurker() { return '#ff7a3c'; },
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
    // Regular enemies get tougher every room.
    const room = Math.max(1, game?.roomIndex ?? 1);
    this.hpScale = 1 + ROOM_SCALING.hpPerRoom * (room - 1);
    this.dmgScale = 1 + ROOM_SCALING.damagePerRoom * (room - 1);
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
  }

  get cx() { return this.x; }
  get cy() { return this.y - this.h / 2; }
  get radius() { return Math.max(this.w, this.h) / 2; }

  // Subclasses (boss parts) override this to share one HP pool.
  applyRawDamage(amount) {
    this.hp -= amount;
    if (this.hp <= 0) this.kill();
  }

  damage(amount, opts = {}) {
    if (this.dead) return;
    this.hurtFlash = 0.16;
    const crit = !!opts.crit;
    floatText(this.cx + rand(-3, 3), this.cy - 8, Math.round(amount), opts.color ?? (crit ? Theme.uiAccent : '#ffffff'), { crit });
    burst(this.cx, this.cy, crit ? 12 : 7, {
      color: opts.color ?? Theme.blood, color2: '#ffffff',
      speedMin: 30, speedMax: 150, lifeMin: 0.2, lifeMax: 0.45, sizeMax: 2,
      angle: opts.angle, spread: opts.spread ?? Math.PI,
    });
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
    const c = ENEMY_TINT[this.type] ?? Theme.enemyGrunt;
    burst(this.cx, this.cy, 26, {
      color: c, color2: '#ffffff', speedMin: 40, speedMax: 210,
      lifeMin: 0.3, lifeMax: 0.8, sizeMax: 3, gravity: 300,
    });
    burst(this.cx, this.cy, 10, { color: '#ffffff', speedMin: 10, speedMax: 60, lifeMin: 0.2, lifeMax: 0.5, kind: 'shrink', sizeMax: 4, gravity: 0 });
    this.game.onEnemyKilled(this);
  }

  applyBurn() {
    if (this.st.burn <= 0) this.st.burnTick = 0;
    this.st.burn = PERK.burnDuration;   // refresh, never stacks
  }

  applyMark() { this.st.mark = PERK.markDuration; }

  applyElectrified() {
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
    if (this.spawnT > 0) {
      this.spawnT -= dt;
      return;
    }
    this.updateStatus(dt);
    if (this.dead) return;

    const p = this.game.player;
    const slow = this.st.slowFactor;
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
      const k = 1 - this.spawnT / 0.45;
      const c = ENEMY_TINT[this.type] ?? Theme.enemyGrunt;
      glowDot(ctx, this.x, this.y - this.h / 2, 24 * (1 - k) + 6, c, 0.8);
      ctx.globalAlpha = k;
      pxRect(ctx, this.x - this.w / 2, this.y - this.h * k, this.w, this.h * k, rgba(c, 0.7));
      ctx.globalAlpha = 1;
      return;
    }
    ctx.save();
    if (this.hurtFlash > 0) ctx.globalAlpha = 1;
    const flash = this.hurtFlash > 0;
    if (this.type === 'grunt') this.drawGrunt(ctx, t, flash);
    else if (this.type === 'brute') this.drawBrute(ctx, t, flash);
    else if (this.type === 'lurker') this.drawLurker(ctx, t, flash);
    else if (this.type === 'spitter') this.drawSpitter(ctx, t, flash);
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
    }, o);
    this.angle = Math.atan2(this.vy, this.vx);
  }

  update(dt) {
    this.t += dt;
    if (this.t >= this.life) { this.dead = true; return; }
    if (this.homing && this.target && !this.target.dead) {
      const a = Math.atan2(this.target.cy - this.y, this.target.cx - this.x);
      const cur = Math.atan2(this.vy, this.vx);
      const na = cur + shortAngle(cur, a) * clamp(this.homing * dt, 0, 1);
      const sp = Math.hypot(this.vx, this.vy);
      this.vx = Math.cos(na) * sp;
      this.vy = Math.sin(na) * sp;
    }
    this.vy += this.gravity * dt;
    const dx = this.vx * dt, dy = this.vy * dt;
    this.x += dx; this.y += dy;
    this.traveled += Math.hypot(dx, dy);
    this.angle = Math.atan2(this.vy, this.vx);
    if (this.traveled >= this.maxDist) { this.expire(); return; }
    if (this.x < -8 || this.x > VIEW_W + 8 || this.y < -20 || this.y > GROUND_Y + 4) {
      this.expire();
      return;
    }
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
    } else if (this.team === 'enemy') {
      glowDot(ctx, this.x, this.y, 9, Theme.enemyStinger, 0.4);
      ctx.translate(Math.round(this.x), Math.round(this.y));
      ctx.rotate(this.angle);
      pxRect(ctx, -4, -1, 8, 2, Theme.enemyStinger);
      pxRect(ctx, 2, -2, 3, 4, '#ffffff');
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
    this.slimeT = PERK.slimeInterval;
    this.chainCd = 0;
    this.shield = 0;
    this.shieldMax = 0;
    this.shieldRegenT = 0;
    this.hitStreak = 0;
    this.afterimages = [];
    this.aim = 0;
    this.controls = true;
    this.landSquash = 0;
    this.hurtFlash = 0;
    this.inventory = new Inventory();
    this.inventory.add(classId === 'melee' ? 'sword' : 'bow', 1);
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
    const newMax = this.baseMaxHp + stacks * PERK.lifeCrystalHp;
    if (newMax !== this.maxHp) {
      const diff = newMax - this.maxHp;
      this.maxHp = newMax;
      this.hp = clamp(this.hp + Math.max(0, diff), 1, this.maxHp);
    }
    this.hp = Math.min(this.hp, this.maxHp);
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
    this.landSquash = Math.max(0, this.landSquash - dt * 4);
    this.chainCd = Math.max(0, this.chainCd - dt);
    if (this.swing) {
      this.swing.t += dt;
      if (this.swing.t > SWORD.swingTime * 1.6) this.swing = null;
    }
    for (let i = this.afterimages.length - 1; i >= 0; i--) {
      this.afterimages[i].t += dt;
      if (this.afterimages[i].t > 0.28) this.afterimages.splice(i, 1);
    }
    if (this.dead) {
      this.vy += GRAVITY * dt;
      this.vx *= 0.9;
      moveAndCollide(this, dt);
      return;
    }

    this.recomputeStats();
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
      if (c.keys.has('a')) move -= 1;
      if (c.keys.has('d')) move += 1;
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      if (Math.random() < dt * 90) {
        this.afterimages.push({ x: this.x, y: this.y, facing: this.facing, t: 0 });
      }
      spawnParticle({
        x: this.x + rand(-4, 4), y: this.y - rand(0, this.h), vx: rand(-20, 20), vy: rand(-20, 20),
        life: rand(0.15, 0.35), size: 1, color: Theme.platformGlow, gravity: 0, kind: 'shrink',
      });
      if (this.dashT <= 0) this.vx *= 0.4;
    } else {
      const accel = this.onGround ? PLAYER.accel : PLAYER.airAccel;
      if (move !== 0) {
        this.vx += move * accel * dt;
        this.vx = clamp(this.vx, -PLAYER.speed, PLAYER.speed);
      } else if (this.onGround) {
        this.vx = Math.abs(this.vx) < PLAYER.friction * dt ? 0 : this.vx - sign(this.vx) * PLAYER.friction * dt;
      } else {
        this.vx *= Math.pow(0.6, dt * 4);
      }
    }

    // --- dash. Fires only on the frame a genuine second tap lands. No
    // buffering, no alternate key, nothing that can go off later: if the tap
    // arrives while the dash is on cooldown it is simply dropped.
    if (c && this.dashCd <= 0 && this.dashT <= 0) {
      if (c.doubleTap.has('a')) this.startDash(-1);
      else if (c.doubleTap.has('d')) this.startDash(1);
    }

    // --- jump
    if (c && c.pressed.has('w') && this.onGround && !this.slamming) {
      this.vy = -PLAYER.jumpVel;
      this.onGround = false;
      Sfx.jump();
      burst(this.x, this.y, 7, { color: Theme.platformGlow, speedMin: 20, speedMax: 70, lifeMin: 0.15, lifeMax: 0.35, gravity: 120, angle: -Math.PI / 2, spread: 1.1 });
    }

    // --- drop through / ground slam
    if (c && c.doubleTap.has('s') && !this.onGround && !this.slamming) {
      this.slamming = true;
      this.vy = PLAYER.slamVel;
      this.vx *= 0.3;
      Sfx.dash();
      burst(this.x, this.cy, 10, { color: Theme.uiAccent, speedMin: 20, speedMax: 90, lifeMin: 0.15, lifeMax: 0.4, gravity: -60, angle: -Math.PI / 2, spread: 1.4 });
    } else if (c && c.pressed.has('s') && this.onGround && this.platform) {
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

    // --- attacks
    if (c && input.mouse.left && this.attackCd <= 0) this.attack();
    if (c && c.pressed.has('r')) this.startReload();

    // --- gravity + collide
    if (this.dashT <= 0) this.vy += GRAVITY * dt;
    else this.vy = lerp(this.vy, 0, 1 - Math.pow(0.0001, dt));
    this.vy = Math.min(this.vy, 900);
    const before = this.onGround;
    moveAndCollide(this, dt, { ignorePlatforms: this.dropT > 0 });
    if (!before && this.onGround) this.onLand();
  }

  startDash(dir) {
    this.dashT = PLAYER.dashTime;
    this.dashCd = PLAYER.dashCooldown;
    this.facing = dir;
    this.vx = dir * PLAYER.dashSpeed;
    this.vy = Math.min(this.vy, 0) * 0.2;
    this.invuln = Math.max(this.invuln, PLAYER.dashTime + 0.05);
    Sfx.dash();
    Camera.add(2);
    burst(this.x, this.cy, 12, {
      color: Theme.platformGlow, color2: '#ffffff', speedMin: 40, speedMax: 150,
      lifeMin: 0.15, lifeMax: 0.4, angle: dir > 0 ? Math.PI : 0, spread: 0.7, gravity: 0,
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
      burst(this.x, this.y, 32, {
        color: Theme.uiAccent, color2: Theme.fire, speedMin: 60, speedMax: 240,
        lifeMin: 0.2, lifeMax: 0.6, sizeMax: 3, gravity: 420, angle: -Math.PI / 2, spread: 1.5,
      });
      for (const e of this.game.enemies) {
        if (e.dead || e.spawnT > 0) continue;
        if (dist(e.cx, e.cy, this.x, this.y) < PLAYER.slamRadius + e.radius) {
          e.damage(PLAYER.slamDamage, {
            knockback: 170, fromX: this.x, color: Theme.uiAccent, shake: 0, crit: true,
          });
        }
      }
    } else if (Math.abs(this.vy) > 10 || true) {
      burst(this.x, this.y, 5, { color: Theme.groundEdge, speedMin: 10, speedMax: 50, lifeMin: 0.1, lifeMax: 0.3, angle: -Math.PI / 2, spread: 1.4, gravity: 200 });
    }
  }

  updateReload(dt) {
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.ammo = BOW.ammo;
        Sfx.reload();
      }
    }
  }

  startReload() {
    const w = this.inventory.selectedWeapon();
    if (!w || w.weapon !== 'bow') return;
    if (this.reloadT > 0 || this.ammo >= BOW.ammo) return;
    this.reloadT = BOW.reload;
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
      this.doSwing(SWORD.range * 0.5, PLAYER.punchDamage, 0.9);
      return;
    }
    if (weapon.weapon === 'melee') {
      this.attackCd = SWORD.cooldown;
      this.doSwing(SWORD.range, SWORD.damage, SWORD.arc);
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
        damage: BOW.damage, kind: 'arrow', team: 'player',
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
    }
  }

  doSwing(range, damage, arc) {
    const a = this.aim;
    this.swing = { t: 0, angle: a, kind: 'melee', range, arc };
    Sfx.swing();
    const fiery = this.inventory.has('fireyblade');
    let hits = 0;
    for (const e of this.game.enemies) {
      if (e.dead || e.spawnT > 0) continue;
      const d = dist(this.x, this.cy, e.cx, e.cy);
      if (d > range + e.radius) continue;
      const ang = Math.atan2(e.cy - this.cy, e.cx - this.x);
      if (Math.abs(shortAngle(a, ang)) > arc) continue;
      hits++;
      this.registerHit();
      const burned = fiery && Math.random() < PERK.burnChance;
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
    }
  }

  draw(ctx) {
    // dash afterimages
    for (const a of this.afterimages) {
      const k = 1 - a.t / 0.28;
      ctx.globalAlpha = k * 0.4 * Theme.trail;
      this.drawBody(ctx, a.x, a.y, a.facing, true);
      ctx.globalAlpha = 1;
    }
    if (this.invuln > 0 && !this.dead && Math.floor(this.invuln * 22) % 2 === 0) return;
    this.drawBody(ctx, this.x, this.y, this.facing, false);
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
    const squash = this.landSquash;
    const bob = this.onGround ? Math.sin(cyc * 2) * (moving ? 1 : 0.5) : 0;
    const x = Math.round(px);
    const y = Math.round(py + bob + squash * 2);
    const f = facing;
    const body = ghost ? Theme.platformGlow : Theme.cloth;
    const bodyDark = ghost ? Theme.platformGlow : Theme.clothDark;
    const skin = ghost ? Theme.platformGlow : Theme.skin;
    const hair = ghost ? Theme.platformGlow : Theme.player;

    const flash = this.hurtFlash > 0 && !ghost;
    const C = (c) => (flash ? '#ffffff' : c);

    // legs
    if (this.slamming) {
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

    // torso + cape
    const lean = clamp(this.vx / PLAYER.speed, -1, 1) * 1.4;
    pxRect(ctx, x - 4 + lean * 0.5, y - 15 + squash, 8, 8, C(body));
    pxRect(ctx, x - 4 + lean * 0.5, y - 15 + squash, 8, 2, C(ghost ? body : '#5c8ef0'));
    // cape flutter
    ctx.globalAlpha *= 0.9;
    limb(ctx, x - f * 3, y - 14, (f > 0 ? Math.PI - 0.4 : 0.4) + Math.sin(t * 7) * 0.18 * Theme.wobble, 10, 5, C(bodyDark));
    ctx.globalAlpha /= 0.9;

    // head
    pxRect(ctx, x - 3 + lean, y - 22 + squash, 7, 7, C(skin));
    pxRect(ctx, x - 4 + lean, y - 23 + squash, 9, 3, C(hair));
    pxRect(ctx, x - 4 + lean + (f > 0 ? 6 : 0), y - 21 + squash, 2, 2, flash ? '#fff' : '#233');
    // scarf
    pxRect(ctx, x - 4 + lean, y - 16 + squash, 8, 2, C(ghost ? body : Theme.playerAccent));

    if (!ghost) this.drawWeapon(ctx, x, y + squash, f);
  }

  drawWeapon(ctx, x, y, f) {
    const w = this.inventory.selectedWeapon();
    const sw = this.swing;
    const shoulderY = y - 13;
    if (!w) {
      const p = sw && sw.kind === 'melee' ? clamp(sw.t / SWORD.swingTime, 0, 1) : 0;
      const a = sw ? sw.angle - 0.9 + p * 1.8 : this.aim * 0.3;
      limb(ctx, x, shoulderY, a, 7, 3, Theme.skin);
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
