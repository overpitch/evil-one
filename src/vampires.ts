import * as THREE from 'three';
import type { Humanoid, HumanoidLook } from './character';
import { Enemy, pick, propMaterial, type EnemyStats } from './enemy';
import type { GameContext, Target } from './types';
import type { VampireKind } from './layout';
import { XP_REWARD } from './progression';
import { easeOutCubic, lerp, wrapAngle } from './util';
import { sfx, volumeAt } from './audio';

export const VAMPIRE_KINDS: Record<VampireKind, EnemyStats> = {
  thrall: { hp: 160, speed: 3.8, damage: 18, knockback: 5, scale: 1, poise: 0, windup: 0.45, reach: 1.7 },
  knight: { hp: 340, speed: 3.4, damage: 26, knockback: 7, scale: 1.08, poise: 90, windup: 0.55, reach: 2.1 },
};

const BLOOD = 0x5a0a14;
const ASH = 0x3a3438;

export function vampireLook(kind: VampireKind | 'lord'): HumanoidLook {
  const skin = pick([0xd8d0d6, 0xcfc6d2, 0xe0d8dc]);
  if (kind === 'thrall') {
    return { skin, shirt: pick([0x5a5058, 0x4a4048, 0x6a5a5a]), pants: 0x2a2228, boots: 0x1a1418, eyes: 0xff2a2a, glowingEyes: true };
  }
  if (kind === 'knight') {
    return { skin, shirt: 0x2a2a32, pants: 0x1e1e24, boots: 0x141218, belt: 0x7a0f1a, armor: 0x3a3a46, eyes: 0xff2a2a, glowingEyes: true, sword: true };
  }
  return { skin: 0xe8e0e4, shirt: 0x1a1018, pants: 0x140c12, boots: 0x0c0a0c, belt: 0xd9b24a, eyes: 0xff1a1a, glowingEyes: true, sword: true };
}

/** A long cape hanging from the shoulders. */
export function addCape(h: Humanoid, color: number) {
  const cape = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.15, 0.05).translate(0, -0.55, 0), propMaterial(color));
  cape.position.set(0, 0.62, -0.19);
  cape.castShadow = true;
  h.torso.add(cape);
  return cape;
}

export function createVampire(scene: THREE.Scene, kind: VampireKind): Enemy {
  return kind === 'knight' ? new VampireKnight(scene) : new Thrall(scene);
}

/** A starving servant of the vampires: fast, upright, clawing. */
export class Thrall extends Enemy {
  readonly faction = 'vampire' as const;

  constructor(scene: THREE.Scene) {
    super(scene, VAMPIRE_KINDS.thrall, vampireLook('thrall'), XP_REWARD.thrall);
    this.bloodColor = BLOOD;
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    sfx.hiss(kind === 'idle' ? vol * 0.5 : vol);
  }

  protected pose(h: Humanoid, step: number) {
    h.torso.rotation.x = 0.15;
    h.head.rotation.x = -0.1;
    let reach = -0.5;
    switch (this.state) {
      case 'chase':
        reach = -0.9;
        h.torso.rotation.x = 0.35;
        break;
      case 'windup': {
        const k = easeOutCubic(Math.min(this.stateTime / this.stats.windup, 1));
        reach = lerp(-0.9, -2.5, k);
        h.torso.rotation.x = lerp(0.35, -0.15, k);
        break;
      }
      case 'strike': {
        const k = Math.min(this.stateTime / 0.1, 1);
        reach = lerp(-2.5, -0.7, k);
        h.torso.rotation.x = lerp(-0.15, 0.5, k);
        break;
      }
      case 'stagger':
        reach = -0.4;
        h.torso.rotation.x = -0.3;
        break;
    }
    h.armL.rotation.set(reach + step * 0.4, 0, 0.25);
    h.armR.rotation.set(reach - step * 0.4, 0, -0.25);
  }
}

const BLINK_TIME = 0.35;

/**
 * Armored vampire swordsman. Parries attacks from the front, heals from the
 * blood it draws, and mist-steps behind you when hurt.
 */
export class VampireKnight extends Enemy {
  readonly faction = 'vampire' as const;
  protected parryChance = 0.35;
  protected parryCooldown = 0;
  protected blinkCooldown = 3;
  protected lifesteal = 0.5;
  /** Next windup is a quick counter-attack. */
  protected countering = false;

  constructor(scene: THREE.Scene, stats: EnemyStats = VAMPIRE_KINDS.knight, look: HumanoidLook = vampireLook('knight'), xp: number = XP_REWARD.knight, cape = 0x7a0f1a) {
    super(scene, stats, look, xp);
    this.bloodColor = BLOOD;
    addCape(this.h, cape);
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind !== 'idle') sfx.hiss(vol);
  }

  protected override onDealtDamage(damage: number) {
    this.hp = Math.min(this.maxHp, this.hp + damage * this.lifesteal);
  }

  protected override tryParry(attacker: Target, _ctx: GameContext) {
    if (this.parryCooldown > 0) return false;
    if (this.state !== 'chase' && this.state !== 'idle' && this.state !== 'recover') return false;
    const facing = Math.abs(wrapAngle(Math.atan2(attacker.pos.x - this.pos.x, attacker.pos.z - this.pos.z) - this.yaw)) < 1.2;
    if (!facing || Math.random() > this.parryChance) return false;
    this.parryCooldown = 1.2;
    // Riposte straight away.
    this.target = attacker;
    this.countering = true;
    this.setState('windup');
    return true;
  }

  protected override onHurt(ctx: GameContext) {
    if (this.blinkCooldown <= 0 && this.target && Math.random() < 0.3) this.blinkBehind(ctx);
  }

  /** Dissolves into mist and reappears beside or behind the target. */
  protected blinkBehind(ctx: GameContext) {
    const t = this.target;
    if (!t) return;
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z), ASH, 18, 3);
    const away = Math.atan2(this.pos.x - t.pos.x, this.pos.z - t.pos.z);
    const a = away + Math.PI + (Math.random() - 0.5) * 1.6;
    this.pos.set(t.pos.x + Math.sin(a) * 2.2, this.pos.y, t.pos.z + Math.cos(a) * 2.2);
    this.vel.set(0, 0, 0);
    this.blinkCooldown = 5;
    sfx.hiss(volumeAt(this.pos.distanceTo(ctx.player.pos)) * 0.6);
    this.setState('blink');
  }

  protected override canBeStaggered() {
    return super.canBeStaggered() && this.state !== 'blink';
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    this.parryCooldown -= dt;
    this.blinkCooldown -= dt;
    if (this.state === 'blink') {
      this.faceYaw = Math.atan2(dx, dz);
      this.turnRate = 30;
      if (this.stateTime >= BLINK_TIME) {
        ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z), ASH, 18, 3);
        this.countering = true;
        this.setState('windup');
      }
      return;
    }
    if (this.state === 'windup' && this.countering && this.stateTime >= this.stats.windup * 0.5) {
      // Counters come out at double speed.
      this.countering = false;
      this.struck = false;
      this.setState('strike');
      return;
    }
    super.think(dt, ctx, dx, dz, dist);
  }

  protected pose(h: Humanoid, step: number) {
    h.root.visible = this.state !== 'blink';
    h.torso.rotation.x = 0.05;
    h.armL.rotation.set(-step * 0.6, 0, 0.1);
    h.armR.rotation.set(-0.5 + step * 0.3, 0, -0.1);
    const sword = h.sword!;
    sword.rotation.set(0.2, 0, 0);
    switch (this.state) {
      case 'windup': {
        const total = this.countering ? this.stats.windup * 0.5 : this.stats.windup;
        const k = easeOutCubic(Math.min(this.stateTime / total, 1));
        h.armR.rotation.set(lerp(-0.5, -2.3, k), lerp(0, -1.1, k), 0);
        sword.rotation.x = lerp(0.2, Math.PI / 2, k);
        h.torso.rotation.y = -0.35 * k;
        break;
      }
      case 'strike': {
        const k = easeOutCubic(Math.min(this.stateTime / 0.14, 1));
        h.armR.rotation.set(lerp(-2.3, -1.2, k), lerp(-1.1, 1.0, k), 0);
        sword.rotation.x = Math.PI / 2;
        h.torso.rotation.y = lerp(-0.35, 0.35, k);
        break;
      }
      case 'recover': {
        const k = Math.min(this.stateTime / this.recoverTime, 1);
        h.armR.rotation.set(lerp(-1.2, -0.5, k), lerp(1.0, 0, k), 0);
        sword.rotation.x = lerp(Math.PI / 2, 0.2, k);
        break;
      }
      case 'chase':
      case 'idle':
        // Guard up: blade angled across the body.
        h.armR.rotation.set(-1.0, 0.4, 0);
        sword.rotation.set(-0.3, 0.6, 0);
        break;
      case 'stagger':
        h.torso.rotation.x = -0.3;
        h.armL.rotation.set(-0.5, 0, 0.6);
        h.armR.rotation.set(-0.5, 0, -0.6);
        break;
    }
  }
}
