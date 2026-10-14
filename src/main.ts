import './style.css';
import * as THREE from 'three';
import { Input, PAD } from './input';
import { createWorld, heightAt, respawnPoint, territoryWeight } from './world';
import { Player } from './player';
import type { Enemy } from './enemy';
import { Ally, ARMY_SIZE, SQUAD_SIZE, SQUAD_SLOTS, type ArmyOrder } from './ally';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { Particles } from './particles';
import { Floaters } from './floaters';
import { Projectiles } from './projectiles';
import { initAudio, musicOutput, setVolumes, sfx } from './audio';
import { Music, type Mood, type Theme } from './music';
import { MenuNavigator } from './menuNav';
import { Campaign, type Objective } from './campaign';
import { CAMP_BANNER, DUEL_ARENA, FORT, TERRITORIES, type LeaderId, type ShopKind } from './layout';
import { DUEL_DIFFICULTY, DUEL_RESPAWN, DUEL_TARGET, DuelFoe } from './duel';
import { XP_REWARD } from './progression';
import {
  ARMOR,
  ARMOR_BY_STRENGTH,
  CAPE_STAMINA,
  GOLDEN_ARMOR,
  goldFor,
  HELMET_HEALTH,
  loadGoods,
  maxPotions,
  newGoods,
  MAX_ARMY,
  OUTPOST_GOLD,
  POTION_PRICE,
  SOLDIER_PRICE,
  UNLOCKS,
  unlockOf,
  type Goods,
  type UnlockName,
} from './shop';
import type { ShopEntry } from './hud';
import { COMMANDER_NAME, loadMission, missionAt, type MissionState } from './missions';
import { createHumanoid } from './character';
import { addCape } from './vampires';
import { DEFAULT_OUTFIT, loadOutfit, type Outfit } from './outfit';
import { CoinPiles, WeaponDrops } from './loot';
import { isWeaponId, STARTING_WEAPON, WEAPONS, weaponOf, type WeaponDef, type WeaponId } from './weapons';
import { DIFFICULTIES, IS_XBOX, loadSettings, saveSettings, type Settings } from './settings';
import { loadSave, newCampaignId, newSave, useTestSaveSlot, writeSave, type SaveData } from './save';
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
/** Piles of gold coins where leaders fell. */
const coinPiles = new CoinPiles(scene);
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
/** The ending has played for this save (it waits for a hero who fell just as Zomawi did). */
let endingSeen = true;
/** Weapons the hero has claimed. */
const owned = new Set<WeaponId>([STARTING_WEAPON]);
/** Player 2's own weapons (each hero has their own inventory). */
const owned2 = new Set<WeaponId>([STARTING_WEAPON]);
const ownedBy = (h: Player) => (h === player2 ? owned2 : owned);

/** Duel mode: the two heroes and their armies fight each other in the arena. */
let duel = false;
/** Knockouts so far: Player 1's, Player 2's. */
let duelScore: [number, number] = [0, 0];
/** Someone has won; the Rematch screen is up. */
let duelOver = false;
/** Heroes down and already counted (each knockout scores once). */
const knockedOut = new Set<Player>();
/** Potions each hero brought, given back for a rematch (a duel never uses anything up). */
let duelPotions: [number, number] = [0, 0];
/** Each side, as the other side's sword sees it. */
const duelSides: [DuelFoe[], DuelFoe[]] = [[player, ...army1].map((b) => new DuelFoe(b)), [player2, ...army2].map((b) => new DuelFoe(b))];

/** Both heroes are in and fighting (not still waiting for, or choosing, Player 2). */
const duelLive = () => duel && twoPlayer && !choosingP2;

const ctx: GameContext = {
  scene,
  colliders: world.colliders,
  player,
  players: [player],
  leader: player,
  allies,
  enemies,
  foesOf: (team) => (!duel ? enemies : duelLive() ? duelSides[1 - team] : []),
  get duel() {
    return duel;
  },
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
    countForMission(z);
    if (z.isBoss) {
      // Leaders drop a pile of coins to scoop up (see leaderDefeated).
      floatText(new THREE.Vector3(z.pos.x, z.pos.y + 2.2, z.pos.z), `+${z.xpReward} XP`, 'xp');
    } else {
      const gold = goldFor(z.xpReward, false);
      floatText(new THREE.Vector3(z.pos.x, z.pos.y + 2.2, z.pos.z), `+${z.xpReward} XP · +${gold} gold`, 'xp');
      awardGold(gold);
    }
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
    if (w && activeHeroes().some((h) => needsDrop(h, w.id))) drops.place(w.id, at.x, at.z);
    if (id === 'zomawi') endingSeen = false;
    // Its gold spills out beside its weapon.
    // (A couple of meters toward the arena's middle, so it never lands in the goo castle's goo.)
    const land = TERRITORIES.find((t) => t.leader.id === id);
    if (land && activeHeroes().some((h) => needsCoins(h, id))) {
      const dx = land.arena.x - at.x;
      const dz = land.arena.z - at.z;
      const d = Math.hypot(dx, dz);
      const k = d > 2.5 ? 2.5 / d : 0;
      coinPiles.place(id, at.x + dx * k + (k === 0 ? 2 : 0), at.z + dz * k);
    }
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

/** Levels from just after `from` up to `to` unlocked new weapons or armor at the mansion. */
function announceLevelUnlocks(h: Player, from: number, to: number) {
  const fresh = [
    ...WEAPONS.filter((w) => w.unlockLevel && w.unlockLevel > from && w.unlockLevel <= to).map((w) => `${w.name} (Weaponsmith)`),
    ...ARMOR.filter((a) => a.level && a.level > from && a.level <= to).map((a) => `${a.name} (Armory)`),
  ];
  if (fresh.length === 0) return;
  const who = twoPlayer ? `${h.name} · ` : '';
  // After the Level Up message.
  setTimeout(() => hud.announce(`New at Fort Victory: ${fresh.join(', ')}`, `${who}Level ${to} unlocked it · find it in the mansion`, true), 100);
}

/** Every hero playing gets the gold (each has their own). */
function awardGold(amount: number) {
  for (const h of ctx.players) if (!(h === player2 && choosingP2)) h.goods.gold += amount;
}

/** Every kill and capture gives each hero the XP; each levels up on their own. */
function awardXp(amount: number) {
  for (const h of ctx.players) {
    if (h === player2 && choosingP2) continue;
    const gained = h.gainXp(amount);
    if (gained === 0) continue;
    announceLevelUnlocks(h, h.level - gained, h.level);
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
  if (duel) return; // a duel changes nothing
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
    endingSeen,
    mission,
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
  if (duel) return;
  const save = loadSave();
  if (save) writeSave({ ...save, weapons: [...owned], weapon: player.weapon.id, goods: player.goods, outfit: player.outfit, mission });
  saveP2();
}

// ---------- Saved Player 2 heroes ----------

/** The saved hero Player 2 is playing (null while choosing, or one-player). */
let p2Hero: Player2Hero | null = null;
/** Player 2 has joined and is picking who they are. */
let choosingP2 = false;

/** Saves Player 2's hero: level, XP and weapons. */
function saveP2() {
  if (!twoPlayer || !p2Hero || duel) return;
  p2Hero = { ...p2Hero, level: player2.level, xp: player2.xp, weapons: [...owned2], weapon: player2.weapon.id, goods: player2.goods, outfit: player2.outfit };
  saveHero(p2Hero);
}

/** Player 2 becomes a saved hero, with their own level, XP and weapons. */
function becomeHero(hero: Player2Hero) {
  p2Hero = hero;
  choosingP2 = false;
  player2.goods = goodsFrom(hero.goods, hero.weapons, campaign.leaders, true);
  player2.setOutfit(loadOutfit(hero.outfit ?? P2_OUTFIT));
  player2.loadHero(hero.name, hero.level, hero.xp);
  owned2.clear();
  owned2.add(STARTING_WEAPON);
  for (const id of hero.weapons) if (isWeaponId(id)) owned2.add(id);
  player2.setWeapon(isWeaponId(hero.weapon) && owned2.has(hero.weapon) ? hero.weapon : STARTING_WEAPON);
  player2.hp = player2.maxHp;
  player2.stamina = player2.maxStamina;
  placeMissingDrops(campaign.leaders);
  placeMissingCoins(campaign.leaders);
  reinforceSquad();
  hud.showP2Picker(null);
  saveHero(hero);
  if (duel) {
    startDuel();
    return;
  }
  sfx.warHorn();
  hud.announce(`${hero.name} joins the fight!`, `Level ${hero.level} · Each hero leads an army of three`);
}

hud.onP2Pick = (id) => {
  const hero = loadHeroes().find((h) => h.id === id);
  if (hero) becomeHero(hero);
};
hud.onP2New = (name) => becomeHero(newHero(name));
hud.onP2Cancel = () => {
  leavePlayer2();
  if (duel) waitForDuelist();
};

// A Player 2 from before saved heroes existed (weapons kept in the main save) becomes a saved hero.
{
  const old = loadSave() as (SaveData & { player2?: { weapons: string[]; weapon: string } }) | null;
  if (old?.player2 && loadHeroes().length === 0) {
    saveHero({ ...newHero('Player 2'), level: old.level, weapons: old.player2.weapons, weapon: old.player2.weapon });
    delete old.player2;
    writeSave(old);
  }
}

/** Heroes in play (not a Player 2 still choosing who they are). */
function activeHeroes() {
  return ctx.players.filter((h) => !(h === player2 && choosingP2));
}

/** Takes away any leader's weapon on the ground that no hero playing still needs. */
function removeUnneededDrops() {
  for (const w of WEAPONS) if (w.from && drops.isOut(w.id) && !activeHeroes().some((h) => needsDrop(h, w.id))) drops.remove(w.id);
  for (const id of coinPiles.out) if (!activeHeroes().some((h) => needsCoins(h, id))) coinPiles.remove(id);
}

/** This hero hasn't scooped up this leader's pile of gold yet. */
function needsCoins(h: Player, leaderId: string) {
  return !h.goods.coins.includes(leaderId);
}

/** Gold in a leader's pile of coins (a quarter of its XP). */
function coinValue(leaderId: string) {
  return goldFor(XP_REWARD[leaderId as LeaderId] ?? 0, true);
}

/** Puts each beaten leader's coins back in its lair until every hero playing has scooped up their share. */
function placeMissingCoins(leaders: Iterable<string>) {
  for (const id of leaders) {
    const land = TERRITORIES.find((t) => t.leader.id === id);
    if (land && !coinPiles.isOut(id) && activeHeroes().some((h) => needsCoins(h, id))) coinPiles.place(id, land.arena.x + 2, land.arena.z + 1);
  }
}

/** Walked into a leader's pile of coins: this hero's share of the gold. */
function collectCoins(id: string, hero: Player) {
  const value = coinValue(id);
  hero.goods.gold += value;
  hero.goods.coins.push(id);
  if (activeHeroes().every((h) => !needsCoins(h, id))) coinPiles.remove(id);
  floatText(new THREE.Vector3(hero.pos.x, hero.pos.y + 2.2, hero.pos.z), `+${value} gold`, 'xp');
  sfx.levelUp();
  const land = TERRITORIES.find((t) => t.leader.id === id);
  const who = twoPlayer ? `${hero.name} · ` : '';
  hud.announce(`+${value} gold`, `${who}${land ? `${land.leader.title}'s treasure` : 'Treasure'} · spend it at Fort Victory`, true);
  saveWeapons();
}

/** This hero hasn't picked up this leader's weapon yet. */
function needsDrop(h: Player, id: WeaponId) {
  return !h.goods.claimed.includes(id) && !ownedBy(h).has(id);
}

/** A hero's goods from a save. Older saves: any leader weapons they have count as picked up. */
function goodsFrom(raw: Partial<Goods> | undefined, weapons: readonly string[], leaders: Iterable<string>, playerTwo = false): Goods {
  const goods = loadGoods(raw);
  if (!raw) goods.claimed = weapons.filter((id): id is WeaponId => isWeaponId(id) && WEAPONS.some((w) => w.id === id && w.from !== null));
  if (playerTwo) {
    // A Player 2 hero joining a different playthrough collects that one's leader gold (and weapons) afresh.
    if (goods.campaign !== campaignId) {
      goods.coins = [];
      goods.claimed = [];
      goods.campaign = campaignId;
    }
  } else if (!raw?.coins) {
    // Saves from before coin piles: leaders beaten then already paid out their gold.
    goods.coins = [...leaders];
  }
  return goods;
}

/** This playthrough's name (from the save). */
let campaignId = '';

/** Puts each beaten leader's weapon back in its lair until every hero playing has their own. */
function placeMissingDrops(leaders: Iterable<string>) {
  for (const id of leaders) {
    const w = weaponOf(id);
    const land = TERRITORIES.find((t) => t.leader.id === id);
    if (w && land && activeHeroes().some((h) => needsDrop(h, w.id)) && !drops.isOut(w.id)) drops.place(w.id, land.arena.x, land.arena.z);
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
  // Older saves get a playthrough name now (kept from here on).
  if (save && !save.campaignId) {
    save.campaignId = newCampaignId();
    writeSave(save);
  }
  campaignId = save?.campaignId ?? '';
  player.goods = goodsFrom(save?.goods, [...owned], save?.leaders ?? []);
  player.refreshStats();
  if (save?.outfit || player.outfit !== DEFAULT_OUTFIT) player.setOutfit(loadOutfit(save?.outfit));
  drops.clear();
  placeMissingDrops(leaders);
  coinPiles.clear();
  placeMissingCoins(leaders);
}

/** Whose weapon the open inventory is choosing. */
let inventoryFor: Player = player;
/** Who opened the pause menu (its Inventory button opens their inventory). */
let pausedBy: Player = player;

const inputOf = (h: Player) => (h === player2 ? input2 : input);

function renderInventory() {
  const chooser = twoPlayer ? inventoryFor.name : undefined;
  hud.renderInventory(ownedBy(inventoryFor), inventoryFor.weapon.id, inputOf(inventoryFor).mode === 'gamepad', chooser, missionsDone());
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
  if (activeHeroes().every((h) => !needsDrop(h, w.id))) drops.remove(w.id);
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
  if (hero === player && document.pointerLockElement) document.exitPointerLock();
}

function closeInventory() {
  hud.showInventory(false);
  if (inventoryFor === player) lockPointer();
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
  resetOrders();
  hud.showShop(false);
  shopKind = null;
  atStall.clear();
  player.loadHero(save.name, save.level, save.xp);
  loadWeapons(save);
  hud.showInventory(false);
  kills = save.kills;
  playTime = save.playTime ?? 0;
  endingSeen = save.endingSeen ?? true;
  mission = loadMission(save.mission);
  endingShown = false;
  campaign.load(save);
  const spot = respawnPoint(campaign.current.banner);
  player.reset(spot.x, spot.z);
  if (twoPlayer) {
    const saved = p2Hero && loadHeroes().find((h) => h.id === p2Hero!.id);
    if (saved) {
      p2Hero = saved;
      player2.goods = goodsFrom(saved.goods, saved.weapons, campaign.leaders, true);
      player2.loadHero(saved.name, saved.level, saved.xp);
    }
    if (!owned2.has(player2.weapon.id)) player2.setWeapon(STARTING_WEAPON);
    player2.reset(spot.x - 1.6, spot.z);
  }
  // In Fort Victory's mansion, face the door (and the camera looks out the same way).
  const facing = campaign.current === campaign.fortCheckpoint ? FORT.gateAngle : 0;
  for (const h of [player, player2]) h.yaw = facing;
  reinforceSquad(true);
  for (const c of [camCtrl, camCtrl2]) {
    c.yaw = facing;
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
  if (!endingSeen && campaign.victorious) setTimeout(showEnding, 2000);
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
  player2.goods = newGoods();
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
  if (duel) toDuelSpawn(player2);
  hud.setSplit(true);
  updateAspect();
  resetOrders();
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
  pausedBy = player;
  inventoryFor = player;
  hud.setPauseInventoryLabel('Inventory');
  removeUnneededDrops();
  resetOrders();
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
    if ((waitingForP2 && (p1OnKeyboard || p.index !== p1Pad)) || (p1Pad !== null && p.index !== p1Pad)) {
      joinPlayer2(p.index);
      return;
    }
  }
}

/** A fallen hero comes back beside the other one after a few seconds (two-player). */
function revivingIn(h: Player): number | null {
  if (duel) return h.alive || duelOver ? null : DUEL_RESPAWN - h.stateTime;
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
  resetOrders();
  ctx.players.forEach((h, i) => {
    if (!h.alive) return;
    h.teleport(x - Math.sin(yaw) * 1.6 * i, z - Math.cos(yaw) * 1.6 * i, yaw);
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
  teleportTeam(FORT.arrival.x, FORT.arrival.z, FORT.gateAngle);
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
    if (Math.hypot(h.pos.x - st.front.x, h.pos.z - st.front.z) < 1.5) return st.kind;
  }
  const c = FORT.commander.talk;
  if (campaign.victorious && Math.hypot(h.pos.x - c.x, h.pos.z - c.z) < 1.8) return 'missions';
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
  if (h === player && document.pointerLockElement) document.exitPointerLock();
  sfx.click();
}

function closeShop() {
  hud.showShop(false);
  shopKind = null;
  saveWeapons();
  if (shopFor === player) lockPointer();
}
hud.onShopClose = closeShop;

/** How many of Commander Hale's missions are done (each unlocks something to buy). */
function missionsDone() {
  return mission.index;
}

/** A not-yet-unlocked item: shown greyed out with the mission that unlocks it. */
function lockedEntry(name: UnlockName): ShopEntry {
  const u = unlockOf(name);
  return { label: name, sub: `Locked · unlocks after Commander Hale's mission ${u.after}`, disabled: true, onClick: () => {} };
}

/** Something Commander Hale's missions unlock: locked, for sale, or already bought. */
function unlockable(name: UnlockName, have: boolean, what: string, give: () => void): ShopEntry {
  const u = unlockOf(name);
  if (missionsDone() < u.after) return lockedEntry(name);
  const g = shopFor.goods;
  return {
    label: name,
    sub: have ? `You have it · ${what}` : `${u.price} gold · ${what}`,
    disabled: have || g.gold < u.price,
    onClick: () => {
      g.gold -= u.price;
      give();
      bought();
    },
  };
}

/** After buying or selling: a sound, the shop redrawn, and the hero saved. */
function bought(sound = true) {
  if (sound) sfx.checkpoint();
  renderShop();
  saveWeapons();
}

function renderShop() {
  if (!shopKind) return;
  if (shopKind === 'missions') {
    renderMissions();
    return;
  }
  if (shopKind === 'orders') {
    renderOrders();
    return;
  }
  const h = shopFor;
  const g = h.goods;
  const mine = ownedBy(h);
  const stall = FORT.stalls.find((st) => st.kind === shopKind)!;
  const sub = `${twoPlayer ? `${h.name} has` : 'You have'} ${g.gold} gold`;
  const entries: ShopEntry[] = [];
  if (shopKind === 'potions') {
    entries.push({
      label: 'Healing Potion',
      sub: `${POTION_PRICE} gold · heals half your health · you carry ${g.potions} of ${maxPotions(g)}`,
      disabled: g.gold < POTION_PRICE || g.potions >= maxPotions(g),
      onClick: () => {
        g.gold -= POTION_PRICE;
        g.potions++;
        bought();
      },
    });
    entries.push(unlockable('Potion Belt', g.potionBelt, 'Carry 8 potions instead of 5', () => (g.potionBelt = true)));
  } else if (shopKind === 'armory') {
    // Weakest to strongest; armor for higher levels shows one locked teaser at a time.
    const wornHealth = ARMOR[g.armor]?.health ?? 0;
    let teaser = false;
    for (const tier of ARMOR_BY_STRENGTH) {
      const a = ARMOR[tier];
      const wearing = tier === g.armor;
      if (!wearing && tier === GOLDEN_ARMOR && missionsDone() < unlockOf('Golden Armor').after) {
        entries.push(lockedEntry('Golden Armor'));
        continue;
      }
      if (!wearing && a.level && h.level < a.level) {
        if (!teaser) entries.push({ label: a.name, sub: `Locked · unlocks at level ${a.level} · +${a.health} health`, disabled: true, onClick: () => {} });
        teaser = true;
        continue;
      }
      entries.push({
        label: a.name,
        sub: wearing ? 'You are wearing it' : a.health <= wornHealth ? 'You have better armor' : `${a.price} gold · +${a.health} health`,
        disabled: wearing || a.health <= wornHealth || g.gold < a.price,
        onClick: () => {
          g.gold -= a.price;
          g.armor = tier;
          h.refreshStats();
          bought();
        },
      });
    }
    entries.push(
      unlockable('Masked Helmet', g.helmet, `A closed steel helmet with a face mask · +${HELMET_HEALTH} health`, () => {
        g.helmet = true;
        h.refreshStats();
      }),
    );
    entries.push(
      unlockable("Hero's Cape", g.cape, `A red cape · +${CAPE_STAMINA} stamina for more rolls and sprinting`, () => {
        g.cape = true;
        h.refreshStats();
      }),
    );
  } else if (shopKind === 'barracks') {
    const size = armySize(h);
    const full = size >= MAX_ARMY || g.soldiers >= MAX_ARMY - ARMY_SIZE;
    entries.push({
      label: 'Hire a soldier',
      sub: full ? `Your army is full (${size} of ${MAX_ARMY})` : `${SOLDIER_PRICE} gold · army ${size} of ${MAX_ARMY}`,
      disabled: full || g.gold < SOLDIER_PRICE,
      onClick: () => {
        g.gold -= SOLDIER_PRICE;
        g.soldiers++;
        reinforceSquad(); // the new soldier joins right away
        bought();
      },
    });
    entries.push(
      unlockable('Elite Soldiers', g.elite, 'Train your army: much tougher soldiers who hit harder, with gold crests', () => {
        g.elite = true;
        for (const a of allies) if (a.hero === h) a.heal();
      }),
    );
  } else {
    // The weaponsmith: buy (or buy back), trade the weapon in hand, or sell.
    const equipped = h.weapon;
    const forSale = WEAPONS.filter(
      (w) => !mine.has(w.id) && (w.shop || g.pawned.includes(w.id)) && missionsDone() >= (w.unlockAfter ?? 0) && h.level >= (w.unlockLevel ?? 0),
    );
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
    for (const w of WEAPONS) if (w.unlockAfter && missionsDone() < w.unlockAfter && !mine.has(w.id)) entries.push(lockedEntry(w.name as UnlockName));
    // The next weapon a level up brings.
    const nextUp = WEAPONS.filter((w) => w.unlockLevel && w.unlockLevel > h.level && !mine.has(w.id)).sort((a, b) => a.unlockLevel! - b.unlockLevel!)[0];
    if (nextUp) entries.push({ label: nextUp.name, sub: `Locked · unlocks at level ${nextUp.unlockLevel}`, disabled: true, onClick: () => {} });
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

// ---------- Commander Hale's missions (after the war) ----------

let mission: MissionState = loadMission(undefined);

/** Commander Hale, in the fort's courtyard: gleaming armor and a gold cape. Only there once the war is won. */
const commander = createHumanoid({ skin: 0xc68e64, shirt: 0x2a3f8a, pants: 0x2e3442, boots: 0x2a1e16, eyes: 0x222222, belt: 0xd9b24a, armor: 0xe0c060, plume: 0xffffff, sword: true });
addCape(commander, 0xd9b24a);
commander.root.position.set(FORT.commander.x, heightAt(FORT.commander.x, FORT.commander.z), FORT.commander.z);
commander.root.rotation.y = FORT.gateAngle;
commander.armR.rotation.x = -0.3;
commander.root.visible = false;
scene.add(commander.root);
const commanderCollider = { x: FORT.commander.x, z: FORT.commander.z, r: 0.5, active: false };
world.colliders.circles.push(commanderCollider);

function updateCommander() {
  const here = campaign.victorious;
  commander.root.visible = here;
  commanderCollider.active = here;
}

/** A kill in the current mission's lair counts toward it. */
function countForMission(z: Enemy) {
  if (!mission.active || !campaign.victorious) return;
  const m = missionAt(mission.index);
  const lair = campaign.territories.find((t) => t.def.id === m.lair)?.lair.group;
  if (!lair || z.group !== lair) return;
  if (mission.progress >= m.count) return; // already done: just go back to the commander
  mission.progress++;
  if (mission.progress === m.count) {
    sfx.victoryHorn();
    hud.announce('Mission complete!', `Return to ${COMMANDER_NAME} at Fort Victory for ${m.gold} gold`, true);
  }
  saveWeapons(); // progress isn't lost if the game is closed
}

function missionObjective(): Objective | null {
  if (!campaign.victorious || campaign.activeFight) return null;
  const m = missionAt(mission.index);
  const c = FORT.commander;
  const atCommander = new THREE.Vector3(c.x, heightAt(c.x, c.z), c.z);
  if (!mission.active) return { text: `Talk to ${COMMANDER_NAME} at Fort Victory for a mission`, at: atCommander };
  if (mission.progress >= m.count) return { text: `Mission complete · Return to ${COMMANDER_NAME} for ${m.gold} gold`, at: atCommander };
  const lair = campaign.territories.find((t) => t.def.id === m.lair)!.def.arena;
  return { text: `Mission: defeat ${m.foes} in ${m.place} (${mission.progress}/${m.count})`, at: new THREE.Vector3(lair.x, 0, lair.z) };
}

/** What finishing mission `index` unlocks, if anything. */
function nextUnlock(index: number) {
  return UNLOCKS.find((u) => u.after === index + 1)?.name;
}

/** Talking to the commander: take a mission, see how it's going, or claim the gold. */
function renderMissions() {
  const m = missionAt(mission.index);
  const entries: ShopEntry[] = [];
  const job = `Defeat ${m.count} ${m.foes} in ${m.place}`;
  if (!mission.active) {
    entries.push({ heading: `Mission ${m.index + 1}` });
    entries.push({
      label: job,
      sub: `Reward: ${m.gold} gold${twoPlayer ? ' each' : ''}${nextUnlock(m.index) ? ` and unlocks the ${nextUnlock(m.index)}` : ''} · Press to accept`,
      onClick: () => {
        mission = { index: m.index, active: true, progress: 0 };
        sfx.warHorn();
        renderShop();
        saveWeapons();
      },
    });
  } else if (mission.progress < m.count) {
    entries.push({ heading: `Mission ${m.index + 1}` });
    entries.push({
      label: job,
      sub: `${mission.progress} of ${m.count} done · Reward: ${m.gold} gold · Pause → Go to Fort Victory brings you back`,
      disabled: true,
      onClick: () => {},
    });
  } else {
    entries.push({ heading: 'Well done, soldier!' });
    entries.push({
      label: `Claim your reward: ${m.gold} gold${twoPlayer ? ' each' : ''}`,
      sub: job,
      onClick: () => {
        for (const h of activeHeroes()) h.goods.gold += m.gold;
        mission = { index: m.index + 1, active: false, progress: 0 };
        const unlocked = UNLOCKS.find((u) => u.after === mission.index);
        if (unlocked) hud.announce(`New at Fort Victory: ${unlocked.name}`, `Find it at the ${unlocked.shop} in the mansion`, true);
        sfx.levelUp();
        floatText(new THREE.Vector3(shopFor.pos.x, shopFor.pos.y + 2.2, shopFor.pos.z), `+${m.gold} gold`, 'xp');
        renderShop();
        saveWeapons();
      },
    });
  }
  const sub = `${twoPlayer ? `${shopFor.name} has` : 'You have'} ${shopFor.goods.gold} gold`;
  hud.renderShop(COMMANDER_NAME, sub, entries, inputOf(shopFor).mode === 'gamepad');
}

// ---------- A commander's army orders ----------

/** Beating Zomawi makes the heroes Commanders (both, in two-player). */
function isCommander() {
  return campaign.victorious;
}

const ORDERS: { order: ArmyOrder; name: string; what: string }[] = [
  { order: 'follow', name: 'Follow me', what: 'Stay with me and fight whatever comes near' },
  { order: 'hold', name: 'Hold here', what: 'Stand right here and fight anyone who comes close' },
  { order: 'charge', name: 'Charge!', what: 'Go after every enemy in sight' },
  { order: 'guard', name: 'Guard me', what: 'Stick close and only fight enemies right next to me' },
];

/** Each hero's current order to their army. */
const armyOrders = new Map<Player, ArmyOrder>();

/** Gives `hero`'s army an order (holding happens where the hero stands now). */
function orderArmy(hero: Player, order: ArmyOrder) {
  armyOrders.set(hero, order);
  for (const a of allies) {
    if (a.hero !== hero) continue;
    a.order = order;
    a.holdAt.copy(hero.pos);
    a.holdYaw = hero.yaw;
  }
}

/** Back to "follow me" (after teleporting, respawning, or a player joining or leaving). */
function resetOrders() {
  for (const h of [player, player2]) orderArmy(h, 'follow');
}

function renderOrders() {
  const h = shopFor;
  const current = armyOrders.get(h) ?? 'follow';
  const entries: ShopEntry[] = ORDERS.map((o) => ({
    label: o.name,
    sub: o.order === current ? `Current order · ${o.what}` : o.what,
    onClick: () => {
      orderArmy(h, o.order);
      sfx.warHorn();
      hud.announce(o.name, twoPlayer ? `${h.name}'s army: ${o.what.toLowerCase()}` : o.what);
      closeShop();
    },
  }));
  hud.renderShop('Army orders', `Commander ${h.name}, your army awaits`, entries, inputOf(h).mode === 'gamepad');
}

hud.onOrders = () => {
  const h = twoPlayer ? pausedBy : player;
  hud.showPause(false);
  openShop(h, 'orders');
};

// ---------- Duels ----------

/** "Red 2 – 1 Blue": the score with each hero's name. */
function duelScoreText() {
  return `${player.name} ${duelScore[0]} – ${duelScore[1]} ${player2.name}`;
}

/** A hero at their end of the arena, facing the other end, at full strength. */
function toDuelSpawn(h: Player) {
  const s = DUEL_ARENA.spawns[h.team];
  h.reset(s.x, s.z);
  h.yaw = s.yaw;
  const cam = h === player ? camCtrl : camCtrl2;
  cam.yaw = s.yaw;
  cam.pitch = 0.12;
  cam.cut();
}

function waitForDuelist() {
  waitingForP2 = true;
  hud.announce('The Arena', 'Player 2: press A on the second controller to join the duel', true);
}

/** Title → Duel: Player 1's saved hero (with all their gear) walks into the arena and waits for Player 2. */
function enterDuel() {
  initAudio();
  const save = loadSave();
  duel = true;
  duelOver = false;
  duelScore = [0, 0];
  knockedOut.clear();
  hud.fadeIn();
  hud.setDuelMode(true);
  player.loadHero(save?.name ?? 'Player 1', save?.level ?? 1, save?.xp ?? 0);
  loadWeapons(save);
  ctx.difficulty = DUEL_DIFFICULTY;
  ctx.arenaLock = null;
  ctx.peaceful = false;
  ctx.leader = player;
  returnSpot = null;
  hud.setGoBackAvailable(false);
  hud.showShop(false);
  shopKind = null;
  atStall.clear();
  hud.showInventory(false);
  hud.showBoss(null);
  hud.showDeath(false);
  hud.showMap(false);
  hud.showScreen('none');
  projectiles.clear();
  floaters.clear();
  floaters2.clear();
  hitStopTimer = 0;
  deathShown = false;
  phase = 'playing';
  toDuelSpawn(player);
  resetOrders();
  reinforceSquad(true);
  waitForDuelist();
  lockPointer();
}
hud.onDuel = enterDuel;

/** Both heroes ready (or a rematch): everyone back to their own end, 0–0. */
function startDuel(rematch = false) {
  if (rematch) [player.goods.potions, player2.goods.potions] = duelPotions;
  else duelPotions = [player.goods.potions, player2.goods.potions];
  duelScore = [0, 0];
  duelOver = false;
  knockedOut.clear();
  hud.showScreen('none');
  projectiles.clear();
  for (const h of [player, player2]) toDuelSpawn(h);
  resetOrders();
  reinforceSquad(true);
  sfx.warHorn();
  hud.announceNow('Duel!', `${player.name} vs ${player2.name} · First to ${DUEL_TARGET} knockouts wins`, true);
  lockPointer();
}
hud.onRematch = () => startDuel(true);
hud.onLeaveDuel = () => returnToTitle();

/** Scores each knockout, brings fallen heroes (and their soldiers) back, and ends the duel at five. */
function updateDuel() {
  if (!duelLive() || duelOver) return;
  for (const h of [player, player2]) {
    if (h.alive) continue;
    if (!knockedOut.has(h)) {
      knockedOut.add(h);
      const winner = h === player ? player2 : player;
      duelScore[winner.team]++;
      if (duelScore[winner.team] >= DUEL_TARGET) {
        endDuel(winner);
        return;
      }
      sfx.warHorn();
      hud.announceNow(`${winner.name} knocked out ${h.name}!`, duelScoreText(), true);
    } else if (h.stateTime > DUEL_RESPAWN) {
      knockedOut.delete(h);
      toDuelSpawn(h);
      // Their fallen soldiers come back with them.
      const slot = new THREE.Vector3();
      for (const a of h === player ? army1 : army2) {
        if (a.alive || !inService(a)) continue;
        a.slotPosition(ctx, slot);
        a.reinforce(slot.x, slot.z);
      }
      particles.burst(new THREE.Vector3(h.pos.x, h.pos.y + 1, h.pos.z), h.team === 0 ? 0xff5a5a : 0x5a8aff, 24, 5);
      sfx.checkpoint();
    }
  }
}

function endDuel(winner: Player) {
  duelOver = true;
  sfx.victoryHorn();
  hud.showPause(false);
  hud.showInventory(false);
  hud.showShop(false);
  shopKind = null;
  if (document.pointerLockElement) document.exitPointerLock();
  hud.showDuelOver(winner.name, `${duelScoreText()} · First to ${DUEL_TARGET} knockouts`);
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
  if (!duel) ctx.difficulty = DIFFICULTIES[s.difficulty];
  saveSettings(s);
};
input.onLockChange = (locked) => {
  if (!locked) {
    hud.showMap(false);
    pausedBy = player;
    hud.setPauseInventoryLabel(twoPlayer ? `${player.name}'s inventory` : 'Inventory');
  }
  if (duelOver) return; // the duel's Rematch screen is up
  if (twoPlayer && !locked && phase === 'playing' && !hud.optionsOpen && !hud.inventoryOpen && !hud.shopOpen && !hud.outfitOpen && !endingShown) {
    // Player 1 let go of the mouse: their own pause menu, on their half.
    hud.showPause(true, 'left');
    return;
  }
  if (phase === 'playing' && !hud.optionsOpen && !hud.inventoryOpen && !hud.shopOpen && !hud.outfitOpen && !endingShown) hud.showPause(!locked && ctx.players.some((h) => h.alive));
};

/** The war is won: release the mouse and roll the ending. */
function showEnding() {
  if (endingShown || phase !== 'playing') return;
  endingShown = true;
  if (!endingSeen) {
    endingSeen = true;
    saveGame();
  }
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
  // Zomawi's Doomblade and gold come along (no walking back to the fortress for them).
  const doomblade = WEAPONS.find((w) => w.from === 'zomawi')!;
  for (const h of activeHeroes()) {
    if (needsDrop(h, doomblade.id)) claimWeapon(doomblade, h);
    if (needsCoins(h, 'zomawi')) collectCoins('zomawi', h);
  }
  // Straight to Commander Hale at Fort Victory, facing him.
  const meet = FORT.commander.meet;
  teleportTeam(meet.x, meet.z, FORT.gateAngle + Math.PI);
  returnSpot = null;
  hud.setGoBackAvailable(false);
  hud.announce('You are now a Commander!', 'Give your army orders from the pause menu', true);
  hud.announce(COMMANDER_NAME, 'The lairs still stir. Walk up to him for a mission and earn gold');
  lockPointer();
};
/** Back to the title screen (progress since the last checkpoint is dropped; the save stays). */
function returnToTitle() {
  leavePlayer2();
  if (duel) {
    duel = false;
    duelOver = false;
    waitingForP2 = false;
    hud.setDuelMode(false);
    ctx.difficulty = DIFFICULTIES[settings.difficulty];
  }
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
const duelFocus = new THREE.Vector3();
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
  else if (duel) theme = duelLive() && !duelOver ? 'battle' : 'explore';
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
  input.blockClaim = waitingForP2;
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
  menuNav.update(browsing && !deathShown ? [inputOf(browsing)] : inputs);

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
      if (!duel && inputs.some((i) => i !== chooserInput && i.mapPressed)) hud.showMap(!hud.mapOpen);
      if (!hud.inventoryOpen && !hud.p2PickerOpen && !hud.shopOpen && !hud.pauseOpen) {
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
      if (duel) updateDuel();
      else {
        updateRevives();
        updateShopTriggers();
        updateCommander();
      }
      for (const a of allies) a.update(dt, ctx);
      if (!duel) updateEnemies(dt);
      separateBodies();
      if (!duel) campaign.update(dt, ctx);
      projectiles.update(dt, ctx);
      if (!duel) {
        const claimed = drops.update(dt, ctx.players.filter((h) => h.alive), particles, (h, w) => needsDrop(h, w.id));
        if (claimed) claimWeapon(claimed.weapon, claimed.by);
        const scooped = coinPiles.update(dt, activeHeroes().filter((h) => h.alive), particles, needsCoins);
        if (scooped) collectCoins(scooped.id, scooped.by);
      }
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

    if (!duel && ctx.players.every((h) => !h.alive && h.stateTime > 1.6) && !deathShown) {
      deathShown = true;
      hud.showMap(false);
      hud.showPause(false);
      hud.showInventory(false);
      hud.showShop(false);
      shopKind = null;
      if (document.pointerLockElement) document.exitPointerLock();
      hud.showDeath(true);
    }

    if (duel) {
      hud.setObjective(duelLive() ? `Duel · ${duelScoreText()} · First to ${DUEL_TARGET}` : 'Waiting for Player 2 · press A on the second controller');
      hud.views[0].setMarker(null, camera, player.pos);
      hud.views[1].setMarker(null, camera2, player2.pos);
    } else {
      const lead = ctx.leader;
      const objective = weaponObjective() ?? missionObjective() ?? campaign.objective(lead.pos, player.level);
      hud.setObjective(objective.text);
      hud.views[0].setMarker(objective.at, camera, player.pos);
      if (twoPlayer) hud.views[1].setMarker(objective.at, camera2, player2.pos);
      const fight = campaign.activeFight;
      if (fight) hud.setBossHealth(fight.leader.healthFraction);
      if (hud.mapOpen) hud.drawMap(mapData(objective));
    }
  }

  // The sun's shadows cover the whole arena in a duel (centered between the heroes).
  const focus = duel && twoPlayer ? duelFocus.copy(player.pos).add(player2.pos).multiplyScalar(0.5) : ctx.leader.pos;
  world.update(focus, realDt, campaign.gloomAt(focus));
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
  hud.update(duel ? (duelLive() ? duelScoreText() : 'The Arena') : `Enemies slain: ${kills}`);
  hud.setButtonHints(IS_XBOX || twoPlayer || input.mode === 'gamepad');
  const commander = isCommander();
  hud.views[0].update(player, revivingIn(player), commander);
  if (twoPlayer) hud.views[1].update(player2, revivingIn(player2), commander);
  // Anyone can order their army about in a duel.
  hud.setOrdersAvailable((commander || duel) && phase === 'playing');
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
  if (campaign.activeFight) return null;
  const near = drops.nearest(ctx.leader.pos, (w) => activeHeroes().some((h) => needsDrop(h, w.id)));
  if (near) return { text: `Claim ${near.weapon.name}`, at: near.at };
  const pile = coinPiles.nearest(ctx.leader.pos, (id) => activeHeroes().some((h) => needsCoins(h, id)));
  if (!pile) return null;
  const land = TERRITORIES.find((t) => t.leader.id === pile.id);
  return { text: `Collect ${land ? `${land.leader.title.replace(/^The /, 'the ')}'s` : 'the'} gold`, at: pile.at };
}

// ---------- Xbox ----------

const XBOX_TIP = 'Hold the ☰ Menu button for a second to switch the controller to game controls';
let xboxTipTimer = 0;

// Console browsers scroll the page with the right stick; there's nothing to scroll, so ignore it.
// (Menus that are longer than the screen can still be scrolled with the wheel.)
window.addEventListener(
  'wheel',
  (e) => {
    if (!(e.target instanceof Element && e.target.closest('.overlay'))) e.preventDefault();
  },
  { passive: false },
);

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
    enterDuel,
    ctx,
    get duel() {
      return { on: duel, live: duelLive(), over: duelOver, score: duelScore };
    },
    get twoPlayer() {
      return twoPlayer;
    },
    allies,
    enemies,
    campaign,
    projectiles,
    drops,
    coinPiles,
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
