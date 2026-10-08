import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, mulberry32, smoothing } from './util';
import { HUMAN_CAMP, TERRITORIES, VILLAGE_RUINS, type OutpostDef, type TerritoryDef, type TerritoryId } from './layout';

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
  ...TERRITORIES.flatMap((t): [number, number, number][] => [
    ...t.outposts.map((o): [number, number, number] => [o.x, o.z, o.flatRadius]),
    [t.arena.x, t.arena.z, t.arena.r + 6],
    [t.gate.x, t.gate.z, 6],
  ]),
];

/** Terrain height: rolling hills, flattened around camps and arenas. */
export function heightAt(x: number, z: number): number {
  let flat = 1;
  for (const [fx, fz, r] of FLAT_ZONES) {
    const dx = x - fx;
    const dz = z - fz;
    const reach = r + 14;
    if (dx * dx + dz * dz < reach * reach) flat = Math.min(flat, smoothstep(r, reach, Math.hypot(dx, dz)));
  }
  if (flat === 0) return 0;
  const h =
    Math.sin(x * 0.045) * Math.cos(z * 0.038) * 3.2 +
    Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.09 + 0.7) * 1.3 +
    Math.sin((x + z) * 0.21) * 0.3;
  return h * flat;
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
  if (near(HUMAN_CAMP.x, HUMAN_CAMP.z, 22)) return true;
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
  scene.add(mesh);
  return mesh;
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
  for (const t of TERRITORIES) {
    for (const o of t.outposts) {
      const anim = addOutpostDecor(scene, rand, colliders, o);
      if (anim) animated.push(anim);
    }
  }
  const gates = {} as Record<TerritoryId, Gate>;
  for (const t of TERRITORIES) gates[t.id] = addArena(scene, rand, colliders, t);

  const gloom: Record<TerritoryId, number> = { zombie: 0, witch: 0, vampire: 0 };
  let time = 0;

  return {
    colliders,
    gates,
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
    },
  };
}

// ---------- Ground ----------

const GROUND_COLORS: Record<TerritoryId, [number, number, number]> = {
  // [base A, base B, patches]
  zombie: [0x6e6a42, 0x857b4c, 0x4e4232],
  witch: [0x3e5a48, 0x4d6650, 0x4a3a5a],
  vampire: [0x3e3a3c, 0x4a4446, 0x4a2a2e],
};
const ARENA_FLOOR: Record<TerritoryId, number> = { zombie: 0x48433b, witch: 0x2f3a2e, vampire: 0x55505c };

function createGround(rand: () => number) {
  let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, 150, 150);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
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
      dead.setColorAt(counts.dead, id === 'vampire' ? c.setHSL(0.98, 0.15, 0.1 + rand() * 0.06) : c.setHSL(0.08, 0.12, 0.22 + rand() * 0.1));
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
  // Neat rows around Gravedigger's Field, leaving the middle open for the fight.
  const field = zombie.outposts.find((o) => o.decor === 'graves')!;
  for (let row = -2; row <= 2; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = field.x + col * 2.2 + (rand() - 0.5) * 0.4;
      const z = field.z + row * 2.6 + (rand() - 0.5) * 0.4;
      if (Math.hypot(x - field.x, z - field.z) < 6.5) continue;
      spots.push([x, z]);
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
    slabs.setColorAt(i, c.setHSL(0.1, 0.04, 0.38 + rand() * 0.18));
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
    default:
      return null;
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
  vampire: { pillar: new THREE.BoxGeometry(1.6, 5.2, 1.6), pillarColor: 0x3e3a48, wallColor: 0x4e4a58, wallHeight: 3.4, barColor: 0x1e1a22 },
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
  const gateHalfAngle = 0.36;
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

/** Where the hero stands after respawning at a banner: just beside it. */
export function respawnPoint(banner: { x: number; z: number }) {
  return { x: banner.x - 1.5, z: banner.z - 2.5 };
}
