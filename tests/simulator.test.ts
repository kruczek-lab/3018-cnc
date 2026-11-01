import { describe, expect, it } from 'vitest';
import { GrblController } from '../src/machine/controller';
import { SimulatedGrbl } from '../src/machine/simulator';

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('controller + simulator', () => {
  it('runs a job to completion and ends at the commanded work position', async () => {
    const sim = new SimulatedGrbl();
    sim.speedup = 200;
    const c = new GrblController();
    await c.connect(sim);
    await c.send('G10 L20 P1 X0 Y0 Z0');
    await c.send('$J=G91 X5 F1000');
    await c.send('G10 L20 P1 X0');
    const lines = ['G21G90', 'G0Z2', 'M3S1000', 'G0X10Y10', 'G1Z-1F200', 'G1X20Y10F600', 'G1X20Y20', 'G0Z2', 'M5'];
    c.startJob('sim', lines);
    await until(() => c.job!.status === 'finished');
    await until(() => c.machine.state === 'Idle' && c.machine.wpos[2] === 2);
    expect(c.machine.wpos).toEqual([20, 20, 2]);
    expect(c.machine.mpos[0]).toBeCloseTo(25);
    await c.disconnect();
  });
});
