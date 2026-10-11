import type { WeaponId } from './weapons';

/**
 * Fort Victory's shops, and what each hero owns: gold, potions, armor and
 * hired soldiers. Every hero has their own (Player 1's in the save,
 * Player 2's in their saved hero).
 */
export interface Goods {
  gold: number;
  potions: number;
  /** 0 = none, then Leather, Chainmail, Plate (see ARMOR). */
  armor: number;
  /** Soldiers hired at the barracks (the army is capped at MAX_ARMY). */
  soldiers: number;
  /** Weapons this hero sold or traded in: the weaponsmith keeps them to buy back. */
  pawned: WeaponId[];
  /** Leaders' weapons this hero has already picked up (so a sold one doesn't reappear in its lair). */
  claimed: WeaponId[];
  /** Leaders whose pile of gold coins this hero has scooped up. */
  coins: string[];
  /** For a Player 2 hero: the playthrough `coins` and `claimed` belong to (they reset in another one). */
  campaign?: string;
  /** Bought after Commander Hale's missions unlock them (see UNLOCKS). */
  helmet: boolean;
  potionBelt: boolean;
  cape: boolean;
  elite: boolean;
}

export function newGoods(): Goods {
  return { gold: 0, potions: 0, armor: 0, soldiers: 0, pawned: [], claimed: [], coins: [], helmet: false, potionBelt: false, cape: false, elite: false };
}

/** Reads goods from a save, filling anything missing. */
export function loadGoods(raw: Partial<Goods> | undefined): Goods {
  const g = newGoods();
  if (!raw) return g;
  const n = (v: unknown, max = Infinity) => (typeof v === 'number' && v >= 0 ? Math.min(Math.floor(v), max) : 0);
  g.gold = n(raw.gold);
  g.potions = n(raw.potions, BELT_POTIONS);
  g.armor = n(raw.armor, ARMOR.length - 1);
  g.soldiers = n(raw.soldiers, MAX_ARMY);
  g.pawned = Array.isArray(raw.pawned) ? (raw.pawned.filter((w) => typeof w === 'string') as WeaponId[]) : [];
  g.claimed = Array.isArray(raw.claimed) ? (raw.claimed.filter((w) => typeof w === 'string') as WeaponId[]) : [];
  g.coins = Array.isArray(raw.coins) ? raw.coins.filter((id) => typeof id === 'string') : [];
  if (typeof raw.campaign === 'string') g.campaign = raw.campaign;
  g.helmet = raw.helmet === true;
  g.potionBelt = raw.potionBelt === true;
  g.cape = raw.cape === true;
  g.elite = raw.elite === true;
  return g;
}

/** Gold for a kill: a tenth of the XP for soldiers, a quarter for leaders. */
export function goldFor(xp: number, boss: boolean) {
  return Math.max(1, Math.round(xp / (boss ? 4 : 10)));
}

/** Gold for capturing an outpost. */
export const OUTPOST_GOLD = 10;

export const POTION_PRICE = 15;
export const MAX_POTIONS = 5;
/** With the Potion Belt. */
export const BELT_POTIONS = 8;

/** How many potions this hero can carry. */
export const maxPotions = (g: Goods) => (g.potionBelt ? BELT_POTIONS : MAX_POTIONS);
/** A potion heals this share of the hero's health. */
export const POTION_HEAL = 0.5;

/**
 * Armor, by kind (saves keep the index, so new kinds go on the end). Better
 * armor means more health; `level` armor is for sale once the hero reaches
 * that level, and Golden Armor waits for Commander Hale's missions.
 */
export const ARMOR: { name: string; health: number; price: number; color: number; level?: number }[] = [
  { name: 'No armor', health: 0, price: 0, color: 0 },
  { name: 'Leather Armor', health: 25, price: 40, color: 0x7a4a2a },
  { name: 'Chainmail', health: 60, price: 110, color: 0x8a929c },
  { name: 'Plate Armor', health: 110, price: 240, color: 0xd8dde6 },
  { name: 'Golden Armor', health: 170, price: 400, color: 0xe8b830 },
  { name: 'Padded Armor', health: 40, price: 70, color: 0x8a6a4a, level: 3 },
  { name: 'Reinforced Chainmail', health: 85, price: 170, color: 0x9aa3ab, level: 6 },
  { name: 'Steel Plate', health: 135, price: 300, color: 0xeef2f8, level: 9 },
  { name: 'Dragonscale Armor', health: 210, price: 500, color: 0x3a7a3a, level: 12 },
  { name: "Champion's Plate", health: 260, price: 650, color: 0x5a7ad8, level: 15 },
  { name: 'Titan Armor', health: 320, price: 850, color: 0x4a4e5a, level: 18 },
];

/** Armor indexes from weakest to strongest (how the armory lists them). */
export const ARMOR_BY_STRENGTH = ARMOR.map((_, i) => i)
  .filter((i) => i > 0)
  .sort((a, b) => ARMOR[a].health - ARMOR[b].health);

/** The armor tier that waits for Commander Hale's missions. */
export const GOLDEN_ARMOR = 4;

/**
 * Commander Hale's rewards: each mission completed unlocks one more thing
 * to buy at Fort Victory (`after` = missions completed).
 */
export const UNLOCKS = [
  { after: 1, name: 'Masked Helmet', shop: 'Armory', price: 70 },
  { after: 2, name: 'Potion Belt', shop: 'Potion Shop', price: 60 },
  { after: 3, name: "Hero's Cape", shop: 'Armory', price: 90 },
  { after: 4, name: 'Flame Blade', shop: 'Weaponsmith', price: 220 },
  { after: 5, name: 'Elite Soldiers', shop: 'Barracks', price: 200 },
  { after: 6, name: 'Golden Armor', shop: 'Armory', price: 400 },
] as const;

export type UnlockName = (typeof UNLOCKS)[number]['name'];

export const unlockOf = (name: UnlockName) => UNLOCKS.find((u) => u.name === name)!;

/** Extra health and stamina from the masked helmet and the cape. */
export const HELMET_HEALTH = 20;
export const CAPE_STAMINA = 25;

export const SOLDIER_PRICE = 50;
/** The most soldiers one hero's army can have. */
export const MAX_ARMY = 5;
