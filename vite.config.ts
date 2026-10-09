import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the built game works from any folder or sub-path
  // (e.g. https://<user>.github.io/evil-one/).
  base: './',
  // Three.js alone is ~550 kB; that's expected for a 3D game.
  build: { chunkSizeWarningLimit: 1000 },
});
