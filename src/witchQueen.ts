import * as THREE from 'three';
import type { EnemyStats } from './enemy';
import type { Humanoid } from './character';
import { Hexer } from './witches';
import type { GameContext } from './types';
import { WITCH_LAND } from './layout';
import { XP_REWARD } from './progression';
import { easeInOutQuad, lerp } from './util';
import { sfx } from './audio';

const ARENA = WITCH_LAND.arena;

const QUEEN_STATS: EnemyStats = {
  hp: 1500,
  speed: 3.2,
  damage: 18,
  knockback: 6,
  scale: 1.25,
  poise: 220,
  windup: 0.6,
  reach: 2.2,
};

const GROUND_TIME = 9;
const ASCEND_TIME = 0.9;
const HOVER_TIME = 7.5;
const HOVER_HEIGHT = 4.5;
const DESCEND_TIME = 0.8;
const EXHAUSTED_TIME = 3.5;
const METEOR_DAMAGE = 24;

/**
 * Leader of the witch covens. Her fight cycles through three phases:
 * - On the ground: fire bolts, hex orbs and the hex burst, like a hexer.
 * - In the air (out of reach): rains marked meteors and fires bolt volleys.
 * - Exhausted after landing: kneels for a few seconds and takes extra damage.
 * At 2/3 and 1/3 health she vanishes and leaves mirror images behind.
 */
export class WitchQueen extends Hexer {
  private phaseTimer = GROUND_TIME;
  private rainTimer = 0;
  private volleyTimer = 0;
  private imagesAt: number[] = [];
  private hoverAngle = 0;

  constructor(scene: THREE.Scene) {
    super(scene, QUEEN_STATS, 0x5a1f6e, XP_REWARD['witch-queen'], 0x2a1030, 0xd9b24a);
    this.showWorldBar = false;
    this.wanderRadius = 0;
    this.flies = true;
    this.preferred = [6, 10];
    this.orbChance = 0.35;
  }

  override spawn(x: number, z: number, rise = false) {
    super.spawn(x, z, rise);
    this.fightActive = false;
    this.phaseTimer = GROUND_TIME;
    this.imagesAt = [0.66, 0.33];
    this.yaw = ARENA.gateAngle;
  }

  protected override damageTakenMultiplier() {
    return this.state === 'exhausted' ? 1.6 : 1;
  }

  protected override canBeStaggered() {
    return super.canBeStaggered() && this.state !== 'ascend' && this.state !== 'hover' && this.state !== 'descend';
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    if (!this.fightActive) {
      super.think(dt, ctx, dx, dz, dist);
      return;
    }
    const grounded = this.state === 'chase' || this.state === 'cast' || this.state === 'burst' || this.state === 'recover';
    if (grounded && this.imagesAt.length > 0 && this.healthFraction <= this.imagesAt[0]) {
      this.imagesAt.shift();
      this.mirrorImages(ctx);
      return;
    }

    switch (this.state) {
      case 'ascend': {
        const k = Math.min(this.stateTime / ASCEND_TIME, 1);
        this.airY = lerp(0, HOVER_HEIGHT, easeInOutQuad(k));
        if (k >= 1) {
          this.phaseTimer = HOVER_TIME;
          this.rainTimer = 0.8;
          this.volleyTimer = 1.8;
          this.hoverAngle = Math.atan2(this.pos.x - ARENA.x, this.pos.z - ARENA.z);
          this.setState('hover');
        }
        return;
      }
      case 'hover': {
        this.airY = HOVER_HEIGHT + Math.sin(this.stateTime * 2) * 0.3;
        // Drift around the arena, always facing her prey.
        this.hoverAngle += dt * 0.35;
        const tx = ARENA.x + Math.sin(this.hoverAngle) * 6;
        const tz = ARENA.z + Math.cos(this.hoverAngle) * 6;
        const hx = tx - this.pos.x;
        const hz = tz - this.pos.z;
        const hd = Math.max(Math.hypot(hx, hz), 1e-3);
        this.desired.set(hx / hd, 0, hz / hd).multiplyScalar(Math.min(4, hd * 2));
        if (this.target) this.faceYaw = Math.atan2(dx, dz);
        this.rainTimer -= dt;
        this.volleyTimer -= dt;
        if (this.rainTimer <= 0) {
          this.spellRain(ctx);
          this.rainTimer = 2.4;
        }
        if (this.volleyTimer <= 0) {
          this.volley(ctx);
          this.volleyTimer = 2.4;
        }
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.setState('descend');
        return;
      }
      case 'descend': {
        const k = Math.min(this.stateTime / DESCEND_TIME, 1);
        this.airY = lerp(HOVER_HEIGHT, 0, easeInOutQuad(k));
        if (k >= 1) {
          this.airY = 0;
          ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 0.3, this.pos.z), 0x6a4a8a, 20, 5);
          if (this.pos.distanceTo(ctx.player.pos) < 20) ctx.addShake(0.3);
          this.setState('exhausted');
        }
        return;
      }
      case 'exhausted':
        if (this.stateTime >= EXHAUSTED_TIME) {
          this.phaseTimer = GROUND_TIME;
          this.setState('chase');
        }
        return;
    }

    if (grounded) {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0 && this.state === 'chase') {
        sfx.cackle(1);
        this.setState('ascend');
        return;
      }
    }
    super.think(dt, ctx, dx, dz, dist);
  }

  /** Marked meteors: one on the target and a few scattered around them. */
  private spellRain(ctx: GameContext) {
    const t = this.target;
    if (!t) return;
    ctx.projectiles.meteor(t.pos, METEOR_DAMAGE, 1.2);
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.5 + Math.random() * 3;
      ctx.projectiles.meteor(new THREE.Vector3(t.pos.x + Math.sin(a) * r, 0, t.pos.z + Math.cos(a) * r), METEOR_DAMAGE, 1.1 + Math.random() * 0.5);
    }
    sfx.cast(1);
  }

  /** Three fire bolts in a fan. */
  private volley(ctx: GameContext) {
    const t = this.target;
    if (!t) return;
    for (const spread of [-0.22, 0, 0.22]) ctx.projectiles.fire('firebolt', this.spellOrigin(), t, this.stats.damage, spread);
    sfx.cast(1);
  }

  /** Vanishes in smoke, reappears elsewhere in the arena, and leaves copies of herself. */
  private mirrorImages(ctx: GameContext) {
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.4, this.pos.z), 0x6a4a8a, 30, 5);
    const a = Math.random() * Math.PI * 2;
    const r = 4 + Math.random() * 5;
    this.pos.set(ARENA.x + Math.sin(a) * r, this.pos.y, ARENA.z + Math.cos(a) * r);
    ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 1.4, this.pos.z), 0x6a4a8a, 30, 5);
    ctx.summonMinions(this, 2);
    sfx.cackle(1);
    this.castCooldown = 1.5;
    this.setState('chase');
  }

  protected override pose(h: Humanoid, step: number) {
    if (this.state === 'ascend' || this.state === 'hover' || this.state === 'descend') {
      // Floating, arms raised, robes hanging.
      h.legL.rotation.x = 0.15;
      h.legR.rotation.x = -0.1;
      h.torso.rotation.x = -0.1;
      h.armL.rotation.set(-0.4, 0, 1.1 + Math.sin(this.stateTime * 3) * 0.1);
      h.armR.rotation.set(-0.4, 0, -1.1 - Math.sin(this.stateTime * 3) * 0.1);
      this.orb.visible = true;
      this.orb.scale.setScalar(1.4);
      return;
    }
    if (this.state === 'exhausted') {
      // Kneeling, spent.
      h.hips.position.y = 0.55;
      h.legL.rotation.x = -1.5;
      h.legR.rotation.x = 0.3;
      h.torso.rotation.x = 0.55;
      h.head.rotation.x = 0.4;
      h.armL.rotation.set(0.2, 0, 0.2);
      h.armR.rotation.set(-0.6, 0, -0.2);
      this.orb.visible = false;
      return;
    }
    super.pose(h, step);
  }
}
