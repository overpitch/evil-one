import * as THREE from 'three';
import { Enemy, propMaterial, type EnemyState, type EnemyStats, type StrikeOutcome } from './enemy';
import type { Humanoid } from './character';
import type { GameContext, Target } from './types';
import type { Player } from './player';
import { addCape } from './vampires';
import { Shockwave } from './zombieKing';
import { FORTRESS } from './layout';
import { XP_REWARD } from './progression';
import { easeInOutQuad, easeOutCubic, lerp } from './util';
import { sfx, volumeAt } from './audio';

const ARENA = FORTRESS.arena;

const STATS: EnemyStats = {
  hp: 3200,
  speed: 3.6,
  damage: 20,
  knockback: 8,
  scale: 1.55,
  poise: 260,
  windup: 0.8,
  reach: 2.8,
};

const CAST_TIME = 0.7;
const ROAR_TIME = 1.6;
const CHARGE_WINDUP = 0.75;
const CHARGE_DASH = 0.6;
const BITE_WINDUP = 0.6;
const BITE_DASH = 0.35;
const GRAB_TIME = 1.6;
const GRAB_TICK = 0.4;
const GRAB_DAMAGE = 8;
const ASCEND_TIME = 0.8;
const HOVER_TIME = 5;
const HOVER_HEIGHT = 4;
const DESCEND_TIME = 0.7;
const EXHAUSTED_TIME = 2;
const REGEN_DELAY = 4;
const REGEN_RATE = 6;

const HUMAN_GLOW = new THREE.Color(0xffb04a);
const ZOMBIE_GLOW = new THREE.Color(0x6aff4a);
const WITCH_GLOW = new THREE.Color(0xb04aff);
const BITE_GLOW = new THREE.Color(0xff2a2a);

/**
 * Zomawi: once a general of the human army, raised from the grave as a
 * zombie, and bound with the witches' magic. Fights with all three natures
 * at once, and grows more desperate as it weakens:
 *
 * - Human: greatsword combos (three swings, then a pause) and a charging lunge
 *   across the arena.
 * - Zombie: regenerates when left alone, raises the dead, and a biting grab.
 * - Witch: fire-bolt fans and hex orbs; levitates out of reach to rain meteors,
 *   then lands exhausted.
 * - At 2/3 and 1/3 health it roars: a shockwave, more dead, and every
 *   cooldown gets shorter.
 */
export class Zomawi extends Enemy {
  readonly faction = 'zombie' as const;
  private stage = 0;
  private thresholds: number[] = [];
  private combo = 0;
  private comboRest = 0;
  private quickSwing = false;
  private circleDir = 1;
  private spellCd = 0;
  private summonCd = 0;
  private chargeCd = 0;
  private biteCd = 0;
  private levitateCd = 0;
  private sinceHit = 0;
  private regenerating = false;
  private lungeKind: 'charge' | 'bite' = 'charge';
  private readonly lungeDir = new THREE.Vector3();
  private readonly chargeHits = new Set<Target>();
  private grabTick = 0;
  /** The hero in its grip. */
  private held: Player | null = null;
  private hoverAngle = 0;
  private rainCd = 0;
  private orbCd = 0;
  private roared = false;
  private readonly shockwave: Shockwave;

  constructor(scene: THREE.Scene) {
    super(
      scene,
      STATS,
      {
        skin: 0xd8b48a,
        shirt: 0x5a1a22, // the old general's tabard, faded to blood red
        pants: 0x2a2a30,
        boots: 0x1a1618,
        belt: 0xd9b24a,
        armor: 0x5a5e68,
        eyes: 0x9ad8ff, // the human eye
        glowingEyes: true,
        sword: true,
      },
      XP_REWARD.zomawi,
    );
    this.showWorldBar = false;
    this.wanderRadius = 0;
    this.bloodColor = 0x4a2a3a;
    const h = this.h;

    // The zombie half: the right arm and leg are rotting flesh.
    const rot = new THREE.MeshLambertMaterial({ color: 0x6f9a5a, flatShading: true });
    h.materials.push(rot);
    for (const child of [...h.armR.children, ...h.legR.children]) {
      if (child !== h.sword && child instanceof THREE.Mesh) child.material = rot;
    }
    // ...and the right side of the face, with a sickly yellow eye.
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.39, 0.375), rot);
    patch.position.set(-0.095, 0.2, 0);
    const deadEye = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.02), new THREE.MeshBasicMaterial({ color: 0xfff27a }));
    deadEye.position.set(-0.08, 0.24, 0.195);
    h.head.add(patch, deadEye);

    // The witch: a tattered cloak and a crowned, crooked hat.
    addCape(h, 0x3a1a4a);
    const hatMat = propMaterial(0x1e1626);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 10), hatMat);
    brim.position.y = 0.45;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.7, 8), hatMat);
    cone.position.set(0, 0.78, -0.06);
    cone.rotation.x = -0.35;
    const gold = propMaterial(0xd9b24a);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 10), gold);
    band.position.y = 0.52;
    h.head.add(brim, cone, band);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 4), gold);
      spike.position.set(Math.sin(a) * 0.24, 0.62, Math.cos(a) * 0.24);
      h.head.add(spike);
    }
    for (const m of [patch, brim, cone, band]) m.castShadow = true;

    // The general's greatsword.
    h.sword!.scale.set(1.3, 1.3, 1.6);

    this.shockwave = new Shockwave(scene);
  }

  override spawn(x: number, z: number, rise = false) {
    super.spawn(x, z, rise);
    this.fightActive = false;
    this.stage = 0;
    this.thresholds = [0.66, 0.33];
    this.combo = 0;
    this.comboRest = 0;
    this.spellCd = 3;
    this.summonCd = 10;
    this.chargeCd = 6;
    this.biteCd = 9;
    this.levitateCd = 16;
    this.sinceHit = 0;
    this.yaw = ARENA.gateAngle + Math.PI;
    this.shockwave.reset();
  }

  override makeDormant() {
    super.makeDormant();
    this.shockwave.reset();
  }

  override update(dt: number, ctx: GameContext) {
    super.update(dt, ctx);
    this.shockwave.update(dt, ctx);
    // The zombie in it knits its wounds closed when left alone.
    this.sinceHit += dt;
    this.regenerating = this.fightActive && this.alive && this.sinceHit > REGEN_DELAY && this.hp < this.maxHp;
    if (this.regenerating) this.hp = Math.min(this.maxHp, this.hp + REGEN_RATE * dt);
  }

  override takeHit(damage: number, dir: THREE.Vector3, knockback: number, heavy: boolean, ctx: GameContext, attacker: Target): StrikeOutcome {
    const result = super.takeHit(damage, dir, knockback, heavy, ctx, attacker);
    if (result === 'hit') this.sinceHit = 0;
    return result;
  }

  protected voice(kind: 'alert' | 'idle' | 'die', vol: number) {
    if (kind === 'die') sfx.zombieDie(vol);
    else if (kind === 'alert') sfx.roar();
  }

  protected override damageTakenMultiplier() {
    return this.state === 'exhausted' ? 1.4 : 1;
  }

  protected override canBeStaggered() {
    return this.state === 'chase' || this.state === 'recover' || this.state === 'cast' || this.state === 'exhausted';
  }

  /** After each swing, chain into the next, up to three; then a pause. */
  protected override setState(state: EnemyState) {
    if (state === 'recover' && this.state === 'strike' && this.fightActive) {
      if (this.combo < 2 && this.target?.alive) {
        this.combo++;
        this.quickSwing = true;
        super.setState('windup');
        return;
      }
      this.recoverTime = 1.2;
      this.comboRest = 2 - this.stage * 0.3;
      this.circleDir = Math.random() < 0.5 ? 1 : -1;
    }
    super.setState(state);
  }

  protected override think(dt: number, ctx: GameContext, dx: number, dz: number, dist: number) {
    if (!this.fightActive) {
      super.think(dt, ctx, dx, dz, dist);
      return;
    }
    for (const key of ['spellCd', 'summonCd', 'chargeCd', 'biteCd', 'levitateCd'] as const) this[key] -= dt;
    const t = this.target;
    const toTarget = Math.atan2(dx, dz);

    switch (this.state) {
      case 'roar':
        this.faceYaw = toTarget;
        if (!this.roared && this.stateTime > 0.5) {
          this.roared = true;
          this.shockwave.start(this.pos);
          ctx.addShake(0.6);
          ctx.summonMinions(this, 2 + this.stage);
          ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 0.3, this.pos.z), 0x6a4a3a, 30, 7);
        }
        if (this.stateTime >= ROAR_TIME) this.setState('chase');
        return;
      case 'cast':
        this.faceYaw = toTarget;
        this.turnRate = 8;
        if (this.stateTime >= CAST_TIME) {
          if (t) this.castSpells(ctx, t);
          this.recoverTime = 0.5;
          this.setState('recover');
        }
        return;
      case 'lunge':
        this.thinkLunge(ctx, dx, dz, dist);
        return;
      case 'grab':
        this.thinkGrab(dt, ctx);
        return;
      case 'ascend': {
        const k = Math.min(this.stateTime / ASCEND_TIME, 1);
        this.airY = lerp(0, HOVER_HEIGHT, easeInOutQuad(k));
        if (k >= 1) {
          this.hoverAngle = Math.atan2(this.pos.x - ARENA.x, this.pos.z - ARENA.z);
          this.rainCd = 0.6;
          this.orbCd = 1.6;
          this.setState('hover');
        }
        return;
      }
      case 'hover': {
        this.airY = HOVER_HEIGHT + Math.sin(this.stateTime * 2) * 0.3;
        this.hoverAngle += dt * 0.4;
        const tx = ARENA.x + Math.sin(this.hoverAngle) * 7;
        const tz = ARENA.z + Math.cos(this.hoverAngle) * 7;
        const hx = tx - this.pos.x;
        const hz = tz - this.pos.z;
        const hd = Math.max(Math.hypot(hx, hz), 1e-3);
        this.desired.set(hx / hd, 0, hz / hd).multiplyScalar(Math.min(4, hd * 2));
        if (t) this.faceYaw = toTarget;
        this.rainCd -= dt;
        this.orbCd -= dt;
        if (this.rainCd <= 0 && t) {
          this.rainCd = 2 - this.stage * 0.3;
          ctx.projectiles.meteor(t.pos, 26, 1.2);
          for (let i = 0; i < 3 + this.stage; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 2.5 + Math.random() * 3.5;
            ctx.projectiles.meteor(new THREE.Vector3(t.pos.x + Math.sin(a) * r, 0, t.pos.z + Math.cos(a) * r), 26, 1.1 + Math.random() * 0.5);
          }
          sfx.cast(1);
        }
        if (this.orbCd <= 0 && t) {
          this.orbCd = 2.2;
          ctx.projectiles.fire('hexorb', this.spellOrigin(), t, 14);
        }
        if (this.stateTime >= HOVER_TIME) this.setState('descend');
        return;
      }
      case 'descend': {
        const k = Math.min(this.stateTime / DESCEND_TIME, 1);
        this.airY = lerp(HOVER_HEIGHT, 0, easeInOutQuad(k));
        if (k >= 1) {
          this.airY = 0;
          ctx.particles.burst(new THREE.Vector3(this.pos.x, this.pos.y + 0.3, this.pos.z), 0x6a4a8a, 24, 5);
          if (this.pos.distanceTo(ctx.player.pos) < 20) ctx.addShake(0.4);
          this.setState('exhausted');
        }
        return;
      }
      case 'exhausted':
        if (this.stateTime >= EXHAUSTED_TIME) this.setState('chase');
        return;
      case 'windup':
        if (this.quickSwing && this.stateTime >= this.stats.windup * 0.5) {
          this.quickSwing = false;
          this.struck = false;
          this.setState('strike');
          return;
        }
        break;
    }

    // Wounded past a threshold: roar, shockwave, more dead, and faster from here on.
    if ((this.state === 'chase' || this.state === 'recover') && this.thresholds.length > 0 && this.healthFraction <= this.thresholds[0]) {
      this.thresholds.shift();
      this.stage++;
      this.stats.windup = STATS.windup * (1 - this.stage * 0.15);
      this.stats.speed = STATS.speed * (1 + this.stage * 0.12);
      this.roared = false;
      sfx.roar();
      this.setState('roar');
      return;
    }

    if (this.state === 'chase' && t) {
      this.combo = 0;
      if (this.comboRest > 0) {
        // Circle at sword's length between combos: the opening.
        this.comboRest -= dt;
        const nx = dx / dist;
        const nz = dz / dist;
        const radial = (dist - 3.6) * 1.5;
        this.desired.set(-nz * this.circleDir * 2 + nx * radial, 0, nx * this.circleDir * 2 + nz * radial);
        this.faceYaw = toTarget;
        return;
      }
      if (this.summonCd <= 0) {
        this.summonCd = 18 - this.stage * 4;
        ctx.summonMinions(this, 2 + this.stage);
        sfx.groan(1);
      }
      if (this.levitateCd <= 0) {
        this.levitateCd = 20 - this.stage * 4;
        sfx.cackle(1);
        this.setState('ascend');
        return;
      }
      if (dist > 9 && this.chargeCd <= 0) {
        this.chargeCd = 9 - this.stage * 2;
        this.startLunge('charge', dx, dz, dist);
        return;
      }
      if (dist > 3 && dist < 7 && (ctx.players as Target[]).includes(t!) && this.biteCd <= 0) {
        this.biteCd = 12 - this.stage * 2;
        this.startLunge('bite', dx, dz, dist);
        return;
      }
      if (dist > 6 && this.spellCd <= 0) {
        this.spellCd = 4 - this.stage;
        this.setState('cast');
        return;
      }
    }
    super.think(dt, ctx, dx, dz, dist);
  }

  private spellOrigin() {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    return new THREE.Vector3(this.pos.x + fx * 0.8, this.pos.y + this.airY + 1.5 * this.stats.scale, this.pos.z + fz * 0.8);
  }

  /** Witch magic: a fan of fire bolts, wider as it weakens, plus a hex orb later on. */
  private castSpells(ctx: GameContext, t: Target) {
    const count = 3 + this.stage * 2;
    for (let i = 0; i < count; i++) {
      const spread = (i - (count - 1) / 2) * 0.2;
      ctx.projectiles.fire('firebolt', this.spellOrigin(), t, 20, spread);
    }
    if (this.stage > 0) ctx.projectiles.fire('hexorb', this.spellOrigin(), t, 14);
    sfx.cast(volumeAt(this.pos.distanceTo(ctx.player.pos)));
  }

  private startLunge(kind: 'charge' | 'bite', dx: number, dz: number, dist: number) {
    this.lungeKind = kind;
    this.lungeDir.set(dx / dist, 0, dz / dist);
    this.chargeHits.clear();
    if (kind === 'bite') sfx.groan(1);
    else sfx.roar();
    this.setState('lunge');
  }

  private thinkLunge(ctx: GameContext, dx: number, dz: number, dist: number) {
    const charge = this.lungeKind === 'charge';
    const windup = charge ? CHARGE_WINDUP : BITE_WINDUP;
    const dash = charge ? CHARGE_DASH : BITE_DASH;
    if (this.stateTime < windup) {
      this.faceYaw = Math.atan2(dx, dz);
      this.turnRate = 8;
      if (this.target) this.lungeDir.set(dx / dist, 0, dz / dist);
      return;
    }
    this.accel = 40;
    this.desired.copy(this.lungeDir).multiplyScalar(charge ? 16 : 13);
    this.faceYaw = Math.atan2(this.lungeDir.x, this.lungeDir.z);
    if (charge) {
      // The general's charge: anyone in the path is cut down.
      for (const h of [...ctx.players, ...ctx.allies]) {
        if (!h.alive || this.chargeHits.has(h)) continue;
        if (Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z) < 1.8 + h.radius) {
          this.chargeHits.add(h);
          h.takeDamage(Math.round(this.stats.damage * 1.25), this.pos, ctx);
        }
      }
    } else {
      // The zombie's bite: seize the hero and feed.
      const caught = ctx.players.find((h) => h.alive && !h.invulnerable && Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z) < 1.7);
      if (caught) {
        this.held = caught;
        caught.startGrab();
        this.grabTick = 0.2;
        this.vel.set(0, 0, 0);
        this.setState('grab');
        return;
      }
    }
    if (this.stateTime >= windup + dash) {
      this.recoverTime = 1.1;
      this.setState('recover');
    }
  }

  private thinkGrab(dt: number, ctx: GameContext) {
    const player = this.held ?? ctx.player;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    player.holdAt(this.pos.x + fx * 1.4, this.pos.z + fz * 1.4);
    this.grabTick -= dt;
    if (this.grabTick <= 0 && player.alive) {
      this.grabTick = GRAB_TICK;
      player.takeDamage(GRAB_DAMAGE, this.pos, ctx, true);
      this.hp = Math.min(this.maxHp, this.hp + GRAB_DAMAGE * 3);
      ctx.particles.burst(new THREE.Vector3(player.pos.x, player.pos.y + 1.3, player.pos.z), 0x8a0f0f, 6, 2);
    }
    if (this.stateTime >= GRAB_TIME || !player.alive) {
      player.release(new THREE.Vector3(fx, 0, fz));
      ctx.addShake(0.3);
      this.recoverTime = 0.9;
      this.setState('recover');
    }
  }

  protected pose(h: Humanoid, step: number) {
    const sword = h.sword!;
    h.torso.rotation.x = 0.05;
    h.armL.rotation.set(-step * 0.6, 0, 0.12);
    h.armR.rotation.set(-0.9, 0.35, 0);
    sword.rotation.set(-0.3, 0.5, 0); // greatsword held across the body
    if (this.regenerating) {
      this.glow = 0.15 + 0.1 * Math.sin(this.stateTime * 6);
      this.glowColor = ZOMBIE_GLOW;
    }

    switch (this.state) {
      case 'windup': {
        const total = this.quickSwing ? this.stats.windup * 0.5 : this.stats.windup;
        const k = easeOutCubic(Math.min(this.stateTime / total, 1));
        h.armR.rotation.set(lerp(-0.9, -2.5, k), lerp(0.35, -1.1, k), 0);
        h.armL.rotation.set(lerp(0, -1.8, k), lerp(0, -0.6, k), 0); // two-handed
        sword.rotation.set(lerp(-0.3, Math.PI / 2, k), 0, 0);
        h.torso.rotation.y = -0.4 * k;
        this.glow = 0.3 * k;
        this.glowColor = HUMAN_GLOW;
        break;
      }
      case 'strike': {
        const k = easeOutCubic(Math.min(this.stateTime / 0.14, 1));
        h.armR.rotation.set(lerp(-2.5, -1.2, k), lerp(-1.1, 1.1, k), 0);
        h.armL.rotation.set(lerp(-1.8, -1.2, k), lerp(-0.6, 0.8, k), 0);
        sword.rotation.set(Math.PI / 2, 0, 0);
        h.torso.rotation.y = lerp(-0.4, 0.4, k);
        break;
      }
      case 'recover': {
        const k = Math.min(this.stateTime / this.recoverTime, 1);
        h.armR.rotation.set(lerp(-1.2, -0.9, k), lerp(1.1, 0.35, k), 0);
        sword.rotation.set(lerp(Math.PI / 2, -0.3, k), lerp(0, 0.5, k), 0);
        break;
      }
      case 'roar':
        h.torso.rotation.x = -0.35;
        h.head.rotation.x = -0.6;
        h.armL.rotation.set(-0.4, 0, 1.3);
        h.armR.rotation.set(-0.4, 0, -1.3);
        break;
      case 'cast': {
        const k = easeOutCubic(Math.min(this.stateTime / CAST_TIME, 1));
        h.armL.rotation.set(lerp(0, -2.5, k), lerp(0, 0.4, k), 0); // the witch's hand
        h.torso.rotation.y = 0.25 * k;
        this.glow = 0.35 * k;
        this.glowColor = WITCH_GLOW;
        break;
      }
      case 'lunge': {
        const charge = this.lungeKind === 'charge';
        const windup = charge ? CHARGE_WINDUP : BITE_WINDUP;
        const k = Math.min(this.stateTime / windup, 1);
        if (charge) {
          // Greatsword raised high, then thrust forward.
          const dashing = this.stateTime >= windup;
          h.armR.rotation.set(dashing ? -1.5 : lerp(-0.9, -2.9, k), 0, 0);
          h.armL.rotation.set(dashing ? -1.5 : lerp(0, -2.7, k), 0, 0);
          sword.rotation.set(dashing ? Math.PI / 2 : lerp(-0.3, 1.2, k), 0, 0);
          h.torso.rotation.x = dashing ? 0.4 : -0.2 * k;
          this.glow = dashing ? 0.3 : 0.45 * k;
          this.glowColor = HUMAN_GLOW;
        } else {
          const crouch = this.stateTime < windup;
          h.hips.position.y = crouch ? lerp(0.95, 0.72, k) : 0.85;
          h.torso.rotation.x = crouch ? lerp(0.05, 0.6, k) : 0.5;
          h.armL.rotation.set(crouch ? 0.5 : -1.6, 0, 0.3);
          h.legL.rotation.x = -0.6;
          h.legR.rotation.x = 0.4;
          this.glow = crouch ? 0.5 * k : 0.3;
          this.glowColor = BITE_GLOW;
        }
        break;
      }
      case 'grab':
        h.torso.rotation.x = 0.4;
        h.head.rotation.x = 0.5;
        h.armL.rotation.set(-1.5, -0.3, 0);
        this.glow = 0.3 + 0.15 * Math.sin(this.stateTime * 12);
        this.glowColor = BITE_GLOW;
        break;
      case 'ascend':
      case 'hover':
      case 'descend':
        h.legL.rotation.x = 0.15;
        h.legR.rotation.x = -0.1;
        h.torso.rotation.x = -0.1;
        h.armL.rotation.set(-0.4, 0, 1.1 + Math.sin(this.stateTime * 3) * 0.1);
        h.armR.rotation.set(-0.4, 0, -1.1);
        sword.rotation.set(1.2, 0, 0); // blade hanging point-down
        this.glow = 0.2;
        this.glowColor = WITCH_GLOW;
        break;
      case 'exhausted':
        h.hips.position.y = 0.55;
        h.legL.rotation.x = -1.5;
        h.legR.rotation.x = 0.3;
        h.torso.rotation.x = 0.55;
        h.head.rotation.x = 0.4;
        h.armR.rotation.set(-0.3, 0, -0.2);
        sword.rotation.set(1.6, 0, 0); // leaning on the sword
        break;
      case 'stagger':
        h.torso.rotation.x = -0.3;
        h.armL.rotation.set(-0.5, 0, 0.6);
        h.armR.rotation.set(-0.5, 0, -0.6);
        break;
    }
  }
}
