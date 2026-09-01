// Camera shake, particle system, floating combat text and the shared
// pixel-drawing helpers used by every entity.
import { clamp, lerp, rand, randInt, rgba, TAU } from './util.js';
import { Theme } from './theme.js';

export const Camera = {
  x: 0, y: 0, shake: 0, shakeT: 0, ox: 0, oy: 0,
  zoom: 1, zoomVel: 0, cx: 240, cy: 135, cine: null,
  add(amount) { this.shake = Math.min(14, this.shake + amount); },
  // A short inward kick on impact, sprung back to 1.
  punch(amount) { this.zoomVel += amount; },
  update(dt) {
    this.shakeT += dt * 60;
    this.shake = Math.max(0, this.shake - dt * 26);
    const s = this.shake;
    this.ox = Math.round(Math.sin(this.shakeT * 1.7) * s + rand(-s, s) * 0.4);
    this.oy = Math.round(Math.cos(this.shakeT * 2.3) * s * 0.7 + rand(-s, s) * 0.3);
    if (this.cine) {
      // a cutscene drives the framing directly instead of springing back
      this.cx = this.cine.cx;
      this.cy = this.cine.cy;
      this.zoom = lerp(this.zoom, this.cine.zoom, 1 - Math.pow(0.008, dt));
      this.zoomVel = 0;
      return;
    }
    // critically-ish damped spring back to 1
    const k = 190, damping = 19;
    this.zoomVel += (1 - this.zoom) * k * dt;
    this.zoomVel -= this.zoomVel * damping * dt;
    this.zoom = clamp(this.zoom + this.zoomVel * dt, 0.94, 1.14);
  },
  apply(ctx) {
    ctx.translate(this.ox, this.oy);
    if (Math.abs(this.zoom - 1) > 0.0005) {
      ctx.translate(this.cx, this.cy);
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(-this.cx, -this.cy);
    }
  },
  // screen (already in view space) -> world, so aiming stays exact while zoomed
  unproject(x, y) {
    const z = this.zoom;
    return {
      x: (x - this.ox - this.cx) / z + this.cx,
      y: (y - this.oy - this.cy) / z + this.cy,
    };
  },
  setCinematic(zoom, cx, cy) { this.cine = { zoom, cx, cy }; },
  clearCinematic() { this.cine = null; this.cx = 240; this.cy = 135; },
  reset() { this.shake = 0; this.ox = this.oy = 0; this.zoom = 1; this.zoomVel = 0; this.cine = null; },
};

export const particles = [];
export const texts = [];
export const rings = [];      // expanding impact rings

// An expanding ring of light. Reads as an impact far better than particles.
export function impactRing(x, y, opts = {}) {
  rings.push({
    x, y, t: 0,
    life: opts.life ?? 0.32,
    r0: opts.r0 ?? 3,
    r1: opts.r1 ?? 26,
    color: opts.color ?? '#ffffff',
    width: opts.width ?? 2,
    squash: opts.squash ?? 1,
    rotate: opts.rotate ?? 0,
    arc: opts.arc ?? 0,        // 0 = full ring, else half-width in radians
    angle: opts.angle ?? 0,
  });
}

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
  for (let i = rings.length - 1; i >= 0; i--) {
    rings[i].t += dt;
    if (rings[i].t >= rings[i].life) rings.splice(i, 1);
  }
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

export function clearFx() { particles.length = 0; texts.length = 0; rings.length = 0; }

export function drawRings(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const r of rings) {
    const k = r.t / r.life;
    const ease = 1 - Math.pow(1 - k, 3);          // fast out, slow settle
    const rad = lerp(r.r0, r.r1, ease);
    const a = (1 - k) * (1 - k);
    ctx.strokeStyle = rgba(r.color, a);
    ctx.lineWidth = Math.max(0.6, r.width * (1 - k));
    ctx.beginPath();
    if (r.arc > 0) {
      ctx.ellipse(r.x, r.y, rad, rad * r.squash, r.rotate, r.angle - r.arc, r.angle + r.arc);
    } else {
      ctx.ellipse(r.x, r.y, rad, rad * r.squash, r.rotate, 0, TAU);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// A soft contact shadow. Fades and widens with height above the surface.
export function dropShadow(ctx, x, groundY, width, height) {
  const lift = clamp(height / 90, 0, 1);
  const w = width * (1 - lift * 0.45);
  const a = 0.42 * (1 - lift * 0.7);
  if (w < 1 || a <= 0.01) return;
  ctx.save();
  ctx.fillStyle = rgba('#000000', a);
  ctx.beginPath();
  ctx.ellipse(x, groundY - 1, w, Math.max(1, w * 0.28), 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// A tapered ribbon through a list of [x, y] samples: weapon and dash trails.
export function ribbon(ctx, pts, color, width, alpha = 1, additive = true) {
  if (pts.length < 2) return;
  ctx.save();
  if (additive) ctx.globalCompositeOperation = 'lighter';
  for (let i = 1; i < pts.length; i++) {
    const k = i / (pts.length - 1);
    ctx.strokeStyle = rgba(color, alpha * k * k);
    ctx.lineWidth = Math.max(0.5, width * k);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
    ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }
  ctx.restore();
}

// Two-point verlet chain segment, for scarves / capes / tails.
export function stepChain(chain, anchorX, anchorY, dt, opts = {}) {
  const seg = opts.seg ?? 4;
  const gravity = opts.gravity ?? 220;
  const damping = opts.damping ?? 0.86;
  const stiff = opts.stiff ?? 3;
  chain[0].x = anchorX;
  chain[0].y = anchorY;
  chain[0].px = anchorX;
  chain[0].py = anchorY;
  for (let i = 1; i < chain.length; i++) {
    const n = chain[i];
    const vx = (n.x - n.px) * damping;
    const vy = (n.y - n.py) * damping;
    n.px = n.x;
    n.py = n.y;
    n.x += vx + (opts.windX ?? 0) * dt;
    n.y += vy + gravity * dt * dt * 60;
  }
  for (let pass = 0; pass < stiff; pass++) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      const diff = (d - seg) / d;
      const mx = dx * diff, my = dy * diff;
      if (i - 1 > 0) { a.x += mx * 0.5; a.y += my * 0.5; b.x -= mx * 0.5; b.y -= my * 0.5; }
      else { b.x -= mx; b.y -= my; }
    }
  }
}

export function makeChain(n, x, y) {
  const c = [];
  for (let i = 0; i < n; i++) c.push({ x, y: y + i * 3, px: x, py: y + i * 3 });
  return c;
}

export function drawParticles(ctx) {
  for (const p of particles) {
    const k = 1 - p.t / p.life;
    const col = p.color2 ? mix(p.color, p.color2, 1 - k) : p.color;
    ctx.globalAlpha = clamp(k * p.fade + 0.1, 0, 1);
    if (p.glow) {
      ctx.globalCompositeOperation = 'lighter';
    }
    const s = Math.max(1, Math.round(p.size * (p.kind === 'shrink' ? k : 1)));
    if (p.kind === 'smoke') {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, s * 2.2);
      g.addColorStop(0, rgba(p.color, 0.5));
      g.addColorStop(1, rgba(p.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s * 2.2, 0, TAU);
      ctx.fill();
    } else if (p.kind === 'streak') {
      const len = Math.min(14, Math.hypot(p.vx, p.vy) * 0.05);
      const a = Math.atan2(p.vy, p.vx);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, s * 0.8);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
      ctx.stroke();
    } else if (p.kind === 'line') {
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

// Gradients are rebuilt only when their colours change, not every frame.
const gradCache = new Map();
export function linGrad(ctx, key, x0, y0, x1, y1, stops) {
  const id = `${key}|${stops.map((s) => s[0] + s[1]).join(',')}`;
  let g = gradCache.get(id);
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [off, col] of stops) g.addColorStop(off, col);
    gradCache.set(id, g);
    if (gradCache.size > 40) gradCache.delete(gradCache.keys().next().value);
  }
  return g;
}

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

// A boomerang: two arms meeting at an elbow, drawn around its own centre so it
// spins on the point it would really spin on. Caller handles translate/rotate.
export function drawBoomerang(ctx, len, thick, body, edge, core) {
  const spread = 0.62;              // half the angle between the arms
  const ox = -len * 0.30;           // shift so the elbow is not the pivot
  for (const dir of [-1, 1]) {
    const a = dir * spread;
    const ca = Math.cos(a), sa = Math.sin(a);
    const steps = Math.max(2, Math.round(len));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = ox + ca * len * t;
      const py = sa * len * t;
      const w = Math.max(1, Math.round(thick * (1 - t * 0.45)));
      ctx.fillStyle = body;
      ctx.fillRect(Math.round(px - w / 2), Math.round(py - w / 2), w, w);
      // lit outer edge of the arm
      if (edge && i > steps * 0.25) {
        ctx.fillStyle = edge;
        ctx.fillRect(Math.round(px + ca - w / 2), Math.round(py + sa * 1.2 - w / 2), 1, 1);
      }
    }
  }
  if (core) {
    ctx.fillStyle = core;
    ctx.fillRect(Math.round(ox - 1), -1, 3, 2);
  }
}

export function glowDot(ctx, x, y, r, color, alpha = 1) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r <= 0) return;
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
