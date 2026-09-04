// Frame budget. A weak phone runs out of fill rate long before it runs out of
// javascript, so the levers here are, in order of what they actually cost:
//
//   1. the composite pass, which runs a fairly busy shader once per DISPLAY
//      pixel. The source is only 480x270, so rendering it at three or four
//      device pixels per source pixel buys nothing you can see and costs
//      fill rate linearly. This is the first thing to give up.
//   2. the glow behind every particle, which is a fresh radial gradient per
//      particle per frame on the 2D canvas.
//   3. the number of particles at all.
//   4. the bloom blur iterations, which are cheap by comparison - the bloom
//      buffers are quarter size - but free to trim.
//
// The tier is chosen by watching real frame times rather than by sniffing the
// device, because the thing we actually care about is whether THIS phone is
// keeping up, and no user agent string will tell you that.
import { Options } from './settings.js';

export const TIERS = [
  // Minimum: the post chain is switched off entirely and the pixel canvas is
  // shown as it is. That is not just "fewer effects" - it removes the frame's
  // single most expensive step, handing the finished 2D canvas to the GPU as
  // a texture, which profiling puts at around 40% of the work on a slow
  // device. Nothing else on the list comes close.
  { name: 'LOW', postfx: false, pixelCap: 1.0, blurIters: 1, particleScale: 0.35, particleCap: 260, glowParticles: false },
  // reduced: keeps the look, loses the excess
  { name: 'MID', postfx: true, pixelCap: 1.5, blurIters: 2, particleScale: 0.65, particleCap: 500, glowParticles: true },
  // full
  { name: 'HIGH', postfx: true, pixelCap: 2.0, blurIters: 3, particleScale: 1.0, particleCap: 900, glowParticles: true },
];

export const Perf = {
  tier: TIERS.length - 1,
  auto: true,            // false once the player forces a tier by hand
  lowered: false,        // the watchdog dropped us, so it may raise us again
  fps: 0,
  ...TIERS[TIERS.length - 1],
};

// Windows of real time, so the judgement is about wall clock and not frames.
//
// The recovery threshold has to sit ABOVE the display's frame period, not
// below it: rendering is vsync locked, so on a 60Hz screen a game with plenty
// of headroom still reads 16.7ms and can never look "fast" by a stricter
// measure. Asking for less than that means the quality can only ever fall.
const WINDOW = 1.0;
const SLOW_MS = 21;      // below ~48fps: the player feels this as stutter
// Below ~30fps the middle tier is not worth walking through: it still pays
// for the post chain, which is the expensive part, so its worst frames are
// barely better than full quality. Go straight to the one that turns it off.
const VERY_SLOW_MS = 33;
// Climbing back needs proof of HEADROOM, and the frame interval cannot give
// it: rendering is vsync locked, so a frame that took 4ms of work and one
// that took 16 both read as 16.7ms on a 60Hz screen. So the recovery test
// watches how long the frame's work actually takes, which is not capped by
// anything, and asks for it to fit comfortably inside a 60fps budget.
const HEADROOM_MS = 8;
const SETTLE = 1.5;      // ignore the frames right after a change or a boot
const CLIMB_GRACE = 8;   // a climb that gets undone this soon was a mistake
const MAX_CLIMB_FAILS = 2;

let acc = 0, frames = 0, work = 0, strikes = 0, good = 0, settle = SETTLE;
let sinceClimb = Infinity, climbFails = 0;

function apply(i) {
  Perf.tier = i;
  Object.assign(Perf, TIERS[i]);
}

// Called when the player flips the manual switch, and once at boot.
export function syncPerfOptions() {
  if (Options.lowPower) {
    Perf.auto = false;
    Perf.lowered = false;
    climbFails = 0;
    if (Perf.tier !== 0) { apply(0); return true; }
    return false;
  }
  if (!Perf.auto) {
    // coming back off the manual switch: start from full and let the
    // watchdog find the right tier again
    Perf.auto = true;
    Perf.lowered = false;
    climbFails = 0;
    sinceClimb = Infinity;
    settle = SETTLE;
    if (Perf.tier !== TIERS.length - 1) { apply(TIERS.length - 1); return true; }
  }
  return false;
}

// Returns the new tier when it changed this frame, or null. The caller has to
// resize the display when it does, because pixelCap moved.
export function perfTick(dt, workMs = 0) {
  if (dt > 0) Perf.fps = Perf.fps ? Perf.fps + (1 / dt - Perf.fps) * 0.08 : 1 / dt;
  if (!Perf.auto) return null;
  if (settle > 0) { settle -= dt; return null; }

  // a single long frame is a hitch, not a trend: only the window average counts
  acc += Math.min(dt, 0.25);
  work += Math.min(workMs, 250);
  frames++;
  sinceClimb += dt;
  if (acc < WINDOW) return null;
  const avg = (acc / frames) * 1000;
  const workAvg = work / frames;
  acc = 0; frames = 0; work = 0;

  if (avg > SLOW_MS) {
    good = 0;
    if (++strikes >= 2 && Perf.tier > 0) {
      const drop = avg > VERY_SLOW_MS ? Perf.tier : 1;
      strikes = 0;
      settle = SETTLE;
      // if we only just climbed into this tier and it already cannot hold,
      // that climb was wrong - stop trying after a couple of those, rather
      // than seesawing for the rest of the session
      if (sinceClimb < CLIMB_GRACE) climbFails++;
      sinceClimb = Infinity;
      Perf.lowered = true;
      apply(Perf.tier - drop);
      return Perf.tier;
    }
  } else if (workAvg > 0 && workAvg < HEADROOM_MS) {
    strikes = 0;
    // only climb back toward where we started, and only after a long clean
    // run, so a quiet moment cannot bounce the quality around mid-fight
    if (Perf.lowered && climbFails < MAX_CLIMB_FAILS
        && ++good >= 6 && Perf.tier < TIERS.length - 1) {
      good = 0;
      settle = SETTLE;
      sinceClimb = 0;
      apply(Perf.tier + 1);
      if (Perf.tier === TIERS.length - 1) Perf.lowered = false;
      return Perf.tier;
    }
  } else {
    strikes = 0;
    good = 0;
  }
  return null;
}
