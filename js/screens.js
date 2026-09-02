// Front-end screens: main menu, settings (shader packs), class select,
// pause, and the death screen.
import { clamp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { drawText, drawTextShadow, textWidth } from './font.js';
import { pxRect, glowDot, spawnParticle } from './gfx.js';
import { VIEW_W, VIEW_H, FINAL_ROOM } from './config.js';
import { panel, button, slider, textField, drawTooltip, UI } from './ui.js';
import { drawItemIcon, ITEMS, RARITY } from './items.js';
import { AudioCfg, setVolume, Sfx } from './audio.js';
import { randomSeedText } from './util.js';
import { Input, Binds, BIND_ORDER, BIND_LABELS, bindLabel, setBind, resetBinds } from './input.js';

function titleGlyphs(ctx, t) {
  const title = 'AETHER';
  const sub = 'DESCENT';
  const s = 4;
  const w = textWidth(title, s);
  for (let i = 0; i < title.length; i++) {
    const ox = (VIEW_W - w) / 2 + i * (6 * s);
    const oy = 34 + Math.sin(t * 2 + i * 0.5) * 2;
    drawText(ctx, title[i], ox + 2, oy + 2, rgba('#000000', 0.6), s);
    drawText(ctx, title[i], ox, oy, i % 2 ? Theme.uiAccent : Theme.ui, s);
  }
  drawTextShadow(ctx, sub, VIEW_W / 2, 34 + 7 * s + 6, Theme.platformGlow, 2, 'center');
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
  if (button(ctx, 'settings', x, y, bw, bh, 'SETTINGS')) game.screen = 'settings';
  y += bh + 6;
  if (button(ctx, 'controls', x, y, bw, bh, 'CONTROLS')) game.screen = 'controls';
  drawTextShadow(ctx, 'A ROGUELIKE SIDESCROLLER', VIEW_W / 2, VIEW_H - 16, Theme.uiDim, 1, 'center');
  if (game.shaderName) {
    drawTextShadow(ctx, `SHADER: ${game.shaderName}`, 6, VIEW_H - 12, Theme.platformGlow, 1);
  }
}

export function drawControls(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  panel(ctx, 26, 10, VIEW_W - 52, VIEW_H - 34);
  drawTextShadow(ctx, 'CONTROLS', VIEW_W / 2, 16, Theme.uiAccent, 2, 'center');
  drawText(ctx, 'CLICK A KEY TO REBIND IT', VIEW_W / 2, 32, Theme.uiDim, 1, 'center');

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

  let y = 46;
  for (const action of BIND_ORDER) {
    const waiting = UI.rebinding === action;
    drawText(ctx, BIND_LABELS[action], 44, y + 4, Theme.ui, 1);
    const label = waiting ? 'PRESS A KEY' : bindLabel(Binds[action]);
    if (button(ctx, 'bind-' + action, 190, y, waiting ? 92 : 52, 14, label, { selected: waiting })) {
      UI.rebinding = waiting ? null : action;
    }
    y += 18;
  }

  // the things that are not rebindable, for reference
  const fixed = [
    ['DOUBLE TAP MOVE', 'DASH'],
    ['DOUBLE TAP DROP', 'GROUND SLAM'],
    ['LEFT / RIGHT CLICK', 'ATTACK / INTERACT'],
    ['SCROLL, 1-4', 'HOTBAR'],
    ['ESC', 'PAUSE'],
  ];
  const fx = 292;
  drawText(ctx, 'FIXED', fx, 46, Theme.uiDim, 1);
  let fy = 60;
  for (const [k, v] of fixed) {
    drawText(ctx, k, fx, fy, Theme.uiAccent, 1);
    drawText(ctx, v, fx, fy + 9, Theme.uiDim, 1);
    fy += 22;
  }

  if (button(ctx, 'binddef', 44, y + 4, 96, 16, 'RESET DEFAULTS')) {
    resetBinds();
    UI.rebinding = null;
  }
  if (button(ctx, 'back', VIEW_W - 152, y + 4, 90, 16, 'BACK')) {
    UI.rebinding = null;
    game.screen = game.controlsReturn || 'menu';
    game.controlsReturn = null;
  }
}

export function drawSettings(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  panel(ctx, 28, 14, VIEW_W - 56, VIEW_H - 44);
  drawTextShadow(ctx, 'SETTINGS', VIEW_W / 2, 22, Theme.uiAccent, 2, 'center');

  // --- shader pack
  drawText(ctx, 'SHADER PACK (.SHDR)', 40, 44, Theme.platformGlow, 1);
  drawText(ctx, 'REPLACES THE POST PIPELINE AND', 40, 56, Theme.uiDim, 1);
  drawText(ctx, 'CAN RETHEME EVERY SPRITE COLOR.', 40, 66, Theme.uiDim, 1);

  if (button(ctx, 'load', 40, 78, 96, 18, 'LOAD .SHDR')) game.requestShaderUpload();
  if (button(ctx, 'reset', 142, 78, 80, 18, 'RESET', { disabled: !game.shaderName })) game.resetShader();

  const status = game.shaderError ? game.shaderError.slice(0, 34)
    : game.shaderName ? `ACTIVE: ${game.shaderName}` : 'USING BUILT-IN SHADER';
  drawText(ctx, status, 40, 102, game.shaderError ? Theme.hp : Theme.ui, 1);
  if (!game.postfx.ok) drawText(ctx, 'WEBGL OFF - EFFECTS DISABLED', 40, 112, Theme.hp, 1);

  // --- sliders
  drawText(ctx, 'BLOOM', 40, 128, Theme.ui, 1);
  const nb = slider(ctx, 'bloom', 120, 127, 90, clamp(Theme.bloomStrength / 2, 0, 1));
  Theme.bloomStrength = nb * 2;
  drawText(ctx, Math.round(Theme.bloomStrength * 50) + '%', 218, 128, Theme.uiDim, 1);

  drawText(ctx, 'SCANLINE', 40, 144, Theme.ui, 1);
  Theme.scanline = slider(ctx, 'scan', 120, 143, 90, Theme.scanline);
  drawText(ctx, Math.round(Theme.scanline * 100) + '%', 218, 144, Theme.uiDim, 1);

  drawText(ctx, 'VOLUME', 40, 160, Theme.ui, 1);
  const nv = slider(ctx, 'vol', 120, 159, 90, AudioCfg.volume);
  if (nv !== AudioCfg.volume) setVolume(nv);
  drawText(ctx, Math.round(AudioCfg.volume * 100) + '%', 218, 160, Theme.uiDim, 1);

  if (button(ctx, 'shake', 40, 174, 100, 16, game.screenShake ? 'SHAKE: ON' : 'SHAKE: OFF')) {
    game.screenShake = !game.screenShake;
  }
  if (button(ctx, 'sample', 146, 174, 116, 16, 'DOWNLOAD SAMPLE')) game.downloadSampleShader();
  if (button(ctx, 'skeys', 40, 194, 100, 16, 'KEY BINDINGS')) {
    game.controlsReturn = 'settings';
    game.screen = 'controls';
  }

  // --- format help
  panel(ctx, 274, 40, VIEW_W - 274 - 34, 150, { alpha: 0.5 });
  const help = [
    'SHDR FORMAT',
    '',
    '/*@THEME',
    '{ "NAME":"NEON",',
    '  "PLAYER":"#FF00AA",',
    '  "BLOOMSTRENGTH":1.6 }',
    '@*/',
    'PRECISION MEDIUMP FLOAT;',
    'VARYING VEC2 VUV;',
    'UNIFORM SAMPLER2D USCENE;',
    'UNIFORM SAMPLER2D UBLOOM;',
    'UNIFORM FLOAT UTIME;',
    'VOID MAIN() { ... }',
  ];
  for (let i = 0; i < help.length; i++) {
    drawText(ctx, help[i], 280, 46 + i * 10, i === 0 ? Theme.uiAccent : Theme.uiDim, 1);
  }

  if (button(ctx, 'back', 146, 194, 90, 16, 'BACK')) {
    game.screen = game.returnScreen || 'menu';
    game.returnScreen = null;
  }
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
      lines: ['IRON SWORD', '3 BLOCK REACH  -  10 DMG', '0.45S SWING'],
    },
    {
      id: 'ranger', name: 'RANGER', item: 'bow', color: Theme.platformGlow,
      lines: ['HUNTER BOW', '10 BLOCK RANGE  -  5 DMG', '10 AMMO  -  2S RELOAD'],
    },
  ];
  const cw = 168, ch = 126;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const x = VIEW_W / 2 - cw - 8 + i * (cw + 16);
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
    drawTextShadow(ctx, c.name, x + cw / 2, y + 70, c.color, 2, 'center');
    for (let k = 0; k < c.lines.length; k++) {
      drawText(ctx, c.lines[k], x + cw / 2, y + 90 + k * 10, Theme.ui, 1, 'center');
    }
    if (button(ctx, 'class' + c.id, x + 24, y + ch + 6, cw - 48, 18, 'SELECT')) {
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
      ['CLASS', st.classId === 'melee' ? 'MELEE' : 'RANGER'],
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
      ['CLASS', st.classId === 'melee' ? 'MELEE' : 'RANGER'],
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
