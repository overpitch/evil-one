import * as THREE from 'three';
import { createHumanoid, HIPS_HEIGHT, resetPose, setFlash, type Humanoid, type HumanoidLook } from './character';
import type { GameContext, Target } from './types';
import type { ZombieKind } from './layout';
import { heightAt, resolveColliders } from './world';
import { dampAngle, easeOutCubic, lerp, smoothing, wrapAngle } from './util';
import { sfx, volumeAt } from './audio';
import { XP_REWARD } from './progression';

export type ZombieState =
  | 'dormant' // not in the world (cleaned up, or waiting to be summoned)
  | 'rising' // clawing out of the ground
  | 'idle'
  | 'chase'
  | 'windup'
  | 'strike'
  | 'recover'
  | 'stagger'
  | 'dead'
  | 'leap' // boss only
  | 'roar'; // boss only

export interface ZombieStats {
  hp: number;
  speed: number;
  damage: number;
  knockback: number;
  scale: number;
  /** Damage it can soak before staggering. 0 = every hit staggers. */
  poise: number;
  windup: number;
  /** Distance at which it starts an attack. */
  reach: number;
}

export const ZOMBIE_KINDS: Record<ZombieKind, ZombieStats> = {
  shambler: { hp: 100, speed: 2.5, damage: 14, knockback: 5, scale: 1, poise: 0, windup: 0.6, reach: 1.75 },
  runner: { hp: 60, speed: 4.5, damage: 10, knockback: 4, scale: 0.9, poise: 0, windup: 0.45, reach: 1.7 },
  brute: { hp: 260, speed: 1.9, damage: 26, knockback: 9, scale: 1.35, poise: 70, windup: 0.85, reach: 2.3 },
};

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

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

const SIGHT = 22;
const LEASH = 42; // stop chasing this far from home
const RISE_TIME = 1.3;
const RECOVER = 0.7;
const CORPSE_TIME = 3.5;

const HIT_COLOR = new THREE.Color(0xffffff);
const TELEGRAPH_COLOR = new THREE.Color(0xff6a1a);

const barBgGeo = new THREE.PlaneGeometry(0.9, 0.11);
const barFillGeo = new THREE.PlaneGeometry(0.86, 0.07).translate(0.43, 0, 0);
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.8, depthTest: false });
const barFillMat = new THREE.MeshBasicMaterial({ color: 0xc62f2f, depthTest: false });

/** A pack of zombies that share a home and alert each other. */
export class ZombieGroup {
  alerted = false;
  readonly members: Zombie[] = [];

  /** Every member is dead (or never spawned). */
  get cleared() {
    return this.members.every((m) => !m.alive);
  }
}

export function createZombie(scene: THREE.Scene, kind: ZombieKind) {
  return new Zombie(scene, ZOMBIE_KINDS[kind], LOOKS[kind](), XP_REWARD[kind]);
}

export class Zombie {
  readonly h: Humanoid;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  readonly home = new THREE.Vector3();
  hp: number;
  yaw = Math.random() * Math.PI * 2;
  state: ZombieState = 'dormant';
  stateTime = 0;
  group: ZombieGroup | null = null;
  /** How far it wanders from home when idle. */
  wanderRadius = 5;
  target: Target | null = null;

  protected readonly stats: ZombieStats;
  /** Extra height while airborne (boss leap). */
  protected airY = 0;
  protected recoverTime = RECOVER;
  protected showWorldBar = true;
  // Per-frame steering output from think()
  protected readonly desired = new THREE.Vector3();
  protected faceYaw = 0;
  protected turnRate = 6;
  protected accel = 8;

  private readonly wanderTo = new THREE.Vector3();
  private wanderTimer = 0;
  private retargetTimer = 0;
  private groanTimer = 2 + Math.random() * 4;
  private hitFlash = 0;
  private struck = false;
  private staggerDuration = 0;
  private poiseDamage = 0;
  /** Bosses can't be staggered again for a while after a stagger. */
  private staggerArmor = 0;
  private walkPhase = Math.random() * 10;
  private readonly bar = new THREE.Group();
  private readonly barFill: THREE.Mesh;

  constructor(scene: THREE.Scene, stats: ZombieStats, look: HumanoidLook, readonly xpReward: number) {
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

  /** Dead long enough to be reused (patrols respawn). */
  get readyToRespawn() {
    return this.state === 'dormant' || (this.state === 'dead' && this.stateTime > CORPSE_TIME);
  }

  /** Puts the zombie into the world at full health, optionally clawing out of the ground. */
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

  /** Removes the zombie from the world until spawned again. */
  makeDormant() {
    this.setState('dormant');
    this.target = null;
    this.h.root.visible = false;
    this.bar.visible = false;
  }

  /** Hides a far-away zombie without simulating it (timers still run, so corpses clear and patrols can respawn). */
  sleep(dt: number) {
    this.stateTime += dt;
    this.h.root.visible = false;
    this.bar.visible = false;
  }

  /** Kills it outright with no reward (its leader has fallen). */
  collapse(ctx: GameContext) {
    if (!this.alive) return;
    this.hp = 0;
    this.setState('dead');
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z), 0x2d4020, 10, 3);
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
    this.think(dt, ctx, dx, dz, dist);

    const turns = this.state !== 'dead' && this.state !== 'stagger' && this.state !== 'rising';
    if (turns) this.yaw = dampAngle(this.yaw, this.faceYaw, this.turnRate, dt);
    if (this.state !== 'rising') {
      const k = smoothing(this.accel, dt);
      this.vel.x += (this.desired.x - this.vel.x) * k;
      this.vel.z += (this.desired.z - this.vel.z) * k;
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      resolveColliders(this.pos, this.radius, ctx.colliders);
    }
    this.pos.y = heightAt(this.pos.x, this.pos.z);

    this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
    this.staggerArmor = Math.max(0, this.staggerArmor - dt);
    this.animate(dt);
  }

  /** Picks the closest human (the hero counts as a bit closer, so they draw aggro). */
  protected chooseTarget(ctx: GameContext) {
    if (ctx.peaceful || !this.alive || this.state === 'rising') {
      this.target = null;
      return;
    }
    // Too far from home: give up and walk back.
    if (this.target && this.pos.distanceTo(this.home) > LEASH) {
      this.target = null;
      if (this.group) this.group.alerted = false;
      this.wanderTo.copy(this.home);
      return;
    }
    const engaged = this.target !== null || this.group?.alerted === true;
    let best: Target | null = null;
    let bestScore = engaged ? SIGHT * 1.6 : SIGHT;
    const consider = (c: Target, weight: number) => {
      if (!c.alive) return;
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

  /** The AI brain: sets desired velocity and facing, and moves between states. */
  protected think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    const t = this.target;
    const toTargetYaw = Math.atan2(dx, dz);
    switch (this.state) {
      case 'rising':
        if (this.stateTime >= RISE_TIME) this.setState('idle');
        break;
      case 'idle': {
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
        if (t) {
          this.setState('chase');
          if (this.group) this.group.alerted = true;
          sfx.groan(volumeAt(this.pos.distanceTo(ctx.player.pos)));
        }
        break;
      }
      case 'chase':
        if (!t) {
          this.setState('idle');
          break;
        }
        this.desired.set(dx / dist, 0, dz / dist).multiplyScalar(this.stats.speed);
        this.faceYaw = toTargetYaw;
        this.groanTimer -= dt;
        if (this.groanTimer <= 0) {
          sfx.groan(volumeAt(this.pos.distanceTo(ctx.player.pos)));
          this.groanTimer = 4 + Math.random() * 5;
        }
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
      case 'strike': {
        this.accel = 20;
        this.desired.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(3.5);
        if (!this.struck && this.stateTime >= 0.06) {
          this.struck = true;
          const inFront = Math.abs(wrapAngle(toTargetYaw - this.yaw)) < 1.1;
          if (t && dist < this.stats.reach + t.radius + 0.4 && inFront) {
            if (t.takeDamage(this.stats.damage, this.pos, ctx) === 'blocked') {
              // Bouncing off a raised guard leaves the zombie wide open.
              this.vel.set(-dx / dist, 0, -dz / dist).multiplyScalar(4 / this.stats.scale);
              this.stagger(0.8);
              break;
            }
          }
        }
        if (this.stateTime >= 0.22) this.setState('recover');
        break;
      }
      case 'recover':
        if (this.stateTime >= this.recoverTime) {
          this.recoverTime = RECOVER;
          this.setState(t && dist < this.stats.reach + t.radius ? 'windup' : 'chase');
        }
        break;
      case 'stagger':
        this.accel = 5;
        if (this.stateTime >= this.staggerDuration) this.setState(t ? 'chase' : 'idle');
        break;
      case 'dead':
        this.accel = 4;
        break;
    }
  }

  takeHit(damage: number, dir: THREE.Vector3, knockback: number, heavy: boolean, ctx: GameContext, attacker: Target) {
    if (!this.alive) return;
    const byPlayer = attacker === ctx.player;
    this.hp = Math.max(0, this.hp - damage);
    this.hitFlash = 1;
    this.poiseDamage += damage;
    // Heavy blows break the guard of anything short of a boss.
    const isBoss = this.stats.poise >= 100;
    const poiseBroken =
      this.staggerArmor <= 0 && (this.stats.poise === 0 || this.poiseDamage >= this.stats.poise || (heavy && !isBoss));
    this.vel.copy(dir).multiplyScalar((poiseBroken ? knockback : knockback * 0.25) / this.stats.scale);

    const at = new THREE.Vector3(this.pos.x, this.pos.y + 1.3 * this.stats.scale, this.pos.z);
    ctx.particles.burst(at, 0x3f5a2a, heavy ? 14 : 8, 4.5, dir);
    sfx.hit(heavy, byPlayer ? 1 : volumeAt(this.pos.distanceTo(ctx.player.pos)) * 0.5);
    if (byPlayer) ctx.floatText(at, String(damage), heavy ? 'heavy' : 'damage');

    // Getting hit wakes the whole pack and draws attention to the attacker.
    if (this.group) this.group.alerted = true;
    if (!this.target) this.target = attacker;

    if (this.hp <= 0) {
      this.setState('dead');
      ctx.particles.burst(at, 0x2d4020, 16, 5, dir);
      sfx.zombieDie(volumeAt(this.pos.distanceTo(ctx.player.pos)));
      ctx.onEnemyKilled(this);
      return;
    }
    if (poiseBroken && this.state !== 'leap' && this.state !== 'roar' && this.state !== 'rising') {
      this.poiseDamage = 0;
      if (isBoss) this.staggerArmor = 6;
      this.stagger(heavy ? 0.7 : 0.38);
    }
  }

  /** Billboards the health bar toward the camera; hidden at full health. */
  updateBar(camera: THREE.Camera) {
    this.bar.visible = this.showWorldBar && this.alive && this.h.root.visible && this.hp < this.maxHp;
    if (!this.bar.visible) return;
    this.bar.position.set(this.pos.x, this.pos.y + 2.3 * this.stats.scale, this.pos.z);
    this.bar.quaternion.copy(camera.quaternion);
    this.barFill.scale.x = Math.max(this.hp / this.maxHp, 0.001);
  }

  protected setState(state: ZombieState) {
    this.state = state;
    this.stateTime = 0;
  }

  protected stagger(duration: number) {
    this.staggerDuration = duration;
    this.setState('stagger');
  }

  /**
   * Hook for subclasses to pose special states. Return an arm reach angle,
   * 'posed' if the subclass set the arms itself, or null to use the defaults.
   */
  protected poseSpecial(_h: Humanoid): number | 'posed' | null {
    return null;
  }

  private animate(dt: number) {
    const h = this.h;
    h.root.position.copy(this.pos);
    h.root.position.y += this.airY;
    h.root.rotation.y = this.yaw;
    h.root.visible = true;
    resetPose(h);

    // Shambling walk: hunched, head lolling, arms reaching forward.
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * ((speed * 2.4) / this.stats.scale + 0.6);
    const step = Math.sin(this.walkPhase) * Math.min(speed / 2.5, 1) * 0.55;
    h.legL.rotation.x = step;
    h.legR.rotation.x = -step;
    h.torso.rotation.set(0.25, Math.sin(this.walkPhase * 0.5) * 0.1, Math.sin(this.walkPhase) * 0.06);
    h.head.rotation.set(0.15, 0, 0.35 + Math.sin(this.walkPhase * 0.7) * 0.06);
    let reach: number | 'posed' = -1.4;
    let telegraph = 0;

    const special = this.poseSpecial(h);
    if (special !== null) {
      reach = special;
    } else {
      switch (this.state) {
        case 'rising': {
          // Claw up out of the grave.
          const k = easeOutCubic(Math.min(this.stateTime / RISE_TIME, 1));
          h.root.position.y -= (1 - k) * 1.9 * this.stats.scale;
          reach = -2.9 + k * 1.5;
          h.torso.rotation.x = 0.5 * (1 - k);
          break;
        }
        case 'windup': {
          const k = easeOutCubic(Math.min(this.stateTime / this.stats.windup, 1));
          reach = lerp(-1.4, -2.7, k);
          h.torso.rotation.x = lerp(0.25, -0.2, k);
          telegraph = k * (0.25 + 0.15 * Math.sin(this.stateTime * 30));
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
        case 'dead': {
          const k = easeOutCubic(Math.min(this.stateTime / 0.6, 1));
          h.hips.rotation.x = 1.5 * k;
          h.hips.position.y = lerp(HIPS_HEIGHT, 0.3, k);
          h.legL.rotation.x = h.legR.rotation.x = 0;
          reach = -2.8;
          // Sink into the ground, then vanish.
          if (this.stateTime > 1.8) h.root.position.y -= (this.stateTime - 1.8) * 0.6;
          h.root.visible = this.stateTime < CORPSE_TIME;
          break;
        }
      }
    }

    if (reach !== 'posed') {
      h.armL.rotation.set(reach + step * 0.2, 0, 0.1);
      h.armR.rotation.set(reach - step * 0.2, 0, -0.1);
    }
    if (this.hitFlash > 0) setFlash(h, HIT_COLOR, this.hitFlash * 0.45);
    else setFlash(h, TELEGRAPH_COLOR, telegraph);
  }
}
