import type { Mask } from './mask';
import { edgeDistanceField, squaredDistanceTo } from './distance';
import { isoContours, type Point } from './contours';
import { simplify } from './simplify';
import { orderPaths, type CutPath, type Operation } from './operation';

export interface VBitSettings {
  /** Included angle, e.g. 30 for a 30° engraving bit. */
  angle: number;
  /** Width of the flat at the tip (many cheap "V" bits have 0.1–0.2 mm). */
  tipDiameter: number;
  /** Depth of the outline cut along the edges of the kept areas. */
  depth: number;
  /** Shallowest cut worth making when carving into narrow gaps and sharp corners. */
  minDepth: number;
  feed: number;
  plungeFeed: number;
  spindle: number;
}

export interface ClearingSettings {
  diameter: number;
  depth: number;
  /** Fraction of the diameter between raster rows. */
  stepover: number;
  stepdown: number;
  feed: number;
  plungeFeed: number;
  spindle: number;
}

export interface CarveSettings {
  safeZ: number;
  detail: VBitSettings;
  /** Optional flat end mill to clear the big open areas quickly. */
  clearing: ClearingSettings | null;
}

export const COVERAGE = { keep: 0, cut: 1, missed: 2 } as const;

export interface CarvePlan {
  operations: Operation[];
  /** Per mask pixel: 0 = surface left, 1 = carved, 2 = should be carved but no tool fits. */
  coverage: Uint8Array;
  missedArea: number;
}

/**
 * Plans the cuts that remove everything outside the kept area.
 *
 * Everything is driven by one distance field: the distance from each pixel to the nearest kept
 * pixel. A V-bit cut at depth z removes material out to a surface radius r(z), so a V-bit
 * following the iso-line at distance r(z) cuts right up to the edge with a sloped wall that
 * supports the printing surface. Further iso-lines at full depth widen the cut; shallower ones
 * reach into narrow gaps and sharp corners. A flat end mill clears whatever is far enough
 * from any edge. A coverage bitmap tracks what has been cut so redundant passes are dropped.
 */
export function planCarve(mask: Mask, settings: CarveSettings): CarvePlan {
  const { width: w, height: h, res, keep } = mask;
  const field = edgeDistanceField(keep, w, h, res);
  const cut = new Uint8Array(w * h);
  const toMM = (p: Point, z: number): [number, number, number] => [(p[0] + 0.5) * res, (h - p[1] - 0.5) * res, -z];
  const operations: Operation[] = [];

  const v = settings.detail;
  const tanHalf = Math.tan(((v.angle / 2) * Math.PI) / 180);
  const tipR = v.tipDiameter / 2;
  const radiusAt = (depth: number) => tipR + depth * tanHalf;
  const outline = radiusAt(v.depth);

  let maxField = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > maxField && field[i] < 1e6) maxField = field[i];
  if (maxField === 0 && field.length && field[0] >= 1e6) maxField = Math.hypot(w, h) * res;

  // 1. Clearing with a flat end mill: its edge reaches the centre line of the V-bit outline.
  const clearing = settings.clearing;
  if (clearing) {
    const radius = clearing.diameter / 2;
    const reach = outline + radius;
    const centres = new Uint8Array(w * h);
    for (let i = 0; i < field.length; i++) centres[i] = field[i] >= reach ? 1 : 0;
    const paths = rasterRuns(centres, w, h, Math.max(1, Math.round((clearing.diameter * clearing.stepover) / res)))
      .map((run) => run.map((p) => toMM(p, clearing.depth)));
    const boundary = isoContours(field, w, h, reach)
      .map((line) => closedPoints(line.points, line.closed, 0.5))
      .filter((pts) => pts.length > 1)
      .map((pts) => pts.map((p) => toMM(p, clearing.depth)));
    const d2 = squaredDistanceTo(centres, w, h);
    const r2 = (radius / res) ** 2;
    for (let i = 0; i < cut.length; i++) if (!keep[i] && d2[i] <= r2) cut[i] = 1;
    if (paths.length || boundary.length) {
      operations.push({
        name: 'Clearing',
        tool: `${clearing.diameter} mm flat end mill`,
        spindle: clearing.spindle,
        feed: clearing.feed,
        plungeFeed: clearing.plungeFeed,
        stepdown: clearing.stepdown,
        safeZ: settings.safeZ,
        paths: [...paths, ...orderPaths(boundary, lastPoint(paths))],
      });
    }
  }

  // 2. Detail with the V-bit.
  const levels: { distance: number; depth: number }[] = [{ distance: outline, depth: v.depth }];
  const widenStep = Math.max(outline, res);
  const widenLimit = clearing ? outline + clearing.diameter / 2 + widenStep : maxField;
  for (let d = outline + widenStep; d <= Math.min(widenLimit, maxField); d += widenStep) levels.push({ distance: d, depth: v.depth });
  const shallowest = radiusAt(Math.min(v.minDepth, v.depth));
  for (let d = outline - res; d >= shallowest - 1e-9; d -= res) levels.push({ distance: d, depth: (d - tipR) / tanHalf });

  const detail: CutPath[] = [];
  for (const { distance, depth } of levels) {
    const rPix = distance / res;
    const r2 = rPix * rPix;
    const reach = Math.ceil(rPix);
    const disk = (p: Point, visit: (i: number) => boolean | void) => {
      const x0 = Math.max(0, Math.floor(p[0] - reach));
      const x1 = Math.min(w - 1, Math.ceil(p[0] + reach));
      const y0 = Math.max(0, Math.floor(p[1] - reach));
      const y1 = Math.min(h - 1, Math.ceil(p[1] + reach));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if ((x - p[0]) ** 2 + (y - p[1]) ** 2 <= r2 && visit(y * w + x)) return true;
        }
      }
      return false;
    };
    const levelPaths: CutPath[] = [];
    for (const line of isoContours(field, w, h, distance)) {
      const pts = line.points;
      const needed = pts.map((p) => disk(p, (i) => !keep[i] && !cut[i]));
      for (const run of neededRuns(needed, line.closed)) {
        const runPts = run.map((i) => pts[i]);
        for (const p of runPts) disk(p, (i) => { if (!keep[i]) cut[i] = 1; });
        const closed = run.length === pts.length && line.closed;
        levelPaths.push(closedPoints(runPts, closed, 0.5).map((p) => toMM(p, depth)));
      }
    }
    detail.push(...levelPaths);
  }
  if (detail.length) {
    operations.push({
      name: 'Detail',
      tool: `${v.angle}° V-bit`,
      spindle: v.spindle,
      feed: v.feed,
      plungeFeed: v.plungeFeed,
      stepdown: v.depth,
      safeZ: settings.safeZ,
      // Every pass goes straight to its own depth, so the order is free: minimise travel.
      paths: orderPaths(detail),
    });
  }

  const coverage = new Uint8Array(w * h);
  let missed = 0;
  for (let i = 0; i < coverage.length; i++) {
    if (keep[i]) coverage[i] = COVERAGE.keep;
    else if (cut[i]) coverage[i] = COVERAGE.cut;
    else {
      coverage[i] = COVERAGE.missed;
      missed++;
    }
  }
  return { operations, coverage, missedArea: missed * res * res };
}

function lastPoint(paths: CutPath[]): [number, number] {
  const last = paths[paths.length - 1];
  return last ? [last[last.length - 1][0], last[last.length - 1][1]] : [0, 0];
}

/** Simplifies, and for closed loops repeats the first point at the end. */
function closedPoints(points: Point[], closed: boolean, tolerance: number): Point[] {
  if (!closed) return simplify(points, tolerance);
  const loop = simplify([...points, points[0]], tolerance);
  return loop.length < 3 ? [points[0]] : loop;
}

/** Index runs of consecutive `true`, each grown by one point either side so cuts overlap. */
function neededRuns(needed: boolean[], closed: boolean): number[][] {
  const n = needed.length;
  if (needed.every(Boolean)) return [Array.from({ length: n }, (_, i) => i)];
  if (!needed.some(Boolean)) return [];
  const runs: number[][] = [];
  const startAt = closed ? needed.findIndex((x) => !x) : 0;
  let run: number[] | null = null;
  for (let k = 0; k < n; k++) {
    const i = (startAt + k) % n;
    if (needed[i]) {
      if (!run) {
        run = [];
        const before = i - 1;
        if (before >= 0 || closed) run.push((before + n) % n);
      }
      run.push(i);
    } else if (run) {
      run.push(i);
      runs.push(run);
      run = null;
    }
  }
  if (run) {
    if (closed) run.push(startAt);
    runs.push(run);
  }
  return runs;
}

/**
 * Zig-zag raster over the allowed tool-centre pixels, every `rowStep` rows. Consecutive runs
 * are joined into one path when the straight link between them stays inside the allowed area.
 */
function rasterRuns(allowed: Uint8Array, w: number, h: number, rowStep: number): Point[][] {
  const paths: Point[][] = [];
  let current: Point[] | null = null;
  const inside = (a: Point, b: Point) => {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2);
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      const x = Math.round(a[0] + (b[0] - a[0]) * t);
      const y = Math.round(a[1] + (b[1] - a[1]) * t);
      if (!allowed[y * w + x]) return false;
    }
    return true;
  };
  const rows: number[] = [];
  for (let y = Math.floor(rowStep / 2); y < h; y += rowStep) rows.push(y);
  rows.forEach((y, rowIndex) => {
    const runs: [number, number][] = [];
    for (let x = 0; x < w; x++) {
      if (!allowed[y * w + x]) continue;
      const start = x;
      while (x + 1 < w && allowed[y * w + x + 1]) x++;
      runs.push([start, x]);
    }
    const reverse = rowIndex % 2 === 1;
    if (reverse) runs.reverse();
    for (const [a, b] of runs) {
      const from: Point = reverse ? [b, y] : [a, y];
      const to: Point = reverse ? [a, y] : [b, y];
      const last = current?.[current.length - 1];
      if (current && last && Math.abs(last[1] - y) <= rowStep && inside(last, from)) current.push(from, to);
      else {
        if (current) paths.push(current);
        current = [from, to];
      }
    }
  });
  if (current) paths.push(current);
  return paths;
}
