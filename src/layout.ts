/**
 * World layout shared by terrain generation and the campaign.
 * North is +Z (the direction the hero faces at the start). East is -X.
 */
export type ZombieKind = 'shambler' | 'runner' | 'brute';
export type WitchKind = 'hexer' | 'broomWitch' | 'witchDecoy';
export type VampireKind = 'thrall' | 'knight';
export type EnemyKind = ZombieKind | WitchKind | VampireKind;

export type TerritoryId = 'zombie' | 'witch' | 'vampire' | 'fortress';
export type LeaderId = 'zombie-king' | 'witch-queen' | 'vampire-lord' | 'zomawi';

export interface Spot {
  x: number;
  z: number;
}

export const HUMAN_CAMP = { x: 0, z: 0 };
export const CAMP_BANNER = { id: 'camp', name: 'Human Camp', x: 3, z: -9 };

export interface OutpostDef {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Radius of the flattened clearing. */
  flatRadius: number;
  /** [kind, offsetX, offsetZ] relative to the outpost center. */
  spawns: [EnemyKind, number, number][];
  /** Scenery for the clearing. */
  decor: 'graves' | 'ruins' | 'bones' | 'mushrooms' | 'huts' | 'hangingWood' | 'chapel' | 'mill' | 'pens' | 'spikes';
}

export interface ArenaDef {
  x: number;
  z: number;
  r: number;
  /** Direction of the gate from the center (radians; 0 = north/+Z, PI = south). */
  gateAngle: number;
}

export interface TerritoryDef {
  id: TerritoryId;
  name: string;
  center: Spot & { r: number };
  recommendedLevel: number;
  outposts: OutpostDef[];
  patrol: { route: Spot[]; kinds: EnemyKind[] };
  arena: ArenaDef;
  /** Where the leader waits before the fight. */
  throne: Spot;
  /** Checkpoint banner just outside the arena gate. */
  gate: { id: string; name: string; x: number; z: number };
  leader: {
    id: LeaderId;
    title: string;
    minionKind: EnemyKind;
    minionCount: number;
    introLine: string;
    deathLine: string;
  };
  liberatedTitle: string;
  /** Leaders that must fall before this land opens at all (Zomawi's fortress). */
  requires?: LeaderId[];
}

/** Point on a circle around a center, at a compass angle (0 = north/+Z). */
const around = (c: Spot, angle: number, r: number): Spot => ({ x: c.x + Math.sin(angle) * r, z: c.z + Math.cos(angle) * r });

const ZOMBIE_ARENA: ArenaDef = { x: 8, z: 128, r: 14, gateAngle: Math.PI };
const WITCH_ARENA: ArenaDef = { x: 124, z: 10, r: 14, gateAngle: -Math.PI / 2 };
const VAMPIRE_ARENA: ArenaDef = { x: -124, z: 10, r: 14, gateAngle: Math.PI / 2 };
const FORTRESS_ARENA: ArenaDef = { x: 0, z: -122, r: 16, gateAngle: 0 };

export const ARMY_LEADERS: LeaderId[] = ['zombie-king', 'witch-queen', 'vampire-lord'];

export const TERRITORIES: TerritoryDef[] = [
  {
    id: 'zombie',
    name: 'Zombie Lands',
    center: { x: 0, z: 92, r: 60 },
    recommendedLevel: 1,
    outposts: [
      {
        id: 'gravefield',
        name: "Gravedigger's Field",
        x: -30,
        z: 56,
        flatRadius: 13,
        decor: 'graves',
        spawns: [['shambler', 0, 3], ['shambler', -3, -1], ['shambler', 3, -1], ['shambler', -2, 4.5], ['shambler', 2.5, 4], ['runner', 0, -3]],
      },
      {
        id: 'rotting-village',
        name: 'The Rotting Village',
        x: 30,
        z: 78,
        flatRadius: 16,
        decor: 'ruins',
        spawns: [['shambler', -3, 2], ['shambler', 3, 3], ['shambler', 0, -3], ['shambler', -4, -2], ['runner', 4, -2], ['runner', -1, 5], ['brute', 0, 1]],
      },
      {
        id: 'corpse-mire',
        name: 'The Corpse Mire',
        x: -42,
        z: 82,
        flatRadius: 12,
        decor: 'bones',
        spawns: [['shambler', -3, 2], ['shambler', 3, 2], ['shambler', 0, -3], ['shambler', -3, -3], ['runner', 3, -3], ['brute', 0, 1]],
      },
      {
        id: 'bone-pit',
        name: 'The Bone Pit',
        x: -26,
        z: 108,
        flatRadius: 12,
        decor: 'bones',
        spawns: [['shambler', -3, 3], ['shambler', 3, 3], ['shambler', -3, -3], ['shambler', 3, -3], ['runner', 0, 4.5], ['runner', 0, -4.5], ['brute', 0, 0]],
      },
      {
        id: 'plague-farm',
        name: 'The Plague Farm',
        x: 36,
        z: 114,
        flatRadius: 15,
        decor: 'ruins',
        spawns: [['shambler', -3, 2], ['shambler', 3, 2], ['runner', -4, -3], ['runner', 4, -3], ['brute', -1.5, 0], ['brute', 1.5, 0]],
      },
    ],
    patrol: {
      route: [{ x: -4, z: 48 }, { x: 12, z: 62 }, { x: 4, z: 88 }, { x: -10, z: 76 }],
      kinds: ['shambler', 'shambler', 'shambler', 'runner'],
    },
    arena: ZOMBIE_ARENA,
    throne: { x: 8, z: 134 },
    gate: { id: 'crypt-gate', name: 'Crypt Gate', ...around(ZOMBIE_ARENA, Math.PI, ZOMBIE_ARENA.r + 7) },
    leader: {
      id: 'zombie-king',
      title: 'The Zombie King',
      minionKind: 'shambler',
      minionCount: 6,
      introLine: 'Fresh meat for my children!',
      deathLine: 'Zomawi... will... avenge... me...',
    },
    liberatedTitle: 'Zombie Lands liberated',
  },
  {
    id: 'witch',
    name: 'Witch Lands',
    center: { x: 95, z: 10, r: 50 },
    recommendedLevel: 5,
    outposts: [
      {
        id: 'glowcap-grove',
        name: 'Glowcap Grove',
        x: 70,
        z: -6,
        flatRadius: 12,
        decor: 'mushrooms',
        spawns: [['hexer', 0, 4], ['hexer', -4, -2], ['hexer', 4, -2], ['broomWitch', 0, 0]],
      },
      {
        id: 'cauldron-hollow',
        name: 'Cauldron Hollow',
        x: 86,
        z: 40,
        flatRadius: 14,
        decor: 'huts',
        spawns: [['hexer', -4, 3], ['hexer', 4, 3], ['hexer', 0, -4], ['broomWitch', -3, -2], ['broomWitch', 3, -2]],
      },
      {
        id: 'hanging-wood',
        name: 'The Hanging Wood',
        x: 98,
        z: -24,
        flatRadius: 12,
        decor: 'hangingWood',
        spawns: [['hexer', -3, 4], ['hexer', 3, 4], ['hexer', -4, -3], ['hexer', 4, -3], ['broomWitch', 0, 0], ['broomWitch', 0, -4]],
      },
      {
        id: 'toadstool-ring',
        name: 'The Toadstool Ring',
        x: 116,
        z: 40,
        flatRadius: 12,
        decor: 'mushrooms',
        spawns: [['hexer', -4, 2], ['hexer', 4, 2], ['hexer', 0, -4], ['broomWitch', -2, 0], ['broomWitch', 2, 0]],
      },
      {
        id: 'witchlight-bog',
        name: 'Witchlight Bog',
        x: 122,
        z: -22,
        flatRadius: 12,
        decor: 'hangingWood',
        spawns: [['hexer', -4, 3], ['hexer', 4, 3], ['hexer', -4, -3], ['hexer', 4, -3], ['broomWitch', 0, 0]],
      },
    ],
    patrol: {
      route: [{ x: 60, z: 12 }, { x: 78, z: 22 }, { x: 84, z: 0 }, { x: 70, z: -18 }],
      kinds: ['hexer', 'hexer', 'broomWitch'],
    },
    arena: WITCH_ARENA,
    throne: { x: 130, z: 10 },
    gate: { id: 'coven-gate', name: 'Coven Circle', ...around(WITCH_ARENA, -Math.PI / 2, WITCH_ARENA.r + 7) },
    leader: {
      id: 'witch-queen',
      title: 'The Witch Queen',
      minionKind: 'witchDecoy',
      minionCount: 4,
      introLine: 'A soldier? How quaint. You will burn beautifully.',
      deathLine: 'Zomawi... my spells... were yours...',
    },
    liberatedTitle: 'Witch Lands liberated',
  },
  {
    id: 'vampire',
    name: 'Vampire Lands',
    center: { x: -95, z: 10, r: 50 },
    recommendedLevel: 8,
    outposts: [
      {
        id: 'bloodroot-chapel',
        name: 'Bloodroot Chapel',
        x: -70,
        z: -6,
        flatRadius: 13,
        decor: 'chapel',
        spawns: [['thrall', 0, 4], ['thrall', -3, 1], ['thrall', 3, 1], ['thrall', 0, -3], ['knight', 0, 0]],
      },
      {
        id: 'crimson-mill',
        name: 'The Crimson Mill',
        x: -86,
        z: 40,
        flatRadius: 14,
        decor: 'mill',
        spawns: [['thrall', -4, 3], ['thrall', 4, 3], ['thrall', -3, -3], ['thrall', 3, -3], ['knight', -1.5, 0], ['knight', 1.5, 0]],
      },
      {
        id: 'thrall-pens',
        name: 'The Thrall Pens',
        x: -98,
        z: -24,
        flatRadius: 13,
        decor: 'pens',
        spawns: [['thrall', -4, 4], ['thrall', 4, 4], ['thrall', -4, -4], ['thrall', 4, -4], ['thrall', 0, 4.5], ['knight', -1.5, 0], ['knight', 1.5, 0]],
      },
      {
        id: 'ashen-cemetery',
        name: 'The Ashen Cemetery',
        x: -116,
        z: 40,
        flatRadius: 13,
        decor: 'graves',
        spawns: [['thrall', -3, 3], ['thrall', 3, 3], ['thrall', -3, -3], ['thrall', 3, -3], ['thrall', 0, 4], ['knight', 0, 0]],
      },
      {
        id: 'ravenhold-ruins',
        name: 'Ravenhold Ruins',
        x: -122,
        z: -22,
        flatRadius: 15,
        decor: 'ruins',
        spawns: [['thrall', -4, 3], ['thrall', 4, 3], ['thrall', -3, -4], ['thrall', 3, -4], ['knight', -1.5, 0], ['knight', 1.5, 0]],
      },
    ],
    patrol: {
      route: [{ x: -60, z: 12 }, { x: -78, z: 22 }, { x: -84, z: 0 }, { x: -70, z: -18 }],
      kinds: ['thrall', 'thrall', 'thrall', 'knight'],
    },
    arena: VAMPIRE_ARENA,
    throne: { x: -130, z: 10 },
    gate: { id: 'castle-gate', name: 'Castle Nightspire Gate', ...around(VAMPIRE_ARENA, Math.PI / 2, VAMPIRE_ARENA.r + 7) },
    leader: {
      id: 'vampire-lord',
      title: 'The Vampire Lord',
      minionKind: 'thrall',
      minionCount: 6,
      introLine: 'At last, a guest worth draining.',
      deathLine: 'Zomawi... promised... eternity...',
    },
    liberatedTitle: 'Vampire Lands liberated',
  },
  {
    id: 'fortress',
    name: "Zomawi's Fortress",
    center: { x: 0, z: -108, r: 34 },
    recommendedLevel: 10,
    requires: ARMY_LEADERS,
    outposts: [
      {
        id: 'fortress-courtyard',
        name: 'The Fortress Courtyard',
        x: 0,
        z: -84,
        flatRadius: 13,
        decor: 'spikes',
        spawns: [
          ['brute', 0, 0],
          ['knight', -3, 2],
          ['knight', 3, 2],
          ['hexer', -5, -3],
          ['hexer', 5, -3],
          ['broomWitch', 0, 4],
          ['runner', -2, 5],
          ['runner', 2, 5],
        ],
      },
    ],
    patrol: { route: [{ x: 0, z: -78 }], kinds: [] },
    arena: FORTRESS_ARENA,
    throne: { x: 0, z: -129 },
    gate: { id: 'fortress-gate', name: 'Fortress Gate', ...around(FORTRESS_ARENA, 0, FORTRESS_ARENA.r + 4) },
    leader: {
      id: 'zomawi',
      title: 'Zomawi',
      minionKind: 'runner',
      minionCount: 8,
      introLine: 'Another soldier of the human army. I was one, once. Kneel, and I will make you more.',
      deathLine: 'The witches... the grave... at last... it is quiet...',
    },
    liberatedTitle: 'Zomawi has fallen',
  },
];

export const ZOMBIE_LAND = TERRITORIES[0];
export const WITCH_LAND = TERRITORIES[1];
export const VAMPIRE_LAND = TERRITORIES[2];
export const FORTRESS = TERRITORIES[3];

/** Ruined houses in villages, as offsets from the outpost center: [x, z, halfWidth, halfDepth]. */
export const VILLAGE_RUINS: [number, number, number, number][] = [
  [-9, 7, 3, 2.5],
  [9, -6, 2.5, 3],
  [-8, -8, 3, 2.2],
];
