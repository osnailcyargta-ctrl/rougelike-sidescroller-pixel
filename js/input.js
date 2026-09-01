// Keyboard / mouse state. Double-tap detection lives here so gameplay code
// only has to ask "did a dash / slam get requested this frame?".
// A double tap is two SEPARATE presses of the same key inside this window,
// with a real release in between. Auto-repeat from a held key, and any keydown
// that arrives while the key is already down, are both discarded - holding a
// key can never produce a double tap.
const DOUBLE_TAP_WINDOW = 0.28;

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
  time: 0,
  enabled: true,
  _view: null,
};

// view = { canvas, toWorld(sx, sy) -> {x, y} }
export function initInput(view) {
  Input._view = view;
  const el = view.canvas;

  addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['Tab', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    // e.repeat is the browser's auto-repeat flag; the keys.has check is the
    // backstop for platforms where it is not set reliably.
    if (e.repeat || Input.keys.has(k)) return;
    Input.keys.add(k);
    Input.pressed.add(k);
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
}

export function inputTick(dt) { Input.time += dt; }

export function inputEndFrame() {
  Input.pressed.clear();
  Input.released.clear();
  Input.doubleTap.clear();
  Input.mouseDown.left = Input.mouseDown.right = false;
  Input.mouseUp.left = Input.mouseUp.right = false;
  Input.wheel = 0;
}

export const key = (k) => Input.keys.has(k);
export const keyPressed = (k) => Input.pressed.has(k);
export const keyDoubleTap = (k) => Input.doubleTap.has(k);
