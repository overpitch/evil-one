import type * as THREE from 'three';
import type { Player } from './player';
import type { Ally } from './ally';
import type { Zombie } from './enemy';
import type { Particles } from './particles';
import type { FloaterKind } from './floaters';
import type { Colliders } from './world';

export type HitResult = 'ignored' | 'blocked' | 'hit';

/** Anything on the human side that undead can attack: the hero or an allied soldier. */
export interface Target {
  readonly pos: THREE.Vector3;
  readonly radius: number;
  readonly alive: boolean;
  /** `unblockable` attacks (shockwaves) can only be dodged. */
  takeDamage(amount: number, from: THREE.Vector3, ctx: GameContext, unblockable?: boolean): HitResult;
}

/** Shared game state handed to every entity's update. */
export interface GameContext {
  scene: THREE.Scene;
  colliders: Colliders;
  player: Player;
  allies: Ally[];
  enemies: Zombie[];
  particles: Particles;
  /** True behind the menus: enemies wander and ignore the humans. */
  peaceful: boolean;
  floatText(at: THREE.Vector3, text: string, kind: FloaterKind): void;
  addShake(amount: number): void;
  hitStop(seconds: number): void;
  onEnemyKilled(enemy: Zombie): void;
  /** Raises dormant minions from the ground around a boss. */
  summonMinions(around: Zombie, count: number): void;
}
