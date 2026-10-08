import * as THREE from 'three';
import type { EnemyState, EnemyStats, StrikeOutcome } from './enemy';
import type { Humanoid } from './character';
import { VampireKnight, vampireLook } from './vampires';
import type { GameContext, Target } from './types';
import { VAMPIRE_LAND } from './layout';
import { XP_REWARD } from './progression';
import { lerp } from './util';
import { sfx } from './audio';

const ARENA = VAMPIRE_LAND.arena;

const LORD_STATS: EnemyStats = {
  hp: 2000,
  speed: 4.4,
  damage: 22,
  knockback: 6,
  scale: 1.3,
  poise: 240,
  windup: 0.5,
  reach: 2.4,
};

const LUNGE_WINDUP = 0.65;
const LUNGE_DASH = 0.4;
const GRAB_TIME = 1.8;
const GRAB_TICK = 0.45;
const GRAB_DAMAGE = 7;
const BAT_TIME = 1.8;
const BAT_COUNT = 16;
const DRAIN_GLOW = new THREE.Color(0xff1a2a);

/**
 * Leader of the vampire lords: a sword duelist.
 * - Three-swing combos, then a long opening to punish.
 * - Parries often and counters instantly: attack after his combos.
 * - Life-drain lunge: a crouch and red glow, then a dash. Roll away or be
 *   seized and drained.
 * - At 2/3 and 1/3 health he bursts into bats, flies across the arena and
 *   calls thralls.
 */
export class VampireLord extends VampireKnight {
  private combo = 0;
  /** After a full combo he circles for a moment instead of attacking: your opening. */
  private comboRest = 0;
  private circleDir = 1;
  private lungeCooldown = 6;
  private grabTick = 0;
  private batsAt: number[] = [];
  private readonly batTarget = new THREE.Vector3();
  private readonly lungeDir = new THREE.Vector3();
  private readonly swarm = new THREE.Group();

  constructor(scene: THREE.Scene) {
    super(scene, LORD_STATS, vampireLook('lord'), XP_REWARD['vampire-lord'], 0x8a0a1a);
    this.showWorldBar = false;
    this.wanderRadius = 0;
    this.parryChance = 0.45;
    this.lifesteal = 0.6;

    const wingMat = new THREE.MeshBasicMaterial({ color: 0x120a10 });
    const wingGeo = new THREE.BoxGeometry(0.32, 0.03, 0.16).translate(0.16, 0, 0);
    for (let i = 0; i < BAT_COUNT; i++) {
      const bat = new THREE.Group();
      const left = new THREE.Mesh(wingGeo, wingMat);
      const right = new THREE.Mesh(wingGeo, wingMat);
      right.rotation.y = Math.PI;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.18), wingMat);
      bat.add(left, right, body);
      this.swarm.add(bat);
    }
    this.swarm.visible = false;
    scene.add(this.swarm);
  }

  override spawn(x: number, z: number, rise = false) {
    super.spawn(x, z, rise);
    this.fightActive = false;
    this.combo = 0;
    this.comboRest = 0;
    this.lungeCooldown = 6;
    this.batsAt = [0.66, 0.33];
    this.blinkCooldown = Infinity; // the Lord uses bat form instead
    this.yaw = ARENA.gateAngle;
    this.swarm.visible = false;
  }

  override makeDormant() {
    super.makeDormant();
    this.swarm.visible = false;
  }

  override takeHit(damage: number, dir: THREE.Vector3, knockback: number, heavy: boolean, ctx: GameContext, attacker: Target): StrikeOutcome {
    if (this.state === 'bats') return 'ignored';
    return super.takeHit(damage, dir, knockback, heavy, ctx, attacker);
  }

  protected override canBeStaggered() {
    return super.canBeStaggered() && this.state !== 'lunge' && this.state !== 'grab';
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    if (!this.fightActive) {
      super.think(dt, ctx, dx, dz, dist);
      return;
    }
    this.lungeCooldown -= dt;
    const player = ctx.player;

    switch (this.state) {
      case 'bats':
        this.thinkBats(ctx);
        return;
      case 'lunge':
        this.thinkLunge(ctx, dx, dz);
        return;
      case 'grab':
        this.thinkGrab(dt, ctx);
        return;
    }

    if ((this.state === 'chase' || this.state === 'recover') && this.batsAt.length > 0 && this.healthFraction <= this.batsAt[0]) {
      this.batsAt.shift();
      this.startBats(ctx);
      return;
    }
    if (this.state === 'chase') {
      this.combo = 0;
      if (this.lungeCooldown <= 0 && this.target === player && dist > 3 && dist < 8) {
        this.lungeDir.set(dx / dist, 0, dz / dist);
        sfx.hiss(1);
        this.setState('lunge');
        return;
      }
      if (this.comboRest > 0) {
        // Circle at sword's length, watching.
        this.comboRest -= dt;
        const nx = dx / dist;
        const nz = dz / dist;
        const radial = (dist - 3.2) * 1.5;
        this.desired.set(-nz * this.circleDir * 2.2 + nx * radial, 0, nx * this.circleDir * 2.2 + nz * radial);
        this.faceYaw = Math.atan2(dx, dz);
        return;
      }
    }
    super.think(dt, ctx, dx, dz, dist);
  }

  /** After each swing, chain straight into the next one, up to three; then a long opening. */
  protected override setState(state: EnemyState) {
    if (state === 'recover' && this.state === 'strike' && this.fightActive) {
      if (this.combo < 2 && this.target?.alive) {
        this.combo++;
        this.countering = true;
        super.setState('windup');
        return;
      }
      this.recoverTime = 1.1;
      this.comboRest = 1.5;
      this.circleDir = Math.random() < 0.5 ? 1 : -1;
    }
    super.setState(state);
  }

  private thinkLunge(ctx: GameContext, dx: number, dz: number) {
    const player = ctx.player;
    if (this.stateTime < LUNGE_WINDUP) {
      this.faceYaw = Math.atan2(dx, dz);
      this.turnRate = 8;
      const d = Math.max(Math.hypot(dx, dz), 1e-3);
      this.lungeDir.set(dx / d, 0, dz / d);
      return;
    }
    this.accel = 40;
    this.desired.copy(this.lungeDir).multiplyScalar(15);
    this.faceYaw = Math.atan2(this.lungeDir.x, this.lungeDir.z);
    const reach = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    if (player.alive && !player.invulnerable && reach < 1.6) {
      player.startGrab();
      this.grabTick = 0.2;
      this.vel.set(0, 0, 0);
      this.setState('grab');
      return;
    }
    if (this.stateTime >= LUNGE_WINDUP + LUNGE_DASH) {
      this.lungeCooldown = 8 + Math.random() * 3;
      this.recoverTime = 1.2;
      this.setState('recover');
    }
  }

  private thinkGrab(dt: number, ctx: GameContext) {
    const player = ctx.player;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    player.holdAt(this.pos.x + fx * 1.25, this.pos.z + fz * 1.25);
    this.grabTick -= dt;
    if (this.grabTick <= 0 && player.alive) {
      this.grabTick = GRAB_TICK;
      player.takeDamage(GRAB_DAMAGE, this.pos, ctx, true);
      this.hp = Math.min(this.maxHp, this.hp + GRAB_DAMAGE * 2);
      ctx.particles.burst(new THREE.Vector3(player.pos.x, player.pos.y + 1.3, player.pos.z), 0x8a0f0f, 6, 2);
    }
    if (this.stateTime >= GRAB_TIME || !player.alive) {
      player.release(new THREE.Vector3(fx, 0, fz));
      ctx.addShake(0.3);
      this.lungeCooldown = 9 + Math.random() * 3;
      this.recoverTime = 0.8;
      this.setState('recover');
    }
  }

  /** Bursts into bats and flies to the far side of the arena. */
  private startBats(ctx: GameContext) {
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.5, this.pos.z), 0x1a1018, 26, 4);
    sfx.bats(1);
    const player = ctx.player;
    let best = 0;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * (ARENA.r - 6);
      const x = ARENA.x + Math.sin(a) * r;
      const z = ARENA.z + Math.cos(a) * r;
      const d = Math.hypot(x - player.pos.x, z - player.pos.z);
      if (d > best) {
        best = d;
        this.batTarget.set(x, 0, z);
      }
    }
    this.setState('bats');
  }

  private thinkBats(ctx: GameContext) {
    const bx = this.batTarget.x - this.pos.x;
    const bz = this.batTarget.z - this.pos.z;
    const bd = Math.max(Math.hypot(bx, bz), 1e-3);
    this.accel = 20;
    this.desired.set(bx / bd, 0, bz / bd).multiplyScalar(Math.min(12, bd * 3));
    if (this.stateTime >= BAT_TIME) {
      ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.5, this.pos.z), 0x1a1018, 26, 4);
      ctx.summonMinions(this, 2);
      sfx.hiss(1);
      this.setState('chase');
    }
  }

  protected override pose(h: Humanoid, step: number) {
    this.swarm.visible = this.state === 'bats';
    if (this.state === 'bats') {
      h.root.visible = false;
      this.swarm.position.set(this.pos.x, this.pos.y + 1.6, this.pos.z);
      this.swarm.children.forEach((bat, i) => {
        const a = this.stateTime * 6 + (i / BAT_COUNT) * Math.PI * 2;
        const r = 0.6 + (i % 3) * 0.35;
        bat.position.set(Math.sin(a) * r, Math.sin(a * 1.7 + i) * 0.5, Math.cos(a) * r);
        bat.rotation.y = a + Math.PI / 2;
        const flap = Math.sin(this.stateTime * 30 + i) * 0.7;
        bat.children[0].rotation.z = flap;
        bat.children[1].rotation.z = -flap;
      });
      return;
    }
    if (this.state === 'lunge') {
      const crouch = this.stateTime < LUNGE_WINDUP;
      const k = Math.min(this.stateTime / LUNGE_WINDUP, 1);
      h.hips.position.y = crouch ? lerp(0.95, 0.7, k) : 0.85;
      h.torso.rotation.x = crouch ? lerp(0.05, 0.6, k) : 0.5;
      h.armL.rotation.set(crouch ? 0.6 : -1.6, 0, 0.3);
      h.armR.rotation.set(crouch ? 0.6 : -1.6, 0, -0.3);
      h.legL.rotation.x = -0.6;
      h.legR.rotation.x = 0.4;
      this.glow = crouch ? 0.5 * k : 0.3;
      this.glowColor = DRAIN_GLOW;
      return;
    }
    if (this.state === 'grab') {
      h.torso.rotation.x = 0.35;
      h.head.rotation.x = 0.3;
      h.armL.rotation.set(-1.5, -0.3, 0);
      h.armR.rotation.set(-1.5, 0.3, 0);
      this.glow = 0.3 + 0.15 * Math.sin(this.stateTime * 12);
      this.glowColor = DRAIN_GLOW;
      return;
    }
    super.pose(h, step);
  }
}
