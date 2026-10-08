/**
 * Player options. Stored in this browser, so each player on their own
 * device keeps their own choices.
 */
export interface Settings {
  /** Look speed multiplier for mouse and trackpad. */
  sensitivity: number;
  /** Moving the mouse up looks down (flight-sim style). */
  invertY: boolean;
}

const KEY = 'evil-one.settings';
const LEGACY_SENSITIVITY_KEY = 'evil-one.sensitivity';

export const DEFAULT_SETTINGS: Settings = { sensitivity: 1, invertY: false };

export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (typeof parsed.sensitivity === 'number' && parsed.sensitivity > 0) settings.sensitivity = parsed.sensitivity;
      if (typeof parsed.invertY === 'boolean') settings.invertY = parsed.invertY;
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
