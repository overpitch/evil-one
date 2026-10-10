import * as THREE from 'three';
import type { Player } from './player';
import { PER_LEVEL } from './progression';
import { DIFFICULTIES, type Difficulty, type Graphics, type Settings } from './settings';
import type { SaveData } from './save';
import { drawMap, type MapData } from './map';
import { sfx } from './audio';
import { TERRITORIES } from './layout';
import { WEAPONS, weaponIcon, type WeaponId } from './weapons';
import type { Player2Hero } from './heroes';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const LAST_NAME_KEY = 'evil-one.last-name';
const MAX_NAME_LENGTH = 20;
const ANNOUNCE_TIME = 2700;
const SUBTITLE_TIME = 4500;

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move'],
  ['Mouse / trackpad', 'Look'],
  ['Click or J', 'Attack (keep pressing for a 3-hit combo)'],
  ['Q or K (hold)', 'Block'],
  ['Space', 'Dodge roll'],
  ['Shift', 'Sprint'],
  ['M', 'Map'],
  ['I', 'Inventory (choose your weapon)'],
  ['1 – 5', 'Quick-swap weapon'],
  ['Esc', 'Pause'],
];

/** The same list for an Xbox controller. */
const PAD_CONTROLS: [string, string][] = [
  ['Left stick', 'Move'],
  ['Right stick', 'Look'],
  ['RT or X', 'Attack (keep pressing for a 3-hit combo)'],
  ['LT or LB (hold)', 'Block'],
  ['A', 'Dodge roll'],
  ['B (hold)', 'Sprint'],
  ['View', 'Map'],
  ['Y', 'Inventory (choose your weapon)'],
  ['D-pad left / right', 'Quick-swap weapon'],
  ['Menu', 'Pause'],
];

const RANDOM_NAMES = [
  'Aldric', 'Brenna', 'Cedric', 'Elara', 'Gareth', 'Isolde', 'Rowan',
  'Thorne', 'Wren', 'Osric', 'Maren', 'Bram', 'Sable', 'Tamsin',
];

const DEATH_TIPS = [
  'An enemy glowing orange is about to strike. Block (hold LT, or Q on a keyboard), then hit back.',
  'Blocking costs stamina. When the bar runs low, step back or roll instead.',
  'Shockwaves, meteors and grabs can\'t be blocked. Roll through or away from them.',
  'Leaders pause after their combos. That\'s your moment to attack.',
  'Touch a red banner to heal, save, and replace fallen soldiers.',
  'Stand back and let your soldiers draw attention while your health returns.',
  'Too tough? Easy difficulty in Options makes enemies hit softer, and you can change it any time.',
  'Broom-witches can only be hit when they skim low after a dive.',
  'Vampire knights parry swings from the front. Attack right after they swing.',
];

type Screen = 'title' | 'name' | 'intro' | 'options' | 'ending' | 'none';

/** "the Zombie King", for "Defeat the Zombie King". */
function leaderTitle(id: string) {
  const title = TERRITORIES.find((t) => t.leader.id === id)?.leader.title ?? id;
  return title.replace(/^The /, 'the ');
}

const pips = (n: number) => '●'.repeat(n) + '○'.repeat(5 - n);

export interface EndingStats {
  name: string;
  level: number;
  kills: number;
  playSeconds: number;
  difficulty: string;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

function storageGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Trims and validates a hero name. Returns the clean name or an error message. */
export function cleanName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Your hero needs a name.' };
  if (name.length > MAX_NAME_LENGTH) return { error: `Keep it to ${MAX_NAME_LENGTH} characters or fewer.` };
  if (!/^[\p{L}\p{N}' -]+$/u.test(name)) return { error: 'Use letters, numbers, spaces, hyphens or apostrophes.' };
  return { name };
}

/**
 * One hero's part of the screen: status bars, crosshair, damage numbers,
 * objective marker and hurt glow. The whole screen in one-player, a half in two-player.
 */
export class HeroView {
  readonly floaterLayer: HTMLElement;
  private shownWeapon: WeaponId | null = null;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly projected = new THREE.Vector3();

  constructor(readonly root: HTMLElement) {
    for (const node of root.querySelectorAll<HTMLElement>('[data-s]')) this.el[node.dataset.s!] = node;
    this.floaterLayer = this.el.floaters;
  }

  update(player: Player, revivingIn: number | null) {
    const e = this.el;
    e.name.textContent = player.name;
    e.level.textContent = `Lv ${player.level}`;
    e['hp-fill'].style.width = `${(player.hp / player.maxHp) * 100}%`;
    e['hp-text'].textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
    e['st-fill'].style.width = `${(player.stamina / player.maxStamina) * 100}%`;
    e['st-bar'].classList.toggle('low', player.stamina < 22);
    e['xp-fill'].style.width = player.atMaxLevel ? '100%' : `${(player.xp / player.xpToNext) * 100}%`;
    e['xp-text'].textContent = player.atMaxLevel ? 'Max level' : `${player.xp} / ${player.xpToNext} XP`;
    e.slowed.classList.toggle('hidden', player.slowTimer <= 0);
    // A pulsing red edge when badly hurt.
    const low = player.alive && player.hp / player.maxHp < 0.3 ? 0.3 + 0.2 * Math.sin(performance.now() / 160) : 0;
    e.vignette.style.opacity = String(Math.max(player.hurtFlash, low));
    // Two-player: a fallen hero comes back beside the other one.
    e.down.classList.toggle('hidden', revivingIn === null);
    if (revivingIn !== null) {
      const text = `You have fallen · back in ${Math.max(1, Math.ceil(revivingIn))}`;
      if (e.down.textContent !== text) e.down.textContent = text;
    }
    if (this.shownWeapon !== player.weapon.id) {
      this.shownWeapon = player.weapon.id;
      e['weapon-icon'].innerHTML = weaponIcon(player.weapon);
      e['weapon-name'].textContent = player.weapon.name;
    }
  }

  /** What to do next, in the bottom-right corner of this view. */
  setObjective(text: string) {
    if (this.el.objective.textContent !== text) this.el.objective.textContent = text;
  }

  /** A marker over the objective, pinned to the edge of this view when it's off-screen. */
  setMarker(at: THREE.Vector3 | null, camera: THREE.Camera, from: THREE.Vector3) {
    const marker = this.el.marker;
    const dist = at ? Math.hypot(at.x - from.x, at.z - from.z) : 0;
    if (!at || dist < 8) {
      marker.classList.add('hidden');
      return;
    }
    marker.classList.remove('hidden');
    this.el['marker-dist'].textContent = `${Math.round(dist)} m`;

    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const p = this.projected.set(at.x, at.y + 4, at.z).project(camera);
    const behind = p.z > 1;
    let dx = p.x * (behind ? -1 : 1) * (w / 2);
    let dy = -p.y * (behind ? -1 : 1) * (h / 2);
    const margin = 48;
    const limitX = w / 2 - margin;
    const limitY = h / 2 - margin;
    if (behind || Math.abs(dx) > limitX || Math.abs(dy) > limitY) {
      if (behind && dy < 0) dy = Math.abs(dy) + 1; // behind you: pin to the bottom
      const scale = Math.min(limitX / Math.max(Math.abs(dx), 1e-3), limitY / Math.max(Math.abs(dy), 1e-3));
      dx *= scale;
      dy *= scale;
    }
    marker.style.transform = `translate(${w / 2 + dx}px, ${h / 2 + dy}px) translate(-50%, -50%)`;
  }
}

/** DOM overlay: status bars, messages, objective marker, map, and every menu screen. */
export class Hud {
  onContinue?: () => void;
  onNewGame?: () => void;
  onNameChosen?: (name: string) => void;
  onBegin?: () => void;
  onResume?: () => void;
  onRespawn?: () => void;
  onSettings?: (settings: Settings) => void;
  onKeepExploring?: () => void;
  onQuitToTitle?: () => void;
  onEndingTitle?: () => void;
  onInventory?: () => void;
  onInventoryClose?: () => void;
  onEquip?: (id: WeaponId) => void;
  onTogglePlayer2?: () => void;
  /** Player 2 picked a saved hero (by id), named a new one, or backed out. */
  onP2Pick?: (id: string) => void;
  onP2New?: (name: string) => void;
  onP2Cancel?: () => void;

  /** Player 1's view, then Player 2's. */
  readonly views: [HeroView, HeroView];

  private readonly hud = $('hud');
  private readonly kills = $('kills');
  private readonly boss = $('boss');
  private readonly bossName = $('boss-name');
  private readonly bossFill = $('boss-fill');
  private readonly announceEl = $('announce');
  private readonly subtitle = $('subtitle-line');
  private readonly screens: Record<Exclude<Screen, 'none'>, HTMLElement> = {
    title: $('title-screen'),
    name: $('name-screen'),
    intro: $('intro-screen'),
    options: $('options-screen'),
    ending: $('ending-screen'),
  };
  private readonly pause = $('pause-screen');
  private readonly death = $('death-screen');
  private readonly mapScreen = $('map-screen');
  private readonly mapCanvas = $<HTMLCanvasElement>('map-canvas');
  private readonly nameInput = $<HTMLInputElement>('name-input');
  private readonly nameError = $('name-error');
  private readonly inventory = $('inventory-screen');
  private readonly weaponCards = new Map<WeaponId, HTMLButtonElement>();

  private settings: Settings;
  /** Where the Options screen's Back button returns to. */
  private optionsReturn: 'title' | 'pause' = 'title';
  private announceQueue: { title: string; detail: string; gold: boolean }[] = [];
  private announcing = false;
  private subtitleTimer = 0;
  private hasSave = false;

  constructor(settings: Settings) {
    this.settings = { ...settings };
    const view1 = $('view1');
    const view2 = $('view2');
    view2.replaceChildren(...[...view1.children].map((c) => c.cloneNode(true)));
    this.views = [new HeroView(view1), new HeroView(view2)];
    // Two versions of each controls list: keyboard, and Xbox controller (shown while one is in use).
    for (const dl of document.querySelectorAll('[data-controls]')) {
      for (const [list, only] of [[CONTROLS, 'keys-only'], [PAD_CONTROLS, 'pad-only']] as const) {
        for (const [keys, action] of list) {
          const dt = Object.assign(document.createElement('dt'), { textContent: keys, className: only });
          const dd = Object.assign(document.createElement('dd'), { textContent: action, className: only });
          dl.append(dt, dd);
        }
      }
      const pad = document.createElement('p');
      pad.className = 'pad-controls keys-only';
      pad.textContent =
        'Controller: left stick move · right stick look · RT or X attack · LT or LB block · A roll · B sprint · Y inventory · D-pad left/right swap weapon · View map · Menu pause';
      dl.after(pad);
    }

    // Title
    $('continue-btn').addEventListener('click', () => this.onContinue?.());
    $('new-game-btn').addEventListener('click', () => {
      if (this.hasSave) this.showConfirm(true);
      else this.onNewGame?.();
    });
    $('confirm-yes-btn').addEventListener('click', () => {
      this.showConfirm(false);
      this.onNewGame?.();
    });
    $('confirm-no-btn').addEventListener('click', () => this.showConfirm(false));
    $('title-options-btn').addEventListener('click', () => this.openOptions('title'));

    // Naming
    $('random-name-btn').addEventListener('click', () => {
      const options = RANDOM_NAMES.filter((n) => n !== this.nameInput.value);
      this.nameInput.value = options[Math.floor(Math.random() * options.length)];
      this.nameError.textContent = '';
      this.nameInput.focus();
    });
    this.nameInput.addEventListener('input', () => (this.nameError.textContent = ''));
    $('name-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const result = cleanName(this.nameInput.value);
      if ('error' in result) {
        this.nameError.textContent = result.error;
        this.nameInput.focus();
        return;
      }
      storageSet(LAST_NAME_KEY, result.name);
      this.onNameChosen?.(result.name);
    });
    $('begin-btn').addEventListener('click', () => this.onBegin?.());
    $('keep-exploring-btn').addEventListener('click', () => this.onKeepExploring?.());
    $('quit-btn').addEventListener('click', () => this.onQuitToTitle?.());
    // The controller test page (same site, so no address to type on a console).
    $('controller-test-btn').addEventListener('click', () => location.assign('./?padtest'));
    // Every menu button clicks.
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, .segmented label, .toggle')) sfx.click();
    });

    // Embers drifting up behind the title.
    const embers = $('embers');
    for (let i = 0; i < 36; i++) {
      const ember = document.createElement('span');
      ember.style.left = `${Math.random() * 100}%`;
      ember.style.animationDelay = `${-Math.random() * 12}s`;
      ember.style.animationDuration = `${8 + Math.random() * 8}s`;
      ember.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
      ember.style.setProperty('--size', `${2 + Math.random() * 3}px`);
      embers.append(ember);
    }
    $('ending-title-btn').addEventListener('click', () => this.onEndingTitle?.());

    // Pause, death
    $('resume-btn').addEventListener('click', () => this.onResume?.());
    $('pause-options-btn').addEventListener('click', () => this.openOptions('pause'));
    this.pause.addEventListener('click', (e) => {
      if (e.target === this.pause) this.onResume?.();
    });
    $('respawn-btn').addEventListener('click', () => this.onRespawn?.());

    // Inventory: one card per weapon, built once and updated in place (so controller focus stays put).
    $('pause-inventory-btn').addEventListener('click', () => this.onInventory?.());
    $('pause-p2-btn').addEventListener('click', () => this.onTogglePlayer2?.());

    // Who is Player 2?
    const p2Name = $<HTMLInputElement>('p2-name-input');
    const p2Error = $('p2-name-error');
    $('p2-new-btn').addEventListener('click', () => {
      $('p2-pick').classList.add('hidden');
      $('p2-new').classList.remove('hidden');
      p2Name.value = '';
      p2Error.textContent = '';
    });
    $('p2-back-btn').addEventListener('click', () => {
      $('p2-new').classList.add('hidden');
      $('p2-pick').classList.remove('hidden');
    });
    $('p2-cancel-btn').addEventListener('click', () => this.onP2Cancel?.());
    $('p2-random-btn').addEventListener('click', () => {
      const options = RANDOM_NAMES.filter((n) => n !== p2Name.value);
      p2Name.value = options[Math.floor(Math.random() * options.length)];
      p2Error.textContent = '';
    });
    p2Name.addEventListener('input', () => (p2Error.textContent = ''));
    $('p2-new').addEventListener('submit', (e) => {
      e.preventDefault();
      const result = cleanName(p2Name.value);
      if ('error' in result) {
        p2Error.textContent = result.error;
        return;
      }
      p2Name.blur();
      this.onP2New?.(result.name);
    });
    $('inventory-close-btn').addEventListener('click', () => this.onInventoryClose?.());
    const grid = $('weapon-grid');
    WEAPONS.forEach((w, i) => {
      const card = document.createElement('button');
      card.className = 'weapon-card';
      card.style.setProperty('--accent', `#${w.color.toString(16).padStart(6, '0')}`);
      card.innerHTML = `
        <span class="weapon-slot">${i + 1}</span>
        <span class="weapon-icon">${weaponIcon(w)}</span>
        <span class="weapon-name"></span>
        <span class="weapon-from"></span>
        <span class="weapon-stats">
          <span>Damage</span><span class="pips">${pips(w.pips.damage)}</span>
          <span>Speed</span><span class="pips">${pips(w.pips.speed)}</span>
          <span>Reach</span><span class="pips">${pips(w.pips.reach)}</span>
        </span>
        <span class="weapon-desc"></span>
        <span class="weapon-badge">Equipped</span>`;
      card.addEventListener('click', () => {
        if (card.classList.contains('locked')) return;
        this.onEquip?.(w.id);
      });
      grid.append(card);
      this.weaponCards.set(w.id, card);
    });

    // Options
    const sens = $<HTMLInputElement>('sens');
    const sensValue = $<HTMLOutputElement>('sens-value');
    const invert = $<HTMLInputElement>('invert-y');
    const invertValue = $<HTMLOutputElement>('invert-value');
    const difficultyRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="difficulty"]')];
    const graphicsRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="graphics"]')];
    const difficultyNote = $('difficulty-note');
    const volumeSliders: [HTMLInputElement, HTMLOutputElement, 'musicVolume' | 'sfxVolume'][] = [
      [$<HTMLInputElement>('music-volume'), $<HTMLOutputElement>('music-volume-value'), 'musicVolume'],
      [$<HTMLInputElement>('sfx-volume'), $<HTMLOutputElement>('sfx-volume-value'), 'sfxVolume'],
    ];
    const render = () => {
      for (const [slider, out, key] of volumeSliders) {
        slider.value = String(this.settings[key]);
        out.value = `${Math.round(this.settings[key] * 100)}%`;
      }
      for (const r of difficultyRadios) r.checked = r.value === this.settings.difficulty;
      for (const r of graphicsRadios) r.checked = r.value === this.settings.graphics;
      difficultyNote.textContent = DIFFICULTIES[this.settings.difficulty].description;
      sens.value = String(this.settings.sensitivity);
      sensValue.value = this.settings.sensitivity.toFixed(1);
      invert.checked = this.settings.invertY;
      invertValue.value = this.settings.invertY ? 'On' : 'Off';
    };
    sens.addEventListener('input', () => {
      this.settings.sensitivity = Number(sens.value);
      render();
      this.onSettings?.({ ...this.settings });
    });
    invert.addEventListener('change', () => {
      this.settings.invertY = invert.checked;
      render();
      this.onSettings?.({ ...this.settings });
    });
    for (const [slider, , key] of volumeSliders) {
      slider.addEventListener('input', () => {
        this.settings[key] = Number(slider.value);
        render();
        this.onSettings?.({ ...this.settings });
      });
    }
    for (const r of graphicsRadios) {
      r.addEventListener('change', () => {
        this.settings.graphics = r.value as Graphics;
        render();
        this.onSettings?.({ ...this.settings });
      });
    }
    for (const r of difficultyRadios) {
      r.addEventListener('change', () => {
        this.settings.difficulty = r.value as Difficulty;
        render();
        this.onSettings?.({ ...this.settings });
      });
    }
    render();
    $('options-back-btn').addEventListener('click', () => {
      if (this.optionsReturn === 'pause') {
        this.showScreen('none');
        this.showPause(true);
      } else {
        this.showScreen('title');
      }
    });
  }

  /** Shows one menu screen (or none) and hides the rest. */
  showScreen(screen: Screen) {
    for (const [name, el] of Object.entries(this.screens)) el.classList.toggle('hidden', name !== screen);
    const inMenus =
      screen === 'title' || screen === 'name' || screen === 'intro' || screen === 'ending' || (screen === 'options' && this.optionsReturn === 'title');
    this.hud.classList.toggle('hidden', inMenus);
    if (screen === 'name') {
      this.nameInput.value = storageGet(LAST_NAME_KEY) ?? '';
      this.nameError.textContent = '';
      // Focus after the click that opened the screen has finished.
      setTimeout(() => {
        this.nameInput.focus();
        this.nameInput.select();
      });
    }
  }

  /** The title screen, with a Continue button when there's a saved hero. */
  showTitle(save: SaveData | null) {
    this.hasSave = save !== null;
    $('continue-btn').classList.toggle('hidden', !save);
    if (save) $('continue-sub').textContent = `${save.name} · Level ${save.level}${save.leaders.includes('zomawi') ? ' · Victorious' : ''}`;
    $('confirm-text').textContent = save
      ? `Start a new game? Your saved hero, ${save.name} (Level ${save.level}), will be erased.`
      : '';
    this.showConfirm(false);
    this.showScreen('title');
  }

  private showConfirm(show: boolean) {
    $('confirm').classList.toggle('hidden', !show);
    $('title-menu').classList.toggle('hidden', show);
  }

  private openOptions(from: 'title' | 'pause') {
    this.optionsReturn = from;
    this.showPause(false);
    this.showScreen('options');
  }

  get inventoryOpen() {
    return !this.inventory.classList.contains('hidden');
  }

  /** `side`: two-player, the inventory covers only that hero's half of the screen. */
  showInventory(show: boolean, side: 'left' | 'right' | null = null) {
    this.inventory.classList.toggle('hidden', !show);
    this.inventory.classList.toggle('side-left', side === 'left');
    this.inventory.classList.toggle('side-right', side === 'right');
  }

  /** Fills in the inventory cards: what's owned, what's still to win, and what's in hand. */
  renderInventory(owned: ReadonlySet<WeaponId>, equipped: WeaponId, usingPad: boolean, chooser?: string) {
    this.inventory.querySelector('.subtitle')!.textContent = chooser
      ? `Choosing ${chooser}'s weapon. Each leader you defeat drops a new one.`
      : 'Choose your weapon. Each leader you defeat drops a new one.';
    for (const w of WEAPONS) {
      const card = this.weaponCards.get(w.id)!;
      const have = owned.has(w.id);
      card.classList.toggle('locked', !have);
      card.classList.toggle('equipped', w.id === equipped);
      card.querySelector('.weapon-name')!.textContent = have ? w.name : '???';
      card.querySelector('.weapon-from')!.textContent = !w.from
        ? 'Your own blade'
        : have
          ? `Won from ${leaderTitle(w.from)}`
          : `Defeat ${leaderTitle(w.from)} to claim it`;
      card.querySelector('.weapon-desc')!.textContent = have ? w.description : '';
    }
    $('inventory-hint').textContent = usingPad
      ? 'A · Equip    B or Y · Back to battle    In battle, the d-pad left/right swaps weapons'
      : 'Click a weapon to equip it    I or Esc · Back to battle    In battle, keys 1–5 swap weapons';
  }

  get p2PickerOpen() {
    return !$('p2-screen').classList.contains('hidden');
  }

  /** The "Who is Player 2?" list on the right half: saved heroes, newest first. */
  showP2Picker(heroes: Player2Hero[] | null) {
    $('p2-screen').classList.toggle('hidden', heroes === null);
    if (!heroes) return;
    $('p2-new').classList.add('hidden');
    $('p2-pick').classList.remove('hidden');
    const list = $('p2-list');
    list.replaceChildren(
      ...heroes.map((h) => {
        const b = document.createElement('button');
        b.className = 'p2-hero';
        b.append(h.name, Object.assign(document.createElement('span'), { className: 'button-sub', textContent: `Level ${h.level} · ${h.weapons.length} ${h.weapons.length === 1 ? 'weapon' : 'weapons'}` }));
        b.addEventListener('click', () => this.onP2Pick?.(h.id));
        return b;
      }),
    );
    // No saved heroes yet: straight to naming one.
    if (heroes.length === 0) $('p2-new-btn').click();
  }

  /** Button hints match what's being played with: Xbox buttons for a controller, keys for a keyboard. */
  setButtonHints(controller: boolean) {
    document.body.classList.toggle('pad-mode', controller);
    const hint = controller ? 'View · Map \u00a0 Y · Inventory' : 'M · Map \u00a0 I · Inventory';
    const el = $('hud-hint');
    if (el.textContent !== hint) {
      el.textContent = hint;
      this.mapScreen.querySelector('.map-hint')!.textContent = controller ? 'View · Close map' : 'M · Close map';
    }
  }

  setPauseInventoryLabel(label: string) {
    $('pause-inventory-btn').textContent = label;
  }

  /** Splits the screen into two views (two-player) or one. */
  setSplit(on: boolean) {
    this.hud.classList.toggle('split', on);
    $('view2').classList.toggle('hidden', !on);
    $('split-line').classList.toggle('hidden', !on);
    $('pause-p2-btn').textContent = on ? 'Remove Player 2' : 'Add Player 2';
  }

  setPadDebug(text: string) {
    const el = $('pad-debug');
    const line = `Controller check: ${text}`;
    if (el.textContent !== line) el.textContent = line;
  }

  get pauseOpen() {
    return !this.pause.classList.contains('hidden');
  }

  get optionsOpen() {
    return !this.screens.options.classList.contains('hidden');
  }

  /** Writes the intro story with the hero's name, lines fading in one by one. */
  showIntro(heroName: string) {
    const story = $('story');
    story.replaceChildren();
    const hero = () => Object.assign(document.createElement('span'), { className: 'hero', textContent: heroName });
    const villain = () => Object.assign(document.createElement('span'), { className: 'villain', textContent: 'Zomawi' });
    const lines: (string | HTMLElement)[][] = [
      ['For a hundred years, the human kingdoms knew peace.'],
      ['Then came ', villain(), ': born human, raised from the grave as a zombie, crowned by witches. Part of all three, and master of them all.'],
      ['Now three armies march under its banner: the zombie horde, the witch covens, and the vampire lords.'],
      ['The human army rides out to meet them. Among its soldiers stands ', hero(), '.'],
      ['To the north lie the Zombie Lands. Take back their outposts, then face the Zombie King.'],
    ];
    lines.forEach((parts, i) => {
      const p = document.createElement('p');
      p.append(...parts);
      p.style.animationDelay = `${0.3 + i * 1.1}s`;
      story.append(p);
    });
    const after = `${0.3 + lines.length * 1.1}s`;
    const screen = this.screens.intro;
    (screen.querySelector('.controls') as HTMLElement).style.animationDelay = after;
    $('begin-btn').style.animationDelay = after;
    // Restart the CSS animations if the intro is shown again.
    for (const el of screen.querySelectorAll<HTMLElement>('.controls, #begin-btn')) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }
    this.showScreen('intro');
  }

  /** The victory screen: the story's end, with the hero's name, and their stats. */
  showEnding(stats: EndingStats) {
    const story = $('ending-story');
    story.replaceChildren();
    const hero = () => Object.assign(document.createElement('span'), { className: 'hero', textContent: stats.name });
    const lines: (string | HTMLElement)[][] = [
      ['Zomawi falls, and with it the dark magic that bound the three armies.'],
      ['In the Zombie Lands the dead lie still. The witch fires gutter out. The vampire lords flee the dawn.'],
      ['They say Zomawi was a general of the human army, long ago. Today, at last, the general rests.'],
      ['The army marches home with ', hero(), ' at its head.'],
      ['Songs will be sung of the soldier who broke the Evil One.'],
    ];
    lines.forEach((parts, i) => {
      const p = document.createElement('p');
      p.append(...parts);
      p.style.animationDelay = `${0.5 + i * 1.3}s`;
      story.append(p);
    });
    const dl = $('ending-stats');
    dl.replaceChildren();
    const rows: [string, string][] = [
      ['Hero', stats.name],
      ['Level', String(stats.level)],
      ['Enemies slain', String(stats.kills)],
      ['Time played', formatTime(stats.playSeconds)],
      ['Difficulty', stats.difficulty],
    ];
    for (const [k, v] of rows) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
    }
    const after = `${0.5 + lines.length * 1.3}s`;
    for (const el of [dl, this.screens.ending.querySelector('.ending-buttons') as HTMLElement]) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      el.style.animationDelay = after;
    }
    this.showScreen('ending');
  }

  /** Fades in from black (entering the world). */
  fadeIn() {
    const fade = $('fade');
    fade.style.transition = 'none';
    fade.style.opacity = '1';
    void fade.offsetWidth;
    fade.style.transition = '';
    fade.style.opacity = '0';
  }

  /** `side`: two-player, the pause menu covers only that hero's half of the screen. */
  showPause(show: boolean, side: 'left' | 'right' | null = null) {
    this.pause.classList.toggle('hidden', !show);
    if (!show) return;
    this.pause.classList.toggle('side-left', side === 'left');
    this.pause.classList.toggle('side-right', side === 'right');
  }

  private tipIndex = Math.floor(Math.random() * DEATH_TIPS.length);

  showDeath(show: boolean) {
    if (show) {
      this.tipIndex = (this.tipIndex + 1) % DEATH_TIPS.length;
      $('death-tip').textContent = `Tip: ${DEATH_TIPS[this.tipIndex]}`;
    }
    this.death.classList.toggle('hidden', !show);
  }

  // ---------- Messages ----------

  /** Big centered message. Messages queue so they never overlap. */
  announce(title: string, detail: string, gold = false) {
    this.announceQueue.push({ title, detail, gold });
    if (!this.announcing) this.nextAnnouncement();
  }

  private nextAnnouncement() {
    const next = this.announceQueue.shift();
    if (!next) {
      this.announcing = false;
      return;
    }
    this.announcing = true;
    $('announce-title').textContent = next.title;
    $('announce-detail').textContent = next.detail;
    this.announceEl.classList.toggle('gold', next.gold);
    this.announceEl.classList.remove('show');
    void this.announceEl.offsetWidth; // restart the animation
    this.announceEl.classList.add('show');
    setTimeout(() => this.nextAnnouncement(), ANNOUNCE_TIME);
  }

  showLevelUp(level: number, heroName?: string) {
    this.announce(
      heroName ? `${heroName} · Level Up` : 'Level Up',
      `Level ${level} · Health +${PER_LEVEL.hp} · Stamina +${PER_LEVEL.stamina} · Damage +${Math.round(PER_LEVEL.damage * 100)}%`,
      true,
    );
  }

  /** A line of dialogue at the bottom of the screen. */
  say(speaker: string, line: string) {
    $('speaker').textContent = speaker;
    $('line').textContent = line;
    this.subtitle.classList.add('show');
    clearTimeout(this.subtitleTimer);
    this.subtitleTimer = window.setTimeout(() => this.subtitle.classList.remove('show'), SUBTITLE_TIME);
  }

  showBoss(name: string | null) {
    this.boss.classList.toggle('hidden', name === null);
    if (name) this.bossName.textContent = name;
  }

  setBossHealth(fraction: number) {
    this.bossFill.style.width = `${Math.max(0, fraction) * 100}%`;
  }

  // ---------- Objective ----------

  /** What to do next, in each hero's view. */
  setObjective(text: string) {
    for (const v of this.views) v.setObjective(text);
  }

  // ---------- Map ----------

  get mapOpen() {
    return !this.mapScreen.classList.contains('hidden');
  }

  showMap(show: boolean) {
    this.mapScreen.classList.toggle('hidden', !show);
  }

  drawMap(data: MapData) {
    drawMap(this.mapCanvas, data);
  }

  // ---------- Status ----------

  update(kills: number) {
    this.kills.textContent = `Enemies slain: ${kills}`;
  }
}
