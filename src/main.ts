import './style.css';
import * as THREE from 'three';
import { Input } from './input';
import { createWorld } from './world';
import { Player } from './player';
import { Zombie } from './enemy';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { Particles } from './particles';
import { initAudio } from './audio';
import type { GameContext } from './types';

// ?test runs the game without pointer lock (for automated checks).
const testMode = new URLSearchParams(location.search).has('test');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 400);
const world = createWorld(scene);
const particles = new Particles(scene);
const player = new Player(scene);
const camCtrl = new ThirdPersonCamera(camera);
const input = new Input(renderer.domElement);
const hud = new Hud();
camCtrl.sensitivity = hud.sensitivity;

const PLAYER_SPAWN: [number, number] = [0, -6];
const ZOMBIE_SPAWNS: [number, number][] = [[0, 10], [-7, 13], [7, 14], [-12, 4], [12, 6], [-4, 18], [5, 20]];
const ZOMBIE_COUNT = 3;

const enemies: Zombie[] = [];
for (let i = 0; i < ZOMBIE_COUNT; i++) enemies.push(new Zombie(scene, ...ZOMBIE_SPAWNS[i]));

let kills = 0;
let hitStopTimer = 0;
let deathShown = false;

const ctx: GameContext = {
  scene,
  colliders: world.colliders,
  player,
  enemies,
  particles,
  addShake: (amount) => camCtrl.addShake(amount),
  hitStop: (seconds) => {
    hitStopTimer = Math.max(hitStopTimer, seconds);
  },
  onEnemyKilled: () => {
    kills++;
  },
};

function respawnZombie(z: Zombie) {
  const options = ZOMBIE_SPAWNS.filter(([x, sz]) => Math.hypot(x - player.pos.x, sz - player.pos.z) > 10);
  const [x, sz] = options[Math.floor(Math.random() * options.length)] ?? ZOMBIE_SPAWNS[0];
  z.spawn(x, sz);
}

function resetGame() {
  player.reset(...PLAYER_SPAWN);
  camCtrl.yaw = 0;
  camCtrl.pitch = 0.12;
  camCtrl.cut();
  enemies.forEach((z, i) => z.spawn(...ZOMBIE_SPAWNS[i]));
  deathShown = false;
}

/** Keeps bodies from overlapping; the hero is harder to shove than a zombie. */
function separateBodies() {
  const bodies: (Player | Zombie)[] = [player, ...enemies.filter((e) => e.alive)];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const min = a.radius + b.radius;
      const d = Math.hypot(dx, dz);
      if (d >= min || d < 1e-6) continue;
      const overlap = (min - d) / d;
      const aShare = a === player ? 0.25 : 0.5;
      a.pos.x -= dx * overlap * aShare;
      a.pos.z -= dz * overlap * aShare;
      b.pos.x += dx * overlap * (1 - aShare);
      b.pos.z += dz * overlap * (1 - aShare);
    }
  }
}

// ---------- UI wiring ----------

const startPlaying = () => {
  initAudio();
  input.requestLock();
};
hud.onPlay = startPlaying;
hud.onRespawn = () => {
  resetGame();
  hud.showDeath(false);
  startPlaying();
};
hud.onSensitivity = (v) => (camCtrl.sensitivity = v);
input.onLockChange = (locked) => hud.showPause(!locked && player.alive);
if (testMode) hud.showPause(false);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Main loop ----------

resetGame();

/** Advances the game by one frame of `realDt` seconds. */
function tick(realDt: number) {
  if (input.locked || testMode) {
    camCtrl.applyInput(input);
    let dt = realDt;
    // Hit-stop: freeze the action for a few frames when a blow lands.
    if (hitStopTimer > 0) {
      hitStopTimer -= realDt;
      dt *= 0.06;
    }
    player.update(dt, ctx, input, camCtrl.yaw);
    for (const z of enemies) {
      z.update(dt, ctx);
      if (z.readyToRespawn) respawnZombie(z);
    }
    separateBodies();
    particles.update(dt);
  }

  world.update(player.pos);
  camCtrl.update(realDt, player.pos);
  for (const z of enemies) z.updateBar(camera);

  if (!player.alive && player.stateTime > 1.6 && !deathShown) {
    deathShown = true;
    if (document.pointerLockElement) document.exitPointerLock();
    hud.showDeath(true);
  }

  hud.update(player, kills);
  input.endFrame();
}

let last = performance.now();
function frame(now: number) {
  tick(Math.min((now - last) / 1000, 0.05));
  last = now;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for debugging from the browser console. step() runs the game at a
// fixed 60 fps, even in a background tab where animation frames are paused.
Object.assign(window, {
  __game: {
    player,
    enemies,
    camCtrl,
    camera,
    renderer,
    input,
    scene,
    step(seconds: number) {
      for (let i = 0; i < Math.round(seconds * 60); i++) tick(1 / 60);
      renderer.render(scene, camera);
    },
  },
});
