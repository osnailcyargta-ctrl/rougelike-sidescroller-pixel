// Arena geometry and all gameplay tuning numbers in one place.
export const VIEW_W = 480;
export const VIEW_H = 270;
export const BLOCK = 16;

export const GRAVITY = 950;

export const GROUND_Y = 236;              // top surface of the floor

// One-way platforms: { x, y, w, h }. The 'drift' one slides along X and
// carries whatever is standing on it; dx is filled in each frame.
export const PLATFORMS = [
  { x: 40, y: 170, w: 96, h: 8, tag: 'left' },
  { x: VIEW_W - 136, y: 170, w: 96, h: 8, tag: 'right' },
  { x: VIEW_W / 2 - 32, y: 206, w: 64, h: 8, tag: 'center' },  // 4 blocks
  {
    x: VIEW_W / 2 - 32, y: 100, w: 64, h: 8, tag: 'drift', dx: 0,
    drift: { min: 96, max: VIEW_W - 160, speed: 42, dir: 1 },
  },
];

export const SPAWN_LEFT = { x: 88, y: 170 };
export const SPAWN_RIGHT = { x: VIEW_W - 88, y: 170 };
export const SPAWN_CENTER = { x: VIEW_W / 2, y: 206 };
export const DROP_POINT = { x: VIEW_W / 2, y: 206 };

export const PLAYER = {
  w: 10, h: 18,
  maxHp: 100,
  speed: 112,
  accel: 1100,
  airAccel: 700,
  friction: 1500,
  jumpVel: 372,
  dashSpeed: 300,
  dashTime: 0.16,
  dashCooldown: 0.55,
  slamVel: 640,
  slamDamage: 25,
  slamRadius: 46,
  invulnTime: 0.8,
  regenPerSecond: 1,        // natural regeneration
  dropTime: 0.22,
  punchDamage: 3,
};

export const SWORD = { range: 3 * BLOCK, damage: 10, cooldown: 0.45, arc: 1.05, swingTime: 0.22 };
// Thrown melee weapon: flies out five blocks, comes back, detonates on contact.
export const NUKERANG = {
  range: 5 * BLOCK,
  speed: 300,
  returnSpeed: 340,
  catchRadius: 11,
  cooldown: 0.18,
  windUp: 0.14,              // arm cocks back before the release
  catchTime: 0.22,           // reach-and-snap when it comes home
  spin: 22,                  // radians per second
  hitDamage: 14,             // small blast
  hitRadius: 24,
  bigDamage: 28,             // every third blast
  bigRadius: 48,
  bigEvery: 3,
  reHitDelay: 0.35,          // per-enemy, so one enemy cannot chain-detonate it
};

export const BOW = {
  range: 10 * BLOCK, damage: 5, ammo: 10, reload: 2.0, cooldown: 0.4, speed: 340,
};

// Regular enemies stay at their base stats through the first five rooms, then
// step up once every two rooms from room 6 on.
export const ROOM_SCALING = {
  startRoom: 6,
  everyRooms: 2,
  hpPerStep: 0.18,        // +18% max HP per step
  damagePerStep: 0.12,    // +12% damage per step
  bossHpPerTier: 0.40,    // +40% boss HP per boss room after the first
  bossDamagePerTier: 0.25,
};

// How many scaling steps a given room has earned.
export function roomScaleSteps(room) {
  const { startRoom, everyRooms } = ROOM_SCALING;
  if (room < startRoom) return 0;
  return Math.floor((room - startRoom) / everyRooms) + 1;
}

export const BOSS_ROOM_INTERVAL = 5;   // rooms 5, 10, 15 ... get a third wave

export const ENEMY_TYPES = {
  grunt: {
    id: 'grunt', name: 'Ghoul', hp: 80, speed: 52, damage: 12, w: 12, h: 17,
    attackCooldown: 0.9, attackRange: 16, knockback: 120,
  },
  brute: {
    id: 'brute', name: 'Brute', hp: 80, speed: 32, damage: 20, w: 18, h: 22,
    attackCooldown: 1.4, attackRange: 20, knockback: 190, chargeSpeed: 150,
  },
  stinger: {
    id: 'stinger', name: 'Stinger', hp: 80, speed: 60, damage: 10, w: 13, h: 12,
    attackCooldown: 1.8, attackRange: 150, flying: true, projectileSpeed: 150,
  },
  // Stalks just out of reach, then commits to a long telegraphed lunge.
  lurker: {
    id: 'lurker', name: 'Lurker', hp: 80, speed: 44, damage: 15, w: 13, h: 15,
    attackCooldown: 1.6, attackRange: 96, knockback: 140,
    windUp: 0.5, lungeSpeed: 330, lungeTime: 0.3, standOff: 74,
  },
  // Artillery: holds its ground and lobs acid over platforms.
  spitter: {
    id: 'spitter', name: 'Spitter', hp: 80, speed: 26, damage: 16, w: 16, h: 16,
    attackCooldown: 2.2, attackRange: 210, knockback: 90,
    standOff: 120, projectileSpeed: 190, windUp: 0.45,
  },
  // Boss parts live in the normal enemy list so every existing hit test works.
  golemBody: {
    id: 'golemBody', name: 'Aether Golem', hp: 600, speed: 0, damage: 18, w: 48, h: 60,
    attackCooldown: 1, attackRange: 30, boss: true,
  },
  golemHead: {
    id: 'golemHead', name: 'Golem Head', hp: 600, speed: 88, damage: 16, w: 32, h: 27,
    attackCooldown: 1, attackRange: 240, flying: true, boss: true,
  },
  wormHead: {
    id: 'wormHead', name: 'Big Dude', hp: 600, speed: 0, damage: 34, w: 30, h: 30,
    attackCooldown: 1, attackRange: 20, boss: true,
  },
  wormBody: {
    id: 'wormBody', name: 'Big Dude', hp: 600, speed: 0, damage: 18, w: 22, h: 22,
    attackCooldown: 1, attackRange: 20, boss: true,
  },
};

// The golem. Phase 2 begins the moment its shared HP pool drops to phase2Hp.
export const BOSS_TYPES = {
  golem: {
    id: 'golem', name: 'Aether Golem', short: 'Golem', kind: 'lasers',
    hp: 600, phase2Hp: 280,
    bodyW: 48, bodyH: 60, headW: 32, headH: 27,
    contactDamage: 18,
    smallLaser: { count: 4, interval: 0.2, speed: 250, damage: 12, windUp: 0.45 },
    bigLaser: { duration: 2.0, shortDuration: 1.0, lag: 0.3, damage: 22, width: 5, windUp: 0.6 },
    slam: { jumpVel: 470, fallAccel: 2200, damage: 26, radius: 92, windUp: 0.4 },
    dash: { speed: 290, time: 0.55, damage: 24, windUp: 0.45 },
    headSpeed: 88, headHover: 74,
    attackDelay: 3.0,   // pause between one attack ending and the next starting
  },
  // A twenty-block worm that lives under the floor and only surfaces to strike.
  bigdude: {
    id: 'bigdude', name: 'Big Dude', short: 'Big Dude', kind: 'worm',
    hp: 600,
    segments: 20, segSpacing: 16,   // 20 blocks of body
    headR: 15, bodyR: 11, tailR: 4,
    headDamage: 34, bodyDamage: 18,
    burrowDepth: 46,                // how far under the floor it cruises
    burrowSpeed: 150,
    leapUp: 585, leapAcross: 165, leapGravity: 900,
    buriedTime: 3.0, waitTime: 2.0,
    spitCount: 20, spitDamage: 12, spitSpeed: 205, spitSpread: 1.25,
  },
};

export const PERK = {
  aegisShield: 20,          // absorb per Aegis Shard
  aegisRegenDelay: 5.0,     // seconds without damage before it refills
  aegisRegenRate: 12,       // absorb per second once refilling
  bloodstoneHits: 5,        // hits needed for a Bloodstone proc
  bloodstoneHeal: 3,        // HP for the first stack
  bloodstoneStackHeal: 2,   // extra HP per additional stack
  lifeCrystalHp: 10,
  lifeCrystalMaxStacks: 5,
  burnChance: 0.33,
  burnDuration: 3.0,
  burnTick: 0.1,
  burnTickDamage: 1,
  markDuration: 5.0,
  chainCooldown: 0.75,
  chainDamage: 8,
  electrifiedDuration: 4.5,
  electrifiedDamage: 10,
  electrifiedIntervalMin: 1.2,
  electrifiedIntervalMax: 1.5,
  slimeInterval: 2.0,
  slimeSlow: 0.30,
  slimeSlowDuration: 1.5,
  slimeSpeed: 190,
};

export const WAVES = {
  perRoom: 2,
  bossRoomWaves: 3,
  interWaveDelay: 1.6,
  spawnStagger: 0.45,
};
