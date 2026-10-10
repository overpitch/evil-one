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

  /** The nearest weapon still lying on the ground, for the objective marker. */
  nearest(from: THREE.Vector3): { weapon: WeaponDef; at: THREE.Vector3 } | null {
    let best: Drop | null = null;
    for (const d of this.drops.values()) {
      if (d.active && (!best || d.pos.distanceToSquared(from) < best.pos.distanceToSquared(from))) best = d;
    }
    return best ? { weapon: best.weapon, at: best.pos } : null;
  }

  /** Spins the weapons; returns one the hero just walked into, if any. */
  update(dt: number, hero: THREE.Vector3 | null, particles: Particles): WeaponDef | null {
    this.time += dt;
    let picked: WeaponDef | null = null;
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
      if (hero && !picked && Math.hypot(hero.x - d.pos.x, hero.z - d.pos.z) < PICKUP_RADIUS) {
        d.active = false;
        d.group.visible = false;
        particles.burst(new THREE.Vector3(d.pos.x, d.pos.y + 1.3, d.pos.z), d.weapon.color, 30, 6);
        particles.burst(new THREE.Vector3(d.pos.x, d.pos.y + 1.3, d.pos.z), 0xffd36b, 16, 4);
        picked = d.weapon;
      }
    }
    return picked;
  }
}
