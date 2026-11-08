import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, read, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrblController, OVERRIDES } from '../src/machine/controller';
import { SimulatedGrbl } from '../src/machine/simulator';
import { limitsFromReference } from '../src/machine/travel';
import { analyzeProgram } from '../src/gcode/analyze';
import { prepareProgram } from '../src/gcode/clean';
import { emitGcode } from '../src/cam/operation';
import { LinuxSerialTransport } from '../server/linuxSerial';
import type { Transport } from '../src/machine/transport';

const until = async (cond: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

class FakeTransport implements Transport {
  readonly name = 'Fake';
  written: string[] = [];
  reply: (line: string) => void = () => undefined;
  async open(onLine: (line: string) => void) {
    this.reply = onLine;
  }
  writeLine(line: string) {
    this.written.push(line);
  }
  writeRealtime() {}
  async close() {}
}

async function connected() {
  const t = new FakeTransport();
  const c = new GrblController();
  await c.connect(t);
  t.reply('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>');
  t.reply('ok'); // the automatic $$ read
  t.written = [];
  return { t, c };
}

describe('review fixes', () => {
  it('refuses manual commands while a job runs, so nothing is slipped into the middle of it', async () => {
    const { t, c } = await connected();
    c.startJob('job', ['G1X1F100', 'G1X2']);
    expect(await c.send('G10 L20 P1 X0')).toBe('error:busy');
    expect(t.written).toEqual(['G1X1F100', 'G1X2']);
  });

  it('flags the zero as unverified after an unexpected restart until each axis is zeroed again', async () => {
    const { t, c } = await connected();
    t.reply("Grbl 1.1f ['$' for help]");
    expect(c.machine.zeroUnverified).toBe('XYZ');
    const xy = c.send('G10 L20 P1 X0 Y0');
    t.reply('ok'); // $$ after the restart
    t.reply('ok');
    await xy;
    expect(c.machine.zeroUnverified).toBe('Z');
    const z = c.send('G10 L20 P1 Z0.1');
    t.reply('ok');
    await z;
    expect(c.machine.zeroUnverified).toBe('');
    // Our own reset while standing still keeps the position, so the zero stays trusted.
    c.softReset();
    t.reply("Grbl 1.1f ['$' for help]");
    expect(c.machine.zeroUnverified).toBe('');
  });

  it('plans the next jog from the real position after GRBL rejects one', async () => {
    const { t, c } = await connected();
    c.machine.limits = limitsFromReference([0, 0, 0], [300, 180, 45], 1);
    const first = c.send('$J=G91 X290 F600');
    t.reply('error:15');
    expect(await first).toBe('error:15');
    void c.send('$J=G91 X20 F600');
    expect(t.written.at(-1)).toBe('$J=G91G21X20F600');
  });

  it('marks programs with machine-coordinate moves as not fully checkable', () => {
    expect(analyzeProgram(prepareProgram('G0 X1\nG28')).unchecked).toBe(true);
    expect(analyzeProgram(prepareProgram('G0 X1\nG1 Y2 F100')).unchecked).toBe(false);
  });

  it('writes G-code for paths far longer than the call-stack limit', () => {
    const path = Array.from({ length: 300_000 }, (_, i) => [i * 0.001, 0, -0.5] as [number, number, number]);
    const gcode = emitGcode({ name: 'long', tool: 'bit', spindle: 1000, feed: 500, plungeFeed: 100, stepdown: 1, safeZ: 2, paths: [path] });
    expect(gcode).toContain('G1 Z-0.5');
  });
});

describe('overrides', () => {
  it('changes feed and spindle override and reports them back', async () => {
    const c = new GrblController();
    await c.connect(new SimulatedGrbl());
    await until(() => c.machine.state === 'Idle');
    c.realtime(OVERRIDES.feedPlus);
    c.realtime(OVERRIDES.feedPlus);
    c.realtime(OVERRIDES.spindleMinus);
    await until(() => c.machine.overrides[0] === 120 && c.machine.overrides[2] === 90);
    c.realtime(OVERRIDES.feedReset);
    await until(() => c.machine.overrides[0] === 100);
    await c.disconnect();
  });
});

describe('USB adapter that goes quiet when unplugged', () => {
  it('notices the device has gone even though reads just return nothing', async () => {
    // A real USB serial adapter that is unplugged reads 0 bytes, like a timeout. A plain file at
    // its end does the same, and deleting it is the unplug.
    const path = join(mkdtempSync(join(tmpdir(), 'dev-')), 'ttyUSB0');
    writeFileSync(path, '');
    const c = new GrblController();
    await c.connect(new LinuxSerialTransport(path, 115200, false));
    expect(c.connected).toBe(true);
    rmSync(path);
    await until(() => !c.connected, 5000);
  });
});

const haveSocat = spawnSync('which', ['socat']).status === 0;

describe.skipIf(!haveSocat)('USB unplug on the Pi', () => {
  let socat: ChildProcess | null = null;
  afterEach(() => socat?.kill());

  it('notices the adapter disappearing mid-job and ends the job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tty-'));
    const pc = join(dir, 'pc');
    const board = join(dir, 'board');
    socat = spawn('socat', [`pty,raw,echo=0,link=${pc}`, `pty,raw,echo=0,link=${board}`]);
    await until(() => existsSync(pc) && existsSync(board));
    // A tiny board: answers status requests and acknowledges lines.
    const fd = openSync(board, 'r+');
    const buffer = Buffer.alloc(256);
    let stopped = false;
    const pump = () =>
      read(fd, buffer, 0, buffer.length, null, (error, n) => {
        if (error || stopped) return;
        for (const byte of buffer.subarray(0, n)) {
          if (byte === 0x3f) writeSync(fd, '<Run|MPos:0.000,0.000,0.000|FS:100,0>\r\n');
          else if (byte === 0x0a) writeSync(fd, 'ok\r\n');
        }
        pump();
      });
    pump();

    const c = new GrblController();
    await c.connect(new LinuxSerialTransport(pc));
    c.startJob('long', Array.from({ length: 1000 }, (_, i) => `G1X${i}F100`));
    await until(() => c.job!.acked > 5);
    stopped = true;
    socat.kill(); // pull the cable
    socat = null;
    closeSync(fd);
    await until(() => !c.connected);
    expect(c.job!.status).toBe('error');
    expect(c.job!.message).toBe('Connection lost');
  });
});
