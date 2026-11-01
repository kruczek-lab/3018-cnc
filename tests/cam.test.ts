import { describe, expect, it } from 'vitest';
import { squaredDistanceTo, edgeDistanceField } from '../src/cam/distance';
import { isoContours } from '../src/cam/contours';
import { simplify } from '../src/cam/simplify';
import { planCarve, COVERAGE, type CarveSettings } from '../src/cam/carve';
import { emitGcode, orderPaths, type Operation } from '../src/cam/operation';
import { maskFromRGBA, mirrorMask, type Mask } from '../src/cam/mask';
import { planSurfacing } from '../src/cam/surfacing';
import { prepareProgram } from '../src/gcode/clean';
import { analyzeProgram } from '../src/gcode/analyze';

function maskFrom(rows: string[], res: number): Mask {
  const height = rows.length;
  const width = rows[0].length;
  const keep = new Uint8Array(width * height);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (keep[y * width + x] = ch === '#' ? 1 : 0)));
  return { width, height, res, keep };
}

function drawMask(width: number, height: number, res: number, inside: (x: number, y: number) => boolean): Mask {
  const keep = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) keep[y * width + x] = inside(x, y) ? 1 : 0;
  return { width, height, res, keep };
}

describe('distance transform', () => {
  it('matches brute force', () => {
    const w = 23;
    const h = 17;
    const feature = new Uint8Array(w * h);
    [5, 77, 200, 333].forEach((i) => (feature[i] = 1));
    const d2 = squaredDistanceTo(feature, w, h);
    for (let i = 0; i < w * h; i++) {
      let best = Infinity;
      for (let j = 0; j < w * h; j++) {
        if (feature[j]) best = Math.min(best, (i % w - (j % w)) ** 2 + (Math.floor(i / w) - Math.floor(j / w)) ** 2);
      }
      expect(d2[i]).toBe(best);
    }
  });
});

describe('isoContours', () => {
  it('traces a closed circle at the right radius', () => {
    const n = 41;
    const field = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[y * n + x] = Math.hypot(x - 20, y - 20);
    const lines = isoContours(field, n, n, 10);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    for (const [x, y] of lines[0].points) expect(Math.hypot(x - 20, y - 20)).toBeCloseTo(10, 0);
  });

  it('returns open lines where the contour leaves the image', () => {
    const field = new Float32Array(10 * 10).map((_, i) => i % 10);
    const lines = isoContours(field, 10, 10, 4.5);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(false);
    expect(lines[0].points).toHaveLength(10);
  });
});

describe('simplify', () => {
  it('drops collinear points', () => {
    expect(simplify([[0, 0], [1, 0.01], [2, 0], [2, 5]], 0.1)).toEqual([[0, 0], [2, 0], [2, 5]]);
  });
});

describe('mask helpers', () => {
  it('thresholds, inverts and treats transparency as white', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    expect([...maskFromRGBA(rgba, 3, 1, 0.1, 128, false).keep]).toEqual([1, 0, 0]);
    expect([...maskFromRGBA(rgba, 3, 1, 0.1, 128, true).keep]).toEqual([0, 1, 1]);
  });

  it('mirrors left to right', () => {
    expect([...mirrorMask(maskFrom(['#..', '.#.'], 1)).keep]).toEqual([0, 0, 1, 0, 1, 0]);
  });
});

const settings = (clearing: boolean): CarveSettings => ({
  safeZ: 2,
  detail: { angle: 30, tipDiameter: 0.1, depth: 1, minDepth: 0.2, feed: 600, plungeFeed: 200, spindle: 1000 },
  clearing: clearing ? { diameter: 2, depth: 1.5, stepover: 0.4, stepdown: 1.5, feed: 800, plungeFeed: 200, spindle: 1000 } : null,
});

/** Checks every cut stays clear of kept pixels, sampling along segments. Returns the worst intrusion in mm. */
function worstIntrusion(mask: Mask, op: Operation, radiusAtDepth: (depth: number) => number): number {
  const { width: w, height: h, res, keep } = mask;
  const kept: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep[y * w + x]) kept.push([x * res, (h - 1 - y) * res]);
  let worst = 0;
  const check = (px: number, py: number, depth: number) => {
    const r = radiusAtDepth(depth);
    for (const [kx, ky] of kept) {
      // distance from point to the kept pixel's square
      const dx = Math.max(kx - px, 0, px - (kx + res));
      const dy = Math.max(ky - py, 0, py - (ky + res));
      worst = Math.max(worst, r - Math.hypot(dx, dy));
    }
  };
  for (const path of op.paths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[Math.min(i + 1, path.length - 1)];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (res / 2)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        check(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, -(a[2] + (b[2] - a[2]) * t));
      }
    }
  }
  return worst;
}

describe('planCarve', () => {
  const res = 0.1;
  // A ring, a thin bar, a sharp wedge and a dot on a 12 × 8 mm block.
  const mask = drawMask(120, 80, res, (x, y) => {
    const r = Math.hypot(x - 35, y - 40);
    if (r > 18 && r < 26) return true;
    if (x >= 70 && x <= 72 && y >= 10 && y <= 70) return true;
    if (x >= 80 && x <= 110 && Math.abs(y - 40) <= (x - 80) * 0.3) return true;
    return Math.hypot(x - 35, y - 40) < 3;
  });

  for (const clearing of [true, false]) {
    it(`never cuts into kept areas (${clearing ? 'with' : 'without'} clearing)`, () => {
      const s = settings(clearing);
      const plan = planCarve(mask, s);
      const tan = Math.tan((15 * Math.PI) / 180);
      const detail = plan.operations.find((o) => o.name === 'Detail')!;
      expect(worstIntrusion(mask, detail, (d) => 0.05 + d * tan)).toBeLessThan(res * 0.75);
      if (clearing) {
        const clear = plan.operations.find((o) => o.name === 'Clearing')!;
        expect(worstIntrusion(mask, clear, () => 1)).toBeLessThan(res * 0.75);
      } else {
        expect(plan.operations).toHaveLength(1);
      }
      for (const op of plan.operations) for (const p of op.paths) for (const [x, y] of p) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(12);
        expect(y).toBeLessThanOrEqual(8);
      }
    });

    it(`carves almost everything that should go (${clearing ? 'with' : 'without'} clearing)`, () => {
      const plan = planCarve(mask, settings(clearing));
      const white = mask.keep.reduce((n, k) => n + (k ? 0 : 1), 0) * res * res;
      expect(plan.missedArea / white).toBeLessThan(0.01);
      for (let i = 0; i < mask.keep.length; i++) if (mask.keep[i]) expect(plan.coverage[i]).toBe(COVERAGE.keep);
    });
  }

  it('reaches into a gap narrower than the outline cut with a shallower pass', () => {
    // Two blocks 0.4 mm apart: narrower than the 1 mm deep, 30° outline (≈0.64 mm wide).
    const m = maskFrom(Array.from({ length: 30 }, () => '#'.repeat(20) + '.'.repeat(4) + '#'.repeat(20)), res);
    const plan = planCarve(m, settings(false));
    const depths = plan.operations[0].paths.flat().map((p) => -p[2]);
    expect(Math.max(...depths)).toBeLessThan(1);
    expect(Math.max(...depths)).toBeGreaterThan(0.2);
    expect(plan.missedArea).toBeLessThan(0.05);
  });

  it('produces G-code the analyser accepts, within the design and depth', () => {
    const plan = planCarve(mask, settings(true));
    for (const op of plan.operations) {
      const info = analyzeProgram(prepareProgram(emitGcode(op)));
      expect(info.warnings).toEqual([]);
      expect(info.cutBounds!.min[2]).toBeGreaterThanOrEqual(-1.5 - 1e-9);
      expect(info.cutBounds!.max[0]).toBeLessThanOrEqual(12);
    }
  });
});

describe('emitGcode', () => {
  const op: Operation = {
    name: 'Test', tool: 'bit', spindle: 1000, feed: 500, plungeFeed: 100, stepdown: 0.5, safeZ: 2,
    paths: [[[0, 0, -1.2], [10, 0, -1.2], [10, 10, -1.2], [0, 0, -1.2]]],
  };

  it('cuts deep paths in several passes, staying down on closed loops', () => {
    const lines = emitGcode(op).split('\n');
    expect(lines.filter((l) => l.startsWith('G1 Z'))).toEqual(['G1 Z-0.5 F100', 'G1 Z-1 F100', 'G1 Z-1.2 F100']);
    expect(lines.filter((l) => l === 'G0 Z2')).toHaveLength(2);
    expect(lines).toContain('M3 S1000');
    expect(lines.slice(-4)).toEqual(['M5', 'G0 X0 Y0', 'M2', '']);
  });
});

describe('orderPaths', () => {
  it('reverses open paths and rotates closed loops to reduce travel', () => {
    const ordered = orderPaths([
      [[10, 0, -1], [0, 0, -1]],
      [[5, 5, -1], [6, 5, -1], [6, 6, -1], [5, 5, -1]],
    ]);
    expect(ordered[0][0]).toEqual([0, 0, -1]);
    // The first path ends at (10, 0), so the loop should start from its nearest corner and stay closed.
    expect(ordered[1]).toEqual([[6, 5, -1], [6, 6, -1], [5, 5, -1], [6, 5, -1]]);
  });
});

describe('planSurfacing', () => {
  it('covers the rectangle', () => {
    const op = planSurfacing({ width: 50, height: 30, diameter: 6, depth: 0.5, stepover: 0.5, stepdown: 0.5, feed: 800, plungeFeed: 200, spindle: 1000, safeZ: 2 });
    const info = analyzeProgram(prepareProgram(emitGcode(op)));
    expect(info.cutBounds!.min).toEqual([0, 0, -0.5]);
    expect(info.cutBounds!.max.slice(0, 2)).toEqual([50, 30]);
  });
});

describe('edgeDistanceField', () => {
  it('puts the zero level on the pixel boundary', () => {
    const f = edgeDistanceField(new Uint8Array([1, 0, 0]), 3, 1, 1);
    expect([...f]).toEqual([-0.5, 0.5, 1.5]);
  });
});
