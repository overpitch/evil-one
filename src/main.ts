import './style.css';
import * as THREE from 'three';
import { Input, PAD } from './input';
import { createWorld, heightAt, respawnPoint, territoryWeight } from './world';
import { Player } from './player';
import type { Enemy } from './enemy';
import { Ally, ARMY_SIZE, SQUAD_SIZE, SQUAD_SLOTS } from './ally';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { Particles } from './particles';
import { Floaters } from './floaters';
import { Projectiles } from './projectiles';
import { initAudio, musicOutput, setVolumes, sfx } from './audio';
import { Music, type Mood, type Theme } from './music';
import { MenuNavigator } from './menuNav';
import { Campaign, type Objective } from './campaign';
import { CAMP_BANNER, FORT, TERRITORIES, type ShopKind } from './layout';
import { ARMOR, goldFor, loadGoods, MAX_ARMY, MAX_POTIONS, OUTPOST_GOLD, POTION_PRICE, SOLDIER_PRICE, type Goods } from './shop';
import type { ShopEntry } from './hud';
import { DEFAULT_OUTFIT, loadOutfit, type Outfit } from './outfit';
import { WeaponDrops } from './loot';
import { isWeaponId, STARTING_WEAPON, WEAPONS, weaponOf, type WeaponDef, type WeaponId } from './weapons';
import { DIFFICULTIES, IS_XBOX, loadSettings, saveSettings, type Settings } from './settings';
import { loadSave, newSave, useTestSaveSlot, writeSave, type SaveData } from './save';
import { loadHeroes, newHero, saveHero, useTestHeroList, type Player2Hero } from './heroes';
import type { MapData } from './map';
import type { GameContext } from './types';

const params = new URLSearchParams(location.search);
// ?test skips the menus, uses a separate save slot, and runs without pointer lock (for automated checks).
const testMode = params.has('test');
if (testMode) {
  useTestSaveSlot();
  useTestHeroList();
}

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
const camera2 = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 400);
// Each view is rendered separately; the sun's shadows only need drawing once per frame.
renderer.shadowMap.autoUpdate = false;
const world = createWorld(scene);
const particles = new Particles(scene);
const projectiles = new Projectiles(scene);
const drops = new WeaponDrops(scene);
const player = new Player(scene);
/** Player 2's hero, in blue. Only in the world while two people play. */
const player2 = new Player(scene, true);
player2.h.root.visible = false;
const camCtrl = new ThirdPersonCamera(camera);
const camCtrl2 = new ThirdPersonCamera(camera2);
const input = new Input(renderer.domElement);
/** Player 2 plays with a controller only. */
const input2 = new Input(renderer.domElement, false);
/** No buttons pressed: a hero stands still while their inventory is open (two-player). */
const noInput = new Input(renderer.domElement, false);
noInput.padIndex = -1;
const hud = new Hud(settings);
const floaters = new Floaters(hud.views[0].floaterLayer);
const floaters2 = new Floaters(hud.views[1].floaterLayer);
/** Two people are playing, side by side. */
let twoPlayer = false;
/** "Add Player 2" was chosen: the next controller to press A joins. */
let waitingForP2 = false;
/** Seconds a fallen hero waits before coming back beside the other (two-player). */
const REVIVE_TIME = 6;

const music = new Music();

function applySettings(s: Settings) {
  for (const c of [camCtrl, camCtrl2]) {
    c.sensitivity = s.sensitivity;
    c.invertY = s.invertY;
  }
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
player2.onStep = (volume) => sfx.step(volume * 0.7);
player2.onHurt = () => input2.rumble(0.7, 180);
player.onTeleport = () => camCtrl.cut();
player2.onTeleport = () => camCtrl2.cut();
const menuNav = new MenuNavigator();
// Browsers only allow sound after the player interacts; start it on the first key or click.
for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, () => initAudio(), { once: true });

const enemies: Enemy[] = [];
// Player 1's army (red) and Player 2's (blue). One player leads all of the red army;
// with two players, each hero leads an army of three.
const army1 = Array.from({ length: SQUAD_SLOTS }, (_, i) => new Ally(scene, i, 0));
const army2 = Array.from({ length: SQUAD_SLOTS }, (_, i) => new Ally(scene, i, 1));
for (const a of army1) a.hero = player;
for (const a of army2) a.hero = player2;
const allies = [...army1, ...army2];

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
/** Player 2's own weapons (each hero has their own inventory). */
const owned2 = new Set<WeaponId>([STARTING_WEAPON]);
const ownedBy = (h: Player) => (h === player2 ? owned2 : owned);

const ctx: GameContext = {
  scene,
  colliders: world.colliders,
  player,
  players: [player],
  leader: player,
  allies,
  enemies,
  particles,
  projectiles,
  difficulty: DIFFICULTIES[settings.difficulty],
  peaceful: true,
  arenaLock: null,
  floatText: (at, text, kind) => floatText(at, text, kind),
  addShake: (amount) => {
    camCtrl.addShake(amount);
    if (twoPlayer) camCtrl2.addShake(amount);
  },
  hitStop: (seconds) => {
    input.rumble(seconds > 0.08 ? 0.5 : 0.3, 90);
    if (twoPlayer) input2.rumble(seconds > 0.08 ? 0.5 : 0.3, 90);
    hitStopTimer = Math.max(hitStopTimer, seconds);
  },
  onEnemyKilled: (z) => {
    if (z.xpReward === 0) return; // the Witch Queen's mirror images don't count
    kills++;
    const gold = goldFor(z.xpReward, z.isBoss);
    floatText(new THREE.Vector3(z.pos.x, z.pos.y + 2.2, z.pos.z), `+${z.xpReward} XP · +${gold} gold`, 'xp');
    awardGold(gold);
    awardXp(z.xpReward);
  },
  summonMinions: (around, count) => campaign.summonMinions(around, count, ctx),
};

const campaign = new Campaign(scene, world, enemies, {
  announce: (title, detail) => hud.announce(title, detail),
  say: (speaker, line) => hud.say(speaker, line),
  checkpointReached: () => {
    for (const h of ctx.players) {
      if (!h.alive) continue;
      h.hp = h.maxHp;
      h.stamina = h.maxStamina;
    }
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
    floatText(at, `+${amount} XP · +${OUTPOST_GOLD} gold`, 'xp');
    awardGold(OUTPOST_GOLD);
    awardXp(amount);
  },
  bossStarted: (name) => hud.showBoss(name),
  bossEnded: () => hud.showBoss(null),
  leaderDefeated: (id, at) => {
    const w = weaponOf(id);
    if (w && ctx.players.some((h) => !ownedBy(h).has(w.id))) drops.place(w.id, at.x, at.z);
  },
  victory: () => {
    saveGame();
    setTimeout(showEnding, 2500);
  },
  save: () => saveGame(),
});

/** Damage numbers and +XP show in both views. */
function floatText(at: THREE.Vector3, text: string, kind: Parameters<Floaters['spawn']>[2]) {
  floaters.spawn(at, text, kind);
  if (twoPlayer) floaters2.spawn(at, text, kind);
}

/** Every hero playing gets the gold (each has their own). */
function awardGold(amount: number) {
  for (const h of ctx.players) if (!(h === player2 && choosingP2)) h.goods.gold += amount;
}

/** Every kill and capture gives each hero the XP; each levels up on their own. */
function awardXp(amount: number) {
  for (const h of ctx.players) {
    if (h === player2 && choosingP2) continue;
    if (h.gainXp(amount) === 0) continue;
    const at = new THREE.Vector3(h.pos.x, h.pos.y + 1, h.pos.z);
    particles.burst(at, 0xffd36b, 30, 6);
    particles.burst(at, 0xfff2b0, 15, 4);
    if (h.alive) {
      h.hp = h.maxHp;
      h.stamina = h.maxStamina;
    }
    ctx.addShake(0.2);
    sfx.levelUp();
    hud.showLevelUp(h.level, twoPlayer ? h.name : undefined);
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
    goods: player.goods,
    outfit: player.outfit,
    ...campaign.saveFields(),
    savedAt: Date.now(),
  });
  saveP2();
}

/**
 * Records a weapon change in the save straight away, without saving
 * anything else (XP and kills still only count from the last checkpoint).
 */
function saveWeapons() {
  const save = loadSave();
  if (save) writeSave({ ...save, weapons: [...owned], weapon: player.weapon.id, goods: player.goods, outfit: player.outfit });
  saveP2();
}

// ---------- Saved Player 2 heroes ----------

/** The saved hero Player 2 is playing (null while choosing, or one-player). */
let p2Hero: Player2Hero | null = null;
/** Player 2 has joined and is picking who they are. */
let choosingP2 = false;

/** Saves Player 2's hero: level, XP and weapons. */
function saveP2() {
  if (!twoPlayer || !p2Hero) return;
  p2Hero = { ...p2Hero, level: player2.level, xp: player2.xp, weapons: [...owned2], weapon: player2.weapon.id, goods: player2.goods, outfit: player2.outfit };
  saveHero(p2Hero);
}

/** Player 2 becomes a saved hero, with their own level, XP and weapons. */
function becomeHero(hero: Player2Hero) {
  p2Hero = hero;
  choosingP2 = false;
  player2.goods = goodsFrom(hero.goods, hero.weapons);
  player2.setOutfit(loadOutfit(hero.outfit ?? P2_OUTFIT));
  player2.loadHero(hero.name, hero.level, hero.xp);
  owned2.clear();
  owned2.add(STARTING_WEAPON);
  for (const id of hero.weapons) if (isWeaponId(id)) owned2.add(id);
  player2.setWeapon(isWeaponId(hero.weapon) && owned2.has(hero.weapon) ? hero.weapon : STARTING_WEAPON);
  player2.hp = player2.maxHp;
  player2.stamina = player2.maxStamina;
  placeMissingDrops(campaign.leaders);
  hud.showP2Picker(null);
  saveHero(hero);
  sfx.warHorn();
  hud.announce(`${hero.name} joins the fight!`, `Level ${hero.level} · Each hero leads an army of three`);
}

hud.onP2Pick = (id) => {
  const hero = loadHeroes().find((h) => h.id === id);
  if (hero) becomeHero(hero);
};
hud.onP2New = (name) => becomeHero(newHero(name));
hud.onP2Cancel = () => leavePlayer2();

// A Player 2 from before saved heroes existed (weapons kept in the main save) becomes a saved hero.
{
  const old = loadSave() as (SaveData & { player2?: { weapons: string[]; weapon: string } }) | null;
  if (old?.player2 && loadHeroes().length === 0) {
    saveHero({ ...newHero('Player 2'), level: old.level, weapons: old.player2.weapons, weapon: old.player2.weapon });
    delete old.player2;
    writeSave(old);
  }
}

/** This hero hasn't picked up this leader's weapon yet. */
function needsDrop(h: Player, id: WeaponId) {
  return !h.goods.claimed.includes(id) && !ownedBy(h).has(id);
}

/** A hero's goods from a save. Older saves: any leader weapons they have count as picked up. */
function goodsFrom(raw: Partial<Goods> | undefined, weapons: readonly string[]): Goods {
  const goods = loadGoods(raw);
  if (!raw) goods.claimed = weapons.filter((id): id is WeaponId => isWeaponId(id) && WEAPONS.some((w) => w.id === id && w.from !== null));
  return goods;
}

/** Puts each beaten leader's weapon back in its lair until every hero playing has their own. */
function placeMissingDrops(leaders: Iterable<string>) {
  for (const id of leaders) {
    const w = weaponOf(id);
    const land = TERRITORIES.find((t) => t.leader.id === id);
    if (w && land && ctx.players.some((h) => needsDrop(h, w.id)) && !drops.isOut(w.id)) drops.place(w.id, land.arena.x, land.arena.z);
  }
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
  player.goods = goodsFrom(save?.goods, [...owned]);
  player.refreshStats();
  if (save?.outfit || player.outfit !== DEFAULT_OUTFIT) player.setOutfit(loadOutfit(save?.outfit));
  drops.clear();
  placeMissingDrops(leaders);
}

/** Whose weapon the open inventory is choosing. */
let inventoryFor: Player = player;
/** Who opened the pause menu (its Inventory button opens their inventory). */
let pausedBy: Player = player;

const inputOf = (h: Player) => (h === player2 ? input2 : input);

function renderInventory() {
  const chooser = twoPlayer ? inventoryFor.name : undefined;
  hud.renderInventory(ownedBy(inventoryFor), inventoryFor.weapon.id, inputOf(inventoryFor).mode === 'gamepad', chooser);
}

function equip(w: WeaponDef, announce: boolean, hero: Player = player) {
  if (!ownedBy(hero).has(w.id) || hero.weapon === w) return;
  hero.setWeapon(w.id);
  sfx.block(0.5);
  saveWeapons();
  if (announce) hud.announce(w.name, twoPlayer ? `${hero.name} equipped it` : 'Equipped');
  if (hud.inventoryOpen) renderInventory();
}

/** Walked into a fallen leader's weapon: it's this hero's, and in their hand. It stays until every hero has one. */
function claimWeapon(w: WeaponDef, hero: Player) {
  ownedBy(hero).add(w.id);
  if (!hero.goods.claimed.includes(w.id)) hero.goods.claimed.push(w.id);
  hero.setWeapon(w.id);
  if (ctx.players.every((h) => !needsDrop(h, w.id))) drops.remove(w.id);
  else hud.announce(`${w.name} is still here`, `The other hero can grab one too`);
  saveWeapons();
  sfx.levelUp();
  ctx.addShake(0.2);
  const how = inputOf(hero).mode === 'gamepad' ? 'Press Y' : 'Press I';
  const who = twoPlayer ? `${hero.name} found it · ` : '';
  hud.announce(`New weapon: ${w.name}`, `${who}${how} to open the inventory and switch weapons`, true);
}

function openInventory(hero: Player = player) {
  if (phase !== 'playing' || !hero.alive || endingShown) return;
  inventoryFor = hero;
  hud.showMap(false);
  hud.showPause(false);
  renderInventory();
  // Two-player: the inventory covers only this hero's half, and the other keeps playing.
  hud.showInventory(true, twoPlayer ? (hero === player ? 'left' : 'right') : null);
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeInventory() {
  hud.showInventory(false);
  lockPointer();
}

/** One player leads the whole red army; two players lead three soldiers each. */
function inService(a: Ally) {
  if (a.army === 1 && !twoPlayer) return false;
  const hero = a.army === 1 ? player2 : player;
  return (a.army === 1 ? army2 : army1).indexOf(a) < armySize(hero);
}

/** How many soldiers a hero leads: 4 alone or 3 each in two-player, plus any hired (at most 5). */
function armySize(hero: Player) {
  return Math.min(MAX_ARMY, (twoPlayer ? ARMY_SIZE : SQUAD_SIZE) + hero.goods.soldiers);
}

/** Fallen soldiers are replaced by fresh ones in formation behind their hero. */
function reinforceSquad(everyone = false) {
  const slot = new THREE.Vector3();
  for (const a of allies) {
    if (!inService(a)) {
      if (a.state !== 'gone') a.dismiss();
      continue;
    }
    if (everyone || !a.alive) {
      a.slotPosition(ctx, slot);
      a.reinforce(slot.x, slot.z);
    }
  }
}

/** Starts (or restarts after death) play from a save: hero, territory and position. */
function enterWorld(save: SaveData) {
  hud.fadeIn();
  returnSpot = null;
  hud.setGoBackAvailable(false);
  hud.showShop(false);
  shopKind = null;
  atStall.clear();
  player.loadHero(save.name, save.level, save.xp);
  loadWeapons(save);
  hud.showInventory(false);
  kills = save.kills;
  playTime = save.playTime ?? 0;
  endingShown = false;
  campaign.load(save);
  const spot = respawnPoint(campaign.current.banner);
  player.reset(spot.x, spot.z);
  if (twoPlayer) {
    const saved = p2Hero && loadHeroes().find((h) => h.id === p2Hero!.id);
    if (saved) {
      p2Hero = saved;
      player2.goods = goodsFrom(saved.goods, saved.weapons);
      player2.loadHero(saved.name, saved.level, saved.xp);
    }
    if (!owned2.has(player2.weapon.id)) player2.setWeapon(STARTING_WEAPON);
    player2.reset(spot.x - 1.6, spot.z);
  }
  reinforceSquad(true);
  for (const c of [camCtrl, camCtrl2]) {
    c.yaw = 0;
    c.pitch = 0.12;
    c.cut();
  }
  floaters.clear();
  floaters2.clear();
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
  if (b instanceof Player) return 3;
  if ('isBoss' in b) return b.isBoss ? 12 : b.radius > 0.5 ? 2.5 : 1;
  return 1;
};

/** Keeps bodies from overlapping; heavier bodies get pushed less. */
function separateBodies() {
  const bodies: (Player | Ally | Enemy)[] = [...ctx.players];
  for (const a of allies) if (a.alive) bodies.push(a);
  const near = (e: Enemy) => ctx.players.some((h) => e.pos.distanceToSquared(h.pos) < 40 * 40);
  for (const e of enemies) if (e.alive && !e.flying && near(e)) bodies.push(e);
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
    const near = ctx.players.some((h) => Math.abs(z.pos.x - h.pos.x) < activeRange && Math.abs(z.pos.z - h.pos.z) < activeRange);
    if (near) z.update(dt, ctx);
    else z.sleep(dt);
  }
}

function mapData(objective: Objective): MapData {
  return {
    player: { x: player.pos.x, z: player.pos.z, yaw: player.yaw },
    player2: twoPlayer ? { x: player2.pos.x, z: player2.pos.z, yaw: player2.yaw } : null,
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

// ---------- Two players ----------

/** Player 2 joins on controller `padIndex`, beside Player 1, with their own army of three. */
function joinPlayer2(padIndex: number) {
  twoPlayer = true;
  waitingForP2 = false;
  input2.padIndex = padIndex;
  input2.lastPadIndex = padIndex;
  input.exclude = padIndex;
  if (input.lastPadIndex === padIndex) input.lastPadIndex = null;
  ctx.players = [player, player2];
  // Who is Player 2? They pick on their half of the screen while Player 1 plays on.
  p2Hero = null;
  choosingP2 = true;
  player2.loadHero('Player 2', 1, 0);
  owned2.clear();
  owned2.add(STARTING_WEAPON);
  player2.setWeapon(STARTING_WEAPON);
  hud.showP2Picker(loadHeroes());
  // Appear at Player 1's left (the camera looks over the right shoulder).
  const side = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw)).multiplyScalar(1.6);
  player2.reset(player.pos.x + side.x, player.pos.z + side.z);
  player2.yaw = player.yaw;
  player2.h.root.visible = true;
  camCtrl2.yaw = camCtrl.yaw;
  camCtrl2.pitch = camCtrl.pitch;
  camCtrl2.cut();
  hud.setSplit(true);
  updateAspect();
  reinforceSquad();
}

function leavePlayer2() {
  if (!twoPlayer) return;
  saveP2(); // keep Player 2's hero for next time
  p2Hero = null;
  choosingP2 = false;
  hud.showP2Picker(null);
  twoPlayer = false;
  waitingForP2 = false;
  input.exclude = null;
  input2.padIndex = null;
  ctx.players = [player];
  ctx.leader = player;
  player2.h.root.visible = false;
  floaters2.clear();
  hud.setSplit(false);
  updateAspect();
  // Player 1's army is back to full strength.
  reinforceSquad();
  hud.announce('Player 2 has left', 'Their hero is saved · Your army is back to full strength');
}

/** Each controller's A button last frame, to catch a fresh press. */
const padA = new Map<number, boolean>();

/**
 * A second controller pressing A brings in Player 2: any time, if Player 1
 * is already on a controller, or after "Add Player 2" (so a keyboard player
 * can be joined by someone with a controller).
 */
function checkJoin() {
  const pads = navigator.getGamepads?.() ?? [];
  const anyStandard = [...pads].some((p) => p?.connected && p.mapping === 'standard');
  for (const p of pads) {
    // Only real controllers can join (not remotes or headsets).
    if (!p?.connected || (anyStandard && p.mapping !== 'standard')) continue;
    const down = !!(p.buttons[PAD.A]?.pressed || (p.buttons[PAD.A]?.value ?? 0) > 0.5);
    const fresh = down && !padA.get(p.index);
    padA.set(p.index, down);
    if (!fresh || twoPlayer || phase !== 'playing' || endingShown || menuNav.menuOpen) continue;
    const p1Pad = input.lastPadIndex;
    const p1OnKeyboard = input.mode === 'mouse' || p1Pad === null;
    if ((waitingForP2 && (p1OnKeyboard || p.index !== p1Pad)) || (p1Pad !== null && input.mode === 'gamepad' && p.index !== p1Pad)) {
      joinPlayer2(p.index);
      return;
    }
  }
}

/** A fallen hero comes back beside the other one after a few seconds (two-player). */
function revivingIn(h: Player): number | null {
  if (!twoPlayer || h.alive) return null;
  const other = h === player ? player2 : player;
  return other.alive ? REVIVE_TIME - h.stateTime : null;
}

function updateRevives() {
  if (!twoPlayer) return;
  for (const h of ctx.players) {
    const left = revivingIn(h);
    if (left === null || left > 0) continue;
    const other = h === player ? player2 : player;
    const yaw = other.yaw;
    h.reset(other.pos.x - Math.cos(yaw) * 1.6, other.pos.z + Math.sin(yaw) * 1.6);
    h.yaw = yaw;
    (h === player ? camCtrl : camCtrl2).yaw = yaw;
    (h === player ? camCtrl : camCtrl2).cut();
    particles.burst(new THREE.Vector3(h.pos.x, h.pos.y + 1, h.pos.z), 0xffd36b, 24, 5);
    sfx.checkpoint();
    hud.announce(`${h.name} is back!`, '');
  }
  // The soldiers follow whichever hero is standing.
  ctx.leader = player.alive || !player2.alive ? player : player2;
}

hud.onTogglePlayer2 = () => {
  if (twoPlayer) leavePlayer2();
  else {
    waitingForP2 = true;
    hud.announce('Player 2', 'Press A on the second controller to join');
  }
  lockPointer();
};

// ---------- Fort Victory: teleporting, shops and potions ----------

/** Where "Go back" returns the team after teleporting to the fort. */
let returnSpot: { x: number; z: number; yaw: number } | null = null;

/** Moves both heroes (side by side) and their living soldiers to (x, z). */
function teleportTeam(x: number, z: number, yaw: number) {
  ctx.players.forEach((h, i) => {
    if (!h.alive) return;
    h.teleport(x - Math.cos(yaw) * 1.6 * i, z + Math.sin(yaw) * 1.6 * i, yaw);
    (h === player ? camCtrl : camCtrl2).yaw = yaw;
  });
  const slot = new THREE.Vector3();
  for (const a of allies) {
    if (!a.alive) continue;
    a.slotPosition(ctx, slot);
    a.reinforce(slot.x, slot.z);
  }
  projectiles.clear();
  particles.burst(new THREE.Vector3(x, heightAt(x, z) + 1, z), 0xffd36b, 30, 6);
  sfx.checkpoint();
}

hud.onGoToFort = () => {
  if (campaign.activeFight) {
    hud.announce('Not now!', "You can't leave in the middle of a boss fight");
    return;
  }
  const from = pausedBy.alive ? pausedBy : player;
  returnSpot = { x: from.pos.x, z: from.pos.z, yaw: from.yaw };
  const spot = respawnPoint(FORT.banner);
  teleportTeam(spot.x, spot.z, FORT.gateAngle + Math.PI);
  hud.setGoBackAvailable(true);
  hud.announce('Fort Victory', 'Pause · Go back returns you to where you were');
  lockPointer();
};
hud.onGoBack = () => {
  if (!returnSpot) return;
  if (campaign.activeFight) {
    hud.announce('Not now!', "You can't leave in the middle of a boss fight");
    return;
  }
  teleportTeam(returnSpot.x, returnSpot.z, returnSpot.yaw);
  returnSpot = null;
  hud.setGoBackAvailable(false);
  lockPointer();
};

/** Who is shopping, and where. */
let shopFor: Player = player;
let shopKind: ShopKind | null = null;
/** The stall each hero is standing at (a shop opens when they step up to it). */
const atStall = new Map<Player, ShopKind | null>();

/** The stall whose counter this hero is standing at, if any. */
function stallAt(h: Player): ShopKind | null {
  for (const st of FORT.stalls) {
    const fx = FORT.x + Math.sin(st.angle) * 7.2;
    const fz = FORT.z + Math.cos(st.angle) * 7.2;
    if (Math.hypot(h.pos.x - fx, h.pos.z - fz) < 1.7) return st.kind;
  }
  return null;
}

function updateShopTriggers() {
  for (const h of ctx.players) {
    if (!h.alive || (h === player2 && choosingP2)) continue;
    const kind = stallAt(h);
    const was = atStall.get(h) ?? null;
    atStall.set(h, kind);
    if (kind && kind !== was && !hud.shopOpen && !hud.inventoryOpen && !hud.p2PickerOpen && !hud.pauseOpen) openShop(h, kind);
  }
}

function openShop(h: Player, kind: ShopKind) {
  shopFor = h;
  shopKind = kind;
  hud.showMap(false);
  renderShop();
  hud.showShop(true, twoPlayer ? (h === player ? 'left' : 'right') : null);
  if (document.pointerLockElement) document.exitPointerLock();
  sfx.click();
}

function closeShop() {
  hud.showShop(false);
  shopKind = null;
  saveWeapons();
  lockPointer();
}
hud.onShopClose = closeShop;

/** After buying or selling: a sound, the shop redrawn, and the hero saved. */
function bought(sound = true) {
  if (sound) sfx.checkpoint();
  renderShop();
  saveWeapons();
}

function renderShop() {
  if (!shopKind) return;
  const h = shopFor;
  const g = h.goods;
  const mine = ownedBy(h);
  const stall = FORT.stalls.find((st) => st.kind === shopKind)!;
  const sub = `${twoPlayer ? `${h.name} has` : 'You have'} ${g.gold} gold`;
  const entries: ShopEntry[] = [];
  if (shopKind === 'potions') {
    entries.push({
      label: 'Healing Potion',
      sub: `${POTION_PRICE} gold · heals half your health · you carry ${g.potions} of ${MAX_POTIONS}`,
      disabled: g.gold < POTION_PRICE || g.potions >= MAX_POTIONS,
      onClick: () => {
        g.gold -= POTION_PRICE;
        g.potions++;
        bought();
      },
    });
  } else if (shopKind === 'armory') {
    ARMOR.forEach((a, tier) => {
      if (tier === 0) return;
      const wearing = tier === g.armor;
      entries.push({
        label: a.name,
        sub: wearing ? 'You are wearing it' : tier < g.armor ? 'You have better armor' : `${a.price} gold · +${a.health} health`,
        disabled: tier <= g.armor || g.gold < a.price,
        onClick: () => {
          g.gold -= a.price;
          g.armor = tier;
          h.refreshStats();
          bought();
        },
      });
    });
  } else if (shopKind === 'barracks') {
    const size = armySize(h);
    entries.push({
      label: 'Hire a soldier',
      sub: size >= MAX_ARMY ? `Your army is full (${size} of ${MAX_ARMY})` : `${SOLDIER_PRICE} gold · army ${size} of ${MAX_ARMY}`,
      disabled: size >= MAX_ARMY || g.gold < SOLDIER_PRICE,
      onClick: () => {
        g.gold -= SOLDIER_PRICE;
        g.soldiers++;
        reinforceSquad(); // the new soldier joins right away
        bought();
      },
    });
  } else {
    // The weaponsmith: buy (or buy back), trade the weapon in hand, or sell.
    const equipped = h.weapon;
    const forSale = WEAPONS.filter((w) => !mine.has(w.id) && (w.shop || g.pawned.includes(w.id)));
    entries.push({ heading: 'Buy' });
    if (forSale.length === 0) entries.push({ label: 'Nothing left to buy', sub: 'You have every weapon here', disabled: true, onClick: () => {} });
    for (const w of forSale) {
      entries.push({
        label: g.pawned.includes(w.id) && !w.shop ? `Buy back the ${w.name}` : w.name,
        sub: `${w.value} gold · ${w.description}`,
        disabled: g.gold < w.value,
        onClick: () => {
          g.gold -= w.value;
          g.pawned = g.pawned.filter((id) => id !== w.id);
          mine.add(w.id);
          h.setWeapon(w.id);
          bought();
        },
      });
      if (equipped.value >= w.value) {
        entries.push({
          label: `Trade your ${equipped.name} for the ${w.name}`,
          sub: 'A straight swap, no gold needed',
          onClick: () => {
            mine.delete(equipped.id);
            if (!g.pawned.includes(equipped.id)) g.pawned.push(equipped.id);
            g.pawned = g.pawned.filter((id) => id !== w.id);
            mine.add(w.id);
            h.setWeapon(w.id);
            bought();
          },
        });
      }
    }
    entries.push({ heading: 'Sell' });
    const sellable = WEAPONS.filter((w) => mine.has(w.id) && w.value > 0);
    if (sellable.length === 0) entries.push({ label: 'Nothing to sell', sub: "Your Soldier's Sword stays with you", disabled: true, onClick: () => {} });
    for (const w of sellable) {
      entries.push({
        label: `Sell the ${w.name}`,
        sub: `${Math.floor(w.value / 2)} gold${w === equipped ? ' · the weapon in your hand' : ''}`,
        onClick: () => {
          g.gold += Math.floor(w.value / 2);
          mine.delete(w.id);
          if (!g.pawned.includes(w.id)) g.pawned.push(w.id);
          if (h.weapon === w) h.setWeapon(STARTING_WEAPON);
          bought(false);
          sfx.levelUp();
        },
      });
    }
  }
  hud.renderShop(stall.name, sub, entries, inputOf(h).mode === 'gamepad');
}

/** H or d-pad up: drink a healing potion. */
function updatePotions(browsing: Player | null) {
  for (const h of ctx.players) {
    if (h === browsing || !inputOf(h).potionPressed || (h === player2 && choosingP2)) continue;
    const at = new THREE.Vector3(h.pos.x, h.pos.y + 2.1, h.pos.z);
    const before = h.hp;
    if (h.drinkPotion()) {
      floatText(at, `+${Math.round(h.hp - before)}`, 'heal');
      particles.burst(new THREE.Vector3(h.pos.x, h.pos.y + 1.2, h.pos.z), 0xff5a6a, 16, 3);
      sfx.checkpoint();
    } else if (h.goods.potions === 0) {
      floatText(at, 'No potions', 'damage');
    }
  }
}

// ---------- Outfits ----------

/** The outfit picked for a new hero (before the game starts). */
let pendingOutfit: Outfit = { ...DEFAULT_OUTFIT };
/** Whose outfit the outfit screen is changing. */
let outfitFor: Player = player;
/** Player 2's heroes start in blue. */
const P2_OUTFIT: Outfit = { ...DEFAULT_OUTFIT, shirt: 0x2a4fa3 };

hud.onOutfitChange = (o) => {
  outfitFor.setOutfit(o);
  if (phase === 'menu') pendingOutfit = o;
};
hud.onOutfitDone = () => {
  if (phase === 'menu') {
    hud.showIntro(pendingName);
    return;
  }
  // Changed from the pause menu: save it and play on.
  if (outfitFor === player) saveWeapons();
  else saveP2();
  hud.showScreen('none');
  lockPointer();
};
hud.onOutfit = () => {
  outfitFor = twoPlayer ? pausedBy : player;
  hud.showPause(false);
  hud.showOutfit(outfitFor.outfit, outfitFor === player2);
  if (document.pointerLockElement) document.exitPointerLock();
};

/** While dressing: the camera close in front of the hero, who turns slowly to show off the outfit. */
function updateOutfitCamera(dt: number) {
  const h = outfitFor;
  h.yaw += dt * 0.6;
  h.h.root.rotation.y = h.yaw;
  const p = h.pos;
  const view = Math.PI * 0.25; // the camera looks from this direction
  const fx = Math.sin(view);
  const fz = Math.cos(view);
  camera.position.set(p.x + fx * 4.2, p.y + 1.7, p.z + fz * 4.2);
  // Look a little to the hero's side so they stand to the right of the menu.
  camera.lookAt(p.x - fz * 1.5, p.y + 1.1, p.z + fx * 1.5);
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
    if (phase === 'playing' && !input.locked && !usingPad && !twoPlayer && player.alive && !hud.optionsOpen && !hud.inventoryOpen && !hud.shopOpen && !hud.outfitOpen) hud.showPause(true);
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
  pendingOutfit = { ...DEFAULT_OUTFIT };
  player.setOutfit(pendingOutfit);
  outfitFor = player;
  hud.showOutfit(pendingOutfit);
};
hud.onBegin = () => {
  const save = { ...newSave(pendingName), outfit: pendingOutfit };
  writeSave(save);
  enterWorld(save);
  lockPointer();
};
hud.onResume = lockPointer;
hud.onInventory = () => openInventory(pausedBy);
hud.onInventoryClose = closeInventory;
hud.onEquip = (id) => equip(WEAPONS.find((w) => w.id === id)!, false, inventoryFor);
hud.onRespawn = () => {
  // Nothing is lost: save everything as it is, then come back at the fort.
  campaign.current = campaign.fortCheckpoint;
  saveGame();
  enterWorld(loadSave() ?? newSave(player.name));
  lockPointer();
};
hud.onSettings = (s) => {
  applySettings(s);
  ctx.difficulty = DIFFICULTIES[s.difficulty];
  saveSettings(s);
};
input.onLockChange = (locked) => {
  if (!locked) {
    hud.showMap(false);
    pausedBy = player;
    hud.setPauseInventoryLabel(twoPlayer ? `${player.name}'s inventory` : 'Inventory');
  }
  if (twoPlayer && !locked && phase === 'playing' && !hud.optionsOpen && !hud.inventoryOpen && !hud.shopOpen && !hud.outfitOpen && !endingShown) {
    // Player 1 let go of the mouse: their own pause menu, on their half.
    hud.showPause(player.alive, 'left');
    return;
  }
  if (phase === 'playing' && !hud.optionsOpen && !hud.inventoryOpen && !hud.shopOpen && !hud.outfitOpen && !endingShown) hud.showPause(!locked && ctx.players.some((h) => h.alive));
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
  hud.announce('The lairs still stir', "Enemies keep rising in the four leaders' lairs");
  lockPointer();
};
/** Back to the title screen (progress since the last checkpoint is dropped; the save stays). */
function returnToTitle() {
  leavePlayer2();
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

/** Each camera fits its view: the whole screen, or half of it in two-player. */
function updateAspect() {
  const aspect = (window.innerWidth / (twoPlayer ? 2 : 1)) / window.innerHeight;
  for (const c of [camera, camera2]) {
    c.aspect = aspect;
    c.updateProjectionMatrix();
  }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateAspect();
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
  if (hud.outfitOpen) {
    updateOutfitCamera(dt);
    return;
  }
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
  else if (!ctx.players.some((h) => h.alive)) theme = 'silence';
  else if (fight) {
    theme = 'boss';
    mood = fight.def.id;
  } else {
    const r2 = 28 * 28;
    const engaged = enemies.some((e) => e.alive && e.target !== null && e.fightActive && ctx.players.some((h) => e.pos.distanceToSquared(h.pos) < r2));
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
  checkJoin();
  input.poll(realDt);
  if (twoPlayer) input2.poll(realDt);
  const inputs = twoPlayer ? [input, input2] : [input];
  // The Menu button opens and closes the pause menu; the menus themselves are driven by the d-pad, A and B.
  // Two-player: the pause menu covers only the presser's half, and only they can close it.
  const p1Menu = input.mode === 'gamepad' && input.pausePressed;
  const p2Menu = twoPlayer && !choosingP2 && input2.pausePressed;
  const menuPressed = p1Menu || p2Menu;
  const resumed = hud.pauseOpen && (twoPlayer ? (pausedBy === player ? p1Menu : p2Menu) : menuPressed);
  if (resumed) hud.showPause(false);
  // Two-player menus (pause, inventory, who is Player 2?) cover one hero's half only.
  // Only that hero's controller works them, and the game goes on for the other.
  const sideInventory = twoPlayer && (hud.inventoryOpen || hud.p2PickerOpen || hud.pauseOpen || hud.shopOpen);
  const browsing = !twoPlayer
    ? null
    : hud.p2PickerOpen
      ? player2
      : hud.shopOpen
        ? shopFor
        : hud.inventoryOpen
          ? inventoryFor
          : hud.pauseOpen
            ? pausedBy
            : null;
  menuNav.update(browsing ? [inputOf(browsing)] : inputs);

  if (phase === 'menu') {
    player.idle(realDt);
    for (const a of allies) a.update(realDt, ctx);
    updateMenuCamera(realDt);
  } else {
    // With a controller there's no mouse capture: play whenever no menu is open.
    const padPlay = (input.mode === 'gamepad' || IS_XBOX || twoPlayer) && (!menuNav.menuOpen || sideInventory);
    if (padPlay && menuPressed && !resumed && !sideInventory) {
      pausedBy = p2Menu ? player2 : player;
      hud.setPauseInventoryLabel(twoPlayer ? `${pausedBy.name}'s inventory` : 'Inventory');
      hud.showPause(true, twoPlayer ? (pausedBy === player ? 'left' : 'right') : null);
    }
    let closedNow = false;
    if (hud.shopOpen && shopFor === player && input.escapePressed) {
      closeShop();
      closedNow = true;
    }
    if (hud.inventoryOpen) {
      // One player: the game waits while the hero picks a weapon. Only the chooser can close it.
      const chooser = inputOf(inventoryFor);
      if (chooser.inventoryPressed || (inventoryFor === player && input.escapePressed)) {
        closeInventory();
        closedNow = true;
      }
    }
    if (((!hud.inventoryOpen && !hud.shopOpen) || sideInventory) && !closedNow && (input.locked || padPlay || testMode) && !endingShown) {
      playTime += realDt;
      const chooserInput = browsing ? inputOf(browsing) : null;
      if (inputs.some((i) => i !== chooserInput && i.mapPressed)) hud.showMap(!hud.mapOpen);
      if (!hud.inventoryOpen && !hud.p2PickerOpen && !hud.shopOpen) {
        if (input.inventoryPressed && player.alive) openInventory(player);
        else if (twoPlayer && input2.inventoryPressed && player2.alive) openInventory(player2);
      }
      updateWeaponSwap(browsing);
      updatePotions(browsing);
      // The hero choosing a weapon stands still; the other plays on.
      const in1 = browsing === player ? noInput : input;
      const in2 = browsing === player2 ? noInput : input2;
      camCtrl.applyInput(in1, realDt);
      if (twoPlayer) camCtrl2.applyInput(in2, realDt);
      let dt = realDt;
      // Hit-stop: freeze the action for a few frames when a blow lands.
      if (hitStopTimer > 0) {
        hitStopTimer -= realDt;
        dt *= 0.06;
      }
      player.update(dt, ctx, in1, camCtrl.yaw);
      if (twoPlayer) player2.update(dt, ctx, in2, camCtrl2.yaw);
      updateRevives();
      updateShopTriggers();
      for (const a of allies) a.update(dt, ctx);
      updateEnemies(dt);
      separateBodies();
      campaign.update(dt, ctx);
      projectiles.update(dt, ctx);
      const claimed = drops.update(dt, ctx.players.filter((h) => h.alive), particles, (h, w) => needsDrop(h, w.id));
      if (claimed) claimWeapon(claimed.weapon, claimed.by);
      particles.update(dt);
      floaters.update(dt, camera);
      if (twoPlayer) floaters2.update(dt, camera2);
    }
    camCtrl.update(realDt, player.pos);
    if (hud.outfitOpen) updateOutfitCamera(realDt);
    camera.updateMatrixWorld();
    if (twoPlayer) {
      camCtrl2.update(realDt, player2.pos);
      camera2.updateMatrixWorld();
    }

    if (ctx.players.every((h) => !h.alive && h.stateTime > 1.6) && !deathShown) {
      deathShown = true;
      hud.showMap(false);
      if (document.pointerLockElement) document.exitPointerLock();
      hud.showDeath(true);
    }

    const lead = ctx.leader;
    const objective = weaponObjective() ?? campaign.objective(lead.pos, player.level);
    hud.setObjective(objective.text);
    hud.views[0].setMarker(objective.at, camera, player.pos);
    if (twoPlayer) hud.views[1].setMarker(objective.at, camera2, player2.pos);
    const fight = campaign.activeFight;
    if (fight) hud.setBossHealth(fight.leader.healthFraction);
    if (hud.mapOpen) hud.drawMap(mapData(objective));
  }

  world.update(ctx.leader.pos, realDt, campaign.gloomAt(ctx.leader.pos));
  // Nothing past the fog can be seen, so don't draw it.
  const far = (scene.fog as THREE.Fog).far + 15;
  for (const c of [camera, camera2]) {
    if (Math.abs(c.far - far) > 2) {
      c.far = far;
      c.updateProjectionMatrix();
    }
  }
  updateSound(realDt);
  updateXboxTip(realDt);
  // A live controller readout on the pause screen, for tracking down stuck sticks or keys.
  if (hud.pauseOpen) hud.setPadDebug(input.debugText() + (twoPlayer ? ` · P2 ${input2.debugText()}` : ''));
  hud.update(kills);
  hud.setButtonHints(IS_XBOX || twoPlayer || input.mode === 'gamepad');
  hud.views[0].update(player, revivingIn(player));
  if (twoPlayer) hud.views[1].update(player2, revivingIn(player2));
  for (const i of inputs) i.endFrame();
}

/** Draws the world: once full-screen, or twice side by side in two-player. */
function render() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.shadowMap.needsUpdate = true;
  if (!twoPlayer || phase !== 'playing') {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    prepareView(camera);
    renderer.render(scene, camera);
    return;
  }
  const half = Math.floor(w / 2);
  renderer.setScissorTest(true);
  [camera, camera2].forEach((cam, i) => {
    renderer.setViewport(i * half, 0, half, h);
    renderer.setScissor(i * half, 0, half, h);
    prepareView(cam);
    renderer.render(scene, cam);
  });
  renderer.setScissorTest(false);
}

/** Health bars face this camera, and soldiers right in front of its lens are hidden so they don't block the view. */
function prepareView(cam: THREE.Camera) {
  for (const z of enemies) z.updateBar(cam);
  for (const a of allies) {
    if (a.state === 'gone') continue;
    const dx = a.pos.x - cam.position.x;
    const dy = a.pos.y + 1.2 - cam.position.y;
    const dz = a.pos.z - cam.position.z;
    a.h.root.visible = dx * dx + dy * dy + dz * dz > 1.6 * 1.6;
  }
}

/** Number keys pick a weapon; the d-pad steps through the ones you own. */
function updateWeaponSwap(browsing: Player | null) {
  if (player.alive && browsing !== player) {
    const slot = input.weaponSlotPressed;
    if (slot !== null && WEAPONS[slot]) {
      if (owned.has(WEAPONS[slot].id)) equip(WEAPONS[slot], true);
      else hud.announce('Not yet yours', `Defeat its owner to claim slot ${slot + 1}`);
    }
  }
  for (const h of ctx.players) {
    if (h === browsing) continue;
    const step = inputOf(h).weaponCyclePressed;
    if (!h.alive || step === 0 || ownedBy(h).size < 2) continue;
    const mine = WEAPONS.filter((w) => ownedBy(h).has(w.id));
    const i = mine.indexOf(h.weapon);
    equip(mine[(i + step + mine.length) % mine.length], true, h);
  }
}

/** A fallen leader's weapon waiting to be picked up comes before everything else. */
function weaponObjective(): Objective | null {
  const near = drops.nearest(ctx.leader.pos);
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
  render();
  updateStats(now, performance.now() - now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for debugging from the browser console. step() runs the game at a
// fixed 60 fps, even in a background tab where animation frames are paused.
Object.assign(window, {
  __game: {
    player,
    player2,
    input2,
    joinPlayer2,
    leavePlayer2,
    get twoPlayer() {
      return twoPlayer;
    },
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
      render();
    },
  },
});
