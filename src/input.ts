/** Keys the browser should never act on while playing (e.g. Space scrolling the page). */
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyK', 'KeyJ', 'KeyE', 'KeyM',
  'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/**
 * Keyboard + pointer-locked mouse/trackpad input. Nothing needs right-click or
 * click-and-hold, so it plays the same on a trackpad.
 */
export class Input {
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  onLockChange?: (locked: boolean) => void;

  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private clicked = false;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) this.clicked = true;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.down.clear();
      this.onLockChange?.(this.locked);
    });
  }

  requestLock() {
    try {
      // Browsers refuse a re-lock for ~1s after Esc; the overlay stays up so the player can click again.
      Promise.resolve(this.el.requestPointerLock()).catch(() => {});
    } catch {
      /* pointer lock unsupported */
    }
  }

  isDown(...codes: string[]) {
    return codes.some((c) => this.down.has(c));
  }

  wasPressed(...codes: string[]) {
    return codes.some((c) => this.pressed.has(c));
  }

  get attackPressed() {
    return this.clicked || this.pressed.has('KeyJ');
  }

  /** Clears per-frame state; call once at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.clicked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
