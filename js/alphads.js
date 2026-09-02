// Alphads, the Aether God. The last thing in the vault: it never lands, it
// cannot be slammed, and it fights on a fixed liturgy of five attacks.
import { clamp, lerp, rand, randInt, choice, dist, distToSegment, shortAngle, sign, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import {
  Camera, burst, floatText, spawnParticle, impactRing, limb, pxRect, glowDot, ribbon,
} from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GROUND_Y, BLOCK, BOSS_TYPES, ROOM_SCALING, ENEMY_TYPES } from './config.js';
import { Enemy, Projectile } from './entities.js';

const TINT = {
  censor: '#08070c',
  censorEdge: '#1a1726',
  halo: '#ffe9a8',
  wing: '#f6f1e4',
  wingShade: '#c9bda4',
  wingDeep: '#9c8e74',
  gold: '#ffd76a',
  goldDeep: '#b9863a',
  ray: '#fff6d8',
  orb: '#7cffa8',
};

class GodPart extends Enemy {
  constructor(type, x, y, game, boss) {
    super(type, x, y, game);
    this.boss = boss;
    this.spawnT = 0;
    this.isBoss = true;
    this.noContact = false;
    this.dmg = Math.round(this.def.damage * boss.dmgScale);
    this.maxHp = boss.maxHp;
    this.hp = boss.hp;
  }
  applyRawDamage(amount) { this.boss.applyRawDamage(amount); }
  damage(amount, opts = {}) { super.damage(amount, { ...opts, knockback: 0, shake: opts.shake ?? 1 }); }
  kill() { this.boss.die(); }
  drawHpBar() {}
  draw() {}   // the boss draws itself, over the enemy layer
  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.maxHp;
    this.updateStatus(dt);
  }
}

export class AlphadsBoss {
  constructor(game, roomIndex) {
    const def = BOSS_TYPES.alphads;
    this.game = game;
    this.def = def;
    this.name = def.name;
    this.title = def.title;
    this.kind = 'god';
    this.roomIndex = roomIndex;

    this.hpScale = 1;
    this.dmgScale = 1;
    this.maxHp = def.hp;
    this.hp = this.maxHp;
    this.phase = 1;
    this.phase2At = 0;
    this.dead = false;
    this.intro = 0;

    this.x = VIEW_W / 2;
    this.y = def.hoverY;
    this.targetX = VIEW_W / 2;
    this.bob = rand(0, TAU);
    this.wing = 0;
    this.facing = -1;

    this.state = 'idle';
    this.stateT = 0;
    this.step = -1;
    this.waitT = 0.9;               // a breath before the first verse
    this.shots = 0;
    this.shotT = 0;
    this.ray = null;
    this.orbs = [];
    this.rainMarks = [];
    this.pillars = [];       // light columns the shardlings arrive down
    this.sweep = -1;         // the time-stop clock hand, -1 when idle
    this.shardlingsSpawned = 0;
    this.script = AlphadsBoss.buildScript();
    this.feathers = [];
    for (let i = 0; i < 14; i++) {
      this.feathers.push({ x: rand(VIEW_W), y: rand(VIEW_H), vy: rand(6, 20), p: rand(TAU), s: rand(0.6, 1.4) });
    }

    // Its pool is fixed at 1750 by design - the god does not scale with the run.
    this.spawnParts();
  }

  // shot x2, rain, three times over; then the long verse.
  static buildScript() {
    const s = [];
    for (let i = 0; i < 3; i++) {
      s.push({ a: 'shot' }, { wait: 0.5 }, { a: 'shot' }, { wait: 1.0 },
             { a: 'rain' }, { wait: 3.0 });
    }
    s.push({ wait: 1.0 });
    s.push({ a: 'timestop' });
    s.push({ a: 'godray' }, { wait: 2.3 }, { a: 'godray' }, { wait: 1.0 },
           { a: 'shot' }, { wait: 0.5 }, { a: 'shot' }, { wait: 0.5 }, { a: 'shot' });
    s.push({ a: 'heal' });
    return s;
  }

  get parts() { return [this.body].filter(Boolean); }

  spawnParts() {
    this.body = new GodPart('alphadsBody', this.x, this.y + this.def.h / 2, this.game, this);
    this.game.enemies.push(this.body);
  }

  applyRawDamage(amount) {
    if (this.dead) return;
    this.hp -= amount;
    if (this.hp <= 0) this.die();
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    floatText(this.x, this.y - 24, `+${amount}`, TINT.orb, { life: 0.9 });
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deathT = 0;          // it stays on screen and comes apart
    this.hp = 0;
    this.ray = null;
    this.orbs.length = 0;
    if (this.body) this.body.dead = true;
    // its congregation goes with it
    for (const e of this.game.enemies) {
      if (e.type === 'aetherShardling' && !e.dead) e.kill();
    }
    this.game.endTimeStop();
    Camera.add(18);
    this.game.hitstop(0.26);
    Sfx.die();
    burst(this.x, this.y, 60, {
      color: TINT.wing, color2: TINT.gold, speedMin: 40, speedMax: 300,
      lifeMin: 0.5, lifeMax: 1.6, sizeMax: 4, gravity: 90, drag: 0.94,
    });
    impactRing(this.x, this.y, { color: '#ffffff', r0: 6, r1: 220, life: 0.9, width: 4 });
    this.game.onBossDefeated(this);
    this.game.onEnemyKilled(this.body);
  }

  // --- script ------------------------------------------------------------

  nextStep() {
    this.step = (this.step + 1) % this.script.length;
    const s = this.script[this.step];
    this.stateT = 0;
    if (s.wait !== undefined) {
      this.state = 'idle';
      this.waitT = s.wait;
      this.targetX = clamp(this.game.player.x + rand(-110, 110), 70, VIEW_W - 70);
      return;
    }
    switch (s.a) {
      case 'shot': this.state = 'shot'; this.shots = 0; this.shotT = this.def.shot.windUp; break;
      case 'rain': this.state = 'rain'; this.rainFired = false; break;
      case 'timestop': this.state = 'timestop'; this.tsFired = false; break;
      case 'godray': this.state = 'godray'; this.rayFired = false; break;
      case 'heal': this.state = 'heal'; this.healFired = false; break;
    }
    Sfx.ui();
  }

  update(dt) {
    if (this.dead) return;
    const d = this.def;
    const p = this.game.player;
    this.stateT += dt;
    this.bob += dt * 1.35;
    this.wing += dt * (this.state === 'idle' ? 2.4 : 3.4);
    this.facing = sign(p.x - this.x) || this.facing;

    // it never lands and it never stops drifting
    const hover = d.hoverY + Math.sin(this.bob) * 7 + Math.sin(this.bob * 0.61) * 4;
    this.x = lerp(this.x, clamp(this.targetX, 70, VIEW_W - 70), 1 - Math.pow(0.35, dt));
    this.y = lerp(this.y, hover, 1 - Math.pow(0.02, dt));
    if (this.body) {
      this.body.x = this.x;
      this.body.y = this.y + d.h / 2;
    }

    this.updateOrbs(dt);
    this.updateRay(dt);
    this.updateRainMarks(dt);
    this.updatePillars(dt);
    this.ambient(dt);

    switch (this.state) {
      case 'idle':
        this.waitT -= dt;
        if (this.waitT <= 0) this.nextStep();
        break;
      case 'shot': this.updateShot(dt); break;
      case 'rain': this.updateRain(dt); break;
      case 'timestop': this.updateTimeStop(dt); break;
      case 'godray': if (!this.ray && this.stateT > 0.05) this.startRay(); break;
      case 'heal': this.updateHeal(dt); break;
    }
  }

  cinematicUpdate(dt) {
    this.bob += dt * 1.2;
    if (this.dead) {
      // the outro: the wings slow, the whole shape lifts and thins out
      this.deathT += dt;
      this.wing += dt * 0.9;
      this.y -= 15 * dt;
      this.x = lerp(this.x, VIEW_W / 2, 1 - Math.pow(0.4, dt));
      if (this.body) { this.body.x = this.x; this.body.y = this.y + this.def.h / 2; }
      return;
    }
    this.wing += dt * 2.2;
    this.y = this.def.hoverY + Math.sin(this.bob) * 7;
    if (this.body) { this.body.x = this.x; this.body.y = this.y + this.def.h / 2; this.body.anim += dt; }
    this.ambient(dt);
  }

  ambient(dt) {
    for (const f of this.feathers) {
      f.y += f.vy * dt;
      f.x += Math.sin(f.p + f.y * 0.03) * 8 * dt;
      if (f.y > VIEW_H + 6) { f.y = -6; f.x = rand(VIEW_W); }
    }
    // motes lifting off the body
    if (Math.random() < dt * 34) {
      spawnParticle({
        x: this.x + rand(-26, 26), y: this.y + rand(-20, 20),
        vx: rand(-10, 10), vy: rand(-22, 8), life: rand(0.6, 1.6),
        size: 1, color: Math.random() < 0.3 ? '#ffffff' : TINT.halo,
        gravity: -8, drag: 0.98, kind: 'shrink',
      });
    }
    // sparks shaken loose from the wing tips as they beat
    if (Math.random() < dt * 22) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const a = (side > 0 ? -0.66 : Math.PI + 0.66);
      spawnParticle({
        x: this.x + Math.cos(a) * 40, y: this.y - 11 + Math.sin(-0.66) * 34 + rand(-6, 6),
        vx: side * rand(10, 50), vy: rand(-6, 26), life: rand(0.35, 0.9),
        size: 1, color: TINT.gold, gravity: 22, drag: 0.96, kind: 'streak',
      });
    }
    // and a slow rain of down under it
    if (Math.random() < dt * 10) {
      spawnParticle({
        x: this.x + rand(-46, 46), y: this.y + rand(6, 22),
        vx: rand(-6, 6), vy: rand(10, 26), life: rand(1.0, 2.2),
        size: 1, color: TINT.wing, gravity: 4, drag: 0.99, kind: 'shrink',
      });
    }
  }

  // Where the string is: arrows and rays all leave from the bow, not the body.
  bowTip() {
    const p = this.game.player;
    const aim = this.state === 'rain' ? -Math.PI / 2
      : Math.atan2(p.cy - this.y, p.x - this.x);
    return { x: this.x + Math.cos(aim) * 24, y: this.y + Math.sin(aim) * 24 };
  }

  // --- shot --------------------------------------------------------------

  updateShot(dt) {
    const cfg = this.def.shot;
    this.shotT -= dt;
    if (this.shotT <= 0 && this.shots < cfg.arrows) {
      this.shots++;
      this.shotT = cfg.spacing;
      this.fireArrow();
    }
    if (this.shots >= cfg.arrows && this.shotT <= -0.2) this.nextStep();
  }

  fireArrow() {
    const cfg = this.def.shot;
    const o = this.bowTip();
    const p = this.game.player;
    const a = Math.atan2((p.y - p.h / 2) - o.y, p.x - o.x) + rand(-0.045, 0.045);
    this.game.projectiles.push(new Projectile({
      x: o.x, y: o.y, vx: Math.cos(a) * cfg.speed, vy: Math.sin(a) * cfg.speed,
      damage: cfg.damage, team: 'enemy', kind: 'godarrow', life: 4, game: this.game,
    }));
    Sfx.bow();
    Camera.add(3.2);
    Camera.punch(0.5);
    burst(o.x, o.y, 16, {
      color: TINT.gold, color2: '#ffffff', kind: 'streak', speedMin: 120, speedMax: 380,
      lifeMin: 0.07, lifeMax: 0.22, gravity: 0, angle: a, spread: 0.45, drag: 0.82,
    });
    burst(o.x, o.y, 8, {
      color: '#ffffff', color2: TINT.ray, speedMin: 30, speedMax: 140,
      lifeMin: 0.1, lifeMax: 0.3, gravity: 0, kind: 'shrink',
    });
    // a flat ring squashed along the shot, so the release reads as a snap
    impactRing(o.x, o.y, { color: '#ffffff', r0: 2, r1: 30, life: 0.2, width: 2 });
    impactRing(o.x, o.y, { color: TINT.gold, r0: 2, r1: 52, life: 0.34, width: 1.5 });
    this.recoil = 1;
  }

  // --- arrow rain --------------------------------------------------------

  updateRain(dt) {
    const cfg = this.def.arrowRain;
    if (!this.rainFired && this.stateT >= cfg.windUp) {
      this.rainFired = true;
      this.fireRain();
    }
    if (this.rainFired && this.stateT > cfg.windUp + 0.5) this.nextStep();
  }

  fireRain() {
    const cfg = this.def.arrowRain;
    const o = this.bowTip();
    Sfx.wave();
    Camera.add(13);
    Camera.punch(1.8);
    this.game.hitstop(0.05);
    // the whole sky lights up as the volley leaves
    impactRing(o.x, o.y, { color: '#ffffff', r0: 4, r1: 150, life: 0.45, width: 4 });
    impactRing(o.x, o.y, { color: TINT.gold, r0: 4, r1: 240, life: 0.75, width: 2.5 });
    for (let i = 0; i < 26; i++) {
      const a = -Math.PI / 2 + rand(-0.9, 0.9);
      spawnParticle({
        x: o.x, y: o.y, vx: Math.cos(a) * rand(120, 420), vy: Math.sin(a) * rand(160, 520),
        life: rand(0.2, 0.6), size: 1, color: i % 3 === 0 ? '#ffffff' : TINT.gold,
        gravity: 260, drag: 0.9, kind: 'streak',
      });
    }
    for (let i = 0; i < cfg.count; i++) {
      // straight up, fanned just enough that they come down spread across the room
      const vx = ((i / (cfg.count - 1)) - 0.5) * 2 * cfg.spread + rand(-14, 14);
      this.game.projectiles.push(new Projectile({
        x: o.x + rand(-6, 6), y: o.y,
        vx, vy: -cfg.speed * rand(0.94, 1.06),
        gravity: cfg.gravity, damage: this.def.shot.damage,
        team: 'enemy', kind: 'godarrow', life: 8, keepTop: true, game: this.game,
      }));
    }
    burst(o.x, o.y, 22, {
      color: TINT.gold, color2: '#ffffff', speedMin: 60, speedMax: 220,
      lifeMin: 0.2, lifeMax: 0.6, gravity: 120, angle: -Math.PI / 2, spread: 0.9,
    });
  }

  updatePillars(dt) {
    for (let i = this.pillars.length - 1; i >= 0; i--) {
      const p = this.pillars[i];
      p.t += dt;
      if (p.t > 0.9) this.pillars.splice(i, 1);
    }
    if (this.sweep >= 0) {
      this.sweep += dt;
      if (this.sweep > 1.4) this.sweep = -1;
    }
  }

  drawPillars(ctx) {
    for (const p of this.pillars) {
      const k = clamp(1 - p.t / 0.9, 0, 1);
      const w = 3 + k * 9;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(0, 0, 0, p.y);
      g.addColorStop(0, rgba('#a98cff', 0));
      g.addColorStop(1, rgba('#ffffff', 0.5 * k));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - w / 2, 0, w, p.y);
      ctx.restore();
      glowDot(ctx, p.x, p.y, 14 + k * 22, '#a98cff', k * 0.5);
    }
    // the clock hand: one sweep of the room the instant time stops
    if (this.sweep >= 0) {
      const k = clamp(this.sweep / 1.4, 0, 1);
      const a = -Math.PI / 2 + k * TAU;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(this.x, this.y,
        this.x + Math.cos(a) * 300, this.y + Math.sin(a) * 300);
      g.addColorStop(0, rgba('#ffffff', 0.5 * (1 - k)));
      g.addColorStop(1, rgba(TINT.gold, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + Math.cos(a) * 300, this.y + Math.sin(a) * 300);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Sights on the floor under anything falling from above the screen.
  updateRainMarks(dt) {
    this.rainMarks.length = 0;
    for (const pr of this.game.projectiles) {
      if (pr.kind !== 'godarrow' || !pr.keepTop || pr.dead) continue;
      if (pr.y > 0 || pr.vy <= 0) continue;
      this.rainMarks.push(pr.x + pr.vx * 0.35);
    }
  }

  // --- time stop ---------------------------------------------------------

  updateTimeStop(dt) {
    const cfg = this.def.timeStop;
    if (!this.tsFired && this.stateT >= cfg.windUp) {
      this.tsFired = true;
      this.game.beginTimeStop(cfg.duration);
      Sfx.zap();
      Camera.add(16);
      Camera.punch(3.2);
      this.game.hitstop(0.12);
      this.sweep = 0;                       // the clock hand that sweeps the room
      // three rings leaving the god, then the whole room stops
      impactRing(this.x, this.y, { color: '#ffffff', r0: 8, r1: 300, life: 0.7, width: 5 });
      impactRing(this.x, this.y, { color: TINT.gold, r0: 4, r1: 420, life: 1.0, width: 3 });
      impactRing(this.x, this.y, { color: TINT.ray, r0: 2, r1: 190, life: 0.45, width: 2 });
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU;
        spawnParticle({
          x: this.x + Math.cos(a) * 14, y: this.y + Math.sin(a) * 14,
          vx: Math.cos(a) * rand(180, 460), vy: Math.sin(a) * rand(180, 460),
          life: rand(0.2, 0.5), size: 1, color: i % 4 === 0 ? TINT.gold : '#ffffff',
          gravity: 0, drag: 0.86, kind: 'streak',
        });
      }
      const room = Math.max(0, cfg.maxShardlings - this.shardlingsSpawned);
      const n = Math.min(cfg.spawn, room);
      for (let i = 0; i < n; i++) {
        const sx = clamp(this.x + (i - (n - 1) / 2) * 54 + rand(-10, 10), 30, VIEW_W - 30);
        const e = new Enemy('aetherShardling', sx, this.y + rand(-14, 26), this.game);
        e.spawnT = 0.45;
        this.game.enemies.push(e);
        this.shardlingsSpawned++;
        // each one arrives down a pillar of light
        this.pillars.push({ x: sx, y: e.y, t: 0 });
        impactRing(sx, e.y, { color: '#ffffff', r0: 3, r1: 44, life: 0.5, width: 2 });
        impactRing(sx, e.y, { color: '#a98cff', r0: 2, r1: 66, life: 0.7, width: 1.5 });
        burst(sx, e.y, 18, {
          color: '#a98cff', color2: '#ffffff', speedMin: 30, speedMax: 170,
          lifeMin: 0.2, lifeMax: 0.6, gravity: 0, drag: 0.9, kind: 'shrink',
        });
      }
    }
    if (this.tsFired && this.stateT >= cfg.windUp + cfg.duration + 0.15) this.nextStep();
  }

  // --- healing -----------------------------------------------------------

  updateHeal(dt) {
    const cfg = this.def.healing;
    if (!this.healFired && this.stateT >= cfg.windUp) {
      this.healFired = true;
      Sfx.pickup();
      Camera.add(7);
      impactRing(this.x, this.y, { color: TINT.orb, r0: 6, r1: 210, life: 0.7, width: 3 });
      for (const e of this.game.enemies) {
        if (e.type !== 'aetherShardling' || e.dead) continue;
        this.orbs.push({ x: e.cx, y: e.cy, vx: rand(-40, 40), vy: rand(-60, -20), t: 0, trail: [] });
        burst(e.cx, e.cy, 26, {
          color: TINT.orb, color2: '#ffffff', speedMin: 30, speedMax: 190,
          lifeMin: 0.2, lifeMax: 0.7, gravity: 0, drag: 0.9, kind: 'shrink',
        });
        burst(e.cx, e.cy, 10, {
          color: '#ffffff', color2: TINT.orb, kind: 'streak', speedMin: 90, speedMax: 260,
          lifeMin: 0.08, lifeMax: 0.22, gravity: 0, drag: 0.85,
        });
        impactRing(e.cx, e.cy, { color: TINT.orb, r0: 2, r1: 40, life: 0.4, width: 2 });
        e.dead = true;                    // it is unmade, not killed
      }
    }
    if (this.healFired && (this.orbs.length === 0 || this.stateT > cfg.windUp + 4)) this.nextStep();
  }

  updateOrbs(dt) {
    const cfg = this.def.healing;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.t += dt;
      const a = Math.atan2(this.y - o.y, this.x - o.x);
      o.vx = lerp(o.vx, Math.cos(a) * cfg.orbSpeed, 1 - Math.pow(0.01, dt));
      o.vy = lerp(o.vy, Math.sin(a) * cfg.orbSpeed, 1 - Math.pow(0.01, dt));
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      (o.trail ??= []).push([o.x, o.y]);
      if (o.trail.length > 14) o.trail.shift();
      if (Math.random() < dt * 40) {
        spawnParticle({
          x: o.x + rand(-3, 3), y: o.y + rand(-3, 3), vx: rand(-14, 14), vy: rand(-14, 14),
          life: rand(0.2, 0.45), size: 1, color: TINT.orb, gravity: 0, kind: 'shrink',
        });
      }
      // a shot can burst an orb before it lands
      let popped = false;
      for (const pr of this.game.projectiles) {
        if (pr.dead || pr.team !== 'player' || pr.spent) continue;
        if (dist(pr.x, pr.y, o.x, o.y) < 8) { popped = true; break; }
      }
      if (popped) {
        this.orbs.splice(i, 1);
        Sfx.hit();
        burst(o.x, o.y, 12, {
          color: TINT.orb, color2: '#ffffff', speedMin: 40, speedMax: 160,
          lifeMin: 0.15, lifeMax: 0.4, gravity: 120,
        });
        continue;
      }
      if (dist(o.x, o.y, this.x, this.y) < 16) {
        this.orbs.splice(i, 1);
        this.heal(cfg.perOrb);
        Sfx.pickup();
        Camera.add(3);
        impactRing(this.x, this.y, { color: TINT.orb, r0: 4, r1: 54, life: 0.35, width: 2.5 });
        impactRing(this.x, this.y, { color: '#ffffff', r0: 2, r1: 26, life: 0.2, width: 1.5 });
        burst(this.x, this.y, 16, {
          color: TINT.orb, color2: '#ffffff', speedMin: 40, speedMax: 170,
          lifeMin: 0.15, lifeMax: 0.5, gravity: 0, drag: 0.88, kind: 'shrink',
        });
      }
    }
  }

  // --- god rays ----------------------------------------------------------

  startRay() {
    const cfg = this.def.godRay;
    const o = this.bowTip();
    this.ray = {
      charge: cfg.windUp, t: 0, dur: cfg.duration,
      angle: 0, ox: o.x, oy: o.y, ex: o.x, ey: o.y, len: 0,
      nextWave: 0, waves: [],
    };
    this.rayFired = true;
    Sfx.zap();
  }

  // Called the frame the beam actually opens.
  rayOpened() {
    const b = this.ray;
    Sfx.slam();
    Camera.add(11);
    Camera.punch(2.0);
    this.game.hitstop(0.05);
    impactRing(b.ox, b.oy, { color: '#ffffff', r0: 3, r1: 120, life: 0.35, width: 4 });
    impactRing(b.ox, b.oy, { color: TINT.gold, r0: 3, r1: 190, life: 0.6, width: 2.5 });
    burst(b.ox, b.oy, 24, {
      color: '#ffffff', color2: TINT.gold, kind: 'streak', speedMin: 140, speedMax: 420,
      lifeMin: 0.08, lifeMax: 0.24, gravity: 0, angle: b.angle, spread: 0.7, drag: 0.84,
    });
  }

  updateRay(dt) {
    const cfg = this.def.godRay;
    const b = this.ray;
    if (!b) return;
    const p = this.game.player;
    const o = this.bowTip();
    b.ox = o.x; b.oy = o.y;
    const want = Math.atan2((p.y - p.h / 2) - o.y, p.x - o.x);
    b.angle = b.charge > 0 ? want : b.angle + shortAngle(b.angle, want) * clamp(dt / cfg.lag, 0, 1);
    b.len = 900;
    b.ex = o.x + Math.cos(b.angle) * b.len;
    b.ey = o.y + Math.sin(b.angle) * b.len;

    if (b.charge > 0) {
      const was = b.charge;
      b.charge -= dt;
      if (was > 0 && b.charge <= 0) this.rayOpened();
      if (Math.random() < dt * 50) {
        const a = rand(0, TAU);
        spawnParticle({
          x: o.x + Math.cos(a) * 26, y: o.y + Math.sin(a) * 26,
          vx: -Math.cos(a) * 80, vy: -Math.sin(a) * 80, life: 0.3,
          size: 1, color: TINT.ray, gravity: 0, kind: 'shrink',
        });
      }
      return;
    }

    b.t += dt;
    if (!p.dead && distToSegment(p.x, p.y - p.h / 2, b.ox, b.oy, b.ex, b.ey) < cfg.width / 2 + 4) {
      p.hurt(Math.round(cfg.damage * this.dmgScale), b.ox);
    }
    if (Math.random() < dt * 60) {
      const k = Math.random();
      spawnParticle({
        x: lerp(b.ox, b.ex, k * 0.35), y: lerp(b.oy, b.ey, k * 0.35),
        vx: rand(-50, 50), vy: rand(-50, 50), life: rand(0.1, 0.3),
        size: 1, color: TINT.ray, gravity: 0, kind: 'line',
      });
    }

    // shock waves peeling off the beam, out to ten blocks either side
    b.nextWave -= dt;
    if (b.nextWave <= 0 && b.t < b.dur) {
      b.nextWave = cfg.waveEvery;
      b.waves.push({ r: 0 });
      Sfx.slam();
      Camera.add(7);
      Camera.punch(0.9);
      impactRing(b.ox, b.oy, { color: TINT.ray, r0: 2, r1: 70, life: 0.3, width: 2 });
      const nx0 = -Math.sin(b.angle), ny0 = Math.cos(b.angle);
      for (let i = 0; i < 14; i++) {
        const side = i % 2 ? 1 : -1;
        const along = rand(20, 200);
        spawnParticle({
          x: b.ox + Math.cos(b.angle) * along, y: b.oy + Math.sin(b.angle) * along,
          vx: nx0 * side * rand(120, 320), vy: ny0 * side * rand(120, 320),
          life: rand(0.15, 0.4), size: 1, color: i % 3 === 0 ? '#ffffff' : TINT.ray,
          gravity: 0, drag: 0.9, kind: 'streak',
        });
      }
    }
    for (let i = b.waves.length - 1; i >= 0; i--) {
      const w = b.waves[i];
      w.r += cfg.waveSpeed * dt;
      if (w.r > cfg.waveRange) { b.waves.splice(i, 1); continue; }
      if (p.dead) continue;
      const px = p.x, py = p.y - p.h / 2;
      const perp = distToSegment(px, py, b.ox, b.oy, b.ex, b.ey);
      const along = (px - b.ox) * Math.cos(b.angle) + (py - b.oy) * Math.sin(b.angle);
      if (along > 0 && Math.abs(perp - w.r) < 8) {
        p.hurt(Math.round(cfg.waveDamage * this.dmgScale), b.ox);
      }
    }

    if (b.t >= b.dur && b.waves.length === 0) {
      this.ray = null;
      if (this.state === 'godray') this.nextStep();
    } else if (b.t >= b.dur + 1.2) {
      this.ray = null;
      if (this.state === 'godray') this.nextStep();
    }
  }

  // --- art ---------------------------------------------------------------

  // Drawn under everything else: the cathedral it fights inside.
  drawBackdrop(ctx) {
    const t = this.body ? this.body.anim : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.1);
    const charge = this.state === 'godray' || this.state === 'timestop' ? 1 : 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 1. the whole room washes gold, brighter while it is winding something up
    const wash = ctx.createRadialGradient(this.x, this.y, 10, this.x, this.y, 260);
    wash.addColorStop(0, rgba(TINT.halo, 0.16 + charge * 0.10 + pulse * 0.03));
    wash.addColorStop(0.5, rgba(TINT.gold, 0.05 + charge * 0.04));
    wash.addColorStop(1, rgba(TINT.gold, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, VIEW_W, GROUND_Y + 8);

    // 2. a column of light falling from the ceiling onto the floor
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, rgba(TINT.halo, 0.20));
    g.addColorStop(1, rgba(TINT.halo, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(this.x - 26, 0);
    ctx.lineTo(this.x + 26, 0);
    ctx.lineTo(this.x + 110, GROUND_Y);
    ctx.lineTo(this.x - 110, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    // and the pool it makes where it lands
    const pool = ctx.createLinearGradient(0, GROUND_Y - 26, 0, GROUND_Y);
    pool.addColorStop(0, rgba(TINT.halo, 0));
    pool.addColorStop(1, rgba(TINT.halo, 0.16 + pulse * 0.05));
    ctx.fillStyle = pool;
    ctx.fillRect(this.x - 108, GROUND_Y - 26, 216, 26);

    // 3. two counter-rotating fans of rays behind it
    for (let i = 0; i < 14; i++) {
      const a = t * 0.16 + (i / 14) * TAU;
      ctx.strokeStyle = rgba(TINT.halo, 0.055 + 0.035 * Math.sin(t * 1.4 + i));
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + Math.cos(a) * 240, this.y + Math.sin(a) * 240);
      ctx.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const a = -t * 0.27 + (i / 9) * TAU;
      ctx.strokeStyle = rgba('#ffffff', 0.028 + 0.022 * Math.sin(t * 2.1 - i));
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + Math.cos(a) * 190, this.y + Math.sin(a) * 190);
      ctx.stroke();
    }

    // 4. three haloes of scripture turning at their own speeds behind it
    const rings = [[52, 0.42, 24], [76, -0.29, 32], [104, 0.19, 40]];
    for (let r = 0; r < rings.length; r++) {
      const [rad, spin, n] = rings[r];
      const wob = rad + Math.sin(t * 0.9 + r) * 3;
      ctx.strokeStyle = rgba(TINT.gold, 0.10 + 0.05 * Math.sin(t * 1.3 + r * 2));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(this.x, this.y, wob, wob * 0.94, 0, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < n; i++) {
        const a = t * spin + (i / n) * TAU;
        const on = (i + r) % 3 === 0;
        const px = this.x + Math.cos(a) * wob;
        const py = this.y + Math.sin(a) * wob * 0.94;
        pxRect(ctx, px - 1, py - 1, on ? 2 : 1, on ? 2 : 1,
               rgba(on ? '#ffffff' : TINT.gold, 0.22 + 0.3 * Math.sin(t * 3 + i)));
      }
    }
    ctx.restore();

    // 5. feathers drifting the length of the room, each one turning as it falls
    for (const f of this.feathers) {
      const a = 0.18 + 0.16 * Math.sin(f.p + f.y * 0.05);
      const h = Math.max(1, Math.round(f.s * 2));
      const sway = Math.sin(f.p + f.y * 0.04) * 2;
      pxRect(ctx, f.x + sway, f.y, 1, h, rgba(TINT.wing, a));
      pxRect(ctx, f.x + sway, f.y + h, 1, 1, rgba(TINT.gold, a * 0.6));
    }
  }

  // A real wing, not a starburst: an arm bone sweeping out and up from the
  // shoulder, with primaries hanging along it - long at the tip, short and
  // steep near the body. Everything is built in a right-facing frame and
  // mirrored, so both sides fold identically.
  drawWing(ctx, side, big) {
    const flap = Math.sin(this.wing + (big ? 0 : 0.55)) * (big ? 0.17 : 0.24);
    const sx = this.x + side * (this.def.w / 2 - 3);
    const sy = this.y + (big ? -11 : 11);
    const mirror = (a) => (side > 0 ? a : Math.PI - a);

    const boneA = (big ? -0.66 : -0.16) - flap * 0.5;
    const boneLen = big ? 34 : 19;
    const bx = sx + Math.cos(mirror(boneA)) * boneLen;
    const by = sy + Math.sin(boneA) * boneLen;

    const n = big ? 10 : 6;
    // outer primaries first so the coverts nearer the body layer on top
    for (let i = n - 1; i >= 0; i--) {
      const k = n === 1 ? 1 : i / (n - 1);          // 0 at shoulder, 1 at tip
      const px = lerp(sx, bx, k);
      const py = lerp(sy, by, k);
      // near the tip the feather carries on outward; near the body it drops
      const a = lerp(1.15, boneA + 0.30, Math.pow(k, 0.8)) + flap * (0.35 + k * 0.5);
      const len = (big ? lerp(11, 34, Math.pow(k, 0.65)) : lerp(7, 20, Math.pow(k, 0.65)));
      const wdt = big ? lerp(3, 6, k) : lerp(2, 4, k);
      const col = k > 0.72 ? TINT.wing : k > 0.34 ? TINT.wingShade : TINT.wingDeep;
      limb(ctx, px, py, mirror(a), len, wdt, col, big ? 2.5 : 2);
      // a bright tip on every third primary keeps the fan readable
      if (i % 3 === 0) {
        pxRect(ctx, px + Math.cos(mirror(a)) * len - 1, py + Math.sin(a) * len - 1,
               2, 2, rgba('#ffffff', 0.8));
      }
    }
    // the leading edge, drawn last so it caps the fan
    limb(ctx, sx, sy, mirror(boneA), boneLen, big ? 5 : 4, TINT.wing, big ? 2.5 : 2);
    limb(ctx, sx, sy - 1, mirror(boneA), boneLen * 0.85, 2, '#ffffff', 1);
    pxRect(ctx, sx - 3, sy - 3, 6, 6, TINT.wingShade);
    glowDot(ctx, sx, sy, big ? 22 : 14, TINT.halo, 0.16);
  }

  draw(ctx) {
    // While the outro runs it is still here, fading upward.
    let dying = 0;
    if (this.dead) {
      dying = clamp(this.deathT / 3.0, 0, 1);
      if (dying >= 1) return;
    }
    const t = this.body ? this.body.anim : 0;
    const flash = this.body && this.body.hurtFlash > 0;
    const d = this.def;
    const x = Math.round(this.x);
    const y = Math.round(this.y);
    const f = this.facing;

    ctx.save();
    if (dying > 0) ctx.globalAlpha = 1 - dying;

    this.drawBackdrop(ctx);

    // wings behind the body: one big above, one small below, each side
    this.drawWing(ctx, -1, true);
    this.drawWing(ctx, 1, true);
    this.drawWing(ctx, -1, false);
    this.drawWing(ctx, 1, false);

    // halo
    const hy = y - d.h / 2 - 12;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(TINT.halo, 0.75 + 0.2 * Math.sin(t * 3));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, hy, 17, 5, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
    glowDot(ctx, x, hy, 26, TINT.halo, 0.3);

    // the body: a censor bar, and nothing else
    const w = d.w, h = d.h;
    glowDot(ctx, x, y, 46, TINT.halo, 0.18);
    pxRect(ctx, x - w / 2 - 1, y - h / 2 - 1, w + 2, h + 2, flash ? '#ffffff' : TINT.censorEdge);
    pxRect(ctx, x - w / 2, y - h / 2, w, h, flash ? '#ffffff' : TINT.censor);
    if (!flash) {
      // the black is not flat: something moves under it
      for (let i = 0; i < 5; i++) {
        const ly = y - h / 2 + 4 + ((t * 9 + i * 9) % (h - 6));
        pxRect(ctx, x - w / 2 + 2, ly, w - 4, 1, rgba('#3a3550', 0.35 + 0.2 * Math.sin(t * 5 + i)));
      }
      pxRect(ctx, x - w / 2, y - h / 2, w, 1, rgba(TINT.halo, 0.35));
      pxRect(ctx, x - w / 2, y + h / 2 - 1, w, 1, rgba(TINT.halo, 0.2));
    }

    // the bow: held out at arm's length and aimed where the next shot goes
    const drawing = this.state === 'shot' || this.state === 'rain' || (this.ray && this.ray.charge > 0);
    const aim = this.state === 'rain'
      ? -Math.PI / 2
      : Math.atan2((this.game.player.cy) - y, this.game.player.x - x);
    const bx = x + Math.cos(aim) * 21;
    const by = y + Math.sin(aim) * 21;
    // arm reaching for it, drawn under the bow
    limb(ctx, x + f * (w / 2 - 3), y + 3, aim, dist(x, y, bx, by) - 2, 4, TINT.censorEdge);

    const pull = drawing ? 5 + Math.sin(t * 18) : 1.5;
    ctx.save();
    ctx.translate(Math.round(bx), Math.round(by));
    ctx.rotate(aim);
    ctx.strokeStyle = TINT.gold;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 15, -2.05, 2.05);
    ctx.stroke();
    ctx.strokeStyle = rgba(TINT.goldDeep, 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 13, -2.05, 2.05);
    ctx.stroke();
    // the string, pulled back while it draws
    ctx.strokeStyle = rgba('#fff6d8', 0.85);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(-2.05) * 15, Math.sin(-2.05) * 15);
    ctx.lineTo(-pull, 0);
    ctx.lineTo(Math.cos(2.05) * 15, Math.sin(2.05) * 15);
    ctx.stroke();
    if (drawing) {
      ctx.globalCompositeOperation = 'lighter';
      pxRect(ctx, -pull, -1, 15, 2, TINT.ray);
      pxRect(ctx, 8, -2, 5, 4, '#ffffff');
      glowDot(ctx, 0, 0, 18, TINT.gold, 0.45);
    }
    ctx.restore();

    this.drawRay(ctx);
    this.drawOrbs(ctx);
    this.drawRainMarks(ctx);
    this.drawPillars(ctx);
    ctx.restore();
  }

  drawRainMarks(ctx) {
    const t = this.body ? this.body.anim : 0;
    for (const mx of this.rainMarks) {
      const x = clamp(mx, 4, VIEW_W - 4);
      const beat = 0.7 + 0.3 * Math.sin(t * 14 + x);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(0, GROUND_Y - 64, 0, GROUND_Y);
      g.addColorStop(0, rgba(TINT.gold, 0));
      g.addColorStop(1, rgba(TINT.gold, 0.34 * beat));
      ctx.fillStyle = g;
      ctx.fillRect(x - 4, GROUND_Y - 64, 8, 64);
      // a target ring on the floor that tightens as it comes in
      ctx.strokeStyle = rgba('#ffffff', 0.4 * beat);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, GROUND_Y - 1, 8 + beat * 4, 3 + beat * 1.5, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
      pxRect(ctx, x - 5, GROUND_Y - 1, 10, 1, rgba(TINT.gold, 0.85 * beat));
      pxRect(ctx, x - 1, GROUND_Y - 4, 2, 3, rgba('#ffffff', 0.5 * beat));
    }
  }

  drawOrbs(ctx) {
    for (const o of this.orbs) {
      if (o.trail && o.trail.length > 1) {
        ribbon(ctx, o.trail, TINT.orb, 3.5, 0.55);
        ribbon(ctx, o.trail.slice(-6), '#ffffff', 1.6, 0.5);
      }
      glowDot(ctx, o.x, o.y, 18, TINT.orb, 0.55);
      glowDot(ctx, o.x, o.y, 7, '#ffffff', 0.7);
      pxRect(ctx, o.x - 2, o.y - 2, 4, 4, TINT.orb);
      pxRect(ctx, o.x - 1, o.y - 1, 2, 2, '#ffffff');
    }
  }

  drawRay(ctx) {
    const b = this.ray;
    if (!b) return;
    const cfg = this.def.godRay;
    if (b.charge > 0) {
      const k = 1 - b.charge / cfg.windUp;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // the sight line, tightening as it locks on
      ctx.strokeStyle = rgba(TINT.gold, 0.2 + 0.5 * k);
      ctx.lineWidth = 1 + k;
      ctx.setLineDash([3, 5 - k * 3]);
      ctx.beginPath();
      ctx.moveTo(b.ox, b.oy);
      ctx.lineTo(b.ex, b.ey);
      ctx.stroke();
      ctx.setLineDash([]);
      // chevrons running down the line into the muzzle
      const nx = -Math.sin(b.angle), ny = Math.cos(b.angle);
      for (let i = 0; i < 5; i++) {
        const d = ((1 - ((k * 1.6 + i * 0.2) % 1)) * 130) + 12;
        const cx = b.ox + Math.cos(b.angle) * d, cy = b.oy + Math.sin(b.angle) * d;
        const w = 4 + (d / 130) * 12;
        ctx.strokeStyle = rgba('#ffffff', (1 - d / 150) * 0.55);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx + nx * w, cy + ny * w);
        ctx.lineTo(cx + Math.cos(b.angle) * 7, cy + Math.sin(b.angle) * 7);
        ctx.lineTo(cx - nx * w, cy - ny * w);
        ctx.stroke();
      }
      // the muzzle itself winding up
      ctx.strokeStyle = rgba('#ffffff', 0.25 + k * 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(b.ox, b.oy, 26 - k * 20, 0, TAU);
      ctx.stroke();
      ctx.restore();
      glowDot(ctx, b.ox, b.oy, 10 + k * 34, TINT.ray, 0.35 + k * 0.6);
      return;
    }
    const fade = clamp(Math.min(b.t * 9, (b.dur - b.t) * 9), 0, 1);
    const w = cfg.width * fade;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const layers = [[w * 7, 0.10, TINT.gold], [w * 3.4, 0.26, TINT.gold],
                    [w * 1.6, 0.55, TINT.ray], [w * 0.7, 0.95, '#ffffff']];
    for (const [lw, la, col] of layers) {
      ctx.strokeStyle = rgba(col, la * fade);
      ctx.lineWidth = Math.max(1, lw);
      ctx.beginPath();
      ctx.moveTo(b.ox, b.oy);
      ctx.lineTo(b.ex, b.ey);
      ctx.stroke();
    }
    // the shock waves: a pair of rails sliding out to either side of the beam,
    // bounded so they read as a wave and not as two stray lines
    const nx = -Math.sin(b.angle), ny = Math.cos(b.angle);
    const railLen = 260;
    for (const wv of b.waves) {
      const a = clamp(1 - wv.r / cfg.waveRange, 0, 1);
      for (const s of [-1, 1]) {
        const sx = b.ox + nx * wv.r * s, sy = b.oy + ny * wv.r * s;
        const ex = sx + Math.cos(b.angle) * railLen, ey = sy + Math.sin(b.angle) * railLen;
        const g = ctx.createLinearGradient(sx, sy, ex, ey);
        g.addColorStop(0, rgba('#ffffff', a * 0.95));
        g.addColorStop(0.55, rgba(TINT.ray, a * 0.5));
        g.addColorStop(1, rgba(TINT.gold, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = 3 * a + 1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        glowDot(ctx, sx, sy, 14 * a + 4, TINT.ray, a * 0.4);
      }
    }
    ctx.restore();
    glowDot(ctx, b.ox, b.oy, 40, TINT.ray, 0.65 * fade);
    glowDot(ctx, b.ox, b.oy, 16, '#ffffff', 0.85 * fade);
    // where the beam meets the floor it burns a pool of light
    if (Math.abs(Math.sin(b.angle)) > 0.05) {
      const tHit = (GROUND_Y - b.oy) / Math.sin(b.angle);
      if (tHit > 0) {
        const hx = b.ox + Math.cos(b.angle) * tHit;
        if (hx > -40 && hx < VIEW_W + 40) {
          const flick = 0.75 + 0.25 * Math.sin(b.t * 40);
          glowDot(ctx, hx, GROUND_Y, 34 * fade * flick, TINT.gold, 0.55 * fade);
          glowDot(ctx, hx, GROUND_Y, 14 * fade, '#ffffff', 0.8 * fade);
          if (Math.random() < 0.6) {
            spawnParticle({
              x: hx + rand(-4, 4), y: GROUND_Y, vx: rand(-90, 90), vy: rand(-190, -60),
              life: rand(0.2, 0.6), size: 1, color: Math.random() < 0.4 ? '#ffffff' : TINT.gold,
              gravity: 420, drag: 0.92, kind: 'streak',
            });
          }
        }
      }
    }
  }
}
