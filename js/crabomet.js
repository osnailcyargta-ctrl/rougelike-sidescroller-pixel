// Crab-omet: the thing that came down with the comet, and is still on fire.
//
// It is a crab the size of a car with a burning crust for a shell. Three
// things it does, in one order, forever: drive both claws through you, throw
// itself off the top of the screen and come back down where you are standing,
// and fold itself into a ball that starts rolling slowly and does not stay
// slow.
import { clamp, lerp, rand, sign, dist, distToSegment, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import {
  Camera, burst, spawnParticle, impactRing, limb, limbInk, pxRect, pxSolid,
  glowDot, glowEye, screenFlash,
} from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, GROUND_Y, BOSS_TYPES } from './config.js';
import { Enemy } from './entities.js';

// One step darker, for the underside of the shell.
const shade = (hex) => hex === '#ffffff' ? '#cccccc' : hex === '#a8543a' ? '#6f3524' : '#54291a';

const TINT = {
  shell: '#7b3f2a',        // the crust, cooled on the outside
  shellLit: '#c47a4e',
  seam: '#ff8a3c',         // and still glowing along every crack
  seamHot: '#ffe6a8',
  claw: '#a8543a',
  clawLit: '#e0a173',
  ink: '#1b0d09',
  eye: '#8cf0ff',          // whatever is inside it is not from here
};

// The part that takes the hits. Everything forwards to the boss, so the shell
// and the ball are the same health bar.
class CrabPart extends Enemy {
  constructor(x, y, game, boss) {
    super('crabometBody', x, y, game);
    this.boss = boss;
    this.spawnT = 0;
    this.isBoss = true;
    this.dmg = Math.round(this.def.damage * boss.dmgScale);
    this.maxHp = boss.maxHp;
    this.hp = boss.hp;
  }
  applyRawDamage(amount) { this.boss.applyRawDamage(amount); }
  damage(amount, opts = {}) { super.damage(amount, { ...opts, knockback: 0, shake: opts.shake ?? 1 }); }
  kill() { this.boss.die(); }
  drawHpBar() {}
  draw() {}                 // the boss paints itself, above the enemy layer
  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.maxHp;
    this.updateStatus(dt);
  }
}

export class CrabometBoss {
  constructor(game, roomIndex) {
    const def = BOSS_TYPES.crabomet;
    this.game = game;
    this.def = def;
    this.name = def.name;
    this.title = def.title;
    this.kind = 'comet';
    this.roomIndex = roomIndex;

    // It is not on the rotation, so it does not scale with the tier it landed
    // in: it hits exactly as hard wherever it turns up.
    this.hpScale = 1;
    this.dmgScale = 1;
    this.maxHp = def.hp;
    this.hp = this.maxHp;
    this.phase = 1;
    this.phase2At = 0;
    this.dead = false;
    this.deathT = 0;
    this.intro = 0;

    this.x = VIEW_W / 2;
    this.y = GROUND_Y;            // the feet, like every walker
    this.vx = 0;
    this.vy = 0;
    this.facing = -1;
    this.walk = 0;                // leg cycle
    this.curl = 0;                // 0 crab, 1 ball
    this.spin = 0;                // how far the ball has rolled
    this.aloft = false;           // off the top of the screen, do not draw
    this.rollDir = 1;
    this.glow = 0;                // seam heat, pushed up by everything it does

    this.step = -1;               // which entry of def.steps is running
    this.state = 'idle';
    this.stateT = 0;
    this.waitT = 0.9;
    this.claws = [0, 0];          // extension of each claw, 0..1
    this.clawSide = 0;            // which one leads this stab
    this.hitThisMove = false;     // one hit per stab, per slam, per roll pass

    // The crust cracked when it landed and has not healed. Each seam is a few
    // points in shell space, so the same cracks ride the shell as it curls.
    this.cracks = [];
    for (let i = 0; i < 5; i++) {
      const a0 = rand(0, TAU);
      const pts = [];
      let a = a0, r = rand(0.15, 0.5);
      for (let k = 0; k < 4; k++) {
        pts.push({ a, r });
        a += rand(-0.5, 0.5);
        r = clamp(r + rand(0.12, 0.3), 0, 0.95);
      }
      this.cracks.push(pts);
    }

    this.spawnParts();
  }

  get parts() { return [this.body].filter(Boolean); }

  spawnParts() {
    this.body = new CrabPart(this.x, this.y - this.def.h / 2, this.game, this);
    this.game.enemies.push(this.body);
  }

  applyRawDamage(amount) {
    if (this.dead) return;
    this.hp -= amount;
    if (this.hp <= 0) this.die();
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deathT = 0;
    this.hp = 0;
    if (this.body) this.body.dead = true;
    Camera.add(18);
    this.game.hitstop(0.24);
    screenFlash(0.75, TINT.seamHot, 0.5);
    Sfx.die();
    // it goes the way it arrived: a lot of burning rock, all at once
    burst(this.x, this.y - 16, 60, {
      color: TINT.seam, color2: '#ffffff', speedMin: 50, speedMax: 300,
      lifeMin: 0.4, lifeMax: 1.5, sizeMax: 4, gravity: 420, drag: 0.94,
    });
    impactRing(this.x, this.y - 16, { color: TINT.seamHot, r0: 8, r1: 210, life: 0.9, width: 4 });
    this.game.onBossDefeated(this);
    this.game.onEnemyKilled(this.body);
  }

  // --- the pattern ---------------------------------------------------------
  // claw, wait 1s, claw, wait 0.3s, comet, wait 0.6s, roll, and round again.

  nextStep() {
    const steps = this.def.steps;
    this.step = (this.step + 1) % steps.length;
    const s = steps[this.step];
    this.stateT = 0;
    this.hitThisMove = false;
    if (s.move === 'claw') this.beginClaw();
    else if (s.move === 'comet') this.beginComet();
    else this.beginRoll();
  }

  // Between moves it closes the distance, sidling the way a crab does.
  rest() {
    const wait = this.def.steps[this.step]?.wait ?? 0.8;
    this.state = 'idle';
    this.stateT = 0;
    this.waitT = wait;
  }

  beginClaw() {
    this.state = 'claw';
    this.clawSide = this.clawSide === 0 ? 1 : 0;
    this.clawT = this.def.claw.windUp;
    this.phase2 = 'wind';
    Sfx.ui();
  }

  beginComet() {
    this.state = 'comet';
    this.phase2 = 'crouch';
    this.cometT = this.def.comet.windUp;
    this.aimX = this.game.player.x;
  }

  beginRoll() {
    this.state = 'roll';
    this.phase2 = 'curl';
    this.rollT = 0;
    this.rollSpeed = 0;
    this.rollDir = sign(this.game.player.x - this.x) || 1;
    this.bounces = 0;
  }

  // --- update --------------------------------------------------------------

  update(dt) {
    if (this.dead) return;
    const p = this.game.player;
    this.stateT += dt;
    this.walk += dt * (this.state === 'idle' ? 7 : 4);
    if (!this.aloft) this.facing = sign(p.x - this.x) || this.facing;

    // the crust cools between moves and flares while it is doing something
    const heat = this.state === 'comet' ? 1 : this.state === 'roll' ? 0.85 : 0.25;
    this.glow = lerp(this.glow, heat, 1 - Math.pow(0.04, dt));

    switch (this.state) {
      case 'idle': this.updateIdle(dt); break;
      case 'claw': this.updateClaw(dt); break;
      case 'comet': this.updateComet(dt); break;
      case 'roll': this.updateRoll(dt); break;
    }

    // It folds up for the flight as well as for the roll - that is what makes
    // the thing coming down at you a comet and not a crab falling over.
    const flying = this.state === 'comet' &&
      (this.phase2 === 'rise' || this.phase2 === 'aloft' || this.phase2 === 'fall');
    const wantCurl = this.state === 'roll' ? this.curlWanted() : flying ? 0.9 : 0;
    const k = 1 - Math.pow(this.state === 'roll' ? 0.02 : flying ? 0.0004 : 0.05, dt);
    this.curl = lerp(this.curl, wantCurl, k);
    // The stabbing claw is driven straight off the clock, not eased toward a
    // target: an eased one only ever reached two thirds of its reach inside a
    // stab that short, so the arm never went as far as the picture promised.
    for (const i of [0, 1]) {
      if (this.state === 'claw' && i === this.clawSide) this.claws[i] = this.clawDrive();
      else this.claws[i] = lerp(this.claws[i], 0, 1 - Math.pow(0.01, dt));
    }

    this.x = clamp(this.x, 26, VIEW_W - 26);
    if (this.body) {
      this.body.x = this.x;
      this.body.y = this.y - this.def.h / 2;
      // while it is off the top of the screen there is nothing to shoot
      this.body.untargetable = this.aloft;
    }
    this.ambient(dt);
  }

  curlWanted() {
    if (this.phase2 === 'curl') return clamp(this.stateT / this.def.roll.curl, 0, 1);
    if (this.phase2 === 'uncurl') return 1 - clamp(this.stateT / this.def.roll.uncurl, 0, 1);
    return 1;
  }

  // Where the stabbing claw is in its swing: cocked back, driven out, held
  // there, then pulled in.
  clawDrive() {
    const cfg = this.def.claw;
    if (this.phase2 === 'wind') {
      const k = clamp(1 - this.clawT / cfg.windUp, 0, 1);
      return -0.35 * k;                       // it draws back as it winds up
    }
    if (this.phase2 === 'stab') {
      const k = clamp(1 - this.clawT / cfg.stab, 0, 1);
      return lerp(-0.35, 1, 1 - Math.pow(1 - k, 2));
    }
    if (this.phase2 === 'hold') return 1;
    return clamp(this.clawT / cfg.recover, 0, 1);
  }

  updateIdle(dt) {
    const p = this.game.player;
    const gap = Math.abs(p.x - this.x);
    // it wants to be a claw's length away; closer than that and it sidles off
    const want = this.def.standOff + 18;
    const dir = gap > want + 10 ? sign(p.x - this.x) : gap < want - 14 ? -sign(p.x - this.x) : 0;
    this.x += dir * this.def.walkSpeed * dt;
    this.waitT -= dt;
    if (this.waitT <= 0) this.nextStep();
  }

  // --- both claws ----------------------------------------------------------

  updateClaw(dt) {
    const cfg = this.def.claw;
    this.clawT -= dt;
    if (this.phase2 === 'wind') {
      // it leans in over the wind-up so the stab starts from a set stance
      const p = this.game.player;
      this.x += sign(p.x - this.x) * this.def.walkSpeed * 0.55 * dt;
      if (Math.random() < dt * 26) this.sparkAt(this.clawTip(this.clawSide), 0.5);
      if (this.clawT <= 0) { this.phase2 = 'stab'; this.clawT = cfg.stab; this.stateT = 0; Sfx.hit(); }
      return;
    }
    if (this.phase2 === 'stab') {
      this.stabHit();
      if (this.clawT <= 0) { this.phase2 = 'hold'; this.clawT = cfg.hold; }
      return;
    }
    if (this.phase2 === 'hold') {
      this.stabHit();
      if (this.clawT <= 0) { this.phase2 = 'recover'; this.clawT = cfg.recover; }
      return;
    }
    if (this.clawT <= 0) this.rest();
  }

  // The whole arm is the attack, not just the point on the end of it. Testing
  // only the tip meant a claw driven clean through you missed, because at full
  // stretch the tip was already past your back.
  stabHit() {
    if (this.hitThisMove) return;
    const p = this.game.player;
    const tip = this.clawTip(this.clawSide);
    if (p.dead) return;
    if (distToSegment(p.x, p.cy, tip.sx, tip.sy, tip.x, tip.y) < 16) {
      p.hurt(Math.round(this.def.claw.damage * this.dmgScale), tip.x);
      this.hitThisMove = true;
      Camera.add(7);
      burst(tip.x, tip.y, 16, {
        color: TINT.seam, color2: '#ffffff', speedMin: 40, speedMax: 170,
        lifeMin: 0.15, lifeMax: 0.5, sizeMax: 3, gravity: 220,
      });
    }
  }

  // --- off the top of the screen, and back down on your head ---------------

  updateComet(dt) {
    const cfg = this.def.comet;
    const p = this.game.player;
    if (this.phase2 === 'crouch') {
      this.cometT -= dt;
      // it gathers itself, and the crust goes white before it goes
      if (Math.random() < dt * 40) this.sparkAt({ x: this.x + rand(-20, 20), y: this.y - 10 }, 1);
      if (this.cometT <= 0) {
        this.phase2 = 'rise';
        this.vy = -cfg.riseSpeed;
        Camera.add(9);
        Sfx.slam();
      }
      return;
    }
    if (this.phase2 === 'rise') {
      this.y += this.vy * dt;
      this.spin += dt * 7;
      this.trail(dt, 20);
      if (this.y < -70) {
        this.phase2 = 'aloft';
        this.aloft = true;
        this.stateT = 0;
      }
      return;
    }
    if (this.phase2 === 'aloft') {
      // It only looks up your position at the last moment, so running as it
      // leaves the screen buys you nothing.
      if (this.stateT > cfg.aloft - cfg.aim) this.aimX = p.x;
      this.x = lerp(this.x, clamp(this.aimX, 30, VIEW_W - 30), 1 - Math.pow(0.001, dt));
      if (this.stateT >= cfg.aloft) {
        this.phase2 = 'fall';
        this.aloft = false;
        this.y = -60;
        this.vy = cfg.fallSpeed;
      }
      return;
    }
    if (this.phase2 === 'fall') {
      this.y += this.vy * dt;
      this.spin += dt * 9;
      this.trail(dt, 46);
      if (this.y >= GROUND_Y) { this.y = GROUND_Y; this.impact(); }
      return;
    }
    if (this.phase2 === 'land') {
      if (this.stateT > 0.24) this.rest();
    }
  }

  impact() {
    const cfg = this.def.comet;
    this.phase2 = 'land';
    this.stateT = 0;
    this.vy = 0;
    Camera.add(20);
    this.game.hitstop(0.1);
    screenFlash(0.3, TINT.seamHot, 0.22);
    Sfx.slam();
    this.game.shockwaves.push({ x: this.x, y: GROUND_Y, t: 0, r: cfg.radius });
    burst(this.x, GROUND_Y, 46, {
      color: TINT.seam, color2: '#ffffff', speedMin: 70, speedMax: 300,
      lifeMin: 0.25, lifeMax: 0.8, sizeMax: 4, gravity: 520,
      angle: -Math.PI / 2, spread: 1.5,
    });
    impactRing(this.x, GROUND_Y, { color: TINT.seamHot, r0: 4, r1: cfg.radius * 2, life: 0.5, width: 3 });
    // It comes down on your head, so jumping is not a dodge - only being
    // somewhere else is. That is the whole point of the move.
    const p = this.game.player;
    if (!p.dead && Math.abs(p.x - this.x) < cfg.radius && p.cy > GROUND_Y - 90) {
      p.hurt(Math.round(cfg.damage * this.dmgScale), this.x);
    }
  }

  // --- the ball ------------------------------------------------------------

  updateRoll(dt) {
    const cfg = this.def.roll;
    if (this.phase2 === 'curl') {
      // it stops dead to fold up, which is the only warning you get
      if (this.stateT >= cfg.curl) {
        this.phase2 = 'rolling';
        this.stateT = 0;
        this.rollSpeed = cfg.speed0;
        this.rollDir = sign(this.game.player.x - this.x) || this.rollDir;
        Sfx.slam();
      }
      return;
    }
    if (this.phase2 === 'rolling') {
      // slow to begin with, then it runs away with itself
      const k = clamp(this.stateT / cfg.time, 0, 1);
      this.rollSpeed = lerp(cfg.speed0, cfg.speed1, Math.pow(k, cfg.accel));
      this.x += this.rollDir * this.rollSpeed * dt;
      this.spin += this.rollDir * this.rollSpeed * dt / 13;
      this.rollHit();
      this.trail(dt, 10 + this.rollSpeed / 22);
      // it comes off the walls rather than stopping at them
      if ((this.x <= 28 && this.rollDir < 0) || (this.x >= VIEW_W - 28 && this.rollDir > 0)) {
        this.rollDir *= -1;
        this.bounces++;
        this.hitThisMove = false;      // a new pass may hit you again
        Camera.add(9);
        Sfx.hit();
        burst(this.x, this.y - 16, 20, {
          color: TINT.seam, color2: '#ffffff', speedMin: 50, speedMax: 200,
          lifeMin: 0.2, lifeMax: 0.6, sizeMax: 3, gravity: 320,
        });
      }
      if (this.stateT >= cfg.time || this.bounces > cfg.bounces) {
        this.phase2 = 'uncurl';
        this.stateT = 0;
      }
      return;
    }
    if (this.stateT >= cfg.uncurl) this.rest();
  }

  rollHit() {
    if (this.hitThisMove) return;
    const p = this.game.player;
    if (p.dead) return;
    if (Math.abs(p.x - this.x) < 24 && Math.abs(p.cy - (this.y - 18)) < 26) {
      p.hurt(Math.round(this.def.roll.damage * this.dmgScale), this.x);
      this.hitThisMove = true;
      Camera.add(8);
    }
  }

  // --- the fire it never puts out ------------------------------------------

  ambient(dt) {
    if (this.aloft) return;
    if (Math.random() < dt * (10 + this.glow * 40)) {
      spawnParticle({
        x: this.x + rand(-24, 24), y: this.y - rand(10, 30),
        vx: rand(-10, 10), vy: rand(-34, -8),
        life: rand(0.3, 0.9), size: 1, color: Math.random() < 0.4 ? TINT.seamHot : TINT.seam,
        gravity: -30, drag: 0.96, kind: 'shrink',
      });
    }
  }

  trail(dt, rate) {
    for (let i = 0; i < rate * dt * 60 * 0.02; i++) {
      spawnParticle({
        x: this.x + rand(-14, 14), y: this.y - 16 + rand(-14, 14),
        vx: rand(-40, 40), vy: rand(-30, 60),
        life: rand(0.2, 0.6), size: rand(1, 2), color: Math.random() < 0.5 ? TINT.seamHot : TINT.seam,
        gravity: 40, drag: 0.94, kind: 'shrink', glow: true,
      });
    }
  }

  sparkAt(pt, k) {
    const a = rand(0, TAU);
    spawnParticle({
      x: pt.x + Math.cos(a) * 14, y: pt.y + Math.sin(a) * 14,
      vx: -Math.cos(a) * 90, vy: -Math.sin(a) * 90,
      life: 0.18, size: 1, color: TINT.seamHot, gravity: 0, kind: 'shrink',
    });
  }

  // Where a claw is right now: shoulder, out along the arm, further as it
  // stabs. Used by the hit test and by the drawing, so they cannot disagree.
  clawTip(i) {
    // 0 is the far claw, held high and back; 1 is the near one, held low and
    // out front. Holding them apart is what makes two claws read as two.
    const far = i === 0;
    const ext = this.claws[i];
    const sx = this.x + this.facing * (far ? 8 : 18);
    const sy = this.y - (far ? 34 : 24);
    const reach = (far ? 26 : 32) + ext * this.def.claw.reach;
    // At rest they are held apart; as one drives forward it swings onto the
    // player, so a stab that looks like it is going through you is.
    const droop = (far ? -0.34 : 0.22) * (1 - ext);
    const rest = (this.facing > 0 ? 0 : Math.PI) + this.facing * droop;
    const p = this.game.player;
    let a = rest;
    if (ext > 0 && p && !p.dead) {
      const aim = Math.atan2(p.cy - sy, p.x - sx);
      // only ever a lean, never a full turn - it cannot stab behind itself
      const turn = clamp(((aim - rest + Math.PI * 3) % TAU) - Math.PI, -1.05, 1.05);
      a = rest + turn * clamp(ext, 0, 1);
    }
    return { x: sx + Math.cos(a) * reach, y: sy + Math.sin(a) * reach, a, sx, sy };
  }

  // Held still by the intro and outro; only the fire keeps moving.
  cinematicUpdate(dt) {
    this.walk += dt * 4;
    this.glow = lerp(this.glow, 0.6, 1 - Math.pow(0.05, dt));
    this.ambient(dt);
    if (this.dead) this.deathT += dt;
    if (this.body) this.body.anim += dt;
  }

  posePreview() {
    this.curl = 0;
    this.claws[0] = 0.25;
    this.claws[1] = 0.25;
    this.facing = -1;
    this.glow = 0.7;
  }

  // --- paint ---------------------------------------------------------------

  draw(ctx) {
    if (this.aloft) return;
    const flash = this.body ? this.body.hurtFlash > 0 : false;
    const x = Math.round(this.x), y = Math.round(this.y);
    const f = this.facing;
    const c = flash ? '#ffffff' : TINT.shell;
    const lit = flash ? '#ffffff' : TINT.shellLit;
    const cl = flash ? '#ffffff' : TINT.claw;
    const cll = flash ? '#ffffff' : TINT.clawLit;
    const ink = flash ? '#ffffff' : TINT.ink;
    const seam = flash ? '#ffffff' : TINT.seam;
    const hot = flash ? '#ffffff' : TINT.seamHot;

    const curl = this.curl;
    const open = 1 - curl;                 // how much crab is left
    const cy = y - 20 - curl * 2;          // the ball rides a little higher

    ctx.save();
    if (this.dead) ctx.globalAlpha = clamp(1 - this.deathT / 2.2, 0, 1);

    // --- the heat it sits inside
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, x, cy, 34 + this.glow * 30, seam, 0.10 + this.glow * 0.22);
    ctx.restore();

    // --- legs: four a side, reaching well past the shell so the silhouette
    // reads as a crab and not as a rock. They fold away as it curls.
    if (open > 0.05) {
      for (let i = 0; i < 4; i++) {
        const step = Math.sin(this.walk * 2 + i * 1.15) * 0.3 * open;
        const hx = x + (i - 1.5) * 13;
        const lift = Math.max(0, Math.sin(this.walk * 2 + i * 1.15)) * 3 * open;
        for (const side of [-1, 1]) {
          // up and out from the shell, then a knee, then down to the floor
          const up = (side > 0 ? -0.55 : Math.PI + 0.55) + side * step * 0.4;
          const hipY = cy + 6;
          const kx = hx + Math.cos(up) * 16 * open, ky = hipY + Math.sin(up) * 16 * open;
          limbInk(ctx, hx, hipY, up, 16 * open, 4, cl, ink);
          const down = (side > 0 ? 1.15 : Math.PI - 1.15) - side * step;
          const footLen = (y - lift - ky) / Math.max(0.2, Math.sin(down));
          limbInk(ctx, kx, ky, down, clamp(footLen, 6, 34) * open, 3, cl, ink);
          // the point it actually stands on
          const fx = kx + Math.cos(down) * clamp(footLen, 6, 34) * open;
          const fy = ky + Math.sin(down) * clamp(footLen, 6, 34) * open;
          pxRect(ctx, Math.round(fx) - 1, Math.round(fy) - 1, 3, 2, ink);
        }
      }
    }

    // --- the shell. A dome when it walks, a circle when it rolls: the same
    // rows, squeezed from one shape into the other. It is drawn as one shape,
    // not as a stack of boxes - a per-row outline would read as planks.
    const RX = 31, RY = 20, BALL = 22;
    const rows = [];
    for (let dy = -RY; dy <= RY * 0.66; dy += 2) {
      const k = dy / RY;
      const domeHw = RX * Math.sqrt(Math.max(0, 1 - k * k));
      const ballHw = BALL * Math.sqrt(Math.max(0, 1 - (dy / BALL) * (dy / BALL)));
      const hw = Math.round(lerp(domeHw, ballHw, curl));
      if (hw > 0) rows.push([Math.round(cy + dy), hw, k]);
    }
    // the outline first, as one silhouette a pixel bigger all round
    ctx.fillStyle = ink;
    for (const [yy, hw] of rows) ctx.fillRect(x - hw - 1, yy - 1, hw * 2 + 2, 4);
    // then the shell itself, lighter at the crown and darker under the belly
    for (const [yy, hw, k] of rows) {
      ctx.fillStyle = k < -0.72 ? lit : k < -0.2 ? c : shade(c);
      ctx.fillRect(x - hw, yy, hw * 2, 2);
    }
    // plates: three seams running back over the crown
    if (curl < 0.6) {
      ctx.fillStyle = rgba(ink, 0.55 * (1 - curl));
      for (const px2 of [-14, 0, 14]) {
        for (const [yy, hw, k] of rows) {
          if (k > 0.1 || Math.abs(px2) > hw - 3) continue;
          ctx.fillRect(x + px2 - f * Math.round(k * 6), yy, 1, 2);
        }
      }
    }
    // the crown highlight, and the lip that hangs over its face
    const top = rows[0];
    if (top) {
      ctx.fillStyle = rgba(hot, 0.35 + this.glow * 0.4);
      ctx.fillRect(x - Math.round(top[1] * 0.6), top[0], Math.round(top[1] * 1.2), 1);
    }
    if (open > 0.2) {
      // the plate over its face, tucked under the front of the shell
      for (let i = 0; i < 3; i++) {
        const w2 = Math.round((12 - i * 3) * open);
        pxSolid(ctx, x + f * 17 - w2 / 2, cy + 5 + i * 3, w2, 3, c,
                { ink, light: i === 0 ? lit : null, dark: null });
      }
    }

    // --- the cracks, turning with the ball and glowing with the work
    const spin = curl > 0.2 ? this.spin : 0;
    ctx.save();
    for (const pts of this.cracks) {
      for (let i = 1; i < pts.length; i++) {
        const a0 = pts[i - 1].a + spin, a1 = pts[i].a + spin;
        const sx0 = x + Math.cos(a0) * pts[i - 1].r * lerp(RX, BALL, curl);
        const sy0 = cy + Math.sin(a0) * pts[i - 1].r * lerp(RY, BALL, curl);
        const sx1 = x + Math.cos(a1) * pts[i].r * lerp(RX, BALL, curl);
        const sy1 = cy + Math.sin(a1) * pts[i].r * lerp(RY, BALL, curl);
        const a = Math.atan2(sy1 - sy0, sx1 - sx0);
        const len = dist(sx0, sy0, sx1, sy1);
        // the crack itself is molten rock, not light: it is drawn flat, and
        // only the thread down the middle of it glows
        limb(ctx, sx0, sy0, a, len, 3, rgba('#3a1408', 0.9), 1);
        limb(ctx, sx0, sy0, a, len, 2, rgba(seam, 0.5 + this.glow * 0.5), 1);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        limb(ctx, sx0, sy0, a, len, 1, rgba(hot, 0.35 + this.glow * 0.5), 0.4);
        if (this.glow > 0.3) glowDot(ctx, (sx0 + sx1) / 2, (sy0 + sy1) / 2, 6, hot, 0.16 * this.glow);
        ctx.restore();
      }
    }
    ctx.restore();
    // and the light coming out of them
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, x, cy + 2, 16 + this.glow * 14, hot, 0.06 + this.glow * 0.2);
    ctx.restore();

    // a burning ring around the ball, turning with it
    if (curl > 0.15) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const a = this.spin + i * (TAU / 6);
        glowDot(ctx, x + Math.cos(a) * BALL, cy + Math.sin(a) * BALL, 8, hot, 0.28 * curl);
      }
      ctx.restore();
    }

    // --- eyes on stalks, tucked away with everything else as it curls
    if (open > 0.1) {
      for (const side of [-1, 1]) {
        const sx = x + f * 9 + side * 7;
        const a = (f > 0 ? -1.3 : Math.PI + 1.3) + side * 0.18 + Math.sin(this.walk * 1.6 + side) * 0.09;
        const len = 13 * open;
        limbInk(ctx, sx, cy - RY + 4, a, len, 3, cl, ink);
        const ex = sx + Math.cos(a) * len, ey = cy - RY + 4 + Math.sin(a) * len;
        glowEye(ctx, ex - 3, ey - 3, 6, 6, flash ? '#ffffff' : TINT.eye, 0.45);
        pxRect(ctx, Math.round(ex) - 1, Math.round(ey) - 1, 2, 2, '#ffffff');
      }
      // the mouth parts, working away underneath the front lip
      for (const side of [-1, 1]) {
        const aa = (f > 0 ? 0.55 : Math.PI - 0.55) + side * (0.22 + Math.sin(this.walk * 5) * 0.1);
        limbInk(ctx, x + f * 16, cy + 8, aa, 9 * open, 2, cll, ink);
      }
    }

    // --- the claws, out front on two jointed arms
    if (open > 0.05) {
      for (const i of [0, 1]) {
        const t = this.clawTip(i);
        const near = i === 1;                      // the one on your side of it
        const arm = near ? cl : shade(cl);
        const armLit = near ? cll : cl;
        const elbowA = t.a - (i === 0 ? 0.75 : -0.6) * (1 - this.claws[i]);
        const ex = t.sx + Math.cos(elbowA) * 15, ey = t.sy + Math.sin(elbowA) * 15;
        limbInk(ctx, t.sx, t.sy, elbowA, 15 * open, near ? 6 : 5, arm, ink);
        const fa = Math.atan2(t.y - ey, t.x - ex);
        limbInk(ctx, ex, ey, fa, dist(ex, ey, t.x, t.y) * open, near ? 5 : 4, arm, ink);
        // the pincer: a heavy fixed jaw and a lighter one that closes on it
        const gape = 0.52 - this.claws[i] * 0.44;
        for (const sgn of [-1, 1]) {
          const aa = t.a + sgn * gape;
          const len = (sgn > 0 ? 17 : 14) * open;
          limbInk(ctx, t.x, t.y, aa, len, sgn > 0 ? 7 : 5, arm, ink);
          limb(ctx, t.x, t.y, aa, len, sgn > 0 ? 6 : 4, armLit, 2.2);
          // the point, which is what goes through you
          const px2 = t.x + Math.cos(aa) * len, py2 = t.y + Math.sin(aa) * len;
          pxRect(ctx, Math.round(px2) - 1, Math.round(py2) - 1, 2, 2, ink);
        }
        // the knuckle, and the heat gathering in it before a stab
        pxSolid(ctx, t.x - 5, t.y - 5, 10, 10, arm, { ink, light: armLit, dark: null });
        if (this.claws[i] > 0.05) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          glowDot(ctx, t.x, t.y, 8 + 10 * this.claws[i], seam, 0.2 + 0.4 * this.claws[i]);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }
}
