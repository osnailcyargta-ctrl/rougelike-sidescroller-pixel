// The wire. Everything that talks to the PvP server lives here, and nothing
// in here knows the rules of the game - it moves messages and tracks who is
// in which lobby.
//
// Where the server is: whatever is saved in settings, else the page's own host
// on the default port. A ?pvp= in the URL overrides both, which is how two
// browsers on one machine are pointed at one server for testing.

const STORE = 'aether.pvp.server';
export const DEFAULT_PORT = 8787;

export function serverUrl() {
  const q = new URLSearchParams(location.search).get('pvp');
  if (q) return q;
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) return saved;
  } catch { /* storage off: fall through to the default */ }
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
  return fetch(httpUrl(serverUrl()), { signal: ctl.signal, cache: 'no-store' })
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
      break;
    case 'lobbies':
      Net.lobbies = msg.list ?? [];
      break;
    case 'lobby':
      Net.lobby = msg;
      break;
    case 'lobbyClosed':
      Net.lobby = null;
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
