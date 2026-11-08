import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Browser tests for both ways of running the app: the Vite dev server (the Mac/USB setup, using
// the in-browser simulator) and the built Pi server (with the simulator on the "Pi").
// Run with `npm run test:e2e`, which builds first.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { viewport: { width: 1440, height: 900 } },
  webServer: [
    { command: 'npx vite --port 5180 --strictPort', url: 'http://localhost:5180', reuseExistingServer: false },
    {
      command: 'node dist-server/main.js',
      url: 'http://localhost:8030',
      reuseExistingServer: false,
      env: { STUDIO_PORT: '8030', STUDIO_AUTOCONNECT: '0', STUDIO_DATA: mkdtempSync(join(tmpdir(), 'studio-e2e-')) },
    },
  ],
});
