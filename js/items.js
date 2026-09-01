// Item / perk definitions plus the inventory model.
// Passive perks work while the item merely sits anywhere in the inventory.
import { Theme } from './theme.js';
import { pxRect } from './gfx.js';

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

export const DROP_POOL = ['lifecrystal', 'fireyblade', 'lightningarrow', 'wetslime', 'bloodstone', 'aegis'];
export const WEAPON_POOL = ['sword', 'bow'];
export const WEAPON_DROP_CHANCE = 0.20;

// One in five room clears drops a weapon instead of a perk, favouring one the
// player is not already carrying so it actually opens up a second playstyle.
export function rollDrop(inventory) {
  if (Math.random() < WEAPON_DROP_CHANCE) {
    const missing = WEAPON_POOL.filter((id) => !inventory || !inventory.has(id));
    const pool = missing.length ? missing : WEAPON_POOL;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // Commons are twice as likely as uncommons.
  const weights = {
    lifecrystal: 3, fireyblade: 3, bloodstone: 3,
    lightningarrow: 2, wetslime: 2, aegis: 2,
  };
  let total = 0;
  for (const id of DROP_POOL) total += weights[id];
  let r = Math.random() * total;
  for (const id of DROP_POOL) {
    r -= weights[id];
    if (r <= 0) return id;
  }
  return DROP_POOL[0];
}

// Boss rooms hand out a choice of two perks, never a weapon, and never two of
// the same thing.
export function rollPerkPair() {
  const first = rollPerkOnly();
  let second = rollPerkOnly();
  let guard = 0;
  while (second === first && guard++ < 20) second = rollPerkOnly();
  if (second === first) second = DROP_POOL.find((id) => id !== first);
  return [first, second];
}

function rollPerkOnly() {
  const weights = {
    lifecrystal: 3, fireyblade: 3, bloodstone: 3,
    lightningarrow: 2, wetslime: 2, aegis: 2,
  };
  let total = 0;
  for (const id of DROP_POOL) total += weights[id];
  let r = Math.random() * total;
  for (const id of DROP_POOL) {
    r -= weights[id];
    if (r <= 0) return id;
  }
  return DROP_POOL[0];
}

export class Inventory {
  constructor() {
    this.slots = new Array(INV_SIZE).fill(null);
    this.selected = 0;
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

  countOf(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
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
