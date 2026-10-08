import { defineConfig } from 'vite';

export default defineConfig({
  // Three.js alone is ~550 kB; that's expected for a 3D game.
  build: { chunkSizeWarningLimit: 1000 },
});
