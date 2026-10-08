import * as THREE from 'three';
import type { Input } from './input';
import { heightAt } from './world';
import { clamp, smoothing } from './util';

const BASE_SENSITIVITY = 0.0022; // radians per pixel of mouse/trackpad movement

/**
 * Over-the-shoulder camera: sits a few meters behind the hero, offset over
 * the right shoulder. yaw 0 looks toward +Z; positive pitch looks down.
 */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = 0.12;
  sensitivity = 1;
  distance = 3.6;
  height = 1.7;
  shoulder = 0.85;

  private trauma = 0;
  private time = 0;
  private readonly pivot = new THREE.Vector3();
  private hasPivot = false;
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Screen shake; amounts stack up to a cap and fade out quickly. */
  addShake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  applyInput(input: Input) {
    const s = BASE_SENSITIVITY * this.sensitivity;
    this.yaw -= input.mouseDX * s;
    this.pitch = clamp(this.pitch + input.mouseDY * s, -0.55, 0.9);
  }

  /** Snaps instead of easing on the next update (respawn, teleport). */
  cut() {
    this.hasPivot = false;
  }

  update(dt: number, target: THREE.Vector3) {
    this.time += dt;
    const desired = this.tmp.set(target.x, target.y + this.height, target.z);
    if (this.hasPivot) this.pivot.lerp(desired, smoothing(25, dt));
    else this.pivot.copy(desired);
    this.hasPivot = true;

    const cp = Math.cos(this.pitch);
    this.dir.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    const shoulderPoint = this.tmp.copy(this.pivot).addScaledVector(this.right, this.shoulder);
    const cam = this.camera.position.copy(shoulderPoint).addScaledVector(this.dir, -this.distance);
    cam.y = Math.max(cam.y, heightAt(cam.x, cam.z) + 0.35);

    const shake = this.trauma * this.trauma;
    const t = this.time;
    cam.x += Math.sin(t * 47) * 0.22 * shake;
    cam.y += Math.sin(t * 53 + 1.7) * 0.22 * shake;
    cam.z += Math.sin(t * 59 + 3.1) * 0.22 * shake;

    this.camera.lookAt(shoulderPoint.addScaledVector(this.dir, 20));
    this.camera.rotateZ(Math.sin(t * 37) * 0.04 * shake);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
  }
}
