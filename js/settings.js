// Everything the player can turn on, off or slide, plus the code that keeps it
// all in localStorage so a reload does not throw their setup away.
//
// Two groups: INDICATORS are readouts (numbers, ranges, counters) and VISUALS
// are look-and-feel. Key bindings live in input.js and save themselves.
import { Theme, DEFAULT_THEME } from './theme.js';

const KEY = 'aether.options.v1';
const SHADER_KEY = 'aether.shader.v1';

// name -> { label, group, type, default, min, max, help }
export const OPTION_DEFS = [
  // --- touch controls
  { id: 'mobileControls', label: 'ON-SCREEN CONTROLS', group: 'touch', type: 'bool', def: false },
  { id: 'touchScale', label: 'PAD SIZE', group: 'touch', type: 'range', def: 1.0, max: 1.5 },
  { id: 'touchOpacity', label: 'PAD OPACITY', group: 'touch', type: 'range', def: 0.6, max: 1 },
  { id: 'lowPower', label: 'LOW POWER MODE', group: 'touch', type: 'bool', def: false },

  // --- indicators
  { id: 'showFps', label: 'SHOW FPS', group: 'indicator', type: 'bool', def: false },
  { id: 'showRange', label: 'SHOW WEAPON RANGE', group: 'indicator', type: 'bool', def: false },
  { id: 'showEnemyHpNum', label: 'ENEMY HP NUMBERS', group: 'indicator', type: 'bool', def: false },
  { id: 'showBossHpNum', label: 'BOSS HP NUMBERS', group: 'indicator', type: 'bool', def: true },
  { id: 'showDamage', label: 'DAMAGE NUMBERS', group: 'indicator', type: 'bool', def: true },
  { id: 'showEnemyHpBars', label: 'ENEMY HP BARS', group: 'indicator', type: 'bool', def: true },
  { id: 'showWaveCounter', label: 'WAVE COUNTER', group: 'indicator', type: 'bool', def: true },
  { id: 'showReticle', label: 'AIM RETICLE', group: 'indicator', type: 'bool', def: true },
  { id: 'showCooldown', label: 'ATTACK COOLDOWN RING', group: 'indicator', type: 'bool', def: true },
  { id: 'showBossTimer', label: 'BOSS ENRAGE TIMER', group: 'indicator', type: 'bool', def: true },

  // --- visuals
  { id: 'bloom', label: 'BLOOM', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'scanline', label: 'SCANLINES', group: 'visual', type: 'range', def: 0.18, max: 1 },
  { id: 'vignette', label: 'VIGNETTE', group: 'visual', type: 'range', def: 0.55, max: 1 },
  { id: 'chroma', label: 'CHROMATIC SPLIT', group: 'visual', type: 'range', def: 0.35, max: 1 },
  { id: 'saturation', label: 'SATURATION', group: 'visual', type: 'range', def: 1.06, max: 2 },
  { id: 'grain', label: 'FILM GRAIN', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'halation', label: 'HALATION', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'shake', label: 'SCREEN SHAKE', group: 'visual', type: 'range', def: 0.42, max: 1 },
  { id: 'flash', label: 'FLASH STRENGTH', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'particles', label: 'PARTICLE DENSITY', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'trails', label: 'TRAILS', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'shafts', label: 'LIGHT SHAFTS', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'animSpeed', label: 'ANIMATION SPEED', group: 'visual', type: 'range', def: 1.0, max: 2 },
  { id: 'volume', label: 'VOLUME', group: 'visual', type: 'range', def: 0.5, max: 1 },
];

const DEFAULTS = {};
for (const d of OPTION_DEFS) DEFAULTS[d.id] = d.def;

export const Options = { ...DEFAULTS };

export function optionsIn(group) { return OPTION_DEFS.filter((d) => d.group === group); }

export function loadOptions() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const d of OPTION_DEFS) {
        const v = saved[d.id];
        if (d.type === 'bool' && typeof v === 'boolean') Options[d.id] = v;
        if (d.type === 'range' && typeof v === 'number' && Number.isFinite(v)) {
          Options[d.id] = Math.min(d.max ?? 1, Math.max(0, v));
        }
      }
    }
  } catch { /* storage blocked; defaults are fine */ }
  return Options;
}

let saveTimer = 0;
export function saveOptions() {
  // slider drags fire every frame, so coalesce the writes
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(Options)); } catch { /* ignore */ }
  }, 250);
}

export function resetOptions() {
  Object.assign(Options, DEFAULTS);
  saveOptions();
}

// --- shader packs ---------------------------------------------------------
// The whole .shdr text is kept, so the pack is reapplied on the next boot
// exactly as it was loaded.

export function saveShader(name, text) {
  try {
    if (!text) localStorage.removeItem(SHADER_KEY);
    else localStorage.setItem(SHADER_KEY, JSON.stringify({ name, text }));
  } catch { /* ignore */ }
}

export function loadShader() {
  try {
    const raw = localStorage.getItem(SHADER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.text === 'string' ? v : null;
  } catch { return null; }
}

// A shader pack sets the baseline for the visual sliders; the player's own
// values then ride on top of it. Called whenever a pack is applied or reset.
export const ShaderBase = {
  bloomStrength: DEFAULT_THEME.bloomStrength,
  scanline: DEFAULT_THEME.scanline,
  vignette: DEFAULT_THEME.vignette,
  chroma: DEFAULT_THEME.chroma,
  saturation: DEFAULT_THEME.saturation,
  animSpeed: DEFAULT_THEME.animSpeed,
  trail: DEFAULT_THEME.trail,
};

export function captureShaderBase() {
  ShaderBase.bloomStrength = Theme.bloomStrength;
  ShaderBase.scanline = Theme.scanline;
  ShaderBase.vignette = Theme.vignette;
  ShaderBase.chroma = Theme.chroma;
  ShaderBase.saturation = Theme.saturation;
  ShaderBase.animSpeed = Theme.animSpeed;
  ShaderBase.trail = Theme.trail;
}

// Push the player's visual settings into the live theme. The sliders are
// multipliers on whatever the current pack asked for, except the ones the
// player expects to be absolute.
export function applyVisualOptions() {
  Theme.bloomStrength = ShaderBase.bloomStrength * Options.bloom;
  Theme.scanline = Options.scanline;
  Theme.vignette = Options.vignette;
  Theme.chroma = Options.chroma;
  Theme.saturation = Options.saturation;
  Theme.animSpeed = ShaderBase.animSpeed * Options.animSpeed;
  Theme.trail = ShaderBase.trail * Options.trails;
}
