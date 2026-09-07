// The PvP server: lobbies, and a relay between the two players in one.
//
// Run it with plain node - `node server/pvp.js` - and nothing else. It speaks
// WebSocket over the raw http module rather than pulling in a library, so
// there is no install step between someone cloning this and playing.
//
// It knows nothing about the game. Two clients agree that one of them is the
// host, the host simulates the fight and sends snapshots, the guest sends its
// input, and this only decides who is talking to whom. That keeps the rules in
// one place - the game - and keeps this small enough to read.

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);

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
const clients = new Set();        // every connected socket wrapper

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

// --- the protocol ---------------------------------------------------------

function handle(c, msg) {
  const t = msg && msg.t;
  if (t === 'hello') {
    c.name = String(msg.name || 'PLAYER').slice(0, 12).toUpperCase();
    c.sock.send({ t: 'welcome', you: c.name, list: lobbyList(), maxLobbies: MAX_LOBBIES });
    return;
  }
  if (t === 'list') { c.sock.send({ t: 'lobbies', list: lobbyList() }); return; }

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

  if (t === 'ping') { c.sock.send({ t: 'pong', at: msg.at }); return; }
}

// --- wiring ---------------------------------------------------------------

const server = http.createServer((req, res) => {
  // A plain GET is how the client checks the server is there before it shows
  // the menu, so answer it cheaply and allow it from the game's own origin.
  res.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, game: 'ascent-to-the-aether', lobbies: lobbies.size, max: MAX_LOBBIES }));
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
  const c = { sock, name: 'PLAYER', lobby: null, cooldownUntil: 0 };
  clients.add(c);
  sock.onmessage = (msg) => { try { handle(c, msg); } catch { /* one bad message is not fatal */ } };
  sock.onclose = () => { leaveLobby(c); clients.delete(c); };
  sock.send({ t: 'hi' });
});

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

server.listen(PORT, () => {
  console.log(`pvp server on :${PORT}  (max ${MAX_LOBBIES} lobbies)`);
});
