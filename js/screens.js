// Front-end screens: main menu, settings (shader packs), class select,
// pause, and the death screen.
import { clamp, rand, rgba, TAU } from './util.js';
import { Theme } from './theme.js';
import { drawText, drawTextShadow, textWidth } from './font.js';
import { pxRect, glowDot, spawnParticle } from './gfx.js';
import { VIEW_W, VIEW_H } from './config.js';
import { panel, button, slider, UI } from './ui.js';
import { drawItemIcon } from './items.js';
import { AudioCfg, setVolume, Sfx } from './audio.js';

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
  panel(ctx, 40, 18, VIEW_W - 80, VIEW_H - 52);
  drawTextShadow(ctx, 'CONTROLS', VIEW_W / 2, 26, Theme.uiAccent, 2, 'center');
  const rows = [
    ['A / D', 'MOVE LEFT / RIGHT'],
    ['DOUBLE A / D', 'DASH (I-FRAMES)'],
    ['SHIFT', 'DASH (ONE-KEY VERSION)'],
    ['W', 'JUMP'],
    ['S', 'DROP THROUGH PLATFORM'],
    ['DOUBLE S (AIR)', 'GROUND SLAM'],
    ['LEFT CLICK', 'ATTACK TOWARD CURSOR'],
    ['RIGHT CLICK', 'INTERACT AT CURSOR'],
    ['SCROLL / 1-4', 'CHANGE HOTBAR SLOT'],
    ['E', 'INVENTORY'],
    ['R', 'RELOAD BOW'],
    ['ESC', 'PAUSE'],
  ];
  let y = 52;
  for (const [k, v] of rows) {
    drawText(ctx, k, 56, y, Theme.uiAccent, 1);
    drawText(ctx, v, 168, y, Theme.ui, 1);
    y += 12;
  }
  if (button(ctx, 'back', (VIEW_W - 90) / 2, 202, 90, 18, 'BACK')) game.screen = 'menu';
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

  if (button(ctx, 'back', 40, 200, 90, 18, 'BACK')) {
    game.screen = game.returnScreen || 'menu';
    game.returnScreen = null;
  }
}

export function drawClassSelect(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  drawTextShadow(ctx, 'CHOOSE YOUR PATH', VIEW_W / 2, 24, Theme.uiAccent, 2, 'center');

  const cards = [
    {
      id: 'melee', name: 'BLADE', item: 'sword', color: Theme.hp,
      lines: ['IRON SWORD'],
    },
    {
      id: 'ranger', name: 'RANGER', item: 'bow', color: Theme.platformGlow,
      lines: ['HUNTER BOW'],
    },
  ];
  const cw = 168, ch = 130;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const x = VIEW_W / 2 - cw - 8 + i * (cw + 16);
    const y = 46;
    const hot = UI.hovered === 'class' + c.id;
    panel(ctx, x, y, cw, ch, { accent: c.color, alpha: hot ? 0.95 : 0.8 });
    glowDot(ctx, x + cw / 2, y + 44, 34, c.color, hot ? 0.35 : 0.18);
    ctx.save();
    ctx.translate(x + cw / 2, y + 44);
    const sc = 3 + (hot ? 0.4 : 0) + Math.sin(t * 3 + i) * 0.1;
    ctx.scale(sc, sc);
    drawItemIcon(ctx, c.item, -6, -6, 12, t);
    ctx.restore();
    drawTextShadow(ctx, c.name, x + cw / 2, y + 74, c.color, 2, 'center');
    for (let k = 0; k < c.lines.length; k++) {
      drawText(ctx, c.lines[k], x + cw / 2, y + 94 + k * 10, Theme.ui, 1, 'center');
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
  ctx.fillStyle = rgba('#000000', clamp(game.deathT * 0.5, 0, 0.72));
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (game.deathT < 0.6) return;
  drawTextShadow(ctx, 'YOU DIED', VIEW_W / 2, 62, Theme.hp, 3, 'center');
  drawTextShadow(ctx, `ROOM ${game.roomIndex}`, VIEW_W / 2, 96, Theme.ui, 1, 'center');
  drawTextShadow(ctx, `KILLS ${game.kills}`, VIEW_W / 2, 108, Theme.ui, 1, 'center');
  const bw = 120, x = VIEW_W / 2 - bw / 2;
  if (button(ctx, 'retry', x, 132, bw, 18, 'RETRY')) game.goClassSelect();
  if (button(ctx, 'gmenu', x, 156, bw, 18, 'MAIN MENU')) game.quitToMenu();
}
