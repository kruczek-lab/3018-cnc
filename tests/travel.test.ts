import { describe, expect, it } from 'vitest';
import { checkMoves, clampJog, describeViolations, limitsFromHoming, limitsFromReference } from '../src/machine/travel';
import { analyzeProgram } from '../src/gcode/analyze';
import { prepareProgram } from '../src/gcode/clean';
import { traceOutline } from '../src/gcode/trace';
import { GrblController, LimitError } from '../src/machine/controller';
import { SimulatedGrbl } from '../src/machine/simulator';
import type { Transport } from '../src/machine/transport';

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('travel limits', () => {
  const limits = limitsFromReference([10, 20, 5], [300, 180, 45], 1);

  it('builds the box from the X−/Y−/Z-top corner, with the margin on the far sides', () => {
    expect(limits.min).toEqual([10, 20, -39]);
    expect(limits.max).toEqual([309, 199, 5]);
    expect(limitsFromHoming([300, 180, 45], 1)).toMatchObject({ min: [-299, -179, -44], max: [0, 0, 0] });
  });

  it('shortens jogs at the limits, but lets them move back inside', () => {
    expect(clampJog([300, 20, 5], [50, -10, 10], limits)).toEqual([9, 0, 0]);
    expect(clampJog([100, 100, 0], [-10, 10, -5], limits)).toEqual([-10, 10, -5]);
    // Outside (e.g. after shrinking the margin): can't go further out, can come back.
    expect(clampJog([320, 100, 0], [5, 0, 0], limits)).toEqual([0, 0, 0]);
    expect(clampJog([320, 100, 0], [-5, 0, 0], limits)).toEqual([-5, 0, 0]);
  });

  it('reports how far a program goes past each end, from the current work zero', () => {
    const { moves } = analyzeProgram(prepareProgram('G0 Z3\nG0 X0 Y0\nG1 Z-1 F100\nG1 X120 Y50\nG0 Z3'));
    // Work zero at machine (200, 160, 0): X reaches 320 (11 past 309), Y 210 (11 past 199).
    const violations = checkMoves(moves, [200, 160, 0], limits);
    expect(describeViolations(violations)).toBe('11.0 mm past the X+ end, 11.0 mm past the Y+ end');
    expect(checkMoves(moves, [50, 50, 0], limits)).toEqual([]);
    expect(describeViolations(checkMoves(moves, [50, 50, 3], limits))).toBe('1.0 mm above the top of Z');
  });
});

describe('traceOutline', () => {
  it('goes round the bounds with the bit raised and the spindle off', () => {
    const lines = traceOutline({ min: [5, 6, -1], max: [50, 40, 0] }, 3);
    expect(lines.slice(0, 3)).toEqual(['G21G90', 'M5', 'G0Z3']);
    const moves = analyzeProgram(lines).moves;
    expect(moves.every((m) => m.rapid && m.to[2] === 3)).toBe(true);
    // After the lift: to the first corner, then round the rectangle.
    expect(moves.slice(1).map((m) => [m.to[0], m.to[1]])).toEqual([[5, 6], [50, 6], [50, 40], [5, 40], [5, 6]]);
  });
});

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

async function controllerAt(mpos: string) {
  const t = new FakeTransport();
  const c = new GrblController();
  await c.connect(t);
  t.reply(`<Idle|MPos:${mpos}|FS:0,0|WCO:0.000,0.000,0.000>`);
  t.reply('ok'); // the automatic $$ read
  t.written = [];
  return { t, c };
}

describe('GrblController with travel limits', () => {
  it('clamps jogs, including several queued clicks, and refuses jogs that cannot move', async () => {
    const { t, c } = await controllerAt('0.000,0.000,0.000');
    c.setTravelReference([300, 180, 45], 1);
    void c.send('$J=G91 G21 X10 F600');
    void c.send('$J=G91 G21 Z5 F600');
    expect(await c.send('$J=G91 Z5 F600')).toBe('error:limit');
    t.reply('<Jog|MPos:5.000,0.000,0.000|FS:600,0>');
    void c.send('$J=G91 X-50 F600');
    expect(t.written).toEqual(['$J=G91G21X10F600', '$J=G91G21X-10F600']);
  });

  it('turns absolute jogs into limited relative ones', async () => {
    const { t, c } = await controllerAt('100.000,50.000,-10.000');
    c.setTravelReference([300, 180, 45], 1);
    t.reply('ok');
    t.reply('<Idle|MPos:150.000,60.000,-12.000|FS:0,0|WCO:100.000,50.000,-10.000>');
    t.written = [];
    void c.send('$J=G90 X500 Y0 F800');
    // From machine X150 to the X+ limit 399; Y to work 0 = machine 50.
    expect(t.written).toEqual(['$J=G91G21X249Y-10F800']);
  });

  it('refuses jobs that leave the travel unless told to ignore the limits', async () => {
    const { c } = await controllerAt('0.000,0.000,0.000');
    c.setTravelReference([300, 180, 45], 1);
    const lines = prepareProgram('G0 X350 Y10\nG1 Z-1 F100');
    expect(() => c.startJob('big', lines)).toThrow(LimitError);
    expect(() => c.startJob('big', lines)).toThrow('51.0 mm past the X+ end');
    c.startJob('big', lines, { ignoreLimits: true });
    expect(c.job?.status).toBe('running');
  });

  it('forgets the limits on alarms and unexpected restarts, but not after its own idle reset', async () => {
    const { t, c } = await controllerAt('0.000,0.000,0.000');
    c.setTravelReference([300, 180, 45], 1);
    c.softReset();
    t.reply("Grbl 1.1f ['$' for help]");
    expect(c.machine.limits).not.toBeNull();
    t.reply("Grbl 1.1f ['$' for help]");
    expect(c.machine.limits).toBeNull();
    t.reply('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    c.setTravelReference([300, 180, 45], 1);
    t.reply('ALARM:3');
    expect(c.machine.limits).toBeNull();
  });
});

describe('homing (simulated limit switches)', () => {
  it('reads settings, homes, takes limits from $130–$132 and works with GRBL soft limits', async () => {
    const sim = new SimulatedGrbl();
    sim.speedup = 200;
    const c = new GrblController();
    await c.connect(sim);
    await until(() => c.machine.state === 'Idle' && c.settings[130] === 300);
    expect(c.machine.homingEnabled).toBe(false);
    expect(await c.home(1)).toBe('error:5');

    expect(await c.send('$20=1')).toBe('error:10');
    expect(await c.send('$22=1')).toBe('ok');
    expect(await c.send('$20=1')).toBe('ok');
    await until(() => c.machine.homingEnabled);

    // Restarting with homing enabled starts locked, like the real thing.
    c.softReset();
    await until(() => c.machine.state === 'Alarm');
    expect(await c.home(1)).toBe('ok');
    expect(c.machine.limits).toEqual({ source: 'homing', min: [-299, -179, -44], max: [0, 0, 0] });

    await until(() => c.machine.state === 'Idle');
    await c.send('$J=G91 X-1000 F1000');
    await until(() => c.machine.state === 'Idle' && c.machine.mpos[0] < -200);
    expect(c.machine.mpos[0]).toBeCloseTo(-299);
    await c.disconnect();
  });
});
