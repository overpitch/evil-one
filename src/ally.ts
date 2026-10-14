import * as THREE from 'three';
import { createHumanoid, HIPS_HEIGHT, resetPose, setFlash, type Humanoid } from './character';
import type { Foe, GameContext, HitResult, Target } from './types';
import type { Player } from './player';
import { boxShape } from './shapes';
import { heightAt, resolveColliders } from './world';
import { clamp, dampAngle, easeOutCubic, lerp, smoothing, wrapAngle } from './util';
import { sfx, volumeAt } from './audio';

type State = 'follow' | 'engage' | 'windup' | 'strike' | 'recover' | 'stagger' | 'dead' | 'gone';

/**
 * Formation slots around the hero: [to the hero's right, forward]. They
 * flank the hero rather than trail behind, because the camera sits behind
 * the hero's right shoulder.
 */
const SLOTS: [number, number][] = [[-2.2, 0.4], [2.6, 1], [-4, -1], [4.4, 0.2], [0.4, -2.8]];
/** Room for the biggest army (with soldiers hired at the barracks). */
export const SQUAD_SLOTS = SLOTS.length;
/** A lone hero's army before hiring anyone. */
export const SQUAD_SIZE = 4;
/** With two players, each hero leads an army of this many (before hiring). */
export const ARMY_SIZE = 3;
/** Shirt colors: Player 1's army in red, Player 2's in blue. */
const ARMY_SHIRTS = [0x8a2a2a, 0x2a4a8a];

const MAX_HP = 70;
/** Elite soldiers (from the barracks, after Commander Hale's missions): tougher and harder-hitting. */
const ELITE_HP = 130;
const ELITE_DAMAGE = 1.6;
const ELITE_CREST = new THREE.MeshLambertMaterial({ color: 0xffc23a, flatShading: true });
/**
 * A commander's orders (after Commander Hale's tenth mission):
 * - follow: stay in formation around the hero and fight what comes near;
 * - hold: stand where the order was given and fight what comes close;
 * - charge: go after every enemy in a wide area;
 * - guard: stick close and only fight enemies right by the hero.
 */
export type ArmyOrder = 'follow' | 'hold' | 'charge' | 'guard';

/** How far (from the soldier) they look for enemies, and how far from the hero (or the held spot) they'll chase. */
const ORDER_RANGES: Record<ArmyOrder, { engage: number; leash: number }> = {
  follow: { engage: 14, leash: 24 },
  hold: { engage: 12, leash: 14 },
  charge: { engage: 45, leash: 60 },
  guard: { engage: 6, leash: 7 },
};
const WINDUP = 0.4;
const RECOVER = 0.55;
const BLOCK_CHANCE = 0.3;
const HURT_COLOR = new THREE.Color(0xff2020);
const SKINS = [0xe0b48a, 0xc68e64, 0x8d5a3b, 0xf1c9a5];

/** A soldier of the human army who follows the hero and fights beside them. */
export class Ally implements Target {
  readonly h: Humanoid;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 0.4;
  yaw = 0;
  hp = MAX_HP;
  state: State = 'gone';
  stateTime = 0;

  private target: Foe | null = null;
  private retargetTimer = 0;
  private struck = false;
  private recoverTime = RECOVER;
  private walkPhase = Math.random() * 10;
  private hurtFlash = 0;
  private sinceHurt = 99;
  private readonly desired = new THREE.Vector3();

  /** The hero this soldier follows (falls back to the other hero while theirs is down). */
  hero: Player | null = null;
  /** Their commander's current order, and where to stand for "hold here". */
  order: ArmyOrder = 'follow';
  readonly holdAt = new THREE.Vector3();
  holdYaw = 0;
  /** A gold crest on the helmet marks an elite soldier. */
  private readonly crest: THREE.Mesh;

  /** Elite once their hero has trained them at the barracks. */
  private get elite() {
    return this.hero?.goods.elite ?? false;
  }

  private get maxHp() {
    return this.elite ? ELITE_HP : MAX_HP;
  }

  constructor(
    scene: THREE.Scene,
    private readonly slot: number,
    /** 0: Player 1's army, 1: Player 2's. */
    readonly army: 0 | 1 = 0,
  ) {
    this.h = createHumanoid({
      skin: SKINS[(slot + army * 2) % SKINS.length],
      shirt: ARMY_SHIRTS[army],
      pants: 0x3a3f4a,
      boots: 0x3b2a1e,
      eyes: 0x222222,
      belt: 0x5a3c22,
      armor: 0x9aa3ab,
      sword: true,
    });
    this.crest = new THREE.Mesh(boxShape(0.08, 0.2, 0.4), ELITE_CREST);
    this.crest.position.set(0, 0.5, -0.02);
    this.crest.visible = false;
    this.h.head.add(this.crest);
    this.h.root.visible = false;
    scene.add(this.h.root);
  }

  get alive() {
    return this.state !== 'dead' && this.state !== 'gone';
  }

  /** Sends the soldier away (not part of the current armies). */
  dismiss() {
    this.state = 'gone';
    this.target = null;
    this.h.root.visible = false;
  }

  /** The hero to follow right now (in a duel, never the other side's). */
  private leaderOf(ctx: GameContext) {
    return this.hero?.alive || (ctx.duel && this.hero) ? this.hero : ctx.leader;
  }

  /** Patches a living soldier back up to full health. */
  heal() {
    if (this.alive) this.hp = this.maxHp;
  }

  /** Brings the soldier (back) into the fight at full health. */
  reinforce(x: number, z: number) {
    this.pos.set(x, heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.hp = this.maxHp;
    this.target = null;
    this.hurtFlash = 0;
    this.sinceHurt = 99;
    this.h.root.visible = true;
    this.setState('follow');
  }

  /** Where this soldier stands in formation behind the hero. */
  slotPosition(ctx: GameContext, out: THREE.Vector3) {
    // Holding: in formation around the spot where the order was given.
    const hold = this.order === 'hold';
    const p = this.leaderOf(ctx);
    const at = hold ? this.holdAt : p.pos;
    const yaw = hold ? this.holdYaw : p.yaw;
    const [right, forward] = SLOTS[this.slot];
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    return out.set(at.x + fx * forward - fz * right, 0, at.z + fz * forward + fx * right);
  }

  update(dt: number, ctx: GameContext) {
    if (this.state === 'gone') return;
    this.stateTime += dt;
    this.crest.visible = this.elite;
    const player = this.leaderOf(ctx);

    // Catch up if left far behind (e.g. the hero respawned), unless ordered to hold.
    if (this.alive && this.order !== 'hold' && this.pos.distanceTo(player.pos) > 55) {
      const s = this.slotPosition(ctx, this.desired);
      this.reinforce(s.x, s.z);
    }

    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0 && this.alive) {
      this.retargetTimer = 0.5;
      this.target = this.findTarget(ctx);
    }
    if (this.target && (!this.target.alive || this.target.flying)) this.target = null;

    const t = this.target;
    const dx = t ? t.pos.x - this.pos.x : 0;
    const dz = t ? t.pos.z - this.pos.z : 0;
    const dist = t ? Math.max(Math.hypot(dx, dz), 1e-4) : Infinity;
    const toTargetYaw = Math.atan2(dx, dz);
    let faceYaw = this.yaw;
    let accel = 10;
    this.desired.set(0, 0, 0);

    switch (this.state) {
      case 'follow': {
        const slot = this.slotPosition(ctx, this.desired);
        const sx = slot.x - this.pos.x;
        const sz = slot.z - this.pos.z;
        const sd = Math.hypot(sx, sz);
        const speed = sd > 6 ? 7.5 : sd > 0.6 ? clamp(sd * 2, 0, 5.5) : 0;
        this.desired.set(sd > 0 ? (sx / sd) * speed : 0, 0, sd > 0 ? (sz / sd) * speed : 0);
        faceYaw = speed > 2 ? Math.atan2(sx, sz) : player.yaw;
        if (t) this.setState('engage');
        break;
      }
      case 'engage':
        if (!t) {
          this.setState('follow');
          break;
        }
        faceYaw = toTargetYaw;
        if (dist > 1.5 + t.radius) this.desired.set(dx / dist, 0, dz / dist).multiplyScalar(5.5);
        else this.setState('windup');
        break;
      case 'windup':
        faceYaw = toTargetYaw;
        if (this.stateTime >= WINDUP) {
          this.struck = false;
          this.setState('strike');
        }
        break;
      case 'strike':
        faceYaw = toTargetYaw;
        accel = 20;
        this.desired.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(2);
        if (!this.struck && this.stateTime >= 0.05) {
          this.struck = true;
          sfx.swing(false, volumeAt(this.pos.distanceTo(player.pos)) * 0.4);
          if (t && dist < 2.3 + t.radius && Math.abs(wrapAngle(toTargetYaw - this.yaw)) < 1.1) {
            t.takeHit(Math.round((8 + 1.5 * player.level) * (this.elite ? ELITE_DAMAGE : 1)), new THREE.Vector3(dx / dist, 0, dz / dist), 3, false, ctx, this);
          }
        }
        if (this.stateTime >= 0.18) {
          this.recoverTime = RECOVER + Math.random() * 0.35;
          this.setState('recover');
        }
        break;
      case 'recover':
        faceYaw = t ? toTargetYaw : this.yaw;
        if (this.stateTime >= this.recoverTime) this.setState(t ? 'engage' : 'follow');
        break;
      case 'stagger':
        accel = 6;
        if (this.stateTime >= 0.35) this.setState(t ? 'engage' : 'follow');
        break;
      case 'dead':
        accel = 5;
        if (this.stateTime > 4) {
          this.setState('gone');
          this.h.root.visible = false;
        }
        break;
    }

    if (this.alive) this.yaw = dampAngle(this.yaw, faceYaw, 10, dt);
    const k = smoothing(accel, dt);
    this.vel.x += (this.desired.x - this.vel.x) * k;
    this.vel.z += (this.desired.z - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    resolveColliders(this.pos, this.radius, ctx.colliders);
    this.pos.y = heightAt(this.pos.x, this.pos.z);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    // Soldiers patch themselves up between fights, like the hero.
    this.sinceHurt += dt;
    if (this.alive && this.sinceHurt > ctx.difficulty.regenDelay) this.hp = Math.min(this.maxHp, this.hp + ctx.difficulty.regenRate * dt);
    this.animate(dt);
  }

  takeDamage(amount: number, from: THREE.Vector3, ctx: GameContext, unblockable = false): HitResult {
    if (!this.alive) return 'ignored';
    const dx = from.x - this.pos.x;
    const dz = from.z - this.pos.z;
    const d = Math.max(Math.hypot(dx, dz), 1e-4);
    const vol = volumeAt(this.pos.distanceTo(ctx.player.pos)) * 0.6;
    const facing = Math.abs(wrapAngle(Math.atan2(dx, dz) - this.yaw)) < 1.2;
    if (!unblockable && facing && this.state !== 'stagger' && Math.random() < BLOCK_CHANCE) {
      sfx.block(vol);
      ctx.particles.burst(new THREE.Vector3(this.pos.x + (dx / d) * 0.6, this.pos.y + 1.4, this.pos.z + (dz / d) * 0.6), 0xffd36b, 8, 4);
      return 'blocked';
    }
    // Soldiers can't dodge, so area attacks (meteors, shockwaves) hurt them less.
    this.hp -= (unblockable ? amount * 0.5 : amount) * ctx.difficulty.enemyDamage;
    this.sinceHurt = 0;
    this.hurtFlash = 1;
    this.vel.set(-dx / d, 0, -dz / d).multiplyScalar(4);
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z), 0x8a0f0f, 6, 3);
    sfx.hurt(vol);
    if (this.hp <= 0) {
      this.hp = 0;
      this.target = null;
      this.setState('dead');
    } else {
      this.setState('stagger');
    }
    return 'hit';
  }

  private findTarget(ctx: GameContext): Foe | null {
    if (ctx.peaceful) return null;
    let best: Foe | null = null;
    const range = ORDER_RANGES[this.order];
    let bestDist = range.engage;
    const anchor = this.order === 'hold' ? this.holdAt : this.leaderOf(ctx).pos;
    for (const z of ctx.foesOf(this.army)) {
      if (!z.alive || z.state === 'rising' || z.flying || !z.fightActive) continue;
      if (Math.hypot(z.pos.x - anchor.x, z.pos.z - anchor.z) > range.leash) continue;
      const d = z.pos.distanceTo(this.pos);
      if (d < bestDist) {
        bestDist = d;
        best = z;
      }
    }
    return best;
  }

  private setState(state: State) {
    this.state = state;
    this.stateTime = 0;
  }

  private animate(dt: number) {
    const h = this.h;
    h.root.position.copy(this.pos);
    h.root.rotation.y = this.yaw;
    resetPose(h);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * speed * 2.1;
    const amp = Math.min(speed / 5, 1.3);
    const step = Math.sin(this.walkPhase) * 0.75 * amp;
    h.hips.position.y = HIPS_HEIGHT + Math.abs(Math.cos(this.walkPhase)) * 0.05 * amp;
    h.legL.rotation.x = step;
    h.legR.rotation.x = -step;
    h.armL.rotation.set(-step * 0.7, 0, 0.08);
    h.armR.rotation.set(-0.35 + step * 0.3, 0, -0.08);
    const sword = h.sword!;
    sword.rotation.set(-0.1, 0, 0);

    switch (this.state) {
      case 'windup': {
        const k = easeOutCubic(Math.min(this.stateTime / WINDUP, 1));
        h.armR.rotation.set(lerp(-0.35, -2.2, k), lerp(0, -1.0, k), 0);
        sword.rotation.x = lerp(-0.1, Math.PI / 2, k);
        h.torso.rotation.y = -0.3 * k;
        break;
      }
      case 'strike': {
        const k = easeOutCubic(Math.min(this.stateTime / 0.15, 1));
        h.armR.rotation.set(lerp(-2.2, -1.2, k), lerp(-1.0, 0.9, k), 0);
        sword.rotation.x = Math.PI / 2;
        h.torso.rotation.y = lerp(-0.3, 0.3, k);
        break;
      }
      case 'recover': {
        const k = Math.min(this.stateTime / this.recoverTime, 1);
        h.armR.rotation.set(lerp(-1.2, -0.35, k), lerp(0.9, 0, k), 0);
        sword.rotation.x = lerp(Math.PI / 2, -0.1, k);
        break;
      }
      case 'stagger':
        h.torso.rotation.x = -0.3;
        h.armL.rotation.set(-0.5, 0, 0.6);
        h.armR.rotation.set(-0.5, 0, -0.6);
        break;
      case 'dead': {
        const k = easeOutCubic(Math.min(this.stateTime / 0.7, 1));
        h.hips.rotation.x = -1.45 * k;
        h.hips.position.y = lerp(HIPS_HEIGHT, 0.3, k);
        h.legL.rotation.x = h.legR.rotation.x = 0;
        if (this.stateTime > 2.5) h.root.position.y -= (this.stateTime - 2.5) * 0.5;
        break;
      }
    }
    setFlash(h, HURT_COLOR, this.hurtFlash * 0.5);
  }
}
