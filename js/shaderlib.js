// The shader shelf: every .shdr the player has handed the game, kept so one
// can be switched on or off from the menu instead of being uploaded again.
//
// Browsers give a single origin a few megabytes of localStorage and refuse the
// write that goes over it. A shader is text and a big one is not small, so the
// shelf is split across three keys: writes fill the first, spill into the
// second when it will not take any more, and into the third after that. Reads
// merge all three, so which key an entry sits in never matters to anything
// above this file.

const KEYS = ['aether.shaders.v1', 'aether.shaders.v1.b', 'aether.shaders.v1.c'];
const ACTIVE_KEY = 'aether.shaders.active.v1';

// One store's worth. Kept well under what a browser will actually refuse so a
// shelf that reports room really has some.
export const STORE_LIMIT = 1.6 * 1024 * 1024;
export const STORE_COUNT = KEYS.length;
// A single pack past this is not a shader pack, it is a mistake.
export const MAX_SHADER = 512 * 1024;

function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((e) => e && typeof e.text === 'string') : [];
  } catch {
    return [];
  }
}

// Returns false when the write was refused - a full store, or none at all.
function writeStore(key, list) {
  try {
    if (!list.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Everything on the shelf, oldest first, whichever store it lives in. */
export function loadShaderLibrary() {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < KEYS.length; i++) {
    for (const e of readStore(KEYS[i])) {
      if (seen.has(e.id)) continue;      // a half-finished move, healed on read
      seen.add(e.id);
      out.push({ ...e, store: i });
    }
  }
  return out;
}

/** How full each store is, for the menu to show before it is too late. */
export function shaderStoreUsage() {
  return KEYS.map((k) => {
    let bytes = 0;
    try { bytes = (localStorage.getItem(k) ?? '').length; } catch { /* ignore */ }
    return { bytes, limit: STORE_LIMIT, full: bytes >= STORE_LIMIT };
  });
}

function makeId() {
  return 'sh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Put a pack on the shelf.
 *
 * @return { ok, entry } or { ok: false, error } with something a player can
 *         read. A name that is already taken replaces that entry rather than
 *         quietly keeping two of it.
 */
export function saveShaderToLibrary(name, text) {
  const clean = String(name || 'CUSTOM').toUpperCase().slice(0, 22).trim() || 'CUSTOM';
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'THE FILE IS EMPTY' };
  if (text.length > MAX_SHADER) return { ok: false, error: 'THAT FILE IS TOO BIG (MAX 512KB)' };

  const existing = loadShaderLibrary().find((e) => e.name === clean);
  if (existing) removeShaderFromLibrary(existing.id);

  const entry = { id: makeId(), name: clean, text, size: text.length, at: Date.now() };
  for (let i = 0; i < KEYS.length; i++) {
    const list = readStore(KEYS[i]);
    const used = (localStorage.getItem(KEYS[i]) ?? '').length;
    // Skip a store that has no room rather than finding out by failing, and
    // still take the failure seriously if the browser refuses anyway.
    if (used + text.length > STORE_LIMIT) continue;
    list.push(entry);
    if (writeStore(KEYS[i], list)) return { ok: true, entry: { ...entry, store: i } };
    writeStore(KEYS[i], list.slice(0, -1));   // put the store back as it was
  }
  return { ok: false, error: 'ALL THREE SHADER STORES ARE FULL' };
}

export function removeShaderFromLibrary(id) {
  for (const key of KEYS) {
    const list = readStore(key);
    const next = list.filter((e) => e.id !== id);
    if (next.length !== list.length) {
      writeStore(key, next);
      if (loadActiveShaderId() === id) saveActiveShaderId(null);
      return true;
    }
  }
  return false;
}

export function findShader(id) {
  return loadShaderLibrary().find((e) => e.id === id) ?? null;
}

// --- which one is on ------------------------------------------------------
// Only the id is kept. The text lives on the shelf, so a pack cannot be
// remembered as active while its own entry has been deleted.

export function saveActiveShaderId(id) {
  try {
    if (!id) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch { /* ignore */ }
}

export function loadActiveShaderId() {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}
