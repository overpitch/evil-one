import * as THREE from 'three';
import type { Foe, GameContext, Target } from './types';
import type { Player } from './player';
import { heightAt } from './world';
import { sfx, volumeAt } from './audio';

export type ProjectileKind = 'firebolt' | 'hexorb' | 'meteor' | 'hexfire';

interface Spec {
  speed: number;
  radius: number;
  life: number;
  color: number;
  core: number;
  /** Homing turn rate (radians per second). */
  homing: number;
}

const SPECS: Record<ProjectileKind, Spec> = {
  firebolt: { speed: 16, radius: 0.45, life: 2.5, color: 0xff7a1a, core: 0xfff0a0, homing: 0 },
  hexorb: { speed: 6.5, radius: 0.55, life: 4.5, color: 0x9a4aff, core: 0xe6ccff, homing: 1.6 },
  meteor: { speed: 18, radius: 0.7, life: 3, color: 0xff5a1a, core: 0xffe08a, homing: 0 },
  // The hero's own bolts, from the Hexfire Staff.
  hexfire: { speed: 24, radius: 0.4, life: 1.3, color: 0xc06aff, core: 0xfff0ff, homing: 0 },
};

const METEOR_BLAST = 2.4;
const SLOW_SECONDS = 2;
const POOL = 48;

interface Projectile {
  kind: ProjectileKind;
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  homingTarget: Target | null;
  /** The hero who threw it (it hurts enemies instead of humans), or null for enemy spells. */
  owner: Player | null;
  /** Meteors fall onto a marked spot. */
  impact: THREE.Vector3;
  mesh: THREE.Group;
  marker: THREE.Mesh;
}

/**
 * Spells in flight. Fire bolts fly straight and can be blocked. Hex orbs
 * home in slowly and slow you down. Meteors fall onto a marked circle and
 * can only be dodged.
 */
export class Projectiles {
  private readonly items: Projectile[] = [];
  private readonly tmp = new THREE.Vector3();
  private trailTimer = 0;

  constructor(scene: THREE.Scene) {
    const markerGeo = new THREE.RingGeometry(0.88, 1, 32).rotateX(-Math.PI / 2);
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Group();
      const outer = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
      const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mesh.add(outer, inner);
      mesh.visible = false;
      scene.add(mesh);
      const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.6, depthWrite: false }));
      marker.visible = false;
      scene.add(marker);
      this.items.push({
        kind: 'firebolt',
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        damage: 0,
        homingTarget: null,
        owner: null,
        impact: new THREE.Vector3(),
        mesh,
        marker,
      });
    }
  }

  private take(kind: ProjectileKind, damage: number): Projectile | null {
    const p = this.items.find((it) => !it.active);
    if (!p) return null;
    const spec = SPECS[kind];
    p.kind = kind;
    p.active = true;
    p.life = spec.life;
    p.damage = damage;
    p.homingTarget = null;
    p.owner = null;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(spec.radius * 0.6);
    const [outer, inner] = p.mesh.children as THREE.Mesh[];
    (outer.material as THREE.MeshBasicMaterial).color.set(spec.color);
    (inner.material as THREE.MeshBasicMaterial).color.set(spec.core);
    return p;
  }

  /** Fires a bolt or orb from `from` toward `target` (aimed at the chest). */
  fire(kind: 'firebolt' | 'hexorb', from: THREE.Vector3, target: Target, damage: number, spread = 0) {
    const p = this.take(kind, damage);
    if (!p) return;
    p.pos.copy(from);
    const aim = this.tmp.set(target.pos.x, target.pos.y + 1.1, target.pos.z).sub(from).normalize();
    if (spread) aim.applyAxisAngle(new THREE.Vector3(0, 1, 0), spread);
    p.vel.copy(aim).multiplyScalar(SPECS[kind].speed);
    if (kind === 'hexorb') p.homingTarget = target;
    p.mesh.position.copy(p.pos);
  }

  /** The hero's fire bolt: flies straight along `dir` and hurts the first enemy it meets. */
  fireFriendly(from: THREE.Vector3, dir: THREE.Vector3, damage: number, owner: Player) {
    const p = this.take('hexfire', damage);
    if (!p) return;
    p.owner = owner;
    p.pos.copy(from);
    p.vel.copy(dir).setY(0).normalize().multiplyScalar(SPECS.hexfire.speed);
    p.mesh.position.copy(p.pos);
  }

  /** Marks a circle on the ground; a meteor lands there after `delay` seconds. */
  meteor(at: THREE.Vector3, damage: number, delay: number) {
    const p = this.take('meteor', damage);
    if (!p) return;
    const spec = SPECS.meteor;
    const fall = spec.speed * delay;
    p.impact.set(at.x, heightAt(at.x, at.z), at.z);
    p.pos.set(at.x + fall * 0.25, p.impact.y + fall, at.z);
    p.vel.set(-0.25, -1, 0).normalize().multiplyScalar(spec.speed * Math.hypot(1, 0.25));
    p.life = delay + 0.5;
    p.mesh.position.copy(p.pos);
    p.marker.visible = true;
    p.marker.position.set(at.x, p.impact.y + 0.1, at.z);
    p.marker.scale.setScalar(METEOR_BLAST);
  }

  update(dt: number, ctx: GameContext) {
    this.trailTimer -= dt;
    const trail = this.trailTimer <= 0;
    if (trail) this.trailTimer = 0.04;
    for (const p of this.items) {
      if (!p.active) continue;
      p.life -= dt;
      const spec = SPECS[p.kind];
      if (p.homingTarget?.alive) {
        // Turn gradually toward the target.
        const want = this.tmp.set(p.homingTarget.pos.x, p.homingTarget.pos.y + 1.1, p.homingTarget.pos.z).sub(p.pos).normalize();
        const cur = p.vel.clone().normalize();
        const angle = cur.angleTo(want);
        const t = angle > 1e-4 ? Math.min(1, (spec.homing * dt) / angle) : 1;
        cur.lerp(want, t).normalize();
        p.vel.copy(cur).multiplyScalar(spec.speed);
      }
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += dt * 9;
      p.mesh.rotation.y += dt * 7;
      if (trail) ctx.particles.burst(p.pos, spec.color, 1, 0.6);

      if (p.kind === 'meteor') {
        (p.marker.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.35 * Math.abs(Math.sin(p.life * 12));
        if (p.pos.y <= p.impact.y + 0.3) this.explodeMeteor(p, ctx);
        else if (p.life <= 0) this.kill(p);
        continue;
      }

      if (p.owner) {
        const enemy = this.enemyAt(p, ctx);
        if (enemy) {
          const dir = this.tmp.copy(p.vel).normalize();
          enemy.takeHit(p.damage, dir, 5, false, ctx, p.owner);
          ctx.particles.burst(p.pos, spec.color, 14, 4);
          this.kill(p);
          continue;
        }
      }
      // Hit a human?
      const hit = p.owner ? null : this.humanAt(p, ctx);
      if (hit) {
        const result = hit.takeDamage(p.damage, p.pos, ctx);
        const hero = ctx.players.find((h) => h === hit);
        if (p.kind === 'hexorb' && result === 'hit' && hero) hero.applySlow(SLOW_SECONDS);
        ctx.particles.burst(p.pos, result === 'blocked' ? 0xffd36b : spec.color, 12, 4);
        this.kill(p);
        continue;
      }
      if (p.life <= 0 || p.pos.y < heightAt(p.pos.x, p.pos.z)) {
        ctx.particles.burst(p.pos, spec.color, 8, 3);
        this.kill(p);
      }
    }
  }

  /** Removes every spell (respawn, fight over). */
  clear() {
    for (const p of this.items) if (p.active) this.kill(p);
  }

  private enemyAt(p: Projectile, ctx: GameContext): Foe | null {
    const r = SPECS[p.kind].radius;
    for (const e of ctx.foesOf(p.owner!.team)) {
      if (!e.alive || e.flying || !e.fightActive) continue;
      const dx = p.pos.x - e.pos.x;
      const dz = p.pos.z - e.pos.z;
      if (Math.abs(dx) > 4 || Math.abs(dz) > 4) continue;
      const tall = 2 * e.h.root.scale.y;
      if (p.pos.y < e.pos.y - 0.3 || p.pos.y > e.pos.y + e.airY + tall) continue;
      if (Math.hypot(dx, dz) < r + e.radius) return e;
    }
    return null;
  }

  private humanAt(p: Projectile, ctx: GameContext): Target | null {
    const r = SPECS[p.kind].radius + 0.4;
    for (const t of [...ctx.players, ...ctx.allies]) {
      if (!t.alive) continue;
      const dy = p.pos.y - (t.pos.y + 1);
      if (Math.abs(dy) > 1.1) continue;
      if (Math.hypot(p.pos.x - t.pos.x, p.pos.z - t.pos.z) < r) return t;
    }
    return null;
  }

  private explodeMeteor(p: Projectile, ctx: GameContext) {
    const at = p.impact;
    ctx.particles.burst(new THREE.Vector3(at.x, at.y + 0.4, at.z), 0xff7a1a, 22, 7);
    ctx.particles.burst(new THREE.Vector3(at.x, at.y + 0.4, at.z), 0x3a2a20, 10, 4);
    const dist = at.distanceTo(ctx.player.pos);
    sfx.explode(volumeAt(dist));
    if (dist < 12) ctx.addShake(0.25);
    for (const t of [...ctx.players, ...ctx.allies]) {
      if (t.alive && Math.hypot(t.pos.x - at.x, t.pos.z - at.z) < METEOR_BLAST) t.takeDamage(p.damage, at, ctx, true);
    }
    this.kill(p);
  }

  private kill(p: Projectile) {
    p.active = false;
    p.mesh.visible = false;
    p.marker.visible = false;
  }
}
