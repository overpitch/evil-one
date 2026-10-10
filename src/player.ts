import * as THREE from 'three';
import { createHumanoid, HIPS_HEIGHT, resetPose, setFlash, type Humanoid } from './character';
import type { Input } from './input';
import type { GameContext, HitResult, Target } from './types';
import { heightAt, resolveColliders } from './world';
import { dampAngle, easeInOutQuad, easeOutCubic, lerp, smoothing, wrapAngle } from './util';
import { sfx } from './audio';
import { MAX_LEVEL, statsForLevel, xpToNext } from './progression';
import { STARTING_WEAPON, WEAPON_BY_ID, WEAPONS, type WeaponDef, type WeaponId } from './weapons';

type State = 'move' | 'attack' | 'roll' | 'stagger' | 'grabbed' | 'dead';

/** One swing of the 3-hit combo. Times are fractions of `dur`. */
interface Swing {
  dur: number;
  hitStart: number;
  hitEnd: number;
  damage: number;
  knockback: number;
  /** Half-angle (radians) of the arc in front of the hero that the swing covers. */
  arc: number;
  reach: number;
  lunge: number;
  stamina: number;
  heavy: boolean;
  /** Sword-arm [sweep, lift] at the start and end of the strike. */
  from: [number, number];
  to: [number, number];
}

const SWINGS: Swing[] = [
  // Slash right → left
  { dur: 0.42, hitStart: 0.3, hitEnd: 0.55, damage: 22, knockback: 4, arc: 1.25, reach: 2.4, lunge: 2.5, stamina: 8, heavy: false, from: [-1.6, -1.45], to: [1.4, -1.55] },
  // Backhand left → right
  { dur: 0.42, hitStart: 0.3, hitEnd: 0.55, damage: 22, knockback: 4, arc: 1.25, reach: 2.4, lunge: 2.5, stamina: 8, heavy: false, from: [1.5, -1.25], to: [-1.5, -1.75] },
  // Overhead chop
  { dur: 0.65, hitStart: 0.42, hitEnd: 0.62, damage: 40, knockback: 9, arc: 0.85, reach: 2.7, lunge: 4.5, stamina: 14, heavy: true, from: [-0.15, -2.9], to: [-0.1, -0.55] },
];

/** The combo as swung with a particular weapon. */
function swingsFor(w: WeaponDef): Swing[] {
  const m = w.swing;
  return SWINGS.map((s) => ({
    ...s,
    dur: s.dur * m.dur,
    damage: s.damage * m.damage,
    knockback: s.knockback * m.knockback,
    reach: s.reach + m.reach,
    arc: s.arc + m.arc,
    stamina: s.stamina * m.stamina,
  }));
}

const BOLT_DAMAGE = 14;
const SLAM_TIME = 0.35;

const ROLL_DURATION = 0.55;
/** Longest any grab can hold the hero (the grabbers let go well before this). */
const MAX_GRAB = 2.5;
const ROLL_STAMINA = 22;
const ARM_REST: [number, number] = [0, -0.35];

const PLAYER_LOOK = {
  skin: 0xe0b48a,
  shirt: 0xa3262a,
  pants: 0x3a3f4a,
  boots: 0x3b2a1e,
  eyes: 0x222222,
  belt: 0x5a3c22,
  armor: 0xb8c0c8,
  plume: 0xd23a2a,
};

const HURT_COLOR = new THREE.Color(0xff2020);
const SLOW_COLOR = new THREE.Color(0x9a4aff);
const SLOW_FACTOR = 0.55;

export class Player implements Target {
  readonly h: Humanoid;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 0.4;
  yaw = 0;

  name = 'Soldier';
  level = 1;
  /** XP earned toward the next level. */
  xp = 0;
  damageMultiplier = 1;
  maxHp = 100;
  hp = 100;
  /** Seconds since the hero last took damage. */
  sinceHurt = 99;
  maxStamina = 100;
  stamina = 100;
  blocking = false;
  /** 1 right after taking damage, fades to 0 (drives the red screen vignette). */
  hurtFlash = 0;
  /** Seconds left of a witch's slowing hex. */
  slowTimer = 0;

  weapon: WeaponDef = WEAPON_BY_ID[STARTING_WEAPON];
  private swings = swingsFor(this.weapon);
  /** One model per weapon, all held in the sword hand; only the equipped one shows. */
  private readonly weaponModels = new Map<WeaponId, THREE.Group>();
  /** The ground-slam ring (Gravebreaker, Doomblade). */
  private readonly slamRing: THREE.Mesh;
  private slamTime = -1;
  private slamRadius = 1;
  private specialDone = false;

  state: State = 'move';
  stateTime = 0;

  private staminaDelay = 0;
  private combo = 0;
  private comboQueued = false;
  private readonly swingHits = new Set<object>();
  private swingSounded = false;
  private readonly rollDir = new THREE.Vector3();
  private staggerDuration = 0;
  private sprinting = false;
  private walkPhase = 0;
  private lastStep = 0;
  /** Called on each footfall with a volume (0..1). */
  onStep?: (volume: number) => void;
  /** Called when the hero is hurt (controller rumble). */
  onHurt?: (amount: number) => void;
  // Presses are remembered briefly so a click during a stagger or swing isn't lost.
  private attackBuffer = 0;
  private rollBuffer = 0;

  private readonly holdPoint = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.h = createHumanoid(PLAYER_LOOK);
    scene.add(this.h.root);
    // Weapons hang from the right fist; the business end points along the hand group's +Z.
    const hand = new THREE.Group();
    hand.position.set(0, -0.64, 0);
    this.h.armR.add(hand);
    this.h.sword = hand;
    for (const w of WEAPONS) {
      const model = w.build();
      model.visible = w === this.weapon;
      hand.add(model);
      this.weaponModels.set(w.id, model);
    }
    this.slamRing = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.slamRing.visible = false;
    scene.add(this.slamRing);
  }

  /** Puts a different weapon in the hero's hand. */
  setWeapon(id: WeaponId) {
    const w = WEAPON_BY_ID[id];
    if (!w || w === this.weapon) return;
    this.weapon = w;
    this.swings = swingsFor(w);
    for (const [wid, model] of this.weaponModels) model.visible = wid === id;
    // A swing in progress finishes as a fresh start with the new weapon.
    if (this.state === 'attack') this.setState('move');
  }

  get alive() {
    return this.state !== 'dead';
  }

  /** Dodge rolls have invincibility frames. */
  get invulnerable() {
    return this.state === 'roll' && this.stateTime > 0.03 && this.stateTime < 0.42;
  }

  get xpToNext() {
    return xpToNext(this.level);
  }

  get atMaxLevel() {
    return this.level >= MAX_LEVEL;
  }

  /** Adds XP and returns how many levels were gained. Leveling up fully heals. */
  gainXp(amount: number): number {
    if (this.atMaxLevel) return 0;
    this.xp += amount;
    let gained = 0;
    while (!this.atMaxLevel && this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      gained++;
    }
    if (this.atMaxLevel) this.xp = 0;
    if (gained > 0) {
      this.applyLevelStats();
      this.hp = this.maxHp;
      this.stamina = this.maxStamina;
    }
    return gained;
  }

  /** Sets up the hero from a save (or a brand-new one at level 1). */
  loadHero(name: string, level = 1, xp = 0) {
    this.name = name;
    this.level = Math.min(Math.max(1, level), MAX_LEVEL);
    this.xp = this.atMaxLevel ? 0 : Math.max(0, xp);
    this.applyLevelStats();
  }

  private applyLevelStats() {
    const stats = statsForLevel(this.level);
    this.maxHp = stats.maxHp;
    this.maxStamina = stats.maxStamina;
    this.damageMultiplier = stats.damageMultiplier;
  }

  /** Full health and stamina, standing at (x, z). */
  reset(x: number, z: number) {
    this.pos.set(x, heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.hurtFlash = 0;
    this.slowTimer = 0;
    this.setState('move');
  }

  update(dt: number, ctx: GameContext, input: Input, camYaw: number) {
    this.stateTime += dt;
    this.sinceHurt += dt;
    this.attackBuffer = input.attackPressed ? 0.25 : Math.max(0, this.attackBuffer - dt);
    this.rollBuffer = input.rollPressed ? 0.2 : Math.max(0, this.rollBuffer - dt);

    // Movement is relative to where the camera looks (FPS-style strafing).
    const fx = Math.sin(camYaw);
    const fz = Math.cos(camYaw);
    // Keys or the left stick; a partly tilted stick walks slower.
    const { x: ix, z: iz } = input.moveVector();
    const wish = this.wish.set(fx * iz - fz * ix, 0, fz * iz + fx * ix);
    const forward = this.tmp.set(fx, 0, fz);

    const target = this.target.set(0, 0, 0);
    let accel = 14;
    this.blocking = false;
    this.sprinting = false;

    switch (this.state) {
      case 'move': {
        this.blocking = input.blockHeld;
        this.sprinting = !this.blocking && iz > 0.3 && this.stamina > 1 && input.sprintHeld;
        if (this.sprinting) {
          this.stamina = Math.max(0, this.stamina - 22 * dt);
          this.staminaDelay = 0.5;
        }
        target.copy(wish).multiplyScalar((this.blocking ? 2.2 : this.sprinting ? 8.2 : 5) * (this.slowTimer > 0 ? SLOW_FACTOR : 1));
        if (this.rollBuffer > 0 && this.stamina >= ROLL_STAMINA) this.startRoll(wish.lengthSq() > 0 ? wish : forward);
        else if (this.attackBuffer > 0 && this.stamina > 0) this.startAttack(0);
        break;
      }
      case 'attack': {
        const sw = this.swings[this.combo];
        const t = this.stateTime / sw.dur;
        if (this.attackBuffer > 0 && this.combo < this.swings.length - 1 && t > 0.15) {
          this.comboQueued = true;
          this.attackBuffer = 0;
        }
        accel = 20;
        if (t > sw.hitStart - 0.1 && t < sw.hitEnd) target.copy(forward).multiplyScalar(sw.lunge);
        else target.copy(wish).multiplyScalar(1.2);
        if (t >= sw.hitStart) {
          if (!this.swingSounded) {
            this.swingSounded = true;
            sfx.swing(sw.heavy);
          }
          if (!this.specialDone) {
            this.specialDone = true;
            this.weaponSpecial(sw, ctx);
          }
          if (t <= sw.hitEnd) this.checkHits(sw, ctx);
        }
        if (t > sw.hitEnd && this.rollBuffer > 0 && this.stamina >= ROLL_STAMINA) {
          this.startRoll(wish.lengthSq() > 0 ? wish : forward);
        } else if (t >= 1) {
          if (this.comboQueued && this.stamina > 0) this.startAttack(this.combo + 1);
          else this.setState('move');
        }
        break;
      }
      case 'roll': {
        const t = this.stateTime / ROLL_DURATION;
        target.copy(this.rollDir).multiplyScalar(lerp(10, 4, t));
        accel = 30;
        if (t >= 1) this.setState('move');
        break;
      }
      case 'stagger':
        accel = 6;
        if (this.stateTime >= this.staggerDuration) this.setState('move');
        break;
      case 'grabbed':
        // Held in a vampire's grip: pulled to the hold point, helpless.
        // Grabs last under 2 s; if the grabber died mid-grab and never let go, break free.
        if (this.stateTime > MAX_GRAB) {
          this.release(forward.clone().negate());
          break;
        }
        this.vel.set(0, 0, 0);
        this.pos.x += (this.holdPoint.x - this.pos.x) * smoothing(15, dt);
        this.pos.z += (this.holdPoint.z - this.pos.z) * smoothing(15, dt);
        accel = 0;
        break;
      case 'dead':
        accel = 5;
        break;
    }

    const k = smoothing(accel, dt);
    this.vel.x += (target.x - this.vel.x) * k;
    this.vel.z += (target.z - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    resolveColliders(this.pos, this.radius, ctx.colliders);
    this.pos.y = heightAt(this.pos.x, this.pos.z);

    // The hero always faces where the camera looks.
    if (this.alive) this.yaw = dampAngle(this.yaw, camYaw, 18, dt);

    if (this.staminaDelay > 0) this.staminaDelay -= dt;
    else this.stamina = Math.min(this.maxStamina, this.stamina + (this.blocking ? 12 : 32) * dt);
    // Slow health regen once out of combat for a while.
    const { regenDelay, regenRate } = ctx.difficulty;
    if (this.alive && this.sinceHurt > regenDelay) this.hp = Math.min(this.maxHp, this.hp + regenRate * dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.slowTimer = Math.max(0, this.slowTimer - dt);
    this.updateSlamRing(dt);

    this.animate(dt);
  }

  /** Returns what happened so attackers can react (a blocked attacker staggers). */
  takeDamage(amount: number, from: THREE.Vector3, ctx: GameContext, unblockable = false): HitResult {
    if (!this.alive || this.invulnerable) return 'ignored';
    amount *= ctx.difficulty.enemyDamage;
    const dx = from.x - this.pos.x;
    const dz = from.z - this.pos.z;
    const away = new THREE.Vector3(-dx, 0, -dz).normalize();
    const attackerInFront = Math.abs(wrapAngle(Math.atan2(dx, dz) - this.yaw)) < 1.4;

    if (this.blocking && attackerInFront && !unblockable) {
      const cost = amount * 1.8;
      const sparkAt = new THREE.Vector3(this.pos.x - away.x * 0.6, this.pos.y + 1.4, this.pos.z - away.z * 0.6);
      ctx.particles.burst(sparkAt, 0xffd36b, 12, 5);
      sfx.block();
      if (this.stamina >= cost) {
        this.spendStamina(cost);
        this.vel.addScaledVector(away, 3);
        ctx.addShake(0.15);
        return 'blocked';
      }
      // Guard broken: not enough stamina to absorb the blow.
      this.stamina = 0;
      this.staminaDelay = 1;
      amount *= 0.5;
    }

    this.hp = Math.max(0, this.hp - amount);
    this.sinceHurt = 0;
    this.hurtFlash = 1;
    this.onHurt?.(amount);
    ctx.addShake(0.45);
    ctx.particles.burst(this.tmp.set(this.pos.x, this.pos.y + 1.2, this.pos.z), 0x8a0f0f, 8, 3);
    sfx.hurt();
    if (this.hp <= 0) {
      this.vel.copy(away).multiplyScalar(5);
      this.setState('dead');
    } else if (this.state !== 'grabbed') {
      this.vel.copy(away).multiplyScalar(5);
      this.staggerDuration = 0.35;
      this.setState('stagger');
    }
    return 'hit';
  }

  /** A hex orb's curse: move at about half speed for a while. */
  applySlow(seconds: number) {
    this.slowTimer = Math.max(this.slowTimer, seconds);
  }

  /** Seized by the Vampire Lord. */
  startGrab() {
    this.holdPoint.copy(this.pos);
    this.setState('grabbed');
  }

  /** Where the grabber is holding the hero this frame. */
  holdAt(x: number, z: number) {
    this.holdPoint.set(x, 0, z);
  }

  /** Thrown free of a grab. */
  release(dir: THREE.Vector3) {
    if (this.state !== 'grabbed') return;
    this.vel.copy(dir).multiplyScalar(7);
    this.staggerDuration = 0.5;
    this.setState('stagger');
  }

  private setState(state: State) {
    this.state = state;
    this.stateTime = 0;
  }

  private spendStamina(amount: number) {
    this.stamina = Math.max(0, this.stamina - amount);
    this.staminaDelay = 0.7;
  }

  private startAttack(index: number) {
    this.attackBuffer = 0;
    this.combo = index;
    this.comboQueued = false;
    this.swingHits.clear();
    this.swingSounded = false;
    this.specialDone = false;
    this.spendStamina(this.swings[index].stamina);
    this.setState('attack');
  }

  private startRoll(dir: THREE.Vector3) {
    this.rollBuffer = 0;
    this.rollDir.copy(dir).normalize();
    this.spendStamina(ROLL_STAMINA);
    this.setState('roll');
    sfx.roll();
  }

  private checkHits(sw: Swing, ctx: GameContext) {
    for (const e of ctx.enemies) {
      if (!e.alive || e.flying || this.swingHits.has(e)) continue;
      const dx = e.pos.x - this.pos.x;
      const dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > sw.reach + e.radius) continue;
      if (dist > 0.6 && Math.abs(wrapAngle(Math.atan2(dx, dz) - this.yaw)) > sw.arc) continue;
      if (this.swingHits.size === 0) {
        ctx.hitStop(sw.heavy ? 0.11 : 0.06);
        ctx.addShake(sw.heavy ? 0.5 : 0.28);
      }
      this.swingHits.add(e);
      const dir = new THREE.Vector3(dx, 0, dz).normalize();
      const damage = Math.round(sw.damage * this.damageMultiplier);
      const outcome = e.takeHit(damage, dir, sw.knockback, sw.heavy, ctx, this);
      if (outcome === 'hit') this.lifesteal(damage, ctx);
      if (outcome === 'parried') {
        // Knocked back by a parry: the swing ends and the hero reels.
        ctx.floatText(new THREE.Vector3(e.pos.x, e.pos.y + 2, e.pos.z), 'Parried!', 'damage');
        ctx.addShake(0.2);
        this.vel.copy(dir).multiplyScalar(-4);
        this.staggerDuration = 0.45;
        this.setState('stagger');
        return;
      }
    }
  }

  // ---------- Weapon powers ----------

  /** Bloodfang and the Doomblade heal the hero for part of the damage each hit deals. */
  private lifesteal(damage: number, ctx: GameContext) {
    const share = this.weapon.special.lifesteal;
    if (!share || this.hp >= this.maxHp) return;
    const heal = Math.max(1, Math.round(damage * share));
    this.hp = Math.min(this.maxHp, this.hp + heal);
    ctx.floatText(new THREE.Vector3(this.pos.x, this.pos.y + 2.1, this.pos.z), `+${heal}`, 'heal');
  }

  /** Fires once per swing, as the blow lands: fire bolts, or the third swing's ground slam. */
  private weaponSpecial(sw: Swing, ctx: GameContext) {
    const special = this.weapon.special;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    if (special.bolts) {
      const from = new THREE.Vector3(this.pos.x + fx * 0.9, this.pos.y + 1.25, this.pos.z + fz * 0.9);
      const damage = Math.round(BOLT_DAMAGE * this.damageMultiplier);
      const spread = sw.heavy ? [-0.22, 0, 0.22] : [0];
      for (const a of spread) {
        const dir = new THREE.Vector3(Math.sin(this.yaw + a), 0, Math.cos(this.yaw + a));
        ctx.projectiles.fireFriendly(from, dir, damage);
      }
      sfx.cast(0.7);
    }
    if (special.slam && sw.heavy) {
      const at = new THREE.Vector3(this.pos.x + fx * 1.4, this.pos.y, this.pos.z + fz * 1.4);
      const { radius, share } = special.slam;
      const damage = Math.round(sw.damage * this.damageMultiplier * share);
      for (const e of ctx.enemies) {
        if (!e.alive || e.flying || this.swingHits.has(e)) continue;
        const dx = e.pos.x - at.x;
        const dz = e.pos.z - at.z;
        const d = Math.hypot(dx, dz);
        if (d > radius + e.radius) continue;
        // The swing itself will hit whatever is right in front; the slam catches the rest.
        const dir = d > 1e-3 ? new THREE.Vector3(dx / d, 0, dz / d) : new THREE.Vector3(fx, 0, fz);
        this.swingHits.add(e);
        if (e.takeHit(damage, dir, 7, true, ctx, this) === 'hit') this.lifesteal(damage, ctx);
      }
      ctx.particles.burst(new THREE.Vector3(at.x, at.y + 0.3, at.z), 0x8a7a5a, 22, 6);
      ctx.particles.burst(new THREE.Vector3(at.x, at.y + 0.3, at.z), this.weapon.color, 14, 5);
      ctx.addShake(0.6);
      ctx.hitStop(0.1);
      sfx.explode(0.8);
      this.slamRadius = radius;
      this.slamTime = 0;
      this.slamRing.position.set(at.x, at.y + 0.15, at.z);
      (this.slamRing.material as THREE.MeshBasicMaterial).color.set(this.weapon.color);
      this.slamRing.visible = true;
    }
  }

  private updateSlamRing(dt: number) {
    if (this.slamTime < 0) return;
    this.slamTime += dt;
    const k = Math.min(this.slamTime / SLAM_TIME, 1);
    this.slamRing.scale.setScalar(0.5 + easeOutCubic(k) * this.slamRadius);
    (this.slamRing.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
    if (k >= 1) {
      this.slamTime = -1;
      this.slamRing.visible = false;
    }
  }

  // ---------- Procedural animation ----------

  /** Just animates in place (used behind the menus). */
  idle(dt: number) {
    this.vel.set(0, 0, 0);
    this.animate(dt);
  }

  private animate(dt: number) {
    const h = this.h;
    h.root.position.copy(this.pos);
    h.root.rotation.y = this.yaw;
    resetPose(h);

    // Walk cycle; runs backwards when backpedaling.
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const forwardSpeed = this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
    this.walkPhase += dt * speed * 2.1 * (forwardSpeed < -0.3 ? -1 : 1);
    const amp = Math.min(speed / 5, 1.3);
    const step = Math.sin(this.walkPhase) * 0.75 * amp;
    const footfall = Math.floor(this.walkPhase / Math.PI);
    if (footfall !== this.lastStep) {
      this.lastStep = footfall;
      if (speed > 1.5 && (this.state === 'move' || this.state === 'attack')) this.onStep?.(Math.min(speed / 7, 1));
    }
    h.hips.position.y = HIPS_HEIGHT + Math.abs(Math.cos(this.walkPhase)) * 0.05 * amp;
    h.legL.rotation.x = step;
    h.legR.rotation.x = -step;
    h.armL.rotation.set(-step * 0.7, 0, 0.08);
    h.armR.rotation.set(ARM_REST[1] + step * 0.3, 0, -0.08);
    h.torso.rotation.x = this.sprinting ? 0.2 : 0.05;
    const sword = h.sword!;
    sword.rotation.set(-0.1, 0, 0);

    switch (this.state) {
      case 'move':
        if (this.blocking) {
          // Sword held diagonally across the body.
          h.armR.rotation.set(-1.25, 0.55, 0);
          h.armL.rotation.set(-1.1, -0.35, 0);
          sword.rotation.set(0, 0.9, 0);
          h.torso.rotation.y = 0.2;
        }
        break;
      case 'attack':
        this.poseSwing(this.swings[this.combo], this.stateTime / this.swings[this.combo].dur);
        break;
      case 'roll': {
        const t = Math.min(this.stateTime / ROLL_DURATION, 1);
        // Tumble around the axis perpendicular to the roll direction (in local space).
        const c = Math.cos(this.yaw);
        const s = Math.sin(this.yaw);
        const lx = this.rollDir.x * c - this.rollDir.z * s;
        const lz = this.rollDir.x * s + this.rollDir.z * c;
        h.hips.quaternion.setFromAxisAngle(this.tmp.set(lz, 0, -lx).normalize(), easeInOutQuad(t) * Math.PI * 2);
        h.hips.position.y = HIPS_HEIGHT - Math.sin(t * Math.PI) * 0.45;
        const tuck = Math.sin(t * Math.PI);
        h.torso.rotation.x = 0.9 * tuck;
        h.legL.rotation.x = h.legR.rotation.x = -1.6 * tuck;
        h.armL.rotation.x = h.armR.rotation.x = -1.5 * tuck;
        break;
      }
      case 'stagger':
        h.torso.rotation.x = -0.3;
        h.head.rotation.x = -0.3;
        h.armL.rotation.set(-0.5, 0, 0.6);
        h.armR.rotation.set(-0.5, 0, -0.6);
        break;
      case 'grabbed': {
        // Lifted off the ground, struggling.
        const kick = Math.sin(this.stateTime * 14);
        h.hips.position.y = HIPS_HEIGHT + 0.25;
        h.torso.rotation.x = -0.25;
        h.head.rotation.x = -0.4;
        h.armL.rotation.set(-1.2 + kick * 0.3, 0, 0.5);
        h.armR.rotation.set(-1.2 - kick * 0.3, 0, -0.5);
        h.legL.rotation.x = kick * 0.5;
        h.legR.rotation.x = -kick * 0.5;
        break;
      }
      case 'dead': {
        const t = easeOutCubic(Math.min(this.stateTime / 0.7, 1));
        h.hips.rotation.x = -1.45 * t;
        h.hips.position.y = lerp(HIPS_HEIGHT, 0.3, t);
        h.armL.rotation.set(-2.6 * t, 0, 0.4);
        h.armR.rotation.set(-2.6 * t, 0, -0.4);
        h.legL.rotation.x = h.legR.rotation.x = 0;
        break;
      }
    }

    if (this.hurtFlash < 0.05 && this.slowTimer > 0) setFlash(h, SLOW_COLOR, 0.2 + 0.1 * Math.sin(this.stateTime * 8));
    else setFlash(h, HURT_COLOR, this.hurtFlash * 0.6);
  }

  /** Windup → strike → recover, sweeping the sword arm from `from` to `to`. */
  private poseSwing(sw: Swing, t: number) {
    const h = this.h;
    let sweep: number;
    let lift: number;
    let extend: number; // 0 = sword resting, 1 = blade extends straight from the arm
    if (t < sw.hitStart) {
      const k = easeOutCubic(t / sw.hitStart);
      sweep = lerp(ARM_REST[0], sw.from[0], k);
      lift = lerp(ARM_REST[1], sw.from[1], k);
      extend = k;
    } else if (t < sw.hitEnd) {
      const k = easeOutCubic((t - sw.hitStart) / (sw.hitEnd - sw.hitStart));
      sweep = lerp(sw.from[0], sw.to[0], k);
      lift = lerp(sw.from[1], sw.to[1], k);
      extend = 1;
      if (sw.heavy) h.torso.rotation.x = 0.05 + k * 0.35;
    } else {
      const k = easeInOutQuad((t - sw.hitEnd) / (1 - sw.hitEnd));
      sweep = lerp(sw.to[0], ARM_REST[0], k);
      lift = lerp(sw.to[1], ARM_REST[1], k);
      extend = 1 - k;
      if (sw.heavy) h.torso.rotation.x = 0.4 - k * 0.35;
    }
    h.armR.rotation.set(lift, sweep * 0.75, 0);
    h.torso.rotation.y = sweep * 0.3;
    h.sword!.rotation.x = lerp(-0.1, Math.PI / 2, extend);
    h.armL.rotation.set(-0.6, 0, 0.35);
    h.legL.rotation.x = -0.35;
    h.legR.rotation.x = 0.3;
  }
}
