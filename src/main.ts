import './style.css';
import * as THREE from 'three';
import { Input } from './input';
import { createWorld } from './world';
import { Player } from './player';
import { Zombie } from './enemy';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { Particles } from './particles';
import { Floaters } from './floaters';
import { initAudio, sfx } from './audio';
import type { GameContext } from './types';

// ?test skips the menus and runs without pointer lock (for automated checks).
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
const floaters = new Floaters(hud.floaterLayer);
camCtrl.sensitivity = hud.sensitivity;

const PLAYER_SPAWN: [number, number] = [0, -6];
const ZOMBIE_SPAWNS: [number, number][] = [[0, 10], [-7, 13], [7, 14], [-12, 4], [12, 6], [-4, 18], [5, 20]];
const ZOMBIE_COUNT = 3;

const enemies: Zombie[] = [];
for (let i = 0; i < ZOMBIE_COUNT; i++) enemies.push(new Zombie(scene, ...ZOMBIE_SPAWNS[i]));

/** 'menu' covers the title, naming and intro screens; the world idles behind them. */
let phase: 'menu' | 'playing' = 'menu';
let kills = 0;
let hitStopTimer = 0;
let deathShown = false;
let menuOrbit = 0;

const ctx: GameContext = {
  scene,
  colliders: world.colliders,
  player,
  enemies,
  particles,
  peaceful: true,
  floatText: (at, text, kind) => floaters.spawn(at, text, kind),
  addShake: (amount) => camCtrl.addShake(amount),
  hitStop: (seconds) => {
    hitStopTimer = Math.max(hitStopTimer, seconds);
  },
  onEnemyKilled: (z) => {
    kills++;
    floaters.spawn(new THREE.Vector3(z.pos.x, z.pos.y + 2.2, z.pos.z), `+${z.xpReward} XP`, 'xp');
    const gained = player.gainXp(z.xpReward);
    if (gained > 0) celebrateLevelUp();
  },
};

function celebrateLevelUp() {
  const at = new THREE.Vector3(player.pos.x, player.pos.y + 1, player.pos.z);
  particles.burst(at, 0xffd36b, 30, 6);
  particles.burst(at, 0xfff2b0, 15, 4);
  camCtrl.addShake(0.2);
  sfx.levelUp();
  hud.showLevelUp(player.level);
}

function respawnZombie(z: Zombie) {
  const options = ZOMBIE_SPAWNS.filter(([x, sz]) => Math.hypot(x - player.pos.x, sz - player.pos.z) > 10);
  const [x, sz] = options[Math.floor(Math.random() * options.length)] ?? ZOMBIE_SPAWNS[0];
  z.spawn(x, sz);
}

/** Puts the hero back at the training ground at full health and resets the zombies. Keeps level and XP. */
function resetArena() {
  player.reset(...PLAYER_SPAWN);
  camCtrl.yaw = 0;
  camCtrl.pitch = 0.12;
  camCtrl.cut();
  enemies.forEach((z, i) => z.spawn(...ZOMBIE_SPAWNS[i]));
  floaters.clear();
  hitStopTimer = 0;
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

// ---------- Menu flow: title → name → intro → play ----------

function startGame(name: string) {
  player.newHero(name);
  kills = 0;
  resetArena();
  phase = 'playing';
  ctx.peaceful = false;
  hud.showScreen('none');
}

/** Grabs the pointer. If the browser refuses, the pause screen offers a Resume button. */
function lockPointer() {
  initAudio();
  if (testMode) return;
  (document.activeElement as HTMLElement | null)?.blur();
  input.requestLock();
  setTimeout(() => {
    if (phase === 'playing' && !input.locked && player.alive) hud.showPause(true);
  }, 1200);
}

hud.onNewGame = () => {
  initAudio();
  hud.showScreen('name');
};
hud.onNameChosen = (name) => {
  player.name = name;
  hud.showIntro(name);
};
hud.onBegin = () => {
  startGame(player.name);
  lockPointer();
};
hud.onResume = lockPointer;
hud.onRespawn = () => {
  resetArena();
  hud.showDeath(false);
  lockPointer();
};
hud.onSensitivity = (v) => (camCtrl.sensitivity = v);
input.onLockChange = (locked) => {
  if (phase === 'playing') hud.showPause(!locked && player.alive);
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (testMode) startGame('Tester');
else hud.showScreen('title');
resetArena();

// ---------- Main loop ----------

/** Slow orbit around the hero while the menus are up. */
function updateMenuCamera(dt: number) {
  menuOrbit += dt * 0.07;
  const p = player.pos;
  camera.position.set(p.x + Math.sin(menuOrbit) * 7.5, p.y + 2.6, p.z + Math.cos(menuOrbit) * 7.5);
  camera.lookAt(p.x, p.y + 1.4, p.z);
}

/** Advances the game by one frame of `realDt` seconds. */
function tick(realDt: number) {
  if (phase === 'menu') {
    player.idle(realDt);
    for (const z of enemies) z.update(realDt, ctx);
    separateBodies();
    updateMenuCamera(realDt);
  } else {
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
      floaters.update(dt, camera);
    }
    camCtrl.update(realDt, player.pos);

    if (!player.alive && player.stateTime > 1.6 && !deathShown) {
      deathShown = true;
      if (document.pointerLockElement) document.exitPointerLock();
      hud.showDeath(true);
    }
  }

  world.update(player.pos);
  for (const z of enemies) z.updateBar(camera);
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
    get phase() {
      return phase;
    },
    step(seconds: number) {
      for (let i = 0; i < Math.round(seconds * 60); i++) tick(1 / 60);
      renderer.render(scene, camera);
    },
  },
});
