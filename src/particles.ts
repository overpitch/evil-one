import * as THREE from 'three';
import { heightAt } from './world';

const MAX = 400;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

/** Little flying cubes for blood, gore and sparks. One draw call for all of them. */
export class Particles {
  private readonly mesh: THREE.InstancedMesh;
  private readonly items: Particle[] = [];
  private next = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), MAX);
    this.mesh.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.items.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 0 });
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.set(0xffffff));
    }
    scene.add(this.mesh);
  }

  burst(origin: THREE.Vector3, color: number, count: number, speed: number, dir?: THREE.Vector3) {
    this.c.set(color);
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const p = this.items[i];
      p.pos.copy(origin);
      p.vel.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      p.vel.y += 2;
      if (dir) p.vel.addScaledVector(dir, speed * 0.6);
      p.maxLife = p.life = 0.5 + Math.random() * 0.4;
      p.size = 0.06 + Math.random() * 0.07;
      this.mesh.setColorAt(i, this.c);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      const p = this.items[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vel.y -= 16 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const ground = heightAt(p.pos.x, p.pos.z) + p.size / 2;
      if (p.pos.y < ground) {
        p.pos.y = ground;
        p.vel.set(p.vel.x * 0.5, -p.vel.y * 0.25, p.vel.z * 0.5);
      }
      const size = p.life > 0 ? p.size * Math.min(1, (p.life / p.maxLife) * 2) : 0;
      this.m.compose(p.pos, this.q, this.s.setScalar(size));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
