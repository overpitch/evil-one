import type * as THREE from 'three';
import type { Player } from './player';
import type { Zombie } from './enemy';
import type { Particles } from './particles';
import type { FloaterKind } from './floaters';

/** A solid circle on the ground (tree trunk, rock) that bodies can't walk through. */
export interface Collider {
  x: number;
  z: number;
  r: number;
}

/** Shared game state handed to every entity's update. */
export interface GameContext {
  scene: THREE.Scene;
  colliders: Collider[];
  player: Player;
  enemies: Zombie[];
  particles: Particles;
  /** True behind the menus: enemies wander and ignore the hero. */
  peaceful: boolean;
  floatText(at: THREE.Vector3, text: string, kind: FloaterKind): void;
  addShake(amount: number): void;
  hitStop(seconds: number): void;
  onEnemyKilled(enemy: Zombie): void;
}
