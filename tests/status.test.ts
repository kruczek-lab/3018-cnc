import { describe, expect, it } from 'vitest';
import { parseStatus } from '../src/machine/status';

describe('parseStatus', () => {
  it('parses a GRBL 1.1 report with MPos and WCO', () => {
    const s = parseStatus('<Idle|MPos:1.000,-2.500,3.250|FS:0,0|WCO:0.500,0.000,-1.000>')!;
    expect(s.state).toBe('Idle');
    expect(s.mpos).toEqual([1, -2.5, 3.25]);
    expect(s.wco).toEqual([0.5, 0, -1]);
    expect(s.feed).toBe(0);
  });

  it('parses sub-states, buffers and pins', () => {
    const s = parseStatus('<Hold:0|WPos:0.000,0.000,0.000|Bf:15,128|FS:500,1000|Pn:XZ>')!;
    expect(s.state).toBe('Hold');
    expect(s.subState).toBe(0);
    expect(s.wpos).toEqual([0, 0, 0]);
    expect(s.plannerFree).toBe(15);
    expect(s.rxFree).toBe(128);
    expect(s.spindle).toBe(1000);
    expect(s.pins).toBe('XZ');
  });

  it('ignores non-status lines', () => {
    expect(parseStatus('ok')).toBeNull();
  });
});
