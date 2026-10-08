import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, mulberry32, smoothing } from './util';
import {
  HUMAN_CAMP, KING_ARENA, KING_THRONE, STRONGHOLD_GATE, VILLAGE_RUINS, ZOMBIE_LAND, ZOMBIE_OUTPOSTS,
} from './layout';

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

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Areas kept flat for camps and arenas: [x, z, radius]. */
const FLAT_ZONES: [number, number, number][] = [
  [HUMAN_CAMP.x, HUMAN_CAMP.z, 18],
  ...ZOMBIE_OUTPOSTS.map((o): [number, number, number] => [o.x, o.z, o.flatRadius]),
  [KING_ARENA.x, KING_ARENA.z, KING_ARENA.r + 6],
  [STRONGHOLD_GATE.x, STRONGHOLD_GATE.z, 6],
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

/** 0 outside the zombie territory, 1 deep inside it. */
export function zombieLandWeight(x: number, z: number) {
  return 1 - smoothstep(ZOMBIE_LAND.r - 20, ZOMBIE_LAND.r + 5, Math.hypot(x - ZOMBIE_LAND.x, z - ZOMBIE_LAND.z));
}

/** Keeps scenery out of camps, outposts and the arena. */
function nearLandmark(x: number, z: number) {
  const near = (px: number, pz: number, r: number) => Math.hypot(x - px, z - pz) < r;
  return (
    near(HUMAN_CAMP.x, HUMAN_CAMP.z, 22) ||
    ZOMBIE_OUTPOSTS.some((o) => near(o.x, o.z, o.flatRadius - 1)) ||
    near(KING_ARENA.x, KING_ARENA.z, KING_ARENA.r + 9) ||
    near(STRONGHOLD_GATE.x, STRONGHOLD_GATE.z, 7)
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

const SKY = new THREE.Color(0x9fc6e8);
const GLOOM_SKY = new THREE.Color(0x7f8a7c);
const SUN_COLOR = new THREE.Color(0xfff1d6);
const GLOOM_SUN = new THREE.Color(0xc9d6b8);

export type World = ReturnType<typeof createWorld>;

export function createWorld(scene: THREE.Scene) {
  const rand = mulberry32(1337);
  const colliders: Colliders = { circles: [], boxes: [] };

  const background = SKY.clone();
  scene.background = background;
  const fog = new THREE.Fog(background, 50, 170);
  scene.fog = fog;

  const hemi = new THREE.HemisphereLight(0xdbeaff, 0x55663a, 1.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(SUN_COLOR, 2.6);
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
  for (const [ox, oz, hw, hd] of VILLAGE_RUINS) {
    const village = ZOMBIE_OUTPOSTS[1];
    addRuin(scene, rand, colliders, village.x + ox, village.z + oz, hw, hd);
  }
  addBonePiles(scene, rand);
  const campfire = addCamp(scene, colliders);
  const gate = addArena(scene, colliders);

  let gloom = 0;
  let time = 0;

  return {
    colliders,
    gate,
    /**
     * Follows the player with the sun's shadow camera and blends the sky,
     * fog and light toward a sickly gloom inside enemy territory.
     */
    update(focus: THREE.Vector3, dt: number, gloomTarget: number) {
      time += dt;
      sun.position.copy(focus).add(sunOffset);
      sun.target.position.copy(focus);

      gloom += (gloomTarget - gloom) * smoothing(1.5, dt);
      background.copy(SKY).lerp(GLOOM_SKY, gloom);
      fog.near = lerp(50, 16, gloom);
      fog.far = lerp(170, 95, gloom);
      hemi.intensity = lerp(1.6, 1.05, gloom);
      sun.intensity = lerp(2.6, 1.4, gloom);
      sun.color.copy(SUN_COLOR).lerp(GLOOM_SUN, gloom);

      campfire.update(time);
    },
  };
}

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
  const deadA = new THREE.Color(0x6e6a42);
  const deadB = new THREE.Color(0x857b4c);
  const dirt = new THREE.Color(0x8a6b45);
  const mud = new THREE.Color(0x4e4232);
  const stone = new THREE.Color(0x48433b);
  const c = new THREE.Color();
  const dead = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const w = zombieLandWeight(cx, cz);
    c.copy(grassA).lerp(grassB, rand());
    c.lerp(dead.copy(deadA).lerp(deadB, rand()), w);
    if (rand() < 0.12 * w) c.lerp(mud, 0.7);
    c.multiplyScalar(1 - Math.max(cy, 0) * 0.025);

    // Packed dirt at the human camp, mud at outposts, dark flagstones in the arena.
    const campDirt = clamp((13 - Math.hypot(cx - HUMAN_CAMP.x, cz - HUMAN_CAMP.z)) / 4, 0, 1);
    if (campDirt > 0) c.lerp(dirt, campDirt * (0.75 + 0.25 * rand()));
    for (const o of ZOMBIE_OUTPOSTS) {
      const k = clamp((o.flatRadius - 3 - Math.hypot(cx - o.x, cz - o.z)) / 4, 0, 1);
      if (k > 0) c.lerp(mud, k * (0.6 + 0.3 * rand()));
    }
    const arenaDist = Math.hypot(cx - KING_ARENA.x, cz - KING_ARENA.z);
    if (arenaDist < KING_ARENA.r + 1) c.copy(stone).multiplyScalar(0.85 + rand() * 0.3);
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const ground = new THREE.Mesh(geo, lambert(0xffffff, { vertexColors: true }));
  ground.receiveShadow = true;
  return ground;
}

function deadTreeGeometry() {
  const parts = [
    new THREE.CylinderGeometry(0.12, 0.26, 3.4, 5).translate(0, 1.7, 0),
    new THREE.CylinderGeometry(0.04, 0.09, 1.5, 4).translate(0, 0.75, 0).rotateZ(0.9).translate(0, 2.1, 0),
    new THREE.CylinderGeometry(0.04, 0.08, 1.2, 4).translate(0, 0.6, 0).rotateZ(-0.8).rotateY(1.3).translate(0, 2.6, 0),
    new THREE.CylinderGeometry(0.03, 0.07, 1.0, 4).translate(0, 0.5, 0).rotateX(0.7).rotateY(-0.6).translate(0, 3.0, 0),
  ];
  return mergeGeometries(parts)!;
}

function addTrees(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const max = 170;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 1.6, 6).translate(0, 0.8, 0), lambert(0x6b4a2f), max);
  const lower = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 2.6, 7).translate(0, 2.6, 0), lambert(), max);
  const upper = new THREE.InstancedMesh(new THREE.ConeGeometry(1.05, 2.0, 7).translate(0, 3.7, 0), lambert(), max);
  const dead = new THREE.InstancedMesh(deadTreeGeometry(), lambert(), max);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  let pines = 0;
  let deadCount = 0;
  for (let tries = 0; pines + deadCount < max && tries < 6000; tries++) {
    const x = (rand() * 2 - 1) * (WORLD_HALF - 5);
    const z = (rand() * 2 - 1) * (WORLD_HALF - 5);
    if (nearLandmark(x, z)) continue;
    if (colliders.circles.some((o) => Math.hypot(o.x - x, o.z - z) < 3.5)) continue;
    const sc = 0.8 + rand() * 0.7;
    m.compose(p.set(x, heightAt(x, z) - 0.1, z), q.setFromAxisAngle(up, rand() * Math.PI * 2), s.set(sc, sc * (0.9 + rand() * 0.3), sc));
    if (zombieLandWeight(x, z) > 0.5) {
      dead.setMatrixAt(deadCount, m);
      dead.setColorAt(deadCount, c.setHSL(0.08, 0.12, 0.22 + rand() * 0.1));
      deadCount++;
    } else {
      trunks.setMatrixAt(pines, m);
      lower.setMatrixAt(pines, m);
      upper.setMatrixAt(pines, m);
      c.setHSL(0.29 + rand() * 0.07, 0.45, 0.24 + rand() * 0.08);
      lower.setColorAt(pines, c);
      upper.setColorAt(pines, c.offsetHSL(0, 0, 0.03));
      pines++;
    }
    colliders.circles.push({ x, z, r: 0.35 * sc });
  }
  trunks.count = lower.count = upper.count = pines;
  dead.count = deadCount;
  for (const mesh of [trunks, lower, upper, dead]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function addRocks(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const max = 70;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), lambert(), max);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < max && tries < 5000; tries++) {
    const x = (rand() * 2 - 1) * (WORLD_HALF - 5);
    const z = (rand() * 2 - 1) * (WORLD_HALF - 5);
    if (nearLandmark(x, z)) continue;
    if (colliders.circles.some((o) => Math.hypot(o.x - x, o.z - z) < 3)) continue;
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

function addGravestones(scene: THREE.Scene, rand: () => number, colliders: Colliders) {
  const spots: [number, number][] = [];
  // Neat rows around Gravedigger's Field, leaving the middle open for the fight.
  const field = ZOMBIE_OUTPOSTS[0];
  for (let row = -2; row <= 2; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = field.x + col * 2.2 + (rand() - 0.5) * 0.4;
      const z = field.z + row * 2.6 + (rand() - 0.5) * 0.4;
      if (Math.hypot(x - field.x, z - field.z) < 6.5) continue;
      spots.push([x, z]);
    }
  }
  // Scattered graves across the rest of the territory.
  for (let tries = 0; spots.length < 110 && tries < 3000; tries++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * (ZOMBIE_LAND.r - 8);
    const x = ZOMBIE_LAND.x + Math.sin(a) * r;
    const z = ZOMBIE_LAND.z + Math.cos(a) * r;
    if (nearLandmark(x, z)) continue;
    if (colliders.circles.some((o) => Math.hypot(o.x - x, o.z - z) < 1.6)) continue;
    spots.push([x, z]);
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

/** A roofless ruined house: four broken walls with a doorway on the south side. */
function addRuin(scene: THREE.Scene, rand: () => number, colliders: Colliders, cx: number, cz: number, hw: number, hd: number) {
  const stone = lambert(0x7c766a);
  const wood = lambert(0x5e4630);
  const t = 0.22; // half wall thickness
  const segment = (x: number, z: number, halfX: number, halfZ: number) => {
    const height = 1.1 + rand() * 1.6;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(halfX * 2, height, halfZ * 2), rand() < 0.75 ? stone : wood);
    mesh.position.set(x, heightAt(x, z) + height / 2 - 0.05, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
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

/** Heaps of bones and skulls at the Bone Pit. */
function addBonePiles(scene: THREE.Scene, rand: () => number) {
  const pit = ZOMBIE_OUTPOSTS[2];
  const bone = lambert(0xe6dcc0);
  const boneGeo = new THREE.BoxGeometry(0.08, 0.08, 0.6);
  const skullGeo = new THREE.BoxGeometry(0.22, 0.2, 0.24);
  for (let pile = 0; pile < 7; pile++) {
    const a = (pile / 7) * Math.PI * 2 + rand();
    const r = 6 + rand() * 3;
    const px = pit.x + Math.sin(a) * r;
    const pz = pit.z + Math.cos(a) * r;
    for (let i = 0; i < 9; i++) {
      const skull = i % 4 === 0;
      const mesh = new THREE.Mesh(skull ? skullGeo : boneGeo, bone);
      mesh.position.set(px + (rand() - 0.5) * 1.2, heightAt(px, pz) + 0.06 + rand() * 0.25, pz + (rand() - 0.5) * 1.2);
      mesh.rotation.set(rand() * 0.6, rand() * Math.PI, rand() * 0.6);
      mesh.castShadow = true;
      scene.add(mesh);
    }
  }
}

/** The human army's camp: tents, crates and a campfire. */
function addCamp(scene: THREE.Scene, colliders: Colliders) {
  const canvas = lambert(0xd8cfb4);
  const tents: [number, number, number][] = [[-9, 4, 0.3], [9, 3, -0.4], [-9, -8, 0.9], [11, -7, -0.9]];
  for (const [x, z, rot] of tents) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.5, 4).translate(0, 1.25, 0), canvas);
    tent.position.set(x, heightAt(x, z), z);
    tent.rotation.y = Math.PI / 4 + rot;
    tent.castShadow = true;
    tent.receiveShadow = true;
    scene.add(tent);
    colliders.circles.push({ x, z, r: 1.6 });
  }
  const crate = lambert(0x7a5a36);
  for (const [x, z] of [[-6, 6], [-5.2, 6.4], [6.5, -3], [7.2, -2.4]] as [number, number][]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), crate);
    box.position.set(x, heightAt(x, z) + 0.4, z);
    box.rotation.y = x * 0.7;
    box.castShadow = true;
    scene.add(box);
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
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa23a });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 6).translate(0, 0.45, 0), flameMat);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.55, 5).translate(0, 0.28, 0), new THREE.MeshBasicMaterial({ color: 0xfff0a0 }));
  flame.position.y = core.position.y = 0.1;
  fire.add(flame, core);
  const light = new THREE.PointLight(0xff8a3a, 12, 14, 1.6);
  light.position.y = 1.2;
  fire.add(light);
  scene.add(fire);
  colliders.circles.push({ x: fx, z: fz, r: 0.9 });

  return {
    update(time: number) {
      const flicker = 1 + Math.sin(time * 17) * 0.08 + Math.sin(time * 29 + 1) * 0.06;
      flame.scale.set(1, flicker, 1);
      flame.rotation.y = time * 2;
      core.scale.set(1, 2 - flicker, 1);
      light.intensity = 12 * flicker;
    },
  };
}

/**
 * The Zombie King's arena: a ring of stone walls and pillars with a gate on
 * the south side, and a crypt behind it. The gate slams shut when the fight
 * starts.
 */
function addArena(scene: THREE.Scene, colliders: Colliders) {
  const { x: ax, z: az, r } = KING_ARENA;
  const stone = lambert(0x5d5850);
  const dark = lambert(0x3f3b36);
  const gateHalfAngle = 0.36;
  const inGateGap = (a: number) => Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI))) < gateHalfAngle;

  // Low wall: dense circle colliders around the ring (except the gate).
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    if (inGateGap(a)) continue;
    colliders.circles.push({ x: ax + Math.sin(a) * r, z: az + Math.cos(a) * r, r: 0.55 });
  }
  const pillars = 24;
  for (let i = 0; i < pillars; i++) {
    const a = (i / pillars) * Math.PI * 2;
    const a2 = ((i + 1) / pillars) * Math.PI * 2;
    if (inGateGap(a)) continue;
    const px = ax + Math.sin(a) * r;
    const pz = az + Math.cos(a) * r;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1, 3.4, 1), dark);
    pillar.position.set(px, heightAt(px, pz) + 1.7, pz);
    pillar.rotation.y = a;
    pillar.castShadow = true;
    scene.add(pillar);
    if (inGateGap(a2)) continue;
    // Wall section between this pillar and the next.
    const mx = ax + Math.sin((a + a2) / 2) * r;
    const mz = az + Math.cos((a + a2) / 2) * r;
    const len = 2 * r * Math.sin(Math.PI / pillars);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 1.7, 0.6), stone);
    wall.position.set(mx, heightAt(mx, mz) + 0.85, mz);
    wall.rotation.y = (a + a2) / 2;
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  }

  // The crypt behind the throne.
  const cx = ax;
  const cz = az + r + 4.5;
  const crypt = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(9, 5, 6), dark);
  body.position.y = 2.5;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 3, 4), stone);
  roof.position.y = 6.5;
  roof.rotation.y = Math.PI / 4;
  roof.scale.z = 0.7;
  const door = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.4, 0.2), new THREE.MeshBasicMaterial({ color: 0x0c0a08 }));
  door.position.set(0, 1.7, -3.05);
  crypt.add(body, roof, door);
  crypt.position.set(cx, heightAt(cx, cz), cz);
  crypt.traverse((o) => (o.castShadow = true));
  scene.add(crypt);
  colliders.boxes.push({ x: cx, z: cz, hw: 4.5, hd: 3 });

  // Throne
  const tx = KING_THRONE.x;
  const tz = KING_THRONE.z + 2.5;
  const throne = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 1.6), stone);
  seat.position.y = 0.6;
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.6, 0.5), stone);
  back.position.set(0, 1.8, 0.6);
  throne.add(seat, back);
  throne.position.set(tx, heightAt(tx, tz), tz);
  throne.traverse((o) => (o.castShadow = true));
  scene.add(throne);
  colliders.circles.push({ x: tx, z: tz, r: 1.2 });

  // Gate of bone-white bars, hidden in the ground until the fight starts.
  const gate = new THREE.Group();
  const barMat = lambert(0xd9cfb0);
  const gateColliders: Circle[] = [];
  const bars = 12;
  for (let i = 0; i <= bars; i++) {
    const a = Math.PI - gateHalfAngle + (i / bars) * gateHalfAngle * 2;
    const bx = ax + Math.sin(a) * r;
    const bz = az + Math.cos(a) * r;
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

/** Where the hero stands after respawning at a banner: just south of it. */
export function respawnPoint(banner: { x: number; z: number }) {
  return { x: banner.x - 1.5, z: banner.z - 2.5 };
}
