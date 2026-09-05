// Boss intro and outro cutscenes. The world keeps drawing underneath; this
// only pauses gameplay, drives the camera and paints the cinematic layer on
// top, so the boss stays on screen the whole time.
import { clamp, lerp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, impactRing, spawnParticle, pxRect, glowDot, screenFlash } from './gfx.js';
import { drawText, drawTextShadow, textWidth, fitScale } from './font.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GROUND_Y } from './config.js';

const INTRO_LEN = 4.6;
const OUTRO_LEN = 4.4;
const BAR_H = 34;

// eased 0..1 helpers
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeIn = (t) => Math.pow(clamp(t, 0, 1), 3);
const window01 = (t, a, b) => clamp((t - a) / Math.max(0.0001, b - a), 0, 1);

const SUBTITLE = {
  golem: 'ANCHOR OF THE DEEP VAULT',
  bigdude: 'TWENTY BLOCKS OF APPETITE',
  alphads: 'THE AETHER GOD',
  ceiling: 'THE ROOF OF MEAT',
  poitnus: 'THE ANCIENT STINGER',
};

export class Cutscene {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.type = null;
    this.t = 0;
    this.len = 0;
    this.boss = null;
    this.focus = { x: VIEW_W / 2, y: 150 };
    this.flash = 0;
    this.nextBoom = 0;
    this.booms = 0;
    this.roars = 0;        // how many of the staged shocks have gone off
    this.shafts = [];      // vertical light bars behind the name card
    this.streaks = [];     // radial speed lines thrown out by each shock
  }

  play(type, boss) {
    this.active = true;
    this.type = type;
    this.t = 0;
    this.len = type === 'intro' ? INTRO_LEN : OUTRO_LEN;
    this.boss = boss;
    this.booms = 0;
    this.nextBoom = 0.35;
    this.roars = 0;
    this.shafts.length = 0;
    this.streaks.length = 0;
    // the bars that stand up behind the name, each on its own clock
    for (let i = 0; i < 9; i++) {
      this.shafts.push({ x: rand(0, VIEW_W), w: rand(4, 22), delay: rand(0.5, 1.5), speed: rand(0.9, 2.0) });
    }
    this.roared = false;
    this.finalFlash = false;
    this.flash = type === 'outro' ? 1 : 0;
    this.title = (boss?.name ?? 'BOSS').toUpperCase();
    this.subtitle = SUBTITLE[boss?.def?.id] ?? '';
    this.focus = this.bossFocus();
    Camera.setCinematic(type === 'intro' ? 1.13 : 1.16, this.focus.x, this.focus.y);
    Camera.add(type === 'intro' ? 8 : 14);
    if (type === 'outro') this.game.hitstop(0.2);
    Sfx.wave();
  }

  bossFocus() {
    const b = this.boss;
    if (!b) return { x: VIEW_W / 2, y: 150 };
    if (b.kind === 'ceiling') {
      return { x: VIEW_W / 2, y: clamp(b.slabBottom() + 26, 60, GROUND_Y - 40) };
    }
    if (b.kind === 'worm') {
      return { x: clamp(b.hx, 90, VIEW_W - 90), y: clamp(Math.min(b.hy, GROUND_Y - 30) + 40, 70, GROUND_Y - 20) };
    }
    const body = b.body;
    return {
      x: clamp(body ? body.x : VIEW_W / 2, 90, VIEW_W - 90),
      y: (body ? body.y - body.h / 2 : 150) - 6,
    };
  }

  finish() {
    this.active = false;
    this.flash = 0;
    Camera.clearCinematic();
    // A boss you summoned yourself does not own the room, so the room takes
    // its slot back once the outro is over.
    if (this.type === 'outro' && this.boss?.summoned && this.game.boss === this.boss) {
      this.game.boss = null;
    }
    if (this.type === 'intro' && this.boss) {
      this.boss.intro = 0.25;
      // the worm dives back under before its pattern starts
      if (this.boss.kind === 'worm') {
        this.boss.state = 'wait';
        this.boss.stateT = 0;
        this.boss.stateDur = 0.6;
        this.boss.vy = 420;
      }
    }
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt * 2.6);
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const k = this.streaks[i];
      k.t += dt;
      k.r += 260 * dt;
      if (k.t >= k.life) this.streaks.splice(i, 1);
    }

    // keep the frame on the boss even as it moves through its entrance
    const f = this.bossFocus();
    this.focus.x = lerp(this.focus.x, f.x, 1 - Math.pow(0.05, dt));
    this.focus.y = lerp(this.focus.y, f.y, 1 - Math.pow(0.05, dt));
    const push = this.type === 'intro'
      ? lerp(1.02, 1.16, easeOut(this.t / 2.2))
      : lerp(1.20, 1.05, easeOut(this.t / this.len));
    Camera.setCinematic(push, this.focus.x, this.focus.y);

    if (this.type === 'intro') this.updateIntro(dt);
    else this.updateOutro(dt);

    if (this.t >= this.len) this.finish();
  }

  get holy() { return this.boss?.kind === 'god'; }

  // Three shocks, not one, each bigger than the last, so the entrance builds
  // instead of going off once and then just waiting for the timer.
  static ROAR_AT = [0.45, 1.15, 1.95];

  roar(n) {
    const holy = this.holy;
    const k = 0.55 + n * 0.42;                 // 0.55, 0.97, 1.39
    const last = n === 2;
    const c = holy ? '#ffd76a' : Theme.hp;
    Camera.add((holy ? 8 : 11) * k);
    Camera.punch((holy ? 1.7 : 2.2) * k);
    Sfx.slam();
    if (last) {
      this.game.hitstop(0.14);
      screenFlash(0.55, holy ? '#ffe9a8' : '#ffffff', 0.35);
    }
    impactRing(this.focus.x, this.focus.y, { color: c, r0: 8, r1: (holy ? 180 : 130) * k, life: 0.8, width: 4 });
    impactRing(this.focus.x, this.focus.y, { color: '#ffffff', r0: 4, r1: (holy ? 110 : 80) * k, life: 0.45, width: 2.5 });
    burst(this.focus.x, this.focus.y, Math.round((holy ? 40 : 30) * k), {
      color: holy ? '#ffe9a8' : Theme.uiAccent, color2: '#ffffff', kind: 'streak',
      speedMin: 120, speedMax: 340 * k, lifeMin: 0.2, lifeMax: 0.6, gravity: 0, drag: 0.9,
    });
    // a wave of dust thrown out along the floor either way
    for (const dir of [-1, 1]) {
      burst(this.focus.x, GROUND_Y, Math.round(9 * k), {
        color: Theme.groundEdge, kind: 'smoke', speedMin: 60 * k, speedMax: 230 * k,
        lifeMin: 0.4, lifeMax: 1.1, sizeMin: 1, sizeMax: 4, gravity: -30, glow: false,
        angle: dir > 0 ? -0.35 : Math.PI + 0.35, spread: 0.5,
      });
    }
    // speed lines drawn on the cinematic layer, over everything
    for (let i = 0; i < Math.round(14 * k); i++) {
      this.streaks.push({ a: rand(0, TAU), r: rand(20, 60), len: rand(24, 90) * k, life: rand(0.2, 0.45), t: 0 });
    }
    this.flash = (holy ? 0.6 : 0.42) * (0.7 + n * 0.3);
  }

  updateIntro(dt) {
    const holy = this.holy;
    // The god does not roar - it simply arrives - but it still lands in three
    // stages, and the room brightens harder each time.
    while (this.roars < 3 && this.t >= Cutscene.ROAR_AT[this.roars]) {
      this.roar(this.roars);
      this.roars++;
    }
    if (holy) {
      // feathers falling through the frame instead of embers rising
      if (Math.random() < dt * 30) {
        spawnParticle({
          x: rand(0, VIEW_W), y: rand(-10, 40), vx: rand(-16, 16), vy: rand(14, 40),
          life: rand(1.2, 2.4), size: 1, color: Math.random() < 0.4 ? '#ffd76a' : '#f6f1e4',
          gravity: 6, drag: 0.99, kind: 'shrink',
        });
      }
      return;
    }
    // embers drifting up through the frame the whole time
    if (Math.random() < dt * 26) {
      spawnParticle({
        x: rand(0, VIEW_W), y: GROUND_Y + rand(0, 10), vx: rand(-12, 12), vy: rand(-46, -14),
        life: rand(0.8, 1.8), size: 1, color: Theme.uiAccent, gravity: -6, kind: 'shrink',
      });
    }
  }

  updateOutro(dt) {
    this.game.postfx.slowmo = 1;
    if (this.holy) return this.updateAscension(dt);
    // a chain of detonations walking along the body
    this.nextBoom -= dt;
    if (this.nextBoom <= 0 && this.t < 3.1) {
      this.nextBoom = rand(0.13, 0.24);
      this.booms++;
      const p = this.boomPoint(this.booms);
      const big = this.booms % 4 === 0;
      Camera.add(big ? 9 : 4);
      Camera.punch(big ? 1.6 : 0.6);
      Sfx.slam();
      impactRing(p.x, p.y, { color: '#ffffff', r0: 3, r1: big ? 64 : 34, life: 0.35, width: big ? 3 : 2 });
      impactRing(p.x, p.y, { color: Theme.fire, r0: 2, r1: big ? 88 : 46, life: 0.5, width: 2 });
      burst(p.x, p.y, big ? 30 : 16, {
        color: Theme.fireHot, color2: Theme.fire, speedMin: 40, speedMax: big ? 250 : 150,
        lifeMin: 0.25, lifeMax: 0.9, sizeMax: 3, gravity: 260, drag: 0.9,
      });
      burst(p.x, p.y, big ? 12 : 6, {
        color: '#241a12', kind: 'smoke', speedMin: 15, speedMax: 80,
        lifeMin: 0.5, lifeMax: 1.3, sizeMin: 2, sizeMax: 5, gravity: -40, glow: false,
      });
      if (big) {
        this.flash = 0.55;
        for (let i = 0; i < 8; i++) {
          this.streaks.push({ a: rand(0, TAU), r: rand(20, 50), len: rand(20, 70), life: rand(0.2, 0.4), t: 0 });
        }
      }
    }
    // one last detonation that takes the whole frame with it
    if (!this.finalFlash && this.t >= 3.1) {
      this.finalFlash = true;
      this.flash = 1;
      Camera.add(16);
      Camera.punch(2.4);
      this.game.hitstop(0.16);
      screenFlash(0.8, '#ffffff', 0.55);
      Sfx.slam();
      impactRing(this.focus.x, this.focus.y, { color: '#ffffff', r0: 4, r1: 260, life: 0.9, width: 5 });
      impactRing(this.focus.x, this.focus.y, { color: Theme.fire, r0: 4, r1: 190, life: 0.7, width: 3 });
      burst(this.focus.x, this.focus.y, 46, {
        color: Theme.fireHot, color2: '#ffffff', kind: 'streak', speedMin: 90, speedMax: 420,
        lifeMin: 0.2, lifeMax: 0.7, gravity: 0, drag: 0.9,
      });
      for (let i = 0; i < 22; i++) {
        this.streaks.push({ a: rand(0, TAU), r: rand(10, 40), len: rand(40, 130), life: rand(0.3, 0.6), t: 0 });
      }
    }
  }

  // The speed lines every shock throws: short bright rays flying outward from
  // wherever the camera is looking.
  drawStreaks(ctx) {
    if (!this.streaks.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const k of this.streaks) {
      const a = clamp(1 - k.t / k.life, 0, 1);
      const c = Math.cos(k.a), s2 = Math.sin(k.a);
      ctx.strokeStyle = rgba(this.holy ? '#ffe9a8' : '#ffffff', a * 0.55);
      ctx.lineWidth = 1 + a * 1.6;
      ctx.beginPath();
      ctx.moveTo(this.focus.x + c * k.r, this.focus.y + s2 * k.r);
      ctx.lineTo(this.focus.x + c * (k.r + k.len * a), this.focus.y + s2 * (k.r + k.len * a));
      ctx.stroke();
    }
    ctx.restore();
  }

  // Bars of light standing up behind the name card, wiping on one by one.
  drawShafts(ctx, alpha) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.shafts) {
      const k = clamp((this.t - b.delay) * b.speed, 0, 1);
      if (k <= 0) continue;
      const fade = k * (1 - clamp((this.t - this.len + 1.1) / 1.1, 0, 1));
      const h = easeOut(k) * VIEW_H;
      const g = ctx.createLinearGradient(0, VIEW_H, 0, VIEW_H - h);
      g.addColorStop(0, rgba(this.holy ? '#ffd76a' : Theme.uiAccent, 0.20 * fade * alpha));
      g.addColorStop(1, rgba(this.holy ? '#ffd76a' : Theme.uiAccent, 0));
      ctx.fillStyle = g;
      ctx.fillRect(b.x - b.w / 2, VIEW_H - h, b.w, h);
    }
    ctx.restore();
  }

  // The god does not explode. Its wings come apart a row at a time and the
  // light it was holding goes back up through the ceiling.
  updateAscension(dt) {
    this.nextBoom -= dt;
    if (this.nextBoom <= 0 && this.t < 2.6) {
      this.nextBoom = rand(0.16, 0.3);
      this.booms++;
      const big = this.booms % 3 === 0;
      const x = this.focus.x + rand(-34, 34);
      const y = this.focus.y + rand(-30, 22);
      Camera.add(big ? 6 : 2.5);
      Camera.punch(big ? 1.1 : 0.4);
      Sfx.zap();
      impactRing(x, y, { color: '#ffffff', r0: 2, r1: big ? 80 : 40, life: 0.5, width: big ? 3 : 1.5 });
      impactRing(x, y, { color: '#ffd76a', r0: 2, r1: big ? 120 : 60, life: 0.7, width: 2 });
      burst(x, y, big ? 26 : 12, {
        color: '#f6f1e4', color2: '#ffd76a', speedMin: 20, speedMax: big ? 140 : 80,
        lifeMin: 0.5, lifeMax: 1.6, sizeMax: 2, gravity: -34, drag: 0.94, kind: 'shrink',
      });
      if (big) this.flash = 0.4;
    }
    // a steady column of light leaving through the top of the frame
    if (Math.random() < dt * 70) {
      spawnParticle({
        x: this.focus.x + rand(-26, 26), y: this.focus.y + rand(-10, 24),
        vx: rand(-10, 10), vy: rand(-150, -60), life: rand(0.6, 1.5),
        size: 1, color: Math.random() < 0.35 ? '#ffd76a' : '#ffffff',
        gravity: -40, drag: 0.98, kind: 'streak',
      });
    }
    if (this.t > this.len - 0.5 && !this.finalFlash) {
      this.finalFlash = true;
      this.flash = 1;
      Camera.add(12);
      Sfx.wave();
    }
  }

  boomPoint(n) {
    const b = this.boss;
    if (b && b.kind === 'worm' && b.segments?.length) {
      const s = b.segments[(n * 3) % b.segments.length];
      return { x: s.x + rand(-6, 6), y: Math.min(s.y, GROUND_Y - 4) + rand(-6, 6) };
    }
    return { x: this.focus.x + rand(-30, 30), y: this.focus.y + rand(-26, 26) };
  }

  // --- drawing ----------------------------------------------------------

  draw(ctx) {
    if (!this.active) return;
    const t = this.t;
    const inK = easeOut(window01(t, 0, 0.35));
    const outK = easeIn(window01(t, this.len - 0.55, this.len));
    const bars = Math.round(BAR_H * inK * (1 - outK));

    // dim the playfield a touch so the type reads
    ctx.fillStyle = rgba('#000000', 0.28 * inK * (1 - outK));
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    if (this.flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba('#ffffff', this.flash * 0.5);
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();
    }

    this.drawShafts(ctx, inK * (1 - outK));
    this.drawStreaks(ctx);
    if (this.type === 'intro') this.drawIntro(ctx, bars);
    else this.drawOutro(ctx, bars);

    // letterbox last, so nothing spills into the bars
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, VIEW_W, bars);
    ctx.fillRect(0, VIEW_H - bars, VIEW_W, bars);
    if (bars > 2) {
      pxRect(ctx, 0, bars - 1, VIEW_W, 1, rgba(Theme.uiAccent, 0.35));
      pxRect(ctx, 0, VIEW_H - bars, VIEW_W, 1, rgba(Theme.uiAccent, 0.35));
    }
  }

  drawIntro(ctx, bars) {
    const t = this.t;
    const cardK = window01(t, 0.7, 1.5);
    const holdK = 1 - window01(t, this.len - 0.8, this.len - 0.15);
    if (cardK <= 0 || holdK <= 0) return;

    const cy = 104;
    const sweep = easeOut(cardK);
    // the light streak that wipes the name in
    const streakX = lerp(-120, VIEW_W + 120, sweep);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(streakX - 90, 0, streakX + 90, 0);
    g.addColorStop(0, rgba(Theme.uiAccent, 0));
    g.addColorStop(0.5, rgba(Theme.uiAccent, 0.5 * (1 - sweep) + 0.12));
    g.addColorStop(1, rgba(Theme.uiAccent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, cy - 16, VIEW_W, 40);
    ctx.restore();

    // rules above and below the name, opening outward
    const ruleW = Math.round(lerp(0, 150, sweep));
    ctx.globalAlpha = holdK;
    pxRect(ctx, VIEW_W / 2 - ruleW, cy - 12, ruleW * 2, 1, rgba(Theme.uiAccent, 0.85));
    pxRect(ctx, VIEW_W / 2 - ruleW, cy + 26, ruleW * 2, 1, rgba(Theme.uiAccent, 0.85));

    // the name, letters dropping in one after another. A long one steps down
    // to whatever scale keeps it inside the frame instead of running off it.
    const scale = fitScale(this.title, VIEW_W - 28, 3);
    const w = textWidth(this.title, scale);
    for (let i = 0; i < this.title.length; i++) {
      const k = clamp((cardK * this.title.length - i) / 1.2, 0, 1);
      if (k <= 0) continue;
      const e = easeOut(k);
      const x = (VIEW_W - w) / 2 + i * 6 * scale;
      const y = cy - 6 + (1 - e) * -16;
      ctx.globalAlpha = holdK * e;
      // each letter lands with its own small shock, so the name arrives in
      // pieces instead of simply appearing
      if (k < 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        glowDot(ctx, x + 2 * scale, y + 3 * scale, 20 * (1 - e), '#ffffff', 0.5 * (1 - e) * holdK);
        ctx.restore();
      }
      drawText(ctx, this.title[i], x + 2, y + 2, rgba('#000000', 0.75), scale);
      drawText(ctx, this.title[i], x, y, i % 2 ? Theme.uiAccent : '#ffffff', scale);
    }
    ctx.globalAlpha = holdK * window01(t, 1.4, 1.9);
    if (this.subtitle) drawTextShadow(ctx, this.subtitle, VIEW_W / 2, cy + 32, Theme.ui, fitScale(this.subtitle, VIEW_W - 28, 1), 'center');
    ctx.globalAlpha = 1;

    // the HP bar filling in under the card
    const barK = easeOut(window01(t, 1.6, 2.7));
    if (barK > 0) {
      const bw = Math.round(200 * barK);
      const bx = Math.round((VIEW_W - 200) / 2);
      pxRect(ctx, bx - 1, cy + 44, 202, 7, rgba('#000000', 0.7));
      pxRect(ctx, bx, cy + 45, bw, 5, Theme.hp);
      pxRect(ctx, bx, cy + 45, bw, 1, rgba('#ffffff', 0.5));
    }
  }

  drawOutro(ctx, bars) {
    const t = this.t;
    const cardK = window01(t, 1.5, 2.2);
    const holdK = 1 - window01(t, this.len - 0.75, this.len - 0.2);
    if (cardK <= 0 || holdK <= 0) return;
    const cy = 104;
    const e = easeOut(cardK);

    ctx.globalAlpha = holdK * e;
    const tScale = fitScale(this.title, VIEW_W - 28, 2);
    drawTextShadow(ctx, this.title, VIEW_W / 2, cy - 4, rgba(Theme.uiDim, 0.9), tScale, 'center');
    // struck through, the line drawn on
    const w = textWidth(this.title, tScale);
    const strike = Math.round(w * easeOut(window01(t, 2.0, 2.6)));
    pxRect(ctx, VIEW_W / 2 - w / 2, cy + 3, strike, 1, Theme.hp);

    const defK = window01(t, 2.3, 2.8);
    if (defK > 0) {
      const s = 3;
      const pop = 1 + (1 - easeOut(defK)) * 0.4;
      ctx.save();
      ctx.translate(VIEW_W / 2, cy + 26);
      ctx.scale(pop, pop);
      ctx.globalAlpha = holdK;
      drawText(ctx, 'DEFEATED', 2, 2, rgba('#000000', 0.8), s, 'center');
      drawText(ctx, 'DEFEATED', 0, 0, Theme.uiAccent, s, 'center');
      ctx.restore();
      glowDot(ctx, VIEW_W / 2, cy + 36, 90 * defK, Theme.uiAccent, 0.12 * holdK);
    }
    ctx.globalAlpha = 1;
  }
}
