import * as THREE from 'three';
import { createHumanoid, HIPS_HEIGHT, resetPose, setFlash, type Humanoid, type HumanoidLook } from './character';
import type { GameContext, Target } from './types';
import { heightAt, resolveColliders } from './world';
import { dampAngle, easeOutCubic, lerp, smoothing, wrapAngle } from './util';
import { sfx, volumeAt } from './audio';

export type Faction = 'zombie' | 'witch' | 'vampire';

export type EnemyState =
  | 'dormant' // not in the world (cleaned up, or waiting to be summoned)
  | 'rising' // clawing out of the ground
  | 'idle'
  | 'chase'
  | 'windup'
  | 'strike'
  | 'recover'
  | 'stagger'
  | 'dead'
  // Special states used by particular enemies
  | 'leap'
  | 'roar'
  | 'cast'
  | 'swoop'
  | 'burst'
  | 'ascend'
  | 'hover'
  | 'descend'
  | 'exhausted'
  | 'blink'
  | 'lunge'
  | 'grab'
  | 'bats';

export interface EnemyStats {
  hp: number;
  speed: number;
  damage: number;
  knockback: number;
  scale: number;
  /** Damage it can soak before staggering. 0 = every hit staggers. 100+ marks a boss. */
  poise: number;
  windup: number;
  /** Distance at which it starts a melee attack. */
  reach: number;
}

/** What happened when the hero or a soldier struck an enemy. */
export type StrikeOutcome = 'hit' | 'parried' | 'ignored';

const SIGHT = 22;
const LEASH = 42; // stop chasing this far from home
export const RISE_TIME = 1.3;
const RECOVER = 0.7;
const CORPSE_TIME = 3.5;

const HIT_COLOR = new THREE.Color(0xffffff);
export const TELEGRAPH_COLOR = new THREE.Color(0xff6a1a);

const barBgGeo = new THREE.PlaneGeometry(0.9, 0.11);
const barFillGeo = new THREE.PlaneGeometry(0.86, 0.07).translate(0.43, 0, 0);
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.8, depthTest: false });
const barFillMat = new THREE.MeshBasicMaterial({ color: 0xc62f2f, depthTest: false });

export function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** A pack of enemies that share a home and alert each other. */
export class EnemyGroup {
  alerted = false;
  readonly members: Enemy[] = [];

  /** Every member is dead (or never spawned). */
  get cleared() {
    return this.members.every((m) => !m.alive);
  }
}

/**
 * Shared body of every enemy: movement, targeting, taking hits, health bar,
 * death. Subclasses supply the look, the brain (think) and the poses.
 * The default brain is a simple melee fighter.
 */
export abstract class Enemy {
  abstract readonly faction: Faction;
  readonly h: Humanoid;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  readonly home = new THREE.Vector3();
  hp: number;
  yaw = Math.random() * Math.PI * 2;
  state: EnemyState = 'dormant';
  stateTime = 0;
  group: EnemyGroup | null = null;
  /** How far it wanders from home when idle. */
  wanderRadius = 5;
  target: Target | null = null;
  /** Leaders ignore everyone until their arena fight starts. */
  fightActive = true;
  /** Height above the ground (flying, leaping). Melee can't reach above ~1.2 m. */
  airY = 0;

  protected readonly stats: EnemyStats;
  protected recoverTime = RECOVER;
  protected showWorldBar = true;
  protected bloodColor = 0x3f5a2a;
  /** Flying enemies pass over trees and walls. */
  protected flies = false;
  // Per-frame steering output from think()
  protected readonly desired = new THREE.Vector3();
  protected faceYaw = 0;
  protected turnRate = 6;
  protected accel = 8;
  // Per-frame glow (attack telegraphs), set while posing
  protected glow = 0;
  protected glowColor = TELEGRAPH_COLOR;
  protected struck = false;

  private readonly wanderTo = new THREE.Vector3();
  private wanderTimer = 0;
  private retargetTimer = 0;
  private voiceTimer = 2 + Math.random() * 4;
  private hitFlash = 0;
  private staggerDuration = 0;
  private poiseDamage = 0;
  /** Bosses can't be staggered again for a while after a stagger. */
  private staggerArmor = 0;
  private walkPhase = Math.random() * 10;
  private readonly bar = new THREE.Group();
  private readonly barFill: THREE.Mesh;

  constructor(scene: THREE.Scene, stats: EnemyStats, look: HumanoidLook, readonly xpReward: number) {
    this.stats = { ...stats };
    this.maxHp = this.hp = stats.hp;
    this.radius = 0.42 * stats.scale;
    this.h = createHumanoid(look);
    this.h.root.scale.setScalar(stats.scale);
    this.h.root.visible = false;
    scene.add(this.h.root);

    const bg = new THREE.Mesh(barBgGeo, barBgMat);
    this.barFill = new THREE.Mesh(barFillGeo, barFillMat);
    this.barFill.position.set(-0.43, 0, 0.001);
    bg.renderOrder = 10;
    this.barFill.renderOrder = 11;
    this.bar.add(bg, this.barFill);
    this.bar.visible = false;
    scene.add(this.bar);
  }

  get alive() {
    return this.state !== 'dead' && this.state !== 'dormant';
  }

  /** Dead long enough to be reused (patrols respawn, minions are re-summoned). */
  get readyToRespawn() {
    return this.state === 'dormant' || (this.state === 'dead' && this.stateTime > CORPSE_TIME);
  }

  get healthFraction() {
    return this.hp / this.maxHp;
  }

  /** Too high for a sword to reach. */
  get flying() {
    return this.airY > 1.2;
  }

  get isBoss() {
    return this.stats.poise >= 100;
  }

  /** Puts the enemy into the world at full health, optionally clawing out of the ground. */
  spawn(x: number, z: number, rise = false) {
    this.pos.set(x, heightAt(x, z), z);
    this.home.copy(this.pos);
    this.wanderTo.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.hp = this.maxHp;
    this.hitFlash = 0;
    this.poiseDamage = 0;
    this.staggerArmor = 0;
    this.target = null;
    this.airY = 0;
    this.recoverTime = RECOVER;
    this.h.root.visible = true;
    this.setState(rise ? 'rising' : 'idle');
  }

  /** Removes the enemy from the world until spawned again. */
  makeDormant() {
    this.setState('dormant');
    this.target = null;
    this.h.root.visible = false;
    this.bar.visible = false;
  }

  /** Hides a far-away enemy without simulating it (timers still run, so corpses clear and patrols can respawn). */
  sleep(dt: number) {
    this.stateTime += dt;
    this.h.root.visible = false;
    this.bar.visible = false;
  }

  /** Kills it outright with no reward (its leader has fallen). */
  collapse(ctx: GameContext) {
    if (!this.alive) return;
    this.hp = 0;
    this.airY = 0;
    this.setState('dead');
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z), this.bloodColor, 10, 3);
  }

  update(dt: number, ctx: GameContext) {
    if (this.state === 'dormant') return;
    this.stateTime += dt;

    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0) {
      this.retargetTimer = 0.35 + Math.random() * 0.2;
      this.chooseTarget(ctx);
    }
    const t = this.target;
    const dx = t ? t.pos.x - this.pos.x : 0;
    const dz = t ? t.pos.z - this.pos.z : 0;
    const dist = t ? Math.max(Math.hypot(dx, dz), 1e-4) : Infinity;

    this.desired.set(0, 0, 0);
    this.faceYaw = this.yaw;
    this.turnRate = 6;
    this.accel = 8;
    if (this.state === 'dead') {
      this.accel = 4;
      this.airY = Math.max(0, this.airY - dt * 6); // fliers drop out of the sky
    } else if (this.state === 'stagger') {
      this.accel = 5;
      this.airY = Math.max(0, this.airY - dt * 2);
      if (this.stateTime >= this.staggerDuration) this.afterStagger();
    } else {
      this.think(dt, ctx, dx, dz, dist);
    }

    const turns = this.alive && this.state !== 'stagger' && this.state !== 'rising';
    if (turns) this.yaw = dampAngle(this.yaw, this.faceYaw, this.turnRate, dt);
    if (this.state !== 'rising') {
      const k = smoothing(this.accel, dt);
      this.vel.x += (this.desired.x - this.vel.x) * k;
      this.vel.z += (this.desired.z - this.vel.z) * k;
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      if (this.flies && this.airY > 1.5) resolveColliders(this.pos, this.radius, { circles: [], boxes: [] });
      else resolveColliders(this.pos, this.radius, ctx.colliders);
    }
    this.pos.y = heightAt(this.pos.x, this.pos.z);

    this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
    this.staggerArmor = Math.max(0, this.staggerArmor - dt);
    this.animate(dt);
  }

  /** Picks the closest human (the hero counts as a bit closer, so they draw aggro). */
  protected chooseTarget(ctx: GameContext) {
    if (ctx.peaceful || !this.alive || this.state === 'rising' || !this.fightActive) {
      this.target = null;
      return;
    }
    // Too far from home: give up and walk back.
    if (this.target && !this.isBoss && this.pos.distanceTo(this.home) > LEASH) {
      this.target = null;
      if (this.group) this.group.alerted = false;
      this.wanderTo.copy(this.home);
      return;
    }
    const engaged = this.target !== null || this.group?.alerted === true;
    let best: Target | null = null;
    let bestScore = engaged ? SIGHT * 1.6 : SIGHT;
    const lock = ctx.arenaLock;
    const outsider = lock !== null && this.group !== lock.group;
    const consider = (c: Target, weight: number) => {
      if (!c.alive) return;
      if (outsider && Math.hypot(c.pos.x - lock.x, c.pos.z - lock.z) < lock.r + 1) return;
      const score = Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z) * weight;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    };
    consider(ctx.player, 0.8);
    for (const a of ctx.allies) consider(a, 1);
    this.target = best;
  }

  /** Wanders around home; notices a target and gives chase. Shared by every brain. */
  protected thinkIdle(dt: number, ctx: GameContext) {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0 && this.wanderRadius > 0) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * this.wanderRadius;
      this.wanderTo.set(this.home.x + Math.sin(a) * r, 0, this.home.z + Math.cos(a) * r);
      this.wanderTimer = 3 + Math.random() * 4;
    }
    const wx = this.wanderTo.x - this.pos.x;
    const wz = this.wanderTo.z - this.pos.z;
    const wd = Math.hypot(wx, wz);
    if (wd > 0.5) {
      const pace = wd > 8 ? this.stats.speed * 0.7 : 0.8; // hurry home after a chase
      this.desired.set(wx / wd, 0, wz / wd).multiplyScalar(pace);
      this.faceYaw = Math.atan2(wx, wz);
    }
    if (this.target) {
      this.setState('chase');
      if (this.group) this.group.alerted = true;
      this.voice('alert', volumeAt(this.pos.distanceTo(ctx.player.pos)));
    }
  }

  /** Occasional idle noises while hunting. */
  protected tickVoice(dt: number, ctx: GameContext) {
    this.voiceTimer -= dt;
    if (this.voiceTimer <= 0) {
      this.voice('idle', volumeAt(this.pos.distanceTo(ctx.player.pos)));
      this.voiceTimer = 4 + Math.random() * 5;
    }
  }

  /** Swings at the target if it's in reach and in front. Returns what happened. */
  protected meleeHit(ctx: GameContext, dx: number, dz: number, dist: number, damage = this.stats.damage, extraReach = 0.4) {
    const t = this.target;
    if (!t) return 'ignored';
    const inFront = Math.abs(wrapAngle(Math.atan2(dx, dz) - this.yaw)) < 1.1;
    if (dist >= this.stats.reach + t.radius + extraReach || !inFront) return 'ignored';
    const result = t.takeDamage(damage, this.pos, ctx);
    if (result === 'blocked') {
      // Bouncing off a raised guard leaves the attacker wide open.
      this.vel.set(-dx / dist, 0, -dz / dist).multiplyScalar(4 / this.stats.scale);
      if (!this.isBoss) this.stagger(0.8);
    }
    if (result === 'hit') this.onDealtDamage(damage, ctx);
    return result;
  }

  /** Hook: vampires heal from the damage they deal. */
  protected onDealtDamage(_damage: number, _ctx: GameContext) {}

  /** The default brain: chase, wind up, strike, recover. */
  protected think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    const t = this.target;
    const toTargetYaw = Math.atan2(dx, dz);
    switch (this.state) {
      case 'rising':
        if (this.stateTime >= RISE_TIME) this.setState('idle');
        break;
      case 'idle':
        this.thinkIdle(dt, ctx);
        break;
      case 'chase':
        if (!t) {
          this.setState('idle');
          break;
        }
        this.desired.set(dx / dist, 0, dz / dist).multiplyScalar(this.stats.speed);
        this.faceYaw = toTargetYaw;
        this.tickVoice(dt, ctx);
        if (dist < this.stats.reach + t.radius) this.setState('windup');
        break;
      case 'windup':
        this.faceYaw = toTargetYaw;
        this.turnRate = 3;
        if (t && dist > this.stats.reach * 0.5) this.desired.set(dx / dist, 0, dz / dist).multiplyScalar(0.4);
        if (this.stateTime >= this.stats.windup) {
          this.struck = false;
          this.setState('strike');
        }
        break;
      case 'strike':
        this.accel = 20;
        this.desired.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(3.5);
        if (!this.struck && this.stateTime >= 0.06) {
          this.struck = true;
          if (this.meleeHit(ctx, dx, dz, dist) === 'blocked' && !this.isBoss) break;
        }
        if (this.stateTime >= 0.22) this.setState('recover');
        break;
      case 'recover':
        if (this.stateTime >= this.recoverTime) {
          this.recoverTime = RECOVER;
          this.setState(t && dist < this.stats.reach + t.radius ? 'windup' : 'chase');
        }
        break;
    }
  }

  /** Where to go once a stagger wears off. */
  protected afterStagger() {
    this.setState(this.target ? 'chase' : 'idle');
  }

  /** Hook: some enemies (vampire knights, the Vampire Lord) can parry. */
  protected tryParry(_attacker: Target, _ctx: GameContext): boolean {
    return false;
  }

  /** Hook: damage taken multiplier (an exhausted Witch Queen takes extra). */
  protected damageTakenMultiplier() {
    return 1;
  }

  /** Hook: called after taking damage and surviving (blink away, etc.). */
  protected onHurt(_ctx: GameContext, _attacker: Target) {}

  takeHit(damage: number, dir: THREE.Vector3, knockback: number, heavy: boolean, ctx: GameContext, attacker: Target): StrikeOutcome {
    if (!this.alive || this.flying) return 'ignored';
    if (this.tryParry(attacker, ctx)) {
      sfx.block(attacker === ctx.player ? 1 : volumeAt(this.pos.distanceTo(ctx.player.pos)) * 0.6);
      ctx.particles.burst(new THREE.Vector3(this.pos.x - dir.x * 0.6, this.pos.y + 1.4 * this.stats.scale, this.pos.z - dir.z * 0.6), 0xffd36b, 10, 4);
      return 'parried';
    }
    damage = Math.round(damage * this.damageTakenMultiplier());
    const byPlayer = attacker === ctx.player;
    this.hp = Math.max(0, this.hp - damage);
    this.hitFlash = 1;
    this.poiseDamage += damage;
    // Heavy blows break the guard of anything short of a boss.
    const poiseBroken =
      this.staggerArmor <= 0 && (this.stats.poise === 0 || this.poiseDamage >= this.stats.poise || (heavy && !this.isBoss));
    this.vel.copy(dir).multiplyScalar((poiseBroken ? knockback : knockback * 0.25) / this.stats.scale);

    const at = new THREE.Vector3(this.pos.x, this.pos.y + this.airY + 1.3 * this.stats.scale, this.pos.z);
    ctx.particles.burst(at, this.bloodColor, heavy ? 14 : 8, 4.5, dir);
    sfx.hit(heavy, byPlayer ? 1 : volumeAt(this.pos.distanceTo(ctx.player.pos)) * 0.5);
    if (byPlayer) ctx.floatText(at, String(damage), heavy ? 'heavy' : 'damage');

    // Getting hit wakes the whole pack and draws attention to the attacker.
    if (this.group) this.group.alerted = true;
    if (!this.target && this.fightActive) this.target = attacker;

    if (this.hp <= 0) {
      this.airY = Math.min(this.airY, 1);
      this.setState('dead');
      ctx.particles.burst(at, this.bloodColor, 16, 5, dir);
      this.voice('die', volumeAt(this.pos.distanceTo(ctx.player.pos)));
      ctx.onEnemyKilled(this);
      return 'hit';
    }
    if (poiseBroken && this.canBeStaggered()) {
      this.poiseDamage = 0;
      if (this.isBoss) this.staggerArmor = 6;
      this.stagger(heavy ? 0.7 : 0.38);
    }
    this.onHurt(ctx, attacker);
    return 'hit';
  }

  /** Special moves (leaps, roars, bat form...) can't be interrupted. */
  protected canBeStaggered() {
    return this.state === 'idle' || this.state === 'chase' || this.state === 'windup' || this.state === 'strike' || this.state === 'recover' || this.state === 'cast';
  }

  /** Billboards the health bar toward the camera; hidden at full health. */
  updateBar(camera: THREE.Camera) {
    this.bar.visible = this.showWorldBar && this.alive && this.h.root.visible && this.hp < this.maxHp;
    if (!this.bar.visible) return;
    this.bar.position.set(this.pos.x, this.pos.y + this.airY + 2.3 * this.stats.scale, this.pos.z);
    this.bar.quaternion.copy(camera.quaternion);
    this.barFill.scale.x = Math.max(this.hp / this.maxHp, 0.001);
  }

  protected setState(state: EnemyState) {
    this.state = state;
    this.stateTime = 0;
  }

  protected stagger(duration: number) {
    this.staggerDuration = duration;
    this.setState('stagger');
  }

  /** Sounds: alert (spotted you), idle (while hunting), die. */
  protected abstract voice(kind: 'alert' | 'idle' | 'die', vol: number): void;

  /**
   * Poses torso, head and arms for the current state (legs already walk).
   * `step` is the walk cycle swing, -1..1 scaled by speed.
   */
  protected abstract pose(h: Humanoid, step: number): void;

  private animate(dt: number) {
    const h = this.h;
    h.root.position.copy(this.pos);
    h.root.position.y += this.airY;
    h.root.rotation.y = this.yaw;
    h.root.visible = true;
    resetPose(h);

    const speed = this.airY > 0.3 ? 0 : Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * ((speed * 2.4) / this.stats.scale + 0.6);
    const step = Math.sin(this.walkPhase) * Math.min(speed / 2.5, 1) * 0.55;
    h.legL.rotation.x = step;
    h.legR.rotation.x = -step;
    this.glow = this.state === 'windup' ? easeOutCubic(Math.min(this.stateTime / this.stats.windup, 1)) * (0.25 + 0.15 * Math.sin(this.stateTime * 30)) : 0;
    this.glowColor = TELEGRAPH_COLOR;

    if (this.state === 'dead') {
      const k = easeOutCubic(Math.min(this.stateTime / 0.6, 1));
      h.hips.rotation.x = 1.5 * k;
      h.hips.position.y = lerp(HIPS_HEIGHT, 0.3, k);
      h.legL.rotation.x = h.legR.rotation.x = 0;
      h.armL.rotation.set(-2.8, 0, 0.1);
      h.armR.rotation.set(-2.8, 0, -0.1);
      // Sink into the ground, then vanish.
      if (this.stateTime > 1.8) h.root.position.y -= (this.stateTime - 1.8) * 0.6;
      h.root.visible = this.stateTime < CORPSE_TIME;
      this.glow = 0;
    } else if (this.state === 'rising') {
      // Claw up out of the ground.
      const k = easeOutCubic(Math.min(this.stateTime / RISE_TIME, 1));
      h.root.position.y -= (1 - k) * 1.9 * this.stats.scale;
      const reach = -2.9 + k * 1.5;
      h.torso.rotation.x = 0.5 * (1 - k);
      h.armL.rotation.set(reach, 0, 0.1);
      h.armR.rotation.set(reach, 0, -0.1);
    } else {
      this.pose(h, step);
    }

    if (this.hitFlash > 0) setFlash(h, HIT_COLOR, this.hitFlash * 0.45);
    else setFlash(h, this.glowColor, this.glow);
  }
}

/** Shared material for enemy-held props (staffs, brooms). */
export function propMaterial(color: number) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}
