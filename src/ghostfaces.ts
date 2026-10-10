import * as THREE from 'three';
import { boxShape } from './shapes';
import type { Humanoid } from './character';
import { Enemy, type EnemyStats } from './enemy';
import { XP_REWARD } from './progression';
import { easeOutCubic, lerp } from './util';
import { sfx } from './audio';

// Moderately tough: a lot of health, and it takes a few hits to knock one off balance.
const GHOSTFACE_STATS: EnemyStats = { hp: 280, speed: 4.6, damage: 15, knockback: 4, scale: 1.05, poise: 60, windup: 0.42, reach: 1.9 };

export function createGhostface(scene: THREE.Scene) {
  return new Ghostface(scene);
}

/**
 * Ghostfaces guard Zomawi's courtyard: black hooded robes, a white mask
 * with long dark eyes and a screaming mouth, and a knife. Fast, and they
 * stab from overhead.
 */
export class Ghostface extends Enemy {
  // They step out of a puff of smoke, like the witches.
  readonly faction = 'witch' as const;

  constructor(scene: THREE.Scene) {
    super(scene, GHOSTFACE_STATS, { skin: 0xf2f0ea, shirt: 0x121216, pants: 0x121216, boots: 0x0a0a0c, eyes: 0x0a0a0c }, XP_REWARD.ghostface);
    this.bloodColor = 0x6a0a10;
    const h = this.h;
    const black = new THREE.MeshLambertMaterial({ color: 0x121216, flatShading: true });
    const ink = new THREE.MeshBasicMaterial({ color: 0x050505 });
    h.materials.push(black);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // The mask: long drooping eyes and a stretched, screaming mouth.
    for (const side of [1, -1]) add(h.head, boxShape(0.08, 0.14, 0.02), ink, 0.08 * side, 0.25, 0.19).rotation.z = -side * 0.25;
    add(h.head, boxShape(0.07, 0.16, 0.02), ink, 0, 0.07, 0.19);
    // The hood around the mask.
    add(h.head, boxShape(0.46, 0.1, 0.46), black, 0, 0.42, -0.02);
    add(h.head, boxShape(0.46, 0.5, 0.08), black, 0, 0.2, -0.22);
    for (const side of [1, -1]) add(h.head, boxShape(0.06, 0.5, 0.44), black, 0.22 * side, 0.2, -0.01);
    // A long robe hanging below the waist.
    add(h.hips, boxShape(0.6, 0.75, 0.36), black, 0, -0.38, 0);
    // The knife, held point-down.
    const knife = new THREE.Group();
    knife.position.set(0, -0.64, 0);
    add(knife, boxShape(0.04, 0.04, 0.14), black, 0, 0, 0);
    add(knife, boxShape(0.04, 0.4, 0.015), new THREE.MeshLambertMaterial({ color: 0xd8dde3 }), 0, -0.24, 0.02);
    h.armR.add(knife);
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind === 'idle') sfx.hiss(vol * 0.4);
    else sfx.screech(vol * (kind === 'die' ? 0.8 : 0.6));
  }

  protected pose(h: Humanoid, step: number) {
    // Leaning in, head tilted, the knife low and ready.
    h.torso.rotation.set(0.12, 0, 0);
    h.head.rotation.set(0.05, 0, 0.25);
    let arm = -0.5;
    switch (this.state) {
      case 'windup': {
        const k = easeOutCubic(Math.min(this.stateTime / this.stats.windup, 1));
        arm = lerp(-0.5, -3.0, k); // raised high overhead
        h.torso.rotation.x = lerp(0.12, -0.15, k);
        break;
      }
      case 'strike': {
        const k = Math.min(this.stateTime / 0.1, 1);
        arm = lerp(-3.0, -0.6, k); // the stab
        h.torso.rotation.x = lerp(-0.15, 0.4, k);
        break;
      }
      case 'recover':
        arm = lerp(-0.6, -0.5, Math.min(this.stateTime / this.recoverTime, 1));
        break;
      case 'stagger':
        arm = -0.2;
        h.torso.rotation.x = -0.3;
        break;
    }
    h.armR.rotation.set(arm, 0, -0.1);
    h.armL.rotation.set(-0.3 + step * 0.4, 0, 0.15);
  }
}
