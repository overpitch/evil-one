import type { EnemyKind, LeaderId } from './layout';

/**
 * XP and level curve. Each enemy land (five outposts with counterattack
 * waves, a patrol and a leader) is worth roughly 2,500 XP, so the hero
 * reaches about level 5 after the Zombie Lands, 8 after the Witch Lands and
 * 10-11 by Zomawi's fortress.
 */
export const MAX_LEVEL = 20;

/** Gains per level beyond 1. */
export const PER_LEVEL = {
  hp: 12,
  stamina: 6,
  damage: 0.08,
};

export const xpToNext = (level: number) => 250 + 120 * (level - 1);

export function statsForLevel(level: number) {
  const n = level - 1;
  return {
    maxHp: 100 + PER_LEVEL.hp * n,
    maxStamina: 100 + PER_LEVEL.stamina * n,
    damageMultiplier: 1 + PER_LEVEL.damage * n,
  };
}

/** XP awarded per kill, by enemy type. */
export const XP_REWARD: Record<EnemyKind | LeaderId, number> = {
  shambler: 25,
  runner: 30,
  brute: 70,
  hexer: 40,
  broomWitch: 50,
  witchDecoy: 0,
  thrall: 40,
  knight: 90,
  gremlin: 20,
  'zombie-king': 400,
  'witch-queen': 500,
  'vampire-lord': 600,
  zomawi: 1500,
};

/** Bonus XP for capturing an outpost. */
export const OUTPOST_XP = 50;
