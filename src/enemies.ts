import type * as THREE from 'three';
import type { Enemy } from './enemy';
import type { EnemyKind, LeaderId } from './layout';
import { createZombie } from './zombies';
import { createWitch } from './witches';
import { createVampire } from './vampires';
import { ZombieKing } from './zombieKing';
import { WitchQueen } from './witchQueen';
import { VampireLord } from './vampireLord';
import { Zomawi } from './zomawi';

/** Makes any regular enemy by kind. */
export function createEnemy(scene: THREE.Scene, kind: EnemyKind): Enemy {
  switch (kind) {
    case 'shambler':
    case 'runner':
    case 'brute':
      return createZombie(scene, kind);
    case 'hexer':
    case 'broomWitch':
    case 'witchDecoy':
      return createWitch(scene, kind);
    case 'thrall':
    case 'knight':
      return createVampire(scene, kind);
  }
}

/** Makes an army leader (boss). */
export function createLeader(scene: THREE.Scene, id: LeaderId): Enemy {
  switch (id) {
    case 'zombie-king':
      return new ZombieKing(scene);
    case 'witch-queen':
      return new WitchQueen(scene);
    case 'vampire-lord':
      return new VampireLord(scene);
    case 'zomawi':
      return new Zomawi(scene);
  }
}
