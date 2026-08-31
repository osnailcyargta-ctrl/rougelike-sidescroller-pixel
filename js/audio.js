// Tiny procedural SFX. No assets, everything is synthesised on demand.
let ctx = null;
let master = null;
export const AudioCfg = { volume: 0.5, muted: false };

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = AudioCfg.volume;
  master.connect(ctx.destination);
  return ctx;
}

export function resumeAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
}

export function setVolume(v) {
  AudioCfg.volume = v;
  if (master) master.gain.value = AudioCfg.muted ? 0 : v;
}

function tone({ type = 'square', f0 = 440, f1 = f0, dur = 0.12, vol = 0.3, delay = 0 }) {
  const c = ensure();
  if (!c || AudioCfg.muted) return;
  const t = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise({ dur = 0.2, vol = 0.25, freq = 1200, q = 1, delay = 0 }) {
  const c = ensure();
  if (!c || AudioCfg.muted) return;
  const t = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = freq;
  filt.Q.value = q;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(filt).connect(g).connect(master);
  src.start(t);
}

export const Sfx = {
  swing: () => noise({ dur: 0.14, vol: 0.18, freq: 900, q: 0.7 }),
  hit: () => { tone({ type: 'square', f0: 320, f1: 90, dur: 0.09, vol: 0.22 }); noise({ dur: 0.09, vol: 0.2, freq: 2200 }); },
  bow: () => tone({ type: 'triangle', f0: 900, f1: 240, dur: 0.12, vol: 0.16 }),
  reload: () => { tone({ type: 'square', f0: 200, f1: 400, dur: 0.08, vol: 0.12 }); tone({ type: 'square', f0: 300, f1: 620, dur: 0.09, vol: 0.12, delay: 0.14 }); },
  dash: () => noise({ dur: 0.22, vol: 0.16, freq: 500, q: 0.5 }),
  slam: () => { tone({ type: 'sawtooth', f0: 180, f1: 40, dur: 0.35, vol: 0.3 }); noise({ dur: 0.3, vol: 0.28, freq: 300, q: 0.4 }); },
  jump: () => tone({ type: 'square', f0: 300, f1: 620, dur: 0.1, vol: 0.13 }),
  hurt: () => tone({ type: 'sawtooth', f0: 260, f1: 70, dur: 0.24, vol: 0.24 }),
  die: () => { tone({ type: 'sawtooth', f0: 420, f1: 60, dur: 0.4, vol: 0.22 }); noise({ dur: 0.35, vol: 0.2, freq: 700 }); },
  pickup: () => { tone({ type: 'triangle', f0: 620, f1: 900, dur: 0.1, vol: 0.18 }); tone({ type: 'triangle', f0: 900, f1: 1300, dur: 0.12, vol: 0.16, delay: 0.09 }); },
  zap: () => { tone({ type: 'sawtooth', f0: 1400, f1: 300, dur: 0.18, vol: 0.18 }); noise({ dur: 0.16, vol: 0.18, freq: 3200, q: 2 }); },
  slime: () => tone({ type: 'sine', f0: 500, f1: 160, dur: 0.16, vol: 0.14 }),
  ui: () => tone({ type: 'square', f0: 560, f1: 760, dur: 0.06, vol: 0.12 }),
  wave: () => { tone({ type: 'square', f0: 300, f1: 500, dur: 0.16, vol: 0.16 }); tone({ type: 'square', f0: 500, f1: 760, dur: 0.22, vol: 0.16, delay: 0.16 }); },
};
