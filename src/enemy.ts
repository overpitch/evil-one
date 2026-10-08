import * as THREE from 'three';
import { createHumanoid, HIPS_HEIGHT, resetPose, setFlash, type Humanoid } from './character';
import type { GameContext } from './types';
import { heightAt, resolveColliders } from './world';
import { dampAngle, easeOutCubic, lerp, smoothing, wrapAngle } from './util';
import { sfx, volumeAt } from './audio';
import { XP_REWARD } from './progression';

type State = 'idle' | 'chase' | 'windup' | 'strike' | 'recover' | 'stagger' | 'dead';

const WINDUP = 0.6;
const STRIKE = 0.22;
const RECOVER = 0.7;
const ATTACK_RANGE = 1.75;
const HIT_RANGE = 2.1;
const DAMAGE = 14;
const SIGHT = 24;
const RESPAWN_AFTER = 5;

const SHIRTS = [0x5b4a3a, 0x4a5a4a, 0x6a5040];
const SKINS = [0x7fa36a, 0x8aa070, 0x6f9a68];
const HIT_COLOR = new THREE.Color(0xffffff);
const TELEGRAPH_COLOR = new THREE.Color(0xff6a1a);

const barBgGeo = new THREE.PlaneGeometry(0.9, 0.11);
const barFillGeo = new THREE.PlaneGeometry(0.86, 0.07).translate(0.43, 0, 0);
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.8, depthTest: false });
const barFillMat = new THREE.MeshBasicMaterial({ color: 0xc62f2f, depthTest: false });

export class Zombie {
  readonly h: Humanoid;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 0.42;
  readonly xpReward = XP_REWARD.zombie;
  yaw = Math.random() * Math.PI * 2;
  maxHp = 100;
  hp = 100;
  state: State = 'idle';
  stateTime = 0;

  private readonly speed = 2.3 + Math.random() * 0.5;
  private readonly home = new THREE.Vector3();
  private readonly wanderTo = new THREE.Vector3();
  private wanderTimer = 0;
  private groanTimer = 2 + Math.random() * 4;
  private hitFlash = 0;
  private struck = false;
  private staggerDuration = 0;
  private walkPhase = Math.random() * 10;
  private readonly bar = new THREE.Group();
  private readonly barFill: THREE.Mesh;
  private readonly target = new THREE.Vector3();

  constructor(scene: THREE.Scene, x: number, z: number) {
    const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
    this.h = createHumanoid({
      skin: pick(SKINS),
      shirt: pick(SHIRTS),
      pants: 0x3c4a5e,
      boots: 0x2e2a26,
      eyes: 0xfff27a,
      glowingEyes: true,
    });
    scene.add(this.h.root);

    const bg = new THREE.Mesh(barBgGeo, barBgMat);
    this.barFill = new THREE.Mesh(barFillGeo, barFillMat);
    this.barFill.position.set(-0.43, 0, 0.001);
    bg.renderOrder = 10;
    this.barFill.renderOrder = 11;
    this.bar.add(bg, this.barFill);
    scene.add(this.bar);

    this.spawn(x, z);
  }

  get alive() {
    return this.state !== 'dead';
  }

  get readyToRespawn() {
    return this.state === 'dead' && this.stateTime > RESPAWN_AFTER;
  }

  spawn(x: number, z: number) {
    this.pos.set(x, heightAt(x, z), z);
    this.home.copy(this.pos);
    this.wanderTo.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.hp = this.maxHp;
    this.hitFlash = 0;
    this.h.root.visible = true;
    this.setState('idle');
  }

  update(dt: number, ctx: GameContext) {
    this.stateTime += dt;
    const player = ctx.player;
    const dx = player.pos.x - this.pos.x;
    const dz = player.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const toPlayerYaw = Math.atan2(dx, dz);
    const target = this.target.set(0, 0, 0);
    let faceYaw = this.yaw;
    let turnRate = 6;
    let accel = 8;

    switch (this.state) {
      case 'idle': {
        this.wanderTimer -= dt;
        if (this.wanderTimer <= 0) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * 6;
          this.wanderTo.set(this.home.x + Math.sin(a) * r, 0, this.home.z + Math.cos(a) * r);
          this.wanderTimer = 3 + Math.random() * 4;
        }
        const wx = this.wanderTo.x - this.pos.x;
        const wz = this.wanderTo.z - this.pos.z;
        const wd = Math.hypot(wx, wz);
        if (wd > 0.5) {
          target.set(wx / wd, 0, wz / wd).multiplyScalar(0.8);
          faceYaw = Math.atan2(wx, wz);
        }
        if (!ctx.peaceful && player.alive && dist < SIGHT) {
          this.setState('chase');
          sfx.groan(volumeAt(dist));
        }
        break;
      }
      case 'chase':
        if (ctx.peaceful || !player.alive || dist > SIGHT * 1.6) {
          this.setState('idle');
          break;
        }
        target.set(dx / dist, 0, dz / dist).multiplyScalar(this.speed);
        faceYaw = toPlayerYaw;
        this.groanTimer -= dt;
        if (this.groanTimer <= 0) {
          sfx.groan(volumeAt(dist));
          this.groanTimer = 4 + Math.random() * 5;
        }
        if (dist < ATTACK_RANGE) this.setState('windup');
        break;
      case 'windup':
        faceYaw = toPlayerYaw;
        turnRate = 3;
        if (dist > 0.9) target.set(dx / dist, 0, dz / dist).multiplyScalar(0.4);
        if (this.stateTime >= WINDUP) {
          this.struck = false;
          this.setState('strike');
        }
        break;
      case 'strike': {
        accel = 20;
        target.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(3.5);
        if (!this.struck && this.stateTime >= 0.06) {
          this.struck = true;
          const inFront = Math.abs(wrapAngle(toPlayerYaw - this.yaw)) < 1.1;
          if (dist < HIT_RANGE && inFront && player.takeDamage(DAMAGE, this.pos, ctx) === 'blocked') {
            // Bouncing off a raised guard leaves the zombie wide open.
            this.vel.set(-dx / dist, 0, -dz / dist).multiplyScalar(4);
            this.staggerDuration = 0.8;
            this.setState('stagger');
            break;
          }
        }
        if (this.stateTime >= STRIKE) this.setState('recover');
        break;
      }
      case 'recover':
        if (this.stateTime >= RECOVER) this.setState(player.alive && dist < ATTACK_RANGE ? 'windup' : 'chase');
        break;
      case 'stagger':
        accel = 5;
        if (this.stateTime >= this.staggerDuration) this.setState('chase');
        break;
      case 'dead':
        accel = 4;
        break;
    }

    if (this.state !== 'dead' && this.state !== 'stagger') this.yaw = dampAngle(this.yaw, faceYaw, turnRate, dt);
    const k = smoothing(accel, dt);
    this.vel.x += (target.x - this.vel.x) * k;
    this.vel.z += (target.z - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    resolveColliders(this.pos, this.radius, ctx.colliders);
    this.pos.y = heightAt(this.pos.x, this.pos.z);

    this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
    this.animate(dt);
  }

  takeHit(damage: number, dir: THREE.Vector3, knockback: number, heavy: boolean, ctx: GameContext) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - damage);
    this.hitFlash = 1;
    this.vel.copy(dir).multiplyScalar(knockback);
    const at = new THREE.Vector3(this.pos.x, this.pos.y + 1.3, this.pos.z);
    ctx.particles.burst(at, 0x3f5a2a, heavy ? 14 : 8, 4.5, dir);
    sfx.hit(heavy);
    ctx.floatText(at, String(damage), heavy ? 'heavy' : 'damage');
    if (this.hp <= 0) {
      this.setState('dead');
      ctx.particles.burst(at, 0x2d4020, 16, 5, dir);
      sfx.zombieDie(volumeAt(this.pos.distanceTo(ctx.player.pos)));
      ctx.onEnemyKilled(this);
      return;
    }
    this.staggerDuration = heavy ? 0.7 : 0.38;
    this.setState('stagger');
  }

  /** Billboards the health bar toward the camera; hidden at full health. */
  updateBar(camera: THREE.Camera) {
    this.bar.visible = this.alive && this.hp < this.maxHp;
    if (!this.bar.visible) return;
    this.bar.position.set(this.pos.x, this.pos.y + 2.3, this.pos.z);
    this.bar.quaternion.copy(camera.quaternion);
    this.barFill.scale.x = Math.max(this.hp / this.maxHp, 0.001);
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

    // Shambling walk: hunched, head lolling, arms reaching forward.
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (speed * 2.4 + 0.6);
    const step = Math.sin(this.walkPhase) * Math.min(speed / 2.5, 1) * 0.55;
    h.legL.rotation.x = step;
    h.legR.rotation.x = -step;
    h.torso.rotation.set(0.25, Math.sin(this.walkPhase * 0.5) * 0.1, Math.sin(this.walkPhase) * 0.06);
    h.head.rotation.set(0.15, 0, 0.35 + Math.sin(this.walkPhase * 0.7) * 0.06);
    let reach = -1.4;
    let telegraph = 0;

    switch (this.state) {
      case 'windup': {
        const k = easeOutCubic(Math.min(this.stateTime / WINDUP, 1));
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
        const k = Math.min(this.stateTime / RECOVER, 1);
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
        // Sink into the ground, then vanish until respawn.
        if (this.stateTime > 1.8) h.root.position.y -= (this.stateTime - 1.8) * 0.6;
        h.root.visible = this.stateTime < 3.5;
        break;
      }
    }

    h.armL.rotation.set(reach + step * 0.2, 0, 0.1);
    h.armR.rotation.set(reach - step * 0.2, 0, -0.1);
    if (this.hitFlash > 0) setFlash(h, HIT_COLOR, this.hitFlash * 0.45);
    else setFlash(h, TELEGRAPH_COLOR, telegraph);
  }
}
