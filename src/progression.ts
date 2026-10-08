/**
 * XP and level curve. Tuned so a full playthrough ends around level 10
 * (about 2,000 XP total; a zombie is worth 25).
 */
export const MAX_LEVEL = 20;

/** Gains per level beyond 1. */
export const PER_LEVEL = {
  hp: 12,
  stamina: 6,
  damage: 0.08,
};

export const xpToNext = (level: number) => 60 + 40 * (level - 1);

export function statsForLevel(level: number) {
  const n = level - 1;
  return {
    maxHp: 100 + PER_LEVEL.hp * n,
    maxStamina: 100 + PER_LEVEL.stamina * n,
    damageMultiplier: 1 + PER_LEVEL.damage * n,
  };
}

/** XP awarded per kill, by enemy type. */
export const XP_REWARD = {
  zombie: 25,
};
