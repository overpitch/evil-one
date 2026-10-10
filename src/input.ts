import { IS_XBOX } from './settings';

/** Keys the browser should never act on while playing (e.g. Space scrolling the page). */
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyK', 'KeyJ', 'KeyE', 'KeyM', 'KeyI', 'KeyH',
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
  lastPadInput = -Infinity;
  onLockChange?: (locked: boolean) => void;

  /** The browser turns the controller into key presses (an Xbox, or anything sending 'Gamepad' keys). */
  private consoleBrowser = IS_XBOX;
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private clicked = false;

  /** Player 2 reads only this controller (null: any controller, as Player 1 does). */
  padIndex: number | null = null;
  /** Controller Player 1 leaves alone (Player 2's), or null. */
  exclude: number | null = null;
  /**
   * Player 1's controller: the first one they use, kept until it disconnects
   * (so touching another controller never takes Player 1's hero away; that
   * controller pressing A brings in Player 2 instead). Player 2's is padIndex.
   */
  lastPadIndex: number | null = null;
  /** Waiting for Player 2 to press A: Player 1 doesn't pick up a new controller meanwhile. */
  blockClaim = false;

  private pad: Gamepad | null = null;
  /**
   * Per controller: which sticks have been seen centered, and which buttons
   * released, at least once. A stick or button stuck from the moment a
   * device appears (a faulty or odd device) is ignored until then.
   */
  private readonly settled = new Map<number, { axes: boolean[]; buttons: boolean[] }>();
  private padDown = new Set<number>();
  private readonly padPressed = new Set<number>();
  private axes = [0, 0, 0, 0];
  private navHeld: NavDir | null = null;
  private navTimer = 0;
  private navFired: NavDir | null = null;

  /** `keyboard: false` makes a controller-only player (Player 2), with no keyboard or mouse. */
  constructor(
    private readonly el: HTMLElement,
    keyboard = true,
  ) {
    if (!keyboard) {
      this.mode = 'gamepad';
      return;
    }
    window.addEventListener('keydown', (e) => {
      // Let text fields (hero name) receive every key.
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      // Console browsers turn the controller into arrow/"Gamepad" key presses while in
      // browser mode, and may never send the matching release: don't treat them as keys.
      if (e.key.startsWith('Gamepad')) {
        this.consoleBrowser = true;
        this.down.clear();
        return;
      }
      if (this.consoleBrowser && e.code.startsWith('Arrow')) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      if (!IS_XBOX) this.mode = 'mouse';
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

  /** Reads the controller(s). Call once at the start of every frame. */
  poll(dt: number) {
    const all = navigator.getGamepads?.() ?? [];
    // Player 2 uses their own controller; Player 1 uses the one they picked up first.
    let pads: Gamepad[] = [];
    // Ignore odd devices (remotes, headsets) when a proper controller is connected.
    const anyStandard = [...all].some((p) => p?.connected && p.mapping === 'standard');
    for (const p of all) {
      if (!p?.connected || (anyStandard && p.mapping !== 'standard')) continue;
      if (this.padIndex !== null ? p.index === this.padIndex : p.index !== this.exclude) pads.push(p);
    }
    if (this.padIndex === null) {
      const mine = pads.find((p) => p.index === this.lastPadIndex);
      if (mine) pads = [mine];
      else {
        this.lastPadIndex = null; // it was unplugged (or never chosen)
        if (this.blockClaim) pads = [];
      }
    }
    const previous = this.padDown;
    this.padDown = new Set();
    this.padPressed.clear();
    this.axes = [0, 0, 0, 0];
    this.pad = pads.find((p) => p.index === this.lastPadIndex) ?? pads[0] ?? null;
    if (!this.pad) {
      this.navHeld = null;
      this.navFired = null;
      return;
    }
    for (const pad of pads) {
      let used = false;
      let settled = this.settled.get(pad.index);
      if (!settled) this.settled.set(pad.index, (settled = { axes: [], buttons: [] }));
      pad.buttons.forEach((b, i) => {
        const down = b.pressed || b.value > 0.5;
        if (!down) settled.buttons[i] = true;
        else if (settled.buttons[i]) {
          this.padDown.add(i);
          used = true;
        }
      });
      for (let i = 0; i < 4; i++) {
        const raw = pad.axes[i] ?? 0;
        if (Math.abs(raw) < 0.3) settled.axes[i] = true;
        const v = settled.axes[i] ? deadzone(raw) : 0;
        if (Math.abs(v) > Math.abs(this.axes[i])) this.axes[i] = v;
        if (Math.abs(v) > 0.3) used = true;
      }
      if (used && this.lastPadIndex === null) {
        this.lastPadIndex = pad.index;
        this.pad = pad;
      }
    }
    for (const i of this.padDown) if (!previous.has(i)) this.padPressed.add(i);
    // While a browser is steering a cursor with the controller (Edge on Xbox in browser
    // mode), the buttons belong to the browser: don't switch the menus to controller mode.
    if ((this.padPressed.size > 0 || this.axes.some((a) => Math.abs(a) > 0.3)) && !this.cursorActive) {
      // Taking over from the keyboard: forget any keys that look held (a release may have been missed).
      if (!this.padActive) this.down.clear();
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

  /** A mouse pointer (or a browser's controller cursor) moved in the last moment, while not captured. */
  get cursorActive() {
    return !this.locked && performance.now() - this.lastMouseMove < 1500;
  }

  /** The controller has been used in the last few seconds (keyboard movement is ignored meanwhile). */
  get padActive() {
    return performance.now() - this.lastPadInput < 3000;
  }

  /**
   * Keyboard keys, unless the controller is in charge. On a console the
   * hero only moves with the controller: the browser there invents key
   * presses from the controller and can lose the release, leaving the hero
   * walking on their own.
   */
  private key(...codes: string[]) {
    return !this.consoleBrowser && !this.padActive && this.isDown(...codes);
  }

  /** Movement intent: x = strafe right, z = forward, length up to 1. Keys or left stick. */
  moveVector() {
    let x = (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0) + this.axes[0];
    let z = (this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0) - this.axes[1];
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
    return this.key('KeyQ', 'KeyK') || this.padIsDown(PAD.LT, PAD.LB);
  }

  get sprintHeld() {
    return this.key('ShiftLeft', 'ShiftRight') || this.padIsDown(PAD.B, PAD.LS);
  }

  /** For ?stats: what the controller and keyboard look like right now. */
  debugText() {
    const p = this.pad;
    const raw = p ? Array.from(p.axes.slice(0, 4), (a) => a.toFixed(2)).join(' ') : 'none';
    const buttons = p ? p.buttons.flatMap((b, i) => (b.pressed ? [i] : [])).join(',') || 'none' : 'none';
    return `pad ${p ? p.mapping || 'non-standard' : 'none'} · sticks ${raw} · buttons ${buttons} · keys ${[...this.down].join(',') || 'none'} · ${this.consoleBrowser ? 'console' : 'computer'}`;
  }

  get mapPressed() {
    return this.pressed.has('KeyM') || this.padWasPressed(PAD.VIEW);
  }

  /** H, or the d-pad up: drink a healing potion. */
  get potionPressed() {
    return this.pressed.has('KeyH') || this.padWasPressed(PAD.UP);
  }

  /** I, or the controller's Y button: open or close the inventory. */
  get inventoryPressed() {
    return this.pressed.has('KeyI') || this.padWasPressed(PAD.Y);
  }

  /** Quick weapon swap while playing: number keys pick a slot, the d-pad steps through. */
  get weaponSlotPressed(): number | null {
    for (let i = 1; i <= 9; i++) if (this.pressed.has(`Digit${i}`)) return i - 1;
    return null;
  }

  get weaponCyclePressed(): -1 | 0 | 1 {
    if (this.padWasPressed(PAD.RIGHT)) return 1;
    if (this.padWasPressed(PAD.LEFT)) return -1;
    return 0;
  }

  get escapePressed() {
    return this.pressed.has('Escape');
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
