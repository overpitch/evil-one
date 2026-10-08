import type * as THREE from 'three';
import type { Humanoid, HumanoidLook } from './character';
import { Enemy, pick, type EnemyStats } from './enemy';
import type { ZombieKind } from './layout';
import { XP_REWARD } from './progression';
import { easeOutCubic, lerp } from './util';
import { sfx } from './audio';

export const ZOMBIE_KINDS: Record<ZombieKind, EnemyStats> = {
  shambler: { hp: 100, speed: 2.5, damage: 14, knockback: 5, scale: 1, poise: 0, windup: 0.6, reach: 1.75 },
  runner: { hp: 60, speed: 4.5, damage: 10, knockback: 4, scale: 0.9, poise: 0, windup: 0.45, reach: 1.7 },
  brute: { hp: 260, speed: 1.9, damage: 26, knockback: 9, scale: 1.35, poise: 70, windup: 0.85, reach: 2.3 },
};

const LOOKS: Record<ZombieKind, () => HumanoidLook> = {
  shambler: () => ({
    skin: pick([0x7fa36a, 0x8aa070, 0x6f9a68]),
    shirt: pick([0x5b4a3a, 0x4a5a4a, 0x6a5040]),
    pants: 0x3c4a5e,
    boots: 0x2e2a26,
    eyes: 0xfff27a,
    glowingEyes: true,
  }),
  runner: () => ({
    skin: pick([0x9fb08a, 0xa8b496]),
    shirt: pick([0x6b6b6b, 0x5a5550]),
    pants: 0x4a4038,
    boots: 0x2e2a26,
    eyes: 0xc6ff6a,
    glowingEyes: true,
  }),
  brute: () => ({
    skin: 0x5f7f4f,
    shirt: 0x5f7f4f, // bare-chested
    pants: 0x3a2e26,
    boots: 0x221c18,
    belt: 0x2a2018,
    eyes: 0xff5533,
    glowingEyes: true,
  }),
};

export function createZombie(scene: THREE.Scene, kind: ZombieKind) {
  return new Zombie(scene, ZOMBIE_KINDS[kind], LOOKS[kind](), XP_REWARD[kind]);
}

/** The walking dead: hunched, arms reaching, slow but relentless. */
export class Zombie extends Enemy {
  readonly faction = 'zombie' as const;

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind === 'die') sfx.zombieDie(vol);
    else sfx.groan(vol);
  }

  protected pose(h: Humanoid, step: number) {
    // Shambling: hunched, head lolling, arms reaching forward.
    const sway = this.stateTime * 3;
    h.torso.rotation.set(0.25, Math.sin(sway * 0.5) * 0.1, Math.sin(sway) * 0.06);
    h.head.rotation.set(0.15, 0, 0.35 + Math.sin(sway * 0.7) * 0.06);
    let reach = -1.4;
    switch (this.state) {
      case 'windup': {
        const k = easeOutCubic(Math.min(this.stateTime / this.stats.windup, 1));
        reach = lerp(-1.4, -2.7, k);
        h.torso.rotation.x = lerp(0.25, -0.2, k);
        break;
      }
      case 'strike': {
        const k = Math.min(this.stateTime / 0.12, 1);
        reach = lerp(-2.7, -0.9, k);
        h.torso.rotation.x = lerp(-0.2, 0.55, k);
        break;
      }
      case 'recover': {
        const k = Math.min(this.stateTime / this.recoverTime, 1);
        reach = lerp(-0.9, -1.4, k);
        h.torso.rotation.x = lerp(0.55, 0.25, k);
        break;
      }
      case 'stagger':
        reach = -0.6;
        h.torso.rotation.x = -0.35;
        h.head.rotation.x = -0.4;
        break;
    }
    h.armL.rotation.set(reach + step * 0.2, 0, 0.1);
    h.armR.rotation.set(reach - step * 0.2, 0, -0.1);
  }
}
