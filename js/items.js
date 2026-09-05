// Item / perk definitions plus the inventory model.
// Passive perks work while the item merely sits anywhere in the inventory.
import { Theme } from './theme.js';
import { rng, streamFor } from './util.js';
import { pxRect, drawBoomerang } from './gfx.js';

export const INV_COLS = 4;
export const INV_ROWS = 4;
export const INV_SIZE = INV_COLS * INV_ROWS;   // 16 slots, hotbar included
export const HOTBAR_SIZE = 4;                  // first row doubles as the hotbar
export const MAX_STACK = 10;                   // weapons override this to 1

export const RARITY = {
  starter: { name: 'Starter', color: '#cfe0ff' },
  common: { name: 'Common', color: '#8ce88c' },
  uncommon: { name: 'Uncommon', color: '#6fc6ff' },
  rare: { name: 'Rare', color: '#c98cff' },
};

export const ITEMS = {
  sword: {
    id: 'sword', name: 'Iron Sword', rarity: 'starter', stack: 1, weapon: 'melee',
    desc: ['Melee weapon.', '3 block reach, 10 damage.'],
  },
  bow: {
    id: 'bow', name: 'Hunter Bow', rarity: 'starter', stack: 1, weapon: 'bow',
    desc: ['Ranged weapon. 10 block range,', '5 damage, 10 ammo, 2s reload.'],
  },
  nukerang: {
    id: 'nukerang', name: 'Nukerang', rarity: 'rare', stack: 1, weapon: 'boomerang',
    desc: ['Thrown melee weapon. 5 block flight,', 'returns to your hand.',
           'Blasts for 14 on contact; every 3rd', 'blast detonates for 28.'],
  },
  twindagger: {
    id: 'twindagger', name: 'Firey Twin Dagger', rarity: 'rare', stack: 1, weapon: 'melee',
    fiery: true,
    desc: ['Melee. 2 block reach, 5 damage,', 'one strike every 0.3s.',
           'Burns on every hit, no perk needed.', 'Every 15th hit throws you',
           'forward in a burning dash (+5).'],
  },
  // --- Origamist ---------------------------------------------------------
  paper: {
    id: 'paper', name: 'Paper', rarity: 'common', stack: 250, weapon: 'paper',
    desc: ['Ammunition and weapon both.', 'Attacking opens the fold wheel;',
           'each fold you know costs its own', 'number of sheets.',
           'You can carry 250 at most.'],
  },
  bookairplane: {
    id: 'bookairplane', name: 'Paper Plane Tutor', rarity: 'uncommon', stack: 1, book: 'airplane',
    desc: ['Teaches the PAPER PLANE fold.', '1 sheet. Glides forever, sinking',
           'slowly, and kicks off walls.', '30 damage.'],
  },
  bookmissile: {
    id: 'bookmissile', name: 'Paper Missile Tutor', rarity: 'rare', stack: 1, book: 'missile',
    desc: ['Teaches the PAPER MISSILE fold.', '2 sheets. Starts slow, builds',
           'speed, detonates on contact for', '40 over 5 blocks.'],
  },
  // --- the ancient stinger -----------------------------------------------
  stingereggshell: {
    id: 'stingereggshell', name: 'Stinger Egg Shell', rarity: 'common', stack: MAX_STACK,
    desc: ['Crafting material.', 'Ten, with three souls, make a',
           'Gigantic Stinger Egg.'],
  },
  soul: {
    id: 'soul', name: 'Soul', rarity: 'uncommon', stack: MAX_STACK,
    desc: ['Crafting material.'],
  },
  souldart: {
    id: 'souldart', name: 'Soul Dart', rarity: 'uncommon', stack: 100,
    desc: ['Ammunition for the Stinger Gun.', 'While a stack is on the hotbar it',
           'fires these instead: +25% damage', 'and a hit knocks the target back',
           'a block. One is spent per shot.'],
  },
  giganticstingeregg: {
    id: 'giganticstingeregg', name: 'Gigantic Stinger Egg', rarity: 'rare', stack: 1,
    place: 'giantegg',
    desc: ['Stand on the centre platform and', 'attack to set it down.',
           'Five seconds later POITNUS', 'comes out of it.'],
  },
  // --- armour ------------------------------------------------------------
  ironbar: {
    id: 'ironbar', name: 'Iron Bar', rarity: 'common', stack: MAX_STACK,
    desc: ['Melted-down weapon.', 'Three bars make one iron', 'armour piece at an anvil.'],
  },
  ironhelmet: {
    id: 'ironhelmet', name: 'Iron Helmet', rarity: 'uncommon', stack: 1,
    armor: 'helmet', set: 'iron', defense: 3,
    buff: { meleeDamage: 0.20 },
    desc: ['Head armour. 3 defence.', '+20% melee damage.'],
  },
  ironchestplate: {
    id: 'ironchestplate', name: 'Iron Chestplate', rarity: 'uncommon', stack: 1,
    armor: 'chest', set: 'iron', defense: 4,
    buff: { meleeRange: 1 },
    desc: ['Body armour. 4 defence.', '+1 tile of melee reach.'],
  },
  ironleggings: {
    id: 'ironleggings', name: 'Iron Leggings', rarity: 'uncommon', stack: 1,
    armor: 'legs', set: 'iron', defense: 3,
    buff: {},
    desc: ['Leg armour. 3 defence.'],
  },
  paperhelmet: {
    id: 'paperhelmet', name: 'Paper Helmet', rarity: 'uncommon', stack: 1,
    armor: 'helmet', set: 'paper', defense: 0,
    buff: { origamiDamage: 0.10 },
    desc: ['Folded head armour. 0 defence.', '+10% Origamist damage.'],
  },
  paperchestplate: {
    id: 'paperchestplate', name: 'Paper Chestplate', rarity: 'uncommon', stack: 1,
    armor: 'chest', set: 'paper', defense: 2,
    buff: { foldCooldown: -0.30 },
    desc: ['Folded body armour. 2 defence.', '-30% fold cooldown.'],
  },
  paperleggings: {
    id: 'paperleggings', name: 'Paper Leggings', rarity: 'uncommon', stack: 1,
    armor: 'legs', set: 'paper', defense: 1,
    buff: { planeSpeed: 0.10 },
    desc: ['Folded leg armour. 1 defence.', '+10% paper plane speed.'],
  },
  damagebooster: {
    id: 'damagebooster', name: 'Damage Booster', rarity: 'rare', stack: 1,
    desc: ['+50% damage with your own class\'s', 'weapons while it is held.',
           'Costs you 5 max HP.'],
  },
  stingergun: {
    id: 'stingergun', name: 'Stinger Gun', rarity: 'rare', stack: 1, weapon: 'stingergun',
    desc: ['Ranged weapon. 3 darts, 1.4s reload.', '20 damage, and every dart poisons:',
           'it burns and drags at once.'],
  },
  stident: {
    id: 'stident', name: 'Stident', rarity: 'rare', stack: 1, weapon: 'trident',
    desc: ['Melee. 5 block thrust, 37 damage.', 'Three of Poitnus\' own stingers',
           'on a shaft. Two hits in three', 'leave poison behind for 2s.'],
  },
  shardgun: {
    id: 'shardgun', name: 'Shardgun', rarity: 'rare', stack: 1, weapon: 'shardgun',
    desc: ['Ranged weapon. 1 shell, 1.5s reload.', 'Fires 5 shards over 5 blocks; they',
           'hang there 0.87s, then streak at the', 'cursor for half damage, forever.',
           'Two splinters that meet burst into 8.'],
  },
  graplinghook: {
    id: 'graplinghook', name: 'Grappling Hook', rarity: 'rare', stack: 1,
    desc: ['Press Q to fire a hook at the cursor.', 'It bites terrain, reels you in and',
           'lets you swing. Q again to let go.'],
  },
  lifecrystal: {
    id: 'lifecrystal', name: 'Life Crystal', rarity: 'common', stack: MAX_STACK,
    desc: ['+10 max HP while held.', 'Stacks up to 5 (+50 HP).'],
  },
  fireyblade: {
    id: 'fireyblade', name: 'Fiery Blade', rarity: 'common', stack: MAX_STACK,
    desc: ['Melee hits have a 33% chance', 'to burn for 3s (-1 HP / 0.1s).'],
  },
  lightningarrow: {
    id: 'lightningarrow', name: 'Lightning Arrow', rarity: 'uncommon', stack: MAX_STACK,
    desc: ['Arrows mark enemies for 5s.', '2+ marks arc lightning between', 'them, electrifying everything hit.'],
  },
  wetslime: {
    id: 'wetslime', name: 'Wet Slime', rarity: 'uncommon', stack: MAX_STACK,
    desc: ['Every 2s spits slime at an enemy,', 'slowing it 30% for 1.5s.'],
  },
  bloodstone: {
    id: 'bloodstone', name: 'Bloodstone', rarity: 'common', stack: MAX_STACK,
    desc: ['Every 5th hit you land heals 3 HP.', '+2 HP per extra stack.'],
  },
  aegis: {
    id: 'aegis', name: 'Aegis Shard', rarity: 'uncommon', stack: MAX_STACK,
    desc: ['+20 absorb shield that soaks damage', 'before your HP. Refills 5s after', 'you stop taking hits.'],
  },
};

export const DROP_POOL = [
  'lifecrystal', 'fireyblade', 'lightningarrow', 'wetslime', 'bloodstone', 'aegis',
  'graplinghook',
];
// Things you only ever need one of.
export const UNIQUE_ONCE = new Set(['graplinghook', 'nukerang', 'shardgun', 'twindagger',
  'bookairplane', 'bookmissile', 'damagebooster', 'stingergun', 'stident']);
const PERK_WEIGHTS = {
  lifecrystal: 3, fireyblade: 3, bloodstone: 3,
  lightningarrow: 2, wetslime: 2, aegis: 2,
  graplinghook: 2,
};

// `roll` is the generator to draw from: a room's own seeded stream where the
// seed is meant to decide the offer, or the loose one where it is not.
function weightedPerk(inventory, roll = rng) {
  const pool = DROP_POOL.filter((id) => !(UNIQUE_ONCE.has(id) && inventory && inventory.has(id)));
  let total = 0;
  for (const id of pool) total += PERK_WEIGHTS[id];
  let r = roll() * total;
  for (const id of pool) {
    r -= PERK_WEIGHTS[id];
    if (r <= 0) return id;
  }
  return pool[0] ?? DROP_POOL[0];
}
export const WEAPON_POOL = ['sword', 'bow'];
export const WEAPON_DROP_CHANCE = 0.20;

// One in five room clears drops a weapon instead of a perk, favouring one the
// player is not already carrying so it actually opens up a second playstyle.
export function rollDrop(inventory, roll = rng) {
  if (roll() < WEAPON_DROP_CHANCE) {
    const missing = WEAPON_POOL.filter((id) => !inventory || !inventory.has(id));
    const pool = missing.length ? missing : WEAPON_POOL;
    return pool[Math.floor(roll() * pool.length)];
  }
  return weightedPerk(inventory, roll);
}

// Boss rooms hand out a choice of two perks, never a weapon, and never two of
// the same thing.
export function rollPerkPair(inventory, roll = rng) {
  const first = weightedPerk(inventory, roll);
  let second = weightedPerk(inventory, roll);
  let guard = 0;
  while (second === first && guard++ < 20) second = weightedPerk(inventory, roll);
  if (second === first) second = DROP_POOL.find((id) => id !== first);
  return [first, second];
}

export const ARMOR_SLOTS = ['helmet', 'chest', 'legs'];

export class Inventory {
  constructor() {
    this.slots = new Array(INV_SIZE).fill(null);
    this.selected = 0;
    // worn pieces, one per slot. Each holds a { id, count: 1 } like any stack.
    this.armor = { helmet: null, chest: null, legs: null };
  }

  // Which armour slot an item belongs in, or null if it is not armour.
  static armorSlot(id) { return ITEMS[id]?.armor ?? null; }

  // Every worn piece, in slot order.
  wornPieces() {
    return ARMOR_SLOTS.map((k) => this.armor[k]).filter(Boolean);
  }

  // The set name if all three worn pieces belong to the same one.
  activeSet() {
    const worn = this.wornPieces();
    if (worn.length < ARMOR_SLOTS.length) return null;
    const set = ITEMS[worn[0].id]?.set;
    return worn.every((w) => ITEMS[w.id]?.set === set) ? set : null;
  }

  // Put an item into its armour slot, sending whatever was there back to the
  // grid. Returns false if it does not belong there or there is no room.
  equip(slotIndex) {
    const item = this.slots[slotIndex];
    if (!item) return false;
    const key = Inventory.armorSlot(item.id);
    if (!key) return false;
    const prev = this.armor[key];
    this.armor[key] = { id: item.id, count: 1 };
    this.slots[slotIndex] = prev ?? null;
    return true;
  }

  // Take a piece off. Returns false when the grid is full.
  unequip(key, toIndex = -1) {
    const worn = this.armor[key];
    if (!worn) return false;
    if (toIndex >= 0 && !this.slots[toIndex]) {
      this.slots[toIndex] = worn;
      this.armor[key] = null;
      return true;
    }
    if (this.add(worn.id, 1) === 0) { this.armor[key] = null; return true; }
    return false;
  }

  stackLimit(id) { return ITEMS[id]?.stack ?? MAX_STACK; }

  // Returns the number of items that did NOT fit.
  add(id, count = 1) {
    const limit = this.stackLimit(id);
    for (let i = 0; i < INV_SIZE && count > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < limit) {
        const take = Math.min(limit - s.count, count);
        s.count += take;
        count -= take;
      }
    }
    for (let i = 0; i < INV_SIZE && count > 0; i++) {
      if (!this.slots[i]) {
        const take = Math.min(limit, count);
        this.slots[i] = { id, count: take };
        count -= take;
      }
    }
    return count;
  }

  // Spend from a stack, newest slots first. Returns true only if the whole
  // amount was there to spend.
  remove(id, count = 1) {
    if (this.countOf(id) < count) return false;
    for (let i = INV_SIZE - 1; i >= 0 && count > 0; i--) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, count);
      s.count -= take;
      count -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return true;
  }

  // Every fold the player has a tutor book for, in a stable order.
  knownFolds() {
    const found = [];
    for (const s of this.slots) {
      if (!s) continue;
      const book = ITEMS[s.id]?.book;
      if (book && !found.includes(book)) found.push(book);
    }
    return found;
  }

  countOf(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  // Only the first row. Some things have to be to hand, not merely carried:
  // Soul Darts feed the gun from the hotbar, so stuffing them in the back of
  // the bag does nothing.
  countInHotbar(id) {
    let n = 0;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = this.slots[i];
      if (s && s.id === id) n += s.count;
    }
    return n;
  }

  removeFromHotbar(id, count = 1) {
    if (this.countInHotbar(id) < count) return false;
    for (let i = HOTBAR_SIZE - 1; i >= 0 && count > 0; i--) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, count);
      s.count -= take;
      count -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return true;
  }

  has(id) { return this.countOf(id) > 0; }

  selectedItem() { return this.slots[this.selected]; }

  selectedWeapon() {
    const s = this.slots[this.selected];
    if (!s) return null;
    const def = ITEMS[s.id];
    return def && def.weapon ? def : null;
  }

  cycle(dir) {
    this.selected = (this.selected + dir + HOTBAR_SIZE) % HOTBAR_SIZE;
  }

  swap(a, b) {
    if (a === b) return;
    const A = this.slots[a], B = this.slots[b];
    // merge identical stacks when possible
    if (A && B && A.id === B.id) {
      const limit = this.stackLimit(A.id);
      const move = Math.min(limit - B.count, A.count);
      if (move > 0) {
        B.count += move;
        A.count -= move;
        if (A.count <= 0) this.slots[a] = null;
        return;
      }
    }
    this.slots[a] = B;
    this.slots[b] = A;
  }

  firstFreeIndex() { return this.slots.findIndex((s) => s === null); }

  canAccept(id) {
    if (this.firstFreeIndex() >= 0) return true;
    const limit = this.stackLimit(id);
    return this.slots.some((s) => s && s.id === id && s.count < limit);
  }
}

// --- icons ---------------------------------------------------------------

export function drawItemIcon(ctx, id, x, y, s = 12, t = 0) {
  const u = s / 12;
  const P = (dx, dy, dw, dh, c) => pxRect(ctx, x + dx * u, y + dy * u, Math.max(1, dw * u), Math.max(1, dh * u), c);
  const bob = Math.round(Math.sin(t * 3) * 0.6);
  switch (id) {
    case 'sword':
      P(2, 8, 3, 2, Theme.steelDark);
      for (let i = 0; i < 7; i++) P(3 + i, 7 - i, 2, 2, i > 4 ? Theme.steel : Theme.steel);
      P(3, 6, 2, 2, Theme.uiAccent);
      P(1, 9, 3, 2, '#7a4a2a');
      break;
    case 'bow':
      for (let i = 0; i < 9; i++) {
        const a = (i / 8) * Math.PI - Math.PI / 2;
        P(4 + Math.cos(a) * 3.4, 6 + Math.sin(a) * 4.6, 1.4, 1.4, '#a86a3a');
      }
      P(7, 1, 1, 10, Theme.steelDark);
      P(4, 5, 6, 1, Theme.steel);
      break;
    case 'twindagger': {
      // two short blades crossed, both alight
      for (const side of [-1, 1]) {
        const ox = side < 0 ? 0 : 6;
        const a = side < 0 ? 1 : -1;
        P(ox + 1, side < 0 ? 8 : 2, 2, 2, '#7a4a2a');
        for (let i = 0; i < 4; i++) {
          P(ox + 1 + i * 0.9, (side < 0 ? 7 : 3) - a * i * 1.5, 2, 2, Theme.steel);
        }
        const fl = Math.sin(t * 9 + side) * 0.6;
        P(ox + 4 + fl, (side < 0 ? 2 : 8) + fl, 2, 2, Theme.fire);
        P(ox + 4 + fl, (side < 0 ? 2 : 8) + fl, 1, 1, Theme.fireHot ?? '#ffe9a8');
      }
      break;
    }
    case 'paper': {
      // a sheet with a scribble of ink on it - two colours, nothing else
      const lift = Math.round(Math.sin(t * 2.5) * 0.6);
      P(2, 1 + lift, 8, 10, '#141018');
      P(3, 2 + lift, 6, 8, '#f4f0e6');
      P(3, 9 + lift, 6, 1, '#cdc7b8');
      P(4, 4 + lift, 4, 1, '#141018');
      P(4, 6 + lift, 3, 1, '#141018');
      P(4, 8 + lift, 4, 1, '#3a3340');
      break;
    }
    case 'bookairplane':
    case 'bookmissile': {
      // a manual: inked cover, paper page, the fold sketched on it in ink
      P(1, 2, 9, 9, '#141018');
      P(2, 3, 7, 7, '#f4f0e6');
      P(9, 2, 1, 9, '#3a3340');
      P(2, 3, 1, 7, '#cdc7b8');
      const fl = Math.round(Math.sin(t * 3) * 0.5);
      if (id === 'bookairplane') {
        P(3, 5 + fl, 5, 1, '#141018');
        P(4, 6 + fl, 3, 1, '#141018');
        P(5, 4 + fl, 1, 3, '#3a3340');
      } else {
        P(4, 4 + fl, 2, 5, '#141018');
        P(3, 8 + fl, 4, 1, '#3a3340');
        P(4, 3 + fl, 2, 1, '#3a3340');
      }
      break;
    }
    case 'damagebooster': {
      // an upward chevron over a cracked heart: more punch, less of you
      const pulse = Math.round(Math.sin(t * 4) * 0.7);
      P(2, 8 + pulse, 3, 2, '#ff5c7a');
      P(7, 8 + pulse, 3, 2, '#ff5c7a');
      P(3, 10 + pulse, 6, 1, '#c93a58');
      P(5, 9 + pulse, 2, 1, '#2a1420');
      for (let i = 0; i < 4; i++) {
        P(3 + i, 6 - i + pulse, 2, 2, i > 1 ? '#ffe9a8' : '#ffb43c');
        P(9 - i, 6 - i + pulse, 2, 2, i > 1 ? '#ffe9a8' : '#ffb43c');
      }
      P(5, 1 + pulse, 2, 2, '#ffffff');
      break;
    }
    case 'stingereggshell': {
      // a curved shard of shell, inner face pale, jagged along the break
      const lift = Math.round(Math.sin(t * 2.4) * 0.5);
      P(2, 5 + lift, 8, 5, '#9fd8c4');
      P(3, 4 + lift, 6, 1, '#cdf3e6');
      P(2, 5 + lift, 1, 4, '#cdf3e6');
      P(4, 9 + lift, 2, 1, '#5d9484');
      P(7, 9 + lift, 1, 1, '#5d9484');
      P(9, 6 + lift, 1, 3, '#5d9484');
      break;
    }
    case 'soul': {
      // a small flame with a hollow in it, always drifting upward
      const lift = Math.sin(t * 3) * 0.8;
      const flick = 0.6 + 0.4 * Math.sin(t * 9);
      P(4, 4 + lift, 4, 7, '#7cc8ff');
      P(5, 3 + lift, 2, 2, '#d8f2ff');
      P(3, 6 + lift, 1, 4, '#4a8cd8');
      P(8, 6 + lift, 1, 4, '#4a8cd8');
      P(5, 6 + lift, 2, 2, flick > 0.6 ? '#ffffff' : '#a8dcff');
      P(4, 11 + lift, 4, 1, '#2a4a80');
      break;
    }
    case 'giganticstingeregg': {
      // a fat egg with a hairline crack, breathing
      const br = Math.sin(t * 2) * 0.4;
      P(2, 3 - br, 8, 9 + br * 2, '#9fd8c4');
      P(3, 2 - br, 6, 1, '#cdf3e6');
      P(2, 4 - br, 1, 5, '#cdf3e6');
      P(8, 5 - br, 1, 5, '#5d9484');
      P(3, 12, 6, 1, '#3d6a5c');
      P(5, 4 - br, 1, 3, '#3d6a5c');
      P(6, 7, 1, 3, '#3d6a5c');
      if (Math.sin(t * 5) > 0.7) P(5, 6, 2, 1, '#ffe9a8');
      break;
    }
    case 'souldart': {
      // a needle with a soul-blue bead burning behind the point
      const lift = Math.sin(t * 3) * 0.6;
      P(1, 6 + lift, 8, 2, '#5a6b8c');
      P(1, 6 + lift, 7, 1, '#98a8c8');
      P(9, 5.5 + lift, 3, 3, '#dfe7f5');
      P(0, 5 + lift, 2, 4, '#7cc8ff');
      const glow = 0.5 + 0.5 * Math.sin(t * 7);
      P(1, 6 + lift, 2, 2, glow > 0.5 ? '#d8f2ff' : '#7cc8ff');
      break;
    }
    case 'stident': {
      // three barbed prongs on a shaft, the middle one longest
      P(1, 6, 8, 2, '#6b4a30');
      P(2, 5, 6, 1, '#8a6238');
      P(8, 4, 1, 6, Theme.steelDark);
      const wob = Math.sin(t * 3) * 0.4;
      for (const py of [2.5, 5.5, 8.5]) {
        P(9, py + wob * (py === 5.5 ? 0 : 1), py === 5.5 ? 3 : 2, 1, '#5fd8a8');
        P(py === 5.5 ? 12 : 11, py + wob * (py === 5.5 ? 0 : 1), 1, 1, '#c6ffe4');
      }
      const glow = 0.5 + 0.5 * Math.sin(t * 6);
      P(9, 5.5, 1, 1, glow > 0.5 ? '#eaffb0' : '#a8e04a');
      break;
    }
    case 'ironbar': {
      const lift = Math.round(Math.sin(t * 2.5) * 0.5);
      P(1, 6 + lift, 10, 4, '#7d8798');
      P(1, 6 + lift, 10, 1, '#c3ccdb');
      P(1, 9 + lift, 10, 1, '#4a5262');
      P(3, 7 + lift, 2, 1, '#e6ecf7');
      break;
    }
    case 'ironhelmet': case 'ironchestplate': case 'ironleggings':
    case 'paperhelmet': case 'paperchestplate': case 'paperleggings': {
      const iron = id.startsWith('iron');
      const body = iron ? '#8e99ac' : '#f4f0e6';
      const lit = iron ? '#ccd6e6' : '#ffffff';
      const dark = iron ? '#4a5262' : '#141018';
      const lift = Math.round(Math.sin(t * 2.2) * 0.5);
      if (id.endsWith('helmet')) {
        P(2, 2 + lift, 8, 6, body);
        P(2, 2 + lift, 8, 1, lit);
        P(2, 8 + lift, 3, 3, body);
        P(7, 8 + lift, 3, 3, body);
        P(4, 5 + lift, 4, 2, dark);          // visor
        P(5, 0 + lift, 2, 2, iron ? '#ccd6e6' : dark);   // crest
      } else if (id.endsWith('chestplate')) {
        P(2, 2 + lift, 8, 8, body);
        P(2, 2 + lift, 8, 1, lit);
        P(0, 3 + lift, 2, 4, body);
        P(10, 3 + lift, 2, 4, body);
        P(5, 4 + lift, 2, 5, dark);          // sternum seam
        P(2, 9 + lift, 8, 1, dark);
      } else {
        P(2, 1 + lift, 8, 3, body);
        P(2, 1 + lift, 8, 1, lit);
        P(2, 4 + lift, 3, 7, body);
        P(7, 4 + lift, 3, 7, body);
        P(5, 4 + lift, 2, 6, dark);          // the gap between the legs
        P(2, 10 + lift, 3, 1, dark);
        P(7, 10 + lift, 3, 1, dark);
      }
      break;
    }
    case 'stingergun': {
      // a slim dart gun: barrel, grip, and a green bead venting at the muzzle
      P(1, 6, 7, 2, Theme.steelDark);
      P(1, 5, 6, 1, Theme.steel);
      P(2, 8, 2, 3, '#3a5a2a');
      P(8, 5, 3, 3, Theme.steel);
      const pulse = 0.5 + 0.5 * Math.sin(t * 6);
      P(10, 6, 2, 1, '#a8e04a');
      P(11 + Math.sin(t * 5) * 0.5, 5.5, 1, 1, pulse > 0.5 ? '#eaffb0' : '#a8e04a');
      P(4, 3, 1, 2, '#a8e04a');
      break;
    }
    case 'shardgun': {
      // a stubby barrel with three violet shards fanning out of the muzzle
      P(1, 6, 6, 3, Theme.steelDark);
      P(1, 5, 5, 1, Theme.steel);
      P(2, 9, 2, 2, '#7a4a2a');
      P(6, 6, 2, 3, Theme.steel);
      const fan = [[8, 3], [9, 5.5], [8, 8]];
      for (let i = 0; i < fan.length; i++) {
        const o = Math.sin(t * 5 + i * 1.5) * 0.5;
        P(fan[i][0] + o, fan[i][1], 2, 2, '#a98cff');
        P(fan[i][0] + o, fan[i][1], 1, 1, '#ffffff');
      }
      break;
    }
    case 'lifecrystal':
      P(5, 1 + bob, 2, 2, '#ffd9e6');
      P(4, 3 + bob, 4, 5, Theme.hp);
      P(5, 2 + bob, 2, 6, '#ff9ab0');
      P(3, 4 + bob, 1, 3, '#c1274a');
      P(8, 4 + bob, 1, 3, '#c1274a');
      P(5, 8 + bob, 2, 2, '#ff6f8b');
      break;
    case 'fireyblade': {
      P(2, 8, 3, 2, Theme.steelDark);
      for (let i = 0; i < 7; i++) P(3 + i, 7 - i, 2, 2, Theme.steel);
      const f = Math.sin(t * 9) * 0.8;
      P(6, 2 + f, 2, 3, Theme.fire);
      P(7, 1 + f, 2, 2, Theme.fireHot);
      P(5, 5 + f, 2, 2, Theme.fire);
      break;
    }
    case 'lightningarrow': {
      P(2, 9, 8, 1, Theme.steelDark);
      P(9, 8, 2, 3, Theme.steel);
      P(1, 8, 2, 3, '#dfe9ff');
      const z = Math.sin(t * 12) > 0 ? 0 : 1;
      P(5 + z, 1, 2, 3, Theme.lightning);
      P(4 + z, 4, 3, 2, Theme.lightning);
      P(6 + z, 5, 2, 3, '#ffffff');
      break;
    }
    case 'wetslime': {
      const w = Math.sin(t * 4) * 0.7;
      P(2, 6 + w, 8, 5, Theme.slime);
      P(3, 4 + w, 6, 3, '#a9ffb8');
      P(4, 3 + w, 3, 2, '#dfffe6');
      P(4, 7 + w, 2, 2, '#0e3d1a');
      P(7, 7 + w, 2, 2, '#0e3d1a');
      break;
    }
    case 'graplinghook': {
      // a claw on a coiled line
      const sway = Math.sin(t * 2.5) * 0.5;
      P(1, 2 + sway, 2, 2, Theme.steelDark);
      P(3, 4 + sway, 2, 2, Theme.steelDark);
      P(5, 6 + sway, 2, 2, Theme.steelDark);
      P(6, 1, 1, 5, Theme.steel);
      P(4, 1, 5, 1, Theme.steel);
      P(3, 0, 2, 3, Theme.steel);
      P(8, 0, 2, 3, Theme.steel);
      P(6, 7 + sway, 3, 3, Theme.steel);
      break;
    }
    case 'nukerang': {
      ctx.save();
      ctx.translate(x + s / 2, y + s / 2);
      ctx.rotate(t * 3.4);
      ctx.scale(u, u);
      drawBoomerang(ctx, 6.5, 3, Theme.steel, Theme.steelDark, Theme.fire);
      ctx.restore();
      break;
    }
    case 'bloodstone': {
      const pulse = Math.sin(t * 4) * 0.6;
      P(4, 2 + pulse, 4, 2, '#7a1030');
      P(3, 3 + pulse, 6, 5, Theme.hp);
      P(4, 4 + pulse, 2, 2, '#ffc2d0');
      P(2, 5 + pulse, 8, 4, '#c1274a');
      P(4, 9 + pulse, 4, 2, '#7a1030');
      P(5, 6 + pulse, 2, 2, '#ffffff');
      break;
    }
    case 'aegis': {
      const g = Math.sin(t * 3) * 0.5;
      P(2, 1 + g, 8, 2, '#8fd8ff');
      P(2, 3 + g, 8, 4, '#4fa8e8');
      P(3, 7 + g, 6, 2, '#4fa8e8');
      P(4, 9 + g, 4, 2, '#2b6ea8');
      P(5, 10 + g, 2, 1, '#8fd8ff');
      P(4, 2 + g, 2, 6, '#dff3ff');
      break;
    }
    default:
      P(2, 2, 8, 8, Theme.uiDim);
  }
}
