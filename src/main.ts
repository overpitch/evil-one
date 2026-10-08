import './style.css';
import * as THREE from 'three';
import { Input } from './input';
import { createWorld, respawnPoint } from './world';
import { Player } from './player';
import type { Enemy } from './enemy';
import { Ally, SQUAD_SIZE } from './ally';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { Particles } from './particles';
import { Floaters } from './floaters';
import { Projectiles } from './projectiles';
import { initAudio, sfx } from './audio';
import { Campaign, type Objective } from './campaign';
import { CAMP_BANNER } from './layout';
import { loadSettings, saveSettings, type Settings } from './settings';
import { loadSave, newSave, useTestSaveSlot, writeSave, type SaveData } from './save';
import type { MapData } from './map';
import type { GameContext } from './types';

// ?test skips the menus, uses a separate save slot, and runs without pointer lock (for automated checks).
const testMode = new URLSearchParams(location.search).has('test');
if (testMode) useTestSaveSlot();

/** Zombies farther than this (on either axis) are hidden and not simulated. */
const ACTIVE_RANGE = 80;

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
const projectiles = new Projectiles(scene);
const player = new Player(scene);
const camCtrl = new ThirdPersonCamera(camera);
const input = new Input(renderer.domElement);
const settings = loadSettings();
const hud = new Hud(settings);
const floaters = new Floaters(hud.floaterLayer);

function applySettings(s: Settings) {
  camCtrl.sensitivity = s.sensitivity;
  camCtrl.invertY = s.invertY;
}
applySettings(settings);

const enemies: Enemy[] = [];
const allies = Array.from({ length: SQUAD_SIZE }, (_, i) => new Ally(scene, i));

/** 'menu' covers the title, naming and intro screens; the world idles behind them. */
let phase: 'menu' | 'playing' = 'menu';
let kills = 0;
let hitStopTimer = 0;
let deathShown = false;
let menuOrbit = 0;
let pendingName = '';

const ctx: GameContext = {
  scene,
  colliders: world.colliders,
  player,
  allies,
  enemies,
  particles,
  projectiles,
  peaceful: true,
  arenaLock: null,
  floatText: (at, text, kind) => floaters.spawn(at, text, kind),
  addShake: (amount) => camCtrl.addShake(amount),
  hitStop: (seconds) => {
    hitStopTimer = Math.max(hitStopTimer, seconds);
  },
  onEnemyKilled: (z) => {
    if (z.xpReward === 0) return; // the Witch Queen's mirror images don't count
    kills++;
    floaters.spawn(new THREE.Vector3(z.pos.x, z.pos.y + 2.2, z.pos.z), `+${z.xpReward} XP`, 'xp');
    awardXp(z.xpReward);
  },
  summonMinions: (around, count) => campaign.summonMinions(around, count, ctx),
};

const campaign = new Campaign(scene, world, enemies, {
  announce: (title, detail) => hud.announce(title, detail),
  say: (speaker, line) => hud.say(speaker, line),
  checkpointReached: () => {
    player.hp = player.maxHp;
    player.stamina = player.maxStamina;
    reinforceSquad();
    saveGame();
  },
  awardXp: (amount, at) => {
    floaters.spawn(at, `+${amount} XP`, 'xp');
    awardXp(amount);
  },
  bossStarted: (name) => hud.showBoss(name),
  bossEnded: () => hud.showBoss(null),
  save: () => saveGame(),
});

function awardXp(amount: number) {
  if (player.gainXp(amount) > 0) {
    const at = new THREE.Vector3(player.pos.x, player.pos.y + 1, player.pos.z);
    particles.burst(at, 0xffd36b, 30, 6);
    particles.burst(at, 0xfff2b0, 15, 4);
    camCtrl.addShake(0.2);
    sfx.levelUp();
    hud.showLevelUp(player.level);
  }
}

function saveGame() {
  writeSave({
    version: 1,
    name: player.name,
    level: player.level,
    xp: player.xp,
    kills,
    ...campaign.saveFields(),
    savedAt: Date.now(),
  });
}

/** Fallen soldiers are replaced by fresh ones in formation behind the hero. */
function reinforceSquad(everyone = false) {
  const slot = new THREE.Vector3();
  for (const a of allies) {
    if (everyone || !a.alive) {
      a.slotPosition(ctx, slot);
      a.reinforce(slot.x, slot.z);
    }
  }
}

/** Starts (or restarts after death) play from a save: hero, territory and position. */
function enterWorld(save: SaveData) {
  player.loadHero(save.name, save.level, save.xp);
  kills = save.kills;
  campaign.load(save);
  const spot = respawnPoint(campaign.current.banner);
  player.reset(spot.x, spot.z);
  reinforceSquad(true);
  camCtrl.yaw = 0;
  camCtrl.pitch = 0.12;
  camCtrl.cut();
  floaters.clear();
  projectiles.clear();
  ctx.arenaLock = null;
  hitStopTimer = 0;
  deathShown = false;
  hud.showDeath(false);
  hud.showMap(false);
  hud.showScreen('none');
  phase = 'playing';
  ctx.peaceful = false;
}

const mass = (b: Player | Ally | Enemy) => {
  if (b === player) return 3;
  if ('isBoss' in b) return b.isBoss ? 12 : b.radius > 0.5 ? 2.5 : 1;
  return 1;
};

/** Keeps bodies from overlapping; heavier bodies get pushed less. */
function separateBodies() {
  const bodies: (Player | Ally | Enemy)[] = [player];
  for (const a of allies) if (a.alive) bodies.push(a);
  for (const e of enemies) if (e.alive && !e.flying && e.pos.distanceToSquared(player.pos) < 40 * 40) bodies.push(e);
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
      const ma = mass(a);
      const mb = mass(b);
      const aShare = mb / (ma + mb);
      a.pos.x -= dx * overlap * aShare;
      a.pos.z -= dz * overlap * aShare;
      b.pos.x += dx * overlap * (1 - aShare);
      b.pos.z += dz * overlap * (1 - aShare);
    }
  }
}

function updateEnemies(dt: number) {
  for (const z of enemies) {
    if (z.state === 'dormant') continue;
    const near = Math.abs(z.pos.x - player.pos.x) < ACTIVE_RANGE && Math.abs(z.pos.z - player.pos.z) < ACTIVE_RANGE;
    if (near) z.update(dt, ctx);
    else z.sleep(dt);
  }
}

function mapData(objective: Objective): MapData {
  return {
    player: { x: player.pos.x, z: player.pos.z, yaw: player.yaw },
    heroLevel: player.level,
    allies: allies.filter((a) => a.alive).map((a) => ({ x: a.pos.x, z: a.pos.z })),
    outposts: campaign.outposts.map((o) => ({ x: o.def.x, z: o.def.z, name: o.def.name, captured: o.captured })),
    checkpoints: campaign.checkpoints
      .filter((c) => c.unlocked)
      .map((c) => ({ x: c.banner.x, z: c.banner.z, current: c === campaign.current })),
    liberated: {
      zombie: campaign.isLiberated(campaign.territories[0]),
      witch: campaign.isLiberated(campaign.territories[1]),
      vampire: campaign.isLiberated(campaign.territories[2]),
    },
    objective: objective.at ? { x: objective.at.x, z: objective.at.z } : null,
  };
}

// ---------- Menu flow: title → (name → intro | continue) → play ----------

/** Grabs the pointer. If the browser refuses, the pause screen offers a Resume button. */
function lockPointer() {
  initAudio();
  if (testMode) return;
  (document.activeElement as HTMLElement | null)?.blur();
  input.requestLock();
  setTimeout(() => {
    if (phase === 'playing' && !input.locked && player.alive && !hud.optionsOpen) hud.showPause(true);
  }, 1200);
}

hud.onContinue = () => {
  const save = loadSave();
  if (!save) {
    hud.showTitle(null);
    return;
  }
  enterWorld(save);
  lockPointer();
};
hud.onNewGame = () => {
  initAudio();
  hud.showScreen('name');
};
hud.onNameChosen = (name) => {
  pendingName = name;
  hud.showIntro(name);
};
hud.onBegin = () => {
  const save = newSave(pendingName);
  writeSave(save);
  enterWorld(save);
  lockPointer();
};
hud.onResume = lockPointer;
hud.onRespawn = () => {
  enterWorld(loadSave() ?? newSave(player.name));
  lockPointer();
};
hud.onSettings = (s) => {
  applySettings(s);
  saveSettings(s);
};
input.onLockChange = (locked) => {
  if (!locked) hud.showMap(false);
  if (phase === 'playing' && !hud.optionsOpen) hud.showPause(!locked && player.alive);
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// The world behind the title screen reflects the saved game.
const existingSave = loadSave();
campaign.load(existingSave);
const campSpot = respawnPoint(CAMP_BANNER);
player.reset(campSpot.x, campSpot.z);
reinforceSquad(true);
if (testMode) {
  const save = newSave('Tester');
  writeSave(save);
  enterWorld(save);
} else {
  hud.showTitle(existingSave);
}

// ---------- Main loop ----------

/** Slow orbit around the hero while the menus are up. */
function updateMenuCamera(dt: number) {
  menuOrbit += dt * 0.07;
  const p = player.pos;
  camera.position.set(p.x + Math.sin(menuOrbit) * 8.5, p.y + 2.8, p.z + Math.cos(menuOrbit) * 8.5);
  camera.lookAt(p.x, p.y + 1.4, p.z);
}

/** Advances the game by one frame of `realDt` seconds. */
function tick(realDt: number) {
  if (phase === 'menu') {
    player.idle(realDt);
    for (const a of allies) a.update(realDt, ctx);
    updateMenuCamera(realDt);
  } else {
    if (input.locked || testMode) {
      if (input.wasPressed('KeyM')) hud.showMap(!hud.mapOpen);
      camCtrl.applyInput(input);
      let dt = realDt;
      // Hit-stop: freeze the action for a few frames when a blow lands.
      if (hitStopTimer > 0) {
        hitStopTimer -= realDt;
        dt *= 0.06;
      }
      player.update(dt, ctx, input, camCtrl.yaw);
      for (const a of allies) a.update(dt, ctx);
      updateEnemies(dt);
      separateBodies();
      campaign.update(dt, ctx);
      projectiles.update(dt, ctx);
      particles.update(dt);
      floaters.update(dt, camera);
    }
    camCtrl.update(realDt, player.pos);
    camera.updateMatrixWorld();
    // Soldiers who wander right in front of the lens are hidden so they don't block the view.
    for (const a of allies) {
      if (a.state === 'gone') continue;
      const dx = a.pos.x - camera.position.x;
      const dy = a.pos.y + 1.2 - camera.position.y;
      const dz = a.pos.z - camera.position.z;
      a.h.root.visible = dx * dx + dy * dy + dz * dz > 1.6 * 1.6;
    }

    if (!player.alive && player.stateTime > 1.6 && !deathShown) {
      deathShown = true;
      hud.showMap(false);
      if (document.pointerLockElement) document.exitPointerLock();
      hud.showDeath(true);
    }

    const objective = campaign.objective(player.pos, player.level);
    hud.setObjective(objective.text, objective.at, camera, player.pos);
    const fight = campaign.activeFight;
    if (fight) hud.setBossHealth(fight.leader.healthFraction);
    if (hud.mapOpen) hud.drawMap(mapData(objective));
  }

  world.update(player.pos, realDt, campaign.gloomAt(player.pos));
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
    allies,
    enemies,
    campaign,
    projectiles,
    camCtrl,
    camera,
    renderer,
    input,
    scene,
    hud,
    get phase() {
      return phase;
    },
    step(seconds: number) {
      for (let i = 0; i < Math.round(seconds * 60); i++) tick(1 / 60);
      renderer.render(scene, camera);
    },
  },
});
