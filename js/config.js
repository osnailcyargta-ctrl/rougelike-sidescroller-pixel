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

// Grappling hook: fires on Q, bites terrain, then reels you in on a rope you
// can swing from. No damage - it is pure movement.
export const GRAPPLE = {
  maxLength: 11 * BLOCK,     // how far the hook can reach
  hookSpeed: 620,
  reelSpeed: 165,            // how fast the rope shortens once it bites
  pull: 340,                 // extra acceleration along the rope
  minLength: 16,             // let go once you are basically there
  airControl: 0.45,          // how much steering you keep while swinging
  cooldown: 0.22,
  fallGravity: 760,          // past its reach the hook drops instead of vanishing
  fallDrag: 0.4,             // how much forward speed it keeps when it starts to fall
  maxRope: 1.75,             // multiple of maxLength before the line finally runs out
};

export const BOW = {
  range: 10 * BLOCK, damage: 5, ammo: 10, reload: 2.0, cooldown: 0.4, speed: 340,
};

// Firey Twin Dagger: tiny range, tiny damage, absurd cadence. Every 15th
// connect throws the player forward in a burning dash.
export const TWINDAGGER = {
  range: 2 * BLOCK, damage: 5, cooldown: 0.3, arc: 1.0,
  dashEvery: 15, dashDamage: 5, dashSpeed: 430, dashTime: 0.16,
  dropChance: 0.01,
};

// Armour. Three slots, two sets, and a flat defence number that comes straight
// off every hit you take.
export const ARMOR = {
  slots: ['helmet', 'chest', 'legs'],
  smeltValue: 2,             // bars you get for melting a weapon down
  ironCost: 3,               // bars per iron piece
  paperCost: 75,             // sheets per paper piece
  // which weapons the anvil will take apart
  smeltable: ['sword', 'shardgun', 'nukerang', 'graplinghook', 'twindagger'],
  sets: {
    iron: { name: 'IRON', bonus: { defense: 1, meleeCooldown: -0.10 } },
    paper: { name: 'PAPER', bonus: { fold: 'shield' } },
  },
};

// The Paper set's reward: three plates that orbit you and cut what they touch.
export const PAPER_SHIELD = {
  cost: 20,
  count: 3,
  damage: 20,
  radius: 26,
  spin: 2.1,                 // radians per second
  life: 90,                  // 1.5 minutes, then they are gone
  hitCooldown: 0.5,          // per enemy, so one shield cannot shred instantly
};

// Origamist: paper is ammunition, and every fold is a different weapon.
export const ORIGAMI = {
  maxHp: 50,                 // the Origamist is made of paper too
  startPaper: 100,
  roomPaper: 50,             // handed over on entering a new room
  wavePaper: 20,             // and after every wave you clear
  maxPaper: 250,             // anything past this is simply never handed over
  dropChance: 0.10,          // per kill, while playing the Origamist
  dropMin: 1, dropMax: 4,
  cooldown: 0.55,            // between folds, whoever is throwing them
  forms: {
    airplane: {
      id: 'airplane', name: 'PAPER PLANE', book: 'bookairplane', cost: 1,
      cooldown: 0.45,
      damage: 30, speed: 132, drop: 26,     // drop = downward drift, px/s^2
      bounces: 3, bounceKick: 46,
    },
    missile: {
      id: 'missile', name: 'PAPER MISSILE', book: 'bookmissile', cost: 2,
      cooldown: 0.9,
      damage: 40, speed: 70, maxSpeed: 520, accel: 620,
      blastRadius: 5 * BLOCK, blastDamage: 40,
    },
    // unlocked by wearing the whole Paper set, not by a tutor book
    shield: {
      id: 'shield', name: 'PAPER SHIELD', set: 'paper', cost: PAPER_SHIELD.cost,
      cooldown: 0.6, damage: PAPER_SHIELD.damage,
    },
  },
};

// The anvil rides the drifting platform on even-numbered rooms.
export const ANVIL = { everyRooms: 2, w: 20, h: 14, reach: 46 };

// The forge list scrolls once it is longer than this. Five rows is what fits
// on a phone without the panel swallowing the screen.
export const FORGE_VISIBLE_ROWS = 5;

// What a Stinger Egg is worth in parts, and what a boss leaves behind.
export const DROPS = {
  shellsFromBroken: [1, 3],       // an egg you smashed
  shellsFromHatched: [0, 1],      // one that opened on its own
  soulsPerBoss: [1, 2],           // every boss but the god
};

// The one thing you cannot find: it has to be made.
export const GIANT_EGG = {
  shells: 10, souls: 3,
  hatch: 5.0,                     // seconds on the platform before it opens
  w: 34, h: 42,
};


// Darts, not arrows - which is why lightning never touches them.
export const STINGER_GUN = {
  range: 7 * BLOCK, damage: 20, ammo: 3, reload: 1.4, cooldown: 0.34,
  speed: 330,
  poisonFromMutant: 0.02,          // Mutant Stinger's chance to leave one
  poisonFromStinger: 0.0021,       // and a plain Stinger's
};

// Darts cast from a soul and an iron bar. Loading them into the Stinger Gun
// makes it hit harder and actually move what it hits.
export const SOUL_DART = {
  barCost: 1, soulCost: 1, perCraft: 10,
  stack: 100,
  damageMult: 1.25,
  knockback: 1 * BLOCK,     // how far the thing you hit ends up, in pixels
  hopHeight: 10,            // and how high the arc that carries it there is
  speed: 380,
};

export const SHARDGUN = {
  range: 5 * BLOCK, damage: 20, ammo: 1, reload: 1.5, cooldown: 0.45,
  pellets: 5, speed: 400, spread: 0.30,
  hoverTime: 0.87,                 // how long the shards hang at max range
  splinterSpeed: 1180,             // very fast, and it never expires on range
  splinterDamage: 0.5,             // of the base damage
  splinterLife: 2.4,
  fragments: 8,                    // when two splinters meet
  fragmentDamage: 0.75,            // of the base damage
  fragmentSpeed: 300,
  fragmentLife: 0.7,
  collideRadius: 5,
  dropChance: 0.10,                // a Shardling's chance to leave one behind
};

// Regular enemies stay at their base stats through the first five rooms, then
// step up once every two rooms from room 6 on.
export const ROOM_SCALING = {
  startRoom: 6,
  everyRooms: 2,
  stopRoom: 12,           // enemies stop scaling after room 12
  hpPerStep: 0.18,        // +18% max HP per step
  damagePerStep: 0.12,    // +12% damage per step
  bossHpPerTier: 0.40,    // +40% boss HP per boss room after the first
  bossDamagePerTier: 0.25,
};

// How many scaling steps a given room has earned. It stops climbing at
// stopRoom: past that the run gets harder through its bosses, not by the
// regular enemies quietly turning into sponges.
export function roomScaleSteps(room) {
  const { startRoom, everyRooms, stopRoom } = ROOM_SCALING;
  if (room < startRoom) return 0;
  const capped = Math.min(room, stopRoom);
  return Math.floor((capped - startRoom) / everyRooms) + 1;
}

export const BOSS_ROOM_INTERVAL = 5;   // rooms 5, 10, 15, 20 get a third wave
export const FINAL_ROOM = 20;          // Alphads waits here; there is no room 21
export const CEILING_ROOM = 15;        // where the Undead Ceiling hangs
// Up to here the seed decides everything: which enemies a wave sends, which
// perks a room offers, what a boss leaves. Past it the run goes off-script on
// purpose - the last stretch should not be something you can rehearse.
export const SEEDED_THROUGH_ROOM = 15;

// Boss Rush: the four room bosses back to back, nothing in between. Each one
// is a "room", so the reward between them is the same choice of two perks a
// boss room normally gives.
export const BOSS_RUSH = {
  order: ['golem', 'bigdude', 'ceiling', 'poitnus', 'alphads'],
  // the room number each is fought at, so it arrives at the strength it would
  // have had in a full run rather than at its room-5 numbers
  atRoom: { golem: 5, bigdude: 10, ceiling: 15, poitnus: 18, alphads: 20 },
  // two on offer, one taken, from the class you picked
  weaponPicks: 2,
  // and between bosses: three on offer, two taken, then a short countdown
  rewardOffer: 3,
  rewardTake: 2,
  rewardCountdown: 3,
  // and the one perk a rush opens with, spun for on a slot reel
  slotSpin: 2.1,             // how long the reel runs before it settles
  slotRerolls: 1,            // and how many times you may send it round again
  weapons: {
    melee: ['sword', 'twindagger', 'nukerang'],
    ranger: ['bow', 'shardgun', 'stingergun'],
    origamist: ['bookairplane', 'bookmissile'],
  },
};

export const ENEMY_TYPES = {
  grunt: {
    id: 'grunt', name: 'Ghoul', hp: 80, speed: 52, damage: 12, w: 12, h: 17,
    attackCooldown: 0.9, attackRange: 16, knockback: 120, windUp: 0.22,
  },
  brute: {
    id: 'brute', name: 'Brute', hp: 80, speed: 32, damage: 20, w: 18, h: 22,
    attackCooldown: 1.4, attackRange: 20, knockback: 190, chargeSpeed: 150, windUp: 0.38,
  },
  stinger: {
    id: 'stinger', name: 'Stinger', hp: 80, speed: 60, damage: 10, w: 13, h: 12,
    attackCooldown: 1.8, attackRange: 150, flying: true, projectileSpeed: 150,
    // a hundredth of the Mutant's chance: the gun is really the Mutant's
    dropId: 'stingergun', dropChance: 0.0021,
  },
  // Stalks just out of reach, then commits to a long telegraphed lunge.
  lurker: {
    id: 'lurker', name: 'Lurker', hp: 80, speed: 44, damage: 15, w: 13, h: 15,
    attackCooldown: 1.6, attackRange: 96, knockback: 140,
    windUp: 0.5, lungeSpeed: 330, lungeTime: 0.3, standOff: 74,
    dropId: 'twindagger', dropChance: 0.01,
  },
  // Artillery: holds its ground and lobs acid over platforms.
  spitter: {
    id: 'spitter', name: 'Spitter', hp: 80, speed: 26, damage: 16, w: 16, h: 16,
    attackCooldown: 2.2, attackRange: 210, knockback: 90,
    standOff: 120, projectileSpeed: 190, windUp: 0.45,
  },
  // Post-golem support. It never touches you: it hangs behind the pack and
  // pours speed into whatever is closest to you.
  wisp: {
    id: 'wisp', name: 'Wisp', hp: 30, speed: 96, damage: 0, w: 11, h: 11,
    attackCooldown: 99, attackRange: 0, flying: true, ai: 'wisp',
    noContact: true,
    auraRange: 84, auraSpeed: 0.20, auraMax: 3,   // +20% speed to up to 3 allies
    orbit: 96,                                    // how far behind the pack it hangs
  },
  // Golem wreckage that reassembled itself. Its front plate turns most of a
  // frontal hit, so it has to be opened up from behind or above.
  shardling: {
    id: 'shardling', name: 'Shardling', hp: 80, speed: 74, damage: 10, w: 17, h: 16,
    attackCooldown: 2.0, attackRange: 150, flying: true, ai: 'shardling',
    standOff: 92, windUp: 0.55, chargeSpeed: 395, chargeTime: 0.34,
    frontGuard: 0.25,          // fraction of damage that gets through the plate
    dropId: 'shardgun', dropChance: 0.10,   // at the spot where it broke
  },
  // From room 10 the plain Stinger stops turning up and this comes instead:
  // bigger, slower to fire, and it leaves an egg behind.
  mutantstinger: {
    id: 'mutantstinger', name: 'Mutant Stinger', hp: 150, speed: 52, damage: 14, w: 20, h: 18,
    attackCooldown: 2.6, attackRange: 170, flying: true, projectileSpeed: 145,
    ai: 'mutantstinger', shots: 2, shotSpread: 0.26, shotGap: 0.16,
    dropId: 'stingergun', dropChance: 0.02,
  },
  // What a Mutant Stinger leaves where it fell. It does nothing but sit there
  // and count down - but what it is counting down to is two more Stingers.
  stingeregg: {
    id: 'stingeregg', name: 'Stinger Egg', hp: 60, speed: 0, damage: 0, w: 12, h: 15,
    attackCooldown: 99, attackRange: 0, ai: 'egg',
    noContact: true, noScale: true,
    hatchTime: 5.0, hatchCount: 2, brokenHatchChance: 0.5,
  },
  // Poitnus' body. Flying, and a slam cannot reach it.
  poitnusBody: {
    id: 'poitnusBody', name: 'Poitnus', hp: 1400, speed: 0, damage: 22,
    w: 54, h: 40, attackCooldown: 1, attackRange: 30,
    flying: true, boss: true, slamImmune: true,
  },
  // The clutch it lays, and the shell you set down yourself. Both are eggs;
  // only one of them can be hurt.
  giantstingeregg: {
    id: 'giantstingeregg', name: 'Gigantic Stinger Egg', hp: 1, speed: 0, damage: 0,
    w: 34, h: 42, attackCooldown: 99, attackRange: 0, ai: 'giantegg',
    noContact: true, noScale: true, invincible: true,
  },
  // The ones Alphads calls up. Same AI, same sprite, different bookkeeping:
  // only these count against the summon cap, and they leave nothing behind.
  aetherShardling: {
    id: 'aetherShardling', name: 'Shardling', hp: 80, speed: 74, damage: 10, w: 17, h: 16,
    attackCooldown: 2.0, attackRange: 150, flying: true, ai: 'shardling',
    standOff: 92, windUp: 0.55, chargeSpeed: 395, chargeTime: 0.34,
    frontGuard: 0.25, summoned: true,
  },
  // The Undead Ceiling's slab. It hangs, so nothing on the ground reaches it
  // and a slam does nothing.
  ceilingBody: {
    id: 'ceilingBody', name: 'Undead Ceiling', hp: 2000, speed: 0, damage: 26,
    w: 300, h: 46, attackCooldown: 1, attackRange: 30,
    flying: true, boss: true, slamImmune: true, noContact: true,
  },
  // Its arm. A separate target so hitting the hand still lands on the pool.
  ceilingHand: {
    id: 'ceilingHand', name: 'Grasping Hand', hp: 2000, speed: 0, damage: 30,
    w: 26, h: 30, attackCooldown: 1, attackRange: 24,
    flying: true, boss: true, slamImmune: true, noContact: true,
  },
  // Alphads' body. Censored-black, always airborne, and a ground slam cannot
  // touch it.
  alphadsBody: {
    id: 'alphadsBody', name: 'Alphads', hp: 2000, speed: 0, damage: 22, w: 34, h: 46,
    attackCooldown: 1, attackRange: 30, flying: true, boss: true, slamImmune: true,
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
    hp: 990, phase2Hp: 462,          // +65% over its original 600 pool
    bodyW: 48, bodyH: 60, headW: 32, headH: 27,
    contactDamage: 18,
    smallLaser: { count: 4, interval: 0.2, speed: 250, damage: 12, windUp: 0.45 },
    bigLaser: { duration: 2.0, shortDuration: 1.0, lag: 0.3, damage: 22, width: 5, windUp: 0.6 },
    slam: { jumpVel: 470, fallAccel: 2200, damage: 26, radius: 92, windUp: 0.4 },
    dash: { speed: 290, time: 0.55, damage: 24, windUp: 0.45 },
    headSpeed: 88, headHover: 74,
    attackDelay: 3.0,   // pause between one attack ending and the next starting
    // It paces and hops the whole fight instead of standing there between orders.
    restless: { speed: 46, standOff: 96, hopVel: 250, hopEvery: [0.9, 1.9] },
  },
  // Room 15. It does not stand on the floor - it IS the ceiling, a sheet of
  // grafted flesh with one enormous eye, and it never moves sideways.
  ceiling: {
    id: 'ceiling', name: 'Undead Ceiling', short: 'Ceiling', title: 'THE ROOF OF MEAT',
    kind: 'ceiling',
    hp: 2000,
    dmgScale: 2,              // it hits twice as hard as its numbers read
    pace: 0.65,               // and waits this much of each scripted pause
    w: 300, h: 46,            // the slab that hangs from the roof
    restY: 4,                 // how far its top sits above the screen edge
    eyeR: 15,
    laser: { duration: 1.0, windUp: 0.5, damage: 24, width: 9, tickDamage: 8, tick: 0.15 },
    hand: {
      count: 5,               // five arms, from five places along the slab
      stagger: 0.16,          // how far apart they punch
      damage: 30, reach: 190, windUp: 0.7, punchTime: 0.2, holdTime: 0.3,
      retract: 0.45, w: 26, h: 30,
    },
    // The crush is not an attack you survive. It is the clock running out.
    crush: { damage: 2000, fallSpeed: 1500, hold: 0.45, riseSpeed: 190, windUp: 0.9 },
    crushAfter: 150,          // 2.5 minutes to kill it, or it flattens you
  },
  // The last thing in the vault. It never lands, and it never stops.
  alphads: {
    id: 'alphads', name: 'Alphads', short: 'Alphads', title: 'THE AETHER GOD',
    kind: 'god',
    hp: 2000,
    dmgScale: 2,              // twice the bite for the same listed numbers
    pace: 0.65,               // and every wait between attacks is this long
    w: 34, h: 46,
    hoverY: 84, driftSpeed: 96, driftRange: 128,

    shot: { arrows: 10, spacing: 0.13, speed: 330, damage: 20, windUp: 0.35 },
    arrowRain: { count: 25, speed: 545, spread: 150, gravity: 430, windUp: 0.5 },
    timeStop: { duration: 2.0, spawn: 3, maxShardlings: 10, windUp: 0.6 },
    healing: { perOrb: 15, orbSpeed: 150, windUp: 0.45 },
    godRay: {
      duration: 2.0, windUp: 0.85, damage: 26, width: 7, lag: 0.14,
      // the shock waves off the beam reach two blocks now, not ten, and they
      // hit for five less: standing clear of the beam is meant to be enough
      waveEvery: 0.75, waveRange: 2 * BLOCK, waveSpeed: 320, waveDamage: 13,
    },
  },

  // Not a room boss: the one you build yourself and set down on the centre
  // platform. It never lands, it never stops moving, and it seeds the floor
  // with the eggs its whole brood came from.
  poitnus: {
    id: 'poitnus', name: 'Poitnus', short: 'Poitnus',
    title: 'THE ANCIENT STINGER', kind: 'stinger',
    hp: 1400,
    w: 54, h: 40,
    contactDamage: 22,
    hoverY: 72, hoverRange: 26,     // how far up and down it wanders
    driftSpeed: 116, standOff: 96,
    // five stingers in a fan, thrown at wherever you were standing
    volley: { count: 5, spacing: 0.10, speed: 215, damage: 15, windUp: 0.4, spread: 0.34 },
    // then it hangs still, and lays
    clutch: { hold: 2.0, count: 3, gap: 0.5, minSpacing: 56, dropSpeed: 90 },
    maxBrood: 10,                   // stingers on screen; at the cap it stops laying
    volleysPerCycle: 3,
    volleyGap: 1.0,
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
  // Damage Booster: your own class's weapons hit harder, and you get frailer.
  boosterDamage: 0.50,      // +50% to your class's weapon damage
  boosterMaxHp: 5,          // -5 max HP for holding it
  burnChance: 0.33,
  burnDuration: 3.0,
  burnTick: 0.1,
  burnTickDamage: 1,
  markDuration: 5.0,
  chainCooldown: 0.75,
  chainDamage: 8,
  // Poison is the burn and the slime at once: it ticks like fire and drags
  // like slime, and the Stinger Gun carries it without a perk.
  poisonDuration: 4.0,
  poisonTick: 0.5,
  poisonTickDamage: 3,
  poisonSlow: 0.35,
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
  maxPerWave: 17,           // however deep the room, never more than this
};
