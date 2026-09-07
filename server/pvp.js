// The PvP server: lobbies, a relay between the two players in one, and a
// window onto them for whoever runs the box.
//
// Run it with plain node - `node server/pvp.js` - and nothing else. It speaks
// WebSocket over the raw http module rather than pulling in a library, so
// there is no install step between someone cloning this and playing, and
// nothing to audit but this file. `compose.yaml` at the root of the repo puts
// it on a NAS on port 8897.
//
// It knows nothing about the game. Two clients agree that one of them is the
// host, the host simulates the fight and sends snapshots, the guest sends its
// input, and this only decides who is talking to whom. That keeps the rules in
// one place - the game - and keeps this small enough to read.
//
// Three things it does know about:
//
//   * Quiet hours. Between QUIET_FROM and QUIET_TO in the server's own clock -
//     not the player's - it is shut. Not "empty": shut. Lobbies are closed,
//     the lobby list is refused, and the status the game fetches says so and
//     names the hour it opens again.
//   * The watch page at /watch, behind a password kept in a file of its own.
//     It shows every live lobby as a moving picture of what those two players
//     are looking at.
//   * Frames. A player only sends pictures of their screen while somebody is
//     actually watching, and only as often as that watcher asked for.

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8897);

// Where a duel is fought. Kept here as well as in the game so the roll happens
// on the server - a client cannot ask for a map, only be told one.
const MAPS = [
  { room: 0,  name: 'NEON CITY',    sub: 'WHERE IT STARTED' },
  { room: 2,  name: 'GRASSY FIELD', sub: 'OPEN GROUND' },
  { room: 7,  name: 'THE CASTLE',   sub: 'STONE AND CHAIN' },
  { room: 15, name: 'THE INFERNO',  sub: 'UNDER THE FLOOR' },
  { room: 18, name: 'THE AETHER',   sub: 'NOTHING UNDERNEATH' },
];

// --- limits ---------------------------------------------------------------
const MAX_LOBBIES = 10;          // how many can exist at once
const CREATE_COOLDOWN = 3000;    // after a match, before you may open another
const KICK_BAN = 2000;           // how long a kicked player is kept out
const START_DELAY = 3000;        // both in the lobby, then this, then the game
const IDLE_TIMEOUT = 120000;     // a lobby nobody has touched
const MAX_FRAME = 1 << 20;       // a megabyte of one message is not a game

// --- when it is shut ------------------------------------------------------
// Read in the server's own local time, which is the whole point: a player in
// another timezone does not get their own set of opening hours. Set TZ in
// compose.yaml to say which clock that is.
// Written as an hour ("21") or as a time ("21:30"); kept as minutes past
// midnight, so a window that wraps over midnight is one comparison either way.
function parseClock(v, fallback) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(v ?? ''));
  if (!m) return fallback;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

const QUIET_FROM = parseClock(process.env.QUIET_FROM, 21 * 60);   // 21:00, inclusive
const QUIET_TO = parseClock(process.env.QUIET_TO, 4 * 60);        // 04:00, exclusive

// --- the watch page -------------------------------------------------------
// The password lives in a file, never in this one and never in compose.yaml,
// so the thing that has to be secret is the one thing you do not commit.
const PASS_FILE = process.env.PASS_FILE || path.join(__dirname, 'secret', 'watch-password.txt');
const FPS_MIN = 10;              // what the watcher may ask each player for
const FPS_MAX = 30;

function watchPassword() {
  // Read every time rather than once at boot: changing the file is then the
  // whole job, with nothing to restart.
  try {
    return fs.readFileSync(PASS_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Constant-time compare, so a wrong guess tells you nothing by how long it took. */
function passwordOk(given) {
  const want = watchPassword();
  if (!want) return false;                 // no file, no way in
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(want);
  if (a.length !== b.length) {
    // still burn a comparison, so length is not readable off the clock either
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// --- the clock ------------------------------------------------------------

/** Is that minute of the day inside the quiet window? The window may wrap midnight. */
function minuteIsQuiet(mins) {
  if (QUIET_FROM === QUIET_TO) return false;
  return QUIET_FROM < QUIET_TO
    ? (mins >= QUIET_FROM && mins < QUIET_TO)
    : (mins >= QUIET_FROM || mins < QUIET_TO);
}

function isQuiet(at = new Date()) { return minuteIsQuiet(at.getHours() * 60 + at.getMinutes()); }

/** The next time the door changes state, as a timestamp in ms. */
function nextEdge(mins, at = new Date()) {
  const d = new Date(at);
  d.setSeconds(0, 0);
  d.setHours(Math.floor(mins / 60), mins % 60);
  if (d <= at) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function hhmm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** Everything the game needs to say when the door is shut - or open. */
function doorState(at = new Date()) {
  const quiet = isQuiet(at);
  return {
    open: !quiet,
    quiet,
    // in the server's clock, and said so, because that is the clock that counts
    now: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'server time',
    closesAt: hhmm(QUIET_FROM),
    opensAt: hhmm(QUIET_TO),
    // and when that next actually happens, so a countdown needs no arithmetic
    changesAt: quiet ? nextEdge(QUIET_TO, at) : nextEdge(QUIET_FROM, at),
    message: quiet
      ? `PVP IS SHUT UNTIL ${hhmm(QUIET_TO)} SERVER TIME`
      : `PVP SHUTS AT ${hhmm(QUIET_FROM)} SERVER TIME`,
  };
}

// --- the tiny WebSocket layer --------------------------------------------
// Only what this needs: text frames, close, ping/pong, no extensions, no
// fragmentation on the way out. Fragmented input is reassembled because a
// browser may split a large snapshot.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x81;                 // FIN + text
  return Buffer.concat([head, payload]);
}

class Socket {
  constructor(raw) {
    this.raw = raw;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    raw.on('data', (d) => this.feed(d));
    raw.on('close', () => this.die());
    raw.on('error', () => this.die());
    raw.setNoDelay(true);         // every millisecond of Nagle is a millisecond of lag
  }

  send(obj) {
    if (!this.open) return;
    try { this.raw.write(frame(JSON.stringify(obj))); } catch { this.die(); }
  }

  // A ws-level ping. A phone that walks out of range does not send a FIN, so
  // without this its lobby would sit there holding one of the ten slots until
  // the idle sweep noticed - and a lobby with somebody in it never goes idle.
  ping() {
    if (!this.open) return;
    try { this.raw.write(Buffer.from([0x89, 0x00])); } catch { this.die(); }
  }

  close() {
    if (!this.open) return;
    try { this.raw.end(Buffer.from([0x88, 0x00])); } catch { /* already gone */ }
    this.die();
  }

  die() {
    if (!this.open) return;
    this.open = false;
    try { this.raw.destroy(); } catch { /* ignore */ }
    if (this.onclose) this.onclose();
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const big = this.buf.readBigUInt64BE(off); off += 8;
        if (big > BigInt(MAX_FRAME)) return this.close();
        len = Number(big);
      }
      if (len > MAX_FRAME) return this.close();
      if (masked && this.buf.length < off + 4) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const body = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);

      if (op === 0x8) return this.close();
      if (op === 0x9) {                     // ping: answer, keep going
        try { this.raw.write(Buffer.concat([Buffer.from([0x8a, body.length]), body])); } catch { /* ignore */ }
        continue;
      }
      if (op === 0xa) continue;             // pong
      this.parts.push(body);
      if (!fin) continue;
      const text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      let msg = null;
      try { msg = JSON.parse(text); } catch { continue; }   // junk is not fatal
      if (msg && this.onmessage) this.onmessage(msg);
    }
  }
}

// --- lobbies --------------------------------------------------------------

let nextId = 1;
const lobbies = new Map();        // id -> lobby
const clients = new Set();        // every connected player socket
const watchers = new Set();       // and everyone looking in through /watch

const now = () => Date.now();

function lobbyList() {
  const out = [];
  for (const l of lobbies.values()) {
    out.push({
      id: l.id,
      name: l.name,
      host: l.host ? l.host.name : null,
      guest: l.guest ? l.guest.name : null,
      players: (l.host ? 1 : 0) + (l.guest ? 1 : 0),
      started: l.started,
    });
  }
  return out;
}

function broadcastLobbies() {
  pushWatchList();
  const list = lobbyList();
  for (const c of clients) {
    if (c.lobby) continue;        // people already in one do not need the list
    c.sock.send({ t: 'lobbies', list });
  }
}

function lobbyState(l) {
  return {
    t: 'lobby',
    id: l.id,
    name: l.name,
    host: l.host ? l.host.name : null,
    guest: l.guest ? l.guest.name : null,
    startsAt: l.startsAt,
    started: l.started,
  };
}

function pushLobby(l) {
  const msg = lobbyState(l);
  if (l.host) l.host.sock.send(msg);
  if (l.guest) l.guest.sock.send(msg);
}

function armStart(l) {
  if (l.started || !l.host || !l.guest) { l.startsAt = 0; pushLobby(l); return; }
  l.startsAt = now() + START_DELAY;
  pushLobby(l);
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    if (!l.host || !l.guest || l.started) return;
    l.started = true;
    // The host simulates. It is told so here, once, so both ends agree before
    // a single frame of the match exists.
    // The map is rolled here, by the one machine neither player controls, and
    // handed to both. There is no seed to set: crypto.randomInt is not a
    // sequence anybody can reproduce.
    const map = MAPS[crypto.randomInt(MAPS.length)];
    l.host.sock.send({ t: 'start', role: 'host', opponent: l.guest.name, map });
    l.guest.sock.send({ t: 'start', role: 'guest', opponent: l.host.name, map });
    pushLobby(l);
    broadcastLobbies();
  }, START_DELAY);
}

function leaveLobby(c, why = 'left') {
  const l = c.lobby;
  if (!l) return;
  c.lobby = null;
  if (l.host === c) {
    // the owner going means the lobby goes
    if (l.guest) {
      l.guest.sock.send({ t: 'lobbyClosed', why: why === 'left' ? 'the host left' : why });
      l.guest.lobby = null;
    }
    clearTimeout(l.timer);
    lobbies.delete(l.id);
  } else if (l.guest === c) {
    l.guest = null;
    l.started = false;
    l.startsAt = 0;
    clearTimeout(l.timer);
    if (l.host) l.host.sock.send({ t: 'opponentLeft' });
    pushLobby(l);
  }
  broadcastLobbies();
}

function other(l, c) {
  if (l.host === c) return l.guest;
  if (l.guest === c) return l.host;
  return null;
}

// --- watching -------------------------------------------------------------
// A watcher sees the shape of every lobby, and a moving picture of what each
// player in it is looking at. The pictures are not free, so nobody sends any
// until somebody is watching, and they stop the moment the last watcher goes.

/** The rate the players should be sending at: the fastest anybody asked for. */
function wantedFps() {
  let fps = 0;
  for (const w of watchers) if (w.ok) fps = Math.max(fps, w.fps);
  return Math.min(FPS_MAX, fps);
}

/**
 * Tell every player how often to send a picture of their screen - which is
 * usually "not at all". Only sent when the answer changes, so a lobby full of
 * people does not get a message per watcher per second.
 */
function syncCapture() {
  const fps = wantedFps();
  for (const c of clients) {
    if (c.captureFps === fps) continue;
    c.captureFps = fps;
    c.sock.send({ t: 'capture', fps });
  }
}

/** What the watch page draws: one card per lobby, with who is in it. */
function watchList() {
  const out = [];
  for (const l of lobbies.values()) {
    out.push({
      id: l.id,
      name: l.name,
      started: l.started,
      seats: [
        l.host ? { key: `${l.id}:h`, name: l.host.name, role: 'HOST' } : null,
        l.guest ? { key: `${l.id}:g`, name: l.guest.name, role: 'CHALLENGER' } : null,
      ].filter(Boolean),
    });
  }
  return out;
}

function pushWatchList() {
  const list = watchList();
  const door = doorState();
  for (const w of watchers) {
    if (w.ok) w.sock.send({ t: 'wlobbies', list, door });
  }
}

/** One player's screen, on its way to everyone looking. */
function pushFrame(c, img) {
  if (!c.lobby || !watchers.size) return;
  const key = `${c.lobby.id}:${c.lobby.host === c ? 'h' : 'g'}`;
  const msg = { t: 'wframe', key, id: c.lobby.id, name: c.name, img };
  for (const w of watchers) if (w.ok) w.sock.send(msg);
}

function handleWatcher(w, msg) {
  const t = msg && msg.t;
  if (t === 'watch') {
    if (!passwordOk(msg.pass)) {
      w.sock.send({ t: 'denied', why: watchPassword() ? 'WRONG PASSWORD' : 'NO PASSWORD FILE ON THE SERVER' });
      return;
    }
    w.ok = true;
    w.fps = clampFps(msg.fps);
    w.sock.send({ t: 'watching', fpsMin: FPS_MIN, fpsMax: FPS_MAX, fps: w.fps });
    pushWatchList();
    syncCapture();
    return;
  }
  if (!w.ok) return;              // nothing else works until the password does
  if (t === 'fps') { w.fps = clampFps(msg.n); syncCapture(); return; }
  if (t === 'ping') { w.sock.send({ t: 'pong', at: msg.at }); return; }
}

function clampFps(n) {
  const v = Math.round(Number(n) || FPS_MIN);
  return Math.max(FPS_MIN, Math.min(FPS_MAX, v));
}

// --- the protocol ---------------------------------------------------------

function handle(c, msg) {
  const t = msg && msg.t;

  // A picture of somebody's screen, on its way to the watch page. Allowed at
  // any hour: it is not a way into a game.
  if (t === 'frame') {
    if (typeof msg.img === 'string' && msg.img.length < MAX_FRAME) pushFrame(c, msg.img);
    return;
  }
  if (t === 'ping') { c.sock.send({ t: 'pong', at: msg.at }); return; }

  if (t === 'hello') {
    c.name = String(msg.name || 'PLAYER').slice(0, 12).toUpperCase();
    c.sock.send({
      t: 'welcome', you: c.name, list: lobbyList(), maxLobbies: MAX_LOBBIES,
      door: doorState(),
    });
    if (c.captureFps) c.sock.send({ t: 'capture', fps: c.captureFps });
    return;
  }

  // Everything below this line is the lobby system, and during quiet hours
  // the lobby system does not exist. Not "there are no lobbies" - there is
  // nothing to fetch and nothing to make, and the answer says when that
  // changes.
  if (isQuiet()) {
    const door = doorState();
    c.sock.send({ t: 'closed', door, why: door.message });
    return;
  }

  if (t === 'list') { c.sock.send({ t: 'lobbies', list: lobbyList(), door: doorState() }); return; }

  if (t === 'create') {
    if (c.lobby) return;
    if (lobbies.size >= MAX_LOBBIES) {
      c.sock.send({ t: 'error', why: `ALL ${MAX_LOBBIES} LOBBIES ARE IN USE` });
      return;
    }
    const wait = c.cooldownUntil - now();
    if (wait > 0) {
      c.sock.send({ t: 'error', why: `WAIT ${Math.ceil(wait / 1000)}S BEFORE OPENING ANOTHER` });
      return;
    }
    const l = {
      id: nextId++,
      name: String(msg.name || `${c.name}'S LOBBY`).slice(0, 20).toUpperCase(),
      host: c, guest: null, started: false, startsAt: 0, timer: null,
      banned: new Map(),          // name -> until
      touched: now(),
    };
    lobbies.set(l.id, l);
    c.lobby = l;
    pushLobby(l);
    broadcastLobbies();
    return;
  }

  if (t === 'join') {
    if (c.lobby) return;
    const l = lobbies.get(msg.id);
    if (!l) { c.sock.send({ t: 'error', why: 'THAT LOBBY IS GONE' }); return; }
    if (l.guest || l.started) { c.sock.send({ t: 'error', why: 'THAT LOBBY IS FULL' }); return; }
    const ban = l.banned.get(c.name) ?? 0;
    if (ban > now()) {
      c.sock.send({ t: 'error', why: `KICKED - ${Math.ceil((ban - now()) / 1000)}S` });
      return;
    }
    l.guest = c;
    c.lobby = l;
    l.touched = now();
    armStart(l);
    broadcastLobbies();
    return;
  }

  if (t === 'leave') { leaveLobby(c); return; }

  if (t === 'kick') {
    const l = c.lobby;
    if (!l || l.host !== c || !l.guest) return;
    const g = l.guest;
    l.banned.set(g.name, now() + KICK_BAN);
    g.sock.send({ t: 'kicked', seconds: KICK_BAN / 1000 });
    g.lobby = null;
    l.guest = null;
    l.started = false;
    l.startsAt = 0;
    clearTimeout(l.timer);
    pushLobby(l);
    broadcastLobbies();
    return;
  }

  // Everything else is the match itself, and this does not read it: whatever
  // one side sends, the other side gets, as fast as it arrives.
  if (t === 'net') {
    const l = c.lobby;
    if (!l) return;
    const o = other(l, c);
    if (o) o.sock.send(msg);
    return;
  }

  if (t === 'over') {
    const l = c.lobby;
    if (!l) return;
    c.cooldownUntil = now() + CREATE_COOLDOWN;
    const o = other(l, c);
    if (o) o.cooldownUntil = now() + CREATE_COOLDOWN;
    return;
  }

}

// --- wiring ---------------------------------------------------------------

const WATCH_PAGE = path.join(__dirname, 'watch.html');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // The watch page. Served to anybody who asks - it is a password box and
  // nothing else. What it shows arrives over the socket, after the password.
  if (url === '/watch' || url === '/watch/') {
    fs.readFile(WATCH_PAGE, (err, body) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('watch.html is missing'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    });
    return;
  }

  // A plain GET is how the game checks the server is there before it shows
  // the menu, so answer it cheaply and allow it from the game's own origin.
  // During quiet hours it still answers - it has to, or the game could not
  // tell "shut until four" apart from "no server at all".
  const door = doorState();
  res.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({
    ok: true,
    game: 'ascent-to-the-aether',
    lobbies: door.open ? lobbies.size : 0,
    max: MAX_LOBBIES,
    door,
  }));
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`);

  const sock = new Socket(socket);
  const watching = (req.url || '').startsWith('/watch');

  if (watching) {
    // A watcher is not a player: it never gets a lobby, and until it has said
    // the password it gets nothing at all.
    const w = { sock, ok: false, fps: FPS_MIN };
    watchers.add(w);
    sock.onmessage = (msg) => { try { handleWatcher(w, msg); } catch { /* ignore */ } };
    sock.onclose = () => { watchers.delete(w); syncCapture(); };
    sock.send({ t: 'hi', watch: true, door: doorState() });
    return;
  }

  const c = { sock, name: 'PLAYER', lobby: null, cooldownUntil: 0, captureFps: 0 };
  clients.add(c);
  sock.onmessage = (msg) => { try { handle(c, msg); } catch { /* one bad message is not fatal */ } };
  sock.onclose = () => { leaveLobby(c); clients.delete(c); };
  sock.send({ t: 'hi', door: doorState() });
  // if somebody is already watching, this player starts sending pictures too
  const fps = wantedFps();
  if (fps) { c.captureFps = fps; sock.send({ t: 'capture', fps }); }
});

// --- the door -------------------------------------------------------------
// On the stroke of the quiet hour every lobby is closed and everybody in one
// is told why and when it opens again. Checked every ten seconds rather than
// scheduled, so a NAS that suspends and wakes lands on the right side of it.

let wasQuiet = isQuiet();
setInterval(() => {
  const quiet = isQuiet();
  if (quiet === wasQuiet) return;
  wasQuiet = quiet;
  const door = doorState();
  if (quiet) {
    for (const l of [...lobbies.values()]) {
      for (const seat of [l.host, l.guest]) {
        if (!seat) continue;
        seat.sock.send({ t: 'lobbyClosed', why: door.message, door });
        seat.lobby = null;
      }
      clearTimeout(l.timer);
      lobbies.delete(l.id);
    }
    console.log(`shut for the night - open again at ${door.opensAt}`);
  } else {
    console.log(`open - shut again at ${door.closesAt}`);
  }
  // everybody hears about it either way, in a lobby or not
  for (const c of clients) c.sock.send({ t: 'door', door });
  pushWatchList();
}, 5000);

// lobbies nobody is using do not sit there holding a slot
setInterval(() => {
  // first: anybody whose connection has already gone quietly
  for (const c of [...clients]) {
    if (c.sock.open) { c.sock.ping(); continue; }
    leaveLobby(c);
    clients.delete(c);
  }
  const cut = now() - IDLE_TIMEOUT;
  for (const l of [...lobbies.values()]) {
    if (l.guest || l.touched > cut) continue;
    if (l.host) { l.host.sock.send({ t: 'lobbyClosed', why: 'idle' }); l.host.lobby = null; }
    clearTimeout(l.timer);
    lobbies.delete(l.id);
  }
}, 15000);

// the watch page wants the list moving even when nobody joins or leaves
setInterval(() => { if (watchers.size) pushWatchList(); }, 2000);

server.listen(PORT, () => {
  const door = doorState();
  console.log(`pvp server on :${PORT}  (max ${MAX_LOBBIES} lobbies)`);
  console.log(`clock: ${door.now} ${door.tz} - ${door.message}`);
  console.log(`watch: http://<this-box>:${PORT}/watch  (password from ${PASS_FILE})`);
  if (!watchPassword()) console.log('WARNING: no password file, so the watch page cannot be opened at all');
});
