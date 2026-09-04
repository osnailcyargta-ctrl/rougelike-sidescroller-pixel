// Front-end screens: main menu, settings (shader packs), class select,
// pause, and the death screen.
import { clamp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { drawText, drawTextShadow, textWidth } from './font.js';
import { pxRect, glowDot, spawnParticle } from './gfx.js';
import { VIEW_W, VIEW_H, FINAL_ROOM } from './config.js';
import { panel, button, slider, textField, drawTooltip, UI } from './ui.js';
import { Options, optionsIn, saveOptions, resetOptions, applyVisualOptions } from './settings.js';
import { Perf, syncPerfOptions } from './perf.js';
import { drawItemIcon, ITEMS, RARITY } from './items.js';
import { AudioCfg, setVolume, Sfx } from './audio.js';
import { randomSeedText } from './util.js';
import { Input, Binds, BIND_ORDER, BIND_LABELS, bindLabel, setBind, resetBinds } from './input.js';

const CLASS_LABEL = { melee: 'MELEE', ranger: 'RANGER', origamist: 'ORIGAMIST' };

// Break a line on spaces so it never runs past the width it was given.
function wrapLine(text, maxW, scale = 1) {
  if (textWidth(text, scale) <= maxW) return [text];
  const words = String(text).split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, scale) > maxW) { out.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

// The logo. Not just the title typed out: a struck emblem behind it, a beam of
// light raking across the letters, each glyph carved with its own bevel and
// dropping its own shadow, and a shard-ring that turns behind the whole thing.
function drawLogoMark(ctx, cx, cy, t, scale = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  // the halo the mark stands in
  ctx.globalCompositeOperation = 'lighter';
  glowDot(ctx, 0, 0, 46, Theme.uiAccent, 0.14 + 0.05 * Math.sin(t * 1.6));
  // three rings of shards, each turning at its own rate
  const rings = [[34, 0.30, 16], [26, -0.44, 12], [18, 0.62, 8]];
  for (let r = 0; r < rings.length; r++) {
    const [rad, spin, n] = rings[r];
    for (let i = 0; i < n; i++) {
      const a = t * spin + (i / n) * TAU;
      const wob = rad + Math.sin(t * 1.4 + i + r) * 1.4;
      const px = Math.cos(a) * wob;
      const py = Math.sin(a) * wob * 0.62;
      const lit = (i + r) % 3 === 0;
      pxRect(ctx, px - 1, py - 1, lit ? 2 : 1, lit ? 2 : 1,
             rgba(lit ? '#ffffff' : Theme.uiAccent, 0.25 + 0.35 * Math.sin(t * 3 + i)));
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  // the sigil: a downward chevron inside a diamond - the descent, struck in metal
  const pulse = 1 + Math.sin(t * 1.9) * 0.03;
  ctx.save();
  ctx.scale(pulse, pulse);
  const dia = (r, col) => {
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.72, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.72, 0);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
  };
  dia(15, rgba('#000000', 0.75));
  dia(13, Theme.uiPanel);
  ctx.strokeStyle = Theme.uiAccent;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, -13); ctx.lineTo(9.4, 0); ctx.lineTo(0, 13); ctx.lineTo(-9.4, 0);
  ctx.closePath();
  ctx.stroke();
  // two chevrons pointing down, the brighter one leading
  for (let i = 0; i < 2; i++) {
    const oy = -3 + i * 5;
    const a = i === 0 ? 1 : 0.45;
    ctx.strokeStyle = rgba(i === 0 ? '#ffffff' : Theme.platformGlow, a);
    ctx.lineWidth = i === 0 ? 1.6 : 1.2;
    ctx.beginPath();
    ctx.moveTo(-5, oy); ctx.lineTo(0, oy + 4); ctx.lineTo(5, oy);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

function titleGlyphs(ctx, t) {
  const title = 'AETHER';
  const sub = 'DESCENT';
  const s = 4;
  const w = textWidth(title, s);
  const x0 = (VIEW_W - w) / 2;
  const baseY = 58;

  // the sigil sits above the wordmark, never behind it
  drawLogoMark(ctx, VIEW_W / 2, 27, t, 0.95);

  // a light sweep that travels across the wordmark, in glyph units
  const sweep = ((t * 0.42) % 1.6) * (title.length + 3) - 1.5;

  for (let i = 0; i < title.length; i++) {
    const ox = x0 + i * (6 * s);
    const bob = Math.sin(t * 1.8 + i * 0.55) * 1.6;
    const oy = baseY + bob;
    const near = clamp(1 - Math.abs(i - sweep) / 1.4, 0, 1);

    // a long shadow, then the bevel, then the face
    drawText(ctx, title[i], ox + 3, oy + 4, rgba('#000000', 0.55), s);
    drawText(ctx, title[i], ox + 1, oy + 2, rgba(Theme.bgFar, 0.9), s);
    drawText(ctx, title[i], ox, oy + 1, rgba(Theme.uiAccent, 0.55), s);   // bevel
    drawText(ctx, title[i], ox, oy, i % 2 ? Theme.uiAccent : Theme.ui, s);
    // the sweep lights one glyph at a time
    if (near > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawText(ctx, title[i], ox, oy - 1, rgba('#ffffff', near * 0.85), s);
      glowDot(ctx, ox + 2.5 * s, oy + 3.5 * s, 22 * near, '#ffffff', near * 0.20);
      ctx.restore();
    }
  }

  // rules either side of the subtitle, drawn out from the centre
  const sy = baseY + 7 * s + 8;
  const subW = textWidth(sub, 2);
  const ruleW = 46;
  for (const dir of [-1, 1]) {
    const gx = VIEW_W / 2 + dir * (subW / 2 + 8);
    const g = ctx.createLinearGradient(gx, 0, gx + dir * ruleW, 0);
    g.addColorStop(0, rgba(Theme.platformGlow, 0.85));
    g.addColorStop(1, rgba(Theme.platformGlow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(gx, gx + dir * ruleW), sy + 3, ruleW, 1);
  }
  drawTextShadow(ctx, sub, VIEW_W / 2, sy, Theme.platformGlow, 2, 'center');

  // dust lifting off the wordmark
  if (Math.random() < 0.5) {
    spawnParticle({
      x: x0 + rand(0, w), y: baseY + rand(0, 7 * s),
      vx: rand(-6, 6), vy: rand(-22, -6), life: rand(0.8, 1.8),
      size: 1, color: Math.random() < 0.4 ? '#ffffff' : Theme.uiAccent,
      gravity: -6, drag: 0.98, kind: 'shrink',
    });
  }
}

export function drawMenuBackdrop(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, Theme.bgFar);
  g.addColorStop(1, Theme.bgNear);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  for (let i = 0; i < 40; i++) {
    const x = (i * 71 + t * (8 + (i % 5) * 4)) % (VIEW_W + 20) - 10;
    const y = (i * 37) % VIEW_H;
    const a = 0.15 + 0.35 * Math.sin(t * 2 + i);
    pxRect(ctx, x, y, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1, rgba(Theme.star, a));
  }
  // horizon glow
  glowDot(ctx, VIEW_W / 2, VIEW_H + 20, 200, Theme.platformGlow, 0.18);
  for (let x = 0; x < VIEW_W; x += 8) {
    const h = 14 + Math.sin(x * 0.05 + t * 0.6) * 8;
    pxRect(ctx, x, VIEW_H - h, 8, h, rgba(Theme.fog, 0.6));
  }
}

export function drawMainMenu(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  titleGlyphs(ctx, t);
  const bw = 132, bh = 20, x = (VIEW_W - bw) / 2;
  let y = 148;
  if (button(ctx, 'play', x, y, bw, bh, 'PLAY')) game.goClassSelect();
  y += bh + 6;
  if (button(ctx, 'settings', x, y, bw, bh, 'SETTINGS')) { UI.tab = 'indicator'; game.screen = 'settings'; }
  y += bh + 6;
  if (button(ctx, 'controls', x, y, bw, bh, 'CONTROLS')) { UI.tab = 'binds'; game.screen = 'settings'; }
  drawTextShadow(ctx, 'A ROGUELIKE SIDESCROLLER', VIEW_W / 2, VIEW_H - 16, Theme.uiDim, 1, 'center');
  if (game.shaderName) {
    drawTextShadow(ctx, `SHADER: ${game.shaderName}`, 6, VIEW_H - 12, Theme.platformGlow, 1);
  }
}

// One settings screen, three tabs: what the game tells you, how it looks, and
// what the keys do. Everything here writes straight through to localStorage.
const TABS = [
  { id: 'indicator', label: 'INDICATORS' },
  { id: 'visual', label: 'VISUALS' },
  { id: 'binds', label: 'KEYS' },
  { id: 'touch', label: 'TOUCH' },
];

export function drawSettings(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  panel(ctx, 18, 8, VIEW_W - 36, VIEW_H - 30);
  drawTextShadow(ctx, 'SETTINGS', VIEW_W / 2, 13, Theme.uiAccent, 2, 'center');

  // --- tab strip
  const tw = 86, ty = 29;
  const tx0 = Math.round((VIEW_W - (TABS.length * tw + (TABS.length - 1) * 6)) / 2);
  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    const x = tx0 + i * (tw + 6);
    const on = UI.tab === tab.id;
    if (button(ctx, 'tab' + tab.id, x, ty, tw, 14, tab.label, { selected: on })) {
      UI.tab = tab.id;
      UI.rebinding = null;
    }
    if (on) pxRect(ctx, x + 6, ty + 15, tw - 12, 1, Theme.uiAccent);
  }

  if (UI.tab === 'binds') drawBindsTab(ctx, game, t);
  else if (UI.tab === 'visual') drawVisualTab(ctx, game, t);
  else if (UI.tab === 'touch') drawTouchTab(ctx, game, t);
  else drawIndicatorTab(ctx, game, t);

  if (button(ctx, 'back', VIEW_W / 2 - 45, VIEW_H - 20, 90, 15, 'BACK')) {
    UI.rebinding = null;
    game.screen = game.returnScreen || 'menu';
    game.returnScreen = null;
  }
}

// The on-screen pad: one switch to raise it, two dials to fit it to the hand,
// and a legend, because nothing on the pad is labelled with a key name.
function drawTouchTab(ctx, game, t) {
  const on = !!Options.mobileControls;
  drawText(ctx, 'TWO THUMBS, NO KEYBOARD', VIEW_W / 2, 50, Theme.uiDim, 1, 'center');

  // left column: the switches. Sliders share one column so the readouts line
  // up and stay clear of the legend on the right.
  const x = 34, ctl = x + 120, read = x + 206;
  let y = 64;
  drawText(ctx, 'ON-SCREEN CONTROLS', x, y + 4, on ? Theme.ui : Theme.uiDim, 1);
  if (button(ctx, 'opt-mobile', ctl, y, 44, 14, on ? 'ON' : 'OFF', { selected: on })) {
    Options.mobileControls = !on;
    saveOptions();
    Sfx.ui();
  }
  y += 22;

  for (const d of optionsIn('touch')) {
    if (d.type !== 'range') continue;
    const max = d.max ?? 1;
    const cur = clamp((Options[d.id] ?? d.def) / max, 0, 1);
    drawText(ctx, d.label, x, y + 2, on ? Theme.ui : Theme.uiDim, 1);
    const next = slider(ctx, 'ts-' + d.id, ctl, y + 1, 44, cur);
    if (Math.abs(next - cur) > 0.0005) {
      Options[d.id] = next * max;
      saveOptions();
    }
    drawText(ctx, `${Math.round((Options[d.id] ?? 0) * 100)}%`, read, y + 2, Theme.uiDim, 1, 'right');
    y += 16;
  }

  // performance. The watchdog picks a tier on its own; this forces the floor.
  const lp = !!Options.lowPower;
  drawText(ctx, 'LOW POWER MODE', x, y + 4, lp ? Theme.ui : Theme.uiDim, 1);
  if (button(ctx, 'opt-lowpower', ctl, y, 44, 14, lp ? 'ON' : 'OFF', { selected: lp })) {
    Options.lowPower = !lp;
    saveOptions();
    if (syncPerfOptions()) game.resize();
    Sfx.ui();
  }
  // short enough to clear the switch beside it
  drawText(ctx, lp ? 'FORCED' : Perf.name, read, y + 2, Theme.uiDim, 1, 'right');
  y += 20;

  const gy = y + 10;
  drawText(ctx, 'GESTURES', x, gy, Theme.platformGlow, 1);
  const gest = [
    'FLICK THE MOVE STICK LEFT',
    'OR RIGHT TWICE TO DASH.',
    '',
    'FLICK IT DOWN TWICE IN',
    'THE AIR TO GROUND SLAM.',
    '',
    'THE STICKS ONLY ANSWER TO',
    'A DRAG, NOT A TAP.',
  ];
  let ggy = gy + 13;
  for (const line of gest) {
    if (line) drawText(ctx, line, x, ggy, on ? Theme.uiDim : rgba(Theme.uiDim, 0.55), 1);
    ggy += 10;
  }

  // right column: what each control does, since none of them carry a key name
  const lx = 250, vx = lx + 72;
  drawText(ctx, 'THE PAD', lx, 64, Theme.platformGlow, 1);
  const legend = [
    ['LEFT STICK', 'MOVE / JUMP / DROP'],
    ['RIGHT STICK', 'MOVE THE CROSSHAIR'],
    ['FIRE', 'ATTACK (HOLD)'],
    ['HOOK', 'GRAPPLE'],
    ['USE', 'INTERACT'],
    ['AUTO', 'FIRE WHILE AIMING'],
    ['BAG', 'INVENTORY'],
    ['PAUSE', 'TOP LEFT CORNER'],
  ];
  let ly = 78;
  for (const [k, v] of legend) {
    drawText(ctx, k, lx, ly, on ? Theme.uiAccent : Theme.uiDim, 1);
    drawText(ctx, v, vx, ly, Theme.uiDim, 1);
    ly += 11;
  }
  drawText(ctx, 'PERFORMANCE', lx, ly + 8, Theme.platformGlow, 1);
  drawText(ctx, 'QUALITY DROPS BY ITSELF', lx, ly + 21, Theme.uiDim, 1);
  drawText(ctx, 'IF FRAMES GET TIGHT.', lx, ly + 31, Theme.uiDim, 1);
}

// Two columns of switches. Nothing here changes the game, only what it is
// willing to tell you about it.
function drawIndicatorTab(ctx, game, t) {
  const defs = optionsIn('indicator');
  const colW = 194;
  const x0 = Math.round((VIEW_W - colW * 2 - 10) / 2);
  const rows = Math.ceil(defs.length / 2);
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = x0 + col * (colW + 10);
    const y = 52 + row * 16;
    const on = !!Options[d.id];
    drawText(ctx, d.label, x, y + 4, on ? Theme.ui : Theme.uiDim, 1);
    if (button(ctx, 'opt' + d.id, x + colW - 38, y, 38, 13, on ? 'ON' : 'OFF', { selected: on })) {
      Options[d.id] = !on;
      saveOptions();
      Sfx.ui();
    }
  }
  drawText(ctx, 'READOUTS ONLY - NONE OF THESE CHANGE THE FIGHT',
           VIEW_W / 2, VIEW_H - 36, rgba(Theme.uiDim, 0.75), 1, 'center');
}

// Sliders for the look, the shader loader, and a swatch row so a pack's
// palette is visible without starting a run.
function drawVisualTab(ctx, game, t) {
  const defs = optionsIn('visual');
  const colW = 186;
  const x0 = 32;
  const rows = Math.ceil(defs.length / 2);
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = x0 + col * (colW + 14);
    const y = 50 + row * 13;
    drawText(ctx, d.label, x, y + 2, Theme.ui, 1);
    const max = d.max ?? 1;
    const cur = clamp((Options[d.id] ?? d.def) / max, 0, 1);
    const next = slider(ctx, 'vis' + d.id, x + 108, y + 1, 44, cur);
    if (Math.abs(next - cur) > 0.0005) {
      Options[d.id] = next * max;
      saveOptions();
      applyVisualOptions();
      if (d.id === 'volume') setVolume(Options.volume);
    }
    // percentages for 0..1 dials, multipliers for the ones that go past 1
    const v = Options[d.id] ?? 0;
    const readout = max > 1 ? `${v.toFixed(2)}X` : `${Math.round(v * 100)}%`;
    drawText(ctx, readout, x + colW - 4, y + 2, Theme.uiDim, 1, 'right');
  }

  const py = 50 + rows * 13 + 4;
  pxRect(ctx, 32, py, VIEW_W - 64, 1, rgba(Theme.uiDim, 0.4));
  drawText(ctx, 'SHADER PACK (.SHDR)', 32, py + 5, Theme.platformGlow, 1);
  if (button(ctx, 'load', 32, py + 15, 70, 14, 'LOAD')) game.requestShaderUpload();
  if (button(ctx, 'reset', 106, py + 15, 58, 14, 'RESET', { disabled: !game.shaderName })) game.resetShader();
  if (button(ctx, 'sample', 168, py + 15, 92, 14, 'SAMPLE')) game.downloadSampleShader();
  if (button(ctx, 'defaults', 264, py + 15, 78, 14, 'DEFAULTS')) {
    resetOptions();
    applyVisualOptions();
    setVolume(Options.volume);
    Sfx.ui();
  }
  const status = game.shaderError ? game.shaderError.slice(0, 40)
    : game.shaderName ? `ACTIVE: ${game.shaderName}` : 'BUILT-IN SHADER';
  drawText(ctx, status, 32, py + 33, game.shaderError ? Theme.hp : Theme.ui, 1);
  if (!game.postfx.ok) drawText(ctx, 'WEBGL OFF - EFFECTS DISABLED', 32, py + 42, Theme.hp, 1);
  else drawText(ctx, 'SETTINGS AND SHADER SAVE AUTOMATICALLY', 32, py + 42, rgba(Theme.uiDim, 0.75), 1);

  const keys = ['player', 'uiAccent', 'platformGlow', 'enemyGrunt', 'enemyBrute',
                'fire', 'lightning', 'slime', 'hp', 'ground'];
  drawText(ctx, 'PALETTE', VIEW_W - 32, py + 21, rgba(Theme.uiDim, 0.9), 1, 'right');
  for (let i = 0; i < keys.length; i++) {
    const sx = VIEW_W - 32 - (keys.length - i) * 12;
    ctx.fillStyle = rgba('#000000', 0.5);
    ctx.fillRect(sx, py + 29, 10, 10);
    ctx.fillStyle = Theme[keys[i]];
    ctx.fillRect(sx + 1, py + 30, 8, 8);
  }
}

function drawBindsTab(ctx, game, t) {
  drawText(ctx, 'CLICK A KEY TO REBIND IT', VIEW_W / 2, 50, Theme.uiDim, 1, 'center');

  // a key press while rebinding is consumed here, never by gameplay
  if (UI.rebinding) {
    Input.captureText = true;
    for (const k of Input.pressed) {
      if (k === 'Escape') { UI.rebinding = null; break; }
      if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'Tab') continue;
      setBind(UI.rebinding, k);
      UI.rebinding = null;
      Sfx.ui();
      break;
    }
  }

  let y = 64;
  for (const action of BIND_ORDER) {
    const waiting = UI.rebinding === action;
    drawText(ctx, BIND_LABELS[action], 44, y + 4, Theme.ui, 1);
    const label = waiting ? 'PRESS A KEY' : bindLabel(Binds[action]);
    if (button(ctx, 'bind-' + action, 178, y, waiting ? 92 : 52, 14, label, { selected: waiting })) {
      UI.rebinding = waiting ? null : action;
    }
    y += 17;
  }

  const fixed = [
    ['DOUBLE TAP MOVE', 'DASH'],
    ['DOUBLE TAP DROP', 'GROUND SLAM'],
    ['LEFT / RIGHT CLICK', 'ATTACK / INTERACT'],
    ['SCROLL, 1-4', 'HOTBAR / FOLD WHEEL'],
    ['ESC', 'PAUSE'],
  ];
  const fx = 288;
  drawText(ctx, 'FIXED', fx, 64, Theme.uiDim, 1);
  let fy = 78;
  for (const [k, v] of fixed) {
    drawText(ctx, k, fx, fy, Theme.uiAccent, 1);
    drawText(ctx, v, fx, fy + 9, Theme.uiDim, 1);
    fy += 21;
  }

  if (button(ctx, 'binddef', 44, y + 6, 96, 15, 'RESET DEFAULTS')) {
    resetBinds();
    UI.rebinding = null;
  }
}

// The old standalone controls screen is now just Settings opened on its tab.
export function drawControls(ctx, game, t) {
  UI.tab = 'binds';
  if (game.controlsReturn) { game.returnScreen = game.controlsReturn; game.controlsReturn = null; }
  game.screen = 'settings';
  drawSettings(ctx, game, t);
}

export function drawClassSelect(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  drawTextShadow(ctx, 'CHOOSE YOUR PATH', VIEW_W / 2, 12, Theme.uiAccent, 2, 'center');

  // --- seed. Blank means "surprise me"; anything typed replays exactly.
  const fieldW = 108;
  const rowW = 30 + fieldW + 4 + 56;
  const rowX = Math.round((VIEW_W - rowW) / 2);
  drawText(ctx, 'SEED', rowX, 33, Theme.uiDim, 1);
  game.seedText = textField(ctx, 'seed', rowX + 30, 30, fieldW, 12, game.seedText, {
    max: 12, placeholder: 'RANDOM',
  });
  if (button(ctx, 'seedroll', rowX + 30 + fieldW + 4, 30, 56, 12, 'ROLL')) {
    game.seedText = randomSeedText();
    UI.focus = null;
  }

  const cards = [
    {
      id: 'melee', name: 'MELEE', item: 'sword', color: Theme.hp,
      lines: ['IRON SWORD', '3 BLOCKS - 10 DMG', '0.45S SWING'],
    },
    {
      id: 'ranger', name: 'RANGER', item: 'bow', color: Theme.platformGlow,
      lines: ['HUNTER BOW', '10 BLOCKS - 5 DMG', '10 AMMO - 2S RELOAD'],
    },
    {
      id: 'origamist', name: 'ORIGAMIST', item: 'paper', color: '#efeade',
      lines: ['100 PAPER + TUTOR', 'FOLD WHEEL ON ATTACK', 'RESTOCKS ON KILLS'],
    },
  ];
  const cw = 140, ch = 126;
  const gap = 10;
  const totalW = cards.length * cw + (cards.length - 1) * gap;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const x = Math.round((VIEW_W - totalW) / 2) + i * (cw + gap);
    const y = 50;
    const hot = UI.hovered === 'class' + c.id;
    panel(ctx, x, y, cw, ch, { accent: c.color, alpha: hot ? 0.95 : 0.8 });
    glowDot(ctx, x + cw / 2, y + 42, 34, c.color, hot ? 0.35 : 0.18);
    ctx.save();
    ctx.translate(x + cw / 2, y + 42);
    const sc = 3 + (hot ? 0.4 : 0) + Math.sin(t * 3 + i) * 0.1;
    ctx.scale(sc, sc);
    drawItemIcon(ctx, c.item, -6, -6, 12, t);
    ctx.restore();
    // the name shrinks rather than spilling out of the card
    const nameScale = textWidth(c.name, 2) > cw - 16 ? 1 : 2;
    drawTextShadow(ctx, c.name, x + cw / 2, y + (nameScale === 2 ? 70 : 74), c.color, nameScale, 'center');
    // every stat line is wrapped to the card's inner width, and the block is
    // centred in the space left under the name so it can never reach the edge
    const wrapped = [];
    for (const line of c.lines) {
      for (const part of wrapLine(line, cw - 16)) wrapped.push(part);
    }
    const rows = Math.min(wrapped.length, 4);
    const top = y + 86 + Math.max(0, (3 - rows)) * 4;
    for (let k = 0; k < rows; k++) {
      drawText(ctx, wrapped[k], x + cw / 2, top + k * 9, Theme.ui, 1, 'center');
    }
    if (button(ctx, 'class' + c.id, x + 18, y + ch + 6, cw - 36, 18, 'SELECT')) {
      game.startRun(c.id);
    }
  }
  if (button(ctx, 'back', 8, VIEW_H - 24, 60, 16, 'BACK')) game.screen = 'menu';
}

export function drawPause(ctx, game, t) {
  ctx.fillStyle = rgba('#000000', 0.62);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  panel(ctx, VIEW_W / 2 - 80, 60, 160, 130);
  drawTextShadow(ctx, 'PAUSED', VIEW_W / 2, 70, Theme.uiAccent, 2, 'center');
  const bw = 120, x = VIEW_W / 2 - bw / 2;
  let y = 96;
  if (button(ctx, 'resume', x, y, bw, 18, 'RESUME')) game.screen = 'playing';
  y += 24;
  if (button(ctx, 'pset', x, y, bw, 18, 'SETTINGS')) { game.returnScreen = 'paused'; game.screen = 'settings'; }
  y += 24;
  if (button(ctx, 'quit', x, y, bw, 18, 'QUIT TO MENU')) game.quitToMenu();
}

export function drawGameOver(ctx, game, t) {
  ctx.fillStyle = rgba('#000000', clamp(game.deathT * 0.5, 0, 0.78));
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (game.deathT < 0.6) return;

  const st = game.runStats;
  const k = clamp((game.deathT - 0.6) / 0.5, 0, 1);
  const ease = 1 - Math.pow(1 - k, 3);
  ctx.globalAlpha = ease;

  drawTextShadow(ctx, 'YOU DIED', VIEW_W / 2, 22 - (1 - ease) * 8, Theme.hp, 3, 'center');

  const pw = 264, px = Math.round((VIEW_W - pw) / 2), py = 52;
  panel(ctx, px, py, pw, 122, { alpha: 0.9 });
  drawText(ctx, 'RUN SUMMARY', px + pw / 2, py + 6, Theme.uiAccent, 1, 'center');
  pxRect(ctx, px + 10, py + 16, pw - 20, 1, rgba(Theme.uiDim, 0.5));

  if (st) {
    const mins = Math.floor(st.time / 60);
    const secs = Math.floor(st.time % 60);
    const rows = [
      ['CLASS', CLASS_LABEL[st.classId] ?? 'MELEE'],
      ['REACHED', `ROOM ${st.room}  WAVE ${st.wave}/${st.waves}`],
      ['KILLS', String(st.kills)],
      ['TIME', `${mins}:${String(secs).padStart(2, '0')}`],
      ['MAX HP', String(st.maxHp)],
      ['SEED', st.seed || '-'],
    ];
    let ry = py + 24;
    for (const [label, value] of rows) {
      drawText(ctx, label, px + 12, ry, Theme.uiDim, 1);
      drawText(ctx, value, px + pw - 12, ry, Theme.ui, 1, 'right');
      ry += 11;
    }

    // what you were carrying when it ended
    drawText(ctx, 'CARRIED', px + 12, ry + 3, Theme.uiDim, 1);
    let ix = px + 62;
    let hoverTip = null;
    for (const item of st.items) {
      const def = ITEMS[item.id];
      if (!def) continue;
      const hot = Input.mouse.x >= ix && Input.mouse.x < ix + 14 &&
        Input.mouse.y >= ry && Input.mouse.y < ry + 14;
      ctx.fillStyle = rgba('#000000', 0.45);
      ctx.fillRect(ix, ry, 14, 14);
      ctx.strokeStyle = rgba(RARITY[def.rarity].color, hot ? 1 : 0.6);
      ctx.strokeRect(ix + 0.5, ry + 0.5, 13, 13);
      drawItemIcon(ctx, item.id, ix + 1, ry + 1, 12, t);
      if (item.count > 1) drawText(ctx, item.count, ix + 12, ry + 8, Theme.ui, 1, 'right');
      if (hot) hoverTip = { id: item.id, x: ix + 7, y: ry - 2 };
      ix += 17;
      if (ix > px + pw - 20) break;
    }
    if (!st.items.length) drawText(ctx, 'NOTHING', px + 62, ry + 3, Theme.uiDim, 1);
    if (hoverTip) drawTooltip(ctx, hoverTip);
  }

  const bw = 108;
  if (button(ctx, 'retry', VIEW_W / 2 - bw - 4, 182, bw, 18, 'RETRY SEED')) {
    game.seedText = st ? st.seed : game.seedText;
    game.goClassSelect();
  }
  if (button(ctx, 'gnew', VIEW_W / 2 + 4, 182, bw, 18, 'NEW SEED')) {
    game.seedText = '';
    game.goClassSelect();
  }
  if (button(ctx, 'gmenu', VIEW_W / 2 - 54, 204, 108, 18, 'MAIN MENU')) game.quitToMenu();
  ctx.globalAlpha = 1;
}

// The run's last screen: the god is down and the vault has nothing left to
// throw. Same summary as the death screen, wearing the opposite colours.
export function drawVictory(ctx, game, t) {
  const vt = game.victoryT;
  ctx.fillStyle = rgba('#0a0a12', clamp(vt * 0.45, 0, 0.82));
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // light climbing the frame while the summary settles in
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const beam = clamp(vt / 1.2, 0, 1);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + t * 0.09;
    const w = 26 + Math.sin(t * 0.7 + i) * 10;
    ctx.fillStyle = rgba('#ffe9a8', 0.05 * beam);
    ctx.save();
    ctx.translate(VIEW_W / 2, -30);
    ctx.rotate(a * 0.12 + Math.sin(t * 0.2 + i) * 0.05);
    ctx.fillRect(-w / 2 + (i - 3) * 44, 0, w, VIEW_H + 80);
    ctx.restore();
  }
  ctx.restore();

  // motes drifting up
  if (Math.random() < 0.6) {
    spawnParticle({
      x: rand(VIEW_W), y: VIEW_H + 4, vx: rand(-8, 8), vy: rand(-26, -10),
      life: rand(1.2, 2.6), size: 1, color: '#ffe9a8', gravity: -4, drag: 0.99, kind: 'shrink',
    });
  }

  if (vt < 0.5) return;
  const k = clamp((vt - 0.5) / 0.6, 0, 1);
  const ease = 1 - Math.pow(1 - k, 3);
  ctx.globalAlpha = ease;

  const glow = 0.6 + Math.sin(t * 2.2) * 0.25;
  glowDot(ctx, VIEW_W / 2, 20, 90, '#ffe9a8', 0.1 * glow);
  drawTextShadow(ctx, 'THE VAULT IS QUIET', VIEW_W / 2, 14 - (1 - ease) * 8, '#ffe9a8', 2, 'center');
  drawText(ctx, 'ALPHADS HAS FALLEN', VIEW_W / 2, 32, Theme.uiDim, 1, 'center');

  const st = game.runStats;
  const pw = 264, px = Math.round((VIEW_W - pw) / 2), py = 44;
  panel(ctx, px, py, pw, 118, { alpha: 0.9 });
  drawText(ctx, 'RUN COMPLETE', px + pw / 2, py + 6, '#ffd76a', 1, 'center');
  pxRect(ctx, px + 10, py + 16, pw - 20, 1, rgba(Theme.uiDim, 0.5));

  if (st) {
    const mins = Math.floor(st.time / 60);
    const secs = Math.floor(st.time % 60);
    const rows = [
      ['CLASS', CLASS_LABEL[st.classId] ?? 'MELEE'],
      ['CLEARED', `${FINAL_ROOM} ROOMS`],
      ['KILLS', String(st.kills)],
      ['TIME', `${mins}:${String(secs).padStart(2, '0')}`],
      ['SEED', st.seed || '-'],
    ];
    let ry = py + 24;
    for (const [label, value] of rows) {
      drawText(ctx, label, px + 12, ry, Theme.uiDim, 1);
      drawText(ctx, value, px + pw - 12, ry, Theme.ui, 1, 'right');
      ry += 11;
    }

    drawText(ctx, 'CARRIED', px + 12, ry + 3, Theme.uiDim, 1);
    let ix = px + 62;
    let hoverTip = null;
    for (const item of st.items) {
      const def = ITEMS[item.id];
      if (!def) continue;
      const hot = Input.mouse.x >= ix && Input.mouse.x < ix + 14 &&
        Input.mouse.y >= ry && Input.mouse.y < ry + 14;
      ctx.fillStyle = rgba('#000000', 0.45);
      ctx.fillRect(ix, ry, 14, 14);
      ctx.strokeStyle = rgba(RARITY[def.rarity].color, hot ? 1 : 0.6);
      ctx.strokeRect(ix + 0.5, ry + 0.5, 13, 13);
      drawItemIcon(ctx, item.id, ix + 1, ry + 1, 12, t);
      if (item.count > 1) drawText(ctx, item.count, ix + 12, ry + 8, Theme.ui, 1, 'right');
      if (hot) hoverTip = { id: item.id, x: ix + 7, y: ry - 2 };
      ix += 17;
      if (ix > px + pw - 20) break;
    }
    if (!st.items.length) drawText(ctx, 'NOTHING', px + 62, ry + 3, Theme.uiDim, 1);
    if (hoverTip) drawTooltip(ctx, hoverTip);
  }

  const bw = 108;
  if (button(ctx, 'vretry', VIEW_W / 2 - bw - 4, 182, bw, 18, 'SAME SEED')) {
    game.seedText = st ? st.seed : game.seedText;
    game.goClassSelect();
  }
  if (button(ctx, 'vnew', VIEW_W / 2 + 4, 182, bw, 18, 'NEW RUN')) {
    game.seedText = '';
    game.goClassSelect();
  }
  if (button(ctx, 'vmenu', VIEW_W / 2 - 54, 204, 108, 18, 'MAIN MENU')) game.quitToMenu();
  ctx.globalAlpha = 1;
}
