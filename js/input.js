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
  // --- mobile touch input ---
  touches: new Map(),      // touch id -> { x, y, sx, sy, startX, startY, startTime }
  leftJoystick: { x: 0, y: 0, active: false, touchId: null },
  rightJoystick: { x: 0, y: 0, active: false, touchId: null },
  mobileButtons: new Map(), // button id -> { pressed, justPressed, touchId, sx, sy, r }
  mobileSwipes: [],        // { direction, time }
};

// view = { canvas, toWorld(sx, sy) -> {x, y} }
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
    if (e.repeat || Input.keys.has(k)) return;
    Input.keys.add(k);
    Input.pressed.add(k);
    if (k.length === 1) Input.typed.push(k);
    else if (k === 'Backspace' || k === 'Enter') Input.typed.push(k);
    const now = Input.time;
    const lastDown = Input.lastTap.get(k) ?? -99;
    const lastUp = Input.lastUp.get(k) ?? -99;
    const released = lastUp > lastDown;   // the key really came back up
    if (released && now - lastDown < DOUBLE_TAP_WINDOW) {
      Input.doubleTap.add(k);
      Input.lastTap.set(k, -99);   // a third tap needs a fresh pair
    } else {
      Input.lastTap.set(k, now);
    }
  });

  addEventListener('keyup', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    Input.keys.delete(k);
    Input.released.add(k);
    Input.lastUp.set(k, Input.time);
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

  // --- touch events for mobile ---
  el.addEventListener('touchstart', (e) => {
    for (const touch of e.touches) {
      const r = el.getBoundingClientRect();
      const sx = touch.clientX - r.left;
      const sy = touch.clientY - r.top;
      const w = view.toWorld(sx, sy);
      Input.touches.set(touch.identifier, {
        x: w.x, y: w.y, sx, sy, startX: w.x, startY: w.y, startTime: Input.time,
      });
    }
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    for (const touch of e.touches) {
      const r = el.getBoundingClientRect();
      const sx = touch.clientX - r.left;
      const sy = touch.clientY - r.top;
      const w = view.toWorld(sx, sy);
      const t = Input.touches.get(touch.identifier);
      if (t) {
        t.x = w.x;
        t.y = w.y;
        t.sx = sx;
        t.sy = sy;
      }
    }
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    for (const touch of e.changedTouches) {
      Input.touches.delete(touch.identifier);
    }
  }, { passive: true });
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
  // clear mobile button presses
  for (const btn of Input.mobileButtons.values()) btn.justPressed = false;
}

export function initMobileButtons(buttons) {
  for (const b of buttons) {
    Input.mobileButtons.set(b.id, { pressed: false, justPressed: false, touchId: null, sx: b.sx, sy: b.sy, r: b.r });
  }
}

export function updateMobileInput(canvas) {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();

  // update joystick states based on active touches
  Input.leftJoystick.active = false;
  Input.rightJoystick.active = false;
  Input.leftJoystick.x = 0;
  Input.leftJoystick.y = 0;
  Input.rightJoystick.x = 0;
  Input.rightJoystick.y = 0;

  // mark all buttons as not pressed, but preserve touchId for touch continuation
  const buttons = Array.from(Input.mobileButtons.values());
  for (const btn of buttons) {
    const wasPressed = btn.pressed;
    btn.pressed = false;
    btn.justPressed = false;
    // if button was pressed with a touch that no longer exists, clear touchId
    if (btn.touchId && !Input.touches.has(btn.touchId)) {
      btn.touchId = null;
    }
  }

  // process touches
  for (const [tid, touch] of Input.touches) {
    // check which joystick/button this touch is affecting
    let hitButton = false;
    for (const btn of buttons) {
      const dx = touch.sx - btn.sx;
      const dy = touch.sy - btn.sy;
      if (Math.hypot(dx, dy) <= btn.r) {
        btn.pressed = true;
        if (!btn.touchId) {
          btn.justPressed = true;
          btn.touchId = tid;
        }
        hitButton = true;
        break;
      }
    }

    if (!hitButton) {
      // check joysticks - left is canvas left third, right is canvas right third
      const canvasW = r.width;
      if (touch.sx < canvasW / 3) {
        // left joystick
        Input.leftJoystick.active = true;
        Input.leftJoystick.touchId = tid;
        Input.leftJoystick.x = (touch.x - touch.startX) / 30;
        Input.leftJoystick.y = (touch.y - touch.startY) / 30;
      } else if (touch.sx > (2 * canvasW) / 3) {
        // right joystick
        Input.rightJoystick.active = true;
        Input.rightJoystick.touchId = tid;
        Input.rightJoystick.x = (touch.x - touch.startX) / 30;
        Input.rightJoystick.y = (touch.y - touch.startY) / 30;
      }
    }
  }

  // detect double-swipes for dash
  const now = Input.time;
  const swipeThreshold = 0.2; // 200ms window for double swipe
  Input.mobileSwipes = Input.mobileSwipes.filter((s) => now - s.time < swipeThreshold);
}

export function detectMobileSwipe(direction) {
  const now = Input.time;
  const existing = Input.mobileSwipes.filter((s) => s.direction === direction && now - s.time < 0.2);
  if (existing.length > 0) {
    // double swipe detected
    Input.mobileSwipes = Input.mobileSwipes.filter((s) => s.direction !== direction);
    return true;
  }
  Input.mobileSwipes.push({ direction, time: now });
  return false;
}

export const key = (k) => Input.keys.has(k);
export const keyPressed = (k) => Input.pressed.has(k);

// Action-level queries. These are what gameplay code should use.
export const held = (action) => Input.keys.has(Binds[action]);
export const pressed = (action) => Input.pressed.has(Binds[action]);
export const doubleTapped = (action) => Input.doubleTap.has(Binds[action]);
export const keyDoubleTap = (k) => Input.doubleTap.has(k);
