import type { Player } from './player';
import { PER_LEVEL } from './progression';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SENSITIVITY_KEY = 'evil-one.sensitivity';
const LAST_NAME_KEY = 'evil-one.last-name';
const MAX_NAME_LENGTH = 20;

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move'],
  ['Mouse / trackpad', 'Look'],
  ['Click or J', 'Attack (keep pressing for a 3-hit combo)'],
  ['Q or K (hold)', 'Block'],
  ['Space', 'Dodge roll'],
  ['Shift', 'Sprint'],
  ['Esc', 'Pause'],
];

const RANDOM_NAMES = [
  'Aldric', 'Brenna', 'Cedric', 'Elara', 'Gareth', 'Isolde', 'Rowan',
  'Thorne', 'Wren', 'Osric', 'Maren', 'Bram', 'Sable', 'Tamsin',
];

type Screen = 'title' | 'name' | 'intro' | 'none';

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

/** DOM overlay: status bars, floating text layer, and every menu screen. */
export class Hud {
  onNewGame?: () => void;
  onNameChosen?: (name: string) => void;
  onBegin?: () => void;
  onResume?: () => void;
  onRespawn?: () => void;
  onSensitivity?: (value: number) => void;
  sensitivity = 1;

  readonly floaterLayer = $('floaters');

  private readonly hud = $('hud');
  private readonly heroName = $('hero-name');
  private readonly levelBadge = $('level-badge');
  private readonly hpFill = $('hp-fill');
  private readonly hpText = $('hp-text');
  private readonly stFill = $('st-fill');
  private readonly stBar = $('st-bar');
  private readonly xpFill = $('xp-fill');
  private readonly xpText = $('xp-text');
  private readonly kills = $('kills');
  private readonly vignette = $('vignette');
  private readonly levelUp = $('level-up');
  private readonly levelUpDetail = $('level-up-detail');
  private readonly screens: Record<Exclude<Screen, 'none'>, HTMLElement> = {
    title: $('title-screen'),
    name: $('name-screen'),
    intro: $('intro-screen'),
  };
  private readonly pause = $('pause-screen');
  private readonly death = $('death-screen');
  private readonly nameInput = $<HTMLInputElement>('name-input');
  private readonly nameError = $('name-error');

  constructor() {
    for (const dl of document.querySelectorAll('[data-controls]')) {
      for (const [keys, action] of CONTROLS) {
        const dt = document.createElement('dt');
        dt.textContent = keys;
        const dd = document.createElement('dd');
        dd.textContent = action;
        dl.append(dt, dd);
      }
    }

    $('new-game-btn').addEventListener('click', () => this.onNewGame?.());
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
    $('resume-btn').addEventListener('click', () => this.onResume?.());
    this.pause.addEventListener('click', (e) => {
      if (e.target === this.pause) this.onResume?.();
    });
    $('respawn-btn').addEventListener('click', () => this.onRespawn?.());

    const slider = $<HTMLInputElement>('sens');
    const output = $<HTMLOutputElement>('sens-value');
    const saved = Number(storageGet(SENSITIVITY_KEY));
    if (saved > 0) slider.value = String(saved);
    const apply = () => {
      this.sensitivity = Number(slider.value);
      output.value = this.sensitivity.toFixed(1);
      this.onSensitivity?.(this.sensitivity);
    };
    slider.addEventListener('input', () => {
      apply();
      storageSet(SENSITIVITY_KEY, slider.value);
    });
    apply();
  }

  /** Shows one menu screen (or none) and hides the rest. */
  showScreen(screen: Screen) {
    for (const [name, el] of Object.entries(this.screens)) el.classList.toggle('hidden', name !== screen);
    this.hud.classList.toggle('hidden', screen !== 'none');
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
      ['The first zombies are already at the training grounds. Draw your sword.'],
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

  showPause(show: boolean) {
    this.pause.classList.toggle('hidden', !show);
  }

  showDeath(show: boolean) {
    this.death.classList.toggle('hidden', !show);
  }

  showLevelUp(level: number) {
    this.levelUpDetail.textContent =
      `Level ${level} · Health +${PER_LEVEL.hp} · Stamina +${PER_LEVEL.stamina} · Damage +${Math.round(PER_LEVEL.damage * 100)}%`;
    this.levelUp.classList.remove('show');
    void this.levelUp.offsetWidth; // restart the animation
    this.levelUp.classList.add('show');
  }

  update(player: Player, kills: number) {
    this.heroName.textContent = player.name;
    this.levelBadge.textContent = `Lv ${player.level}`;
    this.hpFill.style.width = `${(player.hp / player.maxHp) * 100}%`;
    this.hpText.textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
    this.stFill.style.width = `${(player.stamina / player.maxStamina) * 100}%`;
    this.stBar.classList.toggle('low', player.stamina < 22);
    this.xpFill.style.width = player.atMaxLevel ? '100%' : `${(player.xp / player.xpToNext) * 100}%`;
    this.xpText.textContent = player.atMaxLevel ? 'Max level' : `${player.xp} / ${player.xpToNext} XP`;
    this.kills.textContent = `Zombies slain: ${kills}`;
    this.vignette.style.opacity = String(player.hurtFlash);
  }
}
