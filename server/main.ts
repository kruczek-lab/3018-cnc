import { existsSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioServer } from './studio';
import { PiSystem } from './system';

// Settings come from environment variables (see pi/3018-studio.env.example).
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(process.env.STUDIO_STATIC ?? resolve(here, '../dist'));
const port = Number(process.env.STUDIO_PORT ?? 8018);

if (!existsSync(resolve(staticDir, 'index.html'))) {
  console.warn(`Warning: no web app found in ${staticDir}. Run "npm run build:pi" first.`);
}

const studio = new StudioServer({
  staticDir,
  serialPort: process.env.STUDIO_SERIAL_PORT || undefined,
  password: process.env.STUDIO_PASSWORD || undefined,
  system: new PiSystem(resolve(here, '..')),
});

const listening = await studio.listen(port, process.env.STUDIO_HOST ?? '0.0.0.0');
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `http://${a!.address}:${listening}`);
console.log(`3018 Studio is running. Open http://${hostname()}.local:${listening} ${addresses.length ? `or ${addresses.join(' / ')} ` : ''}in a browser.`);
if (!process.env.STUDIO_PASSWORD) console.log('No password set: anyone on your network can use the machine.');

if (process.env.STUDIO_AUTOCONNECT !== '0') {
  studio.connect(false).then(
    () => console.log(`Connected to ${studio.state().port}`),
    (error) => console.log(`Not connected yet: ${(error as Error).message}`),
  );
}

const shutdown = async () => {
  await studio.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
