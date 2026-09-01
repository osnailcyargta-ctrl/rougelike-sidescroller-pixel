// The Aether Golem: a two-phase boss that owns a shared HP pool and drives
// one or two body parts. The parts live in game.enemies so every existing hit
// test, status effect and perk works on them unchanged.
import { clamp, lerp, rand, randInt, choice, dist, distToSegment, sign, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, floatText, spawnParticle, limb, pxRect, glowDot, boltPath, strokeBolt } from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GRAVITY, GROUND_Y, BOSS_TYPES, ROOM_SCALING, BOSS_ROOM_INTERVAL } from './config.js';
import { Enemy, Projectile } from './entities.js';

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

    const tier = Math.max(1, Math.round(roomIndex / BOSS_ROOM_INTERVAL));
    this.hpScale = 1 + ROOM_SCALING.bossHpPerTier * (tier - 1);
    this.dmgScale = 1 + ROOM_SCALING.bossDamagePerTier * (tier - 1);
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
    this.syncDash = false;

    this.body = new BossPart('golemBody', VIEW_W / 2, GROUND_Y, game, this);
    this.body.facing = -1;
    this.head = null;
    game.enemies.push(this.body);
  }

  get damage() { return this; }

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
    this.head = new BossPart('golemHead', o.x, o.y, this.game, this);
    this.head.y = o.y;
    this.game.enemies.push(this.head);
    this.step = 0;
    this.bodyState = 'idle';
    this.bodyT = 0.8;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.beams.length = 0;
    this.body.dead = true;
    if (this.head) this.head.dead = true;
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
    this.game.onEnemyKilled(this.body);
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
      this.body.vx = lerp(this.body.vx, 0, 1 - Math.pow(0.002, dt));
    }
    this.updateBodyPhysics(dt);
    if (this.head) this.updateHeadMotion(dt);
  }

  // Phase 1: small burst -> tracking beam -> ground slam -> repeat.
  updatePhase1(dt) {
    const slow = this.body.st.slowFactor;
    this.stateT += dt * slow;
    const p = this.game.player;
    this.body.facing = sign(p.x - this.body.x) || this.body.facing;

    switch (this.state) {
      case 'wait':
        if (this.stateT > this.def.recovery) this.beginStep(this.step % 3);
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
      if (this.stateT > 1.0) { this.state = 'wait'; this.stateT = 0; this.step = 0; }
      return;
    }

    // --- head script: small x4 -> turn -> long beam -> short beam (+ body)
    switch (this.state) {
      case 'wait':
        if (this.stateT > this.def.recovery * 0.8) this.beginHeadStep(this.step % 4);
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
      if (pick === 'dash') { this.startDash(); this.bodyT = 1.5; }
      else { this.startSlam(pick === 'slamHigh'); this.bodyT = pick === 'slamHigh' ? 2.0 : 1.4; }
    }
  }

  beginHeadStep(i) {
    this.stateT = 0;
    if (i === 0) {
      this.state = 'small';
      this.shots = 0;
      this.shotT = this.def.smallLaser.windUp * 0.7;
      this.headTargetX = rand(40, VIEW_W - 40);
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

  updateHeadMotion(dt) {
    const h = this.head;
    const slow = h.st.slowFactor;
    // x-axis only; the hover height never changes
    const target = clamp(this.headTargetX, 26, VIEW_W - 26);
    h.vx = lerp(h.vx, clamp((target - h.x) * 2.2, -this.def.headSpeed, this.def.headSpeed) * slow, 1 - Math.pow(0.002, dt));
    h.x = clamp(h.x + h.vx * dt, h.w / 2, VIEW_W - h.w / 2);
    h.y = this.def.headHover + Math.sin(this.game.time * 2) * 3;
    h.facing = sign(this.game.player.x - h.x) || h.facing;
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

    // legs
    const stance = this.slamming ? 5 : 0;
    limb(ctx, x - 9, y - 14 + stance, Math.PI / 2 - 0.12, 15 - stance, 9, C('#3a3358'));
    limb(ctx, x + 9, y - 14 + stance, Math.PI / 2 + 0.12, 15 - stance, 9, C('#3a3358'));
    pxRect(ctx, x - 14, y - 3, 10, 3, C('#2a2444'));
    pxRect(ctx, x + 4, y - 3, 10, 3, C('#2a2444'));

    // torso slab
    pxRect(ctx, x - w / 2, y - h + 8, w, h - 22, C('#4a3f78'));
    pxRect(ctx, x - w / 2, y - h + 8, w, 4, C('#6a5aa8'));
    pxRect(ctx, x - w / 2 + 3, y - h + 14, w - 6, 3, C('#2a2444'));
    // shoulders
    pxRect(ctx, x - w / 2 - 5, y - h + 10, 6, 12, C('#3a3358'));
    pxRect(ctx, x + w / 2 - 1, y - h + 10, 6, 12, C('#3a3358'));
    // arms
    const swing = Math.sin(t * 2) * 0.14 + (this.dashT > 0 ? 0.7 : 0);
    limb(ctx, x - w / 2 - 2, y - h + 18, Math.PI / 2 + swing, 17, 7, C('#4a3f78'));
    limb(ctx, x + w / 2 + 2, y - h + 18, Math.PI / 2 - swing, 17, 7, C('#4a3f78'));

    // core
    const cy = y - h + 20;
    glowDot(ctx, x, cy, 10 + core * 5, Theme.lightning, 0.35 + core * 0.25);
    pxRect(ctx, x - 4, cy - 4, 8, 8, C(Theme.lightning));
    pxRect(ctx, x - 2, cy - 2, 4, 4, '#ffffff');

    if (this.phase === 1) {
      // head fused to the shoulders
      const hy = y - h - 4;
      pxRect(ctx, x - 12, hy, 24, 16, C('#54487f'));
      pxRect(ctx, x - 12, hy, 24, 4, C('#7a68bd'));
      pxRect(ctx, x - 8, hy + 6, 16, 5, C('#1d1836'));
      const eye = charging ? 1 : 0.45 + 0.3 * Math.sin(t * 5);
      pxRect(ctx, x - 7, hy + 7, 5, 3, rgba(charging ? Theme.hp : Theme.lightning, eye));
      pxRect(ctx, x + 2, hy + 7, 5, 3, rgba(charging ? Theme.hp : Theme.lightning, eye));
      glowDot(ctx, x, hy + 8, charging ? 18 : 10, charging ? Theme.hp : Theme.lightning, 0.3 * eye + 0.15);
      // crown horns
      pxRect(ctx, x - 14, hy - 5, 4, 7, C('#3a3358'));
      pxRect(ctx, x + 10, hy - 5, 4, 7, C('#3a3358'));
    } else {
      // open neck socket, arcing where the head used to sit
      const ny = y - h + 4;
      pxRect(ctx, x - 10, ny, 20, 6, C('#2a2444'));
      pxRect(ctx, x - 7, ny - 2, 14, 3, C('#1d1836'));
      glowDot(ctx, x, ny, 14, Theme.lightning, 0.35 + core * 0.2);
      const pts = boltPath(x - 8, ny, x + 8, ny - 4, 4, 5, this.game.time * 20);
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

    // levitation ring
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(Theme.lightning, 0.25 + 0.2 * Math.sin(t * 5));
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y + 14, 16, 4, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();

    pxRect(ctx, x - 12, y - 10, 24, 16, C('#54487f'));
    pxRect(ctx, x - 12, y - 10, 24, 4, C('#7a68bd'));
    pxRect(ctx, x - 8, y - 4, 16, 5, C('#1d1836'));
    const eye = charging ? 1 : 0.5 + 0.3 * Math.sin(t * 6);
    pxRect(ctx, x - 7, y - 3, 5, 3, rgba(eyeCol, eye));
    pxRect(ctx, x + 2, y - 3, 5, 3, rgba(eyeCol, eye));
    pxRect(ctx, x - 14, y - 15, 4, 7, C('#3a3358'));
    pxRect(ctx, x + 10, y - 15, 4, 7, C('#3a3358'));
    // jaw
    pxRect(ctx, x - 9, y + 6, 18, 4, C('#3a3358'));
    glowDot(ctx, x, y, charging ? 22 : 13, eyeCol, 0.3 + 0.25 * eye);
  }
}

export function makeBoss(game, roomIndex) {
  // Only the golem exists so far; bullet-hell and the third archetype slot in
  // here once their patterns are designed.
  return new GolemBoss(game, roomIndex);
}
