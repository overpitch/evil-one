import * as THREE from 'three';

/**
 * Shapes shared by every character and prop that uses the same size (every
 * gremlin's ears, every witch's hat). Making a fresh copy for each one
 * filled the Xbox browser's graphics memory with thousands of tiny buffers.
 * Shared shapes must never be moved or bent afterwards (no translate/rotate).
 */
const cache = new Map<string, THREE.BufferGeometry>();

function shared<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let geo = cache.get(key);
  if (!geo) cache.set(key, (geo = make()));
  return geo as T;
}

export const boxShape = (w: number, h: number, d: number) => shared(`box:${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));

export const coneShape = (r: number, h: number, sides: number) => shared(`cone:${r},${h},${sides}`, () => new THREE.ConeGeometry(r, h, sides));

export const cylinderShape = (top: number, bottom: number, h: number, sides: number) =>
  shared(`cyl:${top},${bottom},${h},${sides}`, () => new THREE.CylinderGeometry(top, bottom, h, sides));

export const icoShape = (r: number) => shared(`ico:${r}`, () => new THREE.IcosahedronGeometry(r, 0));

/** A shared shape that's already moved or bent into place (`key` must name exactly that shape). */
export const customShape = (key: string, make: () => THREE.BufferGeometry) => shared(`custom:${key}`, make);
