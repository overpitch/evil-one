/** The saved game, written whenever the hero touches a checkpoint banner. */
export interface SaveData {
  version: 1;
  name: string;
  level: number;
  xp: number;
  kills: number;
  /** Id of the checkpoint banner the hero respawns at. */
  checkpoint: string;
  /** Ids of captured outposts. */
  captured: string[];
  /** Ids of defeated army leaders (and 'zomawi' once the game is won). */
  leaders: string[];
  /** Weapons the hero has claimed (older saves: worked out from the defeated leaders). */
  weapons?: string[];
  /** The weapon in the hero's hand. */
  weapon?: string;
  /** Player 2's own weapons, kept between visits. */
  player2?: { weapons: string[]; weapon: string };
  /** Which playthrough this is (new games get a new one). */
  campaignId?: string;
  /** Commander Hale's missions (after the war). */
  mission?: Partial<import('./missions').MissionState>;
  /** False between Zomawi's fall and the ending playing. */
  endingSeen?: boolean;
  /** What the hero wears. */
  outfit?: Partial<import('./outfit').Outfit>;
  /** Gold, potions, armor and hired soldiers. */
  goods?: Partial<import('./shop').Goods>;
  /** Seconds of play so far. */
  playTime?: number;
  savedAt: number;
}

let key = 'evil-one.save';

/** Automated test runs use their own slot so they never touch a real save. */
export function useTestSaveSlot() {
  key = 'evil-one.test-save';
}

export function newSave(name: string): SaveData {
  return { version: 1, name, level: 1, xp: 0, kills: 0, checkpoint: 'camp', captured: [], leaders: [], weapons: ['sword'], weapon: 'sword', campaignId: newCampaignId(), savedAt: Date.now() };
}

/** A name for one playthrough (Player 2 heroes keep which leaders' gold they collected per playthrough). */
export function newCampaignId() {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SaveData>;
    const valid =
      d.version === 1 &&
      typeof d.name === 'string' &&
      Number.isInteger(d.level) &&
      typeof d.xp === 'number' &&
      typeof d.kills === 'number' &&
      typeof d.checkpoint === 'string' &&
      Array.isArray(d.captured) &&
      Array.isArray(d.leaders);
    return valid ? (d as SaveData) : null;
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...data, savedAt: Date.now() }));
  } catch {
    /* storage unavailable: the game still plays, it just won't persist */
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
