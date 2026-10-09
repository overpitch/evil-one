/**
 * Controller test (?padtest): shows, live and in large text, everything a
 * browser passes to the page from a controller (Gamepad API state, key
 * presses, clicks, cursor movement, scrolling, Back). For working out how a
 * console browser (Edge on Xbox) handles the controller in each mode.
 */
document.title = 'Evil One · controller test';
document.body.replaceChildren();
document.body.style.cssText = 'margin:0;background:#101018;color:#f2ead8;font:22px/1.4 Georgia,serif;overflow:hidden';

const NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
type Nav = Navigator & { gamepadInputEmulation?: string };
const nav = navigator as Nav;

const root = document.body.appendChild(document.createElement('div'));
root.style.cssText = 'padding:28px 40px';
root.innerHTML = `
  <div style="font-size:34px;color:#ffd36b">Controller test</div>
  <div style="color:#b8ad96;margin:4px 0 16px">Press A once first (so B can't leave this page). Then press every button and move both sticks, and take a photo of this screen. Hold ☰ Menu to switch to game controls, then do it again and take a second photo.</div>
  <div id="device"></div>
  <button id="emulate" style="font:inherit;font-size:20px;margin:12px 0;padding:8px 18px">Try: switch Edge to gamepad mode</button>
  <button id="back-to-game" style="font:inherit;font-size:20px;margin:12px 0 12px 12px;padding:8px 18px">Back to the game</button>
  <div id="live" style="margin:8px 0 16px;padding:12px 16px;background:#1d1d2a;border-radius:6px"></div>
  <div style="color:#ffd36b">Events the page received (newest first):</div>
  <div id="log" style="font-size:19px;white-space:pre"></div>`;
const $ = (id: string) => document.getElementById(id)!;

const log: string[] = [];
let mouseMoves = 0;
let lastMoveReport = performance.now();
function add(line: string) {
  const t = (performance.now() / 1000).toFixed(1);
  log.unshift(`${t}s  ${line}`);
  log.length = Math.min(log.length, 12);
  $('log').textContent = log.join('\n');
}

// Keep B (browser Back) on this page once there has been a click or key press.
let guarded = false;
const guard = () => {
  if (guarded) return;
  history.pushState({ padtest: true }, '');
  guarded = true;
};
window.addEventListener('pointerdown', guard);
window.addEventListener('keydown', guard);
window.addEventListener('popstate', () => {
  add('Back (popstate) — stayed on the page');
  guarded = false;
  guard();
});

window.addEventListener('keydown', (e) => {
  add(`keydown  key="${e.key}" code="${e.code}"${e.repeat ? ' (repeat)' : ''}`);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => add(`keyup    key="${e.key}" code="${e.code}"`));
window.addEventListener('mousedown', (e) => add(`mousedown button ${e.button}`));
window.addEventListener('click', () => add('click'));
window.addEventListener('mousemove', () => mouseMoves++);
window.addEventListener('wheel', (e) => add(`wheel (scroll) ${e.deltaY.toFixed(0)}`), { passive: true });
window.addEventListener('gamepadconnected', (e) => add(`gamepad connected: ${(e as GamepadEvent).gamepad.id}`));
window.addEventListener('gamepaddisconnected', () => add('gamepad disconnected'));

$('back-to-game').addEventListener('click', () => location.assign('./'));

$('emulate').addEventListener('click', () => {
  if ('gamepadInputEmulation' in nav) {
    nav.gamepadInputEmulation = 'gamepad';
    add(`set gamepadInputEmulation = "gamepad" (now "${nav.gamepadInputEmulation}")`);
  } else {
    add('this browser has no gamepadInputEmulation setting');
  }
});

function render() {
  const pads = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p);
  $('device').innerHTML = `
    <div>Gamepad setting (gamepadInputEmulation): <b>${'gamepadInputEmulation' in nav ? `"${nav.gamepadInputEmulation}"` : 'not available'}</b></div>
    <div>Controllers seen by the page: <b>${pads.length}</b>${pads[0] ? ` · mapping "${pads[0].mapping}" · ${pads[0].buttons.length} buttons, ${pads[0].axes.length} axes` : ''}</div>
    <div style="font-size:15px;color:#8a8070">${navigator.userAgent}</div>`;

  const p = pads[0];
  if (p) {
    const held = p.buttons.map((b, i) => (b.pressed || b.value > 0.5 ? NAMES[i] ?? `#${i}` : '')).filter(Boolean);
    const axes = Array.from(p.axes, (a) => (a >= 0 ? ' ' : '') + a.toFixed(2)).join('  ');
    $('live').innerHTML = `Buttons held: <b>${held.join(' ') || 'none'}</b><br>Sticks (left X Y, right X Y): <b>${axes}</b>`;
  } else {
    $('live').textContent = 'No controller seen yet. Press a button on the controller.';
  }

  const now = performance.now();
  if (now - lastMoveReport > 1000) {
    if (mouseMoves > 0) add(`cursor moved (${mouseMoves} moves in the last second)`);
    mouseMoves = 0;
    lastMoveReport = now;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

export {};
