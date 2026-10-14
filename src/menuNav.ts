import type { Input } from './input';

/** Menu screens, topmost first: the first visible one gets controller focus. */
const SCREENS = ['ending-screen', 'duel-screen', 'death-screen', 'options-screen', 'outfit-screen', 'p2-screen', 'shop-screen', 'inventory-screen', 'pause-screen', 'name-screen', 'intro-screen', 'title-screen'];

/** What the B button does on each screen. */
const BACK_BUTTONS: Record<string, string[]> = {
  'options-screen': ['options-back-btn'],
  'inventory-screen': ['inventory-close-btn'],
  'p2-screen': ['p2-back-btn', 'p2-cancel-btn'],
  'shop-screen': ['shop-close-btn'],
  'outfit-screen': ['outfit-done-btn'],
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
  /** Where the highlight was, so it stays there when a screen redraws its buttons (shops). */
  private lastScreen: HTMLElement | null = null;
  private lastIndex = 0;

  /** True when a menu screen is up (so the game shouldn't take controller input). */
  get menuOpen() {
    return SCREENS.some((id) => visible(document.getElementById(id)!));
  }

  /** Player 1's input first; Player 2's controller (if joined) can drive the menus too. */
  update(inputs: Input[]) {
    const pads = inputs.filter((i) => i.mode === 'gamepad' && !i.cursorActive);
    // Pointing with a cursor (mouse, or Edge on Xbox in browser mode): clicks do the work.
    if (pads.length === 0) {
      this.setFocus(null);
      return;
    }
    const screen = SCREENS.map((id) => document.getElementById(id)!).find(visible);
    if (!screen) {
      this.setFocus(null);
      return;
    }
    this.scrollWith(pads, screen);
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
      // The same screen redrawn: keep the highlight in the same place.
      const same = screen === this.lastScreen;
      this.setFocus(items[same ? Math.min(this.lastIndex, items.length - 1) : 0]);
      this.lastScreen = screen;
      this.lastIndex = items.indexOf(this.focused!);
      return;
    }
    const current = this.focused;
    const index = items.indexOf(current);
    this.lastScreen = screen;
    this.lastIndex = index;

    const nav = pads.map((i) => i.nav).find((d) => d !== null) ?? null;
    switch (nav) {
      case 'up':
        this.setFocus(items[(index - 1 + items.length) % items.length]);
        break;
      case 'down':
        this.setFocus(items[(index + 1) % items.length]);
        break;
      case 'left':
      case 'right':
        this.adjust(current, nav === 'right' ? 1 : -1, items);
        break;
    }

    if (pads.some((i) => i.confirmPressed)) {
      if (current instanceof HTMLInputElement && (current.type === 'text' || !current.type)) current.focus();
      else current.click();
    } else if (pads.some((i) => i.backPressed)) {
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
    // Long lists (shops, inventory) scroll so the highlighted item is always on screen.
    try {
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* older browsers */
    }
  }

  /** The right stick scrolls a long menu up and down (no scroll bar to grab on a controller). */
  private scrollWith(inputs: Input[], screen: HTMLElement) {
    const y = inputs.reduce((sum, i) => sum + i.lookStick().y, 0);
    if (Math.abs(y) < 0.02) return;
    const panel = [screen, ...screen.querySelectorAll<HTMLElement>('.panel')].find((el) => el.scrollHeight > el.clientHeight + 2);
    if (panel) panel.scrollTop += y * 18;
  }
}
