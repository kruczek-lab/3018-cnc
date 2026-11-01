import { describe, expect, it } from 'vitest';
import { GrblController } from '../src/machine/controller';
import type { Transport } from '../src/machine/transport';

class FakeTransport implements Transport {
  readonly name = 'Fake';
  written: string[] = [];
  realtime: number[] = [];
  reply: (line: string) => void = () => undefined;
  async open(onLine: (line: string) => void) {
    this.reply = onLine;
  }
  writeLine(line: string) {
    this.written.push(line);
  }
  writeRealtime(byte: number) {
    this.realtime.push(byte);
  }
  async close() {}
}

async function connected() {
  const t = new FakeTransport();
  const c = new GrblController();
  await c.connect(t);
  return { t, c };
}

describe('GrblController streaming', () => {
  it('never has more than 127 unacknowledged bytes in flight', async () => {
    const { t, c } = await connected();
    const lines = Array.from({ length: 50 }, (_, i) => `G1X${i}.123Y${i}.456F500`);
    c.startJob('test', lines);
    const inFlightBytes = () => t.written.slice(c.job!.acked).reduce((n, l) => n + l.length + 1, 0);
    expect(t.written.length).toBeGreaterThan(1);
    expect(t.written.length).toBeLessThan(lines.length);
    while (c.job!.acked < lines.length) {
      expect(inFlightBytes()).toBeLessThanOrEqual(127);
      t.reply('ok');
    }
    expect(t.written).toEqual(lines);
    expect(c.job!.status).toBe('finished');
  });

  it('pauses the job and holds feed on error', async () => {
    const { t, c } = await connected();
    c.startJob('test', ['G1X1F100', 'G1X2', 'G1X3']);
    t.reply('ok');
    t.reply('error:20');
    expect(c.job!.status).toBe('paused');
    expect(t.realtime).toContain('!'.charCodeAt(0));
    c.resumeJob();
    t.reply('ok');
    expect(c.job!.status).toBe('finished');
  });

  it('resolves manual commands and tracks positions from status', async () => {
    const { t, c } = await connected();
    const response = c.send('G10 L20 P1 X0');
    expect(t.written).toEqual(['G10L20P1X0']);
    t.reply('ok');
    await expect(response).resolves.toBe('ok');
    t.reply('<Idle|MPos:10.000,5.000,-2.000|FS:0,0|WCO:4.000,1.000,-3.000>');
    expect(c.machine.wpos).toEqual([6, 4, 1]);
    t.reply('<Run|MPos:11.000,5.000,-2.000|FS:500,1000>');
    expect(c.machine.wpos).toEqual([7, 4, 1]);
    expect(c.machine.state).toBe('Run');
  });

  it('aborts the job when GRBL resets or alarms', async () => {
    const { t, c } = await connected();
    c.startJob('a', ['G1X1F100']);
    t.reply('ALARM:3');
    expect(c.job!.status).toBe('error');
    c.startJob('b', ['G1X1F100']);
    t.reply("Grbl 1.1f ['$' for help]");
    expect(c.job!.status).toBe('stopped');
  });
});
