import type { TerritoryId } from './layout';

/**
 * After the war: Commander Hale at Fort Victory hands out missions to clear
 * the leaders' lairs, which keep raising their armies. They go round the
 * four lairs, each round asking for more and paying more.
 */
export const COMMANDER_NAME = 'Commander Hale';

/** Missions completed to be promoted to Commander (and give the army orders). */
export const PROMOTION_AFTER = 10;

interface MissionBase {
  lair: TerritoryId;
  /** What to defeat, plural ("zombies"). */
  foes: string;
  /** Where ("the Zombie King's lair"). */
  place: string;
  count: number;
  gold: number;
}

const ROTATION: MissionBase[] = [
  { lair: 'zombie', foes: 'zombies', place: "the Zombie King's lair", count: 15, gold: 80 },
  { lair: 'witch', foes: 'witches', place: "the Witch Queen's lair", count: 12, gold: 100 },
  { lair: 'vampire', foes: 'vampires', place: "the Vampire Lord's castle", count: 12, gold: 120 },
  { lair: 'fortress', foes: 'gremlins', place: "Zomawi's sanctum", count: 25, gold: 150 },
];

export interface Mission extends MissionBase {
  /** Which mission this is (0, 1, 2, ... going round the lairs, harder each round). */
  index: number;
}

export function missionAt(index: number): Mission {
  const base = ROTATION[index % ROTATION.length];
  const round = Math.floor(index / ROTATION.length);
  return { ...base, index, count: Math.round(base.count * (1 + round * 0.5)), gold: Math.round(base.gold * (1 + round * 0.5)) };
}

/** Saved mission progress. */
export interface MissionState {
  /** The current (or next) mission. */
  index: number;
  /** Accepted and being worked on. */
  active: boolean;
  progress: number;
}

export function loadMission(raw: Partial<MissionState> | undefined): MissionState {
  const n = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : 0);
  return { index: n(raw?.index), active: raw?.active === true, progress: n(raw?.progress) };
}
