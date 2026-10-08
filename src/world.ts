import * as THREE from 'three';
import type { Collider } from './types';
import { clamp, mulberry32 } from './util';

export const WORLD_HALF = 150;

/** Terrain height. Flat around the training ground, rolling hills further out. */
export function heightAt(x: number, z: number): number {
  const t = clamp((Math.hypot(x, z) - 18) / 30, 0, 1);
  const flat = t * t * (3 - 2 * t);
  const h =
    Math.sin(x * 0.045) * Math.cos(z * 0.038) * 3.2 +
    Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.09 + 0.7) * 1.3 +
    Math.sin((x + z) * 0.21) * 0.3;
  return h * flat;
}

/** Pushes a body out of trees/rocks and keeps it inside the world. */
export function resolveColliders(pos: THREE.Vector3, radius: number, colliders: Collider[]) {
  for (const c of colliders) {
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
  const edge = WORLD_HALF - 3;
  pos.x = clamp(pos.x, -edge, edge);
  pos.z = clamp(pos.z, -edge, edge);
}

export function createWorld(scene: THREE.Scene) {
  const rand = mulberry32(1337);
  const colliders: Collider[] = [];

  const sky = new THREE.Color(0x9fc6e8);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 50, 170);

  scene.add(new THREE.HemisphereLight(0xdbeaff, 0x55663a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
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
  addBanner(scene, colliders, 3, -9);

  return {
    colliders,
    /** Keeps the shadow-casting sun centered on the player. */
    update(focus: THREE.Vector3) {
      sun.position.copy(focus).add(sunOffset);
      sun.target.position.copy(focus);
    },
  };
}

function lambert(color: number | THREE.Color = 0xffffff, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
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
  const dirt = new THREE.Color(0x8a6b45);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    c.copy(grassA).lerp(grassB, rand());
    c.multiplyScalar(1 - Math.max(cy, 0) * 0.025);
    // Packed-dirt training ground around the spawn
    const dirtAmount = clamp((13 - Math.hypot(cx, cz)) / 4, 0, 1);
    if (dirtAmount > 0) c.lerp(dirt, dirtAmount * (0.75 + 0.25 * rand()));
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const ground = new THREE.Mesh(geo, lambert(0xffffff, { vertexColors: true }));
  ground.receiveShadow = true;
  return ground;
}

function addTrees(scene: THREE.Scene, rand: () => number, colliders: Collider[]) {
  const max = 140;
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1.6, 6).translate(0, 0.8, 0);
  const lowerGeo = new THREE.ConeGeometry(1.5, 2.6, 7).translate(0, 2.6, 0);
  const upperGeo = new THREE.ConeGeometry(1.05, 2.0, 7).translate(0, 3.7, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, lambert(0x6b4a2f), max);
  const lower = new THREE.InstancedMesh(lowerGeo, lambert(), max);
  const upper = new THREE.InstancedMesh(upperGeo, lambert(), max);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < max && tries < 5000; tries++) {
    const x = (rand() * 2 - 1) * (WORLD_HALF - 5);
    const z = (rand() * 2 - 1) * (WORLD_HALF - 5);
    if (Math.hypot(x, z) < 20) continue;
    if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < 3.5)) continue;
    const sc = 0.8 + rand() * 0.7;
    m.compose(p.set(x, heightAt(x, z) - 0.1, z), q.setFromAxisAngle(up, rand() * Math.PI * 2), s.set(sc, sc * (0.9 + rand() * 0.3), sc));
    trunks.setMatrixAt(n, m);
    lower.setMatrixAt(n, m);
    upper.setMatrixAt(n, m);
    c.setHSL(0.29 + rand() * 0.07, 0.45, 0.24 + rand() * 0.08);
    lower.setColorAt(n, c);
    upper.setColorAt(n, c.offsetHSL(0, 0, 0.03));
    colliders.push({ x, z, r: 0.35 * sc });
    n++;
  }
  for (const mesh of [trunks, lower, upper]) {
    mesh.count = n;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function addRocks(scene: THREE.Scene, rand: () => number, colliders: Collider[]) {
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
    if (Math.hypot(x, z) < 15) continue;
    if (colliders.some((o) => Math.hypot(o.x - x, o.z - z) < 3)) continue;
    const sx = 0.5 + rand() * 1.2;
    const sz = sx * (0.7 + rand() * 0.5);
    const sy = sx * (0.5 + rand() * 0.4);
    m.compose(p.set(x, heightAt(x, z) - 0.2 * sy, z), q.setFromEuler(e.set(rand() * 0.4, rand() * 6.3, rand() * 0.4)), s.set(sx, sy, sz));
    rocks.setMatrixAt(n, m);
    c.setHSL(0.08, 0.06, 0.42 + rand() * 0.14);
    rocks.setColorAt(n, c);
    colliders.push({ x, z, r: Math.max(sx, sz) * 0.85 });
    n++;
  }
  rocks.count = n;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
}

/** The human army's banner at the training ground (future checkpoint). */
function addBanner(scene: THREE.Scene, colliders: Collider[], x: number, z: number) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4, 6).translate(0, 2, 0), lambert(0x5a3c22));
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.08), lambert(0x5a3c22));
  bar.position.set(0.6, 3.8, 0);
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.7, 0.04), lambert(0xa3262a));
  cloth.position.set(0.62, 2.9, 0);
  const emblem = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.06), lambert(0xd9b24a));
  emblem.position.set(0.62, 3.05, 0);
  emblem.rotation.z = Math.PI / 4;
  for (const mesh of [pole, bar, cloth, emblem]) {
    mesh.castShadow = true;
    g.add(mesh);
  }
  g.position.set(x, heightAt(x, z), z);
  g.rotation.y = -0.6;
  scene.add(g);
  colliders.push({ x, z, r: 0.25 });
}
