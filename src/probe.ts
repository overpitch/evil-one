import * as THREE from 'three';

/**
 * Device test (?probe): the lightest possible 3D page, with a running timer.
 * If a browser closes even this after a minute, the problem is the device
 * or its settings, not the game's size.
 */
document.title = 'Evil One · device test';
document.body.replaceChildren(); // drop the game's menus; this page stands alone
document.body.style.cssText = 'margin:0;background:#101018;color:#f2ead8;font-family:Georgia,serif;overflow:hidden';

const info = document.body.appendChild(document.createElement('div'));
info.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:24px;text-align:center;text-shadow:0 2px 4px #000;z-index:1';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 6);
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2));
const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 0), new THREE.MeshLambertMaterial({ color: 0xc9242a, flatShading: true }));
scene.add(gem);

let lost = false;
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  lost = true;
});

const start = performance.now();
let frames = 0;
let fps = 0;
let fpsSince = start;

function render(now: number) {
  frames++;
  if (now - fpsSince > 1000) {
    fps = (frames * 1000) / (now - fpsSince);
    frames = 0;
    fpsSince = now;
  }
  const up = Math.max(0, Math.floor((now - start) / 1000));
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  info.innerHTML = `
    <div style="font-size:64px;letter-spacing:4px">${Math.floor(up / 60)}:${String(up % 60).padStart(2, '0')}</div>
    <div style="font-size:20px;margin:8px 0 16px">${up >= 180 ? '✓ Passed: this browser keeps simple 3D running.' : 'Device test: leave this page open for 3 minutes.'}</div>
    <div style="font-size:14px;color:#b8ad96;line-height:1.6">
      ${fps.toFixed(0)} fps · screen ${window.innerWidth}×${window.innerHeight} at ${window.devicePixelRatio}x
      · ${heap ? `${(heap / 1048576).toFixed(0)} MB used` : 'memory not reported'}${lost ? ' · <b style="color:#ff7b6b">graphics were lost</b>' : ''}<br>
      ${navigator.userAgent}
    </div>`;
  gem.rotation.x = now / 1400;
  gem.rotation.y = now / 1000;
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
