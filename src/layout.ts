/**
 * World layout shared by terrain generation and the campaign.
 * North is +Z (the direction the hero faces at the start). East is -X.
 */
export type ZombieKind = 'shambler' | 'runner' | 'brute';

export const HUMAN_CAMP = { x: 0, z: 0 };
export const CAMP_BANNER = { id: 'camp', name: 'Human Camp', x: 3, z: -9 };

export const ZOMBIE_LAND = { x: 0, z: 92, r: 60 };

export interface OutpostDef {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Radius of the flattened, muddy clearing. */
  flatRadius: number;
  /** [kind, offsetX, offsetZ] relative to the outpost center. */
  spawns: [ZombieKind, number, number][];
}

export const ZOMBIE_OUTPOSTS: OutpostDef[] = [
  {
    id: 'gravefield',
    name: "Gravedigger's Field",
    x: -30,
    z: 56,
    flatRadius: 13,
    spawns: [['shambler', 0, 3], ['shambler', -3, -1], ['shambler', 3, -1], ['shambler', -2, 4.5], ['shambler', 2.5, 4], ['runner', 0, -3]],
  },
  {
    id: 'rotting-village',
    name: 'The Rotting Village',
    x: 30,
    z: 78,
    flatRadius: 16,
    spawns: [['shambler', -3, 2], ['shambler', 3, 3], ['shambler', 0, -3], ['shambler', -4, -2], ['runner', 4, -2], ['runner', -1, 5], ['brute', 0, 1]],
  },
  {
    id: 'bone-pit',
    name: 'The Bone Pit',
    x: -26,
    z: 104,
    flatRadius: 12,
    spawns: [['shambler', -3, 3], ['shambler', 3, 3], ['shambler', -3, -3], ['shambler', 3, -3], ['runner', 0, 4.5], ['runner', 0, -4.5], ['brute', 0, 0]],
  },
];

/** Ruined houses in the Rotting Village, as offsets from its center: [x, z, halfWidth, halfDepth]. */
export const VILLAGE_RUINS: [number, number, number, number][] = [
  [-9, 7, 3, 2.5],
  [9, -6, 2.5, 3],
  [-8, -8, 3, 2.2],
];

/** The Zombie King's walled arena. Its gate faces south, toward the camp. */
export const KING_ARENA = { x: 8, z: 128, r: 14 };
export const KING_THRONE = { x: 8, z: 134 };
export const STRONGHOLD_GATE = { id: 'crypt-gate', name: 'Crypt Gate', x: 8, z: 107 };

/** Wandering zombie pack route through the territory. */
export const PATROL_ROUTE = [
  { x: -4, z: 48 },
  { x: 12, z: 62 },
  { x: 4, z: 88 },
  { x: -10, z: 76 },
];

/** Future territories, shown on the map as locked. */
export const WITCH_LAND = { x: 95, z: 10, r: 50 };
export const VAMPIRE_LAND = { x: -95, z: 10, r: 50 };
export const ZOMAWI_FORTRESS = { x: 0, z: -115, r: 25 };
