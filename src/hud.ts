import type { Player } from './player';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SENSITIVITY_KEY = 'evil-one.sensitivity';

/** DOM overlay: health/stamina bars, kill counter, pause and death screens. */
export class Hud {
  onPlay?: () => void;
  onRespawn?: () => void;
  onSensitivity?: (value: number) => void;
  sensitivity = 1;

  private readonly hpFill = $('hp-fill');
  private readonly hpText = $('hp-text');
  private readonly stFill = $('st-fill');
  private readonly stBar = $('st-bar');
  private readonly kills = $('kills');
  private readonly vignette = $('vignette');
  private readonly pause = $('overlay');
  private readonly death = $('death');

  constructor() {
    $('play-btn').addEventListener('click', () => this.onPlay?.());
    this.pause.addEventListener('click', (e) => {
      if (e.target === this.pause) this.onPlay?.();
    });
    $('respawn-btn').addEventListener('click', () => this.onRespawn?.());

    const slider = $<HTMLInputElement>('sens');
    const output = $<HTMLOutputElement>('sens-value');
    try {
      const saved = Number(localStorage.getItem(SENSITIVITY_KEY));
      if (saved > 0) slider.value = String(saved);
    } catch {
      /* storage unavailable */
    }
    const apply = () => {
      this.sensitivity = Number(slider.value);
      output.value = this.sensitivity.toFixed(1);
      this.onSensitivity?.(this.sensitivity);
    };
    slider.addEventListener('input', () => {
      apply();
      try {
        localStorage.setItem(SENSITIVITY_KEY, slider.value);
      } catch {
        /* storage unavailable */
      }
    });
    apply();
  }

  showPause(show: boolean) {
    this.pause.classList.toggle('hidden', !show);
  }

  showDeath(show: boolean) {
    this.death.classList.toggle('hidden', !show);
  }

  update(player: Player, kills: number) {
    this.hpFill.style.width = `${(player.hp / player.maxHp) * 100}%`;
    this.hpText.textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
    this.stFill.style.width = `${(player.stamina / player.maxStamina) * 100}%`;
    this.stBar.classList.toggle('low', player.stamina < 22);
    this.kills.textContent = `Zombies slain: ${kills}`;
    this.vignette.style.opacity = String(player.hurtFlash);
  }
}
