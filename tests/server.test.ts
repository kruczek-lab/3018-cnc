import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, read, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioServer } from '../server/studio';
import { LinuxSerialTransport } from '../server/linuxSerial';
import { GrblController } from '../src/machine/controller';
import { SimulatedGrbl } from '../src/machine/simulator';
import type { SystemActions, SystemInfo } from '../server/system';

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let studio: StudioServer | null = null;
afterEach(async () => {
  await studio?.close();
  studio = null;
});

async function start(password?: string, system?: SystemActions) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-'));
  writeFileSync(join(dir, 'index.html'), '<h1>app</h1>');
  studio = new StudioServer({ staticDir: dir, password, system, dataDir: mkdtempSync(join(tmpdir(), 'studio-data-')) });
  const port = await studio.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const api = async (path: string, body?: unknown, headers: Record<string, string> = { 'X-Studio': '1' }) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { base, api };
}

describe('StudioServer', () => {
  it('runs a job on the simulator from start to finish and keeps the program for other viewers', async () => {
    const { api } = await start();
    expect((await api('/api/info')).body.app).toBe('3018-studio');
    expect((await api('/api/connect', { simulator: true })).body.port).toBe('simulator');
    await until(async () => (await api('/api/state')).body.machine.state === 'Idle');
    expect((await api('/api/command', { line: 'G10 L20 P1 X0 Y0 Z0' })).body.response).toBe('ok');

    const gcode = 'G21 G90\n(comment)\nG0 Z2\nG0 X5 Y5\nG1 Z-0.5 F300\nG1 X10 F1000\nG0 Z2\n';
    const started = await api('/api/job/start', { name: 'test.nc', gcode });
    expect(started.body.job).toMatchObject({ name: 'test.nc', total: 6 });
    expect(started.body.job.lines).toBeUndefined();
    expect((await api('/api/job/start', { name: 'again', gcode })).status).toBe(409);
    await until(async () => (await api('/api/state')).body.job.status === 'finished');
    await until(async () => (await api('/api/state')).body.machine.wpos[0] === 10);
  });

  it('streams state and log events', async () => {
    const { base, api } = await start();
    await api('/api/connect', { simulator: true });
    const res = await fetch(base + '/api/events');
    const reader = res.body!.getReader();
    let text = '';
    await until(async () => {
      text += new TextDecoder().decode((await reader.read()).value);
      return text.includes('event: state') && text.includes('Connected via Simulator');
    });
    await reader.cancel();
  });

  it('rejects commands without the X-Studio header (cross-site protection)', async () => {
    const { api } = await start();
    expect((await api('/api/connect', { simulator: true }, {})).status).toBe(403);
  });

  it('requires the password when one is set', async () => {
    const { base, api } = await start('secret');
    expect((await api('/api/state')).status).toBe(401);
    expect((await api('/api/login', { password: 'nope' })).status).toBe(401);
    expect((await api('/api/login', { password: 'secret' })).status).toBe(200);
    expect((await api('/api/state')).status).toBe(200);
    // The app itself still loads so it can show the login prompt.
    expect((await fetch(base + '/')).status).toBe(200);
  });

  it('serves the app but nothing outside its folder', async () => {
    const { base } = await start();
    expect(await (await fetch(base + '/')).text()).toBe('<h1>app</h1>');
    expect((await fetch(base + '/..%2f..%2fetc%2fpasswd')).status).toBe(403);
    expect((await fetch(base + '/missing.js')).status).toBe(404);
  });
});

class FakeSystem implements SystemActions {
  calls: string[] = [];
  blockers: Pick<SystemInfo, 'updateBlocker' | 'powerBlocker'> = { updateBlocker: null, powerBlocker: null };
  async info(): Promise<SystemInfo> {
    return { version: { commit: 'abc1234', date: '2026-11-07T10:00:00Z', subject: 'Test', branch: 'main' }, lastUpdate: null, ...this.blockers };
  }
  async checkForUpdates() {
    return { behind: 1, commits: ['def5678 Add something'] };
  }
  async startUpdate() {
    this.calls.push('update');
  }
  async power(action: 'poweroff' | 'reboot') {
    this.calls.push(action);
  }
}

describe('Pi system actions', () => {
  it('shuts down only when no job runs, switching the spindle off first', async () => {
    const system = new FakeSystem();
    const { api } = await start(undefined, system);
    await api('/api/connect', { simulator: true });
    await until(async () => (await api('/api/state')).body.machine.state === 'Idle');
    await api('/api/job/start', { name: 'long', gcode: 'G1 X50 F100\nG1 X0' });
    expect((await api('/api/system/power', { action: 'poweroff' })).status).toBe(409);
    await api('/api/job/stop', {});
    expect((await api('/api/system/power', { action: 'format-disk' })).status).toBe(400);
    expect((await api('/api/system/power', { action: 'poweroff' })).status).toBe(202);
    const state = (await api('/api/state')).body;
    expect(state.machine.connected).toBe(false);
    await until(() => system.calls.includes('poweroff'));
  });

  it('reports versions, checks for and starts updates, and refuses when not set up', async () => {
    const system = new FakeSystem();
    const { api } = await start(undefined, system);
    expect((await api('/api/system')).body.version.commit).toBe('abc1234');
    expect((await api('/api/system/check-updates', {})).body.behind).toBe(1);
    expect((await api('/api/system/update', {})).status).toBe(202);
    expect(system.calls).toEqual(['update']);
    system.blockers = { updateBlocker: 'not a git install', powerBlocker: 'run install.sh' };
    expect((await api('/api/system/update', {})).body.error).toBe('not a git install');
    expect((await api('/api/system/power', { action: 'reboot' })).body.error).toBe('run install.sh');
    expect(system.calls).toEqual(['update']);
  });

  it('is unavailable without system actions', async () => {
    const { api } = await start();
    expect((await api('/api/system/power', { action: 'reboot' })).status).toBe(501);
  });
});

/** Connects SimulatedGrbl to the "machine" end of a virtual serial cable, byte for byte like a real board. */
function attachSimulator(path: string) {
  const fd = openSync(path, 'r+');
  const sim = new SimulatedGrbl();
  sim.speedup = 100;
  let stopped = false;
  void sim.open((line) => !stopped && writeSync(fd, line + '\r\n'), () => undefined);
  const buffer = Buffer.alloc(256);
  let pending = '';
  const pump = () =>
    read(fd, buffer, 0, buffer.length, null, (error, n) => {
      if (error || stopped) return;
      for (const byte of buffer.subarray(0, n)) {
        if ([0x3f, 0x21, 0x7e, 0x18, 0x85].includes(byte)) sim.writeRealtime(byte);
        else if (byte === 0x0a) {
          sim.writeLine(pending);
          pending = '';
        } else pending += String.fromCharCode(byte);
      }
      pump();
    });
  pump();
  return () => {
    stopped = true;
    void sim.close();
    closeSync(fd);
  };
}

const haveSocat = spawnSync('which', ['socat']).status === 0;

describe.skipIf(!haveSocat)('LinuxSerialTransport over a virtual serial cable', () => {
  let socat: ChildProcess | null = null;
  afterEach(() => socat?.kill());

  it('streams a job through stty-configured tty devices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tty-'));
    const pc = join(dir, 'pc');
    const board = join(dir, 'board');
    socat = spawn('socat', [`pty,raw,echo=0,link=${pc}`, `pty,raw,echo=0,link=${board}`]);
    await until(() => existsSync(pc) && existsSync(board));
    const detach = attachSimulator(board);

    const controller = new GrblController();
    await controller.connect(new LinuxSerialTransport(pc));
    await until(() => controller.machine.state === 'Idle');
    const lines = Array.from({ length: 40 }, (_, i) => `G1X${i}Y${i % 7}F1000`);
    controller.startJob('serial', lines);
    await until(() => controller.job!.status === 'finished');
    await until(() => controller.machine.state === 'Idle' && controller.machine.wpos[0] === 39);
    await controller.disconnect();
    expect(controller.connected).toBe(false);
    detach();
  });
});
