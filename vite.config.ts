import { defineConfig } from 'vite';

// Relative base so the built site works from any path (GitHub Pages, or the Pi server).
// ES2022 for top-level await: fine for every browser with Web Serial, and Node 18+ on the Pi.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
