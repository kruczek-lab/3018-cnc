export type Point3 = [number, number, number];

/** One continuous cut: the tool plunges at the first point, follows the rest, then retracts. Z is negative into the material. */
export type CutPath = Point3[];

export interface Operation {
  name: string;
  tool: string;
  /** GRBL S value. The 3018's stock $30 is 1000, so S1000 is full speed. */
  spindle: number;
  feed: number;
  plungeFeed: number;
  /** Maximum depth per pass; deeper paths are cut in several passes. */
  stepdown: number;
  safeZ: number;
  paths: CutPath[];
  notes?: string[];
}

const n = (v: number) => {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

const samePoint = (a: Point3, b: Point3) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** Writes an operation as G-code for GRBL. Work zero: X0 Y0 at the design's bottom-left, Z0 on the material surface. */
export function emitGcode(op: Operation): string {
  const out: string[] = [
    `(${op.name})`,
    `(Tool: ${op.tool})`,
    '(Zero: X0 Y0 = bottom-left corner of the design, Z0 = top of the material)',
    ...(op.notes ?? []).map((note) => `(${note.replace(/[()]/g, '')})`),
    'G21 G90 G94 G17',
    `G0 Z${n(op.safeZ)}`,
    `M3 S${n(op.spindle)}`,
    'G4 P3',
  ];
  let feedSet: number | null = null;
  const cut = (x: number, y: number, z: number, feed: number) => {
    out.push(`G1 X${n(x)} Y${n(y)} Z${n(z)}${feed !== feedSet ? ` F${n(feed)}` : ''}`);
    feedSet = feed;
  };
  const plunge = (z: number) => {
    out.push(`G1 Z${n(z)}${op.plungeFeed !== feedSet ? ` F${n(op.plungeFeed)}` : ''}`);
    feedSet = op.plungeFeed;
  };

  for (const path of op.paths) {
    if (!path.length) continue;
    const deepest = Math.min(...path.map((p) => p[2]));
    const passes = Math.max(1, Math.ceil(-deepest / op.stepdown - 1e-9));
    const closed = path.length > 2 && samePoint(path[0], path[path.length - 1]);
    for (let pass = 1; pass <= passes; pass++) {
      const floor = pass === passes ? -Infinity : -pass * op.stepdown;
      const z = (p: Point3) => Math.max(p[2], floor);
      if (pass === 1 || !closed) {
        if (pass > 1) out.push(`G0 Z${n(op.safeZ)}`);
        out.push(`G0 X${n(path[0][0])} Y${n(path[0][1])}`);
      }
      plunge(z(path[0]));
      for (let i = 1; i < path.length; i++) cut(path[i][0], path[i][1], z(path[i]), op.feed);
    }
    out.push(`G0 Z${n(op.safeZ)}`);
  }
  out.push('M5', 'G0 X0 Y0', 'M2');
  return out.join('\n') + '\n';
}

/** Greedy nearest-neighbour ordering to cut down on travel. Closed loops may start anywhere; open paths may be reversed. */
export function orderPaths(paths: CutPath[], start: [number, number] = [0, 0]): CutPath[] {
  const remaining = paths.filter((p) => p.length > 0);
  const ordered: CutPath[] = [];
  let [cx, cy] = start;
  while (remaining.length) {
    let best = 0;
    let bestDist = Infinity;
    let bestIndex = 0;
    let bestReverse = false;
    remaining.forEach((path, pi) => {
      const closed = path.length > 2 && samePoint(path[0], path[path.length - 1]);
      if (closed) {
        for (let i = 0; i < path.length - 1; i++) {
          const d = Math.hypot(path[i][0] - cx, path[i][1] - cy);
          if (d < bestDist) [bestDist, best, bestIndex, bestReverse] = [d, pi, i, false];
        }
      } else {
        const d0 = Math.hypot(path[0][0] - cx, path[0][1] - cy);
        const last = path[path.length - 1];
        const d1 = Math.hypot(last[0] - cx, last[1] - cy);
        if (d0 < bestDist) [bestDist, best, bestIndex, bestReverse] = [d0, pi, 0, false];
        if (d1 < bestDist) [bestDist, best, bestIndex, bestReverse] = [d1, pi, 0, true];
      }
    });
    let path = remaining.splice(best, 1)[0];
    if (bestReverse) path = path.slice().reverse();
    else if (bestIndex > 0) path = [...path.slice(bestIndex, -1), ...path.slice(0, bestIndex + 1)];
    ordered.push(path);
    const end = path[path.length - 1];
    [cx, cy] = [end[0], end[1]];
  }
  return ordered;
}
