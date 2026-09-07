// The wire. Everything that talks to the PvP server lives here, and nothing
// in here knows the rules of the game - it moves messages and tracks who is
// in which lobby.
//
// Where the server is: whatever is saved in settings, else the page's own host
// on the default port. A ?pvp= in the URL overrides both, which is how two
// browsers on one machine are pointed at one server for testing.

import { PVP_SERVER, PVP_PORT } from './pvpserver.js';

const STORE = 'aether.pvp.server';
export const DEFAULT_PORT = PVP_PORT;

/**
 * Where to talk to, most specific first: what this page was opened with, then
 * what this browser was told to remember, then the address the game ships
 * pointed at, and only then the page's own host - which is the right answer
 * when you are running both halves on one machine.
 */
export function serverUrl() {
  const q = new URLSearchParams(location.search).get('pvp');
  if (q) return q;
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) return saved;
  } catch { /* storage off: fall through to the default */ }
  if (PVP_SERVER) return PVP_SERVER;
  const host = location.hostname || 'localhost';
  return `${host}:${DEFAULT_PORT}`;
}

export function setServerUrl(v) {
  try { localStorage.setItem(STORE, String(v || '').trim()); } catch { /* ignore */ }
}

// "host:port" is what a person types; these turn it into what fetch and
// WebSocket want, keeping https/wss when the page itself is secure.
function httpUrl(addr) {
  if (/^https?:\/\//i.test(addr)) return addr;
  const secure = location.protocol === 'https:';
  return `${secure ? 'https' : 'http'}://${addr}`;
}

function wsUrl(addr) {
  if (/^wss?:\/\//i.test(addr)) return addr;
  if (/^https?:\/\//i.test(addr)) return addr.replace(/^http/i, 'ws');
  const secure = location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${addr}`;
}

export const Net = {
  state: 'idle',        // idle | probing | connecting | online | offline
  why: '',              // why it is offline, for the screen to show
  sock: null,
  you: 'PLAYER',
  lobbies: [],
  lobby: null,          // { id, name, host, guest, startsAt, started }
  role: null,           // host | guest, once a match starts
  opponent: null,
  map: null,           // the room the server rolled for this match
  ping: 0,
  kickedUntil: 0,
  maxLobbies: 10,
  onstart: null,        // the game hooks these
  onmatch: null,        // every {t:'net'} message from the other player
  onclosed: null,
  ongone: null,        // the other player is no longer in the lobby
  // The server's own opening hours, in the server's own clock. Null until it
  // has told us; after that the menu shows it whether the door is open or not.
  door: null,
  // How often the server wants a picture of this screen, and zero - which is
  // the usual answer - means it wants none. It only ever asks while somebody
  // is watching the lobby list on the box itself.
  captureFps: 0,
  error: '',
  probeStarted: 0,
};

/**
 * Ask the server whether it is there. Resolves true or false; the caller runs
 * its own clock, because the screen wants to offer a way out after ten
 * seconds without giving up on the attempt underneath.
 */
export function probeServer(timeoutMs = 10000) {
  Net.state = 'probing';
  Net.probeStarted = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // /status, not /: the server's own address is a page for a person to look
  // at, so the machine-readable answer lives one step along.
  return fetch(`${httpUrl(serverUrl()).replace(/\/+$/, '')}/status`, { signal: ctl.signal, cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

export function connect(name = 'PLAYER') {
  return new Promise((resolve) => {
    let done = false;
    try {
      const sock = new WebSocket(wsUrl(serverUrl()));
      Net.sock = sock;
      Net.state = 'connecting';
      Net.error = '';
      sock.onopen = () => {
        send({ t: 'hello', name });
      };
      sock.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        route(msg);
        if (!done && msg.t === 'welcome') { done = true; resolve(true); }
      };
      sock.onclose = () => {
        Net.state = 'offline';
        Net.sock = null;
        Net.lobby = null;
        Net.role = null;
        if (Net.onclosed) Net.onclosed();
        if (!done) { done = true; resolve(false); }
      };
      sock.onerror = () => { /* onclose follows */ };
    } catch {
      Net.state = 'offline';
      if (!done) { done = true; resolve(false); }
    }
  });
}

export function disconnect() {
  if (Net.sock) { try { Net.sock.close(); } catch { /* ignore */ } }
  Net.sock = null;
  Net.state = 'idle';
  Net.lobby = null;
  Net.role = null;
}

export function send(obj) {
  const s = Net.sock;
  if (!s || s.readyState !== 1) return false;
  try { s.send(JSON.stringify(obj)); return true; } catch { return false; }
}

/** Anything that belongs to the match rather than to the lobby. */
export function sendMatch(obj) { return send({ ...obj, t: 'net' }); }

function route(msg) {
  switch (msg.t) {
    case 'welcome':
      Net.state = 'online';
      Net.you = msg.you;
      Net.lobbies = msg.list ?? [];
      Net.maxLobbies = msg.maxLobbies ?? 10;
      if (msg.door) Net.door = msg.door;
      break;
    case 'lobbies':
      Net.lobbies = msg.list ?? [];
      if (msg.door) Net.door = msg.door;
      break;
    case 'hi':
      if (msg.door) Net.door = msg.door;
      break;
    case 'door':
      Net.door = msg.door ?? Net.door;
      break;
    // The lobby system is not merely empty during quiet hours - it is not
    // there, and this is the answer to every request that touches it.
    case 'closed':
      Net.door = msg.door ?? Net.door;
      Net.lobbies = [];
      Net.lobby = null;
      Net.error = String(msg.why || (Net.door && Net.door.message) || 'THE SERVER IS SHUT').toUpperCase();
      break;
    case 'capture':
      Net.captureFps = Math.max(0, Math.min(30, msg.fps ?? 0));
      break;
    case 'lobby':
      Net.lobby = msg;
      break;
    case 'lobbyClosed':
      Net.lobby = null;
      if (msg.door) Net.door = msg.door;
      Net.error = (msg.why || 'the lobby closed').toUpperCase();
      if (Net.ongone) Net.ongone('the lobby closed');
      break;
    case 'opponentLeft':
      Net.error = 'THEY LEFT';
      if (Net.ongone) Net.ongone('they left');
      break;
    case 'kicked':
      Net.lobby = null;
      Net.kickedUntil = performance.now() + (msg.seconds ?? 2) * 1000;
      Net.error = `KICKED - ${msg.seconds ?? 2}S BEFORE YOU CAN REJOIN`;
      break;
    case 'error':
      Net.error = String(msg.why || '').toUpperCase();
      break;
    case 'start':
      Net.role = msg.role;
      Net.opponent = msg.opponent;
      Net.map = msg.map ?? null;
      if (Net.onstart) Net.onstart(msg);
      break;
    case 'pong':
      Net.ping = Math.round(performance.now() - msg.at);
      break;
    case 'net':
      if (Net.onmatch) Net.onmatch(msg);
      break;
    default:
      break;
  }
}

export function createLobby(name) { Net.error = ''; send({ t: 'create', name }); }
export function joinLobby(id) { Net.error = ''; send({ t: 'join', id }); }
export function leaveLobby() { send({ t: 'leave' }); Net.lobby = null; }
export function kickGuest() { send({ t: 'kick' }); }
export function refreshLobbies() { send({ t: 'list' }); }
export function matchOver() { send({ t: 'over' }); }
export function pingServer() { send({ t: 'ping', at: performance.now() }); }

/**
 * How the fight is going, for the log on the server's own page. Only the host
 * sends it, and only numbers: the wording is written on the server, so nothing
 * a player can type ever reaches whoever is watching.
 */
export function reportScore(kind, host, guest, round) {
  return send({ t: 'note', k: kind, h: host, g: guest, n: round });
}

/** Is the door open right now, as far as we have been told? */
export function serverOpen() { return !Net.door || Net.door.open !== false; }

/**
 * A picture of this screen, for whoever is watching the lobby list on the box
 * that runs the server. Half size and lossy: it is a preview, not a recording,
 * and the players' upload is not ours to spend freely.
 */
let frameCanvas = null;
export function sendFrame(source) {
  if (!Net.captureFps || !source) return false;
  if (!frameCanvas) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = Math.round(source.width / 2);
    frameCanvas.height = Math.round(source.height / 2);
  }
  const ctx = frameCanvas.getContext('2d');
  if (!ctx) return false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, frameCanvas.width, frameCanvas.height);
  let img = '';
  try {
    img = frameCanvas.toDataURL('image/webp', 0.45);
    // a browser with no webp encoder hands back a PNG, which is far too big
    if (!img.startsWith('data:image/webp')) img = frameCanvas.toDataURL('image/jpeg', 0.5);
  } catch {
    return false;
  }
  return send({ t: 'frame', img });
}
