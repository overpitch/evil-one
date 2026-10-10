import * as THREE from 'three';
import type { Humanoid, HumanoidLook } from './character';

export type Top = 'shirt' | 'longShirt' | 'chainmail';
export type Legs = 'pants' | 'shorts' | 'fishnets';

/** What the hero wears, picked on the outfit screen. */
export interface Outfit {
  top: Top;
  legs: Legs;
  /** Shirt color (chainmail is always steel). */
  shirt: number;
  /** Pants or shorts color. */
  pants: number;
}

export const TOPS: [Top, string][] = [
  ['shirt', 'Shirt'],
  ['longShirt', 'Long shirt'],
  ['chainmail', 'Chainmail'],
];

export const LEGS: [Legs, string][] = [
  ['pants', 'Pants'],
  ['shorts', 'Shorts'],
  ['fishnets', 'Shorts + pink fishnets'],
];

export const COLORS: [number, string][] = [
  [0xa3262a, 'Red'],
  [0x2a4fa3, 'Blue'],
  [0x2f7a3a, 'Green'],
  [0x6a2a8a, 'Purple'],
  [0xd9b24a, 'Gold'],
  [0xd0702a, 'Orange'],
  [0xe86aa8, 'Pink'],
  [0xe8e4da, 'White'],
  [0x3a3f4a, 'Gray'],
  [0x1e1e22, 'Black'],
];

export const DEFAULT_OUTFIT: Outfit = { top: 'shirt', legs: 'pants', shirt: 0xa3262a, pants: 0x3a3f4a };

/** Reads an outfit from a save, falling back to the default for anything missing. */
export function loadOutfit(raw: Partial<Outfit> | undefined): Outfit {
  const o = { ...DEFAULT_OUTFIT };
  if (!raw) return o;
  if (TOPS.some(([t]) => t === raw.top)) o.top = raw.top!;
  if (LEGS.some(([l]) => l === raw.legs)) o.legs = raw.legs!;
  if (typeof raw.shirt === 'number') o.shirt = raw.shirt;
  if (typeof raw.pants === 'number') o.pants = raw.pants;
  return o;
}

const CHAINMAIL = 0x8a929c;

/** The base look: shirt and pants colors (chainmail tints the shirt steel). */
export function outfitLook(base: HumanoidLook, o: Outfit): HumanoidLook {
  return { ...base, shirt: o.top === 'chainmail' ? CHAINMAIL : o.shirt, pants: o.pants };
}

const fishnetTextures = new Map<string, THREE.Texture>();
let chainTexture: THREE.Texture | null = null;

/** A net (pink, or black for Player 2) over skin. */
function fishnet(skin: number, net: string) {
  const key = `${skin}-${net}`;
  const cached = fishnetTextures.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = `#${skin.toString(16).padStart(6, '0')}`;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = net;
  g.lineWidth = 3;
  for (let i = -64; i <= 64; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 64, 64);
    g.moveTo(i + 64, 0);
    g.lineTo(i, 64);
    g.stroke();
  }
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  fishnetTextures.set(key, texture);
  return texture;
}

/** Rows of little steel rings. */
function chainmail() {
  if (chainTexture) return chainTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8a929c';
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = '#5a6068';
  g.lineWidth = 1.5;
  for (let y = 0; y < 32; y += 8) {
    for (let x = (y / 8) % 2 ? 4 : 0; x < 36; x += 8) {
      g.beginPath();
      g.arc(x, y + 4, 3, 0, Math.PI * 2);
      g.stroke();
    }
  }
  chainTexture = new THREE.CanvasTexture(c);
  chainTexture.wrapS = chainTexture.wrapT = THREE.RepeatWrapping;
  chainTexture.repeat.set(2, 2);
  chainTexture.colorSpace = THREE.SRGBColorSpace;
  return chainTexture;
}

/**
 * Adds the outfit's extra pieces to a freshly built hero: bare (or
 * fishnet) shins for shorts, a long shirt's tails, chainmail rings.
 */
export function dressHero(h: Humanoid, o: Outfit, skin: number, blackNets = false) {
  const add = (parent: THREE.Object3D, w: number, ht: number, d: number, m: THREE.MeshLambertMaterial, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, ht, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    h.materials.push(m);
  };
  if (o.legs !== 'pants') {
    // Shorts end above the knee: bare shins below (or pink fishnet stockings).
    const shin =
      o.legs === 'fishnets'
        ? new THREE.MeshLambertMaterial({ map: fishnet(skin, blackNets ? '#141414' : '#ff4fa8'), flatShading: true })
        : new THREE.MeshLambertMaterial({ color: skin, flatShading: true });
    for (const leg of [h.legL, h.legR]) add(leg, 0.205, 0.42, 0.225, shin, 0, -0.55, 0);
  }
  if (o.top === 'longShirt') {
    // The shirt's tails hang down over the hips.
    add(h.hips, 0.54, 0.34, 0.34, new THREE.MeshLambertMaterial({ color: o.shirt, flatShading: true }), 0, -0.08, 0);
  }
  if (o.top === 'chainmail') {
    const rings = new THREE.MeshLambertMaterial({ map: chainmail(), flatShading: true });
    add(h.torso, 0.58, 0.64, 0.34, rings, 0, 0.32, 0);
    add(h.hips, 0.54, 0.26, 0.34, rings, 0, -0.04, 0);
    for (const arm of [h.armL, h.armR]) add(arm, 0.19, 0.5, 0.21, rings, 0, -0.24, 0);
  }
}
