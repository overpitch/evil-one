import type { Input } from './input';

/** Menu screens, topmost first: the first visible one gets controller focus. */
const SCREENS = ['ending-screen', 'death-screen', 'options-screen', 'inventory-screen', 'pause-screen', 'name-screen', 'intro-screen', 'title-screen'];

/** What the B button does on each screen. */
const BACK_BUTTONS: Record<string, string[]> = {
  'options-screen': ['options-back-btn'],
  'inventory-screen': ['inventory-close-btn'],
  'pause-screen': ['resume-btn'],
  'title-screen': ['confirm-no-btn'],
};

const FOCUS_CLASS = 'pad-focus';

/** Rendered on screen (fixed-position overlays have no offsetParent, so measure instead). */
function visible(el: HTMLElement) {
  return el.getClientRects().length > 0 && !el.closest('.hidden');
}

/**
 * Lets a controller drive the HTML menus: d-pad or left stick moves a
 * highlight between controls, A presses, B goes back, and left/right
 * adjusts sliders and the difficulty switch.
 */
export class MenuNavigator {
  private focused: HTMLElement | null = null;

  /** True when a menu screen is up (so the game shouldn't take controller input). */
  get menuOpen() {
    return SCREENS.some((id) => visible(document.getElementById(id)!));
  }

  update(input: Input) {
    // Pointing with a cursor (mouse, or Edge on Xbox in browser mode): clicks do the work.
    if (input.mode !== 'gamepad' || input.cursorActive) {
      this.setFocus(null);
      return;
    }
    const screen = SCREENS.map((id) => document.getElementById(id)!).find(visible);
    if (!screen) {
      this.setFocus(null);
      return;
    }
    // Each control is a button, a slider, a checkbox, the name field, or a whole segmented switch.
    const items = [...screen.querySelectorAll<HTMLElement>('button, input[type="range"], input[type="checkbox"], input[type="text"], input:not([type]), .segmented')].filter(
      (el) => visible(el) && !el.closest('.segmented:not(:scope)') && getComputedStyle(el).opacity !== '0',
    );
    if (items.length === 0) {
      this.setFocus(null); // e.g. buttons still fading in
      return;
    }
    if (!this.focused || !items.includes(this.focused)) {
      // A new screen (or the first controller input): just show where the highlight starts.
      this.setFocus(items[0]);
      return;
    }
    const current = this.focused;
    const index = items.indexOf(current);

    switch (input.nav) {
      case 'up':
        this.setFocus(items[(index - 1 + items.length) % items.length]);
        break;
      case 'down':
        this.setFocus(items[(index + 1) % items.length]);
        break;
      case 'left':
      case 'right':
        this.adjust(current, input.nav === 'right' ? 1 : -1, items);
        break;
    }

    if (input.confirmPressed) {
      if (current instanceof HTMLInputElement && (current.type === 'text' || !current.type)) current.focus();
      else current.click();
    } else if (input.backPressed) {
      const back = (BACK_BUTTONS[screen.id] ?? []).map((id) => document.getElementById(id)).find((el) => el && visible(el));
      back?.click();
    }
  }

  /** Left/right: nudge sliders, switch segmented options, or move along a row of buttons. */
  private adjust(el: HTMLElement, dir: number, items: HTMLElement[]) {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const step = Number(el.step) || 0.1;
      el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + dir * step)));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.classList.contains('segmented')) {
      const radios = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      const i = radios.findIndex((r) => r.checked);
      radios[Math.min(radios.length - 1, Math.max(0, i + dir))]?.click();
    } else {
      // Buttons side by side: left/right steps between them.
      const i = items.indexOf(el);
      const next = items[i + dir];
      if (next && next.parentElement === el.parentElement) this.setFocus(next);
    }
  }

  private setFocus(el: HTMLElement | null) {
    if (this.focused === el) return;
    this.focused?.classList.remove(FOCUS_CLASS);
    this.focused = el;
    el?.classList.add(FOCUS_CLASS);
  }
}
