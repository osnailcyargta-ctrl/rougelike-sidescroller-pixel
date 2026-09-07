// The screens a duel is arranged on: finding the server, finding a lobby,
// sitting in one, picking what you fight with, and the reel that decides
// where. The fight itself has no screen of its own - it is the game, with a
// score over it.

import { clamp, rgba } from './util.js';
import { Theme } from './theme.js';
import { drawText, drawTextShadow, drawTextFit, textWidth } from './font.js';
import { pxRect, glowDot } from './gfx.js';
import { VIEW_W, VIEW_H, PVP } from './config.js';
import { panel, button, textField, inside, UI } from './ui.js';
import { drawItemIcon, ITEMS, RARITY } from './items.js';
import { Sfx } from './audio.js';
import { Input } from './input.js';
import { Net, serverUrl, setServerUrl, serverOpen } from './net.js';
import { Duel } from './pvp.js';
import { drawMenuBackdrop } from './screens.js';

const LOBBY_ROWS = 5;
const ROW_H = 20;

function wrapText(ctx, lines, x, y, color, gap = 9) {
  for (let i = 0; i < lines.length; i++) drawText(ctx, lines[i], x, y + i * gap, color, 1, 'center');
}

/**
 * The server's opening hours, in the server's clock. Drawn wherever a player
 * might be about to try something the door will refuse - and it says the hour
 * even while it is open, so nobody is surprised at nine.
 */
function doorStrip(ctx, y) {
  const d = Net.door;
  if (!d) return;
  const shut = d.open === false;
  const w = 300, x = VIEW_W / 2 - w / 2;
  pxRect(ctx, x, y, w, 13, rgba(shut ? '#2a0f0f' : '#000000', shut ? 0.8 : 0.4));
  pxRect(ctx, x, y, 2, 13, shut ? Theme.hp : rgba(Theme.uiDim, 0.6));
  drawTextFit(ctx, d.message, VIEW_W / 2, y + 3, shut ? Theme.hp : Theme.uiDim, w - 14, 1, 'center');
  const clock = `SERVER CLOCK ${d.now}${d.tz ? ` ${d.tz}` : ''}`;
  drawTextFit(ctx, clock, VIEW_W / 2, y + 15, rgba(Theme.uiDim, 0.75), w, 1, 'center');
}

/**
 * How long until the door next moves, as a line of words rather than a
 * countdown that ticks: the exact second does not matter, and a clock the
 * player cannot act on is just something to stare at.
 */
function untilText(d) {
  if (!d || !d.changesAt) return '';
  const mins = Math.max(0, Math.round((d.changesAt - Date.now()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  const span = h > 0 ? `${h}H ${m}M` : `${m}M`;
  return d.open === false ? `OPENS IN ${span}` : `SHUTS IN ${span}`;
}

// --- finding the server ---------------------------------------------------
// Ten seconds of trying, and then a way out that does not stop the trying.
// Somebody on a slow phone should be able to wait; somebody whose friend never
// started a server should be able to leave.

export function drawPvpConnect(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  drawTextShadow(ctx, 'PVP', VIEW_W / 2, 14, Theme.hp, 2, 'center');

  const pw = 240, px = Math.round((VIEW_W - pw) / 2), py = 46;
  panel(ctx, px, py, pw, 130, { accent: Theme.hp });

  const c = game.pvpConnect;
  const waited = c ? c.t : 0;
  const dots = '.'.repeat(1 + (Math.floor(t * 2.5) % 3));
  const late = waited >= 10;

  glowDot(ctx, VIEW_W / 2, py + 30, 34, Theme.hp, 0.16 + Math.sin(t * 3) * 0.06);
  drawText(ctx, `LOOKING FOR THE SERVER${dots}`, VIEW_W / 2, py + 26, Theme.ui, 1, 'center');
  const bar = 180, bx = VIEW_W / 2 - bar / 2;
  pxRect(ctx, bx, py + 40, bar, 2, rgba(Theme.uiDim, 0.4));
  pxRect(ctx, bx, py + 40, Math.round(bar * clamp(waited / 10, 0, 1)), 2, Theme.hp);
  if (!late) {
    drawText(ctx, serverUrl().toUpperCase(), VIEW_W / 2, py + 50, Theme.uiDim, 1, 'center');
    drawText(ctx, `${Math.max(0, 10 - Math.floor(waited))}S`, VIEW_W / 2, py + 62, Theme.uiDim, 1, 'center');
    wrapText(ctx, ['A DUEL NEEDS A SERVER TO TALK THROUGH.',
                   'RUN  NODE SERVER/PVP.JS  ON ONE MACHINE',
                   'AND POINT BOTH GAMES AT IT.'], 0, py + 78, Theme.uiDim);
    return;
  }

  // Ten seconds in it stops being a wait and becomes a choice - but the
  // attempt underneath goes on either way, so if the server does come up while
  // this is on screen, the game moves on by itself.
  drawText(ctx, Net.error || 'NO ANSWER YET. IT MAY STILL BE COMING UP.',
           VIEW_W / 2, py + 50, Net.error ? Theme.hp : Theme.uiDim, 1, 'center');
  drawText(ctx, 'SERVER', px + 16, py + 68, Theme.uiDim, 1);
  game.pvpServerText = textField(ctx, 'pvpsrv', px + 56, py + 64, pw - 72, 14,
                                 game.pvpServerText ?? '',
                                 { max: 40, placeholder: serverUrl().toUpperCase() });
  drawText(ctx, 'HOST:PORT, OR A FULL WS:// ADDRESS', VIEW_W / 2, py + 84, rgba(Theme.uiDim, 0.8), 1, 'center');
  if (button(ctx, 'pvpback', px + 16, py + 102, 96, 18, 'BACK TO MENU')) game.leavePvp();
  if (button(ctx, 'pvpkeep', px + pw - 112, py + 102, 96, 18, 'KEEP TRYING', { accent: Theme.hp })) {
    const typed = (game.pvpServerText ?? '').trim();
    if (typed) setServerUrl(typed.toLowerCase());
    game.retryPvpConnect();
  }
}

// --- the list of open lobbies --------------------------------------------

export function drawPvpLobbies(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  drawTextShadow(ctx, 'DUELS', VIEW_W / 2, 12, Theme.hp, 2, 'center');
  drawText(ctx, `${Net.lobbies.length} OF ${Net.maxLobbies} LOBBIES OPEN   -   YOU ARE ${Net.you}`,
           VIEW_W / 2, 30, Theme.uiDim, 1, 'center');

  const pw = 300, px = Math.round((VIEW_W - pw) / 2), py = 42;

  // Quiet hours are not an empty lobby list - there is no lobby system at all
  // until the server opens, and nothing on this screen pretends otherwise.
  if (!serverOpen()) {
    const d = Net.door;
    // Two ways to be shut: the hour, or the server having run out of room and
    // taken itself off for half an hour. They read differently because one is
    // a schedule you can plan around and the other is not.
    const resting = !!d?.resting;
    panel(ctx, px, py, pw, 118, { accent: Theme.hp });
    glowDot(ctx, VIEW_W / 2, py + 34, 40, Theme.hp, 0.14 + Math.sin(t * 1.6) * 0.05);
    drawTextShadow(ctx, resting ? 'THE SERVER IS RESTING' : 'THE SERVER IS ASLEEP',
                   VIEW_W / 2, py + 22, Theme.hp, 2, 'center');
    drawText(ctx, resting
      ? `BACK AT ${d?.opensAt ?? '--:--'}`
      : `SHUTS ${d?.closesAt ?? '21:00'}   -   OPENS ${d?.opensAt ?? '04:00'}`,
             VIEW_W / 2, py + 46, Theme.ui, 1, 'center');
    drawTextFit(ctx, resting
      ? (d?.why ?? 'IT PUT ITSELF TO BED')
      : 'ON THE SERVER\'S CLOCK, NOT YOURS',
             VIEW_W / 2, py + 58, Theme.uiDim, pw - 20, 1, 'center');
    const until = untilText(d);
    if (until) drawTextShadow(ctx, until, VIEW_W / 2, py + 74, Theme.uiAccent, 2, 'center');
    drawText(ctx, 'NO LOBBIES CAN BE OPENED OR JOINED UNTIL THEN.',
             VIEW_W / 2, py + 96, Theme.uiDim, 1, 'center');
    doorStrip(ctx, py + 124);
    drawText(ctx, `PING ${Net.ping}MS`, VIEW_W - 8, VIEW_H - 12, Theme.uiDim, 1, 'right');
    if (button(ctx, 'pvpleave', 8, VIEW_H - 24, 74, 16, 'BACK')) game.leavePvp();
    if (button(ctx, 'pvprefresh', 88, VIEW_H - 24, 74, 16, 'CHECK AGAIN')) game.refreshPvpLobbies();
    return;
  }

  panel(ctx, px, py, pw, 150, { accent: Theme.hp });

  const x0 = px + 10, ry0 = py + 14, w = pw - 20;
  const list = Net.lobbies;
  const listH = LOBBY_ROWS * ROW_H;
  const maxOff = Math.max(0, list.length - LOBBY_ROWS);

  // Wheel or finger, exactly like the shader shelf: a press only becomes a
  // scroll once it has moved, so a tap on JOIN is still a tap.
  const onList = inside(x0, ry0, w, listH);
  if (maxOff > 0 && onList && Input.wheel !== 0) {
    UI.lobbyScroll = clamp((UI.lobbyScroll ?? 0) + Math.sign(Input.wheel), 0, maxOff);
    Sfx.ui();
  }
  if (maxOff > 0 && onList && Input.mouseDown.left) {
    UI.lobbyDrag = { y0: Input.mouse.y, off0: UI.lobbyScroll ?? 0, moved: 0 };
  }
  const d = UI.lobbyDrag;
  if (d && Input.mouse.left) {
    const dy = Input.mouse.y - d.y0;
    d.moved = Math.max(d.moved, Math.abs(dy));
    if (d.moved > 3) UI.lobbyScroll = clamp(d.off0 - dy / ROW_H, 0, maxOff);
  }
  const dragging = !!d && d.moved > 3;
  if (d && !Input.mouse.left) UI.lobbyDrag = null;
  const off = clamp(UI.lobbyScroll ?? 0, 0, maxOff);
  UI.lobbyScroll = off;

  if (!list.length) {
    drawText(ctx, 'NOBODY IS WAITING.', VIEW_W / 2, ry0 + 34, Theme.uiDim, 1, 'center');
    drawText(ctx, 'OPEN ONE AND SOMEBODY CAN WALK IN.', VIEW_W / 2, ry0 + 46, Theme.uiDim, 1, 'center');
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, ry0, w, listH);
  ctx.clip();
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    const y = Math.round(ry0 + (i - off) * ROW_H);
    if (y > ry0 + listH || y + ROW_H < ry0) continue;
    pxRect(ctx, x0, y, w, ROW_H - 2, rgba('#000000', i % 2 ? 0.3 : 0.18));
    drawTextFit(ctx, l.name, x0 + 5, y + 3, Theme.ui, w - 130, 1);
    drawText(ctx, `${l.host ?? '?'}${l.guest ? ` VS ${l.guest}` : ''}`,
             x0 + 5, y + 12, Theme.uiDim, 1);
    const full = l.guest || l.started;
    if (button(ctx, `join${l.id}`, x0 + w - 58, y + 2, 54, 14,
               full ? 'FULL' : 'JOIN',
               { disabled: !!full || dragging, release: true, suppress: dragging, accent: Theme.hp })) {
      game.joinPvpLobby(l.id);
    }
  }
  ctx.restore();

  if (maxOff > 0) {
    const trackH = listH;
    const kh = Math.max(8, Math.round(trackH * (LOBBY_ROWS / list.length)));
    const ky = ry0 + Math.round((trackH - kh) * (off / maxOff));
    pxRect(ctx, x0 + w + 2, ry0, 2, trackH, rgba(Theme.uiDim, 0.3));
    pxRect(ctx, x0 + w + 2, ky, 2, kh, rgba(Theme.hp, 0.8));
  }

  // opening one of your own
  const fy = py + 122;
  drawText(ctx, 'NAME', x0, fy + 4, Theme.uiDim, 1);
  game.pvpLobbyName = textField(ctx, 'pvpname', x0 + 30, fy, 140, 14, game.pvpLobbyName ?? '',
                                { max: 18, placeholder: `${Net.you}'S LOBBY` });
  const cool = Math.max(0, Math.ceil((game.pvpCooldownUntil - performance.now()) / 1000));
  if (button(ctx, 'pvpcreate', x0 + w - 92, fy, 92, 14,
             cool > 0 ? `WAIT ${cool}S` : 'OPEN A LOBBY',
             { disabled: cool > 0, accent: Theme.hp })) {
    game.createPvpLobby();
  }

  if (Net.error) drawText(ctx, Net.error, VIEW_W / 2, VIEW_H - 46, Theme.hp, 1, 'center');
  else doorStrip(ctx, VIEW_H - 52);
  drawText(ctx, `PING ${Net.ping}MS`, VIEW_W - 8, VIEW_H - 12, Theme.uiDim, 1, 'right');
  if (button(ctx, 'pvpleave', 8, VIEW_H - 24, 74, 16, 'BACK')) game.leavePvp();
  if (button(ctx, 'pvprefresh', 88, VIEW_H - 24, 74, 16, 'REFRESH')) game.refreshPvpLobbies();
}

// --- sitting in one -------------------------------------------------------

export function drawPvpRoom(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  const l = Net.lobby;
  if (!l) { game.screen = 'pvpLobbies'; return; }
  const mine = l.host === Net.you;

  drawTextShadow(ctx, l.name, VIEW_W / 2, 14, Theme.hp, 2, 'center');
  drawText(ctx, mine ? 'YOUR LOBBY' : `${l.host}'S LOBBY`, VIEW_W / 2, 32, Theme.uiDim, 1, 'center');

  const cw = 128, gap = 22;
  const totalW = cw * 2 + gap;
  const seats = [
    { name: l.host, label: 'HOST', side: 'LEFT CORNER' },
    { name: l.guest, label: 'CHALLENGER', side: 'RIGHT CORNER' },
  ];
  for (let i = 0; i < 2; i++) {
    const s = seats[i];
    const x = Math.round((VIEW_W - totalW) / 2) + i * (cw + gap);
    const y = 48;
    const here = !!s.name;
    panel(ctx, x, y, cw, 84, { accent: here ? Theme.hp : Theme.uiDim, alpha: here ? 0.9 : 0.6 });
    drawText(ctx, s.label, x + cw / 2, y + 8, here ? Theme.hp : Theme.uiDim, 1, 'center');
    if (here) glowDot(ctx, x + cw / 2, y + 34, 26, Theme.hp, 0.16);
    drawTextFit(ctx, here ? s.name : 'WAITING...', x + cw / 2, y + 28,
                here ? Theme.ui : Theme.uiDim, cw - 12, 2, 'center');
    drawText(ctx, s.side, x + cw / 2, y + 50, Theme.uiDim, 1, 'center');
    if (s.name === Net.you) drawText(ctx, 'THIS IS YOU', x + cw / 2, y + 62, Theme.uiAccent, 1, 'center');
    // Only the owner may throw somebody out, and only for two seconds - long
    // enough to stop a rejoin race, short enough not to be a punishment.
    if (i === 1 && mine && here && button(ctx, 'pvpkick', x + 20, y + 62, cw - 40, 16, 'KICK')) {
      game.kickPvpGuest();
    }
  }

  const left = l.startsAt ? Math.max(0, (l.startsAt - Date.now()) / 1000) : 0;
  if (l.host && l.guest) {
    const n = Math.ceil(left);
    drawTextShadow(ctx, n > 0 ? String(n) : 'GO', VIEW_W / 2, 146, Theme.hp, 3, 'center');
    drawText(ctx, 'BOTH IN. THE DUEL STARTS ON ITS OWN.', VIEW_W / 2, 178, Theme.uiDim, 1, 'center');
  } else {
    drawText(ctx, 'SEND SOMEBODY THE SERVER ADDRESS AND WAIT.',
             VIEW_W / 2, 152, Theme.uiDim, 1, 'center');
    drawText(ctx, serverUrl().toUpperCase(), VIEW_W / 2, 164, Theme.ui, 1, 'center');
  }

  if (Net.error) drawText(ctx, Net.error, VIEW_W / 2, VIEW_H - 38, Theme.hp, 1, 'center');
  if (button(ctx, 'pvproomback', 8, VIEW_H - 24, 90, 16, mine ? 'CLOSE LOBBY' : 'LEAVE')) {
    game.leavePvpLobby();
  }
}

// --- what you fight with --------------------------------------------------
// One weapon and one perk, on one thirty-second clock. Run it out and the
// game picks for you, because the other player is waiting.

export function drawPvpPick(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  const pick = game.pvpPick;
  if (!pick) { game.screen = 'pvpLobbies'; return; }

  const left = Math.max(0, Duel.pickLeft);
  drawTextShadow(ctx, pick.stage === 'weapon' ? 'TAKE ONE' : 'ONE PERK',
                 VIEW_W / 2, 10, Theme.hp, 2, 'center');
  drawText(ctx, `AGAINST ${Duel.oppName}`, VIEW_W / 2, 26, Theme.uiDim, 1, 'center');

  // the clock, as a bar that empties
  const bw = 240, bx = VIEW_W / 2 - bw / 2;
  pxRect(ctx, bx, 36, bw, 3, rgba(Theme.uiDim, 0.35));
  const k = clamp(left / PVP.pickSeconds, 0, 1);
  pxRect(ctx, bx, 36, Math.round(bw * k), 3, left <= 5 ? Theme.hp : Theme.uiAccent);
  drawText(ctx, `${Math.ceil(left)}S`, VIEW_W / 2, 42, left <= 5 ? Theme.hp : Theme.uiDim, 1, 'center');

  if (Duel.ready) {
    panel(ctx, VIEW_W / 2 - 100, 70, 200, 90, { accent: Theme.hp });
    drawText(ctx, 'LOCKED IN', VIEW_W / 2, 82, Theme.hp, 1, 'center');
    const wdef = ITEMS[game.pvpWeapon];
    const pdef = ITEMS[game.pvpPerk];
    drawText(ctx, wdef ? wdef.name : '-', VIEW_W / 2, 100, Theme.ui, 1, 'center');
    drawText(ctx, pdef ? pdef.name : '-', VIEW_W / 2, 112, Theme.ui, 1, 'center');
    drawText(ctx, Duel.foeReady ? 'THEY ARE READY TOO' : `WAITING FOR ${Duel.oppName}...`,
             VIEW_W / 2, 134, Duel.foeReady ? Theme.uiAccent : Theme.uiDim, 1, 'center');
    drawLoadoutNote(ctx, VIEW_H - 44);
    return;
  }

  if (pick.stage === 'weapon') drawWeaponRow(ctx, game, pick, t);
  else drawPerkReel(ctx, game, pick, t);
  drawLoadoutNote(ctx, VIEW_H - 26);
}

function drawLoadoutNote(ctx, y) {
  const names = PVP.loadout.map((l) => `${l.count}x ${(ITEMS[l.id]?.name ?? l.id).toUpperCase()}`);
  drawText(ctx, `BOTH OF YOU ALSO CARRY  ${names.join('   ')}`,
           VIEW_W / 2, y, rgba(Theme.uiDim, 0.9), 1, 'center');
}

// Break a line on spaces so it never runs past the card it is written on.
function wrapLine(text, maxW, scale = 1) {
  const words = String(text).split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, scale) <= maxW || !line) line = next;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

function drawWeaponRow(ctx, game, pick, t) {
  const n = pick.offer.length;
  const cw = Math.min(150, Math.floor((VIEW_W - 40) / n) - 10), ch = 138, gap = 14;
  const totalW = n * cw + (n - 1) * gap;
  for (let i = 0; i < n; i++) {
    const id = pick.offer[i];
    const def = ITEMS[id];
    if (!def) continue;
    const x = Math.round((VIEW_W - totalW) / 2) + i * (cw + gap);
    const y = 54;
    const col = RARITY[def.rarity].color;
    const hot = UI.hovered === 'pvpw' + id;
    panel(ctx, x, y, cw, ch, { accent: col, alpha: hot ? 0.95 : 0.8 });
    glowDot(ctx, x + cw / 2, y + 28, 24, col, hot ? 0.35 : 0.18);
    ctx.save();
    ctx.translate(x + cw / 2, y + 28);
    const sc = 2.4 + (hot ? 0.3 : 0);
    ctx.scale(sc, sc);
    drawItemIcon(ctx, id, -6, -6, 12, t);
    ctx.restore();
    drawTextFit(ctx, def.name, x + cw / 2, y + 50, col, cw - 10, 1, 'center');
    const wrapped = [];
    for (const line of def.desc) for (const part of wrapLine(line, cw - 12)) wrapped.push(part);
    for (let l = 0; l < Math.min(wrapped.length, 7); l++) {
      drawText(ctx, wrapped[l], x + cw / 2, y + 62 + l * 9, Theme.ui, 1, 'center');
    }
    if (button(ctx, 'pvpw' + id, x + 10, y + ch - 20, cw - 20, 16, 'TAKE IT', { accent: col })) {
      game.takePvpWeapon(id);
    }
  }
}

function drawPerkReel(ctx, game, pick, t) {
  const sl = pick.slot;
  if (!sl) return;
  const w = 200, h = 92, x = VIEW_W / 2 - w / 2, y = 56;
  panel(ctx, x, y, w, h, { accent: Theme.uiAccent });
  const winW = 44, winH = 44, winX = VIEW_W / 2 - winW / 2, winY = y + 12;
  pxRect(ctx, winX, winY, winW, winH, rgba('#05060c', 0.85));

  ctx.save();
  ctx.beginPath();
  ctx.rect(winX, winY, winW, winH);
  ctx.clip();
  const cell = winH;
  const base = sl.reel % sl.pool.length;
  for (let i = -1; i <= 1; i++) {
    const idx = ((Math.floor(base) + i) % sl.pool.length + sl.pool.length) % sl.pool.length;
    const id = sl.pool[idx];
    const oy = winY + winH / 2 - cell / 2 + (i - (base - Math.floor(base))) * cell;
    const def = ITEMS[id];
    if (!def) continue;
    ctx.save();
    ctx.translate(winX + winW / 2, oy + cell / 2);
    ctx.scale(2.4, 2.4);
    drawItemIcon(ctx, id, -6, -6, 12, t);
    ctx.restore();
  }
  ctx.restore();
  pxRect(ctx, winX - 3, winY + winH / 2, 3, 1, Theme.uiAccent);
  pxRect(ctx, winX + winW, winY + winH / 2, 3, 1, Theme.uiAccent);

  const landed = sl.landed ? ITEMS[sl.landed] : null;
  drawTextFit(ctx, landed ? landed.name : 'SPINNING...', VIEW_W / 2, y + h - 22,
              landed ? RARITY[landed.rarity].color : Theme.uiDim, w - 16, 1, 'center');

  const by = y + h + 8;
  if (button(ctx, 'pvpspin', VIEW_W / 2 - 98, by, 92, 18,
             sl.rerolls > 0 ? `SPIN AGAIN (${sl.rerolls})` : 'NO SPINS LEFT',
             { disabled: sl.rerolls <= 0 || sl.spin > 0 })) {
    game.spinPvpSlot();
  }
  if (button(ctx, 'pvptake', VIEW_W / 2 + 6, by, 92, 18, 'TAKE IT',
             { disabled: !sl.landed, accent: Theme.hp })) {
    game.takePvpPerk();
  }
}

// --- the map reel ---------------------------------------------------------
// The server rolled it before either of you saw this screen, so the reel is
// theatre - but it is honest theatre: it stops on what was already chosen, and
// there is nothing on this screen that could have changed it.

export function drawPvpMap(ctx, game, t) {
  drawMenuBackdrop(ctx, t);
  drawTextShadow(ctx, 'WHERE', VIEW_W / 2, 16, Theme.uiAccent, 2, 'center');
  drawText(ctx, 'NEITHER OF YOU PICKS THIS ONE', VIEW_W / 2, 34, Theme.uiDim, 1, 'center');

  const w = 260, h = 96, x = VIEW_W / 2 - w / 2, y = 56;
  panel(ctx, x, y, w, h, { accent: Theme.uiAccent });

  const done = Duel.reelDone;
  const spin = clamp(Duel.reelT / 2.4, 0, 1);
  const ease = 1 - Math.pow(1 - spin, 5);
  const total = PVP.maps.length;
  const target = Math.max(0, PVP.maps.findIndex((m) => m.room === Duel.map?.room));
  const pos = ease * (total * 4 + target);
  const cell = 26;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 8, y + 14, w - 16, cell * 2);
  ctx.clip();
  for (let i = -1; i <= 2; i++) {
    const idx = ((Math.floor(pos) + i) % total + total) % total;
    const m = PVP.maps[idx];
    const oy = y + 14 + cell / 2 + (i - (pos - Math.floor(pos))) * cell;
    const on = done && m.room === Duel.map.room;
    drawTextFit(ctx, m.name, VIEW_W / 2, oy, on ? Theme.uiAccent : Theme.ui, w - 30, on ? 2 : 1, 'center');
  }
  ctx.restore();
  pxRect(ctx, x + 4, y + 14 + cell, 4, 1, Theme.uiAccent);
  pxRect(ctx, x + w - 8, y + 14 + cell, 4, 1, Theme.uiAccent);

  if (done && Duel.map) {
    drawText(ctx, Duel.map.sub, VIEW_W / 2, y + h - 26, Theme.uiDim, 1, 'center');
    drawText(ctx, 'FIRST TO THREE ROUNDS TAKES IT', VIEW_W / 2, y + h - 14, Theme.ui, 1, 'center');
  }
}

// --- over it --------------------------------------------------------------

export function drawPvpOver(ctx, game, t) {
  ctx.fillStyle = rgba('#000000', 0.68);
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const win = Duel.result === 'win';
  const col = win ? Theme.uiAccent : Duel.result === 'draw' ? Theme.ui : Theme.hp;
  drawTextShadow(ctx, win ? 'YOU WIN' : Duel.result === 'draw' ? 'A DRAW' : 'YOU LOSE',
                 VIEW_W / 2, 42, col, 3, 'center');

  const pw = 220, px = Math.round((VIEW_W - pw) / 2), py = 80;
  panel(ctx, px, py, pw, 76, { accent: col });
  drawText(ctx, Net.you, px + 40, py + 16, Theme.ui, 1, 'center');
  drawText(ctx, Duel.oppName, px + pw - 40, py + 16, Theme.ui, 1, 'center');
  drawTextShadow(ctx, String(Duel.myScore), px + 40, py + 30, col, 3, 'center');
  drawTextShadow(ctx, String(Duel.foeScore), px + pw - 40, py + 30, Theme.uiDim, 3, 'center');
  drawText(ctx, '-', VIEW_W / 2, py + 38, Theme.uiDim, 2, 'center');
  drawText(ctx, `${Duel.round} ROUNDS FOUGHT`, VIEW_W / 2, py + 60, Theme.uiDim, 1, 'center');

  const cool = Math.max(0, Math.ceil((game.pvpCooldownUntil - performance.now()) / 1000));
  if (button(ctx, 'pvpagain', VIEW_W / 2 - 104, 170, 100, 18,
             cool > 0 ? `WAIT ${cool}S` : 'ANOTHER', { disabled: cool > 0, accent: Theme.hp })) {
    game.backToPvpLobbies();
  }
  if (button(ctx, 'pvpdone', VIEW_W / 2 + 4, 170, 100, 18, 'MAIN MENU')) game.leavePvp();
}

// --- over the fight -------------------------------------------------------

export function drawDuelHud(ctx, game, t) {
  if (!Duel.active || !Duel.map) return;

  // the score, dead centre and small, so it never sits on top of the fight
  const cx = VIEW_W / 2;
  const pips = (n, x, dir) => {
    for (let i = 0; i < PVP.winsNeeded; i++) {
      const on = i < n;
      pxRect(ctx, x + dir * (i * 7), 7, 5, 5, on ? Theme.hp : rgba(Theme.uiDim, 0.35));
    }
  };
  pxRect(ctx, cx - 34, 4, 68, 12, rgba('#000000', 0.45));
  pips(Duel.myScore, cx - 30, 1);
  pips(Duel.foeScore, cx + 26, -1);
  drawText(ctx, `R${Duel.round}`, cx, 6, Theme.ui, 1, 'center');
  drawText(ctx, Duel.oppName, cx + 40, 6, Theme.uiDim, 1);

  if (Duel.phase === 'countdown') {
    const n = Math.ceil(Duel.timer);
    const k = 1 - (Duel.timer - Math.floor(Duel.timer));
    ctx.save();
    ctx.globalAlpha = 0.9;
    drawTextShadow(ctx, n > 0 ? String(n) : 'GO', VIEW_W / 2, VIEW_H / 2 - 24,
                   n > 0 ? Theme.ui : Theme.hp, 3 + Math.round((1 - k) * 2), 'center');
    ctx.restore();
  }
  if (Duel.bannerT > 0 && Duel.banner) {
    const a = clamp(Duel.bannerT * 2, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    drawTextShadow(ctx, Duel.banner, VIEW_W / 2, 40, Theme.hp, 2, 'center');
    ctx.restore();
  }
  drawText(ctx, `${Net.ping}MS`, VIEW_W - 6, VIEW_H - 8, rgba(Theme.uiDim, 0.7), 1, 'right');
}
