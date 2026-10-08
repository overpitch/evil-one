import * as THREE from 'three';

export type FloaterKind = 'damage' | 'heavy' | 'xp';

interface Floater {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  age: number;
  life: number;
  active: boolean;
}

const LIFE: Record<FloaterKind, number> = { damage: 0.8, heavy: 1, xp: 1.4 };
const POOL_SIZE = 40;

/** Damage numbers and "+XP" text that rise from a point in the world and fade. */
export class Floaters {
  private readonly pool: Floater[] = [];
  private next = 0;
  private readonly projected = new THREE.Vector3();

  constructor(container: HTMLElement) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'floater';
      el.style.display = 'none';
      container.appendChild(el);
      this.pool.push({ el, pos: new THREE.Vector3(), age: 0, life: 1, active: false });
    }
  }

  spawn(at: THREE.Vector3, text: string, kind: FloaterKind) {
    const f = this.pool[this.next];
    this.next = (this.next + 1) % POOL_SIZE;
    f.pos.copy(at);
    // Spread numbers out a little so rapid hits don't stack on top of each other.
    f.pos.x += (Math.random() - 0.5) * 0.5;
    f.pos.z += (Math.random() - 0.5) * 0.5;
    f.age = 0;
    f.life = LIFE[kind];
    f.active = true;
    f.el.textContent = text;
    f.el.className = `floater ${kind}`;
  }

  update(dt: number, camera: THREE.Camera) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const f of this.pool) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.active = false;
        f.el.style.display = 'none';
        continue;
      }
      const t = f.age / f.life;
      const p = this.projected.copy(f.pos);
      p.y += t * 0.9;
      p.project(camera);
      if (p.z > 1) {
        f.el.style.display = 'none';
        continue;
      }
      f.el.style.display = '';
      const pop = t < 0.15 ? 0.6 + (t / 0.15) * 0.6 : 1.2 - Math.min(t, 0.5) * 0.4;
      f.el.style.transform = `translate(${(p.x * 0.5 + 0.5) * w}px, ${(-p.y * 0.5 + 0.5) * h}px) translate(-50%, -50%) scale(${pop})`;
      f.el.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
    }
  }

  clear() {
    for (const f of this.pool) {
      f.active = false;
      f.el.style.display = 'none';
    }
  }
}
