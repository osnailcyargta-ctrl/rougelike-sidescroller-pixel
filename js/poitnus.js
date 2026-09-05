// Poitnus, the Ancient Stinger: the only boss in the vault you have to build
// yourself. It never lands and it never stops moving, it throws a fan of five
// stingers at where you were standing, and every fourth verse it hangs in the
// air and lays the clutch its whole species came out of.
import { clamp, lerp, rand, randInt, sign, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import {
  Camera, burst, spawnParticle, impactRing, limb, limbInk, pxRect, pxSolid,
  glowDot, glowEye, screenFlash,
} from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, GROUND_Y, BOSS_TYPES } from './config.js';
import { Enemy, Projectile } from './entities.js';

const TINT = {
  body: '#5fd8a8',
  bodyLit: '#c6ffe4',
  shell: '#1d4a38',
  shellLit: '#3f8c6a',
  eye: '#ffe066',
  venom: '#a8e04a',
  egg: '#cdf3e6',
};

// The part that actually takes hits. Everything about it forwards to the boss.
class StingerPart extends Enemy {
  constructor(x, y, game, boss) {
    super('poitnusBody', x, y, game);
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

export class PoitnusBoss {
  constructor(game, roomIndex) {
    const def = BOSS_TYPES.poitnus;
    this.game = game;
    this.def = def;
    this.name = def.name;
    this.title = def.title;
    this.kind = 'stinger';
    this.roomIndex = roomIndex;
    this.summoned = true;      // not this room's boss: the room goes on without it

    // You chose to fight it, so it fights at its listed numbers, always.
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
    this.y = def.hoverY;
    this.targetX = VIEW_W / 2;
    this.targetY = def.hoverY;
    this.bob = rand(0, TAU);
    this.wing = 0;
    this.facing = -1;

    this.state = 'idle';
    this.stateT = 0;
    this.waitT = 0.8;
    this.volleys = 0;          // how many fans since the last clutch
    this.shots = 0;
    this.shotT = 0;
    this.laid = 0;
    this.layT = 0;
    this.eggSpots = [];        // where this clutch has already gone
    this.sting = 0;            // the abdomen curl, driven by the attack

    this.spawnParts();
  }

  get parts() { return [this.body].filter(Boolean); }

  spawnParts() {
    this.body = new StingerPart(this.x, this.y + this.def.h / 2, this.game, this);
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
    Camera.add(16);
    this.game.hitstop(0.24);
    screenFlash(0.7, '#cdf3e6', 0.5);
    Sfx.die();
    burst(this.x, this.y, 54, {
      color: TINT.body, color2: '#ffffff', speedMin: 40, speedMax: 280,
      lifeMin: 0.4, lifeMax: 1.4, sizeMax: 4, gravity: 120, drag: 0.93,
    });
    impactRing(this.x, this.y, { color: '#ffffff', r0: 6, r1: 200, life: 0.85, width: 4 });
    this.game.onBossDefeated(this);
    this.game.onEnemyKilled(this.body);
  }

  // --- pattern -----------------------------------------------------------
  // Three fans with a breath between them, then the clutch, forever.

  nextStep() {
    this.stateT = 0;
    if (this.state === 'volley' || this.state === 'clutch') {
      const laying = this.state === 'clutch';
      this.state = 'idle';
      this.waitT = laying ? this.def.volleyGap * 1.4 : this.def.volleyGap;
      this.pickPerch();
      return;
    }
    if (this.volleys >= this.def.volleysPerCycle) {
      this.volleys = 0;
      this.state = 'clutch';
      this.laid = 0;
      this.layT = 0;
      this.eggSpots.length = 0;
      // it comes down to lay, and stops dead in the air to do it
      this.targetY = this.def.hoverY + 16;
      Sfx.slime();
      return;
    }
    this.state = 'volley';
    this.shots = 0;
    this.shotT = this.def.volley.windUp;
    this.volleys++;
  }

  // Somewhere new, on the far side of the arena from wherever it just was.
  pickPerch() {
    const p = this.game.player;
    const side = sign(this.x - p.x) || (Math.random() < 0.5 ? 1 : -1);
    this.targetX = clamp(p.x + side * rand(this.def.standOff, this.def.standOff + 70), 50, VIEW_W - 50);
    this.targetY = this.def.hoverY + rand(-this.def.hoverRange, this.def.hoverRange);
  }

  update(dt) {
    if (this.dead) return;
    const d = this.def;
    const p = this.game.player;
    this.stateT += dt;
    this.bob += dt * 1.6;
    this.wing += dt * (this.state === 'clutch' ? 4.6 : 3.2);
    this.facing = sign(p.x - this.x) || this.facing;

    // it is never still, even while laying: only the drift stops
    const drifting = this.state !== 'clutch' || this.laid > 0;
    const hover = this.targetY + Math.sin(this.bob) * 5 + Math.sin(this.bob * 0.63) * 3;
    if (drifting) {
      const k = 1 - Math.pow(0.06, dt);
      this.x = lerp(this.x, clamp(this.targetX, 50, VIEW_W - 50), k);
    }
    this.y = lerp(this.y, clamp(hover, 34, GROUND_Y - 70), 1 - Math.pow(0.04, dt));
    if (this.body) {
      this.body.x = this.x;
      this.body.y = this.y + d.h / 2;
    }
    // the sting curls up when it is about to throw, and stays curled to lay
    const want = this.state === 'volley' ? 1 : this.state === 'clutch' ? 0.75 : 0;
    this.sting = lerp(this.sting, want, 1 - Math.pow(0.02, dt));

    this.ambient(dt);

    switch (this.state) {
      case 'idle':
        this.waitT -= dt;
        if (this.waitT <= 0) this.nextStep();
        break;
      case 'volley': this.updateVolley(dt); break;
      case 'clutch': this.updateClutch(dt); break;
    }
  }

  ambient(dt) {
    // venom beading off the sting, and shed scales drifting down behind it
    if (Math.random() < dt * 14) {
      const s = this.stingTip();
      spawnParticle({
        x: s.x + rand(-2, 2), y: s.y, vx: rand(-8, 8), vy: rand(10, 40),
        life: rand(0.4, 0.9), size: 1, color: TINT.venom, gravity: 180, kind: 'shrink',
      });
    }
    if (Math.random() < dt * 8) {
      spawnParticle({
        x: this.x + rand(-26, 26), y: this.y + rand(-8, 14), vx: rand(-14, 14), vy: rand(6, 26),
        life: rand(0.6, 1.4), size: 1, color: TINT.bodyLit, gravity: 20, drag: 0.98, kind: 'shrink',
      });
    }
  }

  // --- the fan -----------------------------------------------------------

  updateVolley(dt) {
    const cfg = this.def.volley;
    this.shotT -= dt;
    if (this.shotT > 0) {
      // a bead of light gathering on the sting through the wind-up
      if (Math.random() < dt * 40) {
        const s = this.stingTip();
        const a = rand(0, TAU);
        spawnParticle({
          x: s.x + Math.cos(a) * 16, y: s.y + Math.sin(a) * 16,
          vx: -Math.cos(a) * 90, vy: -Math.sin(a) * 90,
          life: 0.18, size: 1, color: TINT.venom, gravity: 0, kind: 'shrink',
        });
      }
      return;
    }
    if (this.shots === 0) this.aimAt = this.playerAim();
    this.fireOne(this.shots);
    this.shots++;
    if (this.shots >= cfg.count) { this.nextStep(); return; }
    this.shotT = cfg.spacing;
  }

  playerAim() {
    const p = this.game.player;
    const s = this.stingTip();
    return Math.atan2(p.cy - s.y, p.x - s.x);
  }

  // The five go out one after another across the fan, so you can watch it
  // sweep rather than being hit by a wall.
  fireOne(i) {
    const cfg = this.def.volley;
    const s = this.stingTip();
    const a = this.aimAt + (i / Math.max(1, cfg.count - 1) - 0.5) * 2 * cfg.spread;
    this.game.projectiles.push(new Projectile({
      x: s.x, y: s.y,
      vx: Math.cos(a) * cfg.speed, vy: Math.sin(a) * cfg.speed,
      damage: Math.round(cfg.damage * this.dmgScale),
      team: 'enemy', kind: 'bolt', life: 4, game: this.game,
    }));
    Sfx.bow();
    Camera.add(1.6);
    burst(s.x, s.y, 5, {
      color: TINT.venom, color2: '#eaffb0', kind: 'streak', speedMin: 60, speedMax: 190,
      lifeMin: 0.06, lifeMax: 0.18, gravity: 0, angle: a, spread: 0.4, drag: 0.86,
    });
    impactRing(s.x, s.y, { color: TINT.venom, r0: 1, r1: 14, life: 0.18, width: 1.5 });
  }

  // --- the clutch --------------------------------------------------------

  updateClutch(dt) {
    const cfg = this.def.clutch;
    // it holds dead still for two seconds first: the tell that eggs are coming
    if (this.laid === 0 && this.stateT < cfg.hold) {
      if (Math.random() < dt * 26) {
        spawnParticle({
          x: this.x + rand(-18, 18), y: this.y + 16, vx: rand(-10, 10), vy: rand(-30, -6),
          life: rand(0.3, 0.7), size: 1, color: TINT.egg, gravity: -10, kind: 'shrink',
        });
      }
      return;
    }
    this.layT -= dt;
    if (this.layT > 0) return;
    this.layOne();
    this.laid++;
    if (this.laid >= cfg.count) { this.nextStep(); return; }
    this.layT = cfg.gap;
    this.movePastLastEgg();
  }

  // Never twice over the same patch of floor: it picks the furthest of a few
  // candidates from everything it has already dropped this clutch.
  movePastLastEgg() {
    const cfg = this.def.clutch;
    let best = this.x, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const cand = rand(56, VIEW_W - 56);
      let near = 1e9;
      for (const sx of this.eggSpots) near = Math.min(near, Math.abs(cand - sx));
      // a candidate that clears the spacing is good enough; otherwise take
      // whichever is furthest from the eggs already down
      const score = Math.min(near, cfg.minSpacing * 1.6);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    this.targetX = best;
    this.targetY = this.def.hoverY + 16;
  }

  layOne() {
    const x = clamp(this.x, 30, VIEW_W - 30);
    this.eggSpots.push(x);
    const e = new Enemy('stingeregg', x, this.y + this.def.h / 2 + 6, this.game);
    e.spawnT = 0.25;
    e.vy = this.def.clutch.dropSpeed;
    this.game.enemies.push(e);
    Sfx.slime();
    Camera.add(3);
    burst(x, this.y + this.def.h / 2, 12, {
      color: TINT.egg, color2: '#ffffff', speedMin: 20, speedMax: 90,
      lifeMin: 0.2, lifeMax: 0.5, gravity: 160, angle: Math.PI / 2, spread: 1.0,
    });
    impactRing(x, this.y + this.def.h / 2, { color: TINT.egg, r0: 2, r1: 26, life: 0.3, width: 2 });
  }

  // --- geometry ----------------------------------------------------------

  // The tip of the abdomen, which is where everything it throws comes from.
  // Where plate i of the abdomen sits, counted back from the thorax. Both the
  // sprite and the aim read this, so the fan always leaves the visible sting.
  plate(i) {
    const f = this.facing;
    const back = [18, 31, 43, 53, 60, 65][i];
    const drop = [2, 7, 12, 17, 21, 24][i];
    const curl = [0, 1, 4, 9, 15, 22][i];
    return { x: this.x - f * back, y: this.y + drop - curl * this.sting };
  }

  stingTip() {
    const f = this.facing;
    const b = this.plate(5);
    const a = -0.32 - this.sting * 1.15;      // level when idle, cocked when aiming
    return { x: b.x - f * Math.cos(a) * 16, y: b.y + Math.sin(a) * 16 };
  }

  cinematicUpdate(dt) {
    this.bob += dt * 1.4;
    this.wing += dt * (this.dead ? 1.0 : 3.0);
    if (this.dead) {
      this.deathT += dt;
      this.y += 24 * dt;                     // it sinks as it comes apart
      if (this.body) { this.body.x = this.x; this.body.y = this.y + this.def.h / 2; }
      return;
    }
    this.y = this.def.hoverY + Math.sin(this.bob) * 6;
    if (this.body) { this.body.x = this.x; this.body.y = this.y + this.def.h / 2; this.body.anim += dt; }
  }

  // --- paint -------------------------------------------------------------

  draw(ctx) {
    const t = this.body ? this.body.anim : this.wing;
    const flash = this.body ? this.body.hurtFlash > 0 : false;
    const x = Math.round(this.x), y = Math.round(this.y);
    const f = this.facing;
    const c = flash ? '#ffffff' : TINT.body;
    const lit = flash ? '#ffffff' : TINT.bodyLit;
    const d = flash ? '#ffffff' : TINT.shell;
    const dl = flash ? '#ffffff' : TINT.shellLit;
    const ink = flash ? '#ffffff' : '#0b1f18';

    // A hornet in profile, so everything is laid out along the way it faces:
    // head out front, thorax in the middle, abdomen trailing behind and down.
    const headX = x + f * 20;
    const tailX = x - f * 16;

    ctx.save();
    if (this.dead) ctx.globalAlpha = clamp(1 - this.deathT / 2.2, 0, 1);

    // --- wings, swept back over the thorax
    const beat = Math.sin(this.wing * 6.5);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [len, tilt, w] of [[42, 0, 7], [28, 0.42, 5]]) {
      for (let i = 0; i < 4; i++) {
        ctx.globalAlpha = (0.17 - i * 0.035) * (this.dead ? 0.35 : 1);
        const a = (f > 0 ? Math.PI + 0.42 : -0.42) + (f > 0 ? 1 : -1) * (tilt + beat * 0.14 - i * 0.09);
        limb(ctx, x - f * 2, y - 9, a, len - i * 4, w, flash ? '#fff' : '#9fe8d4');
      }
      ctx.globalAlpha = 0.55 * (this.dead ? 0.35 : 1);
      const a = (f > 0 ? Math.PI + 0.42 : -0.42) + (f > 0 ? 1 : -1) * (tilt + beat * 0.14);
      limb(ctx, x - f * 2, y - 9, a, len, 1, flash ? '#fff' : '#eaffff');
    }
    ctx.restore();

    // --- abdomen: six plates trailing back and down, tapering to the sting.
    // The whole tail curls upward as it winds up, the way a wasp cocks before
    // it drives the sting in.
    const lift = this.sting;
    for (let i = 5; i >= 0; i--) {
      const p2 = this.plate(i);
      const w = 24 - i * 3, h = 21 - i * 2.6;
      pxSolid(ctx, p2.x - w / 2, p2.y - h / 2, w, h, c, { ink, light: lit, dark: null });
      if (i % 2) pxRect(ctx, p2.x - w / 2, p2.y - h / 2 + 3, w, Math.max(2, h - 8), d);
      pxRect(ctx, p2.x - w / 2, p2.y - h / 2 + 1, w, 1, dl);
    }
    const tip = this.stingTip();
    const back = this.plate(5);
    const stingA = Math.atan2(tip.y - back.y, tip.x - back.x);
    limbInk(ctx, back.x, back.y, stingA, 16, 7, d, ink);
    limb(ctx, back.x, back.y, stingA, 16, 7, d, 6.2);           // taper it to a point
    limb(ctx, back.x, back.y, stingA, 13, 1, flash ? '#fff' : dl);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, tip.x, tip.y, 9 + lift * 16, TINT.venom, 0.3 + lift * 0.45);
    ctx.restore();

    // --- six legs hanging under the thorax, treading air
    for (let i = 0; i < 3; i++) {
      const swing = Math.sin(this.wing * 2.4 + i * 1.2) * 0.2;
      const hx = x + f * (12 - i * 12);
      const a0 = 1.05 + i * 0.16 + swing;
      for (const side of [-1, 1]) {
        const aa = side > 0 ? a0 : Math.PI - a0;
        limbInk(ctx, hx, y + 6, aa, 13, 3, d, ink);
        const kx = hx + Math.cos(aa) * 13, ky = y + 6 + Math.sin(aa) * 13;
        limbInk(ctx, kx, ky, aa - side * 0.95, 9, 2, d, ink);
      }
    }

    // --- thorax: a barrel, rounded by stacking narrowing rows
    for (const [dy, hw, h] of [[-11, 13, 4], [-8, 17, 5], [-3, 19, 8], [5, 16, 5], [10, 11, 3]]) {
      pxSolid(ctx, x - hw, y + dy, hw * 2, h, c, { ink, light: dy < 0 ? lit : null, dark: null });
    }
    // plated ridge along the top, and the pale collar where the head meets it
    for (let i = 0; i < 4; i++) {
      pxRect(ctx, x - 14 + i * 8, y - 9, 6, 7, dl);
      pxRect(ctx, x - 14 + i * 8, y - 9, 6, 1, lit);
    }
    pxSolid(ctx, headX - f * 5 - 3, y - 9, 6, 16, d, { ink, dark: null });

    // --- head, out front: a wedge with a plated brow
    for (const [dy, hw, h] of [[-13, 8, 4], [-10, 11, 7], [-3, 10, 7], [4, 7, 4]]) {
      pxSolid(ctx, headX - hw, y + dy, hw * 2, h, d, { ink, light: dy < 0 ? dl : null, dark: null });
    }
    // eyes: one big compound eye on the near side, two ocelli above it. They
    // narrow to slits through a volley.
    const lid = this.state === 'volley' ? 1 : 0;
    glowEye(ctx, headX + f * 1 - 5, y - 8, 10, 7 - lid * 3, flash ? '#fff' : TINT.eye, 0.36);
    pxRect(ctx, headX + f * 1 - 5, y - 8, 10, 1, flash ? '#fff' : '#fff8c0');
    for (const ox of [-4, 0, 4]) {
      glowEye(ctx, headX + ox - 1, y - 13, 2, 2, flash ? '#fff' : TINT.eye, 0.22);
    }
    // antennae, flicking
    for (const side of [-1, 1]) {
      const aa = (f > 0 ? -1.15 : Math.PI + 1.15) + side * 0.3 + Math.sin(this.wing * 3 + side) * 0.08;
      limbInk(ctx, headX + f * 4, y - 12, aa, 16, 2, d, ink);
    }
    // mandibles under the face, gaping while it lays
    const gape = this.state === 'clutch' ? 0.5 : 0.12;
    for (const side of [-1, 1]) {
      const aa = (f > 0 ? 0.35 : Math.PI - 0.35) + side * gape * f;
      limbInk(ctx, headX + f * 6, y + 3, aa, 11, 3, d, ink);
      const mx = headX + f * 6 + Math.cos(aa) * 11, my = y + 3 + Math.sin(aa) * 11;
      limbInk(ctx, mx, my, aa - f * 1.2, 7, 2, d, ink);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowDot(ctx, x, y - 4, 36, TINT.body, 0.13 + 0.06 * Math.sin(t * 3));
    ctx.restore();
    ctx.restore();
  }
}
