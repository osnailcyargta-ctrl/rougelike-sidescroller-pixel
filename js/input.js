// Keyboard / mouse state. Double-tap detection lives here so gameplay code
// only has to ask "did a dash / slam get requested this frame?".
// A double tap is two SEPARATE presses of the same key inside this window,
// with a real release in between. Auto-repeat from a held key, and any keydown
// that arrives while the key is already down, are both discarded - holding a
// key can never produce a double tap.
const DOUBLE_TAP_WINDOW = 0.28;

// --- key bindings -------------------------------------------------------
// Actions are rebindable; everything in gameplay asks for an action, never a
// literal key, so remapping is a single source of truth.
export const BIND_ORDER = ['left', 'right', 'jump', 'down', 'inventory', 'reload', 'grapple'];
export const BIND_LABELS = {
  left: 'MOVE LEFT', right: 'MOVE RIGHT', jump: 'JUMP', down: 'DROP / SLAM',
  inventory: 'INVENTORY', reload: 'RELOAD', grapple: 'GRAPPLE',
};
export const DEFAULT_BINDS = {
  left: 'a', right: 'd', jump: 'w', down: 's',
  inventory: 'e', reload: 'r', grapple: 'q',
};
export const Binds = { ...DEFAULT_BINDS };
const BIND_STORE = 'aether.binds';

export function loadBinds() {
  try {
    const raw = localStorage.getItem(BIND_STORE);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const a of BIND_ORDER) if (typeof saved[a] === 'string') Binds[a] = saved[a];
  } catch (e) { /* storage unavailable: keep the defaults */ }
}

export function saveBinds() {
  try { localStorage.setItem(BIND_STORE, JSON.stringify(Binds)); } catch (e) { /* ignore */ }
}

export function resetBinds() {
  Object.assign(Binds, DEFAULT_BINDS);
  saveBinds();
}

// Assigning a key that is already used swaps the two, so no action is orphaned.
export function setBind(action, key) {
  if (!BIND_ORDER.includes(action)) return;
  const clash = BIND_ORDER.find((a) => a !== action && Binds[a] === key);
  if (clash) Binds[clash] = Binds[action];
  Binds[action] = key;
  saveBinds();
}

export function bindLabel(key) {
  if (!key) return '--';
  if (key === ' ') return 'SPACE';
  if (key.length === 1) return key.toUpperCase();
  return key.toUpperCase();
}

export const Input = {
  keys: new Set(),
  pressed: new Set(),      // edge-triggered, cleared each frame
  released: new Set(),
  doubleTap: new Set(),    // edge-triggered double tap of a key
  lastTap: new Map(),      // key -> time of last keydown that could start a tap
  lastUp: new Map(),       // key -> time of last keyup
  mouse: { x: 0, y: 0, sx: 0, sy: 0, left: false, right: false },
  mouseDown: { left: false, right: false },   // edge
  mouseUp: { left: false, right: false },
  wheel: 0,
  typed: [],               // printable characters entered this frame
  captureText: false,      // when true, gameplay ignores keys and the UI reads typed
  time: 0,
  enabled: true,
  _view: null,
  // --- touch ---
  // Every touch is queued as an event and drained once per frame, so a tap
  // that begins and ends between two frames is still seen. touchLive carries
  // the latest sample of each finger still on the glass.
  touchQueue: [],
  touchLive: new Map(),
  touchSeen: false,        // sticky: this device has produced a touch at all
};

// A key press from a source other than the keyboard (the on-screen pad) walks
// exactly the same path a real key does, so double taps, holds and releases
// behave identically no matter where they came from.
function pressKey(k, typed) {
  if (Input.keys.has(k)) return;
  Input.keys.add(k);
  Input.pressed.add(k);
  if (typed) {
    if (k.length === 1) Input.typed.push(k);
    else if (k === 'Backspace' || k === 'Enter') Input.typed.push(k);
  }
  const now = Input.time;
  const lastDown = Input.lastTap.get(k) ?? -99;
  const lastUp = Input.lastUp.get(k) ?? -99;
  // The key really came back up. Equal stamps count: a tap fast enough to
  // land its press and release inside one frame shares a timestamp with them,
  // and that is a real double tap, not a held key.
  const released = lastUp >= lastDown;
  if (released && now - lastDown < DOUBLE_TAP_WINDOW) {
    Input.doubleTap.add(k);
    Input.lastTap.set(k, -99);   // a third tap needs a fresh pair
  } else {
    Input.lastTap.set(k, now);
  }
}

function releaseKey(k) {
  if (!Input.keys.has(k)) return;
  Input.keys.delete(k);
  Input.released.add(k);
  Input.lastUp.set(k, Input.time);
}

export function virtualKeyDown(k) { pressKey(k, false); }
export function virtualKeyUp(k) { releaseKey(k); }
// A press and release inside one frame: for buttons that only ever fire an
// edge, so nothing is left held if the finger is lost.
export function virtualKeyTap(k) { pressKey(k, false); releaseKey(k); }

// view = { canvas, toWorld(sx, sy) -> {x, y}, toView(sx, sy) -> {x, y} }
export function initInput(view) {
  loadBinds();
  Input._view = view;
  const el = view.canvas;

  addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['Tab', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    // e.repeat is the browser's auto-repeat flag; the keys.has check is the
    // backstop for platforms where it is not set reliably.
    // hidden debug chord
    if (e.ctrlKey && k === 'm') {
      e.preventDefault();
      if (!e.repeat) Input.pressed.add('ctrl+m');
      return;
    }
    if (e.repeat) return;
    pressKey(k, true);
  });

  addEventListener('keyup', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    releaseKey(k);
  });

  addEventListener('blur', () => {
    Input.keys.clear();
    Input.lastTap.clear();
    Input.lastUp.clear();
  });

  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('mousemove', (e) => {
    const r = el.getBoundingClientRect();
    Input.mouse.sx = e.clientX - r.left;
    Input.mouse.sy = e.clientY - r.top;
    const w = view.toWorld(Input.mouse.sx, Input.mouse.sy);
    Input.mouse.x = w.x;
    Input.mouse.y = w.y;
  });

  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) { Input.mouse.left = true; Input.mouseDown.left = true; }
    if (e.button === 2) { Input.mouse.right = true; Input.mouseDown.right = true; }
  });

  addEventListener('mouseup', (e) => {
    if (e.button === 0) { Input.mouse.left = false; Input.mouseUp.left = true; }
    if (e.button === 2) { Input.mouse.right = false; Input.mouseUp.right = true; }
  });

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    Input.wheel += Math.sign(e.deltaY);
  }, { passive: false });

  // --- touch ---------------------------------------------------------------
  // Sampled in three spaces at once: sx/sy are CSS pixels inside the canvas,
  // vx/vy are the 480x270 pixel grid the pad is laid out on, and wx/wy are
  // world coordinates so a touch can stand in for the mouse on the menus.
  const sample = (t) => {
    const r = el.getBoundingClientRect();
    const sx = t.clientX - r.left;
    const sy = t.clientY - r.top;
    const v = view.toView(sx, sy);
    const w = view.toWorld(sx, sy);
    return { id: t.identifier, sx, sy, vx: v.x, vy: v.y, wx: w.x, wy: w.y };
  };

  const push = (type) => (e) => {
    // preventDefault keeps the browser from scrolling, zooming, or firing a
    // second round of synthetic mouse events on top of every tap
    e.preventDefault();
    Input.touchSeen = true;
    for (const t of e.changedTouches) {
      const s = sample(t);
      if (type === 'end') Input.touchLive.delete(s.id);
      else Input.touchLive.set(s.id, s);
      Input.touchQueue.push({ type, ...s });
    }
    // the pad drains this every frame; the cap is only here so a stalled
    // frame cannot let a dragging finger grow the queue without bound
    if (Input.touchQueue.length > 512) Input.touchQueue.splice(0, Input.touchQueue.length - 512);
  };

  el.addEventListener('touchstart', push('start'), { passive: false });
  el.addEventListener('touchmove', push('move'), { passive: false });
  el.addEventListener('touchend', push('end'), { passive: false });
  el.addEventListener('touchcancel', push('end'), { passive: false });
}

export function inputTick(dt) { Input.time += dt; }

export function inputEndFrame() {
  Input.typed.length = 0;
  Input.pressed.clear();
  Input.released.clear();
  Input.doubleTap.clear();
  Input.mouseDown.left = Input.mouseDown.right = false;
  Input.mouseUp.left = Input.mouseUp.right = false;
  Input.wheel = 0;
}

export const key = (k) => Input.keys.has(k);
export const keyPressed = (k) => Input.pressed.has(k);

// Action-level queries. These are what gameplay code should use.
export const held = (action) => Input.keys.has(Binds[action]);
export const pressed = (action) => Input.pressed.has(Binds[action]);
export const doubleTapped = (action) => Input.doubleTap.has(Binds[action]);
export const keyDoubleTap = (k) => Input.doubleTap.has(k);
