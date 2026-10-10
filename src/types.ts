import type * as THREE from 'three';
import type { Player } from './player';
import type { Ally } from './ally';
import type { Enemy, EnemyGroup } from './enemy';
import type { Particles } from './particles';
import type { FloaterKind } from './floaters';
import type { Colliders } from './world';
import type { Projectiles } from './projectiles';
import type { DifficultyProfile } from './settings';

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
  /** Player 1's hero (also where sounds are heard from). */
  player: Player;
  /** Every hero in the game: Player 1, and Player 2 when they've joined. */
  players: Player[];
  /** The hero the soldiers follow: Player 1, or Player 2 while Player 1 is down. */
  leader: Player;
  allies: Ally[];
  enemies: Enemy[];
  particles: Particles;
  projectiles: Projectiles;
  /** Current difficulty (from Options); can change mid-game. */
  difficulty: DifficultyProfile;
  /** True behind the menus: enemies wander and ignore the humans. */
  peaceful: boolean;
  /** During a leader fight, only that leader's side may attack anyone inside the arena. */
  arenaLock: { x: number; z: number; r: number; group: EnemyGroup } | null;
  floatText(at: THREE.Vector3, text: string, kind: FloaterKind): void;
  addShake(amount: number): void;
  hitStop(seconds: number): void;
  onEnemyKilled(enemy: Enemy): void;
  /** Brings a leader's minions into the fight around it. */
  summonMinions(around: Enemy, count: number): void;
}
