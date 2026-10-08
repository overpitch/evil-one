export const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Frame-rate independent exponential smoothing factor. */
export const smoothing = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

/** Wraps an angle to the range [-PI, PI). */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Smoothly turns an angle toward a target along the shortest path. */
export const dampAngle = (current: number, target: number, lambda: number, dt: number) =>
  current + wrapAngle(target - current) * smoothing(lambda, dt);

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Small deterministic RNG so the world looks the same every time. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
