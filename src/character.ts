import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Blocky low-poly humanoid built from boxes. Every limb hangs from a pivot
 * group so it can be posed procedurally:
 *
 *   root (feet, faces +Z) → hips → torso → head / armL / armR(→ sword)
 *                                 → legL / legR
 *
 * The character's right side is -X. Arms use Euler order YXZ, so
 * rotation.x lifts the arm forward (-PI/2 = straight ahead) and rotation.y
 * then sweeps it left (+) or right (-).
 */
export interface Humanoid {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  sword: THREE.Group | null;
  /** Materials that flash when the character is hit. */
  materials: THREE.MeshLambertMaterial[];
}

export interface HumanoidLook {
  skin: number;
  shirt: number;
  pants: number;
  boots: number;
  eyes: number;
  /** Eyes ignore lighting and glow (zombies). */
  glowingEyes?: boolean;
  belt?: number;
  /** Adds a helmet and shoulder plates in this color. */
  armor?: number;
  plume?: number;
  sword?: boolean;
}

export const HIPS_HEIGHT = 0.95;

const boxCache = new Map<string, THREE.BoxGeometry>();
function boxGeo(w: number, h: number, d: number) {
  const key = `${w}|${h}|${d}`;
  let geo = boxCache.get(key);
  if (!geo) boxCache.set(key, (geo = new THREE.BoxGeometry(w, h, d)));
  return geo;
}

export function createHumanoid(look: HumanoidLook): Humanoid {
  const materials: THREE.MeshLambertMaterial[] = [];
  const matByColor = new Map<number, THREE.Material>();
  const mat = (color: number) => {
    let m = matByColor.get(color);
    if (!m) {
      const lm = new THREE.MeshLambertMaterial({ color, flatShading: true });
      materials.push(lm);
      matByColor.set(color, (m = lm));
    }
    return m;
  };
  const part = (parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(boxGeo(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = HIPS_HEIGHT;
  root.add(hips);
  part(hips, 0.5, 0.22, 0.3, mat(look.pants), 0, 0, 0);
  if (look.belt !== undefined) part(hips, 0.52, 0.07, 0.32, mat(look.belt), 0, 0.1, 0);

  const torso = new THREE.Group();
  torso.position.y = 0.1;
  hips.add(torso);
  part(torso, 0.56, 0.62, 0.32, mat(look.shirt), 0, 0.32, 0);

  const head = new THREE.Group();
  head.position.y = 0.64;
  torso.add(head);
  part(head, 0.36, 0.38, 0.36, mat(look.skin), 0, 0.2, 0);
  const eyeMat = look.glowingEyes ? new THREE.MeshBasicMaterial({ color: look.eyes }) : mat(look.eyes);
  for (const side of [1, -1]) part(head, 0.07, 0.06, 0.02, eyeMat, 0.08 * side, 0.24, 0.185);
  if (look.armor !== undefined) {
    part(head, 0.42, 0.2, 0.42, mat(look.armor), 0, 0.34, 0);
    part(head, 0.46, 0.05, 0.46, mat(look.armor), 0, 0.25, 0);
    if (look.plume !== undefined) part(head, 0.07, 0.16, 0.34, mat(look.plume), 0, 0.52, -0.03);
  }

  const makeArm = (side: number) => {
    const arm = new THREE.Group();
    arm.position.set(0.37 * side, 0.56, 0);
    arm.rotation.order = 'YXZ';
    torso.add(arm);
    part(arm, 0.17, 0.6, 0.19, mat(look.shirt), 0, -0.28, 0);
    part(arm, 0.15, 0.14, 0.16, mat(look.skin), 0, -0.63, 0);
    if (look.armor !== undefined) part(arm, 0.24, 0.14, 0.26, mat(look.armor), 0, 0.02, 0);
    return arm;
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  const makeLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(0.13 * side, -0.05, 0);
    hips.add(leg);
    part(leg, 0.2, 0.78, 0.22, mat(look.pants), 0, -0.4, 0);
    part(leg, 0.22, 0.14, 0.3, mat(look.boots), 0, -0.83, 0.04);
    return leg;
  };
  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  let sword: THREE.Group | null = null;
  if (look.sword) {
    // Held in the right fist; the blade points along the sword group's +Z.
    sword = new THREE.Group();
    sword.position.set(0, -0.64, 0);
    armR.add(sword);
    const gold = mat(0xc9a24a);
    part(sword, 0.045, 0.045, 0.22, mat(0x4a3020), 0, 0, 0);
    part(sword, 0.3, 0.05, 0.06, gold, 0, 0, 0.13);
    part(sword, 0.07, 0.02, 1.0, mat(0xd8dde3), 0, 0, 0.66);
    part(sword, 0.08, 0.08, 0.07, gold, 0, 0, -0.13);
  }

  // Fewer draws: each body part's boxes become one mesh, colored per vertex.
  const body = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true });
  for (const g of [hips, torso, head, armL, armR, legL, legR, sword]) if (g) mergeParts(g, body);
  return { root, hips, torso, head, armL, armR, legL, legR, sword, materials: [body] };
}

/**
 * Merges a body part's plain-colored boxes into one vertex-colored mesh
 * (glowing eyes stay separate so they still glow). Child groups (the sword)
 * are left alone.
 */
function mergeParts(group: THREE.Group, material: THREE.Material) {
  // Glowing eyes: both into one mesh, keeping their glow material.
  const glows = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial);
  if (glows.length > 1) {
    const geos = glows.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const eyes = new THREE.Mesh(mergeGeometries(geos), glows[0].material);
    for (const m of glows) group.remove(m);
    group.add(eyes);
  }
  const boxes = group.children.filter(
    (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.material instanceof THREE.MeshLambertMaterial,
  );
  if (boxes.length < 2) {
    if (boxes.length === 1) {
      // Still use the shared vertex-colored material so the hit flash reaches it.
      const geo = coloredGeometry(boxes[0]);
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      group.remove(boxes[0]);
      group.add(mesh);
    }
    return;
  }
  const merged = mergeGeometries(boxes.map(coloredGeometry));
  for (const b of boxes) group.remove(b);
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  group.add(mesh);
}

/** A box's geometry, moved into its parent's space and painted its material's color. */
function coloredGeometry(mesh: THREE.Mesh) {
  mesh.updateMatrix();
  const geo = mesh.geometry.clone().applyMatrix4(mesh.matrix);
  const color = (mesh.material as THREE.MeshLambertMaterial).color;
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

const flashTmp = new THREE.Color();

/** Tints the whole character (hit flash, attack telegraph). amount 0 = off. */
export function setFlash(h: Humanoid, color: THREE.Color, amount: number) {
  flashTmp.copy(color).multiplyScalar(amount);
  for (const m of h.materials) m.emissive.copy(flashTmp);
}

/** Puts every limb back to a neutral stance before a pose is applied. */
export function resetPose(h: Humanoid) {
  h.hips.quaternion.identity();
  h.hips.position.y = HIPS_HEIGHT;
  for (const g of [h.torso, h.head, h.armL, h.armR, h.legL, h.legR]) g.rotation.set(0, 0, 0);
}
