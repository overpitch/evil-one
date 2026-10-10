import * as THREE from 'three';
import { heightAt } from './world';
import type { Particles } from './particles';
import { WEAPONS, type WeaponDef, type WeaponId } from './weapons';

const PICKUP_RADIUS = 1.9;
const BEAM_HEIGHT = 14;

interface Drop {
  weapon: WeaponDef;
  group: THREE.Group;
  model: THREE.Group;
  active: boolean;
  pos: THREE.Vector3;
  sparkle: number;
}

/**
 * A fallen leader's weapon, spinning above the ground in a beam of light
 * that can be seen from far away. Walk into it to claim it.
 */
export class WeaponDrops {
  private readonly drops = new Map<WeaponId, Drop>();
  private time = 0;

  constructor(scene: THREE.Scene) {
    const beamGeo = new THREE.CylinderGeometry(0.35, 0.6, BEAM_HEIGHT, 10, 1, true).translate(0, BEAM_HEIGHT / 2, 0);
    const glowGeo = new THREE.RingGeometry(0.5, 1.1, 24).rotateX(-Math.PI / 2);
    for (const weapon of WEAPONS) {
      if (!weapon.from) continue;
      const group = new THREE.Group();
      const beam = new THREE.Mesh(
        beamGeo,
        new THREE.MeshBasicMaterial({ color: weapon.color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
      );
      const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: weapon.color, transparent: true, opacity: 0.5, depthWrite: false }));
      glow.position.y = 0.08;
      const model = weapon.build();
      model.scale.setScalar(1.4);
      group.add(beam, glow, model);
      group.visible = false;
      scene.add(group);
      this.drops.set(weapon.id, { weapon, group, model, active: false, pos: new THREE.Vector3(), sparkle: 0 });
    }
  }

  /** Drops a weapon on the ground at (x, z). */
  place(id: WeaponId, x: number, z: number) {
    const d = this.drops.get(id);
    if (!d) return;
    d.active = true;
    d.pos.set(x, heightAt(x, z), z);
    d.group.position.copy(d.pos);
    d.group.visible = true;
  }

  /** Removes every drop (before loading a save). */
  clear() {
    for (const d of this.drops.values()) {
      d.active = false;
      d.group.visible = false;
    }
  }

  /** The nearest weapon still lying on the ground (that `wanted` accepts), for the objective marker. */
  nearest(from: THREE.Vector3, wanted: (w: WeaponDef) => boolean = () => true): { weapon: WeaponDef; at: THREE.Vector3 } | null {
    let best: Drop | null = null;
    for (const d of this.drops.values()) {
      if (d.active && wanted(d.weapon) && (!best || d.pos.distanceToSquared(from) < best.pos.distanceToSquared(from))) best = d;
    }
    return best ? { weapon: best.weapon, at: best.pos } : null;
  }

  /** Takes a weapon off the ground (every hero has one now). */
  remove(id: WeaponId) {
    const d = this.drops.get(id);
    if (!d) return;
    d.active = false;
    d.group.visible = false;
  }

  /** The weapon is lying on the ground somewhere. */
  isOut(id: WeaponId) {
    return this.drops.get(id)?.active ?? false;
  }

  /** Spins the weapons; returns one a hero who still `needs` it just walked into, and who. */
  update<H extends { pos: THREE.Vector3 }>(
    dt: number,
    heroes: H[],
    particles: Particles,
    needs: (hero: H, weapon: WeaponDef) => boolean,
  ): { weapon: WeaponDef; by: H } | null {
    this.time += dt;
    let picked: { weapon: WeaponDef; by: H } | null = null;
    for (const d of this.drops.values()) {
      if (!d.active) continue;
      // Standing on its hilt, blade up, turning slowly.
      d.model.position.y = 0.6 + Math.sin(this.time * 2) * 0.15;
      d.model.rotation.set(-Math.PI / 2, 0, this.time * 1.6);
      d.sparkle -= dt;
      if (d.sparkle <= 0) {
        d.sparkle = 0.25;
        particles.burst(new THREE.Vector3(d.pos.x, d.pos.y + 1.3, d.pos.z), d.weapon.color, 2, 1.5);
      }
      const hero = heroes.find((h) => needs(h, d.weapon) && Math.hypot(h.pos.x - d.pos.x, h.pos.z - d.pos.z) < PICKUP_RADIUS);
      if (hero && !picked) {
        particles.burst(new THREE.Vector3(d.pos.x, d.pos.y + 1.3, d.pos.z), d.weapon.color, 30, 6);
        particles.burst(new THREE.Vector3(d.pos.x, d.pos.y + 1.3, d.pos.z), 0xffd36b, 16, 4);
        picked = { weapon: d.weapon, by: hero };
      }
    }
    return picked;
  }
}

/**
 * A pile of gold coins where a leader fell. Each hero walks into it to
 * scoop up their own share; it stays until every hero playing has.
 */
export class CoinPiles {
  private readonly piles = new Map<string, { group: THREE.Group; pos: THREE.Vector3; active: boolean; sparkle: number }>();
  private time = 0;

  constructor(private readonly scene: THREE.Scene) {}

  private pile(id: string) {
    let p = this.piles.get(id);
    if (p) return p;
    const group = new THREE.Group();
    const gold = new THREE.MeshLambertMaterial({ color: 0xffc23a, emissive: 0x6a4a00, flatShading: true });
    const coin = new THREE.CylinderGeometry(0.22, 0.22, 0.06, 10);
    // A heap in the middle, and coins spilled around it.
    const heap = new THREE.Mesh(new THREE.ConeGeometry(0.75, 0.6, 9), gold);
    heap.position.y = 0.3;
    group.add(heap);
    for (let i = 0; i < 14; i++) {
      const c = new THREE.Mesh(coin, gold);
      const a = (i / 14) * Math.PI * 2 + (i % 3) * 0.4;
      const d = 0.6 + (i % 4) * 0.25;
      c.position.set(Math.sin(a) * d, 0.04 + (i % 2) * 0.05, Math.cos(a) * d);
      c.rotation.set((i % 3) * 0.3, a, (i % 2) * 0.4);
      group.add(c);
    }
    const glow = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 1.6, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    glow.position.y = 0.05;
    group.add(glow);
    group.traverse((o) => (o.castShadow = true));
    group.visible = false;
    this.scene.add(group);
    p = { group, pos: new THREE.Vector3(), active: false, sparkle: 0 };
    this.piles.set(id, p);
    return p;
  }

  /** Drops leader `id`'s coins at (x, z). */
  place(id: string, x: number, z: number) {
    const p = this.pile(id);
    p.pos.set(x, heightAt(x, z), z);
    p.group.position.copy(p.pos);
    p.group.visible = true;
    p.active = true;
  }

  remove(id: string) {
    const p = this.piles.get(id);
    if (!p) return;
    p.active = false;
    p.group.visible = false;
  }

  isOut(id: string) {
    return this.piles.get(id)?.active ?? false;
  }

  /** Leader ids whose coins are on the ground. */
  get out() {
    return [...this.piles.entries()].filter(([, p]) => p.active).map(([id]) => id);
  }

  clear() {
    for (const id of this.piles.keys()) this.remove(id);
  }

  /** The nearest pile (that `wanted` accepts), for the objective marker. */
  nearest(from: THREE.Vector3, wanted: (id: string) => boolean): { id: string; at: THREE.Vector3 } | null {
    let best: { id: string; at: THREE.Vector3 } | null = null;
    for (const [id, p] of this.piles) {
      if (!p.active || !wanted(id)) continue;
      if (!best || p.pos.distanceToSquared(from) < best.at.distanceToSquared(from)) best = { id, at: p.pos };
    }
    return best;
  }

  /** Glints; returns a pile a hero who still `needs` it just walked into, and who. */
  update<H extends { pos: THREE.Vector3 }>(dt: number, heroes: H[], particles: Particles, needs: (hero: H, id: string) => boolean) {
    this.time += dt;
    let picked: { id: string; by: H } | null = null;
    for (const [id, p] of this.piles) {
      if (!p.active) continue;
      p.group.rotation.y = this.time * 0.5;
      p.sparkle -= dt;
      if (p.sparkle <= 0) {
        p.sparkle = 0.2;
        particles.burst(new THREE.Vector3(p.pos.x, p.pos.y + 0.6, p.pos.z), 0xffe08a, 2, 1.8);
      }
      const hero = heroes.find((h) => needs(h, id) && Math.hypot(h.pos.x - p.pos.x, h.pos.z - p.pos.z) < 1.9);
      if (hero && !picked) {
        particles.burst(new THREE.Vector3(p.pos.x, p.pos.y + 0.6, p.pos.z), 0xffd36b, 40, 6);
        picked = { id, by: hero };
      }
    }
    return picked;
  }
}
