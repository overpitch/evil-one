import * as THREE from 'three';
import type { EnemyStats } from './enemy';
import { Zombie } from './zombies';
import type { Humanoid } from './character';
import type { GameContext, Target } from './types';
import { ZOMBIE_LAND } from './layout';
import { XP_REWARD } from './progression';
import { easeInOutQuad, lerp } from './util';
import { heightAt } from './world';
import { sfx } from './audio';

const KING_ARENA = ZOMBIE_LAND.arena;

const KING_STATS: EnemyStats = {
  hp: 1400,
  speed: 2.6,
  damage: 18,
  knockback: 8,
  scale: 1.7,
  poise: 220,
  windup: 0.75,
  reach: 2.4,
};

const LEAP_TIME = 0.95;
const LEAP_HEIGHT = 2.8;
const ROAR_TIME = 1.6;
const SHOCKWAVE_RADIUS = 7.5;
const SHOCKWAVE_SPEED = 12;
const SHOCKWAVE_DAMAGE = 28;

/**
 * Expanding ring from the ground pound. It can't be blocked: roll through
 * it (the dodge roll's invincibility frames) or be out of range.
 */
export class Shockwave {
  readonly mesh: THREE.Mesh;
  private radius = 0;
  private active = false;
  private readonly center = new THREE.Vector3();
  private readonly hit = new Set<Target>();
  private readonly material: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.MeshBasicMaterial({ color: 0xe8d8a8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2), this.material);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  start(at: THREE.Vector3) {
    this.center.copy(at);
    this.radius = 0.5;
    this.active = true;
    this.hit.clear();
    this.mesh.visible = true;
    this.mesh.position.set(at.x, at.y + 0.15, at.z);
  }

  update(dt: number, ctx: GameContext) {
    if (!this.active) return;
    this.radius += SHOCKWAVE_SPEED * dt;
    this.mesh.scale.setScalar(this.radius);
    this.material.opacity = 0.85 * (1 - this.radius / SHOCKWAVE_RADIUS);
    for (const t of [ctx.player as Target, ...ctx.allies]) {
      if (!t.alive || this.hit.has(t)) continue;
      const d = Math.hypot(t.pos.x - this.center.x, t.pos.z - this.center.z);
      if (Math.abs(d - this.radius) < 0.8) {
        this.hit.add(t);
        t.takeDamage(SHOCKWAVE_DAMAGE, this.center, ctx, true);
      }
    }
    if (this.radius >= SHOCKWAVE_RADIUS) {
      this.active = false;
      this.mesh.visible = false;
    }
  }

  reset() {
    this.active = false;
    this.mesh.visible = false;
  }
}

/**
 * Leader of the zombie army. Fights like a giant zombie plus three tricks:
 * - Ground pound: leaps at you and lands with an unblockable shockwave.
 * - Roar: at 2/3 and 1/3 health, raises zombies from the ground.
 * - Enrage: below 1/3 health it moves and swings faster.
 */
export class ZombieKing extends Zombie {
  enraged = false;

  private summonAt: number[] = [];
  private summoned = false;
  private poundCooldown = 0;
  private readonly leapFrom = new THREE.Vector3();
  private readonly leapTo = new THREE.Vector3();
  private readonly shockwave: Shockwave;
  private readonly landingMarker: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    super(
      scene,
      KING_STATS,
      {
        skin: 0x7d9a6a,
        shirt: 0x4b2a5e, // tattered royal purple
        pants: 0x2b2233,
        boots: 0x1e1a18,
        belt: 0xc9a24a,
        eyes: 0xff3b2f,
        glowingEyes: true,
      },
      XP_REWARD['zombie-king'],
    );
    this.showWorldBar = false;
    this.wanderRadius = 0;

    // Crown
    const gold = new THREE.MeshLambertMaterial({ color: 0xd9b24a, flatShading: true, emissive: 0x3a2a00 });
    const crown = new THREE.Group();
    crown.position.y = 0.44;
    for (const [w, d, x, z] of [[0.44, 0.06, 0, 0.2], [0.44, 0.06, 0, -0.2], [0.06, 0.44, 0.2, 0], [0.06, 0.44, -0.2, 0]]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), gold);
      band.position.set(x, 0, z);
      crown.add(band);
    }
    for (const [x, z] of [[0.18, 0.18], [-0.18, 0.18], [0.18, -0.18], [-0.18, -0.18], [0, 0.2], [0, -0.2]]) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 4), gold);
      spike.position.set(x, 0.13, z);
      crown.add(spike);
    }
    this.h.head.add(crown);

    this.shockwave = new Shockwave(scene);
    this.landingMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.landingMarker.visible = false;
    scene.add(this.landingMarker);
  }

  override spawn(x: number, z: number, rise = false) {
    super.spawn(x, z, rise);
    this.fightActive = false;
    this.enraged = false;
    this.summonAt = [0.66, 0.33];
    this.poundCooldown = 3;
    this.stats.speed = KING_STATS.speed;
    this.stats.windup = KING_STATS.windup;
    this.yaw = Math.PI; // facing the arena gate
    this.shockwave.reset();
    this.landingMarker.visible = false;
  }

  override makeDormant() {
    super.makeDormant();
    this.shockwave.reset();
    this.landingMarker.visible = false;
  }

  override update(dt: number, ctx: GameContext) {
    super.update(dt, ctx);
    this.shockwave.update(dt, ctx);
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    this.poundCooldown -= dt;

    if (!this.enraged && this.healthFraction < 0.33) {
      this.enraged = true;
      this.stats.speed = KING_STATS.speed * 1.35;
      this.stats.windup = KING_STATS.windup * 0.7;
    }

    if (this.state === 'leap') {
      this.thinkLeap(ctx);
      return;
    }
    if (this.state === 'roar') {
      this.faceYaw = Math.atan2(dx, dz);
      if (!this.summoned && this.stateTime > 0.6) {
        this.summoned = true;
        ctx.summonMinions(this, this.enraged ? 3 : 2);
        ctx.addShake(0.5);
      }
      if (this.stateTime >= ROAR_TIME) this.setState('chase');
      return;
    }
    if (this.state === 'chase' && this.target) {
      if (this.summonAt.length > 0 && this.healthFraction <= this.summonAt[0]) {
        this.summonAt.shift();
        this.summoned = false;
        this.setState('roar');
        sfx.groan(1);
        ctx.addShake(0.3);
        return;
      }
      // Leaps onto you from mid-range, or hops in place when you're up close.
      if (this.poundCooldown <= 0 && dist < 9) {
        this.leapFrom.copy(this.pos);
        this.leapTo.copy(this.target.pos);
        // Keep the landing inside the arena.
        const ax = this.leapTo.x - KING_ARENA.x;
        const az = this.leapTo.z - KING_ARENA.z;
        const ad = Math.hypot(ax, az);
        const maxR = KING_ARENA.r - 2;
        if (ad > maxR) this.leapTo.set(KING_ARENA.x + (ax / ad) * maxR, 0, KING_ARENA.z + (az / ad) * maxR);
        this.leapTo.y = heightAt(this.leapTo.x, this.leapTo.z);
        this.landingMarker.position.set(this.leapTo.x, this.leapTo.y + 0.12, this.leapTo.z);
        this.landingMarker.visible = true;
        this.setState('leap');
        return;
      }
    }
    super.think(dt, ctx, dx, dz, dist);
  }

  private thinkLeap(ctx: GameContext) {
    const t = Math.min(this.stateTime / LEAP_TIME, 1);
    const k = easeInOutQuad(t);
    this.pos.x = lerp(this.leapFrom.x, this.leapTo.x, k);
    this.pos.z = lerp(this.leapFrom.z, this.leapTo.z, k);
    this.vel.set(0, 0, 0);
    this.airY = Math.sin(t * Math.PI) * LEAP_HEIGHT;
    this.faceYaw = Math.atan2(this.leapTo.x - this.leapFrom.x, this.leapTo.z - this.leapFrom.z);
    // Warning ring pulses faster as the landing nears.
    this.landingMarker.scale.setScalar(SHOCKWAVE_RADIUS * (0.3 + 0.7 * t));
    (this.landingMarker.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.35 * Math.abs(Math.sin(t * 14));
    if (t >= 1) {
      this.airY = 0;
      this.landingMarker.visible = false;
      this.shockwave.start(this.pos);
      const near = this.pos.distanceTo(ctx.player.pos) < 20;
      if (near) ctx.addShake(0.7);
      sfx.hit(true);
      ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 0.3, this.pos.z), 0x8a7a5a, 30, 7);
      this.poundCooldown = this.enraged ? 4.5 : 7;
      this.recoverTime = 1.2; // a long opening to punish
      this.setState('recover');
    }
  }

  protected override canBeStaggered() {
    return super.canBeStaggered() && this.state !== 'leap' && this.state !== 'roar';
  }

  protected override pose(h: Humanoid, step: number) {
    if (this.state === 'leap') {
      const t = Math.min(this.stateTime / LEAP_TIME, 1);
      h.legL.rotation.x = h.legR.rotation.x = -0.9 * Math.sin(t * Math.PI);
      h.torso.rotation.x = -0.2;
      h.armL.rotation.set(-2.9, 0, 0.1); // both fists raised overhead
      h.armR.rotation.set(-2.9, 0, -0.1);
      return;
    }
    if (this.state === 'roar') {
      h.torso.rotation.x = -0.35;
      h.head.rotation.set(-0.6, 0, 0);
      h.armL.rotation.set(-0.4, 0, 1.3);
      h.armR.rotation.set(-0.4, 0, -1.3);
      return;
    }
    super.pose(h, step);
  }
}
