// Visual theme. A user shader pack (.shdr) may override any of these values
// through its JSON header, which is how "the whole look" can be swapped.
export const DEFAULT_THEME = {
  name: 'Aether Depths',
  bgFar: '#10101f',
  bgMid: '#171a2e',
  bgNear: '#1e2340',
  fog: '#2a3157',
  ground: '#2c2f4a',
  groundTop: '#4a5480',
  groundEdge: '#78e0ff',
  platform: '#333a5c',
  platformTop: '#5f6ca0',
  platformGlow: '#7ad7ff',
  player: '#e8f4ff',
  playerDark: '#7f9bd0',
  playerAccent: '#ffd76a',
  cloth: '#3f6ecb',
  clothDark: '#27407d',
  skin: '#f0c39a',
  steel: '#dfe9ff',
  steelDark: '#8fa2c9',
  enemyGrunt: '#c0507a',
  enemyBrute: '#8b5cf6',
  enemyStinger: '#3fd6a6',
  enemyDark: '#20142c',
  eye: '#fff3b0',
  fire: '#ff9d3c',
  fireHot: '#fff0a0',
  spark: '#ffe9a8',
  blood: '#ff5470',
  lightning: '#9ff0ff',
  slime: '#7cff8f',
  ui: '#dff3ff',
  uiDim: '#7f92b8',
  uiAccent: '#ffd76a',
  uiPanel: '#141a30',
  hp: '#ff5470',
  hpBack: '#3a1030',
  star: '#9ad8ff',
  // Post-processing knobs (used by the WebGL pass)
  bloomStrength: 1.0,
  bloomThreshold: 0.62,
  vignette: 0.55,
  chroma: 0.35,
  scanline: 0.18,
  saturation: 1.06,
  // Gameplay-neutral animation knobs
  animSpeed: 1.0,
  wobble: 1.0,
  trail: 1.0,
};

export const Theme = { ...DEFAULT_THEME };

export function applyTheme(overrides = {}) {
  Object.assign(Theme, DEFAULT_THEME);
  for (const k of Object.keys(overrides)) {
    if (k in Theme) Theme[k] = overrides[k];
  }
}

export function resetTheme() { applyTheme({}); }
