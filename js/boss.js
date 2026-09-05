// The Aether Golem: a two-phase boss that owns a shared HP pool and drives
// one or two body parts. The parts live in game.enemies so every existing hit
// test, status effect and perk works on them unchanged.
import { clamp, lerp, rand, randInt, choice, dist, distToSegment, sign, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, floatText, spawnParticle, impactRing, limb, limbInk, pxRect, pxSolid, glowDot, glowEye, boltPath, strokeBolt, screenFlash } from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GRAVITY, GROUND_Y, BOSS_TYPES, ROOM_SCALING, BOSS_ROOM_INTERVAL, FINAL_ROOM, CEILING_ROOM } from './config.js';
import { Enemy, Projectile } from './entities.js';
import { WormBoss } from './worm.js';
import { AlphadsBoss } from './alphads.js';
import { CeilingBoss } from './ceiling.js';
import { PoitnusBoss } from './poitnus.js';

// How far a ray from (ox, oy) travels before it leaves the arena.
function rayLength(ox, oy, dx, dy) {
  let t = 900;
  if (dx > 1e-6) t = Math.min(t, (VIEW_W - ox) / dx);
  else if (dx < -1e-6) t = Math.min(t, -ox / dx);
  if (dy > 1e-6) t = Math.min(t, (VIEW_H - oy) / dy);
  else if (dy < -1e-6) t = Math.min(t, -oy / dy);
  return Math.max(8, t);
}

// A part of the boss. Damage, burn ticks and death all forward to the owner.
class BossPart extends Enemy {
  constructor(type, x, y, game, boss) {
    super(type, x, y, game);
    this.boss = boss;
    this.spawnT = 0;
    this.isBoss = true;
    this.dmg = Math.round(this.def.damage * boss.dmgScale);
    this.maxHp = boss.maxHp;
    this.hp = boss.hp;
  }

  applyRawDamage(amount) { this.boss.applyRawDamage(amount); }

  damage(amount, opts = {}) {
    super.damage(amount, { ...opts, knockback: 0, shake: opts.shake ?? 1 });
  }

  kill() { this.boss.die(); }

  drawHpBar() { /* the boss has its own bar in the HUD */ }

  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.maxHp;
    this.updateStatus(dt);      // burn / slow / mark / electrified still apply
  }

  draw(ctx) {
    if (this.type === 'golemHead') this.boss.drawHead(ctx, this);
    else this.boss.drawBody(ctx, this);
    this.drawStatusFx(ctx, this.anim);
  }
}

export class GolemBoss {
  constructor(game, roomIndex) {
    const def = BOSS_TYPES.golem;
    this.game = game;
    this.def = def;
    this.name = def.name;
    this.roomIndex = roomIndex;

    // Bosses alternate, so scale by how many times THIS boss has shown up -
    // a debut boss always fights at its listed stats.
    const tier = Math.max(1, Math.round(roomIndex / BOSS_ROOM_INTERVAL));
    const ownTier = Math.ceil(tier / 2);
    this.hpScale = 1 + ROOM_SCALING.bossHpPerTier * (ownTier - 1);
    this.dmgScale = 1 + ROOM_SCALING.bossDamagePerTier * (ownTier - 1);
    this.maxHp = Math.round(def.hp * this.hpScale);
    this.hp = this.maxHp;
    this.phase2At = Math.round(def.phase2Hp * this.hpScale);

    this.phase = 1;
    this.dead = false;
    this.intro = 1.6;
    this.beams = [];
    this.history = [];       // player position trail, for the lagged big laser
    this.step = 0;
    this.stateT = 0;
    this.state = 'wait';
    this.shots = 0;
    this.shotT = 0;
    this.bodyState = 'idle';
    this.bodyT = 0;
    this.dashT = 0;
    this.slamming = false;
    this.headTargetX = VIEW_W / 2;
    this.headAnchorX = VIEW_W / 2;
    this.headDrift = rand(0, TAU);
    this.detach = null;
    this.syncDash = false;

    this.body = new BossPart('golemBody', VIEW_W / 2, GROUND_Y, game, this);
    this.body.facing = -1;
    this.head = null;
    game.enemies.push(this.body);
  }

  get damage() { return this; }

  get parts() { return [this.body, this.head].filter(Boolean); }

  headOrigin() {
    if (this.phase === 2 && this.head) return { x: this.head.x, y: this.head.y - this.head.h / 2 };
    return { x: this.body.x, y: this.body.y - this.body.h - 6 };
  }

  applyRawDamage(amount) {
    if (this.dead) return;
    this.hp -= amount;
    if (this.hp <= this.phase2At && this.phase === 1) this.enterPhase2();
    if (this.hp <= 0) this.die();
  }

  // Making the head is separate from tearing it off: the codex wants the
  // shape without the earthquake that normally comes with it.
  spawnHead(o) {
    this.head = new BossPart('golemHead', o.x, o.y + this.def.headH / 2, this.game, this);
    this.head.tilt = 0;
    return this.head;
  }

  enterPhase2() {
    this.phase = 2;
    this.hp = Math.max(1, this.hp);
    this.beams.length = 0;
    this.state = 'split';
    this.stateT = 0;
    Camera.add(14);
    this.game.hitstop(0.16);
    Sfx.slam();
    const o = this.headOrigin();
    burst(o.x, o.y, 50, {
      color: Theme.lightning, color2: '#ffffff', speedMin: 40, speedMax: 260,
      lifeMin: 0.3, lifeMax: 1.0, sizeMax: 3, gravity: 160,
    });
    this.game.enemies.push(this.spawnHead(o));
    // the head does not teleport to its perch: it wrenches loose, sags, then
    // climbs while the socket sprays arcs behind it
    this.detach = {
      t: 0,
      dur: 1.5,
      fromX: o.x,
      fromY: o.y + this.def.headH / 2,
      toX: clamp(o.x + rand(-50, 50), 40, VIEW_W - 40),
      toY: this.def.headHover,
    };
    this.headAnchorX = this.detach.toX;
    this.step = 0;
    this.bodyState = 'idle';
    this.bodyT = this.def.attackDelay;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.beams.length = 0;
    this.body.dead = true;

    // If it never reached phase 2 the head is still fused on, so tear one free
    // now: the death always ends with a head on the floor.
    if (!this.head) {
      const o = this.headOrigin();
      this.head = new BossPart('golemHead', o.x, o.y + this.def.headH / 2, this.game, this);
      this.head.tilt = 0;
      this.game.enemies.push(this.head);
    }
    this.head.dead = true;

    // the head drops, tumbles, lands, then rots away like a spent arrow
    this.headFall = {
      x: this.head.x,
      y: this.head.y,
      vx: rand(-70, 70),
      vy: -120,
      rot: this.head.tilt ?? 0,
      rotVel: rand(-4.5, 4.5),
      landed: false,
      restT: 0,
      bounces: 0,
    };
    this.headAlpha = 1;

    Camera.add(16);
    this.game.hitstop(0.22);
    Sfx.die();
    for (const part of [this.body, this.head]) {
      if (!part) continue;
      burst(part.cx, part.cy, 46, {
        color: Theme.enemyBrute, color2: '#ffffff', speedMin: 40, speedMax: 260,
        lifeMin: 0.4, lifeMax: 1.2, sizeMax: 4, gravity: 320,
      });
    }
    this.game.onBossDefeated(this);
    this.game.onEnemyKilled(this.body);
  }

  // Runs while a cutscene holds the world still. On the death cutscene this is
  // what actually drops the head and decays it.
  cinematicUpdate(dt) {
    for (const p of this.parts) p.anim += dt;
    if (!this.headFall || !this.head) return;
    const f = this.headFall;

    if (!f.landed) {
      f.vy += 780 * dt;
      f.x = clamp(f.x + f.vx * dt, 16, VIEW_W - 16);
      f.y += f.vy * dt;
      f.rot += f.rotVel * dt;
      const floor = GROUND_Y;
      if (f.y >= floor) {
        f.y = floor;
        f.bounces++;
        if (f.bounces >= 2 || Math.abs(f.vy) < 130) {
          f.landed = true;
          // settle onto its side
          f.restRot = f.rot > 0 ? 1.35 : -1.35;
          f.vx = 0;
        } else {
          f.vy = -Math.abs(f.vy) * 0.42;
          f.vx *= 0.55;
          f.rotVel *= 0.6;
        }
        Sfx.slam();
        Camera.add(f.bounces === 1 ? 7 : 3);
        impactRing(f.x, floor, {
          color: Theme.lightning, r0: 4, r1: f.bounces === 1 ? 44 : 24,
          life: 0.3, width: 2, squash: 0.3,
        });
        burst(f.x, floor, f.bounces === 1 ? 20 : 10, {
          color: '#4a3f78', color2: Theme.lightning, speedMin: 40, speedMax: 190,
          lifeMin: 0.25, lifeMax: 0.6, gravity: 420, angle: -Math.PI / 2, spread: 1.3,
        });
        burst(f.x, floor, 8, {
          color: '#2a2444', kind: 'smoke', speedMin: 15, speedMax: 70,
          lifeMin: 0.4, lifeMax: 0.9, sizeMin: 2, sizeMax: 4, gravity: -25, glow: false,
        });
      }
    } else {
      f.restT += dt;
      f.rot += (f.restRot - f.rot) * (1 - Math.pow(0.02, dt));
      // it holds for a beat, then crumbles: the light in it goes out first
      const decay = clamp((f.restT - 0.75) / 1.1, 0, 1);
      this.headAlpha = 1 - decay;
      if (decay > 0 && Math.random() < dt * 55) {
        spawnParticle({
          x: f.x + rand(-15, 15), y: f.y + rand(-14, 2),
          vx: rand(-18, 18), vy: rand(-34, -6),
          life: rand(0.4, 0.9), size: randInt(1, 2),
          color: decay > 0.5 ? '#2a2444' : Theme.lightning,
          gravity: 90, drag: 0.94, kind: 'shrink',
        });
      }
    }

    this.head.x = f.x;
    this.head.y = f.y;
    this.head.tilt = f.rot;
  }

  // --- helpers ----------------------------------------------------------

  laggedTarget(lag) {
    const now = this.game.time;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (now - this.history[i].t >= lag) return this.history[i];
    }
    return this.history[0] ?? { x: VIEW_W / 2, y: GROUND_Y - 20 };
  }

  fireSmallLaser() {
    const cfg = this.def.smallLaser;
    const o = this.headOrigin();
    const p = this.game.player;
    const a = Math.atan2((p.y - p.h / 2) - o.y, p.x - o.x) + rand(-0.05, 0.05);
    this.game.projectiles.push(new Projectile({
      x: o.x, y: o.y, vx: Math.cos(a) * cfg.speed, vy: Math.sin(a) * cfg.speed,
      damage: Math.round(cfg.damage * this.dmgScale), team: 'enemy', kind: 'laser',
      life: 3, game: this.game,
    }));
    Sfx.bow();
    Camera.add(1.5);
    burst(o.x, o.y, 5, {
      color: Theme.lightning, speedMin: 20, speedMax: 90, lifeMin: 0.1, lifeMax: 0.25,
      angle: a, spread: 0.5, gravity: 0, kind: 'line',
    });
  }

  startBeam(duration) {
    const cfg = this.def.bigLaser;
    const o = this.headOrigin();
    this.beams.push({
      charge: cfg.windUp,
      ox: o.x, oy: o.y, ex: o.x, ey: o.y, len: 0,
      t: 0,
      duration,
      angle: 0,
      damage: Math.round(cfg.damage * this.dmgScale),
      width: cfg.width,
      hitT: 0,
    });
    Sfx.zap();
  }

  updateBeams(dt) {
    const cfg = this.def.bigLaser;
    const p = this.game.player;
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      const o = this.headOrigin();
      const aim = this.laggedTarget(cfg.lag);
      b.angle = Math.atan2(aim.y - o.y, aim.x - o.x);
      b.ox = o.x; b.oy = o.y;
      // endpoints are always current, so the draw pass never sees a stale one
      b.len = rayLength(o.x, o.y, Math.cos(b.angle), Math.sin(b.angle));
      b.ex = o.x + Math.cos(b.angle) * b.len;
      b.ey = o.y + Math.sin(b.angle) * b.len;
      if (b.charge > 0) {
        b.charge -= dt;
        if (Math.random() < dt * 40) {
          const a = rand(0, TAU);
          spawnParticle({
            x: o.x + Math.cos(a) * 20, y: o.y + Math.sin(a) * 20,
            vx: -Math.cos(a) * 60, vy: -Math.sin(a) * 60, life: 0.28,
            size: 1, color: Theme.lightning, gravity: 0, kind: 'shrink',
          });
        }
        continue;
      }
      b.t += dt;
      if (b.t >= b.duration) { this.beams.splice(i, 1); continue; }
      const ex = b.ex, ey = b.ey;
      // scorch particles along the beam
      if (Math.random() < dt * 50) {
        const k = Math.random();
        spawnParticle({
          x: lerp(o.x, ex, k), y: lerp(o.y, ey, k), vx: rand(-40, 40), vy: rand(-40, 40),
          life: rand(0.1, 0.3), size: 1, color: Theme.lightning, gravity: 0, kind: 'line',
        });
      }
      if (!p.dead && distToSegment(p.x, p.y - p.h / 2, o.x, o.y, ex, ey) < b.width / 2 + 5) {
        p.hurt(b.damage, o.x);
      }
    }
  }

  drawBeams(ctx) {
    if (this.detach && this.detach.tether) {
      const t = this.detach.tether;
      strokeBolt(ctx, t.pts, '#ffffff', 1.5, t.a);
      strokeBolt(ctx, t.pts, Theme.lightning, 4, t.a * 0.5);
    }
    for (const b of this.beams) {
      if (!Number.isFinite(b.ex) || !Number.isFinite(b.ey)) continue;
      const o = { x: b.ox ?? 0, y: b.oy ?? 0 };
      if (b.charge > 0) {
        const cfg = this.def.bigLaser;
        const k = 1 - b.charge / cfg.windUp;
        const len = rayLength(o.x, o.y, Math.cos(b.angle), Math.sin(b.angle));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgba(Theme.hp, 0.25 + 0.35 * k);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x + Math.cos(b.angle) * len, o.y + Math.sin(b.angle) * len);
        ctx.stroke();
        ctx.restore();
        glowDot(ctx, o.x, o.y, 6 + k * 14, Theme.lightning, 0.3 + k * 0.5);
        continue;
      }
      const fade = clamp(Math.min(b.t * 8, (b.duration - b.t) * 8), 0, 1);
      const w = b.width * fade;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'butt';
      ctx.strokeStyle = rgba(Theme.lightning, 0.22 * fade);
      ctx.lineWidth = w * 4;
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(b.ex, b.ey); ctx.stroke();
      ctx.strokeStyle = rgba(Theme.lightning, 0.65 * fade);
      ctx.lineWidth = w * 1.8;
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(b.ex, b.ey); ctx.stroke();
      ctx.strokeStyle = rgba('#ffffff', 0.95 * fade);
      ctx.lineWidth = Math.max(1, w * 0.7);
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(b.ex, b.ey); ctx.stroke();
      ctx.restore();
      glowDot(ctx, o.x, o.y, 16, Theme.lightning, 0.5 * fade);
      glowDot(ctx, b.ex, b.ey, 12, Theme.lightning, 0.4 * fade);
    }
  }

  // --- slam / dash ------------------------------------------------------

  startSlam(high) {
    this.body.vy = -this.def.slam.jumpVel * (high ? 1 : 0.62);
    this.body.onGround = false;
    this.slamming = true;
    Sfx.jump();
    Camera.add(3);
  }

  // It never just stands there. Between orders it paces to keep its stand-off
  // and pops off the floor in short hops, so the silhouette is always moving.
  updateRestless(dt) {
    const cfg = this.def.restless;
    const b = this.body;
    const p = this.game.player;
    if (this.slamming || !p || p.dead) {
      b.vx = lerp(b.vx, 0, 1 - Math.pow(0.002, dt));
      return;
    }
    // the stand-off it wants breathes in and out, so it is never parked
    this.pace = (this.pace ?? rand(0, TAU)) + dt * 0.85;
    const standOff = cfg.standOff + Math.sin(this.pace) * 40 + Math.sin(this.pace * 0.37) * 16;
    const gap = p.x - b.x;
    const away = Math.abs(gap) - standOff;
    // walk in when it is too far, back off when the player crowds it
    const want = clamp(away * 2.4, -cfg.speed, cfg.speed) * sign(gap || 1);
    b.vx = lerp(b.vx, want, 1 - Math.pow(0.004, dt));
    b.facing = sign(gap) || b.facing;

    this.hopT = (this.hopT ?? rand(cfg.hopEvery[0], cfg.hopEvery[1])) - dt;
    if (this.hopT <= 0 && b.onGround) {
      this.hopT = rand(cfg.hopEvery[0], cfg.hopEvery[1]);
      b.vy = -cfg.hopVel;
      b.onGround = false;
      Sfx.ui();
      Camera.add(2.5);
      // dust kicked out from under it
      burst(b.x, b.y, 14, {
        color: Theme.groundEdge, color2: Theme.enemyBrute, speedMin: 30, speedMax: 130,
        lifeMin: 0.2, lifeMax: 0.5, sizeMax: 2, gravity: 320, angle: -Math.PI / 2, spread: 1.5,
      });
      burst(b.x, b.y, 6, {
        color: Theme.groundEdge, kind: 'smoke', speedMin: 14, speedMax: 60,
        lifeMin: 0.3, lifeMax: 0.8, sizeMin: 2, sizeMax: 4, gravity: -20, glow: false,
      });
      impactRing(b.x, b.y, { color: Theme.groundEdge, r0: 4, r1: 34, life: 0.3, width: 1.5, squash: 0.3 });
    }
  }

  updateBodyPhysics(dt) {
    const b = this.body;
    b.vy += GRAVITY * dt;
    if (this.slamming && b.vy > 0) b.vy += this.def.slam.fallAccel * dt;
    b.vy = Math.min(b.vy, 1300);
    b.x = clamp(b.x + b.vx * dt, b.w / 2, VIEW_W - b.w / 2);
    b.y += b.vy * dt;
    if (b.y >= GROUND_Y) {
      const wasAir = !b.onGround;
      b.y = GROUND_Y;
      b.vy = 0;
      b.onGround = true;
      if (this.slamming && wasAir) this.landSlam();
      else if (wasAir) {
        // even a small hop lands with weight
        Camera.add(3);
        burst(b.x, b.y, 12, {
          color: Theme.groundEdge, speedMin: 25, speedMax: 120, lifeMin: 0.15, lifeMax: 0.45,
          sizeMax: 2, gravity: 360, angle: -Math.PI / 2, spread: 1.6,
        });
        impactRing(b.x, b.y, { color: Theme.groundEdge, r0: 5, r1: 44, life: 0.26, width: 2, squash: 0.28 });
      }
    } else {
      b.onGround = false;
    }
  }

  landSlam() {
    this.slamming = false;
    const cfg = this.def.slam;
    const b = this.body;
    Sfx.slam();
    Camera.add(13);
    this.game.hitstop(0.08);
    screenFlash(0.22, '#ffd0a0', 0.18);
    this.game.shockwaves.push({ x: b.x, y: b.y, t: 0, r: cfg.radius });
    burst(b.x, b.y, 40, {
      color: Theme.uiAccent, color2: Theme.enemyBrute, speedMin: 60, speedMax: 260,
      lifeMin: 0.25, lifeMax: 0.7, sizeMax: 3, gravity: 460, angle: -Math.PI / 2, spread: 1.5,
    });
    const p = this.game.player;
    if (!p.dead && dist(p.x, p.y, b.x, b.y) < cfg.radius + 10 && p.onGround) {
      p.hurt(Math.round(cfg.damage * this.dmgScale), b.x);
    }
  }

  startDash() {
    const p = this.game.player;
    const dir = sign(p.x - this.body.x) || 1;
    this.body.facing = dir;
    this.body.vx = dir * this.def.dash.speed;
    this.dashT = this.def.dash.time;
    Sfx.dash();
  }

  // --- phase scripts ----------------------------------------------------

  update(dt) {
    if (this.dead) return;
    const p = this.game.player;
    this.history.push({ t: this.game.time, x: p.x, y: p.y - p.h / 2 });
    if (this.history.length > 200) this.history.shift();

    if (this.intro > 0) {
      this.intro -= dt;
      this.updateBodyPhysics(dt);
      return;
    }

    this.updateBeams(dt);
    if (this.phase === 1) this.updatePhase1(dt);
    else this.updatePhase2(dt);

    // dash decay
    if (this.dashT > 0) {
      this.dashT -= dt;
      const b = this.body;
      if (!p.dead && Math.abs(p.x - b.x) < (b.w + p.w) / 2 && Math.abs((p.y - p.h / 2) - b.cy) < (b.h + p.h) / 2) {
        p.hurt(Math.round(this.def.dash.damage * this.dmgScale), b.x);
      }
      if (Math.random() < dt * 50) {
        spawnParticle({
          x: b.x + rand(-14, 14), y: b.y - rand(0, b.h), vx: rand(-30, 30), vy: rand(-20, 20),
          life: 0.3, size: 2, color: Theme.enemyBrute, gravity: 0, kind: 'shrink',
        });
      }
      if (this.dashT <= 0) this.body.vx = 0;
    } else {
      this.updateRestless(dt);
    }
    this.updateBodyPhysics(dt);
    if (this.detach) this.updateDetach(dt);
    else if (this.head) this.updateHeadMotion(dt);
  }

  // Phase 1: small burst -> tracking beam -> ground slam -> repeat.
  updatePhase1(dt) {
    const slow = this.body.st.slowFactor;
    this.stateT += dt * slow;
    const p = this.game.player;
    this.body.facing = sign(p.x - this.body.x) || this.body.facing;

    switch (this.state) {
      case 'wait':
        if (this.stateT > this.def.attackDelay) this.beginStep(this.step % 3);
        break;
      case 'small':
        this.shotT -= dt * slow;
        if (this.shotT <= 0 && this.shots < this.def.smallLaser.count) {
          this.shots++;
          this.shotT = this.def.smallLaser.interval;
          this.fireSmallLaser();
        }
        if (this.shots >= this.def.smallLaser.count && this.shotT <= -0.25) this.nextStep();
        break;
      case 'beam':
        if (this.beams.length === 0 && this.stateT > this.def.bigLaser.windUp) this.nextStep();
        break;
      case 'slam':
        if (!this.slamming && this.stateT > this.def.slam.windUp + 0.2) this.nextStep();
        break;
    }
  }

  beginStep(i) {
    this.stateT = 0;
    if (i === 0) {
      this.state = 'small';
      this.shots = 0;
      this.shotT = this.def.smallLaser.windUp;
    } else if (i === 1) {
      this.state = 'beam';
      this.startBeam(this.def.bigLaser.duration);
    } else {
      this.state = 'slam';
      this.startSlam(true);
    }
  }

  nextStep() {
    this.step++;
    this.state = 'wait';
    this.stateT = 0;
  }

  // Phase 2: the head keeps a script, the body improvises.
  updatePhase2(dt) {
    const slow = this.body.st.slowFactor;
    this.stateT += dt * slow;
    if (this.state === 'split') {
      if (!this.detach) { this.state = 'wait'; this.stateT = 0; this.step = 0; }
      return;
    }

    // --- head script: small x4 -> turn -> long beam -> short beam (+ body)
    switch (this.state) {
      case 'wait':
        if (this.stateT > this.def.attackDelay) this.beginHeadStep(this.step % 4);
        break;
      case 'small':
        this.shotT -= dt * slow;
        if (this.shotT <= 0 && this.shots < this.def.smallLaser.count) {
          this.shots++;
          this.shotT = this.def.smallLaser.interval;
          this.fireSmallLaser();
        }
        if (this.shots >= this.def.smallLaser.count && this.shotT <= -0.2) this.nextStep();
        break;
      case 'turn':
        if (this.stateT > 0.6) this.nextStep();
        break;
      case 'beam':
      case 'beamShort':
        if (this.beams.length === 0 && this.stateT > this.def.bigLaser.windUp) this.nextStep();
        break;
    }

    // --- body: no script, just a cooldown and a random pick
    this.bodyT -= dt * slow;
    if (this.bodyT <= 0 && !this.slamming && this.dashT <= 0) {
      const pick = this.syncDash ? 'dash' : choice(['slamHigh', 'slam', 'dash']);
      this.syncDash = false;
      const delay = this.def.attackDelay;
      if (pick === 'dash') { this.startDash(); this.bodyT = delay; }
      else { this.startSlam(pick === 'slamHigh'); this.bodyT = delay; }
    }
  }

  beginHeadStep(i) {
    this.stateT = 0;
    if (i === 0) {
      this.state = 'small';
      this.shots = 0;
      this.shotT = this.def.smallLaser.windUp * 0.7;
      this.headTargetX = rand(60, VIEW_W - 60);
    } else if (i === 1) {
      this.state = 'turn';
      this.headTargetX = this.game.player.x + (Math.random() < 0.5 ? -90 : 90);
    } else if (i === 2) {
      this.state = 'beam';
      this.startBeam(this.def.bigLaser.duration);
    } else {
      this.state = 'beamShort';
      this.startBeam(this.def.bigLaser.shortDuration);
      this.syncDash = true;      // the body charges in on this one
      this.bodyT = Math.min(this.bodyT, 0.15);
    }
  }

  // Wrench, sag, then rise. Nothing here snaps: every value is eased and the
  // head keeps a little overshoot at the top before it settles into its hover.
  updateDetach(dt) {
    const d = this.detach;
    const h = this.head;
    d.t += dt;
    const k = clamp(d.t / d.dur, 0, 1);

    let x = d.fromX;
    let y = d.fromY;
    let tilt = 0;

    if (k < 0.28) {
      // straining: the head shudders in place and sinks a couple of pixels
      const p = k / 0.28;
      const shake = (1 - p) * 1.6;
      x = d.fromX + Math.sin(d.t * 46) * shake;
      y = d.fromY + p * 3;
      tilt = Math.sin(d.t * 34) * 0.05 * (0.4 + p);
      if (Math.random() < dt * 40) {
        const a = rand(0, TAU);
        spawnParticle({
          x: d.fromX + Math.cos(a) * 14, y: d.fromY + Math.sin(a) * 10,
          vx: -Math.cos(a) * 50, vy: -Math.sin(a) * 50, life: 0.3,
          size: 1, color: Theme.lightning, gravity: 0, kind: 'shrink',
        });
      }
    } else {
      // tears free and climbs, easing out with a soft overshoot
      const p = (k - 0.28) / 0.72;
      const ease = 1 - Math.pow(1 - p, 3);
      const overshoot = Math.sin(p * Math.PI) * 6;
      x = lerp(d.fromX, d.toX, ease);
      y = lerp(d.fromY + 3, d.toY, ease) - overshoot;
      tilt = Math.sin(p * 7.5) * 0.30 * (1 - p);
      if (p < 0.06 && !d.popped) {
        d.popped = true;
        Sfx.zap();
        Camera.add(9);
        Camera.punch(2.2);
        this.game.hitstop(0.09);
        burst(d.fromX, d.fromY, 34, {
          color: Theme.lightning, color2: '#ffffff', kind: 'streak',
          speedMin: 90, speedMax: 320, lifeMin: 0.15, lifeMax: 0.4, gravity: 0, drag: 0.86,
        });
        impactRing(d.fromX, d.fromY, { color: Theme.lightning, r0: 6, r1: 66, life: 0.45, width: 3 });
        impactRing(d.fromX, d.fromY, { color: '#ffffff', r0: 3, r1: 34, life: 0.3, width: 2 });
      }
      if (Math.random() < dt * 55) {
        spawnParticle({
          x: x + rand(-10, 10), y: y + rand(-6, 8),
          vx: rand(-20, 20), vy: rand(30, 90), life: rand(0.25, 0.55),
          size: 1, color: Theme.lightning, gravity: 40, kind: 'shrink',
        });
      }
    }

    h.x = x;
    h.y = y + h.h / 2;
    h.tilt = tilt;
    h.facing = sign(this.game.player.x - h.x) || h.facing;

    // an arc still bridging head and socket while it pulls away
    const o = { x: this.body.x, y: this.body.y - this.body.h + 5 };
    const stretch = Math.hypot(h.x - o.x, (h.y - h.h / 2) - o.y);
    d.tether = (stretch > 4 && k < 0.92)
      ? { pts: boltPath(o.x, o.y, h.x, h.y - h.h / 2, 5 + stretch * 0.08, 8, this.game.time * 26), a: 0.55 * (1 - k) }
      : null;

    if (k >= 1) {
      this.detach = null;
      h.tilt = 0;
      this.headDrift = rand(0, TAU);
    }
  }

  updateHeadMotion(dt) {
    const h = this.head;
    const slow = h.st.slowFactor;
    const p = this.game.player;
    this.headDrift += dt * 0.9;

    // The script only nudges the anchor; the head itself is always sliding,
    // sweeping past its anchor and bobbing, so it never looks parked.
    this.headAnchorX = lerp(this.headAnchorX, this.headTargetX, 1 - Math.pow(0.25, dt));
    const sweep = Math.sin(this.headDrift) * 46 + Math.sin(this.headDrift * 0.47 + 1.3) * 22;
    // a slow pull toward the player so it always feels like it is stalking you
    const stalk = (p.x - this.headAnchorX) * 0.18;
    const target = clamp(this.headAnchorX + sweep + stalk, 26, VIEW_W - 26);

    h.vx = lerp(h.vx, clamp((target - h.x) * 2.4, -this.def.headSpeed, this.def.headSpeed) * slow, 1 - Math.pow(0.002, dt));
    h.x = clamp(h.x + h.vx * dt, h.w / 2, VIEW_W - h.w / 2);

    // vertical bob on two out-of-phase waves, plus a dip when it aims
    const aiming = this.state === 'beam' || this.state === 'beamShort' || this.state === 'small';
    const bob = Math.sin(this.game.time * 1.9) * 4 + Math.sin(this.game.time * 0.83 + 2.1) * 2.5;
    const targetY = this.def.headHover + bob + (aiming ? 5 : 0);
    h.y = lerp(h.y, targetY, 1 - Math.pow(0.02, dt));

    // bank into the direction of travel
    h.tilt = lerp(h.tilt ?? 0, clamp(-h.vx / this.def.headSpeed, -1, 1) * 0.16, 1 - Math.pow(0.02, dt));
    h.facing = sign(p.x - h.x) || h.facing;

    if (Math.random() < dt * 20) {
      spawnParticle({
        x: h.x + rand(-10, 10), y: h.y + rand(-4, 6), vx: rand(-8, 8), vy: rand(6, 22),
        life: rand(0.25, 0.5), size: 1, color: Theme.lightning, gravity: 30, kind: 'shrink',
      });
    }
  }

  // --- art --------------------------------------------------------------

  drawBody(ctx, part) {
    const t = part.anim;
    const flash = part.hurtFlash > 0;
    const C = (c) => (flash ? '#ffffff' : c);
    const x = Math.round(part.x);
    const y = Math.round(part.y);
    const w = part.w, h = part.h;
    const charging = this.state === 'beam' || this.state === 'beamShort' || this.state === 'small';
    const core = 0.5 + 0.5 * Math.sin(t * 4);

    const INK = flash ? '#ffffff' : '#120e22';
    // legs
    const stance = this.slamming ? 7 : 0;
    limbInk(ctx, x - 12, y - 20 + stance, Math.PI / 2 - 0.12, 21 - stance, 12, C('#3a3358'), INK);
    limbInk(ctx, x + 12, y - 20 + stance, Math.PI / 2 + 0.12, 21 - stance, 12, C('#3a3358'), INK);
    pxSolid(ctx, x - 19, y - 4, 13, 4, C('#2a2444'), { ink: INK });
    pxSolid(ctx, x + 6, y - 4, 13, 4, C('#2a2444'), { ink: INK });

    // torso slab, with plate seams down it
    pxSolid(ctx, x - w / 2, y - h + 10, w, h - 30, C('#4a3f78'), { ink: INK });
    pxRect(ctx, x - w / 2, y - h + 10, w, 5, C('#6a5aa8'));
    pxRect(ctx, x - w / 2 + 4, y - h + 19, w - 8, 4, C('#2a2444'));
    for (let i = 1; i < 4; i++) {
      pxRect(ctx, x - w / 2 + (w / 4) * i, y - h + 24, 1, h - 46, C('#2a2444'));
    }
    // shoulders
    pxSolid(ctx, x - w / 2 - 7, y - h + 13, 8, 17, C('#3a3358'), { ink: INK });
    pxSolid(ctx, x + w / 2 - 1, y - h + 13, 8, 17, C('#3a3358'), { ink: INK });
    // arms
    const swing = Math.sin(t * 2) * 0.14 + (this.dashT > 0 ? 0.7 : 0);
    limbInk(ctx, x - w / 2 - 3, y - h + 24, Math.PI / 2 + swing, 24, 10, C('#4a3f78'), INK);
    limbInk(ctx, x + w / 2 + 3, y - h + 24, Math.PI / 2 - swing, 24, 10, C('#4a3f78'), INK);
    // fists, with a lit knuckle ridge
    const fy = y - h + 24 + Math.cos(swing) * 24;
    pxSolid(ctx, x - w / 2 - 8, fy - 5, 11, 10, C('#2a2444'), { ink: INK });
    pxSolid(ctx, x + w / 2 - 2, fy - 5, 11, 10, C('#2a2444'), { ink: INK });
    pxRect(ctx, x - w / 2 - 8, fy - 5, 11, 1, C('#6a5aa8'));
    pxRect(ctx, x + w / 2 - 2, fy - 5, 11, 1, C('#6a5aa8'));

    // core
    const cy = y - h + 28;
    glowDot(ctx, x, cy, 13 + core * 6, Theme.lightning, 0.22 + core * 0.16);
    pxRect(ctx, x - 6, cy - 6, 12, 12, C(Theme.lightning));
    pxRect(ctx, x - 3, cy - 3, 6, 6, '#ffffff');

    // once the head has torn free - by phase change or by death - the body
    // shows the open socket instead of a second head
    if (this.phase === 1 && !this.headFall) {
      // head fused to the shoulders
      const hy = y - h - 6;
      pxSolid(ctx, x - 16, hy, 32, 21, C('#54487f'), { ink: INK });
      pxRect(ctx, x - 16, hy, 32, 5, C('#7a68bd'));
      pxRect(ctx, x - 11, hy + 8, 22, 7, C('#1d1836'));
      const eye = charging ? 1 : 0.45 + 0.3 * Math.sin(t * 5);
      const ec = charging ? Theme.hp : Theme.lightning;
      glowEye(ctx, x - 9, hy + 9, 7, 4, rgba(ec, eye), 0.30 * eye);
      glowEye(ctx, x + 3, hy + 9, 7, 4, rgba(ec, eye), 0.30 * eye);
      glowDot(ctx, x, hy + 10, charging ? 24 : 13, ec, 0.3 * eye + 0.15);
      // crown horns
      pxSolid(ctx, x - 19, hy - 7, 5, 10, C('#3a3358'), { ink: INK });
      pxSolid(ctx, x + 14, hy - 7, 5, 10, C('#3a3358'), { ink: INK });
    } else {
      // open neck socket, arcing where the head used to sit
      const ny = y - h + 5;
      pxSolid(ctx, x - 13, ny, 26, 8, C('#2a2444'), { ink: INK });
      pxSolid(ctx, x - 9, ny - 3, 18, 4, C('#1d1836'), { ink: INK });
      glowDot(ctx, x, ny, 18, Theme.lightning, 0.35 + core * 0.2);
      const pts = boltPath(x - 11, ny, x + 11, ny - 5, 5, 5, this.game.time * 20);
      strokeBolt(ctx, pts, Theme.lightning, 1, 0.7);
    }
  }

  drawHead(ctx, part) {
    const t = part.anim;
    const flash = part.hurtFlash > 0;
    const C = (c) => (flash ? '#ffffff' : c);
    const x = Math.round(part.x);
    const y = Math.round(part.y - part.h / 2);
    const charging = this.state === 'beam' || this.state === 'beamShort';
    const eyeCol = charging ? Theme.hp : Theme.lightning;

    const tilt = part.tilt ?? 0;
    ctx.save();
    if (this.headAlpha !== undefined) {
      if (this.headAlpha <= 0.01) { ctx.restore(); return; }
      ctx.globalAlpha *= this.headAlpha;
    }
    if (Math.abs(tilt) > 0.001) {
      ctx.translate(x, y);
      ctx.rotate(tilt);
      ctx.translate(-x, -y);
    }

    // levitation ring, only while it is still under its own power
    if (!this.headFall) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(Theme.lightning, 0.25 + 0.2 * Math.sin(t * 5));
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y + 19, 21, 5, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
    }

    const HINK = flash ? '#ffffff' : '#120e22';
    pxSolid(ctx, x - 16, y - 13, 32, 21, C('#54487f'), { ink: HINK });
    pxRect(ctx, x - 16, y - 13, 32, 5, C('#7a68bd'));
    pxRect(ctx, x - 11, y - 5, 22, 7, C('#1d1836'));
    const eye = charging ? 1 : 0.5 + 0.3 * Math.sin(t * 6);
    glowEye(ctx, x - 9, y - 4, 7, 4, rgba(eyeCol, eye), 0.30 * eye);
    glowEye(ctx, x + 3, y - 4, 7, 4, rgba(eyeCol, eye), 0.30 * eye);
    pxSolid(ctx, x - 19, y - 19, 5, 10, C('#3a3358'), { ink: HINK });
    pxSolid(ctx, x + 14, y - 19, 5, 10, C('#3a3358'), { ink: HINK });
    // jaw, with a row of teeth
    pxSolid(ctx, x - 12, y + 8, 24, 5, C('#3a3358'), { ink: HINK });
    for (let i = 0; i < 6; i++) pxRect(ctx, x - 10 + i * 4, y + 8, 2, 2, C('#cdc4ee'));
    ctx.restore();
    glowDot(ctx, x, y, charging ? 28 : 17, eyeCol, (0.3 + 0.25 * eye) * (this.headAlpha ?? 1));
  }
}

// `which` forces a specific boss; without it, boss rooms alternate.
// A boss built to be looked at, not fought: its parts are pulled straight back
// out of the room so nothing can hit them, nothing updates it, and phase two
// is reached by hand rather than by the transition that shakes the screen.
export function makeBossPreview(game, id, phase = 1) {
  const before = game.enemies.length;
  const boss = makeBoss(game, CODEX_ROOM[id] ?? 5, id);
  boss.previewParts = game.enemies.splice(before);
  boss.intro = 0;
  if (boss.posePreview) boss.posePreview();
  if (phase === 2 && boss.spawnHead) {
    boss.phase = 2;
    const head = boss.spawnHead(boss.headOrigin());
    // In the fight it hovers most of the room above the body. A portrait that
    // framed both would shrink each to nothing, so here it sits just clear of
    // the socket: what the page has to show is that the head came off.
    head.y = GROUND_Y - boss.def.bodyH - 14;
    boss.previewParts.push(head);
  }
  return boss;
}

// Where each one turns up, which is also the order the codex lists them in.
export const CODEX_ROOM = {
  golem: 5, bigdude: 10, ceiling: CEILING_ROOM, alphads: FINAL_ROOM, poitnus: 0,
};

// Paint a preview at whatever transform the caller has set up. The Golem has
// no draw() of its own - its parts carry the art - so both are tried.
export function drawBossPreview(ctx, boss, t) {
  if (!boss) return;
  for (const p of boss.previewParts ?? []) p.anim = t;
  if (boss.draw) boss.draw(ctx);
  for (const p of boss.previewParts ?? []) if (p.draw) p.draw(ctx);
}

export function makeBoss(game, roomIndex, which = null) {
  if (which === 'golem') return new GolemBoss(game, roomIndex);
  if (which === 'bigdude') return new WormBoss(game, roomIndex);
  if (which === 'alphads') return new AlphadsBoss(game, roomIndex);
  if (which === 'ceiling') return new CeilingBoss(game, roomIndex);
  if (which === 'poitnus') return new PoitnusBoss(game, roomIndex);
  // the last room belongs to the god, whatever the rotation says
  if (roomIndex >= FINAL_ROOM) return new AlphadsBoss(game, roomIndex);
  if (roomIndex === CEILING_ROOM) return new CeilingBoss(game, roomIndex);
  const tier = Math.max(1, Math.round(roomIndex / BOSS_ROOM_INTERVAL));
  return tier % 2 === 1 ? new GolemBoss(game, roomIndex) : new WormBoss(game, roomIndex);
}
