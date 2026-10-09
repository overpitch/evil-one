/**
 * Player options. Stored in this browser, so each player on their own
 * device keeps their own choices.
 */
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Graphics = 'high' | 'low';

export interface Settings {
  /** Look speed multiplier for mouse and trackpad. */
  sensitivity: number;
  /** Moving the mouse up looks down (flight-sim style). */
  invertY: boolean;
  difficulty: Difficulty;
  /** 0..1 */
  musicVolume: number;
  /** 0..1 */
  sfxVolume: number;
  /** 'low' turns off shadows and renders at a lower resolution, for slower computers. */
  graphics: Graphics;
}

export interface DifficultyProfile {
  label: string;
  description: string;
  /** Multiplier on all damage enemies deal to the hero and soldiers. */
  enemyDamage: number;
  /** Multiplier on enemy toughness (higher = more hits to kill). */
  enemyHealth: number;
  /** Seconds out of combat before health starts coming back. */
  regenDelay: number;
  /** Health per second regained out of combat. */
  regenRate: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    label: 'Easy',
    description: 'Enemies hit softer and fall faster. You heal quickly between fights.',
    enemyDamage: 0.55,
    enemyHealth: 0.7,
    regenDelay: 3,
    regenRate: 10,
  },
  normal: {
    label: 'Normal',
    description: 'The intended challenge. Block, roll and pick your moments.',
    enemyDamage: 1,
    enemyHealth: 1,
    regenDelay: 5,
    regenRate: 5,
  },
  hard: {
    label: 'Hard',
    description: 'Enemies hit harder and last longer. Healing is slow.',
    enemyDamage: 1.3,
    enemyHealth: 1.25,
    regenDelay: 8,
    regenRate: 3,
  },
};

const KEY = 'evil-one.settings';
const LEGACY_SENSITIVITY_KEY = 'evil-one.sensitivity';

export const DEFAULT_SETTINGS: Settings = { sensitivity: 1, invertY: false, difficulty: 'normal', musicVolume: 0.6, sfxVolume: 0.8, graphics: 'high' };

export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (typeof parsed.sensitivity === 'number' && parsed.sensitivity > 0) settings.sensitivity = parsed.sensitivity;
      if (typeof parsed.invertY === 'boolean') settings.invertY = parsed.invertY;
      if (parsed.difficulty && parsed.difficulty in DIFFICULTIES) settings.difficulty = parsed.difficulty;
      if (parsed.graphics === 'high' || parsed.graphics === 'low') settings.graphics = parsed.graphics;
      for (const key of ['musicVolume', 'sfxVolume'] as const) {
        const v = parsed[key];
        if (typeof v === 'number' && v >= 0 && v <= 1) settings[key] = v;
      }
    } else {
      // Milestone 1–2 stored only the sensitivity, under its own key.
      const legacy = Number(localStorage.getItem(LEGACY_SENSITIVITY_KEY));
      if (legacy > 0) settings.sensitivity = legacy;
    }
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return settings;
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}
