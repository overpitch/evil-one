import * as THREE from 'three';
import type { Humanoid } from './character';
import { Enemy, pick, type EnemyStats } from './enemy';
import { XP_REWARD } from './progression';
import { easeOutCubic, lerp } from './util';
import { sfx } from './audio';

const GREMLIN_STATS: EnemyStats = { hp: 45, speed: 5.4, damage: 8, knockback: 3, scale: 0.62, poise: 0, windup: 0.32, reach: 1.35 };

export function createGremlin(scene: THREE.Scene) {
  return new Gremlin(scene);
}

/**
 * Zomawi's gremlins: small, fast and nasty, with big pointy ears, glowing
 * eyes and sharp teeth. Weak alone, but they come in packs.
 */
export class Gremlin extends Enemy {
  readonly faction = 'zombie' as const;

  constructor(scene: THREE.Scene) {
    const skin = pick([0x6f8a4a, 0x7a9450, 0x627c44]);
    super(
      scene,
      GREMLIN_STATS,
      { skin, shirt: skin, pants: 0x3a2c22, boots: skin, belt: 0x2a1e16, eyes: 0xffe03a, glowingEyes: true },
      XP_REWARD.gremlin,
    );
    this.bloodColor = 0x4a6a2a;
    const h = this.h;
    const skinMat = new THREE.MeshLambertMaterial({ color: skin, flatShading: true });
    h.materials.push(skinMat);
    // Big pointy ears, sticking out sideways.
    for (const side of [1, -1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.5, 4), skinMat);
      ear.position.set(0.3 * side, 0.26, 0);
      ear.rotation.z = -side * 1.25;
      ear.castShadow = true;
      h.head.add(ear);
    }
    // A wide grin full of sharp teeth.
    const teeth = new THREE.MeshBasicMaterial({ color: 0xf4f0e0 });
    for (let i = -2; i <= 2; i++) {
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.07, 3), teeth);
      tooth.position.set(i * 0.045, 0.1, 0.185);
      tooth.rotation.x = Math.PI;
      h.head.add(tooth);
    }
    // An oversized head on a small body.
    h.head.scale.setScalar(1.35);
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind === 'die') sfx.zombieDie(vol * 0.6);
    else if (kind === 'alert') sfx.screech(vol * 0.45);
    else sfx.hiss(vol * 0.5);
  }

  protected pose(h: Humanoid, step: number) {
    // Hunched low and twitchy, claws out.
    const twitch = Math.sin(this.stateTime * 17) * 0.06;
    h.torso.rotation.set(0.45, twitch, 0);
    h.head.rotation.set(-0.35, twitch * 2, 0);
    let claw = -1.1;
    switch (this.state) {
      case 'windup': {
        const k = easeOutCubic(Math.min(this.stateTime / this.stats.windup, 1));
        claw = lerp(-1.1, -2.6, k);
        h.torso.rotation.x = lerp(0.45, 0.1, k);
        break;
      }
      case 'strike': {
        const k = Math.min(this.stateTime / 0.1, 1);
        claw = lerp(-2.6, -0.7, k);
        h.torso.rotation.x = lerp(0.1, 0.7, k);
        break;
      }
      case 'recover':
        claw = lerp(-0.7, -1.1, Math.min(this.stateTime / this.recoverTime, 1));
        break;
      case 'stagger':
        claw = -0.4;
        h.torso.rotation.x = -0.3;
        break;
    }
    h.armL.rotation.set(claw + step * 0.4, 0, 0.3);
    h.armR.rotation.set(claw - step * 0.4, 0, -0.3);
  }
}
