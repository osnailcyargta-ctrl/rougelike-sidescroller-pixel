// Boss intro and outro cutscenes. The world keeps drawing underneath; this
// only pauses gameplay, drives the camera and paints the cinematic layer on
// top, so the boss stays on screen the whole time.
import { clamp, lerp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, impactRing, spawnParticle, pxRect, glowDot } from './gfx.js';
import { drawText, drawTextShadow, textWidth } from './font.js';
import { Sfx } from './audio.js';
import { VIEW_W, VIEW_H, GROUND_Y } from './config.js';

const INTRO_LEN = 3.2;
const OUTRO_LEN = 3.4;
const BAR_H = 30;

// eased 0..1 helpers
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeIn = (t) => Math.pow(clamp(t, 0, 1), 3);
const window01 = (t, a, b) => clamp((t - a) / Math.max(0.0001, b - a), 0, 1);

const SUBTITLE = {
  golem: 'ANCHOR OF THE DEEP VAULT',
  bigdude: 'TWENTY BLOCKS OF APPETITE',
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
  }

  play(type, boss) {
    this.active = true;
    this.type = type;
    this.t = 0;
    this.len = type === 'intro' ? INTRO_LEN : OUTRO_LEN;
    this.boss = boss;
    this.booms = 0;
    this.nextBoom = 0.35;
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
    if (b.kind === 'worm') {
      return { x: clamp(b.hx, 90, VIEW_W - 90), y: clamp(Math.min(b.hy, GROUND_Y - 30) + 40, 70, GROUND_Y - 20) };
    }
    const body = b.body;
    return {
      x: clamp(body ? body.x : VIEW_W / 2, 90, VIEW_W - 90),
      y: (body ? body.y - body.h / 2 : 150) - 6,
    };
  }

  skip() {
    if (!this.active || this.t < 0.45) return;
    this.finish();
  }

  finish() {
    this.active = false;
    this.flash = 0;
    Camera.clearCinematic();
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

  updateIntro(dt) {
    // the roar: one shock at 0.45s that shakes the whole frame
    if (this.t >= 0.45 && !this.roared) {
      this.roared = true;
      Camera.add(13);
      Camera.punch(2.6);
      Sfx.slam();
      impactRing(this.focus.x, this.focus.y, { color: Theme.hp, r0: 8, r1: 150, life: 0.7, width: 4 });
      impactRing(this.focus.x, this.focus.y, { color: '#ffffff', r0: 4, r1: 90, life: 0.45, width: 2.5 });
      burst(this.focus.x, this.focus.y, 40, {
        color: Theme.uiAccent, color2: '#ffffff', kind: 'streak',
        speedMin: 120, speedMax: 340, lifeMin: 0.2, lifeMax: 0.5, gravity: 0, drag: 0.9,
      });
      this.flash = 0.5;
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
    // a chain of detonations walking along the body
    this.nextBoom -= dt;
    if (this.nextBoom <= 0 && this.t < 2.3) {
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
      if (big) this.flash = 0.55;
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

    if (this.type === 'intro') this.drawIntro(ctx, bars);
    else this.drawOutro(ctx, bars);

    // letterbox last, so nothing spills into the bars
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, VIEW_W, bars);
    ctx.fillRect(0, VIEW_H - bars, VIEW_W, bars);
    if (bars > 2) {
      pxRect(ctx, 0, bars - 1, VIEW_W, 1, rgba(Theme.uiAccent, 0.35));
      pxRect(ctx, 0, VIEW_H - bars, VIEW_W, 1, rgba(Theme.uiAccent, 0.35));
      if (t > 0.6 && t < this.len - 0.6) {
        drawText(ctx, 'ANY KEY TO SKIP', VIEW_W - 6, VIEW_H - bars + 8, rgba(Theme.uiDim, 0.55), 1, 'right');
      }
    }
  }

  drawIntro(ctx, bars) {
    const t = this.t;
    const cardK = window01(t, 0.62, 1.15);
    const holdK = 1 - window01(t, this.len - 0.7, this.len - 0.15);
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

    // the name, letters dropping in one after another
    const scale = 3;
    const w = textWidth(this.title, scale);
    for (let i = 0; i < this.title.length; i++) {
      const k = clamp((cardK * this.title.length - i) / 1.2, 0, 1);
      if (k <= 0) continue;
      const e = easeOut(k);
      const x = (VIEW_W - w) / 2 + i * 6 * scale;
      const y = cy - 6 + (1 - e) * -10;
      ctx.globalAlpha = holdK * e;
      drawText(ctx, this.title[i], x + 2, y + 2, rgba('#000000', 0.75), scale);
      drawText(ctx, this.title[i], x, y, i % 2 ? Theme.uiAccent : '#ffffff', scale);
    }
    ctx.globalAlpha = holdK * window01(t, 1.0, 1.4);
    if (this.subtitle) drawTextShadow(ctx, this.subtitle, VIEW_W / 2, cy + 32, Theme.ui, 1, 'center');
    ctx.globalAlpha = 1;

    // the HP bar filling in under the card
    const barK = easeOut(window01(t, 1.15, 1.9));
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
    const cardK = window01(t, 1.05, 1.6);
    const holdK = 1 - window01(t, this.len - 0.75, this.len - 0.2);
    if (cardK <= 0 || holdK <= 0) return;
    const cy = 104;
    const e = easeOut(cardK);

    ctx.globalAlpha = holdK * e;
    drawTextShadow(ctx, this.title, VIEW_W / 2, cy - 4, rgba(Theme.uiDim, 0.9), 2, 'center');
    // struck through, the line drawn on
    const w = textWidth(this.title, 2);
    const strike = Math.round(w * easeOut(window01(t, 1.45, 1.9)));
    pxRect(ctx, VIEW_W / 2 - w / 2, cy + 3, strike, 1, Theme.hp);

    const defK = window01(t, 1.6, 2.05);
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
