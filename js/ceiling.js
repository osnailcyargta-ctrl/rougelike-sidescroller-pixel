// The Undead Ceiling. It is not standing in the room - it IS the roof, a slab
// of grafted flesh with one enormous eye, and it never moves sideways. Three
// ways it reaches you: a beam it stares down, an arm it grows, and, once the
// fight has dragged on long enough, the whole slab coming down on your head.
import { clamp, lerp, rand, randInt, dist, distToSegment, sign, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import {
  Camera, burst, floatText, spawnParticle, impactRing, limb, pxRect, glowDot, screenFlash,
} from './gfx.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GROUND_Y, BLOCK, BOSS_TYPES } from './config.js';
import { Enemy } from './entities.js';

const TINT = {
  flesh: '#7a2f3a',
  fleshLit: '#a8434f',
  fleshDeep: '#4a1a24',
  vein: '#c9566a',
  sinew: '#e0a0a8',
  sclera: '#f2e4d4',
  iris: '#ffd24a',
  pupil: '#12080c',
  beam: '#ff6a7a',
  beamHot: '#ffd8dc',
  bile: '#b8d24a',
};

// Both the slab and the hand are proxies onto one shared pool, so every hit
// test in the game works on them unchanged.
class MeatPart extends Enemy {
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
  damage(amount, opts = {}) { super.damage(amount, { ...opts, knockback: 0, shake: opts.shake ?? 1 }); }
  kill() { this.boss.die(); }
  drawHpBar() {}
  draw() {}                    // the controller draws the whole thing at once
  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.maxHp;
    this.updateStatus(dt);
  }
}

export class CeilingBoss {
  constructor(game, roomIndex) {
    const def = BOSS_TYPES.ceiling;
    this.game = game;
    this.def = def;
    this.name = def.name;
    this.title = def.title;
    this.kind = 'ceiling';
    this.roomIndex = roomIndex;

    this.hpScale = 1;
    this.dmgScale = def.dmgScale ?? 1;
    this.maxHp = def.hp;
    this.hp = this.maxHp;
    this.phase = 1;
    this.phase2At = 0;
    this.dead = false;
    this.intro = 0;

    // it hangs from the top of the frame and only ever moves on Y
    this.x = VIEW_W / 2;
    this.y = def.restY;                 // the top edge of the slab
    this.restY = def.restY;
    this.sag = 0;                       // how far the belly bulges downward
    this.pulse = rand(0, TAU);
    this.fightT = 0;                    // how long this fight has run
    this.crushArmed = false;

    this.state = 'idle';
    this.stateT = 0;
    this.step = -1;
    this.waitT = 1.0;
    this.lasers = 0;
    this.beam = null;
    this.hands = null;
    this.crush = null;
    this.script = CeilingBoss.buildScript();

    // fixed points along the slab where flesh bulges and breathes
    this.lobes = [];
    for (let i = 0; i < 11; i++) {
      this.lobes.push({
        x: 14 + i * ((VIEW_W - 28) / 10) + rand(-6, 6),
        r: rand(9, 20),
        p: rand(0, TAU),
        s: rand(0.7, 1.5),
      });
    }
    // dangling strands of sinew that sway
    this.strands = [];
    for (let i = 0; i < 22; i++) {
      this.strands.push({
        x: rand(6, VIEW_W - 6), len: rand(8, 30), p: rand(0, TAU), s: rand(0.6, 1.4),
      });
    }
    // blotches spread through the whole thickness, given as a fraction of the
    // slab's depth so they stay put as it descends
    this.mottle = [];
    for (let i = 0; i < 30; i++) {
      this.mottle.push({
        x: rand(-10, VIEW_W + 10), y: rand(0, 1), r: rand(14, 46),
        p: rand(0, TAU), s: rand(0.5, 1.3), dark: Math.random() < 0.55,
      });
    }
    this.drips = [];

    this.spawnParts();
  }

  // laser x3 a second apart, a breath, then two waves of grasping arms.
  static buildScript() {
    return [
      { a: 'laser' }, { wait: 1.0 },
      { a: 'laser' }, { wait: 1.0 },
      { a: 'laser' }, { wait: 1.2 },
      { a: 'hand' }, { wait: 1.0 },
      { a: 'hand' },
    ];
  }

  get parts() { return [this.body, ...(this.hands ?? []).map((h) => h.part)].filter(Boolean); }

  spawnParts() {
    const d = this.def;
    this.body = new MeatPart('ceilingBody', this.x, this.y + d.h, this.game, this);
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
    this.beam = null;
    this.crush = null;
    if (this.body) this.body.dead = true;
    for (const h of this.hands ?? []) { if (h.part) h.part.dead = true; }
    this.hands = null;
    Camera.add(16);
    this.game.hitstop(0.24);
    screenFlash(0.5, '#ff8a9a', 0.4);
    Sfx.die();
    for (let i = 0; i < 5; i++) {
      const x = rand(40, VIEW_W - 40);
      burst(x, this.slabBottom() - rand(0, 16), 22, {
        color: TINT.flesh, color2: TINT.vein, speedMin: 40, speedMax: 240,
        lifeMin: 0.4, lifeMax: 1.3, sizeMax: 3, gravity: 420, drag: 0.92,
      });
    }
    impactRing(this.x, this.slabBottom(), { color: TINT.vein, r0: 8, r1: 300, life: 0.8, width: 4 });
    this.game.onBossDefeated(this);
    this.game.onEnemyKilled(this.body);
  }

  // The underside of the slab at a given x, belly and all.
  slabBottom(x = this.x) {
    const d = this.def;
    const k = clamp(1 - Math.abs(x - VIEW_W / 2) / (VIEW_W / 2), 0, 1);
    return this.y + d.h + this.sag + Math.sin(this.pulse) * 2 + k * 6;
  }

  // --- script ------------------------------------------------------------

  nextStep() {
    // once the fight has dragged past its limit, every cycle ends in a crush
    if (this.crushArmed && this.step >= this.script.length - 1) {
      this.step = -1;
      this.startCrush();
      return;
    }
    this.step = (this.step + 1) % this.script.length;
    const s = this.script[this.step];
    this.stateT = 0;
    if (s.wait !== undefined) {
      this.state = 'idle';
      this.waitT = s.wait * (this.def.pace ?? 1);
      return;
    }
    if (s.a === 'laser') { this.state = 'laser'; this.beam = null; }
    else if (s.a === 'hand') { this.state = 'hand'; this.startHand(); }
  }

  update(dt) {
    if (this.dead) return;
    const p = this.game.player;
    this.stateT += dt;
    this.fightT += dt;
    this.pulse += dt * 1.5;

    if (!this.crushArmed && this.fightT >= this.def.crushAfter) {
      this.crushArmed = true;
      // it notices how long this is taking
      Camera.add(9);
      screenFlash(0.24, '#ff6a7a', 0.3);
      Sfx.wave();
      floatText(VIEW_W / 2, 40, 'IT IS DONE WAITING', TINT.beam, { life: 1.8, vy: -6 });
    }

    // the slab breathes, and slumps a little lower when it is winding up. A
    // crush drives Y directly - nothing about it should lag behind.
    if (this.crush) {
      this.y = this.crush.y;
    } else {
      const want = this.restY + (this.state === 'laser' || this.state === 'hand' ? 5 : 0);
      this.y = lerp(this.y, want, 1 - Math.pow(0.02, dt));
    }
    this.sag = lerp(this.sag, this.state === 'idle' ? 3 : 6, 1 - Math.pow(0.05, dt));
    if (this.body) {
      this.body.x = this.x;
      this.body.y = this.slabBottom();
    }

    this.updateBeam(dt);
    this.updateHand(dt);
    this.updateCrush(dt);
    this.updateDrips(dt);
    this.ambient(dt);

    if (this.crush) return;                 // a crush owns the whole boss
    switch (this.state) {
      case 'idle':
        this.waitT -= dt;
        if (this.waitT <= 0) this.nextStep();
        break;
      case 'laser':
        if (!this.beam && this.stateT > 0.05) this.startBeam();
        break;
      case 'hand':
        break;                              // updateHand advances it
    }
  }

  cinematicUpdate(dt) {
    this.pulse += dt * 1.2;
    if (this.dead) { this.deathT += dt; this.y += 26 * dt; }
    if (this.body) this.body.y = this.slabBottom();
    this.updateDrips(dt);
    this.ambient(dt);
  }

  ambient(dt) {
    for (const s of this.strands) s.p += dt * s.s;
    // it weeps
    if (Math.random() < dt * 6) {
      const x = rand(10, VIEW_W - 10);
      this.drips.push({ x, y: this.slabBottom(x), vy: rand(10, 40) });
    }
    if (Math.random() < dt * 10) {
      const x = rand(10, VIEW_W - 10);
      spawnParticle({
        x, y: this.slabBottom(x), vx: rand(-6, 6), vy: rand(6, 26),
        life: rand(0.4, 1.0), size: 1, color: TINT.vein, gravity: 180, drag: 0.98, kind: 'shrink',
      });
    }
  }

  updateDrips(dt) {
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i];
      d.vy += 420 * dt;
      d.y += d.vy * dt;
      if (d.y >= GROUND_Y) {
        this.drips.splice(i, 1);
        burst(d.x, GROUND_Y, 4, {
          color: TINT.flesh, speedMin: 10, speedMax: 60, lifeMin: 0.15, lifeMax: 0.4,
          gravity: 300, angle: -Math.PI / 2, spread: 1.2,
        });
      }
    }
  }

  // --- the stare ---------------------------------------------------------

  startBeam() {
    const cfg = this.def.laser;
    const p = this.game.player;
    this.beam = {
      charge: cfg.windUp, t: 0,
      // it tracks only while the eye is opening; the shot itself is a fixed line
      tx: p.x, ty: p.y - p.h / 2,
      tick: 0,
    };
    Sfx.zap();
  }

  eyePos() {
    return { x: this.x, y: this.slabBottom() - this.def.h * 0.34 };
  }

  updateBeam(dt) {
    const b = this.beam;
    if (!b) return;
    const cfg = this.def.laser;
    const p = this.game.player;
    const o = this.eyePos();

    if (b.charge > 0) {
      // the pupil follows you right up until it fires
      b.tx = lerp(b.tx, p.x, 1 - Math.pow(0.02, dt));
      b.ty = lerp(b.ty, p.y - p.h / 2, 1 - Math.pow(0.02, dt));
      const was = b.charge;
      b.charge -= dt;
      if (Math.random() < dt * 40) {
        const a = rand(0, TAU);
        spawnParticle({
          x: o.x + Math.cos(a) * 24, y: o.y + Math.sin(a) * 24,
          vx: -Math.cos(a) * 80, vy: -Math.sin(a) * 80, life: 0.28,
          size: 1, color: TINT.beam, gravity: 0, kind: 'shrink',
        });
      }
      if (was > 0 && b.charge <= 0) {
        // locked: from here the beam is a fixed line and never follows again
        Sfx.slam();
        Camera.add(9);
        Camera.punch(1.6);
        screenFlash(0.26, '#ff8a9a', 0.18);
        impactRing(o.x, o.y, { color: TINT.beamHot, r0: 3, r1: 90, life: 0.3, width: 3 });
      }
      return;
    }

    b.t += dt;
    // the floor takes the rest of the beam, so it always reads as a full line
    const ang = Math.atan2(b.ty - o.y, b.tx - o.x);
    b.ex = o.x + Math.cos(ang) * 900;
    b.ey = o.y + Math.sin(ang) * 900;
    b.ang = ang;

    b.tick -= dt;
    if (b.tick <= 0 && !p.dead) {
      b.tick = cfg.tick;
      if (distToSegment(p.x, p.y - p.h / 2, o.x, o.y, b.ex, b.ey) < cfg.width / 2 + 4) {
        p.hurt(Math.round(cfg.tickDamage * this.dmgScale), o.x);
      }
    }
    if (Math.random() < dt * 90) {
      const k = Math.random();
      spawnParticle({
        x: lerp(o.x, b.ex, k * 0.4), y: lerp(o.y, b.ey, k * 0.4),
        vx: rand(-60, 60), vy: rand(-60, 60), life: rand(0.1, 0.3),
        size: 1, color: Math.random() < 0.4 ? TINT.beamHot : TINT.beam,
        gravity: 0, kind: 'line',
      });
    }
    // scorch where it lands
    const hitY = GROUND_Y;
    if (Math.sin(ang) > 0.05) {
      const tHit = (hitY - o.y) / Math.sin(ang);
      const hx = o.x + Math.cos(ang) * tHit;
      if (hx > -20 && hx < VIEW_W + 20 && Math.random() < dt * 50) {
        spawnParticle({
          x: hx + rand(-3, 3), y: hitY, vx: rand(-70, 70), vy: rand(-160, -50),
          life: rand(0.2, 0.5), size: 1, color: TINT.beamHot, gravity: 420, drag: 0.92, kind: 'streak',
        });
      }
      b.hx = hx;
    }

    if (b.t >= cfg.duration) {
      this.beam = null;
      if (this.state === 'laser') this.nextStep();
    }
  }

  // --- the arm -----------------------------------------------------------

  // Five arms at once, from five places along the slab. One of them comes for
  // you; the rest come down where you might run, staggered so the room fills
  // up a limb at a time.
  startHand() {
    const cfg = this.def.hand;
    const p = this.game.player;
    const n = cfg.count;
    this.hands = [];
    // evenly spaced anchors, jittered, with one placed right over the player
    const slots = [];
    for (let i = 0; i < n; i++) {
      slots.push(clamp(28 + (i + 0.5) * ((VIEW_W - 56) / n) + rand(-14, 14), 24, VIEW_W - 24));
    }
    // whichever anchor is nearest becomes the one that actually hunts you
    let hunter = 0, best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(slots[i] - p.x);
      if (d < best) { best = d; hunter = i; }
    }
    slots[hunter] = clamp(p.x, 24, VIEW_W - 24);

    for (let i = 0; i < n; i++) {
      const ox = slots[i];
      const oy = this.slabBottom(ox);
      // the hunter tracks you; the others commit to their own patch of floor
      const tx = i === hunter ? p.x : ox + rand(-18, 18);
      const ty = i === hunter ? p.y - p.h / 2 : GROUND_Y - 14;
      const h = {
        phase: 'grow', t: -i * cfg.stagger,
        ox, oy, x: ox, y: oy, tx, ty,
        hunter: i === hunter, hit: false, part: null,
      };
      h.part = new MeatPart('ceilingHand', ox, oy, this.game, this);
      this.game.enemies.push(h.part);
      this.hands.push(h);
      impactRing(ox, oy, { color: TINT.vein, r0: 3, r1: 40, life: 0.35, width: 2, squash: 0.5 });
      burst(ox, oy, 14, {
        color: TINT.flesh, color2: TINT.vein, speedMin: 30, speedMax: 150,
        lifeMin: 0.25, lifeMax: 0.7, gravity: 320, angle: Math.PI / 2, spread: 1.2,
      });
    }
    Sfx.swing();
    Camera.add(5);
  }

  updateHand(dt) {
    if (!this.hands || !this.hands.length) return;
    for (let i = this.hands.length - 1; i >= 0; i--) {
      if (this.updateOneHand(this.hands[i], dt)) this.hands.splice(i, 1);
    }
    if (!this.hands.length) {
      this.hands = null;
      if (this.state === 'hand') this.nextStep();
    }
  }

  // Returns true once this arm is finished and should be dropped.
  updateOneHand(h, dt) {
    const cfg = this.def.hand;
    const p = this.game.player;
    h.t += dt;
    if (h.t < 0) return false;                 // still waiting its turn
    h.oy = this.slabBottom(h.ox);

    if (h.phase === 'grow') {
      // the hunter keeps adjusting while it forms; the rest have already chosen
      if (h.hunter) {
        h.tx = lerp(h.tx, p.x, 1 - Math.pow(0.05, dt));
        h.ty = lerp(h.ty, p.y - p.h / 2, 1 - Math.pow(0.05, dt));
      }
      const k = clamp(h.t / cfg.windUp, 0, 1);
      h.x = h.ox;
      h.y = h.oy + k * 22;
      if (Math.random() < dt * 40) {
        spawnParticle({
          x: h.x + rand(-10, 10), y: h.y + rand(-6, 6), vx: rand(-20, 20), vy: rand(0, 40),
          life: rand(0.2, 0.5), size: randInt(1, 2), color: TINT.vein, gravity: 240, kind: 'shrink',
        });
      }
      if (h.t >= cfg.windUp) { h.phase = 'punch'; h.t = 0; h.hit = false; Sfx.slam(); }
      if (h.part) { h.part.x = h.x; h.part.y = h.y + cfg.h / 2; }
      return false;
    } else if (h.phase === 'punch') {
      const k = clamp(h.t / cfg.punchTime, 0, 1);
      const ease = 1 - Math.pow(1 - k, 4);
      h.x = lerp(h.ox, h.tx, ease);
      h.y = lerp(h.oy + 22, h.ty, ease);
      if (!h.hit && !p.dead && dist(h.x, h.y, p.x, p.cy) < 20) {
        h.hit = true;
        p.hurt(Math.round(cfg.damage * this.dmgScale), h.x);
        Camera.add(8);
        Camera.punch(1.4);
        screenFlash(0.2, '#ff5c7a', 0.16);
        impactRing(h.x, h.y, { color: TINT.vein, r0: 3, r1: 54, life: 0.32, width: 3 });
      }
      if (k >= 1) { h.phase = 'hold'; h.t = 0; }
    } else if (h.phase === 'hold') {
      if (h.t >= cfg.holdTime) { h.phase = 'retract'; h.t = 0; }
    } else {
      const k = clamp(h.t / cfg.retract, 0, 1);
      h.x = lerp(h.tx, h.ox, k);
      h.y = lerp(h.ty, h.oy, k);
      if (k >= 1) {
        if (h.part) { h.part.dead = true; h.part = null; }
        burst(h.ox, h.oy, 12, {
          color: TINT.flesh, speedMin: 20, speedMax: 110, lifeMin: 0.25, lifeMax: 0.6,
          gravity: 320, angle: Math.PI / 2, spread: 1.1,
        });
        return true;
      }
    }
    if (h.part) {
      h.part.x = h.x;
      h.part.y = h.y + cfg.h / 2;
    }
    return false;
  }

  // --- the crush ---------------------------------------------------------

  startCrush() {
    const cfg = this.def.crush;
    this.state = 'crush';
    this.stateT = 0;
    this.beam = null;
    this.crush = { phase: 'wind', t: 0, y: this.restY, hit: false };
    Sfx.wave();
    Camera.add(6);
  }

  updateCrush(dt) {
    const c = this.crush;
    if (!c) return;
    const cfg = this.def.crush;
    const p = this.game.player;
    c.t += dt;

    if (c.phase === 'wind') {
      // it draws up into the roof, and the whole room shakes
      c.y = this.restY - 10 * (c.t / cfg.windUp);
      if (Math.random() < dt * 30) Camera.add(0.6);
      if (Math.random() < dt * 60) {
        const x = rand(0, VIEW_W);
        spawnParticle({
          x, y: this.slabBottom(x), vx: rand(-10, 10), vy: rand(20, 70),
          life: rand(0.3, 0.7), size: randInt(1, 2), color: Theme.groundEdge,
          gravity: 260, kind: 'shrink',
        });
      }
      if (c.t >= cfg.windUp) { c.phase = 'fall'; c.t = 0; }
      return;
    }

    if (c.phase === 'fall') {
      c.y += cfg.fallSpeed * dt;
      this.y = c.y;                          // so the check below sees this frame
      const floorY = GROUND_Y - this.def.h - 4;
      // anything the underside reaches is flattened, once, through everything
      if (!c.hit && !p.dead && this.slabBottom(p.x) >= p.y - p.h) {
        c.hit = true;
        this.flatten(p);
      }
      if (c.y >= floorY) {
        c.y = floorY;
        c.phase = 'hold';
        c.t = 0;
        Sfx.slam();
        Camera.add(18);
        Camera.punch(3.0);
        this.game.hitstop(0.11);
        screenFlash(0.42, '#ff8a9a', 0.26);
        this.game.shockwaves.push({ x: VIEW_W / 2, y: GROUND_Y, t: 0, r: VIEW_W });
        for (let i = 0; i < 7; i++) {
          const x = 20 + i * ((VIEW_W - 40) / 6);
          burst(x, GROUND_Y, 20, {
            color: TINT.flesh, color2: Theme.groundEdge, speedMin: 60, speedMax: 260,
            lifeMin: 0.25, lifeMax: 0.8, sizeMax: 3, gravity: 460,
            angle: -Math.PI / 2, spread: 1.1,
          });
          impactRing(x, GROUND_Y, { color: TINT.vein, r0: 4, r1: 70, life: 0.4, width: 2, squash: 0.3 });
        }
      }
      return;
    }

    if (c.phase === 'hold') {
      if (!c.hit && !p.dead && this.slabBottom(p.x) >= p.y - p.h) {
        c.hit = true;
        this.flatten(p);
      }
      if (c.t >= cfg.hold) { c.phase = 'rise'; c.t = 0; }
      return;
    }

    // rise: slow, and it is open the whole way up
    c.y -= cfg.riseSpeed * dt;
    if (c.y <= this.restY) {
      this.crush = null;
      this.state = 'idle';
      this.waitT = 1.0;
      this.step = -1;
    }
  }

  // The crush is not damage you take, it is the clock running out. It goes
  // straight past shields, invulnerability frames and dashes.
  flatten(p) {
    const cfg = this.def.crush;
    Camera.add(14);
    Camera.punch(2.6);
    screenFlash(0.45, '#ff5c7a', 0.3);
    burst(p.x, p.cy, 46, {
      color: '#c0323f', color2: '#ff8a9a', speedMin: 60, speedMax: 300,
      lifeMin: 0.3, lifeMax: 1.0, sizeMax: 3, gravity: 460, drag: 0.9,
    });
    floatText(p.x, p.cy - 12, cfg.damage, '#ff5c7a', { crit: true, life: 1.2 });
    if (p.dead) return;
    // bypass the shield and every guard the player has
    p.shield = 0;
    p.invuln = 0;
    p.dashT = 0;
    if (this.game.debug && (this.game.debug.god || this.game.debug.infHealth)) return;
    p.hp = 0;
    p.die();
  }

  // --- art ---------------------------------------------------------------

  // Normally the slab lives at the top of the frame, well clear of the player.
  // While it is coming down it has to be drawn over everything instead, so the
  // crush reads as the room closing on you.
  draw(ctx) { if (!this.crush) this.drawAll(ctx); }
  drawBeams(ctx) { if (this.crush) this.drawAll(ctx); }

  drawAll(ctx) {
    let dying = 0;
    if (this.dead) {
      dying = clamp(this.deathT / 3.0, 0, 1);
      if (dying >= 1) return;
    }
    const t = this.body ? this.body.anim : 0;
    const flash = this.body && this.body.hurtFlash > 0;
    const d = this.def;

    ctx.save();
    if (dying > 0) ctx.globalAlpha = 1 - dying;

    this.drawSlab(ctx, t, flash);
    this.drawStrands(ctx, t);
    this.drawEye(ctx, t, flash);
    this.drawHands(ctx, t, flash);
    this.drawBeam(ctx);
    this.drawDrips(ctx);
    ctx.restore();
  }

  drawSlab(ctx, t, flash) {
    const d = this.def;
    // Everything above the underside is flesh, all the way past the top of the
    // screen, so a crush never exposes the room behind it.
    const top = Math.min(-VIEW_H, this.y - VIEW_H);
    const bottomMid = this.slabBottom(VIEW_W / 2);

    // the meat itself: a filled band whose lower edge bulges between lobes
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-8, top);
    ctx.lineTo(VIEW_W + 8, top);
    for (let x = VIEW_W + 8; x >= -8; x -= 6) {
      ctx.lineTo(x, this.slabBottom(x) + Math.sin(x * 0.09 + this.pulse) * 2);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(0, this.y - 34, 0, bottomMid);
    g.addColorStop(0, flash ? '#ffffff' : '#28101a');
    g.addColorStop(0.35, flash ? '#ffcccc' : TINT.fleshDeep);
    g.addColorStop(0.72, flash ? '#ffdddd' : TINT.flesh);
    g.addColorStop(1, flash ? '#ffffff' : TINT.fleshLit);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();

    // lobes: swollen sacs that breathe out of phase with each other
    for (const lo of this.lobes) {
      const r = lo.r * (0.9 + 0.12 * Math.sin(this.pulse * lo.s + lo.p));
      const cy = this.slabBottom(lo.x) - r * 0.55;
      const lg = ctx.createRadialGradient(lo.x, cy - r * 0.3, 1, lo.x, cy, r);
      lg.addColorStop(0, rgba(TINT.fleshLit, 0.9));
      lg.addColorStop(0.7, rgba(TINT.flesh, 0.5));
      lg.addColorStop(1, rgba(TINT.fleshDeep, 0));
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lo.x, cy, r, 0, TAU);
      ctx.fill();
      pxRect(ctx, lo.x - 1, cy - r * 0.45, 2, 2, rgba(TINT.sinew, 0.5));
    }

    // veins crawling across it
    const veinTop = Math.max(top, this.y - VIEW_H);
    for (let i = 0; i < 40; i++) {
      const y0 = veinTop + i * 11;
      if (y0 > bottomMid) break;
      // the ones nearer the underside are lit; the deep ones almost vanish
      const depth = clamp((y0 - veinTop) / Math.max(1, bottomMid - veinTop), 0, 1);
      ctx.strokeStyle = rgba(TINT.vein, 0.10 + depth * 0.34);
      ctx.lineWidth = i % 3 === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(-8, y0);
      for (let x = 0; x <= VIEW_W + 8; x += 12) {
        ctx.lineTo(x, y0 + Math.sin(x * 0.05 + i * 1.7 + this.pulse * 0.5) * 5);
      }
      ctx.stroke();
    }
    // mottling deeper in the meat, so the bulk is not one flat sheet
    for (const m of this.mottle) {
      const my = veinTop + m.y * Math.max(1, bottomMid - veinTop);
      if (my > bottomMid) continue;
      const r = m.r * (0.9 + 0.12 * Math.sin(this.pulse * m.s + m.p));
      const mg = ctx.createRadialGradient(m.x, my, 1, m.x, my, r);
      mg.addColorStop(0, rgba(m.dark ? '#3a1018' : TINT.fleshLit, 0.30));
      mg.addColorStop(1, rgba(m.dark ? '#3a1018' : TINT.fleshLit, 0));
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.arc(m.x, my, r, 0, TAU);
      ctx.fill();
    }
    // a wet rim along the bottom edge
    ctx.strokeStyle = rgba(TINT.sinew, 0.55);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = -8; x <= VIEW_W + 8; x += 5) {
      const y = this.slabBottom(x) + Math.sin(x * 0.09 + this.pulse) * 2;
      if (x === -8) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawStrands(ctx, t) {
    for (const s of this.strands) {
      const y0 = this.slabBottom(s.x);
      const sway = Math.sin(s.p) * 3;
      ctx.strokeStyle = rgba(TINT.sinew, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, y0);
      ctx.quadraticCurveTo(s.x + sway, y0 + s.len * 0.6, s.x + sway * 1.6, y0 + s.len);
      ctx.stroke();
      pxRect(ctx, s.x + sway * 1.6, y0 + s.len, 1, 1, rgba(TINT.vein, 0.7));
    }
  }

  drawEye(ctx, t, flash) {
    const o = this.eyePos();
    const d = this.def;
    const p = this.game.player;
    const charging = this.beam && this.beam.charge > 0;
    const firing = this.beam && this.beam.charge <= 0;
    // the lid opens as it winds up and stays open while it fires
    const open = clamp(
      charging ? 1 - this.beam.charge / d.laser.windUp
        : firing ? 1
          : 0.74 + 0.10 * Math.sin(this.pulse * 0.8), 0, 1);
    const r = d.eyeR * (0.85 + open * 0.3);

    // the glow sits behind the eye, so the pupil is always readable
    if (charging || firing) {
      glowDot(ctx, o.x, o.y, 34 + open * 30, TINT.beam, 0.22 + open * 0.20);
    } else {
      glowDot(ctx, o.x, o.y, 20, TINT.iris, 0.12);
    }

    // socket
    ctx.save();
    ctx.fillStyle = TINT.fleshDeep;
    ctx.beginPath();
    ctx.ellipse(o.x, o.y, r + 5, r + 5, 0, 0, TAU);
    ctx.fill();
    // sclera, squashed by the lid
    ctx.beginPath();
    ctx.ellipse(o.x, o.y, r, r * (0.35 + open * 0.65), 0, 0, TAU);
    ctx.clip();
    ctx.fillStyle = flash ? '#ffffff' : TINT.sclera;
    ctx.fillRect(o.x - r - 2, o.y - r - 2, r * 2 + 4, r * 2 + 4);
    // bloodshot
    ctx.strokeStyle = rgba('#c0323f', 0.55);
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + this.pulse * 0.1;
      ctx.beginPath();
      ctx.moveTo(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
      ctx.lineTo(o.x + Math.cos(a + 0.4) * r * 0.35, o.y + Math.sin(a + 0.4) * r * 0.35);
      ctx.stroke();
    }
    // iris, looking at whatever it is about to burn
    const look = this.beam ? { x: this.beam.tx, y: this.beam.ty } : { x: p.x, y: p.cy };
    const la = Math.atan2(look.y - o.y, look.x - o.x);
    const lr = Math.min(r * 0.42, 6);
    const ix = o.x + Math.cos(la) * lr;
    const iy = o.y + Math.sin(la) * lr;
    const ir = r * 0.46;
    const ig = ctx.createRadialGradient(ix, iy, 1, ix, iy, ir);
    ig.addColorStop(0, charging || firing ? TINT.beamHot : TINT.iris);
    ig.addColorStop(1, charging || firing ? TINT.beam : '#b07a10');
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, TAU);
    ctx.fill();
    ctx.fillStyle = TINT.pupil;
    ctx.beginPath();
    ctx.arc(ix, iy, ir * (charging ? 0.28 : 0.46), 0, TAU);
    ctx.fill();
    pxRect(ctx, ix - ir * 0.5, iy - ir * 0.6, 2, 2, rgba('#ffffff', 0.85));
    ctx.restore();

    // the socket already reads as the lid; all it needs is a wet edge along it
    const eyeHalf = r * (0.35 + open * 0.65);
    ctx.strokeStyle = rgba(TINT.sinew, 0.75);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(o.x, o.y, r, eyeHalf, 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba(TINT.fleshDeep, 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(o.x, o.y, r + 2, eyeHalf + 2, 0, 0, TAU);
    ctx.stroke();
    // lashes of sinew radiating off the rim
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const ex = o.x + Math.cos(a) * r, ey = o.y + Math.sin(a) * eyeHalf;
      pxRect(ctx, ex + Math.cos(a) * 2, ey + Math.sin(a) * 2, 1, 1, rgba(TINT.sinew, 0.5));
    }

    // a thin hot rim over the top, never enough to swallow the eye
    if (charging || firing) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(TINT.beamHot, 0.35 + open * 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(o.x, o.y, r + 1, r * (0.35 + open * 0.65) + 1, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBeam(ctx) {
    const b = this.beam;
    if (!b) return;
    const cfg = this.def.laser;
    const o = this.eyePos();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    if (b.charge > 0) {
      const k = 1 - b.charge / cfg.windUp;
      // the sight line, closing in on where it will lock
      ctx.strokeStyle = rgba(TINT.beam, 0.15 + 0.5 * k);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4 - k * 2]);
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(b.tx, b.ty);
      ctx.stroke();
      ctx.setLineDash([]);
      // a shrinking reticle on the spot it has chosen
      const rr = 22 - k * 14;
      ctx.strokeStyle = rgba(TINT.beamHot, 0.35 + k * 0.5);
      ctx.lineWidth = 1;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(b.tx, b.ty, rr, s > 0 ? -0.7 : Math.PI - 0.7, s > 0 ? 0.7 : Math.PI + 0.7);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    const fade = clamp(Math.min(b.t * 12, (cfg.duration - b.t) * 12), 0, 1);
    const w = cfg.width * fade;
    // it leaves from the lower lid, not from the pupil, so the eye stays visible
    const sx = o.x + Math.cos(b.ang) * (this.def.eyeR + 3);
    const sy = o.y + Math.sin(b.ang) * (this.def.eyeR + 3);
    const layers = [[w * 6, 0.10, TINT.beam], [w * 3, 0.24, TINT.beam],
                    [w * 1.5, 0.55, TINT.beamHot], [w * 0.6, 1, '#ffffff']];
    for (const [lw, la, col] of layers) {
      ctx.strokeStyle = rgba(col, la * fade);
      ctx.lineWidth = Math.max(1, lw);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(b.ex, b.ey);
      ctx.stroke();
    }
    // a tight flare where it leaves the eye, and a wobble in the shaft
    glowDot(ctx, sx, sy, 16 * fade, TINT.beamHot, 0.5 * fade);
    ctx.strokeStyle = rgba('#ffffff', 0.35 * fade);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const k = i / 12;
      const px = lerp(sx, b.ex, k) + Math.cos(b.ang + Math.PI / 2) * Math.sin(k * 22 - b.t * 26) * 3 * (1 - k);
      const py = lerp(sy, b.ey, k) + Math.sin(b.ang + Math.PI / 2) * Math.sin(k * 22 - b.t * 26) * 3 * (1 - k);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
    if (b.hx !== undefined) {
      const flick = 0.75 + 0.25 * Math.sin(b.t * 44);
      glowDot(ctx, b.hx, GROUND_Y, 30 * fade * flick, TINT.beam, 0.5 * fade);
      glowDot(ctx, b.hx, GROUND_Y, 12 * fade, '#ffffff', 0.75 * fade);
    }
  }

  drawHands(ctx, t, flash) {
    for (const h of this.hands ?? []) {
      if (h.t < 0) continue;
      this.drawOneHand(ctx, t, flash, h);
    }
  }

  drawOneHand(ctx, t, flash, h) {
    const cfg = this.def.hand;
    const grow = h.phase === 'grow' ? clamp(h.t / cfg.windUp, 0, 1) : 1;

    // the arm: a tapering tube of muscle from the ceiling to the wrist
    const segs = 9;
    let px = h.ox, py = h.oy;
    for (let i = 1; i <= segs; i++) {
      const k = i / segs;
      const cxp = lerp(h.ox, h.x, k) + Math.sin(this.pulse * 2 + k * 5) * (1 - k) * 4;
      const cyp = lerp(h.oy, h.y, k);
      const th = lerp(13, 7, k) * (0.4 + grow * 0.6);
      const ang = Math.atan2(cyp - py, cxp - px);
      const len = Math.max(1, Math.hypot(cxp - px, cyp - py));
      limb(ctx, px, py, ang, len, th, k < 0.5 ? TINT.flesh : TINT.fleshLit, 1.4);
      if (i % 2 === 0) pxRect(ctx, cxp - 1, cyp - 1, 2, 2, rgba(TINT.vein, 0.6));
      px = cxp; py = cyp;
    }

    // the hand: a palm and four crooked fingers, splayed as it strikes
    const punchK = h.phase === 'punch' ? clamp(h.t / cfg.punchTime, 0, 1) : h.phase === 'grow' ? 0 : 1;
    const spread = 0.35 + punchK * 0.55;
    const toward = Math.atan2(h.y - h.oy, h.x - h.ox);
    ctx.save();
    ctx.translate(Math.round(h.x), Math.round(h.y));
    ctx.rotate(toward - Math.PI / 2);
    const sc = 0.5 + grow * 0.5;
    ctx.scale(sc, sc);
    ctx.fillStyle = flash ? '#ffffff' : TINT.flesh;
    ctx.beginPath();
    ctx.ellipse(0, 0, 11, 9, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(TINT.fleshLit, 0.8);
    ctx.beginPath();
    ctx.ellipse(0, -2, 8, 6, 0, 0, TAU);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI / 2 + (i - 1.5) * spread;
      const fx = Math.cos(a) * 9, fy = Math.sin(a) * 9;
      limb(ctx, fx, fy, a, 11, 4, TINT.fleshLit, 1.6);
      pxRect(ctx, fx + Math.cos(a) * 12, fy + Math.sin(a) * 12, 2, 2, TINT.sinew);
    }
    ctx.restore();
    glowDot(ctx, h.x, h.y, 16, TINT.vein, 0.18 + punchK * 0.2);
  }

  drawDrips(ctx) {
    for (const d of this.drips) {
      pxRect(ctx, d.x, d.y, 1, 3, TINT.vein);
      pxRect(ctx, d.x, d.y + 3, 1, 1, rgba(TINT.sinew, 0.6));
    }
  }
}
