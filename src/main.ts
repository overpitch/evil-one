import './style.css';
import * as THREE from 'three';
import { Input } from './input';
import { createWorld, respawnPoint, territoryWeight } from './world';
import { Player } from './player';
import type { Enemy } from './enemy';
import { Ally, SQUAD_SIZE } from './ally';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { Particles } from './particles';
import { Floaters } from './floaters';
import { Projectiles } from './projectiles';
import { initAudio, musicOutput, setVolumes, sfx } from './audio';
import { Music, type Mood, type Theme } from './music';
import { MenuNavigator } from './menuNav';
import { Campaign, type Objective } from './campaign';
import { CAMP_BANNER, TERRITORIES } from './layout';
import { WeaponDrops } from './loot';
import { isWeaponId, STARTING_WEAPON, WEAPONS, weaponOf, type WeaponDef, type WeaponId } from './weapons';
import { DIFFICULTIES, IS_XBOX, loadSettings, saveSettings, type Settings } from './settings';
import { loadSave, newSave, useTestSaveSlot, writeSave, type SaveData } from './save';
import type { MapData } from './map';
import type { GameContext } from './types';

const params = new URLSearchParams(location.search);
// ?test skips the menus, uses a separate save slot, and runs without pointer lock (for automated checks).
const testMode = params.has('test');
if (testMode) useTestSaveSlot();

const settings = loadSettings();
// ?lite forces Low graphics for this visit (for trying it out on a struggling device).
if (params.has('lite')) settings.graphics = 'low';
const startedLow = settings.graphics === 'low';

/** Enemies farther than this (on either axis) are hidden and not simulated. Lower on Low graphics. */
let activeRange = 80;

// Edge smoothing can only be chosen when the renderer is created, so Low turns it off at start-up.
const renderer = new THREE.WebGLRenderer({ antialias: !startedLow, powerPreference: 'high-performance' });
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
const drops = new WeaponDrops(scene);
const player = new Player(scene);
const camCtrl = new ThirdPersonCamera(camera);
const input = new Input(renderer.domElement);
const hud = new Hud(settings);
const floaters = new Floaters(hud.floaterLayer);

const music = new Music();

function applySettings(s: Settings) {
  camCtrl.sensitivity = s.sensitivity;
  camCtrl.invertY = s.invertY;
  setVolumes(s.musicVolume, s.sfxVolume);
  // Low graphics: no real-time shadows, fewer pixels (fewer still on Xbox), fewer distant enemies.
  const low = s.graphics === 'low';
  renderer.setPixelRatio(low ? Math.min(window.devicePixelRatio, 1) * (IS_XBOX ? 0.75 : 1) : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  world.setShadows(!low);
  activeRange = low ? 55 : 80;
}
applySettings(settings);
player.onStep = (volume) => sfx.step(volume);
player.onHurt = () => input.rumble(0.7, 180);
const menuNav = new MenuNavigator();
// Browsers only allow sound after the player interacts; start it on the first key or click.
for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, () => initAudio(), { once: true });

const enemies: Enemy[] = [];
const allies = Array.from({ length: SQUAD_SIZE }, (_, i) => new Ally(scene, i));

/** 'menu' covers the title, naming and intro screens; the world idles behind them. */
let phase: 'menu' | 'playing' = 'menu';
let kills = 0;
let hitStopTimer = 0;
let deathShown = false;
let menuOrbit = 0;
let pendingName = '';
/** Seconds of play (only counts while actually playing). */
let playTime = 0;
let endingShown = false;
/** Weapons the hero has claimed. */
const owned = new Set<WeaponId>([STARTING_WEAPON]);

const ctx: GameContext = {
  scene,
  colliders: world.colliders,
  player,
  allies,
  enemies,
  particles,
  projectiles,
  difficulty: DIFFICULTIES[settings.difficulty],
  peaceful: true,
  arenaLock: null,
  floatText: (at, text, kind) => floaters.spawn(at, text, kind),
  addShake: (amount) => camCtrl.addShake(amount),
  hitStop: (seconds) => {
    input.rumble(seconds > 0.08 ? 0.5 : 0.3, 90);
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
  enteredTerritory: (t) => {
    reinforceSquad();
    for (const a of allies) a.heal();
    const status = campaign.isLiberated(t) ? 'Liberated' : `Recommended level ${t.def.recommendedLevel}`;
    hud.announce(t.def.name, `${status} · Reinforcements have joined you`);
  },
  awardXp: (amount, at) => {
    floaters.spawn(at, `+${amount} XP`, 'xp');
    awardXp(amount);
  },
  bossStarted: (name) => hud.showBoss(name),
  bossEnded: () => hud.showBoss(null),
  leaderDefeated: (id, at) => {
    const w = weaponOf(id);
    if (w && !owned.has(w.id)) drops.place(w.id, at.x, at.z);
  },
  victory: () => {
    saveGame();
    setTimeout(showEnding, 2500);
  },
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
    playTime: Math.round(playTime),
    weapons: [...owned],
    weapon: player.weapon.id,
    ...campaign.saveFields(),
    savedAt: Date.now(),
  });
}

/**
 * Records a weapon change in the save straight away, without saving
 * anything else (XP and kills still only count from the last checkpoint).
 */
function saveWeapons() {
  const save = loadSave();
  if (save) writeSave({ ...save, weapons: [...owned], weapon: player.weapon.id });
}

/** Sets up the hero's weapons from a save, and puts unclaimed leader weapons back in their arenas. */
function loadWeapons(save: SaveData | null) {
  owned.clear();
  owned.add(STARTING_WEAPON);
  const leaders = save?.leaders ?? [];
  // Saves from before weapons existed: every defeated leader's weapon is already yours.
  const claimed = save?.weapons ?? leaders.map((id) => weaponOf(id)?.id);
  for (const id of claimed) if (isWeaponId(id)) owned.add(id);
  player.setWeapon(isWeaponId(save?.weapon) && owned.has(save.weapon) ? save.weapon : STARTING_WEAPON);
  drops.clear();
  for (const id of leaders) {
    const w = weaponOf(id);
    const land = TERRITORIES.find((t) => t.leader.id === id);
    if (w && land && !owned.has(w.id)) drops.place(w.id, land.arena.x, land.arena.z);
  }
}

function equip(w: WeaponDef, announce: boolean) {
  if (!owned.has(w.id) || player.weapon === w) return;
  player.setWeapon(w.id);
  sfx.block(0.5);
  saveWeapons();
  if (announce) hud.announce(w.name, 'Equipped');
  if (hud.inventoryOpen) hud.renderInventory(owned, player.weapon.id, input.mode === 'gamepad');
}

/** Walked into a fallen leader's weapon: it's yours, and in your hand. */
function claimWeapon(w: WeaponDef) {
  owned.add(w.id);
  player.setWeapon(w.id);
  saveWeapons();
  sfx.levelUp();
  camCtrl.addShake(0.2);
  const how = input.mode === 'gamepad' ? 'Press Y' : 'Press I';
  hud.announce(`New weapon: ${w.name}`, `${how} to open your inventory and switch weapons`, true);
}

function openInventory() {
  if (phase !== 'playing' || !player.alive || endingShown) return;
  hud.showMap(false);
  hud.showPause(false);
  hud.renderInventory(owned, player.weapon.id, input.mode === 'gamepad');
  hud.showInventory(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeInventory() {
  hud.showInventory(false);
  lockPointer();
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
  hud.fadeIn();
  player.loadHero(save.name, save.level, save.xp);
  loadWeapons(save);
  hud.showInventory(false);
  kills = save.kills;
  playTime = save.playTime ?? 0;
  endingShown = false;
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
    const near = Math.abs(z.pos.x - player.pos.x) < activeRange && Math.abs(z.pos.z - player.pos.z) < activeRange;
    if (near) z.update(dt, ctx);
    else z.sleep(dt);
  }
}

function mapData(objective: Objective): MapData {
  return {
    player: { x: player.pos.x, z: player.pos.z, yaw: player.yaw },
    heroLevel: player.level,
    allies: allies.filter((a) => a.alive).map((a) => ({ x: a.pos.x, z: a.pos.z })),
    outposts: campaign.territories
      .filter((t) => campaign.isOpen(t))
      .flatMap((t) => t.outposts)
      .map((o) => ({ x: o.def.x, z: o.def.z, name: o.def.name, captured: o.phase === 'captured' })),
    checkpoints: campaign.checkpoints
      .filter((c) => c.unlocked)
      .map((c) => ({ x: c.banner.x, z: c.banner.z, current: c === campaign.current })),
    liberated: Object.fromEntries(campaign.territories.map((t) => [t.def.id, campaign.isLiberated(t)])) as MapData['liberated'],
    open: Object.fromEntries(campaign.territories.map((t) => [t.def.id, campaign.isOpen(t)])) as MapData['open'],
    armyLeadersDefeated: campaign.armyLeadersDefeated,
    objective: objective.at ? { x: objective.at.x, z: objective.at.z } : null,
  };
}

// ---------- Menu flow: title → (name → intro | continue) → play ----------

/** Grabs the pointer. If the browser refuses, the pause screen offers a Resume button. */
function lockPointer() {
  initAudio();
  (document.activeElement as HTMLElement | null)?.blur();
  if (testMode) return;
  // A controller (and any Xbox, where the browser can't capture the mouse) just closes the menu.
  if (input.mode === 'gamepad' || IS_XBOX) {
    hud.showPause(false);
    return;
  }
  input.requestLock();
  setTimeout(() => {
    const usingPad = input.mode === 'gamepad';
    if (phase === 'playing' && !input.locked && !usingPad && player.alive && !hud.optionsOpen && !hud.inventoryOpen) hud.showPause(true);
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
hud.onInventory = openInventory;
hud.onInventoryClose = closeInventory;
hud.onEquip = (id) => equip(WEAPONS.find((w) => w.id === id)!, false);
hud.onRespawn = () => {
  enterWorld(loadSave() ?? newSave(player.name));
  lockPointer();
};
hud.onSettings = (s) => {
  applySettings(s);
  ctx.difficulty = DIFFICULTIES[s.difficulty];
  saveSettings(s);
};
input.onLockChange = (locked) => {
  if (!locked) hud.showMap(false);
  if (phase === 'playing' && !hud.optionsOpen && !hud.inventoryOpen && !endingShown) hud.showPause(!locked && player.alive);
};

/** The war is won: release the mouse and roll the ending. */
function showEnding() {
  endingShown = true;
  hud.showMap(false);
  hud.showPause(false);
  if (document.pointerLockElement) document.exitPointerLock();
  hud.showEnding({
    name: player.name,
    level: player.level,
    kills,
    playSeconds: playTime,
    difficulty: DIFFICULTIES[loadSettings().difficulty].label,
  });
}

hud.onKeepExploring = () => {
  endingShown = false;
  hud.showScreen('none');
  lockPointer();
};
/** Back to the title screen (progress since the last checkpoint is dropped; the save stays). */
function returnToTitle() {
  endingShown = false;
  phase = 'menu';
  ctx.peaceful = true;
  ctx.arenaLock = null;
  projectiles.clear();
  hud.showBoss(null);
  hud.showPause(false);
  hud.showMap(false);
  hud.showDeath(false);
  hud.showInventory(false);
  if (document.pointerLockElement) document.exitPointerLock();
  const save = loadSave();
  campaign.load(save);
  loadWeapons(save);
  const spot = respawnPoint(CAMP_BANNER);
  player.reset(spot.x, spot.z);
  reinforceSquad(true);
  hud.fadeIn();
  hud.showTitle(save);
}
hud.onEndingTitle = returnToTitle;
hud.onQuitToTitle = returnToTitle;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// The world behind the title screen reflects the saved game.
const existingSave = loadSave();
campaign.load(existingSave);
loadWeapons(existingSave);
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
  menuOrbit += dt * 0.05;
  const p = player.pos;
  camera.position.set(p.x + Math.sin(menuOrbit) * 12, p.y + 4.2, p.z + Math.cos(menuOrbit) * 12);
  camera.lookAt(p.x, p.y + 1.6, p.z);
}

let combatHold = 0;
let heartbeatTimer = 0;

/** Picks the soundtrack for the moment, and the heartbeat when badly hurt. */
function updateSound(dt: number) {
  let theme: Theme;
  let mood: Mood = 'camp';
  const land = campaign.territories.find((t) => territoryWeight(t.def, player.pos.x, player.pos.z) > 0.5);
  if (land && !campaign.isLiberated(land)) mood = land.def.id;
  const fight = campaign.activeFight;
  if (endingShown) theme = 'victory';
  else if (phase === 'menu') theme = 'title';
  else if (!player.alive) theme = 'silence';
  else if (fight) {
    theme = 'boss';
    mood = fight.def.id;
  } else {
    const r2 = 28 * 28;
    const engaged = enemies.some((e) => e.alive && e.target !== null && e.fightActive && e.pos.distanceToSquared(player.pos) < r2);
    combatHold = engaged ? 7 : Math.max(0, combatHold - dt);
    theme = combatHold > 0 ? 'battle' : 'explore';
  }
  music.set(theme, mood);

  const low = phase === 'playing' && player.alive && !endingShown && player.hp / player.maxHp < 0.3;
  heartbeatTimer -= dt;
  if (low && heartbeatTimer <= 0 && (input.locked || testMode)) {
    sfx.heartbeat();
    heartbeatTimer = 0.6 + (player.hp / player.maxHp) * 2;
  }
}

/** Advances the game by one frame of `realDt` seconds. */
function tick(realDt: number) {
  input.poll(realDt);
  // Menu button closes the pause menu; the menus themselves are driven by the d-pad, A and B.
  const resumed = input.mode === 'gamepad' && input.pausePressed && hud.pauseOpen;
  if (resumed) hud.showPause(false);
  menuNav.update(input);

  if (phase === 'menu') {
    player.idle(realDt);
    for (const a of allies) a.update(realDt, ctx);
    updateMenuCamera(realDt);
  } else {
    // With a controller there's no mouse capture: play whenever no menu is open.
    const padPlay = (input.mode === 'gamepad' || IS_XBOX) && !menuNav.menuOpen;
    if (padPlay && input.pausePressed && !resumed) hud.showPause(true);
    if (hud.inventoryOpen) {
      // The game waits while the hero picks a weapon.
      if (input.inventoryPressed || input.escapePressed) closeInventory();
    } else if ((input.locked || padPlay || testMode) && !endingShown) {
      playTime += realDt;
      if (input.mapPressed) hud.showMap(!hud.mapOpen);
      if (input.inventoryPressed && player.alive) openInventory();
      updateWeaponSwap();
      camCtrl.applyInput(input, realDt);
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
      const claimed = drops.update(dt, player.alive ? player.pos : null, particles);
      if (claimed) claimWeapon(claimed);
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

    const objective = weaponObjective() ?? campaign.objective(player.pos, player.level);
    hud.setObjective(objective.text, objective.at, camera, player.pos);
    const fight = campaign.activeFight;
    if (fight) hud.setBossHealth(fight.leader.healthFraction);
    if (hud.mapOpen) hud.drawMap(mapData(objective));
  }

  world.update(player.pos, realDt, campaign.gloomAt(player.pos));
  updateSound(realDt);
  updateXboxTip(realDt);
  // A live controller readout on the pause screen, for tracking down stuck sticks or keys.
  if (hud.pauseOpen) hud.setPadDebug(input.debugText());
  for (const z of enemies) z.updateBar(camera);
  hud.update(player, kills);
  hud.setWeapon(player.weapon);
  input.endFrame();
}

/** Number keys pick a weapon; the d-pad steps through the ones you own. */
function updateWeaponSwap() {
  if (!player.alive) return;
  const slot = input.weaponSlotPressed;
  if (slot !== null && WEAPONS[slot]) {
    if (owned.has(WEAPONS[slot].id)) equip(WEAPONS[slot], true);
    else hud.announce('Not yet yours', `Defeat its owner to claim slot ${slot + 1}`);
  }
  const step = input.weaponCyclePressed;
  if (step !== 0 && owned.size > 1) {
    const mine = WEAPONS.filter((w) => owned.has(w.id));
    const i = mine.indexOf(player.weapon);
    equip(mine[(i + step + mine.length) % mine.length], true);
  }
}

/** A fallen leader's weapon waiting to be picked up comes before everything else. */
function weaponObjective(): Objective | null {
  const near = drops.nearest(player.pos);
  if (!near || campaign.activeFight) return null;
  return { text: `Claim ${near.weapon.name}`, at: near.at };
}

// ---------- Xbox ----------

const XBOX_TIP = 'Hold the ☰ Menu button for a second to switch the controller to game controls';
let xboxTipTimer = 0;

// Console browsers scroll the page with the right stick; there's nothing to scroll, so ignore it.
window.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

if (IS_XBOX) {
  // Edge on Xbox maps the controller's B button to browser Back. Keep an extra
  // history entry on top so Back stays on the game. Browsers ignore entries
  // added without a click or key press, so it's (re)armed on real input.
  let guarded = false;
  const guard = () => {
    if (guarded) return;
    history.pushState({ evilOne: true }, '');
    guarded = true;
  };
  for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, guard);
  window.addEventListener('popstate', () => {
    guarded = false;
    guard();
    hud.announce('Still here!', XBOX_TIP);
  });
  document.getElementById('xbox-tip')!.classList.remove('hidden');
}

/** On Xbox, if the hero isn't getting controller input but the cursor is moving, explain how to switch. */
function updateXboxTip(dt: number) {
  if (!IS_XBOX || phase !== 'playing') return;
  xboxTipTimer -= dt;
  // The cursor is moving but the game hasn't heard from the controller: Edge is still in browser mode.
  const now = performance.now();
  if (xboxTipTimer <= 0 && now - input.lastMouseMove < 1500 && now - input.lastPadInput > 3000) {
    hud.announce('Controller', XBOX_TIP);
    xboxTipTimer = 20;
  }
}

// ---------- Diagnostics ----------

/** ?stats shows frame rate, work per frame, draw calls, memory and running time. */
const statsEl = params.has('stats') ? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'stats' })) : null;
const startedAt = performance.now();
let statFrames = 0;
let statWork = 0;
let statSince = performance.now();

function updateStats(now: number, workMs: number) {
  if (!statsEl) return;
  statFrames++;
  statWork += workMs;
  if (now - statSince < 500) return;
  const fps = (statFrames * 1000) / (now - statSince);
  const up = Math.floor((now - startedAt) / 1000);
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  statsEl.textContent = [
    `${fps.toFixed(0)} fps`,
    `${(statWork / statFrames).toFixed(1)} ms work`,
    `${renderer.info.render.calls} draws`,
    heap ? `${(heap / 1048576).toFixed(0)} MB` : 'memory n/a',
    `${renderer.domElement.width}×${renderer.domElement.height}`,
    `${settings.graphics === 'low' || startedLow ? 'low' : 'high'}`,
    `up ${Math.floor(up / 60)}:${String(up % 60).padStart(2, '0')}`,
    input.debugText(),
  ].join(' · ');
  statFrames = 0;
  statWork = 0;
  statSince = now;
}

// If the browser takes the graphics away (out of GPU memory), say so instead of freezing.
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (document.pointerLockElement) document.exitPointerLock();
  const box = document.body.appendChild(document.createElement('div'));
  box.className = 'overlay';
  box.innerHTML =
    '<div class="panel"><h2>The graphics stopped</h2><p class="tip">The browser ran out of graphics memory. Your game is saved at the last checkpoint. Try Options → Graphics → Low after reloading.</p><button>Reload</button></div>';
  box.querySelector('button')!.addEventListener('click', () => location.reload());
});

let last = performance.now();
function frame(now: number) {
  tick(Math.min((now - last) / 1000, 0.05));
  last = now;
  renderer.render(scene, camera);
  updateStats(now, performance.now() - now);
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
    drops,
    music,
    /** The running audio context (null until the first click). */
    audio: () => musicOutput()?.ac ?? null,
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
