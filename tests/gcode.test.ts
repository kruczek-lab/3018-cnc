import { describe, expect, it } from 'vitest';
import { cleanLine, prepareProgram } from '../src/gcode/clean';
import { analyzeProgram } from '../src/gcode/analyze';
import { parseWords } from '../src/gcode/words';

describe('cleanLine', () => {
  it('strips comments and whitespace', () => {
    expect(cleanLine('g1 x1.5 (move) y2 ; trailing')).toBe('G1X1.5Y2');
    expect(cleanLine('(only a comment)')).toBe('');
    expect(cleanLine('%')).toBe('');
  });

  it('drops empty lines from programs', () => {
    expect(prepareProgram('G21\n\n(hi)\r\nG0 X1\n')).toEqual(['G21', 'G0X1']);
  });
});

describe('parseWords', () => {
  it('rejects malformed lines', () => {
    expect(parseWords('G1X1Y')).toBeNull();
    expect(parseWords('G1X-.5')).toEqual([['G', 1], ['X', -0.5]]);
  });
});

describe('analyzeProgram', () => {
  it('tracks modal motion, relative mode and bounds', () => {
    const info = analyzeProgram(prepareProgram('G21 G90\nG0 X10 Y10\nG1 Z-1 F100\nX20\nG91\nY5\nG90\nG0 Z5'));
    expect(info.moves.map((m) => m.rapid)).toEqual([true, false, false, false, true]);
    expect(info.cutBounds!.min).toEqual([10, 10, -1]);
    expect(info.cutBounds!.max).toEqual([20, 15, 0]);
    expect(info.cutLength).toBeCloseTo(16);
  });

  it('converts inches', () => {
    const info = analyzeProgram(prepareProgram('G20\nG1 X1 F10'));
    expect(info.moves[0].to[0]).toBeCloseTo(25.4);
  });

  it('interpolates arcs', () => {
    const info = analyzeProgram(prepareProgram('G1 X10 Y0 F100\nG3 X0 Y10 I-10 J0'));
    const arc = info.moves.slice(1);
    expect(arc.length).toBeGreaterThan(4);
    for (const m of arc) expect(Math.hypot(m.to[0], m.to[1])).toBeCloseTo(10, 5);
    expect(info.cutLength - 10).toBeCloseTo((Math.PI * 10) / 2, 0);
  });
});
