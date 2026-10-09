/** Keys the browser should never act on while playing (e.g. Space scrolling the page). */
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyK', 'KeyJ', 'KeyE', 'KeyM',
  'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** Standard gamepad button indices (Xbox layout). */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const DEADZONE = 0.2;
/** Seconds between repeated menu moves while a stick or d-pad is held. */
const NAV_REPEAT = 0.22;

type NavDir = 'up' | 'down' | 'left' | 'right';

/** Removes the stick's dead zone and rescales the rest to 0..1. */
function deadzone(v: number) {
  const a = Math.abs(v);
  return a < DEADZONE ? 0 : Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE));
}

/**
 * Keyboard + pointer-locked mouse/trackpad, and gamepads (Xbox controller
 * layout). Nothing needs right-click or click-and-hold, so it plays the
 * same on a trackpad. `mode` follows whichever the player last used.
 */
export class Input {
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  mode: 'mouse' | 'gamepad' = 'mouse';
  /** When the mouse (or a console browser's controller cursor) last moved, in ms. */
  lastMouseMove = 0;
  /** When the game last received real controller input, in ms. */
  lastPadInput = 0;
  onLockChange?: (locked: boolean) => void;

  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private clicked = false;

  private pad: Gamepad | null = null;
  private padDown = new Set<number>();
  private readonly padPressed = new Set<number>();
  private axes = [0, 0, 0, 0];
  private navHeld: NavDir | null = null;
  private navTimer = 0;
  private navFired: NavDir | null = null;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // Let text fields (hero name) receive every key.
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      this.mode = 'mouse';
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    document.addEventListener('mousemove', (e) => {
      this.lastMouseMove = performance.now();
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) this.clicked = true;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (this.locked) this.mode = 'mouse';
      else this.down.clear();
      this.onLockChange?.(this.locked);
    });

    // Older Edge on Xbox turns the controller into a mouse cursor unless told otherwise.
    const nav = navigator as Navigator & { gamepadInputEmulation?: string };
    if ('gamepadInputEmulation' in nav) nav.gamepadInputEmulation = 'gamepad';
  }

  requestLock() {
    try {
      // Browsers refuse a re-lock for ~1s after Esc; the overlay stays up so the player can click again.
      Promise.resolve(this.el.requestPointerLock()).catch(() => {});
    } catch {
      /* pointer lock unsupported */
    }
  }

  /** Reads the controller. Call once at the start of every frame. */
  poll(dt: number) {
    const pads = navigator.getGamepads?.() ?? [];
    this.pad = null;
    for (const p of pads) {
      if (p?.connected) {
        this.pad = p;
        break;
      }
    }
    const previous = this.padDown;
    this.padDown = new Set();
    this.padPressed.clear();
    this.axes = [0, 0, 0, 0];
    const pad = this.pad;
    if (!pad) return;
    pad.buttons.forEach((b, i) => {
      if (b.pressed || b.value > 0.5) this.padDown.add(i);
    });
    for (const i of this.padDown) if (!previous.has(i)) this.padPressed.add(i);
    this.axes = [0, 1, 2, 3].map((i) => deadzone(pad.axes[i] ?? 0));
    if (this.padPressed.size > 0 || this.axes.some((a) => Math.abs(a) > 0.3)) {
      this.mode = 'gamepad';
      this.lastPadInput = performance.now();
    }

    // Menu navigation: d-pad or left stick, with key-repeat while held.
    const [lx, ly] = this.axes;
    let dir: NavDir | null = null;
    if (this.padDown.has(PAD.UP) || ly < -0.6) dir = 'up';
    else if (this.padDown.has(PAD.DOWN) || ly > 0.6) dir = 'down';
    else if (this.padDown.has(PAD.LEFT) || lx < -0.6) dir = 'left';
    else if (this.padDown.has(PAD.RIGHT) || lx > 0.6) dir = 'right';
    this.navFired = null;
    if (dir !== this.navHeld) {
      this.navHeld = dir;
      this.navFired = dir;
      this.navTimer = NAV_REPEAT * 1.8;
    } else if (dir) {
      this.navTimer -= dt;
      if (this.navTimer <= 0) {
        this.navFired = dir;
        this.navTimer = NAV_REPEAT;
      }
    }
  }

  isDown(...codes: string[]) {
    return codes.some((c) => this.down.has(c));
  }

  wasPressed(...codes: string[]) {
    return codes.some((c) => this.pressed.has(c));
  }

  padIsDown(...buttons: number[]) {
    return buttons.some((b) => this.padDown.has(b));
  }

  padWasPressed(...buttons: number[]) {
    return buttons.some((b) => this.padPressed.has(b));
  }

  /** Movement intent: x = strafe right, z = forward, length up to 1. Keys and left stick combined. */
  moveVector() {
    let x = (this.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (this.isDown('KeyA', 'ArrowLeft') ? 1 : 0) + this.axes[0];
    let z = (this.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (this.isDown('KeyS', 'ArrowDown') ? 1 : 0) - this.axes[1];
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  /** Right stick, with a curve for fine aiming near the center. */
  lookStick() {
    const curve = (v: number) => Math.sign(v) * v * v;
    return { x: curve(this.axes[2]), y: curve(this.axes[3]) };
  }

  get attackPressed() {
    return this.clicked || this.pressed.has('KeyJ') || this.padWasPressed(PAD.RT, PAD.X, PAD.RB);
  }

  get rollPressed() {
    return this.pressed.has('Space') || this.padWasPressed(PAD.A);
  }

  get blockHeld() {
    return this.isDown('KeyQ', 'KeyK') || this.padIsDown(PAD.LT, PAD.LB);
  }

  get sprintHeld() {
    return this.isDown('ShiftLeft', 'ShiftRight') || this.padIsDown(PAD.B, PAD.LS);
  }

  get mapPressed() {
    return this.pressed.has('KeyM') || this.padWasPressed(PAD.VIEW);
  }

  get pausePressed() {
    return this.padWasPressed(PAD.MENU);
  }

  /** One menu step in a direction this frame (d-pad or stick, repeating while held). */
  get nav(): NavDir | null {
    return this.navFired;
  }

  get confirmPressed() {
    return this.padWasPressed(PAD.A);
  }

  get backPressed() {
    return this.padWasPressed(PAD.B);
  }

  /** Controller rumble, if supported. strength 0..1. */
  rumble(strength: number, ms: number) {
    const actuator = (this.pad as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    if (this.mode !== 'gamepad' || !actuator?.playEffect) return;
    actuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
  }

  /** Clears per-frame state; call once at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.clicked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
