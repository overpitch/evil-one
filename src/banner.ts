import * as THREE from 'three';
import { heightAt, lambert, type Circle, type Colliders } from './world';
import { easeOutCubic } from './util';

const RAISE_TIME = 1.6;
const SINK_DEPTH = 4.3;

/** A human army banner. Raised banners are checkpoints. */
export class Banner {
  readonly x: number;
  readonly z: number;
  raised = false;

  private readonly group = new THREE.Group();
  private readonly cloth = new THREE.Group();
  private readonly baseY: number;
  private readonly collider: Circle;
  private raiseT = 1;
  private readonly phase = Math.random() * 10;

  constructor(scene: THREE.Scene, colliders: Colliders, x: number, z: number, rotation = -0.6) {
    this.x = x;
    this.z = z;
    const wood = lambert(0x5a3c22);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4, 6).translate(0, 2, 0), wood);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.08), wood);
    bar.position.set(0.6, 3.8, 0);
    const finial = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), lambert(0xd9b24a));
    finial.position.y = 4.1;
    // The cloth hangs from the crossbar and sways in the wind.
    this.cloth.position.set(0.06, 3.78, 0);
    const fabric = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.7, 0.04).translate(0.56, -0.85, 0), lambert(0xa3262a));
    const emblem = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.06), lambert(0xd9b24a));
    emblem.position.set(0.56, -0.75, 0);
    emblem.rotation.z = Math.PI / 4;
    this.cloth.add(fabric, emblem);
    this.group.add(pole, bar, finial, this.cloth);
    this.group.traverse((o) => (o.castShadow = true));

    this.baseY = heightAt(x, z);
    this.group.position.set(x, this.baseY, z);
    this.group.rotation.y = rotation;
    scene.add(this.group);
    this.collider = { x, z, r: 0.25 };
    colliders.circles.push(this.collider);
    this.setRaised(false);
  }

  /** Raises (or hides) the banner, optionally animating it rising out of the ground. */
  setRaised(raised: boolean, animate = false) {
    this.raised = raised;
    this.raiseT = raised && animate ? 0 : 1;
    this.collider.active = raised;
    this.applyPose(0);
  }

  update(dt: number, time: number) {
    if (this.raiseT < 1) this.raiseT = Math.min(1, this.raiseT + dt / RAISE_TIME);
    this.applyPose(time);
  }

  private applyPose(time: number) {
    this.group.visible = this.raised;
    const k = easeOutCubic(this.raiseT);
    this.group.position.y = this.baseY - (1 - k) * SINK_DEPTH;
    this.cloth.rotation.y = Math.sin(time * 1.7 + this.phase) * 0.12;
    this.cloth.rotation.x = Math.sin(time * 2.3 + this.phase) * 0.05;
  }
}
