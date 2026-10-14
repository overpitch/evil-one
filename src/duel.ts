import * as THREE from 'three';
import type { Player } from './player';
import type { Ally } from './ally';
import type { Foe, GameContext, Target } from './types';
import { DIFFICULTIES, type DifficultyProfile } from './settings';

/** Knockouts of the other hero needed to win a duel. */
export const DUEL_TARGET = 5;
/** Seconds a knocked-out hero waits before coming back at their end of the arena. */
export const DUEL_RESPAWN = 4;

/** Duels are the same for everyone: blows land at full strength, whatever the difficulty in Options. */
export const DUEL_DIFFICULTY: DifficultyProfile = { ...DIFFICULTIES.normal, label: 'Duel', enemyDamage: 1, enemyHealth: 1 };

/** A hero or soldier on the other side of a duel, as something to hit. */
export class DuelFoe implements Foe {
  readonly flying = false;
  readonly fightActive = true;
  readonly airY = 0;
  private readonly from = new THREE.Vector3();

  constructor(readonly body: Player | Ally) {}

  get pos() {
    return this.body.pos;
  }
  get radius() {
    return this.body.radius;
  }
  get alive() {
    return this.body.alive;
  }
  get state() {
    return this.body.state;
  }
  get h() {
    return this.body.h;
  }

  takeHit(damage: number, dir: THREE.Vector3, _knockback: number, _heavy: boolean, ctx: GameContext, _attacker: Target) {
    // The blow comes from the side it's pushing away from.
    this.from.copy(this.body.pos).sub(dir);
    const result = this.body.takeDamage(damage, this.from, ctx);
    if (result === 'hit') ctx.floatText(new THREE.Vector3(this.pos.x, this.pos.y + 2, this.pos.z), String(damage), 'damage');
    return result;
  }
}
