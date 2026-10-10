import * as THREE from 'three';
import type { Humanoid, HumanoidLook } from './character';
import { Enemy, RISE_TIME, pick, propMaterial, type EnemyStats } from './enemy';
import type { GameContext, Target } from './types';
import type { WitchKind } from './layout';
import { XP_REWARD } from './progression';
import { easeInOutQuad, easeOutCubic, lerp, smoothing } from './util';
import { sfx, volumeAt } from './audio';

export const WITCH_KINDS: Record<WitchKind, EnemyStats> = {
  hexer: { hp: 120, speed: 3, damage: 14, knockback: 4, scale: 1, poise: 0, windup: 0.7, reach: 1.6 },
  broomWitch: { hp: 100, speed: 6.5, damage: 20, knockback: 7, scale: 0.95, poise: 0, windup: 0.6, reach: 1.6 },
  witchDecoy: { hp: 1, speed: 3, damage: 7, knockback: 2, scale: 1.25, poise: 0, windup: 0.8, reach: 1.6 },
};

const CAST_GLOW = new THREE.Color(0xb04aff);
const SWOOP_GLOW = new THREE.Color(0xff3b5a);

export function witchLook(robe = pick([0x3a2450, 0x2a2a3a, 0x4a2040])): HumanoidLook {
  return {
    skin: pick([0x9dbf8a, 0xb8c4a8, 0xa8b0c8]),
    shirt: robe,
    pants: robe,
    boots: 0x1a1418,
    belt: 0x6a4a2a,
    eyes: 0xd28aff,
    glowingEyes: true,
  };
}

/** Pointy hat and a robe skirt hiding the legs. Returns the glowing orb held in the right hand. */
export function dressWitch(h: Humanoid, robe: number, hatColor = 0x1e1626, band?: number) {
  const hatMat = propMaterial(hatColor);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 10), hatMat);
  brim.position.y = 0.4;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.62, 8), hatMat);
  cone.position.set(0, 0.7, -0.04);
  cone.rotation.x = -0.25;
  h.head.add(brim, cone);
  if (band !== undefined) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.08, 10), propMaterial(band));
    ring.position.y = 0.46;
    h.head.add(ring);
  }
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.62, 0.42), propMaterial(robe));
  skirt.position.y = -0.32;
  h.hips.add(skirt);
  for (const m of [brim, cone, skirt]) m.castShadow = true;

  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), new THREE.MeshBasicMaterial({ color: 0xd8a8ff }));
  orb.position.y = -0.74;
  orb.visible = false;
  h.armR.add(orb);
  return orb;
}

export function createWitch(scene: THREE.Scene, kind: WitchKind): Enemy {
  if (kind === 'broomWitch') return new BroomWitch(scene);
  if (kind === 'witchDecoy') return new WitchDecoy(scene);
  return new Hexer(scene);
}

const CAST_TIME = 0.7;
const BURST_TIME = 0.55;
const BURST_RADIUS = 3;

/**
 * A spellcaster who keeps her distance: strafes at range, flings fire bolts
 * (and slowing hex orbs), and blasts you back if you get too close.
 */
export class Hexer extends Enemy {
  readonly faction = 'witch' as const;
  protected orbChance = 0.2;
  protected castCooldown = 1 + Math.random() * 2;
  protected burstCooldown = 0;
  protected preferred: [number, number] = [4, 10];
  protected readonly orb: THREE.Mesh;
  private strafeDir = Math.random() < 0.5 ? 1 : -1;
  private strafeTimer = 0;

  constructor(scene: THREE.Scene, stats: EnemyStats = WITCH_KINDS.hexer, robe?: number, xp: number = XP_REWARD.hexer, hat?: number, band?: number) {
    const look = witchLook(robe);
    super(scene, stats, look, xp);
    this.bloodColor = 0x5a2a7a;
    this.orb = dressWitch(this.h, look.shirt, hat, band);
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind === 'die') sfx.screech(vol);
    else sfx.cackle(kind === 'idle' ? vol * 0.6 : vol);
  }

  protected spellOrigin() {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    return new THREE.Vector3(this.pos.x + fx * 0.6, this.pos.y + this.airY + 1.45 * this.stats.scale, this.pos.z + fz * 0.6);
  }

  /** Fires this caster's spell at the target. */
  protected castSpell(ctx: GameContext, t: Target) {
    const orb = Math.random() < this.orbChance;
    ctx.projectiles.fire(orb ? 'hexorb' : 'firebolt', this.spellOrigin(), t, orb ? Math.round(this.stats.damage * 0.65) : this.stats.damage);
    sfx.cast(volumeAt(this.pos.distanceTo(ctx.player.pos)));
  }

  /** Keeps at a comfortable spell range, circling the target. */
  protected keepRange(dt: number, dx: number, dz: number, dist: number) {
    const nx = dx / dist;
    const nz = dz / dist;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir *= -1;
      this.strafeTimer = 1.5 + Math.random() * 2;
    }
    const [near, far] = this.preferred;
    if (dist > far) this.desired.set(nx, 0, nz).multiplyScalar(this.stats.speed);
    // Backs off slowly: slower than even a hexed hero, so you can always close in.
    else if (dist < near && dist > 2) this.desired.set(-nx, 0, -nz).multiplyScalar(this.stats.speed * 0.45);
    else this.desired.set(-nz * this.strafeDir, 0, nx * this.strafeDir).multiplyScalar(1.5);
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    const t = this.target;
    this.castCooldown -= dt;
    this.burstCooldown -= dt;
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
        this.faceYaw = Math.atan2(dx, dz);
        this.tickVoice(dt, ctx);
        this.keepRange(dt, dx, dz, dist);
        if (dist < BURST_RADIUS - 0.4 && this.burstCooldown <= 0) this.setState('burst');
        else if (this.castCooldown <= 0 && dist < 18) this.setState('cast');
        break;
      case 'cast':
        this.faceYaw = Math.atan2(dx, dz);
        this.turnRate = 8;
        if (this.stateTime >= CAST_TIME) {
          if (t) this.castSpell(ctx, t);
          this.castCooldown = 3 + Math.random() * 2;
          this.recoverTime = 0.5;
          this.setState('recover');
        }
        break;
      case 'burst':
        // A ring of force that throws you back.
        if (this.stateTime >= BURST_TIME) {
          this.hexBurst(ctx);
          this.burstCooldown = 7;
          this.recoverTime = 0.6;
          this.setState('recover');
        }
        break;
      case 'recover':
        if (this.stateTime >= this.recoverTime) this.setState(t ? 'chase' : 'idle');
        break;
    }
  }

  protected hexBurst(ctx: GameContext) {
    const at = new THREE.Vector3(this.pos.x, this.pos.y + 0.6, this.pos.z);
    ctx.particles.burst(at, 0xb04aff, 24, 7);
    sfx.cast(volumeAt(this.pos.distanceTo(ctx.player.pos)));
    for (const h of [...ctx.players, ...ctx.allies]) {
      if (h.alive && Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z) < BURST_RADIUS * this.stats.scale) {
        h.takeDamage(Math.round(this.stats.damage * 0.8), this.pos, ctx);
      }
    }
  }

  protected pose(h: Humanoid, step: number) {
    h.torso.rotation.x = 0.05;
    h.armL.rotation.set(-step * 0.5 - 0.1, 0, 0.15);
    h.armR.rotation.set(step * 0.5 - 0.2, 0, -0.15);
    this.orb.visible = false;
    switch (this.state) {
      case 'cast': {
        const k = easeOutCubic(Math.min(this.stateTime / CAST_TIME, 1));
        h.armR.rotation.set(lerp(-0.2, -2.4, k), lerp(0, -0.4, k), 0);
        h.armL.rotation.set(-0.8 * k, 0, 0.5 * k);
        h.torso.rotation.y = -0.25 * k;
        this.orb.visible = true;
        this.orb.scale.setScalar(0.4 + k * 1.2);
        this.glow = 0.25 * k;
        this.glowColor = CAST_GLOW;
        break;
      }
      case 'burst': {
        const k = Math.min(this.stateTime / BURST_TIME, 1);
        h.armL.rotation.set(-0.3, 0, 1.4 * k);
        h.armR.rotation.set(-0.3, 0, -1.4 * k);
        h.head.rotation.x = -0.4 * k;
        this.glow = 0.4 * k;
        this.glowColor = CAST_GLOW;
        break;
      }
      case 'recover':
        h.armR.rotation.set(-1.4, 0, 0);
        break;
      case 'stagger':
        h.torso.rotation.x = -0.35;
        h.armL.rotation.set(-0.5, 0, 0.7);
        h.armR.rotation.set(-0.5, 0, -0.7);
        break;
    }
  }
}

/** A mirror image of the Witch Queen: one hit pops it. */
export class WitchDecoy extends Hexer {
  constructor(scene: THREE.Scene) {
    super(scene, WITCH_KINDS.witchDecoy, 0x5a1f6e, 0, 0x2a1030, 0xd9b24a);
    this.orbChance = 0;
    this.preferred = [6, 12];
    this.wanderRadius = 3;
    this.showWorldBar = false;
  }

  /** Decoys burst into smoke instead of leaving a body. */
  override takeHit(damage: number, dir: THREE.Vector3, knockback: number, heavy: boolean, ctx: GameContext, attacker: Target) {
    const result = super.takeHit(damage, dir, knockback, heavy, ctx, attacker);
    if (!this.alive) {
      ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.4, this.pos.z), 0x6a4a8a, 26, 4);
      this.makeDormant();
    }
    return result;
  }
}

const SWOOP_TIME = 0.95;
const CRUISE_HEIGHT = 3.6;
const LOW_HEIGHT = 0.9;

/**
 * Circles overhead on a broom, out of reach, then dives at you. After a
 * swoop she skims low for a moment: that's your chance to strike.
 */
export class BroomWitch extends Enemy {
  readonly faction = 'witch' as const;
  private swoopCooldown = 2 + Math.random() * 2;
  private readonly swoopDir = new THREE.Vector3();
  private readonly swoopHits = new Set<Target>();
  private circleDir = Math.random() < 0.5 ? 1 : -1;
  private readonly broom = new THREE.Group();

  constructor(scene: THREE.Scene) {
    const look = witchLook(pick([0x2a2a3a, 0x3a2450]));
    super(scene, WITCH_KINDS.broomWitch, look, XP_REWARD.broomWitch);
    this.bloodColor = 0x5a2a7a;
    this.flies = true;
    this.wanderRadius = 6;
    dressWitch(this.h, look.shirt);
    // Broom under the hips: a long handle with a bristle tail behind.
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.8), propMaterial(0x6a4a2a));
    handle.position.set(0, -0.12, 0.1);
    const bristles = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 6), propMaterial(0xb89a5a));
    bristles.rotation.x = -Math.PI / 2;
    bristles.position.set(0, -0.12, -0.95);
    this.broom.add(handle, bristles);
    this.broom.traverse((o) => (o.castShadow = true));
    this.h.hips.add(this.broom);
  }

  override spawn(x: number, z: number, rise = false) {
    super.spawn(x, z, false);
    this.airY = rise ? 0.5 : CRUISE_HEIGHT * 0.8;
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind === 'die') sfx.screech(vol);
    else sfx.cackle(kind === 'idle' ? vol * 0.5 : vol);
  }

  private flyTo(height: number, dt: number, rate = 3) {
    this.airY += (height - this.airY) * smoothing(rate, dt);
  }

  protected override afterStagger() {
    this.setState('recover');
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    const t = this.target;
    this.swoopCooldown -= dt;
    switch (this.state) {
      case 'idle':
        this.flyTo(CRUISE_HEIGHT * 0.8, dt);
        this.thinkIdle(dt, ctx);
        break;
      case 'chase': {
        if (!t) {
          this.setState('idle');
          break;
        }
        this.flyTo(CRUISE_HEIGHT, dt);
        this.tickVoice(dt, ctx);
        // Circle the target at a distance.
        const nx = dx / dist;
        const nz = dz / dist;
        const radial = (dist - 8) * 0.8;
        this.desired.set(-nz * this.circleDir * this.stats.speed + nx * radial, 0, nx * this.circleDir * this.stats.speed + nz * radial);
        this.faceYaw = Math.atan2(this.desired.x, this.desired.z);
        if (this.swoopCooldown <= 0 && dist < 14) {
          this.setState('windup');
          sfx.screech(volumeAt(this.pos.distanceTo(ctx.player.pos)) * 0.7);
        }
        break;
      }
      case 'windup':
        this.flyTo(CRUISE_HEIGHT, dt);
        this.faceYaw = Math.atan2(dx, dz);
        this.turnRate = 10;
        if (this.stateTime >= this.stats.windup) {
          this.swoopDir.set(dx / dist, 0, dz / dist);
          this.swoopHits.clear();
          this.yaw = Math.atan2(dx, dz);
          this.setState('swoop');
        }
        break;
      case 'swoop': {
        // Dive down through the target's position and pull up just past it.
        const k = Math.min(this.stateTime / SWOOP_TIME, 1);
        this.accel = 30;
        this.desired.copy(this.swoopDir).multiplyScalar(13);
        this.faceYaw = this.yaw;
        this.airY = k < 0.5 ? lerp(CRUISE_HEIGHT, LOW_HEIGHT - 0.3, easeInOutQuad(k * 2)) : lerp(LOW_HEIGHT - 0.3, LOW_HEIGHT, (k - 0.5) * 2);
        if (this.airY < 1.6) {
          for (const h of [...ctx.players, ...ctx.allies]) {
            if (!h.alive || this.swoopHits.has(h)) continue;
            if (Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z) < 1.3 + h.radius) {
              this.swoopHits.add(h);
              h.takeDamage(this.stats.damage, this.pos, ctx);
            }
          }
        }
        if (k >= 1) {
          this.recoverTime = 1.5;
          this.setState('recover');
        }
        break;
      }
      case 'recover':
        // Skimming low and slow: vulnerable.
        this.flyTo(LOW_HEIGHT, dt, 6);
        this.desired.copy(this.swoopDir).multiplyScalar(2);
        if (this.stateTime >= this.recoverTime) {
          this.swoopCooldown = 2.5 + Math.random() * 2;
          this.circleDir = Math.random() < 0.5 ? 1 : -1;
          this.setState(t ? 'chase' : 'idle');
        }
        break;
    }
  }

  protected pose(h: Humanoid) {
    // Riding side-saddle-free: legs forward along the broom, leaning in.
    h.legL.rotation.x = h.legR.rotation.x = -1.3;
    h.legL.rotation.z = 0.15;
    h.legR.rotation.z = -0.15;
    h.torso.rotation.x = 0.3;
    h.armL.rotation.set(-0.9, -0.2, 0);
    h.armR.rotation.set(-0.9, 0.2, 0);
    this.broom.rotation.x = 0.05 + Math.sin(this.stateTime * 3) * 0.05;
    if (this.state === 'windup') {
      h.head.rotation.x = -0.3;
      h.armR.rotation.set(-2.6, 0, 0); // pointing a bony finger
      this.glow = 0.35 * Math.min(this.stateTime / this.stats.windup, 1);
      this.glowColor = SWOOP_GLOW;
    }
    if (this.state === 'swoop') h.torso.rotation.x = 0.6;
    if (this.state === 'stagger') h.torso.rotation.x = -0.3;
  }
}
