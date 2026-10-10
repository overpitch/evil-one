import * as THREE from 'three';
import type { LeaderId } from './layout';

export type WeaponId = 'sword' | 'gravebreaker' | 'hexfire' | 'bloodfang' | 'doomblade' | 'spear' | 'daggers' | 'axe' | 'hammer';

/**
 * A weapon the hero can carry. The starting sword is always owned; each
 * leader drops its own weapon when it falls. `swing` scales the hero's
 * 3-hit combo (see SWINGS in player.ts); `special` adds a power on top.
 */
export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** The leader who drops it (null: the hero's own sword, or a shop weapon). */
  from: LeaderId | null;
  /** Sold at Fort Victory's weaponsmith. */
  shop?: boolean;
  /** Gold it costs at the weaponsmith; it sells for half. 0 = can't be sold. */
  value: number;
  /** One line about what it does, for the inventory. */
  description: string;
  /** 1–5 pips shown in the inventory. */
  pips: { damage: number; speed: number; reach: number };
  swing: {
    damage: number;
    /** Swing duration multiplier (lower = faster). */
    dur: number;
    /** Extra reach in meters. */
    reach: number;
    /** Extra half-angle of the swing arc, in radians. */
    arc: number;
    knockback: number;
    stamina: number;
  };
  special: {
    /** Every swing throws a fire bolt; the third swing throws three. */
    bolts?: boolean;
    /** The third swing slams the ground, hurting every enemy within `radius` for `share` of its damage. */
    slam?: { radius: number; share: number };
    /** Heals the hero for this share of the damage each hit deals. */
    lifesteal?: number;
    /** Every hit staggers (and knocks back) anything short of a leader. */
    stagger?: boolean;
  };
  /** Glow color for its pickup beam and the inventory card. */
  color: number;
  /** Small picture for the inventory and HUD (SVG markup, 64×64). */
  icon: string;
  /** The 3D model, held at the grip with the business end along +Z. */
  build(): THREE.Group;
  /** A second one for the left hand (twin daggers). */
  offhand?: boolean;
}

const matCache = new Map<number, THREE.Material>();
function mat(color: number, glow = false) {
  const key = glow ? -color - 1 : color;
  let m = matCache.get(key);
  if (!m) {
    m = glow ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color, flatShading: true });
    matCache.set(key, m);
  }
  return m;
}

function box(g: THREE.Group, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}

const GOLD = 0xc9a24a;

export const WEAPONS: WeaponDef[] = [
  {
    id: 'sword',
    value: 0,
    name: "Soldier's Sword",
    from: null,
    description: 'Trusty and balanced. The blade every human soldier carries.',
    pips: { damage: 2, speed: 3, reach: 2 },
    swing: { damage: 1, dur: 1, reach: 0, arc: 0, knockback: 1, stamina: 1 },
    special: {},
    color: 0xd8dde3,
    icon: `<g transform="rotate(45 32 32)"><rect x="29" y="4" width="6" height="38" fill="#d8dde3"/><path d="M29 4 L32 0 L35 4Z" fill="#d8dde3"/><rect x="20" y="42" width="24" height="4" fill="#c9a24a"/><rect x="30" y="46" width="4" height="11" fill="#6a4426"/><rect x="28.5" y="57" width="7" height="5" fill="#c9a24a"/></g>`,
    build() {
      const g = new THREE.Group();
      const gold = mat(GOLD);
      box(g, 0.045, 0.045, 0.22, mat(0x4a3020), 0, 0, 0);
      box(g, 0.3, 0.05, 0.06, gold, 0, 0, 0.13);
      box(g, 0.07, 0.02, 1.0, mat(0xd8dde3), 0, 0, 0.66);
      box(g, 0.08, 0.08, 0.07, gold, 0, 0, -0.13);
      return g;
    },
  },
  {
    id: 'gravebreaker',
    value: 150,
    name: 'Gravebreaker',
    from: 'zombie-king',
    description: 'The Zombie King\'s bone maul. Slow, crushing blows, and every third swing slams the ground.',
    pips: { damage: 4, speed: 1, reach: 3 },
    swing: { damage: 1.6, dur: 1.3, reach: 0.3, arc: 0.1, knockback: 1.6, stamina: 1.35 },
    special: { slam: { radius: 4.5, share: 0.7 } },
    color: 0x7aff5a,
    icon: `<g transform="rotate(35 32 32)"><rect x="29" y="18" width="6" height="42" rx="2" fill="#e2d6b4"/><circle cx="32" cy="60" r="4" fill="#e2d6b4"/><rect x="18" y="4" width="28" height="18" rx="2" fill="#5e5e56"/><rect x="14" y="8" width="4" height="10" fill="#e2d6b4"/><rect x="46" y="8" width="4" height="10" fill="#e2d6b4"/><rect x="24" y="10" width="5" height="4" fill="#7aff5a"/><rect x="35" y="10" width="5" height="4" fill="#7aff5a"/></g>`,
    build() {
      const g = new THREE.Group();
      const bone = mat(0xe2d6b4);
      const stone = mat(0x5e5e56);
      box(g, 0.07, 0.07, 1.0, bone, 0, 0, 0.35);
      box(g, 0.11, 0.11, 0.1, bone, 0, 0, -0.17);
      box(g, 0.36, 0.3, 0.32, stone, 0, 0, 0.95);
      // Bone spikes and a pair of glowing grave-lights in the head.
      box(g, 0.08, 0.08, 0.2, bone, 0.2, 0, 0.95).rotation.y = 0.9;
      box(g, 0.08, 0.08, 0.2, bone, -0.2, 0, 0.95).rotation.y = -0.9;
      box(g, 0.08, 0.22, 0.08, bone, 0, 0.2, 0.95);
      box(g, 0.06, 0.05, 0.02, mat(0x7aff5a, true), 0.07, 0.04, 1.115);
      box(g, 0.06, 0.05, 0.02, mat(0x7aff5a, true), -0.07, 0.04, 1.115);
      return g;
    },
  },
  {
    id: 'hexfire',
    value: 200,
    name: 'Hexfire Staff',
    from: 'witch-queen',
    description: 'The Witch Queen\'s staff. Every swing throws a fire bolt, and the third throws three.',
    pips: { damage: 1, speed: 3, reach: 5 },
    swing: { damage: 0.75, dur: 1, reach: 0.3, arc: 0, knockback: 0.8, stamina: 1.1 },
    special: { bolts: true },
    color: 0xc06aff,
    icon: `<g transform="rotate(40 32 32)"><rect x="30" y="14" width="4" height="48" fill="#4a2a1a"/><rect x="28" y="22" width="8" height="3" fill="#c9a24a"/><rect x="28" y="50" width="8" height="3" fill="#c9a24a"/><path d="M30 14 L26 8 L30 4" stroke="#4a2a1a" stroke-width="3" fill="none"/><circle cx="34" cy="8" r="7" fill="#c06aff"/><circle cx="34" cy="8" r="3.5" fill="#f4e0ff"/></g>`,
    build() {
      const g = new THREE.Group();
      const wood = mat(0x4a2a1a);
      const gold = mat(GOLD);
      box(g, 0.05, 0.05, 1.5, wood, 0, 0, 0.3);
      box(g, 0.08, 0.08, 0.05, gold, 0, 0, 0.2);
      box(g, 0.08, 0.08, 0.05, gold, 0, 0, 0.9);
      // A crooked tip clutching a glowing hex-orb.
      box(g, 0.05, 0.05, 0.22, wood, 0, 0.07, 1.1).rotation.x = -0.6;
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), mat(0xc06aff, true));
      orb.position.set(0, 0.04, 1.2);
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), mat(0xf4e0ff, true));
      core.position.copy(orb.position);
      g.add(orb, core);
      return g;
    },
  },
  {
    id: 'bloodfang',
    value: 250,
    name: 'Bloodfang',
    from: 'vampire-lord',
    description: 'The Vampire Lord\'s saber. Lightning fast, and every hit heals you a little.',
    pips: { damage: 2, speed: 5, reach: 2 },
    swing: { damage: 0.85, dur: 0.72, reach: 0, arc: 0.1, knockback: 0.8, stamina: 0.8 },
    special: { lifesteal: 0.25 },
    color: 0xff2a3a,
    icon: `<g transform="rotate(45 32 32)"><path d="M30 44 L30 10 Q31 2 37 0 Q34 8 34 14 L34 44Z" fill="#c8202e"/><path d="M18 44 Q24 40 32 44 Q40 40 46 44 L44 47 L20 47Z" fill="#1a1016"/><circle cx="32" cy="45.5" r="2.5" fill="#ff2a3a"/><rect x="30" y="47" width="4" height="10" fill="#1a1016"/><rect x="29" y="57" width="6" height="4" fill="#c9a24a"/></g>`,
    build() {
      const g = new THREE.Group();
      const blade = mat(0xc8202e);
      const black = mat(0x1a1016);
      box(g, 0.045, 0.045, 0.2, black, 0, 0, 0);
      box(g, 0.07, 0.07, 0.06, mat(GOLD), 0, 0, -0.12);
      // Bat-wing guard with a blood-red gem.
      box(g, 0.32, 0.04, 0.05, black, 0, 0, 0.12);
      box(g, 0.12, 0.04, 0.05, black, 0.17, 0, 0.09).rotation.y = 0.5;
      box(g, 0.12, 0.04, 0.05, black, -0.17, 0, 0.09).rotation.y = -0.5;
      box(g, 0.06, 0.06, 0.06, mat(0xff2a3a, true), 0, 0.02, 0.12);
      // A slim blade that curves toward the tip.
      box(g, 0.05, 0.018, 0.75, blade, 0, 0, 0.53);
      box(g, 0.045, 0.018, 0.3, blade, 0, 0.04, 1.02).rotation.x = -0.25;
      return g;
    },
  },
  {
    id: 'doomblade',
    value: 400,
    name: 'Doomblade',
    from: 'zomawi',
    description: 'Zomawi\'s greatsword. Huge reach and power; every hit heals you and every third swing slams the ground.',
    pips: { damage: 5, speed: 2, reach: 4 },
    swing: { damage: 1.75, dur: 1.15, reach: 0.7, arc: 0.15, knockback: 1.5, stamina: 1.25 },
    special: { slam: { radius: 5.5, share: 0.6 }, lifesteal: 0.1 },
    color: 0xffc23a,
    icon: `<g transform="rotate(45 32 32)"><path d="M27 42 L27 6 L32 0 L37 6 L37 42Z" fill="#3a3e48"/><rect x="27" y="6" width="2" height="36" fill="#b04aff"/><rect x="35" y="6" width="2" height="36" fill="#7aff5a"/><path d="M16 42 L48 42 L44 47 L20 47Z" fill="#c9a24a"/><rect x="30" y="47" width="4" height="10" fill="#2a1a16"/><circle cx="32" cy="59" r="3.5" fill="#b04aff"/></g>`,
    build() {
      const g = new THREE.Group();
      const steel = mat(0x3a3e48);
      box(g, 0.05, 0.05, 0.3, mat(0x2a1a16), 0, 0, 0);
      box(g, 0.1, 0.1, 0.08, mat(0xb04aff, true), 0, 0, -0.18);
      box(g, 0.46, 0.07, 0.08, mat(GOLD), 0, 0, 0.18);
      box(g, 0.08, 0.12, 0.08, mat(GOLD), 0.21, 0.04, 0.2);
      box(g, 0.08, 0.12, 0.08, mat(GOLD), -0.21, 0.04, 0.2);
      // A broad dark blade edged with witch-fire on one side and grave-light on the other.
      box(g, 0.14, 0.03, 1.4, steel, 0, 0, 0.92);
      box(g, 0.02, 0.035, 1.3, mat(0xb04aff, true), 0.07, 0, 0.9);
      box(g, 0.02, 0.035, 1.3, mat(0x7aff5a, true), -0.07, 0, 0.9);
      box(g, 0.09, 0.03, 0.14, steel, 0, 0, 1.66).rotation.y = Math.PI / 4;
      return g;
    },
  },
  {
    id: 'spear',
    name: 'Spear',
    from: null,
    shop: true,
    value: 60,
    description: 'Very long reach and quick, narrow thrusts. Hit enemies before they reach you.',
    pips: { damage: 2, speed: 4, reach: 5 },
    swing: { damage: 0.9, dur: 0.85, reach: 1.3, arc: -0.45, knockback: 0.9, stamina: 0.9 },
    special: {},
    color: 0x9ad0ff,
    icon: `<g transform="rotate(45 32 32)"><rect x="30.5" y="12" width="3" height="50" fill="#6a4426"/><path d="M32 0 L37 12 L27 12Z" fill="#d8dde3"/><rect x="28" y="12" width="8" height="3" fill="#c9a24a"/></g>`,
    build() {
      const g = new THREE.Group();
      box(g, 0.05, 0.05, 2.0, mat(0x6a4426), 0, 0, 0.55);
      box(g, 0.09, 0.09, 0.08, mat(GOLD), 0, 0, 1.55);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 4).rotateX(Math.PI / 2), mat(0xd8dde3));
      tip.position.z = 1.78;
      g.add(tip);
      return g;
    },
  },
  {
    id: 'daggers',
    name: 'Twin Daggers',
    from: null,
    shop: true,
    value: 80,
    offhand: true,
    description: 'A dagger in each hand. Super fast slashes: weak hits, but a lot of them.',
    pips: { damage: 1, speed: 5, reach: 1 },
    swing: { damage: 0.55, dur: 0.55, reach: -0.5, arc: 0.1, knockback: 0.5, stamina: 0.6 },
    special: {},
    color: 0xc8f0a0,
    icon: `<g transform="rotate(30 32 32)"><rect x="18" y="8" width="4" height="26" fill="#d8dde3"/><rect x="14" y="34" width="12" height="3" fill="#c9a24a"/><rect x="18.5" y="37" width="3" height="8" fill="#3a2a1a"/></g><g transform="rotate(-30 32 32)"><rect x="42" y="8" width="4" height="26" fill="#d8dde3"/><rect x="38" y="34" width="12" height="3" fill="#c9a24a"/><rect x="42.5" y="37" width="3" height="8" fill="#3a2a1a"/></g>`,
    build() {
      const g = new THREE.Group();
      box(g, 0.04, 0.04, 0.16, mat(0x3a2a1a), 0, 0, 0);
      box(g, 0.18, 0.04, 0.04, mat(GOLD), 0, 0, 0.09);
      box(g, 0.05, 0.015, 0.42, mat(0xd8dde3), 0, 0, 0.32);
      return g;
    },
  },
  {
    id: 'axe',
    name: 'Battle Axe',
    from: null,
    shop: true,
    value: 120,
    description: 'A big heavy axe with a wide swing that hits everyone around you.',
    pips: { damage: 4, speed: 2, reach: 3 },
    swing: { damage: 1.4, dur: 1.2, reach: 0.3, arc: 0.6, knockback: 1.4, stamina: 1.3 },
    special: {},
    color: 0xff9a4a,
    icon: `<g transform="rotate(35 32 32)"><rect x="30" y="8" width="4" height="54" fill="#6a4426"/><path d="M34 8 Q50 4 52 18 Q50 30 34 26Z" fill="#c8ccd2"/><path d="M30 8 Q18 10 16 17 Q18 24 30 24Z" fill="#a8acb2"/></g>`,
    build() {
      const g = new THREE.Group();
      box(g, 0.06, 0.06, 1.25, mat(0x6a4426), 0, 0, 0.4);
      box(g, 0.05, 0.42, 0.34, mat(0xc8ccd2), 0, 0.22, 0.88);
      box(g, 0.05, 0.22, 0.2, mat(0xa8acb2), 0, -0.14, 0.92);
      return g;
    },
  },
  {
    id: 'hammer',
    name: 'War Hammer',
    from: null,
    shop: true,
    value: 150,
    description: 'Slow, but every hit knocks enemies off their feet and sends them flying.',
    pips: { damage: 4, speed: 1, reach: 3 },
    swing: { damage: 1.5, dur: 1.35, reach: 0.2, arc: 0.1, knockback: 2.6, stamina: 1.4 },
    special: { stagger: true },
    color: 0xffd36b,
    icon: `<g transform="rotate(35 32 32)"><rect x="30" y="16" width="4" height="46" fill="#4a3020"/><rect x="18" y="4" width="28" height="14" rx="2" fill="#8a8e96"/><rect x="18" y="4" width="4" height="14" fill="#c9a24a"/><rect x="42" y="4" width="4" height="14" fill="#c9a24a"/></g>`,
    build() {
      const g = new THREE.Group();
      box(g, 0.06, 0.06, 1.2, mat(0x4a3020), 0, 0, 0.4);
      box(g, 0.5, 0.26, 0.26, mat(0x8a8e96), 0, 0, 1.0);
      box(g, 0.08, 0.28, 0.28, mat(GOLD), 0.23, 0, 1.0);
      box(g, 0.08, 0.28, 0.28, mat(GOLD), -0.23, 0, 1.0);
      return g;
    },
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w])) as Record<WeaponId, WeaponDef>;

export const STARTING_WEAPON: WeaponId = 'sword';

export function isWeaponId(id: unknown): id is WeaponId {
  return typeof id === 'string' && id in WEAPON_BY_ID;
}

/** The weapon a leader drops. */
export function weaponOf(leader: string): WeaponDef | undefined {
  return WEAPONS.find((w) => w.from === leader);
}

/** Full SVG markup for a weapon's icon. */
export function weaponIcon(w: WeaponDef) {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${w.icon}</svg>`;
}
