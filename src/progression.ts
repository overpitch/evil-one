import type { EnemyKind, LeaderId } from './layout';

/**
 * XP and level curve. Tuned so a full playthrough ends around level 10:
 * each territory is worth roughly 1,400 XP, and the recommended levels are
 * Zombie Lands 1, Witch Lands 5, Vampire Lands 8.
 */
export const MAX_LEVEL = 20;

/** Gains per level beyond 1. */
export const PER_LEVEL = {
  hp: 12,
  stamina: 6,
  damage: 0.08,
};

export const xpToNext = (level: number) => 80 + 60 * (level - 1);

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
  'zombie-king': 400,
  'witch-queen': 500,
  'vampire-lord': 600,
};

/** Bonus XP for capturing an outpost. */
export const OUTPOST_XP = 50;
