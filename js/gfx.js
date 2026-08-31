// Camera shake, particle system, floating combat text and the shared
// pixel-drawing helpers used by every entity.
import { clamp, lerp, rand, randInt, rgba, TAU } from './util.js';
import { Theme } from './theme.js';

export const Camera = {
  x: 0, y: 0, shake: 0, shakeT: 0, ox: 0, oy: 0,
  add(amount) { this.shake = Math.min(14, this.shake + amount); },
  update(dt) {
    this.shakeT += dt * 60;
    this.shake = Math.max(0, this.shake - dt * 26);
    const s = this.shake;
    this.ox = Math.round(Math.sin(this.shakeT * 1.7) * s + rand(-s, s) * 0.4);
    this.oy = Math.round(Math.cos(this.shakeT * 2.3) * s * 0.7 + rand(-s, s) * 0.3);
  },
  reset() { this.shake = 0; this.ox = this.oy = 0; },
};

export const particles = [];
export const texts = [];

export function spawnParticle(p) {
  if (particles.length > 900) particles.shift();
  particles.push(Object.assign({
    x: 0, y: 0, vx: 0, vy: 0, life: 0.5, t: 0, size: 1,
    color: '#fff', color2: null, gravity: 0, drag: 0.98,
    glow: true, kind: 'square', spin: 0, angle: 0, fade: 1,
  }, p));
}

export function burst(x, y, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    const a = opts.angle !== undefined ? opts.angle + rand(-(opts.spread ?? Math.PI), opts.spread ?? Math.PI) : rand(0, TAU);
    const sp = rand(opts.speedMin ?? 20, opts.speedMax ?? 120);
    spawnParticle({
      x: x + rand(-2, 2), y: y + rand(-2, 2),
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(opts.lifeMin ?? 0.25, opts.lifeMax ?? 0.6),
      size: randInt(opts.sizeMin ?? 1, opts.sizeMax ?? 2),
      color: opts.color ?? Theme.spark,
      color2: opts.color2 ?? null,
      gravity: opts.gravity ?? 220,
      drag: opts.drag ?? 0.94,
      kind: opts.kind ?? 'square',
      glow: opts.glow ?? true,
    });
  }
}

export function floatText(x, y, text, color, opts = {}) {
  texts.push({
    x, y, text: String(text), color, t: 0,
    life: opts.life ?? 0.85, vy: opts.vy ?? -26, vx: opts.vx ?? rand(-8, 8),
    scale: opts.scale ?? 1, crit: opts.crit ?? false,
  });
}

export function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t >= p.life) { particles.splice(i, 1); continue; }
    p.vy += p.gravity * dt;
    p.vx *= Math.pow(p.drag, dt * 60);
    p.vy *= Math.pow(p.drag, dt * 60);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.angle += p.spin * dt;
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    t.t += dt;
    if (t.t >= t.life) { texts.splice(i, 1); continue; }
    t.y += t.vy * dt;
    t.x += t.vx * dt;
    t.vy += 40 * dt;
  }
}

export function clearFx() { particles.length = 0; texts.length = 0; }

export function drawParticles(ctx) {
  for (const p of particles) {
    const k = 1 - p.t / p.life;
    const col = p.color2 ? mix(p.color, p.color2, 1 - k) : p.color;
    ctx.globalAlpha = clamp(k * p.fade + 0.1, 0, 1);
    if (p.glow) {
      ctx.globalCompositeOperation = 'lighter';
    }
    const s = Math.max(1, Math.round(p.size * (p.kind === 'shrink' ? k : 1)));
    if (p.kind === 'line') {
      ctx.strokeStyle = col;
      ctx.lineWidth = s;
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x), Math.round(p.y));
      ctx.lineTo(Math.round(p.x - p.vx * 0.04), Math.round(p.y - p.vy * 0.04));
      ctx.stroke();
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
  const bl = Math.round(lerp(pa & 255, pb & 255, t));
  return `rgb(${r},${g},${bl})`;
}

export function drawTexts(ctx) {
  ctx.textAlign = 'center';
  for (const t of texts) {
    const k = 1 - t.t / t.life;
    const pop = t.t < 0.08 ? 1 + (0.08 - t.t) * 6 : 1;
    const size = Math.round((t.crit ? 9 : 7) * t.scale * pop);
    ctx.font = `${size}px "Press Start 2P", monospace`;
    ctx.globalAlpha = clamp(k * 1.4, 0, 1);
    ctx.fillStyle = '#000';
    ctx.fillText(t.text, Math.round(t.x) + 1, Math.round(t.y) + 1);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, Math.round(t.x), Math.round(t.y));
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

// --- drawing primitives -------------------------------------------------

export function pxRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

// A rotated limb: rounded-ish pixel bar from (x, y) at angle, length len.
export function limb(ctx, x, y, angle, len, thick, color, taper = 0) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(angle);
  ctx.fillStyle = color;
  const steps = Math.max(1, Math.round(len));
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const th = Math.max(1, Math.round(thick - taper * t));
    ctx.fillRect(i, -Math.floor(th / 2), 1, th);
  }
  ctx.restore();
}

export function glowDot(ctx, x, y, r, color, alpha = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Jagged bolt between two points; used by lightningarrow + VFX.
export function boltPath(ax, ay, bx, by, jitter = 6, segs = 8, seed = 0) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const j = i === 0 || i === segs ? 0 : jitter;
    const nx = lerp(ax, bx, t) + Math.sin(seed + i * 2.3) * j * rand(0.4, 1);
    const ny = lerp(ay, by, t) + Math.cos(seed + i * 1.7) * j * rand(0.4, 1);
    pts.push([nx, ny]);
  }
  return pts;
}

export function strokeBolt(ctx, pts, color, width, alpha = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rgba(color, alpha);
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();
}
