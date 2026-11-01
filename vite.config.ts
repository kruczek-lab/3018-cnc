import { defineConfig } from 'vite';

// Relative base so the built site works from any path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  test: { include: ['tests/**/*.test.ts'] },
});
