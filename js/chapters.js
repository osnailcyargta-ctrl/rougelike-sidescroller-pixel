// What each chapter is made of.
//
// The tower is four places and they do not look, move or let you out the same
// way. Everything that differs between them lives here: the palette, the sky,
// the floor, how the platforms behave, and the shape of the way onward. The
// world file asks this one for a room and paints what it gets back.
import { clamp, lerp, rand, rgba, mixHex, TAU } from './util.js';
import { Theme } from './theme.js';
import { pxRect, pxSolid, glowDot, limbInk, spawnParticle } from './gfx.js';
import {
  VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, BLOCK, CHAPTERS, chapterFor,
  DIRT_ROOM, DIRT_PATCH,
} from './config.js';

// --- palettes -------------------------------------------------------------
// Flat colours rather than theme lookups: a chapter is a place, and a place
// keeps its colours whatever palette the rest of the game is wearing. The one
// exception is the glow accents, which pick up the theme so a shader pack
// still shows through.

export const PAL = {
  field: {
    skyTop: '#2b4f86', skyMid: '#5b8fc4', skyLow: '#a8cfe6', haze: '#cfe6ef',
    sun: '#fff3c4', sunGlow: '#ffe08a',
    cloud: '#e8f2f8', cloudDark: '#b9d2e2',
    hillFar: '#2f5b48', hillNear: '#1f4436',
    trunk: '#4a3524', trunkDark: '#31231a',
    leafFar: '#2c6b3c', leaf: '#3f8f4a', leafLit: '#67bb5e',
    dirt: '#5c4327', dirtDark: '#3f2d1a', dirtLit: '#7a5b39',
    grass: '#4f9a3a', grassLit: '#7fc95a', grassDark: '#356b28',
    ink: '#17210f',
  },
  castle: {
    wall: '#2b2a36', wallDark: '#1d1c26', wallLit: '#3b3947',
    mortar: '#141320', torch: '#ffb45a', torchCore: '#ffe6b0',
    floor: '#302c2a', floorDark: '#1b1917', floorTop: '#4a423c',
    banner: '#7a2233', bannerLit: '#a83a4c',
    chain: '#6a6a78', chainLit: '#a0a0b0',
    stone: '#413c4a', stoneLit: '#5d5668', stoneDark: '#241f2c',
    dirt: '#4a3a22', dirtLit: '#6b5432', dirtDark: '#2e2314',
    ink: '#0e0d14',
  },
  hell: {
    skyTop: '#0a0305', skyMid: '#1e0708', skyLow: '#3a0c07', haze: '#5e1607',
    rock: '#1d0e10', rockLit: '#33181c', rockDark: '#0f0709',
    lava: '#e8461a', lavaHot: '#ffb44a', lavaDeep: '#7d1604',
    slab: '#241318', slabLit: '#3d2028',
    ink: '#0b0406',
  },
  aether: {
    sky: '#eaf0f8', skyLow: '#c6d3e4', ink: '#0f1116',
    floor: '#cfd8e6', floorLow: '#8b98ac', floorEdge: '#5f6b7d',
    stoneTop: '#ffffff', stoneMid: '#b9c6d8', stoneLow: '#5f6d85',
    glow: '#7cc4f2', glowSoft: '#bfdcf5',
    cloud: '#f4f7fb',
  },
};

// The city keeps using the live theme rather than fixed colours: it is the
// map a shader pack was written against, so it should still answer to one.
PAL.cyber = {
  get sky() { return Theme.bgFar; },
  get glow() { return Theme.platformGlow; },
  get accent() { return Theme.uiAccent; },
};

export function palFor(room) { return PAL[chapterFor(room).id]; }

// How hard the bloom is allowed to hit here. A near-white chapter blows out
// under the same bloom that makes a dark one look good, so the Aether asks for
// a third of it and the Inferno, which is mostly black with fire in it, asks
// for a little extra.
const BLOOM = { field: 0.7, castle: 1, hell: 1.15, aether: 0.28 };
export function bloomFor(room) { return BLOOM[chapterFor(room).id] ?? 1; }

// Colour fringing reads as texture on a dark frame and as smear on a white
// one, so the Aether asks for almost none of it.
const CHROMA = { field: 0.8, castle: 1, hell: 1, aether: 0.15 };
export function chromaFor(room) { return CHROMA[chapterFor(room).id] ?? 1; }

// --- platform behaviour ---------------------------------------------------
// The four platforms are the same four objects all game; what changes is how
// they are allowed to move and whether they are there at all. `off` takes one
// out of the room entirely - collision, drawing and everything else skips it.

const HOME = PLATFORMS.map((p) => ({ x: p.x, y: p.y }));
for (const p of PLATFORMS) { p.motion = 'none'; p.off = false; p.homeX = p.x; p.homeY = p.y; }

export function layoutRoom(room) {
  const ch = chapterFor(room);
  for (let i = 0; i < PLATFORMS.length; i++) {
    const p = PLATFORMS[i];
    p.homeX = HOME[i].x;
    p.homeY = HOME[i].y;
    p.x = p.homeX;
    p.y = p.homeY;
    p.dx = 0;
    p.off = false;
    p.phase = i * 1.7;
    p.motion = 'none';
    p.hangFrom = null;
    p.style = ch.platforms;
  }
  const left = PLATFORMS.find((p) => p.tag === 'left');
  const right = PLATFORMS.find((p) => p.tag === 'right');
  const centre = PLATFORMS.find((p) => p.tag === 'center');
  const top = PLATFORMS.find((p) => p.tag === 'drift');

  if (ch.id === 'field') {
    // Nothing hangs in the air out here. The two hills stay, the low mound
    // stays, and there is no platform overhead at all.
    top.off = true;
  } else if (ch.id === 'castle') {
    // Everything hangs from the ceiling. The pair at the sides ride their
    // chains up and down; the two in the middle swing, the lower one behind
    // the upper one, like two bells rung a moment apart.
    left.motion = 'lift';
    right.motion = 'lift';
    right.phase = 2.4;
    centre.motion = 'swing';
    top.motion = 'swing';
    centre.phase = top.phase + 1.15;      // the delay you can see
    centre.hangFrom = top;                // and its chains run up to that one
    if (room === DIRT_ROOM) {
      // the worm's room: bare floor, nothing overhead in the middle
      centre.off = true;
      top.off = true;
    }
  } else if (ch.id === 'hell') {
    // Slabs riding the heat: they lift on the updraught and slide with it.
    left.motion = 'lift';
    right.motion = 'lift';
    centre.motion = 'drift';
    top.motion = 'drift';
    top.phase = 0.6;
  } else if (ch.id === 'cyber') {
    // The city as it was: one platform drifting across the middle, the rest
    // bolted where they are.
    top.motion = 'swing';
  } else {
    // The Aether: nothing crosses the room. Everything simply breathes.
    for (const p of PLATFORMS) p.motion = 'breathe';
  }
}

const MOTION = {
  lift: { amp: 26, speed: 0.55 },
  swing: { amp: 62, speed: 0.42 },
  drift: { amp: 34, speed: 0.36 },
  breathe: { amp: 7, speed: 0.30 },
};

export function updatePlatforms(dt, t, frozen) {
  for (const p of PLATFORMS) {
    const m = MOTION[p.motion];
    if (p.off || !m) { p.dx = 0; p.dy = 0; continue; }
    const beforeX = p.x, beforeY = p.y;
    const k = frozen ? p.frozenT ?? t : t;
    p.frozenT = k;
    const wave = Math.sin(k * TAU * m.speed + p.phase);
    if (p.motion === 'swing' || p.motion === 'drift') {
      p.x = clamp(p.homeX + wave * m.amp, 24, VIEW_W - 24 - p.w);
      p.y = p.homeY + (p.motion === 'drift' ? Math.sin(k * 1.7 + p.phase) * 5 : 0);
    } else {
      p.y = p.homeY + wave * m.amp;
    }
    // How far it moved this frame. Anything standing on it, stuck in it or
    // hanging off it is moved by exactly this much - a platform that rises out
    // from under its passengers is a platform nobody can use.
    p.dx = frozen ? 0 : p.x - beforeX;
    p.dy = frozen ? 0 : p.y - beforeY;
  }
}

// --- the sky --------------------------------------------------------------
// Everything in here is baked once per room, so it can be as detailed as it
// likes: it is painted when you walk in and blitted after that.

export function bakeSky(ctx, room) {
  const ch = chapterFor(room);
  if (ch.id === 'cyber') return bakeCyber(ctx, room);
  if (ch.id === 'field') return bakeField(ctx, room);
  if (ch.id === 'castle') return bakeCastle(ctx, room);
  if (ch.id === 'hell') return bakeHell(ctx, room);
  return bakeAether(ctx, room);
}

function grad(ctx, stops, y0 = 0, y1 = VIEW_H) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [k, c] of stops) g.addColorStop(k, c);
  return g;
}

// A deterministic little generator, so a room looks the same every time you
// walk back into it.
function rng(seed) {
  let s = seed * 9871 + 17;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// --- chapter one: open country -------------------------------------------

function bakeField(ctx, room) {
  const P = PAL.field;
  const r = rng(room);
  ctx.fillStyle = grad(ctx, [[0, P.skyTop], [0.5, P.skyMid], [0.82, P.skyLow], [1, P.haze]], 0, GROUND_Y);
  ctx.fillRect(0, 0, VIEW_W, GROUND_Y + 2);

  // the sun, low and huge, with the haze bleeding off it
  const sx = 96 + r() * 280, sy = 40 + r() * 26;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 92);
  sg.addColorStop(0, rgba(P.sunGlow, 0.55));
  sg.addColorStop(0.35, rgba(P.sunGlow, 0.18));
  sg.addColorStop(1, rgba(P.sunGlow, 0));
  ctx.fillStyle = sg;
  ctx.fillRect(sx - 100, sy - 100, 200, 200);
  ctx.restore();
  for (let dy = -13; dy <= 13; dy++) {
    const hw = Math.round(Math.sqrt(Math.max(0, 169 - dy * dy)));
    pxRect(ctx, sx - hw, sy + dy, hw * 2, 1, dy < -4 ? '#ffffff' : P.sun);
  }

  // clouds, three depths of them
  for (let i = 0; i < 9; i++) {
    const depth = i % 3;
    const cx = r() * (VIEW_W + 80) - 40;
    const cy = 18 + r() * 74;
    const s = 0.6 + depth * 0.35 + r() * 0.3;
    cloud(ctx, cx, cy, s, depth === 2 ? P.cloud : mixHex(P.cloud, P.skyMid, 0.35 - depth * 0.12));
  }

  // far hills, two ridges
  for (const [hy, col, amp] of [[GROUND_Y - 54, mixHex(P.hillFar, P.haze, 0.45), 16],
                                [GROUND_Y - 30, P.hillFar, 11]]) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 2);
    for (let x = 0; x <= VIEW_W; x += 12) {
      ctx.lineTo(x, hy + Math.sin(x * 0.019 + room) * amp + Math.sin(x * 0.007) * amp * 0.6);
    }
    ctx.lineTo(VIEW_W, GROUND_Y + 2);
    ctx.closePath();
    ctx.fill();
  }

  // the forest: trunks and canopies back to front
  for (let layer = 0; layer < 2; layer++) {
    const base = GROUND_Y - (layer ? 2 : 12);
    const n = layer ? 7 : 9;
    for (let i = 0; i < n; i++) {
      const x = Math.round((i + r() * 0.8) * (VIEW_W / n));
      const h = (layer ? 46 : 34) + r() * 26;
      const leaf = layer ? P.leaf : mixHex(P.leafFar, P.haze, 0.25);
      tree(ctx, x, base, h, leaf, layer ? P.trunk : P.trunkDark, layer ? P.leafLit : null, r);
    }
  }

  // a warm band of haze where the trees meet the ground
  ctx.fillStyle = grad(ctx, [[0, rgba(P.haze, 0)], [1, rgba(P.haze, 0.35)]], GROUND_Y - 40, GROUND_Y);
  ctx.fillRect(0, GROUND_Y - 40, VIEW_W, 40);


}

function cloud(ctx, x, y, s, col) {
  const lumps = [[0, 0, 26], [18, 4, 18], [-18, 5, 16], [8, -7, 15], [-8, -5, 13]];
  for (const [ox, oy, rr] of lumps) {
    const w = Math.round(rr * s), h = Math.round(rr * s * 0.55);
    pxRect(ctx, x + ox * s - w / 2, y + oy * s - h / 2, w, h, col);
  }
  // a lit crown along the top
  pxRect(ctx, x - 20 * s, y - 9 * s, 40 * s, 2, rgba('#ffffff', 0.5));
}

function tree(ctx, x, baseY, h, leaf, trunk, lit, r) {
  const tw = h > 55 ? 6 : 4;
  pxRect(ctx, x - tw / 2, baseY - h * 0.55, tw, h * 0.55, trunk);
  // two boughs
  for (const side of [-1, 1]) {
    limbInk(ctx, x, baseY - h * 0.42, side > 0 ? -0.9 : Math.PI + 0.9, h * 0.22, 2, trunk, null);
  }
  const cy = baseY - h * 0.62;
  const cw = h * 0.5;
  for (const [ox, oy, k] of [[0, 0, 1], [-cw * 0.5, 6, 0.72], [cw * 0.5, 5, 0.72], [0, -9, 0.66]]) {
    const w = Math.round(cw * k), hh = Math.round(cw * k * 0.78);
    pxRect(ctx, x + ox - w / 2, cy + oy - hh / 2, w, hh, leaf);
  }
  if (lit) {
    pxRect(ctx, x - cw * 0.4, cy - cw * 0.42, cw * 0.7, 2, lit);
    pxRect(ctx, x - cw * 0.55, cy - cw * 0.2, 3, 6, lit);
  }
}

// --- chapter two: inside the walls ---------------------------------------

function bakeCastle(ctx, room) {
  const P = PAL.castle;
  const r = rng(room);
  ctx.fillStyle = grad(ctx, [[0, P.wallDark], [0.55, P.wall], [1, mixHex(P.wall, P.wallDark, 0.5)]], 0, GROUND_Y);
  ctx.fillRect(0, 0, VIEW_W, GROUND_Y + 2);

  // brickwork, offset row by row
  const bw = 26, bh = 13;
  for (let row = 0, y = -4; y < GROUND_Y; row++, y += bh) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < VIEW_W + bw; x += bw) {
      const shade = 0.82 + r() * 0.3;
      pxRect(ctx, x + off, y, bw - 2, bh - 2, mixHex(P.wall, shade > 1 ? P.wallLit : P.wallDark, Math.abs(shade - 1) * 1.6));
    }
  }
  ctx.fillStyle = rgba(P.mortar, 0.5);
  for (let row = 0, y = -4; y < GROUND_Y; row++, y += bh) ctx.fillRect(0, y + bh - 2, VIEW_W, 2);

  // arches along the back wall
  for (let i = 0; i < 4; i++) {
    const x = 44 + i * 116;
    const w = 54, h = 96, top = GROUND_Y - h;
    pxRect(ctx, x, top + 18, w, h - 18, mixHex(P.wallDark, '#000000', 0.35));
    for (let dy = 0; dy < 20; dy++) {
      const hw = Math.round(Math.sqrt(Math.max(0, 400 - (20 - dy) * (20 - dy))) * (w / 2) / 20);
      pxRect(ctx, x + w / 2 - hw, top + dy, hw * 2, 1, mixHex(P.wallDark, '#000000', 0.35));
    }
    pxRect(ctx, x - 2, top + 16, 3, h - 16, P.wallLit);
    pxRect(ctx, x + w - 1, top + 16, 3, h - 16, P.wallLit);
  }

  // banners between the arches
  for (let i = 0; i < 3; i++) {
    const x = 100 + i * 118;
    pxSolid(ctx, x, 26, 22, 56, P.banner, { ink: P.ink, light: P.bannerLit, dark: null });
    pxRect(ctx, x + 4, 34, 14, 3, P.bannerLit);
    pxRect(ctx, x + 8, 42, 6, 20, rgba(P.bannerLit, 0.5));
    // the pointed hem
    for (let k = 0; k < 6; k++) pxRect(ctx, x + k * 2, 82 + k, 22 - k * 4, 1, P.banner);
  }
}

// --- chapter three: under the floor of the world -------------------------

function bakeHell(ctx, room) {
  const P = PAL.hell;
  const r = rng(room);
  ctx.fillStyle = grad(ctx, [[0, P.skyTop], [0.45, P.skyMid], [0.85, P.skyLow], [1, P.haze]], 0, GROUND_Y);
  ctx.fillRect(0, 0, VIEW_W, GROUND_Y + 2);

  // a cavern roof of hanging rock
  for (let x = -10; x < VIEW_W + 10; x += 14) {
    const h = 12 + r() * 30;
    ctx.fillStyle = P.rockDark;
    ctx.beginPath();
    ctx.moveTo(x - 8, -2);
    ctx.lineTo(x + 8, -2);
    ctx.lineTo(x + r() * 6 - 3, h);
    ctx.closePath();
    ctx.fill();
  }
  pxRect(ctx, 0, 0, VIEW_W, 6, P.rockDark);

  // far cliffs with fire behind them
  for (const [base, col] of [[GROUND_Y - 46, mixHex(P.rock, P.skyLow, 0.55)], [GROUND_Y - 22, P.rock]]) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 2);
    for (let x = 0; x <= VIEW_W; x += 16) {
      ctx.lineTo(x, base + Math.sin(x * 0.03 + room * 2) * 14 + (r() - 0.5) * 6);
    }
    ctx.lineTo(VIEW_W, GROUND_Y + 2);
    ctx.closePath();
    ctx.fill();
  }

  // a lake of it burning along the base of the cliffs, and the light it throws
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const lake = ctx.createLinearGradient(0, GROUND_Y - 34, 0, GROUND_Y - 2);
  lake.addColorStop(0, rgba(P.lava, 0));
  lake.addColorStop(1, rgba(P.lava, 0.34));
  ctx.fillStyle = lake;
  ctx.fillRect(0, GROUND_Y - 34, VIEW_W, 32);
  for (let i = 0; i < 5; i++) {
    const x = 30 + r() * (VIEW_W - 60);
    const g = ctx.createRadialGradient(x, GROUND_Y - 10, 0, x, GROUND_Y - 10, 46);
    g.addColorStop(0, rgba(P.lavaHot, 0.34));
    g.addColorStop(1, rgba(P.lavaHot, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - 50, GROUND_Y - 56, 100, 56);
  }
  ctx.restore();

  ctx.fillStyle = grad(ctx, [[0, rgba(P.lava, 0)], [1, rgba(P.lava, 0.28)]], GROUND_Y - 46, GROUND_Y);
  ctx.fillRect(0, GROUND_Y - 46, VIEW_W, 46);
}

// --- chapter four: above it all ------------------------------------------

function bakeAether(ctx, room) {
  const P = PAL.aether;
  const r = rng(room);
  ctx.fillStyle = grad(ctx, [[0, P.sky], [1, P.skyLow]], 0, GROUND_Y);
  ctx.fillRect(0, 0, VIEW_W, GROUND_Y + 2);

  // white on white needs a line around everything or it is not a place, it is
  // a blank page. Distant halls, drawn in outline only.
  for (let i = 0; i < 5; i++) {
    const x = Math.round(r() * VIEW_W - 40);
    const w = 60 + Math.round(r() * 80);
    const h = 70 + Math.round(r() * 90);
    const top = GROUND_Y - h;
    pxRect(ctx, x, top, w, h, rgba(P.floorLow, 0.22));
    pxRect(ctx, x, top, w, 1, rgba(P.ink, 0.55));
    pxRect(ctx, x, top, 1, h, rgba(P.ink, 0.42));
    pxRect(ctx, x + w - 1, top, 1, h, rgba(P.ink, 0.42));
    // pillars along the front of it
    for (let k = 10; k < w - 8; k += 18) {
      pxRect(ctx, x + k, top + 8, 4, h - 8, rgba(P.floorEdge, 0.30));
      pxRect(ctx, x + k, top + 8, 1, h - 8, rgba(P.ink, 0.22));
    }
  }
  // the horizon, hard and black, so the ground reads as ground
  pxRect(ctx, 0, GROUND_Y - 1, VIEW_W, 1, rgba(P.ink, 0.8));

  // pale cloud banks, outlined the way everything here is outlined
  for (let i = 0; i < 7; i++) {
    const x = r() * VIEW_W, y = 20 + r() * 120, s = 0.7 + r() * 0.9;
    const lumps = [[0, 0, 30], [22, 5, 20], [-22, 6, 18], [10, -8, 17]];
    for (const [ox, oy, rr] of lumps) {
      const w = Math.round(rr * s), h = Math.round(rr * s * 0.5);
      pxRect(ctx, x + ox * s - w / 2, y + oy * s - h / 2, w, h, P.cloud);
      pxRect(ctx, x + ox * s - w / 2, y + oy * s - h / 2, w, 1, rgba(P.ink, 0.10));
    }
  }

  // a few columns of pure light standing in the distance
  for (let i = 0; i < 3; i++) {
    const x = 60 + i * 160 + r() * 40;
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, rgba(P.glow, 0.16));
    g.addColorStop(1, rgba(P.glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - 16, 0, 32, GROUND_Y);
  }
}

// --- the floor ------------------------------------------------------------

export function bakeFloor(ctx, room) {
  const ch = chapterFor(room);
  if (ch.id === 'cyber') return floorCyber(ctx, room);
  if (ch.id === 'field') return floorField(ctx, room);
  if (ch.id === 'castle') return floorCastle(ctx, room);
  if (ch.id === 'hell') return floorHell(ctx, room);
  return floorAether(ctx, room);
}

function floorField(ctx, room) {
  const P = PAL.field;
  const r = rng(room + 77);
  // earth
  ctx.fillStyle = grad(ctx, [[0, P.dirt], [1, P.dirtDark]], GROUND_Y, VIEW_H);
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  // stones and roots in it
  for (let i = 0; i < 60; i++) {
    const x = r() * VIEW_W, y = GROUND_Y + 6 + r() * (VIEW_H - GROUND_Y - 8);
    pxRect(ctx, x, y, 1 + Math.round(r() * 2), 1 + Math.round(r()), rgba(P.dirtLit, 0.5));
  }
  // the turf on top: a ragged edge, not a ruled line
  for (let x = 0; x < VIEW_W; x++) {
    const h = 4 + Math.round(1.8 * Math.sin(x * 0.5) + 1.4 * Math.sin(x * 0.17 + room));
    pxRect(ctx, x, GROUND_Y, 1, h, P.grass);
    pxRect(ctx, x, GROUND_Y, 1, 1, P.grassLit);
    pxRect(ctx, x, GROUND_Y + h, 1, 2, P.grassDark);
  }
  // tufts standing up out of it
  for (let i = 0; i < 44; i++) {
    const x = Math.round(r() * VIEW_W);
    const h = 3 + Math.round(r() * 5);
    const c = r() < 0.4 ? P.grassLit : P.grass;
    for (let k = -1; k <= 1; k++) {
      const hh = h - Math.abs(k) * 2;
      if (hh <= 0) continue;
      pxRect(ctx, x + k * 2, GROUND_Y - hh, 1, hh, c);
    }
  }
}

function floorCastle(ctx, room) {
  const P = PAL.castle;
  const r = rng(room + 77);
  ctx.fillStyle = grad(ctx, [[0, P.floor], [1, P.floorDark]], GROUND_Y, VIEW_H);
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  pxRect(ctx, 0, GROUND_Y, VIEW_W, 1, P.floorTop);
  // flagstones
  for (let row = 0; row < 3; row++) {
    const y = GROUND_Y + 3 + row * 11;
    if (y > VIEW_H) break;
    pxRect(ctx, 0, y, VIEW_W, 1, rgba('#000000', 0.35));
    for (let x = row % 2 ? 0 : 12; x < VIEW_W; x += 24) {
      pxRect(ctx, x, y, 1, 11, rgba('#000000', 0.4));
      pxRect(ctx, x + 1, y + 1, 1, 9, rgba(P.floorTop, 0.10));
    }
  }
  // the worm's room has bare earth through the middle of the flagstones
  if (room === DIRT_ROOM) {
    const { x, w } = DIRT_PATCH;
    // a hole in the flagstones, sunk a little and lit along its lip, because
    // this patch is the only reason the fight in this room works
    ctx.fillStyle = grad(ctx, [[0, P.dirtLit], [0.5, P.dirt], [1, P.dirtDark]], GROUND_Y - 2, VIEW_H);
    ctx.fillRect(x, GROUND_Y - 2, w, VIEW_H - GROUND_Y + 2);
    pxRect(ctx, x - 1, GROUND_Y - 3, w + 2, 1, rgba('#000000', 0.6));
    pxRect(ctx, x, GROUND_Y - 2, w, 1, P.dirtLit);
    for (let i = 0; i < 40; i++) {
      const px = x + r() * w, py = GROUND_Y + 4 + r() * (VIEW_H - GROUND_Y - 6);
      pxRect(ctx, px, py, 1 + Math.round(r() * 2), 1, rgba(P.dirt, 0.7));
    }
    // broken flagstones at the edges of the hole
    for (const ex of [x, x + w]) {
      for (let k = 0; k < 5; k++) {
        pxRect(ctx, ex - 3 + (ex === x ? -k : k), GROUND_Y + k * 3, 4, 3, P.floorDark);
      }
    }
    pxRect(ctx, x, GROUND_Y, w, 1, P.dirtLit);
  }
}

function floorHell(ctx, room) {
  const P = PAL.hell;
  const r = rng(room + 77);
  ctx.fillStyle = grad(ctx, [[0, P.rock], [1, P.rockDark]], GROUND_Y, VIEW_H);
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  pxRect(ctx, 0, GROUND_Y, VIEW_W, 1, P.rockLit);
  // cracks with fire in them
  for (let i = 0; i < 9; i++) {
    let x = r() * VIEW_W;
    let y = GROUND_Y + 2;
    for (let k = 0; k < 6 && y < VIEW_H; k++) {
      const w = 2 + Math.round(r() * 3);
      pxRect(ctx, x, y, w, 2, rgba(P.lava, 0.75 - k * 0.1));
      pxRect(ctx, x, y, w, 1, rgba(P.lavaHot, 0.6 - k * 0.08));
      x += (r() - 0.5) * 10;
      y += 3 + r() * 3;
    }
  }
}

function floorAether(ctx, room) {
  const P = PAL.aether;
  ctx.fillStyle = grad(ctx, [[0, P.floor], [1, P.floorLow]], GROUND_Y, VIEW_H);
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  pxRect(ctx, 0, GROUND_Y, VIEW_W, 1, P.ink);
  pxRect(ctx, 0, GROUND_Y + 1, VIEW_W, 1, '#ffffff');
  // tiles running away from you, so the mirror has something to hold
  for (let x = -24; x < VIEW_W; x += 40) {
    for (let k = 0; k < VIEW_H - GROUND_Y; k++) {
      pxRect(ctx, x + k * 0.5, GROUND_Y + 2 + k, 1, 1, rgba(P.floorEdge, 0.4));
    }
  }
  for (let y = GROUND_Y + 8; y < VIEW_H; y += 10) {
    pxRect(ctx, 0, y, VIEW_W, 1, rgba(P.floorEdge, 0.28));
  }
}

// --- live decoration on top of the baked room ----------------------------

export function drawChapterAmbience(ctx, t, room) {
  const ch = chapterFor(room);
  if (ch.id === 'field') {
    // grass leaning in the wind, right at the player's feet
    ctx.save();
    for (let x = 4; x < VIEW_W; x += 19) {
      const sway = Math.sin(t * 1.4 + x * 0.09) * 2;
      const h = 4 + ((x * 7) % 5);
      pxRect(ctx, x + sway, GROUND_Y - h, 1, h, rgba(PAL.field.grassLit, 0.75));
    }
    ctx.restore();
  } else if (ch.id === 'castle') {
    // torches burning in their brackets
    for (let i = 0; i < 4; i++) {
      const x = 44 + i * 116 + 27;
      const y = 120;
      const f = 0.7 + 0.3 * Math.sin(t * 9 + i * 2);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      glowDot(ctx, x, y, 34 * f, PAL.castle.torch, 0.22 * f);
      ctx.restore();
      pxRect(ctx, x - 1, y - 6, 2, 8, PAL.castle.torchCore);
      pxRect(ctx, x - 2, y - 2, 4, 6, rgba(PAL.castle.torch, 0.8 * f));
    }
  } else if (ch.id === 'hell') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = ((i * 97 + room * 31) % VIEW_W);
      const k = (t * 0.4 + i * 0.2) % 1;
      glowDot(ctx, x, GROUND_Y - k * 140, 10 * (1 - k), PAL.hell.lavaHot, 0.3 * (1 - k));
    }
    ctx.restore();
  } else {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x = ((i * 83 + room * 41) % VIEW_W);
      const y = 40 + ((i * 37) % 120) + Math.sin(t * 0.5 + i) * 8;
      glowDot(ctx, x, y, 22, PAL.aether.glow, 0.10);
    }
    ctx.restore();
  }
}

// --- platforms ------------------------------------------------------------

export function drawPlatform(ctx, p, t, room) {
  if (p.off) return;
  const ch = chapterFor(room);
  if (ch.id === 'cyber') return platformNeon(ctx, p, t);
  if (ch.id === 'field') return platformHill(ctx, p, t);
  if (ch.id === 'castle') return platformChain(ctx, p, t);
  if (ch.id === 'hell') return platformSlab(ctx, p, t);
  return platformCloud(ctx, p, t);
}

// A rise in the ground, with ground under it all the way down.
function platformHill(ctx, p, t) {
  const P = PAL.field;
  const x = Math.round(p.x), y = Math.round(p.y), w = Math.round(p.w);
  const foot = GROUND_Y + 2;
  // the body of the hill, widening as it goes down
  for (let yy = y; yy < foot; yy++) {
    const k = (yy - y) / (foot - y);
    const spread = Math.round(k * 26);
    const col = mixHex(P.dirt, P.dirtDark, k * 0.8);
    pxRect(ctx, x - spread, yy, w + spread * 2, 1, col);
  }
  // stones showing through the slope
  for (let i = 0; i < 7; i++) {
    const k = (i * 0.13 + 0.1);
    const yy = y + (foot - y) * k;
    pxRect(ctx, x + ((i * 37) % w), yy, 2, 1, rgba(P.dirtLit, 0.45));
  }
  // turf over the top
  for (let i = 0; i < w; i++) {
    const h = 4 + Math.round(1.6 * Math.sin((x + i) * 0.5));
    pxRect(ctx, x + i, y - h + 2, 1, h, P.grass);
    pxRect(ctx, x + i, y - h + 2, 1, 1, P.grassLit);
  }
  pxRect(ctx, x - 2, y + 2, w + 4, 2, P.grassDark);
  // tufts on the crest, leaning in the wind
  for (let i = 6; i < w; i += 13) {
    const sway = Math.sin(t * 1.5 + (x + i) * 0.08) * 1.5;
    pxRect(ctx, x + i + sway, y - 7, 1, 5, P.grassLit);
  }
}

// Hung from the ceiling on a pair of chains that follow it wherever it goes.
function platformChain(ctx, p, t) {
  const P = PAL.castle;
  const x = Math.round(p.x), y = Math.round(p.y), w = Math.round(p.w), h = Math.round(p.h);
  // What it hangs from. The low middle slab hangs off the one above it rather
  // than off the ceiling, which is why the two of them swing together with the
  // lower one always a beat behind.
  const above = p.hangFrom && !p.hangFrom.off ? p.hangFrom : null;
  const topY = above ? above.y + above.h : 0;
  const anchorBase = above ? above.x : p.homeX;
  // the chains, drawn first so the slab covers where they meet it
  for (const ox of [6, w - 8]) {
    const cx = x + ox;
    const anchorX = anchorBase + ox;
    for (let yy = topY; yy < y; yy += 5) {
      const k = (yy - topY) / Math.max(1, y - topY);
      const lx = Math.round(lerp(anchorX, cx, k));
      pxRect(ctx, lx, yy, 2, 3, P.chain);
      pxRect(ctx, lx, yy, 1, 1, P.chainLit);
    }
    pxRect(ctx, cx - 1, y - 3, 4, 4, P.chainLit);
    if (above) pxRect(ctx, Math.round(anchorX) - 1, topY - 1, 4, 3, P.chainLit);
  }
  // the slab
  pxSolid(ctx, x, y, w, h, P.stone, { ink: P.ink, light: P.stoneLit, dark: P.stoneDark });
  for (let i = BLOCK; i < w; i += BLOCK) pxRect(ctx, x + i, y, 1, h, rgba('#000000', 0.35));
  pxRect(ctx, x, y + h, w, 1, rgba('#000000', 0.5));
  // iron banding at the ends
  pxRect(ctx, x, y - 1, 4, h + 2, P.chain);
  pxRect(ctx, x + w - 4, y - 1, 4, h + 2, P.chain);
}

// Basalt riding the updraught, hot underneath.
function platformSlab(ctx, p, t) {
  const P = PAL.hell;
  const x = Math.round(p.x), y = Math.round(p.y), w = Math.round(p.w), h = Math.round(p.h);
  pxSolid(ctx, x, y, w, h, P.slab, { ink: P.ink, light: P.slabLit, dark: null });
  pxRect(ctx, x, y, w, 1, rgba(P.lavaHot, 0.35));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const heat = 0.28 + 0.10 * Math.sin(t * 3 + p.x);
  const g = ctx.createLinearGradient(0, y + h, 0, y + h + 12);
  g.addColorStop(0, rgba(P.lava, heat));
  g.addColorStop(1, rgba(P.lava, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x, y + h, w, 12);
  ctx.restore();
  for (let i = BLOCK; i < w; i += BLOCK) pxRect(ctx, x + i, y + 1, 1, h - 1, rgba(P.lava, 0.5));
}

// White stone with no underside: it fades into the light it is standing on.
function platformCloud(ctx, p, t) {
  const P = PAL.aether;
  const x = Math.round(p.x), y = Math.round(p.y), w = Math.round(p.w), h = Math.round(p.h);
  const deep = h + 5;
  // the body: white at the top, greying as it goes down, and no bottom edge -
  // the last rows narrow away instead of stopping on a line
  for (let k = 0; k < deep; k++) {
    const kk = clamp(k / (deep - 1), 0, 1);
    const c = k === 0 ? '#ffffff' : k === 1 ? P.stoneMid : mixHex(P.stoneMid, P.stoneLow, kk);
    const inset = k > h ? (k - h) * 2 : 0;
    pxRect(ctx, x + inset, y + k, w - inset * 2, 1, c);
  }
  // outlined, because everything here is
  pxRect(ctx, x, y - 1, w, 1, P.ink);
  pxRect(ctx, x - 1, y - 1, 1, h + 3, P.ink);
  pxRect(ctx, x + w, y - 1, 1, h + 3, P.ink);
  // and under it, the colour it ended on, as light
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(0, y + h, 0, y + h + 26);
  g.addColorStop(0, rgba(P.glow, 0.32));
  g.addColorStop(0.4, rgba(P.glow, 0.13));
  g.addColorStop(1, rgba(P.glow, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - 10, y + h, w + 20, 26);
  ctx.restore();
}

/** The colour of the floor here - what a reflection fades into. */
export function floorTint(room) {
  const id = chapterFor(room).id;
  if (id === 'field') return PAL.field.dirt;
  if (id === 'castle') return PAL.castle.floor;
  if (id === 'hell') return PAL.hell.rock;
  return PAL.aether.floor;
}

/** How much of the room the floor gives back. */
export function reflectAmount(room) { return chapterFor(room).reflect; }

// --- the way onward -------------------------------------------------------
// Every chapter lets you out its own way: you walk through a fortress gate,
// push open a castle door, step into a tear in the air, or climb a stair made
// of light. The interaction is the same everywhere; only the shape is not.

export function exitTint(kind) {
  if (kind === 'sign' || kind === 'gate') return PAL.field.sunGlow;
  if (kind === 'portal') return PAL.aether.glow;
  if (kind === 'door') return PAL.castle.torch;
  if (kind === 'rift') return PAL.hell.lavaHot;
  return PAL.aether.glow;
}

export function drawExit(ctx, e) {
  const k = e.open;
  if (k <= 0.01) return;
  if (e.kind === 'sign') return exitSign(ctx, e, k);
  if (e.kind === 'gate') return exitGate(ctx, e, k);
  if (e.kind === 'door') return exitDoor(ctx, e, k);
  if (e.kind === 'rift') return exitRift(ctx, e, k);
  if (e.kind === 'portal') return exitPortal(ctx, e, k);
  return exitStair(ctx, e, k);
}

// A gap in the fence line with the fields going on beyond it - or, at the end
// of the chapter, the front of the castle itself.
function exitGate(ctx, e, k) {
  const P = PAL.field;
  const x = Math.round(e.x), base = Math.round(e.y);
  if (e.grand) return exitFortress(ctx, e, k);
  const w = 40, h = 52;
  const top = base - h;
  // posts
  for (const ox of [-w / 2, w / 2 - 5]) {
    pxSolid(ctx, x + ox, top, 5, h, P.trunk, { ink: P.ink, light: P.trunkDark, dark: null });
  }
  // lintel
  pxSolid(ctx, x - w / 2 - 3, top - 5, w + 6, 5, P.trunk, { ink: P.ink, light: null, dark: null });
  // the open doorway, with daylight coming through it
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x, top, x, base);
  g.addColorStop(0, rgba(P.sunGlow, 0.5 * k));
  g.addColorStop(1, rgba(P.sunGlow, 0.12 * k));
  ctx.fillStyle = g;
  ctx.fillRect(x - w / 2 + 5, top, w - 10, h);
  ctx.restore();
  // the two leaves, swung back against the posts
  for (const side of [-1, 1]) {
    const sw = Math.round(14 * (1 - k * 0.75));
    pxSolid(ctx, side < 0 ? x - w / 2 + 5 : x + w / 2 - 5 - sw, top + 4, sw, h - 6,
            P.trunkDark, { ink: P.ink, light: null, dark: null });
  }
  // grass growing through the gateway
  for (let i = -12; i < 12; i += 5) {
    pxRect(ctx, x + i, base - 5, 1, 5, P.grassLit);
  }
}

// Iron-banded oak, standing open on a lit hall.
function exitDoor(ctx, e, k) {
  const P = PAL.castle;
  const x = Math.round(e.x), base = Math.round(e.y);
  const w = 38, h = 56, top = base - h;
  // the arch it sits in
  pxSolid(ctx, x - w / 2 - 4, top - 6, w + 8, h + 6, P.stoneDark, { ink: P.ink, light: P.stone, dark: null });
  // the hall beyond
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x, top, x, base);
  g.addColorStop(0, rgba(P.torch, 0.42 * k));
  g.addColorStop(1, rgba(P.torch, 0.10 * k));
  ctx.fillStyle = g;
  ctx.fillRect(x - w / 2, top, w, h);
  ctx.restore();
  // one leaf, swung inward
  const lw = Math.round(w * 0.5 * (1 - k * 0.8));
  pxSolid(ctx, x - w / 2, top + 2, Math.max(2, lw), h - 4, '#4a3524', { ink: P.ink, light: '#6a4d33', dark: null });
  for (let i = 0; i < 3; i++) pxRect(ctx, x - w / 2, top + 8 + i * 16, Math.max(2, lw), 2, P.chain);
  // and the light it throws on the floor
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pool = ctx.createRadialGradient(x, base, 0, x, base, 40);
  pool.addColorStop(0, rgba(P.torch, 0.22 * k));
  pool.addColorStop(1, rgba(P.torch, 0));
  ctx.fillStyle = pool;
  ctx.fillRect(x - 44, base - 20, 88, 26);
  ctx.restore();
}

// A tear with the fire of the next floor coming through it.
function exitRift(ctx, e, k) {
  const P = PAL.hell;
  const x = Math.round(e.x), base = Math.round(e.y);
  const h = 62 * k, cy = base - 34;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, cy, 0, x, cy, 44);
  g.addColorStop(0, rgba(P.lavaHot, 0.5 * k));
  g.addColorStop(1, rgba(P.lava, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - 48, cy - 48, 96, 96);
  ctx.restore();
  // the tear itself: a jagged column of light
  for (let i = 0; i < 18; i++) {
    const u = i / 17;
    const yy = cy - h / 2 + u * h;
    const wob = Math.sin(e.t * 6 + i * 1.3) * 3;
    const ww = Math.round((1 - Math.abs(u - 0.5) * 1.7) * 13) + 2;
    pxRect(ctx, x + wob - ww / 2, yy, ww, 4, rgba(P.lavaHot, 0.85));
    pxRect(ctx, x + wob - ww / 4, yy, Math.max(1, ww / 2), 4, '#ffffff');
  }
  // embers falling out of it
  if (Math.random() < 0.4) {
    spawnParticle({
      x: x + rand(-8, 8), y: cy + rand(-20, 20), vx: rand(-20, 20), vy: rand(-40, 10),
      life: rand(0.4, 1.0), size: 1, color: P.lavaHot, gravity: 90, kind: 'shrink',
    });
  }
}

// Steps of light, climbing out of the frame.
function exitStair(ctx, e, k) {
  const P = PAL.aether;
  const x = Math.round(e.x), base = Math.round(e.y);
  for (let i = 0; i < 6; i++) {
    const kk = clamp(k * 6 - i, 0, 1);
    if (kk <= 0) break;
    const w = Math.round(30 * kk);
    const yy = base - 6 - i * 9;
    const xx = Math.round(x - w / 2 + i * 3);
    pxRect(ctx, xx - 1, yy - 1, w + 2, 5, P.ink);      // the outline first
    pxRect(ctx, xx, yy, w, 3, '#ffffff');
    pxRect(ctx, xx, yy + 2, w, 1, P.stoneMid);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(0, yy + 3, 0, yy + 14);
    g.addColorStop(0, rgba(P.glow, 0.4 * kk));
    g.addColorStop(1, rgba(P.glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(xx - 4, yy + 3, w + 8, 12);
    ctx.restore();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const col = ctx.createLinearGradient(0, base - 80, 0, base);
  col.addColorStop(0, rgba(P.glow, 0));
  col.addColorStop(1, rgba(P.glowSoft, 0.22 * k));
  ctx.fillStyle = col;
  ctx.fillRect(x - 26, base - 80, 52, 80);
  ctx.restore();
}

function exitFortress(ctx, e, k) { drawFortress(ctx, e.x, e.y, k); }

// The fortress at the end of the field: a plain wall of grey stone with a gate
// in it. `k` is how far open the gate is - 0 while the field is still yours to
// win, 1 once it is.
export function drawFortress(ctx, ex, ey, k, part = 'all') {
  const C = PAL.castle;
  const x = Math.round(ex), base = Math.round(ey);
  const wallX = x - 66, wallW = VIEW_W - wallX;
  const wallTop = 26;
  const gw = 44, gh = 62, gx = x - gw / 2, gy = base - gh;

  // --- what is behind you as you walk in: the gateway, its light, the doors
  if (part === 'all' || part === 'back') {
    pxRect(ctx, gx - 3, gy - 4, gw + 6, gh + 4, C.stoneDark);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(0, gy, 0, base);
    g.addColorStop(0, rgba(C.torch, 0.55 * k));
    g.addColorStop(1, rgba(C.torch, 0.12 * k));
    ctx.fillStyle = g;
    ctx.fillRect(gx, gy, gw, gh);
    ctx.restore();
    // the two leaves, drawn back into the walls as it opens
    for (const side of [-1, 1]) {
      const lw = Math.round((gw / 2) * (1 - k));
      if (lw <= 0) continue;
      const lx = side < 0 ? gx : gx + gw - lw;
      pxSolid(ctx, lx, gy, lw, gh, '#4a3524', { ink: C.ink, light: '#6a4d33', dark: null });
      for (let i = 0; i < 4; i++) pxRect(ctx, lx, gy + 8 + i * 15, lw, 2, C.chain);
    }
    // the portcullis, hauled up above the arch
    const pcY = gy + Math.round((1 - k) * 26);
    for (let i = 0; i <= gw; i += 7) pxRect(ctx, gx + i, gy - 10, 2, pcY - gy + 10, C.chain);
    pxRect(ctx, gx - 2, pcY, gw + 4, 2, C.chainLit);
  }
  if (part === 'back') return;

  // --- and the stone itself, which stands in front of everything. The gateway
  // is left as a hole in it, so walking in reads as walking in rather than as
  // disappearing behind a wall.
  const holeL = gx - 3, holeR = gx + gw + 3, holeTop = gy - 4;
  const band = (bx, bw2, by, bh2) => {
    if (bw2 <= 0 || bh2 <= 0) return;
    pxSolid(ctx, bx, by, bw2, bh2, C.stone, { ink: C.ink, light: C.stoneLit, dark: null });
    for (let yy = by + 6; yy < by + bh2; yy += 11) {
      pxRect(ctx, bx, yy, bw2, 1, rgba(C.ink, 0.5));
      for (let xx = bx + ((yy / 11) % 2 ? 0 : 13); xx < bx + bw2; xx += 26) {
        pxRect(ctx, xx, yy, 1, Math.min(11, by + bh2 - yy), rgba(C.ink, 0.45));
      }
    }
  };
  band(wallX, holeL - wallX, wallTop, base - wallTop);          // left of the gate
  band(holeR, VIEW_W - holeR, wallTop, base - wallTop);         // right of it
  band(holeL, holeR - holeL, wallTop, holeTop - wallTop);       // over the arch

  // battlements along the top
  for (let xx = wallX; xx < VIEW_W; xx += 18) {
    pxSolid(ctx, xx, wallTop - 10, 11, 11, C.stone, { ink: C.ink, light: C.stoneLit, dark: null });
  }
  // a tower on the near corner
  pxSolid(ctx, wallX - 16, wallTop - 26, 18, base - wallTop + 26, C.stoneDark,
          { ink: C.ink, light: C.stone, dark: null });
  for (let xx = 0; xx < 18; xx += 6) {
    pxSolid(ctx, wallX - 16 + xx, wallTop - 34, 4, 9, C.stoneDark, { ink: C.ink, light: null, dark: null });
  }
}

// Out in the field there is no door. A post pushes up out of the turf with an
// arrow on it, the edge of the map lets go, and you walk.
function exitSign(ctx, e, k) {
  const P = PAL.field;
  const rise = 1 - Math.pow(1 - k, 3);
  const base = Math.round(e.y);
  const x = Math.round(e.x);
  const h = Math.round(40 * rise);
  if (h < 4) return;
  // the earth it came up through
  pxRect(ctx, x - 7, base - 2, 14, 3, P.dirtDark);
  pxRect(ctx, x - 5, base - 3, 10, 1, P.dirtLit);
  // the post
  pxSolid(ctx, x - 2, base - h, 4, h, P.trunk, { ink: P.ink, light: P.trunkDark, dark: null });
  // the board, pointed to the right
  const by = base - h - 2;
  const bw = 34, bh = 14;
  pxSolid(ctx, x - 12, by, bw, bh, '#8a6a42', { ink: P.ink, light: '#ad8b5c', dark: null });
  for (let i = 0; i < 5; i++) {
    pxRect(ctx, x - 12 + bw + i, by + 1 + i, 1, bh - 2 - i * 2, '#8a6a42');
    pxRect(ctx, x - 12 + bw + i, by + 1 + i, 1, 1, P.ink);
    pxRect(ctx, x - 12 + bw + i, by + bh - 2 - i, 1, 1, P.ink);
  }
  // the arrow burned into it
  const ay = by + bh / 2;
  pxRect(ctx, x - 7, ay - 1, 16, 2, '#3d2a18');
  for (let i = 0; i < 5; i++) pxRect(ctx, x + 9 - i, ay - 1 - i, 1, 2 + i * 2, '#3d2a18');
  // and a nudge of light pulling right
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pulse = (Math.sin(e.t * 3) * 0.5 + 0.5);
  glowDot(ctx, x + 26 + pulse * 10, ay, 14, P.sunGlow, 0.25 * k);
  ctx.restore();
}

// The old way through: a hole in the air with something turning inside it.
function exitPortal(ctx, e, k) {
  const P = PAL.aether;
  const w = 22 * k, h = 38 * k;
  const cy = e.y - 22;
  const breathe = 1 + Math.sin(e.t * 2.2) * 0.05;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pool = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, 44 * k);
  pool.addColorStop(0, rgba(P.glow, 0.3 * k));
  pool.addColorStop(1, rgba(P.glow, 0));
  ctx.fillStyle = pool;
  ctx.fillRect(e.x - 48, e.y - 26, 96, 34);
  for (let i = 5; i >= 0; i--) {
    ctx.fillStyle = rgba(i % 2 ? P.glow : P.glowSoft, 0.10 + 0.05 * Math.sin(e.t * 3 + i));
    ctx.beginPath();
    ctx.ellipse(e.x, cy, (w / 2) * (1 + i * 0.13) * breathe, (h / 2) * (1 + i * 0.13) * breathe, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // the mouth, with arms turning in it
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(e.x, cy, (w / 2) * breathe, (h / 2) * breathe, 0, 0, TAU);
  ctx.clip();
  ctx.fillStyle = rgba('#0b1020', 0.92);
  ctx.fillRect(e.x - w, cy - h, w * 2, h * 2);
  ctx.globalCompositeOperation = 'lighter';
  for (let arm = 0; arm < 3; arm++) {
    ctx.strokeStyle = rgba(arm % 2 ? P.glow : '#ffffff', 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 22; i++) {
      const u = i / 22;
      const ang = e.t * 1.5 + arm * (TAU / 3) + u * 5.2;
      const rr = u * (w / 2);
      const px = e.x + Math.cos(ang) * rr;
      const py = cy + Math.sin(ang) * rr * (h / w);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = rgba(P.glow, 0.9);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(e.x, cy, (w / 2) * breathe, (h / 2) * breathe, 0, 0, TAU);
  ctx.stroke();
}

// Painted over the room rather than behind it. The castle at the end of the
// field is the nearest thing on the screen - the hills run behind it, and you
// walk in under it - so it goes on last, after everything else in the world.
export function drawChapterForeground(ctx, t, room, open = 0) {
  if (room !== CHAPTERS[0].to || chapterFor(room).id !== 'field') return;
  drawFortress(ctx, VIEW_W - 34, GROUND_Y, open, 'front');
}

/** The part of the castle that stands behind you: the gateway and its doors. */
export function drawChapterBackdrop(ctx, t, room, open = 0) {
  if (room !== CHAPTERS[0].to || chapterFor(room).id !== 'field') return;
  drawFortress(ctx, VIEW_W - 34, GROUND_Y, open, 'back');
}

// --- the city this game used to be set in --------------------------------
// Kept whole for PvP, which rolls it as one of its maps. It is the only place
// that still reads its colours out of the theme, because it is the map every
// shader pack was written against.

const CITY_LAYERS = [
  { count: 9, minH: 70, maxH: 130, minW: 18, maxW: 30, alpha: 0.34, tint: 0.0, lit: 0.10 },
  { count: 7, minH: 100, maxH: 175, minW: 26, maxW: 44, alpha: 0.52, tint: 0.30, lit: 0.26 },
  { count: 5, minH: 130, maxH: 215, minW: 34, maxW: 58, alpha: 0.72, tint: 0.6, lit: 0.45 },
];

function bakeCyber(ctx, room) {
  const r = rng(room + 313);
  ctx.fillStyle = grad(ctx, [[0, Theme.bgFar], [0.45, Theme.bgMid], [0.82, Theme.bgNear], [1, Theme.fog]], 0, VIEW_H);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // the glow sitting on the horizon behind the towers
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const hg = ctx.createRadialGradient(VIEW_W / 2, GROUND_Y - 10, 0, VIEW_W / 2, GROUND_Y - 10, 260);
  hg.addColorStop(0, rgba(Theme.platformGlow, 0.08));
  hg.addColorStop(1, rgba(Theme.platformGlow, 0));
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.restore();

  // stars, baked at the middle of their twinkle
  for (let i = 0; i < 90; i++) {
    const x = r() * VIEW_W, y = r() * (GROUND_Y - 30);
    const s2 = r() < 0.2 ? 2 : 1;
    pxRect(ctx, x, y, s2, s2, rgba(r() < 0.25 ? Theme.uiAccent : Theme.star, 0.45));
  }

  // three depths of skyline
  for (let l = 0; l < CITY_LAYERS.length; l++) {
    const L = CITY_LAYERS[l];
    ctx.save();
    ctx.globalAlpha = L.alpha;
    for (let i = 0; i < L.count; i++) {
      const w = L.minW + r() * (L.maxW - L.minW);
      const x = Math.round((i + r() * 0.7) * (VIEW_W / L.count) - 20);
      const h = L.minH + r() * (L.maxH - L.minH);
      const top = Math.round(GROUND_Y - h);
      const body = mixHex(mixHex(Theme.fog, Theme.bgFar, 0.45), Theme.bgNear, 1 - L.tint);
      pxRect(ctx, x, top, w, h, body);
      pxRect(ctx, x, top, w, 2, rgba(Theme.platformGlow, 0.10 + L.lit * 0.20));
      pxRect(ctx, x, top, 1, h, rgba(Theme.platformGlow, 0.06 + L.lit * 0.10));
      const windows = Math.floor(2 + r() * 4);
      for (let k = 0; k < windows; k++) {
        const wy = top + 14 + k * 26;
        if (wy > GROUND_Y - 14) break;
        pxRect(ctx, x + 4, wy, 3, 6, rgba(Theme.platformGlow, 0.10 + L.lit * 0.3));
        if (w > 30) pxRect(ctx, x + w - 8, wy + 6, 3, 6, rgba(Theme.uiAccent, 0.18));
      }
    }
    ctx.restore();
  }

  // fog banks and the haze over the floor
  for (let i = 0; i < 7; i++) {
    const x = r() * VIEW_W, y = GROUND_Y - 90 + r() * 100, rr = 60 + r() * 70;
    const fg = ctx.createRadialGradient(x, y, 0, x, y, rr);
    fg.addColorStop(0, rgba(Theme.fog, 0.05 + r() * 0.07));
    fg.addColorStop(1, rgba(Theme.fog, 0));
    ctx.fillStyle = fg;
    ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  ctx.fillStyle = grad(ctx, [[0, rgba(Theme.bgNear, 0)], [1, rgba(Theme.bgNear, 0.5)]], GROUND_Y - 52, GROUND_Y);
  ctx.fillRect(0, GROUND_Y - 52, VIEW_W, 52);
}

function floorCyber(ctx, room) {
  ctx.fillStyle = grad(ctx, [[0, Theme.ground], [1, mixHex(Theme.ground, '#000000', 0.45)]], GROUND_Y, VIEW_H);
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  pxRect(ctx, 0, GROUND_Y, VIEW_W, 1, Theme.groundTop);
  pxRect(ctx, 0, GROUND_Y + 1, VIEW_W, 2, mixHex(Theme.groundTop, Theme.ground, 0.5));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = grad(ctx, [[0, rgba(Theme.groundEdge, 0.16)], [1, rgba(Theme.groundEdge, 0)]], GROUND_Y, GROUND_Y + 16);
  ctx.fillRect(0, GROUND_Y, VIEW_W, 16);
  ctx.fillStyle = rgba(Theme.groundEdge, 0.14);
  ctx.fillRect(0, GROUND_Y - 5, VIEW_W, 5);
  ctx.restore();
  for (let row = 0; row < 3; row++) {
    const y = GROUND_Y + 3 + row * 11;
    if (y > VIEW_H) break;
    pxRect(ctx, 0, y, VIEW_W, 1, rgba('#000000', 0.22));
    for (let x = row % 2 ? 0 : 8; x < VIEW_W; x += 16) {
      pxRect(ctx, x, y, 1, 11, rgba('#000000', 0.26));
      pxRect(ctx, x + 1, y + 1, 1, 9, rgba(Theme.groundTop, 0.05));
    }
  }
}

function platformNeon(ctx, p, t) {
  const x = Math.round(p.x), y = Math.round(p.y), w = Math.round(p.w), h = Math.round(p.h);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pool = ctx.createRadialGradient(x + w / 2, y + h + 6, 0, x + w / 2, y + h + 6, w * 0.6);
  pool.addColorStop(0, rgba(Theme.platformGlow, 0.10));
  pool.addColorStop(1, rgba(Theme.platformGlow, 0));
  ctx.fillStyle = pool;
  ctx.fillRect(x - 20, y, w + 40, 40);
  ctx.restore();

  ctx.fillStyle = grad(ctx, [[0, Theme.platformTop], [0.3, Theme.platform],
                             [1, mixHex(Theme.platform, '#000000', 0.4)]], y, y + h);
  ctx.fillRect(x, y, w, h);
  pxRect(ctx, x, y, w, 1, mixHex(Theme.platformTop, Theme.platformGlow, 0.45));
  pxRect(ctx, x, y + h, w, 1, rgba(Theme.platformGlow, 0.35 + 0.3 * Math.sin(t * 2.4 + x * 0.05)));
  for (let i = BLOCK; i < w; i += BLOCK) {
    pxRect(ctx, x + i, y, 1, h, rgba('#000000', 0.28));
    pxRect(ctx, x + i + 1, y + 1, 1, h - 2, rgba(Theme.platformTop, 0.12));
  }
  if (p.motion !== 'none') {
    const pulse = 0.35 + 0.25 * Math.sin(t * 8 + x * 0.1);
    for (const ox of [10, w / 2, w - 10]) {
      pxRect(ctx, x + ox - 1, y + h, 2, 3, rgba(Theme.platformGlow, pulse));
      glowDot(ctx, x + ox, y + h + 3, 8, Theme.platformGlow, pulse * 0.55);
    }
  }
}
