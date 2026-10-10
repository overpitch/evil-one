import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, mulberry32, smoothing } from './util';
import { FORT, HUMAN_CAMP, TERRITORIES, VAMPIRE_LAND, VILLAGE_RUINS, type OutpostDef, type ShopKind, type TerritoryDef, type TerritoryId } from './layout';
import { createHumanoid, type HumanoidLook } from './character';

export const WORLD_HALF = 150;

/** Solid circle (tree, rock, pillar). Inactive colliders are ignored. */
export interface Circle {
  x: number;
  z: number;
  r: number;
  active?: boolean;
}

/** Solid axis-aligned box (walls), given by center and half sizes. */
export interface Box {
  x: number;
  z: number;
  hw: number;
  hd: number;
}

export interface Colliders {
  circles: Circle[];
  boxes: Box[];
}

export interface Gate {
  open(): void;
  close(): void;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const dirX = (angle: number) => Math.sin(angle);
const dirZ = (angle: number) => Math.cos(angle);

/** Areas kept flat for camps, outposts and arenas: [x, z, radius]. */
const FLAT_ZONES: [number, number, number][] = [
  [HUMAN_CAMP.x, HUMAN_CAMP.z, 18],
  [FORT.x, FORT.z, FORT.hillTop],
  ...TERRITORIES.flatMap((t): [number, number, number][] => [
    ...t.outposts.map((o): [number, number, number] => [o.x, o.z, o.flatRadius]),
    [t.arena.x, t.arena.z, t.arena.r + 6],
    [t.gate.x, t.gate.z, 6],
  ]),
];

// ---------- The goo castle (the Vampire Lord's lair) ----------

/**
 * Castle Nightspire is full of goo. Its floor is a goo pool and its walls
 * drip with it; the gate at ground level is gone. A long stone stair outside
 * climbs to a bridge that crosses over the goo to a raised platform in the
 * middle, where the Vampire Lord waits. Goo slows and burns anyone who falls in.
 */
const CASTLE = VAMPIRE_LAND.arena;
/** Radius of the goo-free platform in the middle. */
export const CASTLE_PLATFORM_R = 9;
/** Height of the platform, bridge and the top of the stairs. */
const CASTLE_TOP = 4.5;
/** The bridge and stairs are this wide either side of the gate line. */
const BRIDGE_HALF = 2;
const STAIR_LEN = 14;
/** How deep heroes and enemies stand in the goo. */
const GOO_LEVEL = -0.35;
/** The goo's surface (the ground under the castle is at 0). */
const GOO_SURFACE = 0.08;
const castleUx = Math.sin(CASTLE.gateAngle);
const castleUz = Math.cos(CASTLE.gateAngle);

/** Position relative to the castle: distance from the center, along the gate line, and across it. */
function castleCoords(x: number, z: number) {
  const dx = x - CASTLE.x;
  const dz = z - CASTLE.z;
  return { d: Math.hypot(dx, dz), along: dx * castleUx + dz * castleUz, across: Math.abs(-dx * castleUz + dz * castleUx) };
}

/** Walkable height of the castle's structures, or null outside them. */
/** Two stairs climb out of the goo onto the platform, at the back left and back right. */
const GOO_STAIR_ANGLES = [CASTLE.gateAngle + (Math.PI * 2) / 3, CASTLE.gateAngle - (Math.PI * 2) / 3];
const GOO_STAIR_HALF = 1.3;
/** The goo stairs run from the wall (low end) in to the platform's edge (top). */
const GOO_STAIR_FOOT = CASTLE.r - 0.5;

/** Height on a goo stair at (x, z), or null if not on one. */
function gooStairHeight(x: number, z: number): number | null {
  const dx = x - CASTLE.x;
  const dz = z - CASTLE.z;
  for (const a of GOO_STAIR_ANGLES) {
    const along = dx * Math.sin(a) + dz * Math.cos(a);
    const across = Math.abs(-dx * Math.cos(a) + dz * Math.sin(a));
    if (across > GOO_STAIR_HALF || along < CASTLE_PLATFORM_R - 0.2 || along > GOO_STAIR_FOOT) continue;
    const k = (along - CASTLE_PLATFORM_R) / (GOO_STAIR_FOOT - CASTLE_PLATFORM_R);
    return CASTLE_TOP + (GOO_LEVEL - CASTLE_TOP) * Math.max(0, k);
  }
  return null;
}

function castleHeight(x: number, z: number): number | null {
  const { d, along, across } = castleCoords(x, z);
  if (d > CASTLE.r + STAIR_LEN + 2) return null;
  if (d <= CASTLE_PLATFORM_R) return CASTLE_TOP;
  const stair = gooStairHeight(x, z);
  if (stair !== null) return stair;
  if (across <= BRIDGE_HALF && along > 0) {
    if (along <= CASTLE.r + 0.8) return CASTLE_TOP; // the bridge, through the gap in the wall
    const k = (along - CASTLE.r - 0.8) / STAIR_LEN;
    if (k <= 1) return CASTLE_TOP + (terrainHeight(x, z) - CASTLE_TOP) * k; // the stairs down to the ground
  }
  if (d < CASTLE.r) return GOO_LEVEL;
  return null;
}

/** Keeps a camera inside the goo castle's walls while its hero is inside (the goo ring is narrow). */
export function keepCameraInCastle(cam: THREE.Vector3, hero: THREE.Vector3) {
  const limit = CASTLE.r - 0.9;
  if (Math.hypot(hero.x - CASTLE.x, hero.z - CASTLE.z) > limit) return;
  const dx = cam.x - CASTLE.x;
  const dz = cam.z - CASTLE.z;
  const d = Math.hypot(dx, dz);
  if (d <= limit) return;
  cam.x = CASTLE.x + (dx / d) * limit;
  cam.z = CASTLE.z + (dz / d) * limit;
  cam.y = Math.max(cam.y, heightAt(cam.x, cam.z) + 0.35);
}

/** In the goo pool at the bottom of the castle. */
export function inGoo(x: number, z: number) {
  const { d, along, across } = castleCoords(x, z);
  return d > CASTLE_PLATFORM_R + 0.3 && d < CASTLE.r && !(across <= BRIDGE_HALF && along > 0) && gooStairHeight(x, z) === null;
}

/**
 * A hero down in the goo can't climb the platform's sides or the bridge
 * (not even with a roll): the only way out is up the goo stairs.
 * Undoes the part of a move from (fromX, fromZ) that would climb out.
 */
export function blockGooClimb(fromX: number, fromZ: number, pos: THREE.Vector3) {
  // Down in the goo: low, inside the walls, and not on a stair.
  const inPit = heightAt(fromX, fromZ) < 1 && castleCoords(fromX, fromZ).d < CASTLE.r && gooStairHeight(fromX, fromZ) === null;
  if (!inPit) return;
  const climbs = (x: number, z: number) => {
    if (heightAt(x, z) < 1) return false;
    const stair = gooStairHeight(x, z);
    return stair === null || stair > 1.2; // onto a stair only at its foot
  };
  if (!climbs(pos.x, pos.z)) return;
  // Slide along the edge if possible, otherwise stay put.
  if (!climbs(pos.x, fromZ)) pos.z = fromZ;
  else if (!climbs(fromX, pos.z)) pos.x = fromX;
  else {
    pos.x = fromX;
    pos.z = fromZ;
  }
}

/** Height everything walks on: the terrain, or the goo castle's platform, bridge and stairs. */
export function heightAt(x: number, z: number): number {
  return castleHeight(x, z) ?? terrainHeight(x, z);
}

/** Terrain height: rolling hills, flattened around camps and arenas. */
function terrainHeight(x: number, z: number): number {
  let flat = 1;
  for (const [fx, fz, r] of FLAT_ZONES) {
    const dx = x - fx;
    const dz = z - fz;
    const reach = r + 14;
    if (dx * dx + dz * dz < reach * reach) flat = Math.min(flat, smoothstep(r, reach, Math.hypot(dx, dz)));
  }
  if (flat === 0) return fortHill(x, z);
  const h =
    Math.sin(x * 0.045) * Math.cos(z * 0.038) * 3.2 +
    Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.09 + 0.7) * 1.3 +
    Math.sin((x + z) * 0.21) * 0.3;
  return h * flat + fortHill(x, z);
}

/** Fort Victory's hill: flat on top, sloping gently down all around. */
function fortHill(x: number, z: number) {
  const d = Math.hypot(x - FORT.x, z - FORT.z);
  if (d >= FORT.hillFoot) return 0;
  return FORT.hillHeight * (1 - smoothstep(FORT.hillTop, FORT.hillFoot, d));
}

/** 0 outside a territory, 1 deep inside it. */
export function territoryWeight(t: TerritoryDef, x: number, z: number) {
  const { center } = t;
  return 1 - smoothstep(center.r - 20, center.r + 5, Math.hypot(x - center.x, z - center.z));
}

/** The territory a point mostly belongs to (if any) and how strongly. */
function biomeAt(x: number, z: number): { id: TerritoryId | null; weight: number } {
  let best: TerritoryId | null = null;
  let weight = 0;
  for (const t of TERRITORIES) {
    const w = territoryWeight(t, x, z);
    if (w > weight) {
      weight = w;
      best = t.id;
    }
  }
  return { id: best, weight };
}

/** Keeps scenery out of camps, outposts, gates and arenas. */
function nearLandmark(x: number, z: number) {
  const near = (px: number, pz: number, r: number) => Math.hypot(x - px, z - pz) < r;
  if (near(HUMAN_CAMP.x, HUMAN_CAMP.z, 22) || near(FORT.x, FORT.z, FORT.r + 8)) return true;
  return TERRITORIES.some(
    (t) =>
      t.outposts.some((o) => near(o.x, o.z, o.flatRadius - 1)) ||
      near(t.arena.x, t.arena.z, t.arena.r + 10) ||
      near(t.gate.x, t.gate.z, 7),
  );
}

/** Pushes a body out of solid scenery and keeps it inside the world. */
export function resolveColliders(pos: THREE.Vector3, radius: number, colliders: Colliders) {
  for (const c of colliders.circles) {
    if (c.active === false) continue;
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const min = radius + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const push = (min - d) / d;
      pos.x += dx * push;
      pos.z += dz * push;
    }
  }
  for (const b of colliders.boxes) {
    const cx = clamp(pos.x, b.x - b.hw, b.x + b.hw);
    const cz = clamp(pos.z, b.z - b.hd, b.z + b.hd);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > radius * radius) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x += (dx / d) * (radius - d);
      pos.z += (dz / d) * (radius - d);
    } else {
      // Center is inside the box: push out along the shallowest side.
      const ox = b.hw + radius - Math.abs(pos.x - b.x);
      const oz = b.hd + radius - Math.abs(pos.z - b.z);
      if (ox < oz) pos.x += Math.sign(pos.x - b.x || 1) * ox;
      else pos.z += Math.sign(pos.z - b.z || 1) * oz;
    }
  }
  const edge = WORLD_HALF - 3;
  pos.x = clamp(pos.x, -edge, edge);
  pos.z = clamp(pos.z, -edge, edge);
}

export function lambert(color: number | THREE.Color = 0xffffff, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
}

/** Adds a shadow-casting mesh at a world position, resting on the ground. */
function place(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, y = 0, rotY = 0) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, heightAt(x, z) + y, z);
  mesh.rotation.y = rotY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.mergeable = true;
  scene.add(mesh);
  return mesh;
}

/** Size of the map squares static scenery is merged within (so whole squares can still be skipped when off-screen). */
const MERGE_CELL = 60;

/**
 * Fewer draws for the Xbox: static scenery made with place() is merged,
 * per map square and color, into one mesh each. Pieces that move or blink
 * opt out by clearing `userData.mergeable`.
 */
function mergeStaticScenery(scene: THREE.Scene) {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const obj of scene.children) {
    if (!(obj instanceof THREE.Mesh) || !obj.userData.mergeable) continue;
    const m = obj.material;
    if (Array.isArray(m) || m.transparent) continue;
    let kind: string;
    if (m instanceof THREE.MeshLambertMaterial) kind = `l${m.color.getHex()}-${m.emissive.getHex()}`;
    else if (m instanceof THREE.MeshBasicMaterial) kind = `b${m.color.getHex()}`;
    else continue;
    const cell = `${Math.floor(obj.position.x / MERGE_CELL)},${Math.floor(obj.position.z / MERGE_CELL)}`;
    const key = `${kind}|${cell}|${obj.castShadow ? 1 : 0}${obj.receiveShadow ? 1 : 0}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(obj);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geos = list.map((mesh) => {
      mesh.updateMatrix();
      let geo = mesh.geometry.clone().applyMatrix4(mesh.matrix);
      if (geo.index) geo = geo.toNonIndexed();
      for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
      return geo;
    });
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, list[0].material);
    mesh.castShadow = list[0].castShadow;
    mesh.receiveShadow = list[0].receiveShadow;
    for (const old of list) scene.remove(old);
    scene.add(mesh);
  }
}

// ---------- Atmosphere ----------

interface Mood {
  sky: THREE.Color;
  fogNear: number;
  fogFar: number;
  hemi: number;
  sun: number;
  sunColor: THREE.Color;
}

const NORMAL: Mood = { sky: new THREE.Color(0x9fc6e8), fogNear: 50, fogFar: 170, hemi: 1.6, sun: 2.6, sunColor: new THREE.Color(0xfff1d6) };
const MOODS: Record<TerritoryId, Mood> = {
  zombie: { sky: new THREE.Color(0x7f8a7c), fogNear: 16, fogFar: 95, hemi: 1.05, sun: 1.4, sunColor: new THREE.Color(0xc9d6b8) },
  witch: { sky: new THREE.Color(0x6a5a82), fogNear: 14, fogFar: 85, hemi: 1.0, sun: 1.2, sunColor: new THREE.Color(0xd0b8f0) },
  vampire: { sky: new THREE.Color(0x262a44), fogNear: 18, fogFar: 100, hemi: 0.75, sun: 1.1, sunColor: new THREE.Color(0x9fb0ff) },
  fortress: { sky: new THREE.Color(0x2e1416), fogNear: 12, fogFar: 85, hemi: 0.7, sun: 1.0, sunColor: new THREE.Color(0xff9a7a) },
};

export type World = ReturnType<typeof createWorld>;

export function createWorld(scene: THREE.Scene) {
  const rand = mulberry32(1337);
  const colliders: Colliders = { circles: [], boxes: [] };

  const background = NORMAL.sky.clone();
  scene.background = background;
  const fog = new THREE.Fog(background, NORMAL.fogNear, NORMAL.fogFar);
  scene.fog = fog;

  const hemi = new THREE.HemisphereLight(0xdbeaff, 0x55663a, NORMAL.hemi);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(NORMAL.sunColor, NORMAL.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const sunOffset = new THREE.Vector3(30, 55, 18);

  scene.add(createGround(rand));
  addTrees(scene, rand, colliders);
  addRocks(scene, rand, colliders);
  addGravestones(scene, rand, colliders);
  addMushrooms(scene, rand);
  addPools(scene, rand);
  addSpires(scene, rand, colliders);
  const animated: ((time: number) => void)[] = [addCamp(scene, colliders)];
  addFort(scene, colliders);
  for (const t of TERRITORIES) {
    for (const o of t.outposts) {
      const anim = addOutpostDecor(scene, rand, colliders, o);
      if (anim) animated.push(anim);
    }
  }
  const gates = {} as Record<TerritoryId, Gate>;
  for (const t of TERRITORIES) gates[t.id] = addArena(scene, rand, colliders, t);
  const beforeCastle = scene.children.length;
  animated.push(addGooCastle(scene, rand));
  // The castle's stonework and goo don't move (only its bubbles do).
  for (const o of scene.children.slice(beforeCastle)) if (o instanceof THREE.Mesh && !o.userData.bubble) o.userData.mergeable = true;
  mergeStaticScenery(scene);
  const seal = addSeal(scene, TERRITORIES.find((t) => t.requires)!);

  const gloom: Record<TerritoryId, number> = { zombie: 0, witch: 0, vampire: 0, fortress: 0 };
  let time = 0;

  return {
    colliders,
    gates,
    /** The dome of red light over Zomawi's arena while the fortress is sealed. */
    seal,
    /** Real-time shadows on or off (Graphics: Low turns them off). */
    setShadows(on: boolean) {
      sun.castShadow = on;
    },
    /**
     * Follows the player with the sun's shadow camera and blends the sky,
     * fog and light toward each enemy land's mood.
     */
    update(focus: THREE.Vector3, dt: number, gloomTarget: Record<TerritoryId, number>) {
      time += dt;
      sun.position.copy(focus).add(sunOffset);
      sun.target.position.copy(focus);

      let total = 0;
      for (const t of TERRITORIES) {
        gloom[t.id] += (gloomTarget[t.id] - gloom[t.id]) * smoothing(1.5, dt);
        total += gloom[t.id];
      }
      const base = Math.max(0, 1 - total);
      background.copy(NORMAL.sky).multiplyScalar(base);
      sun.color.copy(NORMAL.sunColor).multiplyScalar(base);
      let fogNear = NORMAL.fogNear * base;
      let fogFar = NORMAL.fogFar * base;
      let hemiI = NORMAL.hemi * base;
      let sunI = NORMAL.sun * base;
      for (const t of TERRITORIES) {
        const w = gloom[t.id];
        const m = MOODS[t.id];
        background.r += m.sky.r * w;
        background.g += m.sky.g * w;
        background.b += m.sky.b * w;
        sun.color.r += m.sunColor.r * w;
        sun.color.g += m.sunColor.g * w;
        sun.color.b += m.sunColor.b * w;
        fogNear += m.fogNear * w;
        fogFar += m.fogFar * w;
        hemiI += m.hemi * w;
        sunI += m.sun * w;
      }
      const norm = Math.max(1, total);
      background.multiplyScalar(1 / norm);
      sun.color.multiplyScalar(1 / norm);
      fog.near = fogNear / norm;
      fog.far = fogFar / norm;
      hemi.intensity = hemiI / norm;
      sun.intensity = sunI / norm;

      for (const a of animated) a(time);
      seal.update(time);
    },
  };
}

// ---------- Ground ----------

const GROUND_COLORS: Record<TerritoryId, [number, number, number]> = {
  // [base A, base B, patches]
  zombie: [0x6e6a42, 0x857b4c, 0x4e4232],
  witch: [0x3e5a48, 0x4d6650, 0x4a3a5a],
  vampire: [0x3e3a3c, 0x4a4446, 0x4a2a2e],
  fortress: [0x2e2a2a, 0x3a3434, 0x4a1a1a], // ash and old blood
};
const ARENA_FLOOR: Record<TerritoryId, number> = { zombie: 0x48433b, witch: 0x2f3a2e, vampire: 0x55505c, fortress: 0x2a2228 };

function createGround(rand: () => number) {
  let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, 150, 150);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
  geo = geo.toNonIndexed(); // one color + normal per triangle = faceted low-poly look
  geo.computeVertexNormals();

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grassA = new THREE.Color(0x5b8c3a);
  const grassB = new THREE.Color(0x76a64a);
  const dirt = new THREE.Color(0x8a6b45);
  const mud = new THREE.Color(0x4e4232);
  const c = new THREE.Color();
  const biome = new THREE.Color();
  const patch = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    c.copy(grassA).lerp(grassB, rand());
    const { id, weight } = biomeAt(cx, cz);
    if (id) {
      const [a, b, pt] = GROUND_COLORS[id];
      biome.set(a).lerp(patch.set(b), rand());
      c.lerp(biome, weight);
      if (rand() < 0.12 * weight) c.lerp(patch.set(pt), 0.7);
    }
    c.multiplyScalar(1 - Math.max(cy, 0) * 0.025);

    // Packed dirt at the human camp, mud at outposts, paving in arenas.
    const campDirt = clamp((13 - Math.hypot(cx - HUMAN_CAMP.x, cz - HUMAN_CAMP.z)) / 4, 0, 1);
    if (campDirt > 0) c.lerp(dirt, campDirt * (0.75 + 0.25 * rand()));
    for (const t of TERRITORIES) {
      for (const o of t.outposts) {
        const k = clamp((o.flatRadius - 3 - Math.hypot(cx - o.x, cz - o.z)) / 4, 0, 1);
        if (k > 0) c.lerp(mud, k * (0.5 + 0.3 * rand()));
      }
      if (Math.hypot(cx - t.arena.x, cz - t.arena.z) < t.arena.r + 1) c.set(ARENA_FLOOR[t.id]).multiplyScalar(0.85 + rand() * 0.3);
    }
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const ground = new THREE.Mesh(geo, lambert(0xffffff, { vertexColors: true }));
  ground.receiveShadow = true;
  return ground;
}

// ---------- Scattered scenery ----------

function deadTreeGeometry() {
  return mergeGeometries([
    new THREE.CylinderGeometry(0.12, 0.26, 3.4, 5).translate(0, 1.7, 0),
    new THREE.CylinderGeometry(0.04, 0.09, 1.5, 4).translate(0, 0.75, 0).rotateZ(0.9).translate(0, 2.1, 0),
    new THREE.CylinderGeometry(0.04, 0.08, 1.2, 4).translate(0, 0.6, 0).rotateZ(-0.8).rotateY(1.3).translate(0, 2.6, 0),
    new THREE.CylinderGeometry(0.03, 0.07, 1.0, 4).translate(0, 0.5, 0).rotateX(0.7).rotateY(-0.6).translate(0, 3.0, 0),
  ])!;
}

/** A random spot in the open world (not in a landmark). */
function openSpot(rand: () => number, colliders: Colliders, spacing: number): [number, number] | null {
  const x = (rand() * 2 - 1) * (WORLD_HALF - 5);
  const z = (rand() * 2 - 1) * (WORLD_HALF - 5);
  if (nearLandmark(x, z)) return null;
  if (colliders.circles.some((o) => Math.hypot(o.x - x, o.z - z) < spacing)) return null;
  return [x, z];
}

function addTrees(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const max = 260;
  const pineTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 1.6, 6).translate(0, 0.8, 0), lambert(0x6b4a2f), max);
  const pineLow = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 2.6, 7).translate(0, 2.6, 0), lambert(), max);
  const pineHigh = new THREE.InstancedMesh(new THREE.ConeGeometry(1.05, 2.0, 7).translate(0, 3.7, 0), lambert(), max);
  const dead = new THREE.InstancedMesh(deadTreeGeometry(), lambert(), max);
  // Swamp trees: a leaning trunk under a heavy, drooping canopy.
  const swampTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.35, 2.6, 6).translate(0, 1.3, 0), lambert(0x3a2e26), max);
  const swampTop = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.7, 0).scale(1, 0.55, 1).translate(0, 3, 0), lambert(), max);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const counts = { pine: 0, dead: 0, swamp: 0 };
  for (let tries = 0; counts.pine + counts.dead + counts.swamp < max && tries < 8000; tries++) {
    const spot = openSpot(rand, colliders, 3.5);
    if (!spot) continue;
    const [x, z] = spot;
    const sc = 0.8 + rand() * 0.7;
    const { id, weight } = biomeAt(x, z);
    const lean = id === 'witch' ? 0.18 : 0;
    m.compose(p.set(x, heightAt(x, z) - 0.1, z), q.setFromEuler(e.set((rand() - 0.5) * lean, rand() * Math.PI * 2, (rand() - 0.5) * lean)), s.set(sc, sc * (0.9 + rand() * 0.3), sc));
    if (weight > 0.5 && id === 'witch') {
      swampTrunk.setMatrixAt(counts.swamp, m);
      swampTop.setMatrixAt(counts.swamp, m);
      swampTop.setColorAt(counts.swamp, c.setHSL(0.38 + rand() * 0.08, 0.3, 0.18 + rand() * 0.07));
      counts.swamp++;
    } else if (weight > 0.5) {
      dead.setMatrixAt(counts.dead, m);
      dead.setColorAt(
        counts.dead,
        id === 'vampire' || id === 'fortress' ? c.setHSL(0.98, 0.15, 0.1 + rand() * 0.06) : c.setHSL(0.08, 0.12, 0.22 + rand() * 0.1),
      );
      counts.dead++;
    } else {
      pineTrunk.setMatrixAt(counts.pine, m);
      pineLow.setMatrixAt(counts.pine, m);
      pineHigh.setMatrixAt(counts.pine, m);
      c.setHSL(0.29 + rand() * 0.07, 0.45, 0.24 + rand() * 0.08);
      pineLow.setColorAt(counts.pine, c);
      pineHigh.setColorAt(counts.pine, c.offsetHSL(0, 0, 0.03));
      counts.pine++;
    }
    colliders.circles.push({ x, z, r: 0.35 * sc });
  }
  pineTrunk.count = pineLow.count = pineHigh.count = counts.pine;
  dead.count = counts.dead;
  swampTrunk.count = swampTop.count = counts.swamp;
  for (const mesh of [pineTrunk, pineLow, pineHigh, dead, swampTrunk, swampTop]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function addRocks(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const max = 80;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), lambert(), max);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < max && tries < 5000; tries++) {
    const spot = openSpot(rand, colliders, 3);
    if (!spot) continue;
    const [x, z] = spot;
    const sx = 0.5 + rand() * 1.2;
    const sz = sx * (0.7 + rand() * 0.5);
    const sy = sx * (0.5 + rand() * 0.4);
    m.compose(p.set(x, heightAt(x, z) - 0.2 * sy, z), q.setFromEuler(e.set(rand() * 0.4, rand() * 6.3, rand() * 0.4)), s.set(sx, sy, sz));
    rocks.setMatrixAt(n, m);
    rocks.setColorAt(n, c.setHSL(0.08, 0.06, 0.42 + rand() * 0.14));
    colliders.circles.push({ x, z, r: Math.max(sx, sz) * 0.85 });
    n++;
  }
  rocks.count = n;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
}

/** Random point inside a territory, away from landmarks. */
function spotIn(t: TerritoryDef, rand: () => number, colliders: Colliders, spacing: number): [number, number] | null {
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * (t.center.r - 8);
  const x = t.center.x + Math.sin(a) * r;
  const z = t.center.z + Math.cos(a) * r;
  if (nearLandmark(x, z)) return null;
  if (spacing > 0 && colliders.circles.some((o) => Math.hypot(o.x - x, o.z - z) < spacing)) return null;
  return [x, z];
}

function addGravestones(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const zombie = TERRITORIES[0];
  const spots: [number, number][] = [];
  const dark = new Set<number>();
  // Neat rows around graveyard outposts, leaving the middle open for the fight.
  for (const t of TERRITORIES) {
    for (const field of t.outposts.filter((o) => o.decor === 'graves')) {
      for (let row = -2; row <= 2; row++) {
        for (let col = -4; col <= 4; col++) {
          const x = field.x + col * 2.2 + (rand() - 0.5) * 0.4;
          const z = field.z + row * 2.6 + (rand() - 0.5) * 0.4;
          if (Math.hypot(x - field.x, z - field.z) < 6.5) continue;
          if (t.id !== 'zombie') dark.add(spots.length);
          spots.push([x, z]);
        }
      }
    }
  }
  for (let tries = 0; spots.length < 110 && tries < 3000; tries++) {
    const spot = spotIn(zombie, rand, colliders, 1.6);
    if (spot) spots.push(spot);
  }

  const slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.85, 0.16).translate(0, 0.38, 0), lambert(), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  spots.forEach(([x, z], i) => {
    const sc = 0.8 + rand() * 0.5;
    m.compose(p.set(x, heightAt(x, z), z), q.setFromEuler(e.set((rand() - 0.5) * 0.35, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.3)), s.set(sc, sc, sc));
    slabs.setMatrixAt(i, m);
    slabs.setColorAt(i, dark.has(i) ? c.setHSL(0.75, 0.06, 0.2 + rand() * 0.1) : c.setHSL(0.1, 0.04, 0.38 + rand() * 0.18));
    colliders.circles.push({ x, z, r: 0.3 });
  });
  slabs.castShadow = true;
  slabs.receiveShadow = true;
  scene.add(slabs);
}

/** Glowing mushrooms all over the witch swamp. */
function addMushrooms(scene: THREE.Scene, rand: () => number) {
  const witch = TERRITORIES[1];
  const max = 180;
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 5).translate(0, 0.15, 0), lambert(0xd8d0c0), max);
  const caps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.28, 0), new THREE.MeshBasicMaterial(), max);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const empty: Colliders = { circles: [], boxes: [] };
  let n = 0;
  for (let tries = 0; n < max && tries < 2000; tries++) {
    const spot = spotIn(witch, rand, empty, 0);
    if (!spot) continue;
    // Clusters: a few around each spot.
    const [cx, cz] = spot;
    for (let k = 0; k < 4 && n < max; k++) {
      const x = cx + (rand() - 0.5) * 1.6;
      const z = cz + (rand() - 0.5) * 1.6;
      const sc = 0.6 + rand() * 1.2;
      m.compose(p.set(x, heightAt(x, z), z), q.identity(), s.set(sc, sc, sc));
      stems.setMatrixAt(n, m);
      caps.setMatrixAt(n, m);
      caps.setColorAt(n, rand() < 0.6 ? c.setHSL(0.48, 0.9, 0.62) : c.setHSL(0.8, 0.85, 0.68));
      n++;
    }
  }
  stems.count = caps.count = n;
  scene.add(stems, caps);
}

/** Murky pools in the swamp. */
function addPools(scene: THREE.Scene, rand: () => number) {
  const witch = TERRITORIES[1];
  const mat = lambert(0x22403e, { emissive: 0x081816 });
  const empty: Colliders = { circles: [], boxes: [] };
  let placed = 0;
  for (let tries = 0; placed < 14 && tries < 500; tries++) {
    const spot = spotIn(witch, rand, empty, 0);
    if (!spot) continue;
    const [x, z] = spot;
    const r = 2 + rand() * 3;
    // Only on flat ground so the water doesn't float or sink.
    const hs = [heightAt(x + r, z), heightAt(x - r, z), heightAt(x, z + r), heightAt(x, z - r), heightAt(x, z)];
    if (Math.max(...hs) - Math.min(...hs) > 0.35) continue;
    const pool = new THREE.Mesh(new THREE.CircleGeometry(r, 9).rotateX(-Math.PI / 2), mat);
    pool.position.set(x, Math.max(...hs) + 0.04, z);
    pool.receiveShadow = true;
    scene.add(pool);
    placed++;
  }
}

/** Jagged rock spires in the vampire hills. */
function addSpires(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const vampire = TERRITORIES[2];
  const max = 40;
  const spires = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0), lambert(), max);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < max && tries < 2000; tries++) {
    const spot = spotIn(vampire, rand, colliders, 4);
    if (!spot) continue;
    const [x, z] = spot;
    const w = 0.8 + rand() * 1.2;
    m.compose(p.set(x, heightAt(x, z) - 0.2, z), q.setFromEuler(e.set((rand() - 0.5) * 0.25, rand() * 6.3, (rand() - 0.5) * 0.25)), s.set(w, 3 + rand() * 5, w));
    spires.setMatrixAt(n, m);
    spires.setColorAt(n, c.setHSL(0.72, 0.08, 0.26 + rand() * 0.1));
    colliders.circles.push({ x, z, r: w * 0.8 });
    n++;
  }
  spires.count = n;
  spires.castShadow = true;
  spires.receiveShadow = true;
  scene.add(spires);
}

// ---------- Outposts ----------

/** A roofless ruined house: four broken walls with a doorway on the south side. */
function addRuin(scene: THREE.Scene, rand: () => number, colliders: Colliders, cx: number, cz: number, hw: number, hd: number, stoneColor = 0x7c766a) {
  const stone = lambert(stoneColor);
  const wood = lambert(0x5e4630);
  const t = 0.22; // half wall thickness
  const segment = (x: number, z: number, halfX: number, halfZ: number) => {
    const height = 1.1 + rand() * 1.6;
    place(scene, new THREE.BoxGeometry(halfX * 2, height, halfZ * 2), rand() < 0.75 ? stone : wood, x, z, height / 2 - 0.05);
    colliders.boxes.push({ x, z, hw: halfX, hd: halfZ });
  };
  // Each wall is split into chunks of different heights so it looks broken.
  const wallX = (z: number, from: number, to: number) => {
    const n = Math.max(1, Math.round((to - from) / 1.5));
    const len = (to - from) / n;
    for (let i = 0; i < n; i++) if (rand() > 0.15) segment(cx + from + len * (i + 0.5), cz + z, len / 2, t);
  };
  const wallZ = (x: number, from: number, to: number) => {
    const n = Math.max(1, Math.round((to - from) / 1.5));
    const len = (to - from) / n;
    for (let i = 0; i < n; i++) if (rand() > 0.15) segment(cx + x, cz + from + len * (i + 0.5), t, len / 2);
  };
  wallX(hd, -hw, hw);
  wallX(-hd, -hw, -0.8);
  wallX(-hd, 0.8, hw);
  wallZ(-hw, -hd, hd);
  wallZ(hw, -hd, hd);
}

/** Scenery for each outpost. Returns an animation callback if it has moving parts. */
function addOutpostDecor(scene: THREE.Scene, rand: () => number, colliders: Colliders, o: OutpostDef): ((time: number) => void) | null {
  switch (o.decor) {
    case 'ruins':
      for (const [ox, oz, hw, hd] of VILLAGE_RUINS) addRuin(scene, rand, colliders, o.x + ox, o.z + oz, hw, hd);
      return null;
    case 'bones': {
      const bone = lambert(0xe6dcc0);
      const boneGeo = new THREE.BoxGeometry(0.08, 0.08, 0.6);
      const skullGeo = new THREE.BoxGeometry(0.22, 0.2, 0.24);
      for (let pile = 0; pile < 7; pile++) {
        const a = (pile / 7) * Math.PI * 2 + rand();
        const r = 6 + rand() * 3;
        const px = o.x + Math.sin(a) * r;
        const pz = o.z + Math.cos(a) * r;
        for (let i = 0; i < 9; i++) {
          const mesh = place(scene, i % 4 === 0 ? skullGeo : boneGeo, bone, px + (rand() - 0.5) * 1.2, pz + (rand() - 0.5) * 1.2, 0.06 + rand() * 0.25);
          mesh.rotation.set(rand() * 0.6, rand() * Math.PI, rand() * 0.6);
        }
      }
      return null;
    }
    case 'mushrooms': {
      // Giant glowing toadstools ring the grove.
      const stem = lambert(0xd8d0c0);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rand() * 0.4;
        const r = 7 + rand() * 2.5;
        const x = o.x + Math.sin(a) * r;
        const z = o.z + Math.cos(a) * r;
        const sc = 2.5 + rand() * 2;
        place(scene, new THREE.CylinderGeometry(0.12 * sc, 0.16 * sc, 0.6 * sc, 7).translate(0, 0.3 * sc, 0), stem, x, z);
        const cap = place(
          scene,
          new THREE.SphereGeometry(0.42 * sc, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: rand() < 0.5 ? 0x5ae0d0 : 0xc070ff }),
          x,
          z,
          0.55 * sc,
        );
        cap.castShadow = true;
        colliders.circles.push({ x, z, r: 0.18 * sc });
      }
      return null;
    }
    case 'huts': {
      const wall = lambert(0x4a3a2e);
      const roof = lambert(0x3a2a3a);
      const huts: [number, number][] = [[-9, 6], [9, 7], [0, -10]];
      for (const [hx, hz] of huts) {
        const x = o.x + hx;
        const z = o.z + hz;
        place(scene, new THREE.BoxGeometry(3, 2.4, 3).translate(0, 1.2, 0), wall, x, z);
        const r = place(scene, new THREE.ConeGeometry(2.6, 2.4, 4).translate(0, 1.2, 0), roof, x, z, 2.3, Math.PI / 4);
        r.rotation.z = (rand() - 0.5) * 0.3; // crooked
        colliders.boxes.push({ x, z, hw: 1.5, hd: 1.5 });
      }
      // The cauldron, bubbling green.
      place(scene, new THREE.CylinderGeometry(0.85, 0.65, 0.9, 10).translate(0, 0.45, 0), lambert(0x1a1a1e), o.x, o.z + 0.5);
      const brew = place(scene, new THREE.CircleGeometry(0.75, 10).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7aff6a }), o.x, o.z + 0.5, 0.86);
      colliders.circles.push({ x: o.x, z: o.z + 0.5, r: 0.95 });
      brew.userData.mergeable = false; // it bubbles
      return (time) => brew.scale.setScalar(0.95 + Math.sin(time * 6) * 0.05);
    }
    case 'hangingWood': {
      // Gallows posts with glowing cages.
      const post = lambert(0x2e241e);
      const glow = new THREE.MeshBasicMaterial({ color: 0x9aff7a });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.3;
        const x = o.x + Math.sin(a) * 9;
        const z = o.z + Math.cos(a) * 9;
        place(scene, new THREE.BoxGeometry(0.22, 3.4, 0.22).translate(0, 1.7, 0), post, x, z);
        place(scene, new THREE.BoxGeometry(1.4, 0.16, 0.16), post, x + Math.sin(a + Math.PI / 2) * 0.6, z + Math.cos(a + Math.PI / 2) * 0.6, 3.3, a + Math.PI / 2);
        place(scene, new THREE.BoxGeometry(0.35, 0.45, 0.35), glow, x + Math.sin(a + Math.PI / 2) * 1.1, z + Math.cos(a + Math.PI / 2) * 1.1, 2.7);
        colliders.circles.push({ x, z, r: 0.3 });
      }
      return null;
    }
    case 'chapel': {
      const stone = 0x6a6470;
      addRuin(scene, rand, colliders, o.x, o.z + 9, 3.5, 3, stone);
      // Bell tower at the back.
      const tx = o.x;
      const tz = o.z + 12.5;
      place(scene, new THREE.BoxGeometry(2.4, 7, 2.4).translate(0, 3.5, 0), lambert(stone), tx, tz);
      place(scene, new THREE.ConeGeometry(2, 3, 4).translate(0, 1.5, 0), lambert(0x3a1a22), tx, tz, 7, Math.PI / 4);
      colliders.boxes.push({ x: tx, z: tz, hw: 1.2, hd: 1.2 });
      return null;
    }
    case 'mill': {
      addRuin(scene, rand, colliders, o.x - 8, o.z - 6, 3, 2.5, 0x6a5a5a);
      const tx = o.x + 8;
      const tz = o.z + 8;
      place(scene, new THREE.CylinderGeometry(1.6, 2.2, 7, 8).translate(0, 3.5, 0), lambert(0x6a5a5a), tx, tz);
      place(scene, new THREE.ConeGeometry(2, 2.2, 8).translate(0, 1.1, 0), lambert(0x4a1a1e), tx, tz, 7);
      const sails = new THREE.Group();
      const sailMat = lambert(0x8a2a2e);
      for (let i = 0; i < 4; i++) {
        const sail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.2, 0.08).translate(0, 2.1, 0), sailMat);
        sail.rotation.z = (i / 4) * Math.PI * 2;
        sail.castShadow = true;
        sails.add(sail);
      }
      // Face the sails toward the outpost.
      const toward = Math.atan2(o.x - tx, o.z - tz);
      sails.position.set(tx + Math.sin(toward) * 1.8, heightAt(tx, tz) + 5.5, tz + Math.cos(toward) * 1.8);
      sails.rotation.y = toward;
      scene.add(sails);
      colliders.circles.push({ x: tx, z: tz, r: 2.2 });
      return (time) => (sails.rotation.z = time * 0.4);
    }
    case 'pens': {
      // A fenced pen with gaps north and south.
      const wood = lambert(0x3a2a24);
      const hw = 7.5;
      const hd = 6.5;
      const rail = (x: number, z: number, halfX: number, halfZ: number) => {
        place(scene, new THREE.BoxGeometry(halfX * 2, 1.2, halfZ * 2).translate(0, 0.6, 0), wood, x, z);
        colliders.boxes.push({ x, z, hw: halfX, hd: halfZ });
      };
      rail(o.x - hw, o.z, 0.1, hd);
      rail(o.x + hw, o.z, 0.1, hd);
      for (const side of [-1, 1]) {
        rail(o.x - hw / 2 - 1, o.z + side * hd, hw / 2 - 1, 0.1);
        rail(o.x + hw / 2 + 1, o.z + side * hd, hw / 2 - 1, 0.1);
      }
      return null;
    }
    case 'spikes': {
      // Iron stakes and burning braziers before Zomawi's gate.
      const iron = lambert(0x2a2628);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        if (Math.abs(Math.sin(a)) < 0.3) continue; // keep the road north-south clear
        const x = o.x + Math.sin(a) * 11;
        const z = o.z + Math.cos(a) * 11;
        const stake = place(scene, new THREE.ConeGeometry(0.18, 2.6, 4).translate(0, 1.3, 0), iron, x, z);
        stake.rotation.z = Math.sin(a) * 0.25;
        colliders.circles.push({ x, z, r: 0.3 });
      }
      const flames: THREE.Mesh[] = [];
      for (const [bx, bz] of [[-6, 6], [6, 6], [-6, -6], [6, -6]] as [number, number][]) {
        const x = o.x + bx;
        const z = o.z + bz;
        place(scene, new THREE.CylinderGeometry(0.55, 0.3, 1.1, 7).translate(0, 0.55, 0), iron, x, z);
        flames.push(place(scene, new THREE.ConeGeometry(0.45, 1, 6).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xff5a2a }), x, z, 1.1));
        colliders.circles.push({ x, z, r: 0.6 });
      }
      for (const f of flames) f.userData.mergeable = false; // they flicker
      return (time) => flames.forEach((f, i) => f.scale.set(1, 1 + Math.sin(time * 15 + i * 2) * 0.15, 1));
    }
    default:
      return null;
  }
}

// ---------- Fort Victory ----------

/** Canopy color and shopkeeper for each stall. */
const STALL_LOOKS: Record<ShopKind, { canopy: number; keeper: HumanoidLook }> = {
  potions: { canopy: 0xb02a4a, keeper: { skin: 0xe8c39a, shirt: 0x6a2a8a, pants: 0x3a2a4a, boots: 0x2a1e16, eyes: 0x222222, belt: 0xd9b24a } },
  armory: { canopy: 0x6a7480, keeper: { skin: 0xc68e64, shirt: 0x4a4440, pants: 0x2e2a26, boots: 0x1e1814, eyes: 0x222222, belt: 0x5a3c22, armor: 0x9aa3ab } },
  weapons: { canopy: 0xc0702a, keeper: { skin: 0x8d5a3b, shirt: 0x5a3a2a, pants: 0x3a2e26, boots: 0x221c18, eyes: 0x222222, belt: 0x2a2018 } },
  barracks: { canopy: 0x2a4f9a, keeper: { skin: 0xf1c9a5, shirt: 0xa3262a, pants: 0x3a3f4a, boots: 0x3b2a1e, eyes: 0x222222, belt: 0x5a3c22, armor: 0xb8c0c8, plume: 0xd23a2a } },
};

/** Fort Victory: stone walls on the hilltop, a gate toward the camp, and four shop stalls. */
function addFort(scene: THREE.Scene, colliders: Colliders) {
  const { x: fx, z: fz, r, gateAngle } = FORT;
  const stone = lambert(0x9a9488);
  const darkStone = lambert(0x7a746a);
  const gateHalf = 0.22;
  const inGate = (a: number) => Math.abs(Math.atan2(Math.sin(a - gateAngle), Math.cos(a - gateAngle))) < gateHalf;

  // Walls with square towers, broken by the gate.
  const segments = 28;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    const mid = (a + a2) / 2;
    if (!inGate(mid)) {
      const len = 2 * r * Math.sin(Math.PI / segments) + 0.3;
      place(scene, new THREE.BoxGeometry(len, 3.6, 0.9), stone, fx + Math.sin(mid) * r, fz + Math.cos(mid) * r, 1.8, mid);
      // Battlements along the top.
      place(scene, new THREE.BoxGeometry(len * 0.45, 0.6, 1), stone, fx + Math.sin(mid) * r, fz + Math.cos(mid) * r, 3.9, mid);
    }
    if (i % 7 === 3) place(scene, new THREE.BoxGeometry(2.6, 6, 2.6), darkStone, fx + Math.sin(a) * r, fz + Math.cos(a) * r, 3, a);
  }
  for (let i = 0; i < 112; i++) {
    const a = (i / 112) * Math.PI * 2;
    if (!inGate(a)) colliders.circles.push({ x: fx + Math.sin(a) * r, z: fz + Math.cos(a) * r, r: 0.6 });
  }
  // Gate towers with gold-topped flags.
  for (const side of [-1, 1]) {
    const a = gateAngle + side * (gateHalf + 0.06);
    const gx = fx + Math.sin(a) * r;
    const gz = fz + Math.cos(a) * r;
    place(scene, new THREE.BoxGeometry(2.4, 7, 2.4), darkStone, gx, gz, 3.5, a);
    place(scene, new THREE.ConeGeometry(1.9, 2.2, 4).translate(0, 1.1, 0), lambert(0xa3262a), gx, gz, 7, a + Math.PI / 4);
    place(scene, new THREE.OctahedronGeometry(0.3, 0), lambert(0xd9b24a), gx, gz, 9.5);
    colliders.circles.push({ x: gx, z: gz, r: 1.5 });
  }
  // A stone arch over the gate.
  const ax = fx + Math.sin(gateAngle) * r;
  const az = fz + Math.cos(gateAngle) * r;
  place(scene, new THREE.BoxGeometry(2 * r * Math.sin(gateHalf) + 1, 1, 1.2), darkStone, ax, az, 5.4, gateAngle);

  // The shops: a counter under a colored canopy, with a shopkeeper behind it.
  for (const stall of FORT.stalls) {
    const look = STALL_LOOKS[stall.kind];
    const g = new THREE.Group();
    g.position.set(stall.x, heightAt(stall.x, stall.z), stall.z);
    g.rotation.y = stall.angle; // local -Z faces the fort's middle
    const wood = lambert(0x6a4a2e);
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(3, 1.1, 0.8), wood, 0, 0.55, -1.9);
    add(new THREE.BoxGeometry(3.2, 0.12, 1), lambert(look.canopy), 0, 1.16, -1.9);
    for (const px of [-1.5, 1.5]) for (const pz of [-2.3, 1.1]) add(new THREE.BoxGeometry(0.16, 2.8, 0.16), wood, px, 1.4, pz);
    const canopy = add(new THREE.BoxGeometry(3.6, 0.2, 4), lambert(look.canopy), 0, 2.9, -0.6);
    canopy.rotation.x = -0.12;
    add(new THREE.BoxGeometry(3.4, 2.4, 0.15), wood, 0, 1.4, 1.2); // back wall
    // Goods on the counter.
    if (stall.kind === 'potions') {
      [0xff3a4a, 0x3aff6a, 0x5a8aff, 0xff3a4a].forEach((c, i) =>
        add(new THREE.CylinderGeometry(0.1, 0.13, 0.32, 6), new THREE.MeshBasicMaterial({ color: c }), -0.9 + i * 0.6, 1.38, -1.9),
      );
    } else if (stall.kind === 'armory') {
      add(new THREE.BoxGeometry(0.6, 0.7, 0.35), lambert(0x9aa3ab), -0.7, 1.6, -1.9);
      add(new THREE.BoxGeometry(0.4, 0.3, 0.4), lambert(0x9aa3ab), 0.7, 1.4, -1.9);
    } else if (stall.kind === 'weapons') {
      for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.08, 1.4, 0.05), lambert(0xd8dde3), -0.6 + i * 0.6, 1.9, 1.05).rotation.z = 0.15;
    } else {
      add(new THREE.BoxGeometry(0.06, 2, 0.06), wood, 1.2, 2.2, -1.9);
      add(new THREE.BoxGeometry(0.7, 0.5, 0.04), lambert(0xa3262a), 1.55, 2.9, -1.9);
    }
    scene.add(g);
    // The shopkeeper, facing the customers.
    const keeper = createHumanoid(look.keeper);
    keeper.root.position.set(stall.x, heightAt(stall.x, stall.z), stall.z);
    keeper.root.rotation.y = stall.angle + Math.PI;
    keeper.armR.rotation.x = -0.4;
    keeper.armL.rotation.x = -0.4;
    scene.add(keeper.root);
    // The counter is solid.
    const ux = Math.sin(stall.angle);
    const uz = Math.cos(stall.angle);
    for (const off of [-1, 0, 1]) {
      colliders.circles.push({ x: stall.counter.x + uz * off * 1.1, z: stall.counter.z - ux * off * 1.1, r: 0.6 });
    }
    colliders.circles.push({ x: stall.x, z: stall.z, r: 1.6 });
  }
}

// ---------- Human camp ----------

/** The human army's camp: tents, crates and a campfire. */
function addCamp(scene: THREE.Scene, colliders: Colliders) {
  const canvas = lambert(0xd8cfb4);
  const tents: [number, number, number][] = [[-9, 4, 0.3], [9, 3, -0.4], [-9, -8, 0.9], [11, -7, -0.9]];
  for (const [x, z, rot] of tents) {
    place(scene, new THREE.ConeGeometry(2.1, 2.5, 4).translate(0, 1.25, 0), canvas, x, z, 0, Math.PI / 4 + rot);
    colliders.circles.push({ x, z, r: 1.6 });
  }
  const crate = lambert(0x7a5a36);
  for (const [x, z] of [[-6, 6], [-5.2, 6.4], [6.5, -3], [7.2, -2.4]] as [number, number][]) {
    place(scene, new THREE.BoxGeometry(0.8, 0.8, 0.8), crate, x, z, 0.4, x * 0.7);
    colliders.circles.push({ x, z, r: 0.5 });
  }

  // Campfire
  const fx = 0;
  const fz = 5;
  const fire = new THREE.Group();
  fire.position.set(fx, heightAt(fx, fz), fz);
  const stoneMat = lambert(0x6d6a64);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), stoneMat);
    s.position.set(Math.sin(a) * 0.75, 0.1, Math.cos(a) * 0.75);
    fire.add(s);
  }
  const logMat = lambert(0x4a3220);
  for (const r of [0.5, -0.6, 2]) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 5), logMat);
    log.rotation.set(Math.PI / 2, r, 0);
    log.position.y = 0.12;
    fire.add(log);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 6).translate(0, 0.45, 0), new THREE.MeshBasicMaterial({ color: 0xffa23a }));
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.55, 5).translate(0, 0.28, 0), new THREE.MeshBasicMaterial({ color: 0xfff0a0 }));
  flame.position.y = core.position.y = 0.1;
  fire.add(flame, core);
  const light = new THREE.PointLight(0xff8a3a, 12, 14, 1.6);
  light.position.y = 1.2;
  fire.add(light);
  scene.add(fire);
  colliders.circles.push({ x: fx, z: fz, r: 0.9 });

  return (time: number) => {
    const flicker = 1 + Math.sin(time * 17) * 0.08 + Math.sin(time * 29 + 1) * 0.06;
    flame.scale.set(1, flicker, 1);
    flame.rotation.y = time * 2;
    core.scale.set(1, 2 - flicker, 1);
    light.intensity = 12 * flicker;
  };
}

// ---------- Leader arenas ----------

interface ArenaStyle {
  pillar: THREE.BufferGeometry;
  pillarColor: number;
  wallColor: number;
  wallHeight: number;
  barColor: number;
}

const ARENA_STYLES: Record<TerritoryId, ArenaStyle> = {
  zombie: { pillar: new THREE.BoxGeometry(1, 3.4, 1), pillarColor: 0x3f3b36, wallColor: 0x5d5850, wallHeight: 1.7, barColor: 0xd9cfb0 },
  // Standing stones linked by bramble hedges.
  witch: { pillar: new THREE.BoxGeometry(1.2, 4.4, 0.8), pillarColor: 0x56605a, wallColor: 0x24301f, wallHeight: 1.8, barColor: 0x3a2a4a },
  // A castle courtyard: tall walls and square towers.
  vampire: { pillar: new THREE.BoxGeometry(1.6, 7.6, 1.6), pillarColor: 0x3e3a48, wallColor: 0x4e4a58, wallHeight: 6.4, barColor: 0x1e1a22 },
  // Black obsidian and iron.
  fortress: { pillar: new THREE.BoxGeometry(1.8, 6.5, 1.8), pillarColor: 0x1a161e, wallColor: 0x2a2630, wallHeight: 3.8, barColor: 0x6a1a2a },
};

/**
 * A leader's walled arena with a gate facing the human camp, and a
 * landmark behind it (crypt, hex tree or castle keep). The gate slams shut
 * when the fight starts.
 */
function addArena(scene: THREE.Scene, rand: () => number, colliders: Colliders, t: TerritoryDef): Gate {
  const { x: ax, z: az, r, gateAngle } = t.arena;
  const style = ARENA_STYLES[t.id];
  const pillarMat = lambert(style.pillarColor);
  const wallMat = lambert(style.wallColor);
  // The goo castle's only way in is the bridge, so its gap is just the bridge's width.
  const gateHalfAngle = t.id === 'vampire' ? Math.asin((BRIDGE_HALF + 0.3) / r) : 0.36;
  const inGateGap = (a: number) => Math.abs(Math.atan2(Math.sin(a - gateAngle), Math.cos(a - gateAngle))) < gateHalfAngle;

  // The wall: dense circle colliders around the ring, except the gate.
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    if (!inGateGap(a)) colliders.circles.push({ x: ax + dirX(a) * r, z: az + dirZ(a) * r, r: 0.55 });
  }
  const pillars = 24;
  for (let i = 0; i < pillars; i++) {
    const a = (i / pillars) * Math.PI * 2;
    const a2 = ((i + 1) / pillars) * Math.PI * 2;
    if (inGateGap(a)) continue;
    const px = ax + dirX(a) * r;
    const pz = az + dirZ(a) * r;
    const h = (style.pillar as THREE.BoxGeometry).parameters.height;
    const pillar = place(scene, style.pillar, pillarMat, px, pz, h / 2, a);
    if (t.id === 'witch') pillar.rotation.z = (rand() - 0.5) * 0.15;
    if (inGateGap(a2)) continue;
    const mx = ax + dirX((a + a2) / 2) * r;
    const mz = az + dirZ((a + a2) / 2) * r;
    const len = 2 * r * Math.sin(Math.PI / pillars);
    place(scene, new THREE.BoxGeometry(len, style.wallHeight, 0.6), wallMat, mx, mz, style.wallHeight / 2, (a + a2) / 2);
  }

  addArenaLandmark(scene, colliders, t);

  // Gate bars, hidden until the fight starts.
  const gate = new THREE.Group();
  const barMat = lambert(style.barColor);
  const gateColliders: Circle[] = [];
  const bars = 12;
  for (let i = 0; i <= bars; i++) {
    const a = gateAngle - gateHalfAngle + (i / bars) * gateHalfAngle * 2;
    const bx = ax + dirX(a) * r;
    const bz = az + dirZ(a) * r;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3, 0.22), barMat);
    bar.position.set(bx, heightAt(bx, bz) + 1.5, bz);
    bar.castShadow = true;
    gate.add(bar);
    const c: Circle = { x: bx, z: bz, r: 0.5, active: false };
    gateColliders.push(c);
    colliders.circles.push(c);
  }
  gate.visible = false;
  scene.add(gate);

  return {
    close() {
      gate.visible = true;
      for (const c of gateColliders) c.active = true;
    },
    open() {
      gate.visible = false;
      for (const c of gateColliders) c.active = false;
    },
  };
}

/** The goo pool, dripping walls, raised platform, bridge and stairs of the Vampire Lord's castle. Returns its animation. */
function addGooCastle(scene: THREE.Scene, rand: () => number) {
  const { x: cx, z: cz, r } = CASTLE;
  const gooMat = new THREE.MeshLambertMaterial({ color: 0x4adf2a, emissive: 0x1a6a0a, flatShading: true });
  const stone = lambert(0x55505c);
  const darkStone = lambert(0x3e3a48);

  // The goo pool fills the castle floor around the platform.
  const pool = new THREE.Mesh(new THREE.CircleGeometry(r - 0.2, 40).rotateX(-Math.PI / 2), gooMat);
  // Its surface sits just above the ground; anyone wading in sinks up to the shins.
  pool.position.set(cx, GOO_SURFACE, cz);
  scene.add(pool);

  // Goo running down the inside of the walls.
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + rand() * 0.1;
    const { along, across } = castleCoords(cx + Math.sin(a) * r, cz + Math.cos(a) * r);
    if (across < BRIDGE_HALF + 1 && along > 0) continue;
    const h = 2.5 + rand() * 3.5;
    const drip = new THREE.Mesh(new THREE.BoxGeometry(0.5 + rand() * 0.9, h, 0.18), gooMat);
    drip.position.set(cx + Math.sin(a) * (r - 0.4), GOO_LEVEL + h / 2, cz + Math.cos(a) * (r - 0.4));
    drip.rotation.y = a;
    scene.add(drip);
  }

  // The platform: a round stone tower rising out of the goo.
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(CASTLE_PLATFORM_R, CASTLE_PLATFORM_R + 0.4, CASTLE_TOP - GOO_LEVEL, 32), darkStone);
  platform.position.set(cx, (CASTLE_TOP + GOO_LEVEL) / 2, cz);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(CASTLE_PLATFORM_R - 0.1, CASTLE_PLATFORM_R - 0.1, 0.06, 32), stone);
  top.position.set(cx, CASTLE_TOP + 0.01, cz);
  platform.castShadow = top.receiveShadow = platform.receiveShadow = true;
  scene.add(platform, top);

  // The bridge over the goo, through the wall, and the stairs down to the ground outside.
  const yaw = Math.atan2(castleUx, castleUz);
  const bridgeLen = r + 0.8 - CASTLE_PLATFORM_R + 0.5;
  const bridgeMid = CASTLE_PLATFORM_R - 0.5 + bridgeLen / 2;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(BRIDGE_HALF * 2, 0.6, bridgeLen), stone);
  bridge.position.set(cx + castleUx * bridgeMid, CASTLE_TOP - 0.3, cz + castleUz * bridgeMid);
  bridge.rotation.y = yaw;
  bridge.castShadow = bridge.receiveShadow = true;
  scene.add(bridge);
  const steps = 18;
  for (let i = 0; i < steps; i++) {
    const along = r + 0.8 + ((i + 0.5) / steps) * STAIR_LEN;
    const sx = cx + castleUx * along;
    const sz = cz + castleUz * along;
    const h = Math.max(0.2, heightAt(sx, sz) - terrainHeight(sx, sz)) + 0.6;
    const step = new THREE.Mesh(new THREE.BoxGeometry(BRIDGE_HALF * 2, h, STAIR_LEN / steps + 0.02), i % 2 ? stone : darkStone);
    step.position.set(sx, terrainHeight(sx, sz) + h / 2 - 0.6 + 0.02, sz);
    step.rotation.y = yaw;
    step.castShadow = step.receiveShadow = true;
    scene.add(step);
  }

  // Stairs out of the goo, up to the platform, in pale stone so they're easy to spot.
  const gooSteps = 9;
  const paleA = lambert(0x9a94a6);
  const paleB = lambert(0x7e7890);
  for (const a of GOO_STAIR_ANGLES) {
    for (let i = 0; i < gooSteps; i++) {
      const along = CASTLE_PLATFORM_R + ((i + 0.5) / gooSteps) * (GOO_STAIR_FOOT - CASTLE_PLATFORM_R);
      const sx = cx + Math.sin(a) * along;
      const sz = cz + Math.cos(a) * along;
      const top = (gooStairHeight(sx, sz) ?? 0) + 0.02;
      const h = top - GOO_LEVEL + 0.3;
      const step = new THREE.Mesh(new THREE.BoxGeometry(GOO_STAIR_HALF * 2, h, (GOO_STAIR_FOOT - CASTLE_PLATFORM_R) / gooSteps + 0.02), i % 2 ? paleA : paleB);
      step.position.set(sx, top - h / 2, sz);
      step.rotation.y = a;
      step.castShadow = step.receiveShadow = true;
      scene.add(step);
    }
  }

  // Close the wall up to the bridge on both sides, so the bridge is the only way in.
  const wallMat = lambert(ARENA_STYLES.vampire.wallColor);
  const wallH = ARENA_STYLES.vampire.wallHeight;
  const gapHalf = Math.asin((BRIDGE_HALF + 0.3) / r);
  for (const side of [-1, 1]) {
    const a0 = CASTLE.gateAngle + side * gapHalf;
    const a1 = CASTLE.gateAngle + side * ((Math.PI * 2) / 24);
    const mid = (a0 + a1) / 2;
    const len = 2 * r * Math.sin(Math.abs(a1 - a0) / 2) + 0.4;
    place(scene, new THREE.BoxGeometry(len, wallH, 0.6), wallMat, cx + Math.sin(mid) * r, cz + Math.cos(mid) * r, wallH / 2 + GOO_LEVEL, mid);
  }

  // Bubbles that swell and pop on the goo.
  const bubbleGeo = new THREE.SphereGeometry(0.35, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  const bubbles: { mesh: THREE.Mesh; phase: number; speed: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const d = CASTLE_PLATFORM_R + 1 + rand() * (r - CASTLE_PLATFORM_R - 2);
    const bx = cx + Math.sin(a) * d;
    const bz = cz + Math.cos(a) * d;
    if (!inGoo(bx, bz)) continue;
    const mesh = new THREE.Mesh(bubbleGeo, gooMat);
    mesh.userData.bubble = true;
    mesh.position.set(bx, GOO_SURFACE, bz);
    scene.add(mesh);
    bubbles.push({ mesh, phase: rand(), speed: 0.3 + rand() * 0.4 });
  }
  return (time: number) => {
    for (const b of bubbles) {
      const k = (time * b.speed + b.phase) % 1;
      b.mesh.scale.setScalar(0.2 + k * 1.3);
      b.mesh.visible = k < 0.92;
    }
    gooMat.emissive.setRGB(0.1, 0.38 + Math.sin(time * 1.3) * 0.08, 0.04);
  };
}

/** The structure behind each arena, opposite the gate. */
function addArenaLandmark(scene: THREE.Scene, colliders: Colliders, t: TerritoryDef) {
  const { x: ax, z: az, r, gateAngle } = t.arena;
  const back = gateAngle + Math.PI;
  const bx = ax + dirX(back) * (r + 4.5);
  const bz = az + dirZ(back) * (r + 4.5);
  // Its front faces the arena center.
  const facing = gateAngle - Math.PI;
  const sideways = Math.abs(Math.sin(facing)) > 0.5;
  const box = (hw: number, hd: number) => colliders.boxes.push({ x: bx, z: bz, hw: sideways ? hd : hw, hd: sideways ? hw : hd });
  const group = new THREE.Group();
  group.position.set(bx, heightAt(bx, bz), bz);
  group.rotation.y = facing;

  if (t.id === 'zombie') {
    // The crypt, and the king's throne in front of it.
    const dark = lambert(0x3f3b36);
    const body = new THREE.Mesh(new THREE.BoxGeometry(9, 5, 6), dark);
    body.position.y = 2.5;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 3, 4), lambert(0x5d5850));
    roof.position.y = 6.5;
    roof.rotation.y = Math.PI / 4;
    roof.scale.z = 0.7;
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.4, 0.2), new THREE.MeshBasicMaterial({ color: 0x0c0a08 }));
    door.position.set(0, 1.7, -3.05);
    group.add(body, roof, door);
    box(4.5, 3);
    const tx = t.throne.x + dirX(back) * 2.5;
    const tz = t.throne.z + dirZ(back) * 2.5;
    const throne = new THREE.Group();
    const stone = lambert(0x5d5850);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 1.6), stone);
    seat.position.y = 0.6;
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.6, 0.5), stone);
    backrest.position.set(0, 1.8, 0.6);
    throne.add(seat, backrest);
    throne.position.set(tx, heightAt(tx, tz), tz);
    throne.rotation.y = facing;
    throne.traverse((o) => (o.castShadow = true));
    scene.add(throne);
    colliders.circles.push({ x: tx, z: tz, r: 1.2 });
  } else if (t.id === 'witch') {
    // A vast hex tree with a glowing hollow.
    const bark = lambert(0x2a221e);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.4, 9, 7), bark);
    trunk.position.y = 4.5;
    group.add(trunk);
    for (let i = 0; i < 6; i++) {
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.5, 5, 5).translate(0, 2.5, 0), bark);
      branch.position.y = 7 + (i % 2);
      branch.rotation.set(0.9, (i / 6) * Math.PI * 2, 0, 'YXZ');
      group.add(branch);
    }
    const hollow = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2, 0.3), new THREE.MeshBasicMaterial({ color: 0xb070ff }));
    hollow.position.set(0, 2, -1.75);
    group.add(hollow);
    colliders.circles.push({ x: bx, z: bz, r: 2.4 });
  } else if (t.id === 'fortress') {
    // Zomawi's black spire with a burning crystal at its tip...
    const obsidian = lambert(0x16121a);
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 3, 24, 6), obsidian);
    spire.position.y = 12;
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(1.4, 0), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
    crystal.position.y = 25.5;
    crystal.scale.y = 1.6;
    group.add(spire, crystal);
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.9, 9, 5), obsidian);
      horn.position.set(side * 3.5, 5, 0);
      horn.rotation.z = -side * 0.35;
      group.add(horn);
    }
    colliders.circles.push({ x: bx, z: bz, r: 3 });
    // ...a throne inside the arena...
    const tx = t.throne.x + dirX(back) * 2.5;
    const tz = t.throne.z + dirZ(back) * 2.5;
    const throne = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 2), obsidian);
    seat.position.y = 0.7;
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 0.6), obsidian);
    backrest.position.set(0, 2.5, 0.7);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
    gem.position.set(0, 4.4, 0.35);
    throne.add(seat, backrest, gem);
    throne.position.set(tx, heightAt(tx, tz), tz);
    throne.rotation.y = facing;
    throne.traverse((o) => (o.castShadow = true));
    scene.add(throne);
    colliders.circles.push({ x: tx, z: tz, r: 1.6 });
    // ...and watchtowers flanking the arena.
    const towerMat = lambert(0x2a2630);
    for (const side of [-1, 1]) {
      const wx = ax + side * (r + 5);
      const wz = az + 4;
      place(scene, new THREE.CylinderGeometry(2.2, 2.6, 14, 8).translate(0, 7, 0), towerMat, wx, wz);
      place(scene, new THREE.ConeGeometry(2.8, 4, 8).translate(0, 2, 0), lambert(0x3a0a12), wx, wz, 14);
      colliders.circles.push({ x: wx, z: wz, r: 2.6 });
    }
  } else {
    // Castle Nightspire's keep: a tall hall flanked by towers.
    const stone = lambert(0x3e3a48);
    const roofMat = lambert(0x5a0f1e);
    const keep = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 6), stone);
    keep.position.y = 4.5;
    const keepRoof = new THREE.Mesh(new THREE.ConeGeometry(7.5, 4, 4), roofMat);
    keepRoof.position.y = 11;
    keepRoof.rotation.y = Math.PI / 4;
    keepRoof.scale.z = 0.55;
    group.add(keep, keepRoof);
    for (const side of [-1, 1]) {
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2, 13, 8), stone);
      tower.position.set(side * 7, 6.5, 0);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(2.3, 4, 8), roofMat);
      cap.position.set(side * 7, 15, 0);
      group.add(tower, cap);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(3, 4.5, 0.2), new THREE.MeshBasicMaterial({ color: 0x0a0608 }));
    door.position.set(0, 2.25, -3.05);
    const glowWindow = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2, 0.2), new THREE.MeshBasicMaterial({ color: 0xff4a3a }));
    glowWindow.position.set(0, 6.5, -3.05);
    group.add(door, glowWindow);
    box(9, 3);
  }
  group.traverse((o) => (o.castShadow = true));
  scene.add(group);
}

/** A shimmering dome over a sealed arena. */
function addSeal(scene: THREE.Scene, t: TerritoryDef) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(t.arena.r + 2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.position.set(t.arena.x, heightAt(t.arena.x, t.arena.z) - 0.5, t.arena.z);
  scene.add(dome);
  return {
    set(sealed: boolean) {
      dome.visible = sealed;
    },
    update(time: number) {
      mat.opacity = 0.14 + Math.sin(time * 1.5) * 0.05;
    },
  };
}

/** Where the hero stands after respawning at a banner: just beside it. */
export function respawnPoint(banner: { x: number; z: number }) {
  return { x: banner.x - 1.5, z: banner.z - 2.5 };
}
