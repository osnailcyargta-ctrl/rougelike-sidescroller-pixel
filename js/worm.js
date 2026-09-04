// Big Dude: a twenty-block worm that spends most of its life under the floor.
// The head drives a path; every body segment samples that path a fixed arc
// length behind it, so the whole thing swims, erupts and dives as one curve.
// Only the parts above the floor line can be hit, or can hurt you.
import { clamp, lerp, rand, randInt, choice, dist, sign, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import {
  Camera, burst, spawnParticle, impactRing, dropShadow, limb, limbInk, pxRect, pxSolid, glowDot, glowEye,
} from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GROUND_Y, BOSS_TYPES, ROOM_SCALING, BOSS_ROOM_INTERVAL } from './config.js';
import { Enemy, Projectile } from './entities.js';

const TINT = {
  shell: '#7c4a2a',
  shellDark: '#4a2a16',
  shellLight: '#b8703c',
  belly: '#e0a86a',
  maw: '#2a0d0d',
  gum: '#c2455c',
  tooth: '#fff0d8',
  eye: '#ffd166',
};

// One hittable node of the worm. It carries no AI: the worm places it.
class WormPart extends Enemy {
  constructor(type, x, y, game, boss) {
    super(type, x, y, game);
    this.boss = boss;
    this.spawnT = 0;
    this.isBoss = true;
    this.noContact = true;        // the worm does contact damage itself
    this.untargetable = true;
    this.dmg = Math.round(this.def.damage * boss.dmgScale);
    this.maxHp = boss.maxHp;
    this.hp = boss.hp;
  }
  applyRawDamage(amount) { this.boss.applyRawDamage(amount); }
  damage(amount, opts = {}) { super.damage(amount, { ...opts, knockback: 0, shake: opts.shake ?? 1 }); }
  kill() { this.boss.die(); }
  drawHpBar() {}
  draw() {}                      // the worm draws its whole body in one pass
  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.maxHp;
    this.updateStatus(dt);
  }
}

export class WormBoss {
  constructor(game, roomIndex) {
    const def = BOSS_TYPES.bigdude;
    this.game = game;
    this.def = def;
    this.name = def.name;
    this.kind = 'worm';
    this.roomIndex = roomIndex;

    // Bosses alternate, so scale by how many times THIS boss has shown up -
    // a debut boss always fights at its listed stats.
    const tier = Math.max(1, Math.round(roomIndex / BOSS_ROOM_INTERVAL));
    const ownTier = Math.ceil(tier / 2);
    this.hpScale = 1 + ROOM_SCALING.bossHpPerTier * (ownTier - 1);
    this.dmgScale = 1 + ROOM_SCALING.bossDamagePerTier * (ownTier - 1);
    this.maxHp = Math.round(def.hp * this.hpScale);
    this.hp = this.maxHp;
    this.phase = 1;
    this.phase2At = 0;            // no phases; the HP bar hides the marker
    this.dead = false;
    this.intro = 0;

    // head state
    this.hx = VIEW_W / 2;
    this.hy = GROUND_Y + def.burrowDepth;
    this.vx = def.burrowSpeed;
    this.vy = 0;
    this.airborne = false;
    this.wasAbove = false;
    this.targetX = VIEW_W / 2;

    // path history: [x, y, cumulative distance]
    this.path = [];
    this.pathLen = 0;
    for (let i = 0; i < 400; i++) this.path.push([this.hx, this.hy, -i * 4]);

    this.segments = [];
    for (let i = 0; i < def.segments; i++) this.segments.push({ x: this.hx, y: this.hy });

    // the pattern, looping
    this.script = [
      { burrow: def.buriedTime },
      { leap: true },
      { wait: def.waitTime },
      { leap: true },
      { wait: def.waitTime },
      { leap: true, spit: true },
      { burrow: def.buriedTime },
      { leap: true, spit: true },
      { wait: def.waitTime },
    ];
    this.step = 0;
    this.stateT = 0;
    this.state = 'burrow';
    this.stateDur = def.buriedTime;
    this.spitPending = false;
    this.spatThisLeap = false;
    this.cineT = 0;
    this.cineErupted = false;

    // hit proxies: the head plus five points down the body
    this.head = new WormPart('wormHead', this.hx, this.hy, game, this);
    this.bodyParts = [];
    this.bodyIndex = [3, 7, 11, 14, 17];
    for (const i of this.bodyIndex) {
      const p = new WormPart('wormBody', this.hx, this.hy, game, this);
      p.segIndex = i;
      this.bodyParts.push(p);
    }
    game.enemies.push(this.head, ...this.bodyParts);
  }

  get parts() { return [this.head, ...this.bodyParts]; }

  applyRawDamage(amount) {
    if (this.dead) return;
    this.hp -= amount;
    if (this.hp <= 0) this.die();
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    for (const p of this.parts) p.dead = true;
    Camera.add(16);
    this.game.hitstop(0.22);
    Sfx.die();
    for (let i = 0; i < this.segments.length; i += 2) {
      const s = this.segments[i];
      if (s.y > GROUND_Y + 8) continue;
      burst(s.x, s.y, 16, {
        color: TINT.shell, color2: TINT.belly, speedMin: 40, speedMax: 200,
        lifeMin: 0.3, lifeMax: 1.0, sizeMax: 3, gravity: 400,
      });
    }
    this.game.onBossDefeated(this);
    this.game.onEnemyKilled(this.head);
  }

  // --- path ------------------------------------------------------------

  pushPath(x, y) {
    const last = this.path[0];
    const d = Math.hypot(x - last[0], y - last[1]);
    this.pathLen += d;
    this.path.unshift([x, y, this.pathLen]);
    if (this.path.length > 700) this.path.pop();
  }

  // Point a given arc length behind the head.
  sampleBack(distance) {
    const want = this.pathLen - distance;
    for (let i = 0; i < this.path.length - 1; i++) {
      const a = this.path[i], b = this.path[i + 1];
      if (b[2] <= want && a[2] >= want) {
        const span = a[2] - b[2];
        const t = span > 0.0001 ? (want - b[2]) / span : 0;
        return { x: lerp(b[0], a[0], t), y: lerp(b[1], a[1], t) };
      }
    }
    const tail = this.path[this.path.length - 1];
    return { x: tail[0], y: tail[1] };
  }

  // --- pattern ----------------------------------------------------------

  update(dt) {
    if (this.dead) return;
    const d = this.def;
    const p = this.game.player;
    this.stateT += dt;

    if (this.state === 'leap') this.updateLeap(dt);
    else this.updateBurrow(dt, this.state === 'burrow' ? d.burrowSpeed : d.burrowSpeed * 0.7);

    this.updateBody();
    this.contactDamage();
    this.surfaceDust(dt);

    if (this.state !== 'leap' && this.stateT >= this.stateDur) this.nextStep();
  }

  // Trail the body along the head's path and re-place the hit proxies.
  updateBody(hittable = true) {
    const d = this.def;
    this.pushPath(this.hx, this.hy);
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.sampleBack((i + 1) * d.segSpacing);
      this.segments[i].x = s.x;
      this.segments[i].y = s.y;
    }
    this.head.x = this.hx;
    this.head.y = this.hy + this.head.h / 2;
    this.head.untargetable = !hittable || this.hy > GROUND_Y - 2;
    for (const part of this.bodyParts) {
      const s = this.segments[part.segIndex];
      part.x = s.x;
      part.y = s.y + part.h / 2;
      part.untargetable = !hittable || s.y > GROUND_Y - 2;
    }
  }

  nextStep() {
    const d = this.def;
    this.step = (this.step + 1) % this.script.length;
    const s = this.script[this.step];
    this.stateT = 0;
    if (s.leap) {
      this.state = 'leap';
      this.stateDur = 99;
      this.spitPending = !!s.spit;
      this.spatThisLeap = false;
      this.startLeap();
    } else if (s.burrow !== undefined) {
      this.state = 'burrow';
      this.stateDur = s.burrow;
      this.targetX = clamp(this.game.player.x + rand(-90, 90), 40, VIEW_W - 40);
    } else {
      this.state = 'wait';
      this.stateDur = s.wait;
      this.targetX = clamp(this.game.player.x + rand(-70, 70), 40, VIEW_W - 40);
    }
  }

  // Cruising below the floor, sliding toward where it means to come up.
  updateBurrow(dt, speed) {
    const d = this.def;
    const depth = GROUND_Y + d.burrowDepth;
    const dx = this.targetX - this.hx;
    this.vx = lerp(this.vx, clamp(dx * 2.2, -speed, speed), 1 - Math.pow(0.002, dt));
    this.vy = lerp(this.vy, (depth - this.hy) * 2.4, 1 - Math.pow(0.002, dt));
    this.hx = clamp(this.hx + this.vx * dt, 20, VIEW_W - 20);
    this.hy += this.vy * dt;
    this.airborne = false;
  }

  startLeap() {
    const d = this.def;
    const p = this.game.player;
    // burst up through the floor a little short of the player and arc over them
    const from = clamp(p.x - sign(p.x - this.hx || 1) * rand(40, 80), 30, VIEW_W - 30);
    this.hx = from;
    this.hy = GROUND_Y + 22;
    this.vx = sign(p.x - from || 1) * d.leapAcross * rand(0.8, 1.15);
    this.vy = -d.leapUp;
    this.airborne = true;
    this.leapT = 0;
    this.leftGround = false;   // the leap cannot end before it has surfaced
    Sfx.slam();
    Camera.add(9);
    Camera.punch(1.6);
    this.eruptBurst(from);
  }

  eruptBurst(x) {
    impactRing(x, GROUND_Y, { color: TINT.shellLight, r0: 5, r1: 60, life: 0.4, width: 3, squash: 0.3 });
    burst(x, GROUND_Y, 34, {
      color: TINT.shellDark, color2: TINT.shell, speedMin: 60, speedMax: 260,
      lifeMin: 0.3, lifeMax: 0.9, sizeMax: 3, gravity: 520, angle: -Math.PI / 2, spread: 1.2,
    });
    burst(x, GROUND_Y, 12, {
      color: TINT.shellDark, kind: 'smoke', speedMin: 20, speedMax: 90,
      lifeMin: 0.4, lifeMax: 1.0, sizeMin: 2, sizeMax: 5, gravity: -30, glow: false,
    });
  }

  updateLeap(dt) {
    const d = this.def;
    this.leapT += dt;
    this.vy += d.leapGravity * dt;
    // once it is well under again, level out instead of diving off the map
    if (this.hy > GROUND_Y + d.burrowDepth) {
      this.vy = Math.min(this.vy, d.burrowSpeed * 0.8);
      this.vy = lerp(this.vy, 0, 1 - Math.pow(0.02, dt));
    }
    this.hx = clamp(this.hx + this.vx * dt, 12, VIEW_W - 12);
    this.hy += this.vy * dt;

    const above = this.hy < GROUND_Y;
    if (above) this.leftGround = true;
    // spit at the top of the arc, once
    if (this.spitPending && !this.spatThisLeap && this.vy > -60 && above) {
      this.spatThisLeap = true;
      this.spit();
    }
    if (this.wasAbove && !above) {
      // punching back in
      this.eruptBurst(this.hx);
      Sfx.slam();
      Camera.add(7);
    }
    this.wasAbove = above;
    this.airborne = above;

    // the leap is over once it has surfaced AND the tail has followed it back
    const tail = this.segments[this.segments.length - 1];
    if ((this.leftGround && !above && tail.y > GROUND_Y + 6) || this.leapT > 7) {
      this.state = 'wait';
      this.stateT = 0;
      this.stateDur = 0.25;
      this.vy = 0;
      this.targetX = clamp(this.game.player.x + rand(-70, 70), 40, VIEW_W - 40);
    }
  }

  spit() {
    const d = this.def;
    Sfx.slime();
    Camera.add(4);
    for (let i = 0; i < d.spitCount; i++) {
      // a fan of globs thrown upward, each with its own arc
      const a = -Math.PI / 2 + (i / (d.spitCount - 1) - 0.5) * 2 * d.spitSpread + rand(-0.06, 0.06);
      const sp = d.spitSpeed * rand(0.75, 1.2);
      this.game.projectiles.push(new Projectile({
        x: this.hx, y: this.hy - 6,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        gravity: 560, damage: Math.round(d.spitDamage * this.dmgScale),
        team: 'enemy', kind: 'acid', life: 5, game: this.game,
      }));
    }
    burst(this.hx, this.hy - 8, 16, {
      color: '#a8e04a', color2: '#e6ffb0', speedMin: 30, speedMax: 140,
      lifeMin: 0.2, lifeMax: 0.5, gravity: 260, angle: -Math.PI / 2, spread: 1.2,
    });
  }

  contactDamage() {
    const p = this.game.player;
    if (p.dead || p.invuln > 0 || p.dashT > 0) return;
    const d = this.def;
    // the head hurts a lot more than the back
    if (this.hy < GROUND_Y && dist(p.x, p.cy, this.hx, this.hy) < d.headR + 8) {
      p.hurt(Math.round(d.headDamage * this.dmgScale), this.hx);
      return;
    }
    for (let i = 0; i < this.segments.length; i += 2) {
      const s = this.segments[i];
      if (s.y > GROUND_Y) continue;
      if (dist(p.x, p.cy, s.x, s.y) < d.bodyR + 7) {
        p.hurt(Math.round(d.bodyDamage * this.dmgScale), s.x);
        return;
      }
    }
  }

  // Soil kicked up wherever the body is crossing the floor line.
  surfaceDust(dt) {
    const pts = [{ x: this.hx, y: this.hy }, ...this.segments];
    for (const s of pts) {
      if (Math.abs(s.y - GROUND_Y) > 10) continue;
      if (Math.random() > dt * 12) continue;
      spawnParticle({
        x: s.x + rand(-8, 8), y: GROUND_Y - 1, vx: rand(-40, 40), vy: rand(-90, -20),
        life: rand(0.3, 0.7), size: randInt(1, 3), color: TINT.shellDark,
        gravity: 420, drag: 0.92, glow: false,
      });
    }
    // a mound tracking the head while it is buried
    if (this.hy > GROUND_Y && this.hy < GROUND_Y + 34 && Math.random() < dt * 18) {
      spawnParticle({
        x: this.hx + rand(-6, 6), y: GROUND_Y - 1, vx: rand(-20, 20), vy: rand(-40, -8),
        life: rand(0.2, 0.5), size: randInt(1, 2), color: TINT.shellDark,
        gravity: 320, glow: false,
      });
    }
  }

  // The reveal: it holds under the floor for a beat, then tears up into frame
  // and rears there for the name card instead of sitting invisible underground.
  cinematicUpdate(dt) {
    for (const p of this.parts) p.anim += dt;
    this.cineT = (this.cineT ?? 0) + dt;
    const d = this.def;
    const t = this.cineT;

    if (t < 0.45) {
      const want = clamp(this.game.player.x + 96, 60, VIEW_W - 60);
      this.hx = lerp(this.hx, want, 1 - Math.pow(0.02, dt));
      this.hy = lerp(this.hy, GROUND_Y + 26, 1 - Math.pow(0.02, dt));
    } else if (t < 1.5) {
      if (!this.cineErupted) {
        this.cineErupted = true;
        this.eruptBurst(this.hx);
        Sfx.slam();
      }
      // tear upward, easing off as it reaches its rearing height
      const k = clamp((t - 0.45) / 1.05, 0, 1);
      const ease = 1 - Math.pow(1 - k, 3);
      this.hy = lerp(GROUND_Y + 26, 96, ease);
      this.hx += Math.sin(t * 3.4) * 26 * dt;
      this.airborne = true;
    } else {
      // reared and swaying while the card is on screen
      this.hy = 96 + Math.sin((t - 1.5) * 2.2) * 7;
      this.hx += Math.sin(t * 1.7) * 34 * dt;
      this.airborne = true;
    }
    this.hx = clamp(this.hx, 40, VIEW_W - 40);
    this.updateBody(false);
    this.surfaceDust(dt);
  }

  // --- art ---------------------------------------------------------------

  draw(ctx) {
    const d = this.def;
    const flash = this.head.hurtFlash > 0 || this.bodyParts.some((p) => p.hurtFlash > 0);
    const t = this.head.anim;

    // shadow of whatever is in the air
    if (this.hy < GROUND_Y - 4) dropShadow(ctx, this.hx, GROUND_Y, d.headR * 0.9, GROUND_Y - this.hy);

    ctx.save();
    // everything below the floor line is simply not drawn
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, GROUND_Y);
    ctx.clip();

    // body, tail first so the head overlaps everything
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.y > GROUND_Y + 14) continue;
      const k = i / this.segments.length;
      const r = lerp(d.bodyR, d.tailR, k * k);
      const prev = i === 0 ? { x: this.hx, y: this.hy } : this.segments[i - 1];
      const ang = Math.atan2(s.y - prev.y, s.x - prev.x);
      this.drawSegment(ctx, s.x, s.y, r, ang, i, flash, t);
    }
    this.drawHead(ctx, flash, t);
    ctx.restore();

    // dirt lip where the body punches through the floor
    for (const s of [{ x: this.hx, y: this.hy }, ...this.segments]) {
      if (Math.abs(s.y - GROUND_Y) > 8) continue;
      pxRect(ctx, s.x - 12, GROUND_Y - 2, 24, 3, TINT.shellDark);
      pxRect(ctx, s.x - 9, GROUND_Y - 3, 18, 1, TINT.shell);
    }
  }

  drawSegment(ctx, x, y, r, ang, i, flash, t) {
    const C = (c) => (flash ? '#ffffff' : c);
    const px = Math.round(x), py = Math.round(y);
    const ringPulse = Math.sin(t * 6 - i * 0.6) * 0.5 + 0.5;
    const INK = flash ? '#ffffff' : '#170d16';
    // bristles go down first so the plate sits on top of their roots
    const spread = 0.5 + ringPulse * 0.2;
    limbInk(ctx, px, py, ang + Math.PI / 2 + spread, r + 4, 2, C(TINT.shellDark), INK);
    limbInk(ctx, px, py, ang - Math.PI / 2 - spread, r + 4, 2, C(TINT.shellDark), INK);
    // plated ring
    pxSolid(ctx, px - r, py - r, r * 2, r * 2, C(TINT.shell), { ink: INK, light: null, dark: null });
    pxRect(ctx, px - r + 1, py - r - 1, r * 2 - 2, 2, C(TINT.shellLight));
    pxRect(ctx, px - r, py - r, 2, r * 2, C(TINT.shellDark));
    pxRect(ctx, px + r - 2, py - r, 2, r * 2, C(TINT.shellDark));
    // soft belly stripe, lit from inside so the body reads as segmented meat
    pxRect(ctx, px - r + 3, py - 2, r * 2 - 6, 4, C(TINT.belly));
    pxRect(ctx, px - r + 3, py - 2, r * 2 - 6, 1, C(TINT.shellLight));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, px, py, r * 1.6, TINT.belly, 0.10 + ringPulse * 0.10);
    ctx.restore();
  }

  drawHead(ctx, flash, t) {
    const d = this.def;
    const C = (c) => (flash ? '#ffffff' : c);
    const x = Math.round(this.hx), y = Math.round(this.hy);
    const next = this.segments[0];
    const ang = Math.atan2(this.hy - next.y, this.hx - next.x);
    const r = d.headR;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);

    const INK = flash ? '#ffffff' : '#170d16';
    // mandibles first, so the skull overlaps their hinges
    const gape = this.airborne ? 1 : 0.55;
    const openK = (0.7 + 0.3 * Math.sin(t * 9)) * gape;
    limbInk(ctx, r - 4, -r + 1, -0.5 - openK * 0.35, 11, 4, C(TINT.shellDark), INK);
    limbInk(ctx, r - 4, r - 1, 0.5 + openK * 0.35, 11, 4, C(TINT.shellDark), INK);
    // skull
    pxSolid(ctx, -r, -r, r * 2, r * 2, C(TINT.shell), { ink: INK, light: null, dark: null });
    pxRect(ctx, -r + 2, -r - 2, r * 2 - 4, 3, C(TINT.shellLight));
    pxRect(ctx, -r, -r, 3, r * 2, C(TINT.shellDark));
    // a ridge of plates over the crown
    for (let i = 0; i < 3; i++) {
      pxRect(ctx, -r + 4 + i * 5, -r - 3, 3, 2, C(TINT.shellDark));
    }

    // maw: a ring of teeth around a dark throat, chewing as it flies
    pxRect(ctx, r - 6, -r + 2, 8, r * 2 - 4, C(TINT.maw));
    pxRect(ctx, r - 3, -r + 4, 4, r * 2 - 8, C(TINT.gum));
    for (let i = 0; i < 6; i++) {
      const ty = -r + 3 + i * ((r * 2 - 6) / 5);
      const bite = (i % 2 ? 1 : -1) * openK * 2;
      pxRect(ctx, r - 2 + bite, ty, 4, 3, C(TINT.tooth));
    }
    // eyes down the side of the head
    for (const sy of [-1, 1]) {
      glowEye(ctx, -2, sy * (r - 5) - 1, 5, 3, C(TINT.eye), 0.30);
      pxRect(ctx, 0, sy * (r - 5), 2, 1, '#000000');
    }
    ctx.restore();
    glowDot(ctx, x, y, r + 8, TINT.eye, 0.16);
  }
}
