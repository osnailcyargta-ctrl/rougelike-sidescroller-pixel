// Arena geometry and all gameplay tuning numbers in one place.
export const VIEW_W = 480;
export const VIEW_H = 270;
export const BLOCK = 16;

export const GRAVITY = 950;

export const GROUND_Y = 236;              // top surface of the floor

// One-way platforms: { x, y, w, h }
export const PLATFORMS = [
  { x: 40, y: 170, w: 96, h: 8, tag: 'left' },
  { x: VIEW_W - 136, y: 170, w: 96, h: 8, tag: 'right' },
  { x: VIEW_W / 2 - 32, y: 206, w: 64, h: 8, tag: 'center' },  // 4 blocks
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
  dropTime: 0.22,
  punchDamage: 3,
};

export const SWORD = { range: 3 * BLOCK, damage: 10, cooldown: 0.45, arc: 1.05, swingTime: 0.22 };
export const BOW = {
  range: 10 * BLOCK, damage: 5, ammo: 10, reload: 2.0, cooldown: 0.4, speed: 340,
};

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
};

export const PERK = {
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
  interWaveDelay: 1.6,
  spawnStagger: 0.45,
};
