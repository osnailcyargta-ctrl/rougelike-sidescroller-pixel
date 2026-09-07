// A duel: two people, one room, five rounds.
//
// How the two ends stay in step, in one paragraph, because everything else
// here follows from it: each player simulates itself and nobody else. Twice
// per frame-ish a snapshot of where you are goes down the wire, and the other
// end draws you from it. Damage is decided by whoever swung - their screen saw
// the hit, so their screen is right about it - and sent to the victim, who
// applies it to their own bar. Nothing is predicted, nothing is rolled back,
// and neither side can be hit by a version of the other that only it can see.
//
// Nothing in a duel is seeded. The map comes off the server's own random, the
// perk reel off Math.random, and neither reads the run seed - so there is no
// string anybody can type that tells them what is coming.

import { clamp, lerp, rand, sign, rgba } from './util.js';
import { Theme } from './theme.js';
import { Camera, burst, floatText, impactRing, glowDot, pxRect } from './gfx.js';
import { Sfx } from './audio.js';
import {
  VIEW_W, GROUND_Y, PVP, PLAYER, SWORD,
} from './config.js';
import { Enemy, Player, Projectile, closeRightWall } from './entities.js';
import { layoutRoom } from './chapters.js';
import { Net, sendMatch, matchOver } from './net.js';
import { ITEMS, DROP_POOL, UNIQUE_ONCE } from './items.js';

// --- the duel's own state -------------------------------------------------

export const Duel = {
  active: false,
  role: null,            // 'host' | 'guest'
  map: null,             // { room, name, sub }
  oppName: 'PLAYER',
  round: 0,
  myScore: 0,
  foeScore: 0,
  phase: 'idle',         // countdown | fight | dead | over
  timer: 0,
  foe: null,             // the Duelist standing in for the other player
  ghosts: [],            // their shots, drawn but never dangerous here
  sendT: 0,
  ready: false,          // you have locked a weapon and a perk
  foeReady: null,        // what they locked, once they have
  pickLeft: 0,
  result: null,          // 'win' | 'lose' | 'draw'
  banner: '',
  bannerT: 0,
  reelT: 0,              // the map reel, before the first round
  reelDone: false,
};

export function duelIsOn(game) { return game.mode === 'pvp' && Duel.active; }

/** Left corner or right corner: the host takes the left. */
function mySpawn() { return Duel.role === 'host' ? PVP.spawnX[0] : PVP.spawnX[1]; }
function foeSpawn() { return Duel.role === 'host' ? PVP.spawnX[1] : PVP.spawnX[0]; }

// --- the other player, wearing an enemy's clothes -------------------------
// Every weapon in this game already knows how to find an Enemy. Rather than
// teach all of them about a second kind of target, the opponent simply is one
// - with the AI taken out and the body replaced by a Player, so it moves like
// a person and not like a ghoul.

export class Duelist extends Enemy {
  constructor(game, classId) {
    super('duelist', foeSpawn(), GROUND_Y, game);
    this.avatar = new Player(game, classId);
    this.avatar.controls = false;
    this.avatar.x = this.x;
    this.avatar.y = this.y;
    this.avatar.resetChains();
    this.spawnT = 0;              // it does not materialise; it is already here
    this.maxHp = this.avatar.maxHp;
    this.hp = this.maxHp;
    // where the wire says they are, and where we are drawing them, so a
    // 30Hz feed does not read as 30fps
    this.net = { x: this.x, y: this.y, vx: 0, vy: 0, facing: -1 };
    this.lastAt = 0;
  }

  /**
   * Damage never lands here. Their bar is theirs to keep - all this does is
   * tell them what we hit them for and let their end apply it. What the
   * screen shows in the meantime (the flash, the number, the sparks) has
   * already happened in Enemy.damage above this.
   */
  applyRawDamage(amount) {
    const dmg = Math.max(1, Math.round(amount));
    sendMatch({ k: 'hit', d: dmg, fx: this.game.player ? this.game.player.x : this.x });
  }

  /** Only the other end may say they are down. */
  kill() { /* their death arrives over the wire, not from here */ }

  /** What the wire just said about them. */
  applySnapshot(s) {
    this.net.x = s.x; this.net.y = s.y;
    this.net.vx = s.vx ?? 0; this.net.vy = s.vy ?? 0;
    this.net.facing = s.f ?? this.net.facing;
    this.hp = s.hp ?? this.hp;
    this.maxHp = s.mx ?? this.maxHp;
    this.avatar.hp = this.hp;
    this.avatar.maxHp = this.maxHp;
    this.avatar.shield = s.sh ?? 0;
    this.avatar.dashT = s.dt ?? 0;
    this.avatar.onGround = !!s.og;
    this.avatar.invuln = s.iv ?? 0;
    this.avatar.dead = !!s.d;
    this.dead = false;            // the enemy list must not sweep them away
    if (s.sw) this.avatar.swing = { kind: s.sw.k, angle: s.sw.a, t: s.sw.t, range: s.sw.r, arc: s.sw.c, dir: s.sw.dr };
    else if (!s.sw && this.avatar.swing && this.avatar.swing.t > SWORD.swingTime * 1.6) this.avatar.swing = null;
    this.lastAt = performance.now();
    syncGhosts(s.g ?? []);
  }

  update(dt) {
    this.anim += dt * Theme.animSpeed;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.guardFlash = Math.max(0, this.guardFlash - dt * 4);
    // burns and poison keep ticking, and every tick goes down the wire the
    // same way a sword hit does
    this.updateStatus(dt);

    // Slide toward where they said they were rather than snapping to it: the
    // feed is 30 a second and the screen is not.
    const k = 1 - Math.pow(0.0001, dt);
    // dead reckoning, so a body in the air keeps moving between packets
    const age = clamp((performance.now() - this.lastAt) / 1000, 0, 0.25);
    const px = this.net.x + this.net.vx * age;
    const py = this.net.y + this.net.vy * age;
    this.x = lerp(this.x, px, k);
    this.y = lerp(this.y, py, k);
    // A long silence means their tab is gone; leaving them where they stood
    // beats sliding them into a wall.
    const a = this.avatar;
    a.x = this.x; a.y = this.y;
    a.vx = this.net.vx; a.vy = this.net.vy;
    a.facing = this.net.facing;
    a.anim += dt * Theme.animSpeed;
    if (a.swing) {
      a.swing.t += dt;
      if (a.swing.t > SWORD.swingTime * 1.6) a.swing = null;
    }
    a.updateSecondaryMotion(dt);
  }

  draw(ctx) {
    const a = this.avatar;
    // a thin ring under them, so you can always tell which one is you
    glowDot(ctx, this.x, this.y - 1, 14, Theme.hp, 0.10 + (this.hurtFlash > 0 ? 0.25 : 0));
    a.draw(ctx);
    // their name, small, over their head
    drawFoeTag(ctx, this);
  }
}

function drawFoeTag(ctx, foe) {
  const y = foe.y - foe.h - 12;
  const w = 22;
  pxRect(ctx, foe.x - w / 2, y, w, 3, rgba('#000000', 0.55));
  const k = clamp(foe.hp / Math.max(1, foe.maxHp), 0, 1);
  pxRect(ctx, foe.x - w / 2 + 1, y + 1, Math.round((w - 2) * k), 1, Theme.hp);
}

// --- their shots, as scenery ---------------------------------------------
// Only the owner of a shot decides what it hits. Over here it is a picture of
// one, positioned from the same snapshot that moves them, so both screens see
// the arrow in the same place without either being able to hit twice with it.

function syncGhosts(list) {
  const g = Duel.ghosts;
  const n = Math.min(list.length, PVP.ghostCap);
  while (g.length > n) g.pop();
  for (let i = 0; i < n; i++) {
    const [x, y, ang, kind] = list[i];
    if (!g[i] || g[i].kind !== kind) {
      g[i] = new Projectile({ x, y, vx: Math.cos(ang), vy: Math.sin(ang), kind, team: 'ghost' });
    }
    g[i].x = x; g[i].y = y; g[i].angle = ang;
  }
}

export function updateGhosts(dt) {
  for (const p of Duel.ghosts) { p.t += dt; p.trail.length = 0; }
}

export function drawGhosts(ctx) {
  for (const p of Duel.ghosts) {
    try { p.draw(ctx); } catch { /* a picture of a shot is never worth a frame */ }
  }
}

// --- what we tell them ----------------------------------------------------

function snapshot(game) {
  const p = game.player;
  if (!p) return null;
  const g = [];
  for (const pr of game.projectiles) {
    if (pr.dead || pr.team !== 'player') continue;
    g.push([Math.round(pr.x * 2) / 2, Math.round(pr.y * 2) / 2,
            Math.round((pr.angle ?? 0) * 100) / 100, pr.kind]);
    if (g.length >= PVP.ghostCap) break;
  }
  const sw = p.swing
    ? { k: p.swing.kind, a: p.swing.angle, t: p.swing.t, r: p.swing.range, c: p.swing.arc, dr: p.swing.dir }
    : null;
  return {
    k: 's',
    x: Math.round(p.x * 4) / 4, y: Math.round(p.y * 4) / 4,
    vx: Math.round(p.vx), vy: Math.round(p.vy),
    f: p.facing, hp: Math.round(p.hp), mx: p.maxHp, sh: Math.round(p.shield),
    dt: p.dashT, og: p.onGround ? 1 : 0, iv: p.invuln, d: p.dead ? 1 : 0,
    sw, g,
  };
}

// --- the flow -------------------------------------------------------------

/** The server said go. Nothing is on the floor yet; both sides now pick. */
export function beginDuel(game, msg) {
  Duel.active = true;
  Duel.role = msg.role;
  Duel.map = msg.map ?? PVP.maps[0];
  Duel.oppName = msg.opponent ?? 'PLAYER';
  Duel.round = 0;
  Duel.myScore = 0;
  Duel.foeScore = 0;
  Duel.phase = 'pick';
  Duel.ready = false;
  Duel.foeReady = null;
  Duel.pickLeft = PVP.pickSeconds;
  Duel.result = null;
  Duel.banner = '';
  Duel.bannerT = 0;
  Duel.reelT = 0;
  Duel.reelDone = false;
  Duel.ghosts.length = 0;
  Duel.foe = null;
  game.mode = 'pvp';
  game.pvpWeapon = null;
  game.pvpPerk = null;
  game.openPvpPick();
}

/** Both have locked in. Show the map reel, then fight in it. */
export function bothPicked() { return Duel.ready && !!Duel.foeReady; }

export function lockPick(game, weaponId, perkId) {
  if (Duel.ready) return;
  Duel.ready = true;
  game.pvpWeapon = weaponId;
  game.pvpPerk = perkId;
  sendMatch({ k: 'ready', w: weaponId, p: perkId, c: game.pendingClass ?? 'melee' });
}

/**
 * Put the room down and both players in it. Called for every round, so a
 * round is a clean slate: full bars, fresh corners, nothing left flying.
 */
export function startDuelRound(game, n) {
  Duel.round = n;
  Duel.phase = 'countdown';
  Duel.timer = PVP.countdown;
  Duel.ghosts.length = 0;
  game.roomIndex = Duel.map.room;
  game.roomCleared = true;         // there are no waves in a duel
  game.pendingSpawns.length = 0;
  game.projectiles.length = 0;
  game.pickups.length = 0;
  game.shields.length = 0;
  game.shockwaves.length = 0;
  game.bolts.length = 0;
  game.anvil = null;
  game.portal = null;
  game.boss = null;
  game.enemies.length = 0;
  closeRightWall();
  layoutRoom(Duel.map.room);

  const p = game.player;
  p.dead = false;
  p.hp = p.maxHp;
  p.shield = p.shieldMax;
  p.x = mySpawn();
  p.y = GROUND_Y;
  p.vx = 0; p.vy = 0;
  p.facing = Duel.role === 'host' ? 1 : -1;
  p.invuln = 0;
  p.swing = null;
  p.boomerangOut = null;
  p.releaseGrapple(true);
  p.resetChains();

  const foe = new Duelist(game, Duel.foeReady?.c ?? 'melee');
  if (Duel.foeReady?.w) equip(foe.avatar, Duel.foeReady.w);
  foe.x = foeSpawn();
  foe.net.x = foe.x;
  foe.net.y = GROUND_Y;
  foe.net.facing = Duel.role === 'host' ? -1 : 1;
  Duel.foe = foe;
  game.enemies.push(foe);

  banner(`ROUND ${n}`, 1.2);
  Sfx.wave();
}

function equip(player, weaponId) {
  for (const id of ['sword', 'bow', 'bookairplane']) player.inventory.remove(id, 1);
  player.inventory.add(weaponId, 1);
  const i = player.inventory.slots.findIndex((sl) => sl && sl.id === weaponId);
  if (i >= 0) player.inventory.selected = i;
  player.recomputeStats();
}

export function banner(text, secs = 1.4) {
  Duel.banner = text;
  Duel.bannerT = secs;
}

/** Your own bar emptied. Only you can say so; everyone counts it the same way. */
export function onDuelDeath(game) {
  if (Duel.phase !== 'fight') return;
  Duel.phase = 'dead';
  Duel.timer = PVP.deathPause;
  sendMatch({ k: 'died' });
  score(game, false);
}

function score(game, iWon) {
  if (iWon) Duel.myScore++;
  else Duel.foeScore++;
  banner(iWon ? 'ROUND WON' : 'ROUND LOST', PVP.deathPause);
  Camera.add(6);
}

function matchDecided() {
  if (Duel.myScore >= PVP.winsNeeded || Duel.foeScore >= PVP.winsNeeded) return true;
  return Duel.round >= PVP.rounds;
}

function finishDuel(game) {
  Duel.phase = 'over';
  Duel.result = Duel.myScore > Duel.foeScore ? 'win'
    : Duel.foeScore > Duel.myScore ? 'lose' : 'draw';
  matchOver();
  // The wait before you may open another lobby starts when the fight ends,
  // not when it began - the server counts it from here too.
  game.pvpCooldownUntil = performance.now() + 3000;
  game.screen = 'pvpOver';
}

// --- the frame ------------------------------------------------------------

export function updateDuel(game, dt) {
  if (!Duel.active) return;
  if (Duel.bannerT > 0) Duel.bannerT -= dt;
  updateGhosts(dt);

  // the feed
  Duel.sendT += dt;
  const step = 1 / PVP.snapshotHz;
  if (Duel.sendT >= step) {
    Duel.sendT = 0;
    const s = snapshot(game);
    if (s) sendMatch(s);
  }

  if (Duel.phase === 'countdown') {
    Duel.timer -= dt;
    if (Duel.timer <= 0) {
      Duel.phase = 'fight';
      banner('FIGHT', 0.8);
      Sfx.ui();
    }
    return;
  }
  if (Duel.phase === 'dead') {
    Duel.timer -= dt;
    if (Duel.timer <= 0) {
      if (matchDecided()) finishDuel(game);
      else startDuelRound(game, Duel.round + 1);
    }
  }
}

/** Nobody moves during a countdown or between rounds. */
export function duelFrozen() {
  return Duel.active && Duel.phase !== 'fight';
}

// --- the wire -------------------------------------------------------------

export function onDuelMessage(game, msg) {
  switch (msg.k) {
    case 's':
      if (Duel.foe) Duel.foe.applySnapshot(msg);
      break;
    case 'hit': {
      const p = game.player;
      if (!p || p.dead || Duel.phase !== 'fight') break;
      p.hurt(msg.d ?? 1, msg.fx ?? p.x);
      break;
    }
    case 'died':
      if (Duel.phase !== 'fight') break;
      Duel.phase = 'dead';
      Duel.timer = PVP.deathPause;
      score(game, true);
      break;
    case 'ready':
      Duel.foeReady = { w: msg.w, p: msg.p, c: msg.c ?? 'melee' };
      break;
    case 'bye':
      Duel.result = 'win';
      Duel.phase = 'over';
      banner('THEY LEFT', 2);
      game.screen = 'pvpOver';
      break;
    default:
      break;
  }
}

/**
 * They are not there any more - closed the tab, lost the connection, walked
 * out. A duel with one player in it is over, and the one still standing has
 * won it: leaving mid-match is not a way to avoid the loss.
 */
export function onOpponentGone(game) {
  if (!Duel.active || Duel.phase === 'over') return;
  Duel.phase = 'over';
  Duel.result = Duel.myScore > Duel.foeScore ? 'win'
    : Duel.foeScore > Duel.myScore ? 'lose' : 'win';
  banner('THEY LEFT', 2);
  game.pvpCooldownUntil = performance.now() + 3000;
  game.screen = 'pvpOver';
}

/** Walking out of a duel, by choice or by losing the connection. */
export function endDuel(game, tellThem = true) {
  if (tellThem && Net.state === 'online') sendMatch({ k: 'bye' });
  Duel.active = false;
  Duel.foe = null;
  Duel.ghosts.length = 0;
  Duel.phase = 'idle';
}

// --- the perk reel, unseeded ---------------------------------------------
// The rush spins its reel off the run seed so a seed you liked gives the same
// perk back. A duel must not: the pool is drawn straight off Math.random, and
// there is nothing to type that changes it.

export function duelPerkPool(inv) {
  return DROP_POOL.filter((id) => !(UNIQUE_ONCE.has(id) && inv && inv.has(id)) && ITEMS[id]);
}

export function randomOf(list) { return list[Math.floor(Math.random() * list.length)]; }
