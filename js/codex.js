// The bestiary: one page per boss, in the order you meet them, with what it
// takes to bring each one out and what it costs you when it arrives.
//
// Nothing here is discovered - the whole list is readable from the start, so
// you can plan a run - except the tick beside a name, which is the one thing
// you have to earn. That is kept in localStorage, so it survives a death.
import { BOSS_TYPES, CEILING_ROOM, FINAL_ROOM } from './config.js';

const STORE = 'aether.codex.v1';

// How each portrait is framed: the world point to put in the middle of the
// box, and how much to shrink it by. Tuned by eye against the real sprites.
export const CODEX_VIEW = {
  golem: [{ zoom: 0.72, cx: 240, cy: 206 }, { zoom: 0.55, cx: 240, cy: 196 }],
  bigdude: [{ zoom: 0.46, cx: 212, cy: 178 }],
  ceiling: [{ zoom: 0.44, cx: 240, cy: 28 }],
  alphads: [{ zoom: 0.9, cx: 240, cy: 88 }],
  poitnus: [{ zoom: 0.62, cx: 262, cy: 76 }],
};

export function codexView(id, phase) {
  const v = CODEX_VIEW[id] ?? [{ zoom: 1, cx: 240, cy: 135 }];
  return v[Math.min(phase - 1, v.length - 1)];
}

export const CODEX_ORDER = ['golem', 'bigdude', 'ceiling', 'alphads', 'poitnus'];

// Everything the pages say that is not already in BOSS_TYPES. Damage lines are
// worked out from the boss's own numbers rather than typed twice, so tuning a
// fight cannot leave the book lying about it.
export const CODEX = {
  golem: {
    where: `ROOM ${5}`,
    spawn: ['Clear the third wave of the', 'first boss room.'],
    damage: (d, k) => [
      ['CONTACT', d.contactDamage * k],
      ['LASER', d.smallLaser.damage * k],
      ['BEAM', d.bigLaser.damage * k],
      ['SLAM', d.slam.damage * k],
      ['DASH', d.dash.damage * k],
    ],
    drops: ['1-2 Soul', 'A choice of two perks', 'Nukerang, once'],
    phases: ['Whole: it walks, hops and fires', 'from the body. Split: the head', 'tears loose and hunts alone.'],
  },
  bigdude: {
    where: `ROOM ${10}`,
    spawn: ['Clear the third wave of the', 'second boss room.'],
    damage: (d, k) => [
      ['HEAD', d.headDamage * k],
      ['BODY', d.bodyDamage * k],
      ['SPIT', d.spitDamage * k],
    ],
    drops: ['1-2 Soul', 'Paper Missile Tutor, once', 'A choice of two perks'],
    phases: ['Twenty blocks of worm that', 'only surfaces to strike.'],
  },
  ceiling: {
    where: `ROOM ${CEILING_ROOM}`,
    spawn: ['Clear the third wave of', 'room 15.'],
    damage: (d, k) => [
      ['EYE BEAM', d.laser.damage * k],
      ['BEAM TICK', d.laser.tickDamage * k],
      ['HANDS', d.hand.damage * k],
      ['CRUSH', 'LETHAL'],
    ],
    drops: ['1-2 Soul', 'Damage Booster'],
    phases: ['It is the roof. Kill it inside two', 'and a half minutes or it comes', 'down on you.'],
  },
  alphads: {
    where: `ROOM ${FINAL_ROOM}`,
    spawn: ['Clear the third wave of the last', 'room. There is no room past it.'],
    damage: (d, k) => [
      ['ARROW', d.shot.damage * k],
      ['RAIN', d.shot.damage * k],
      ['GOD RAY', d.godRay.damage * k],
      ['SHOCK WAVE', d.godRay.waveDamage * k],
    ],
    drops: ['Nothing. The run ends here.'],
    phases: ['It never lands and it never stops.', 'Five attacks, always in the', 'same order.'],
  },
  poitnus: {
    where: 'ANY ROOM',
    spawn: ['Forge a Gigantic Stinger Egg at', 'an anvil, stand on the centre', 'platform and attack.'],
    damage: (d, k) => [
      ['CONTACT', d.contactDamage * k],
      ['STINGER', d.volley.damage * k],
    ],
    drops: ['1-2 Soul'],
    phases: ['Three fans of five, then it', 'hangs still and lays. Never', 'more than 10 of its brood at once.'],
  },
};

// --- what you have actually killed ---------------------------------------

export const Defeated = new Set();

export function loadCodex() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved)) for (const id of saved) if (CODEX[id]) Defeated.add(id);
  } catch { /* storage blocked; an empty book is fine */ }
}

export function markBossDefeated(id) {
  if (!CODEX[id] || Defeated.has(id)) return false;
  Defeated.add(id);
  try { localStorage.setItem(STORE, JSON.stringify([...Defeated])); } catch { /* ignore */ }
  return true;
}

export function resetCodex() {
  Defeated.clear();
  try { localStorage.removeItem(STORE); } catch { /* ignore */ }
}

// --- page contents --------------------------------------------------------

// The numbers a page shows, pulled from the live config every time it is
// opened rather than copied into this file.
export function codexEntry(id) {
  const def = BOSS_TYPES[id];
  const e = CODEX[id];
  if (!def || !e) return null;
  const k = def.dmgScale ?? 1;
  const damage = e.damage(def, k).map(([label, v]) => [
    label, typeof v === 'number' ? String(Math.round(v)) : v,
  ]);
  return {
    id,
    name: def.name,
    title: def.title ?? '',
    hp: def.hp,
    where: e.where,
    spawn: e.spawn,
    drops: e.drops,
    phases: e.phases,
    damage,
    twoPhases: (def.phase2Hp ?? 0) > 0,
    beaten: Defeated.has(id),
  };
}
