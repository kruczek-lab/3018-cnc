export type Point = [number, number];

export interface Polyline {
  points: Point[];
  closed: boolean;
}

/**
 * Marching-squares iso-lines of `field` at `level`, in pixel-centre coordinates
 * (x = column, y = row). Lines that reach the image border come back open.
 */
export function isoContours(field: ArrayLike<number>, width: number, height: number, level: number): Polyline[] {
  const vEdgeBase = width * height;
  const hEdge = (x: number, y: number) => y * width + x; // between (x,y) and (x+1,y)
  const vEdge = (x: number, y: number) => vEdgeBase + y * width + x; // between (x,y) and (x,y+1)
  const points = new Map<number, Point>();
  const segments: [number, number][] = [];
  const touching = new Map<number, number[]>();

  const crossing = (edge: number, x0: number, y0: number, x1: number, y1: number) => {
    if (!points.has(edge)) {
      const a = field[y0 * width + x0];
      const b = field[y1 * width + x1];
      const t = a === b ? 0.5 : (level - a) / (b - a);
      points.set(edge, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
    return edge;
  };
  const add = (a: number, b: number) => {
    const index = segments.length;
    segments.push([a, b]);
    for (const e of [a, b]) {
      const list = touching.get(e);
      if (list) list.push(index);
      else touching.set(e, [index]);
    }
  };

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = field[y * width + x];
      const tr = field[y * width + x + 1];
      const br = field[(y + 1) * width + x + 1];
      const bl = field[(y + 1) * width + x];
      const c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const top = () => crossing(hEdge(x, y), x, y, x + 1, y);
      const bottom = () => crossing(hEdge(x, y + 1), x, y + 1, x + 1, y + 1);
      const left = () => crossing(vEdge(x, y), x, y, x, y + 1);
      const right = () => crossing(vEdge(x + 1, y), x + 1, y, x + 1, y + 1);
      const centreInside = (tl + tr + br + bl) / 4 >= level;
      switch (c) {
        case 1: case 14: add(left(), bottom()); break;
        case 2: case 13: add(bottom(), right()); break;
        case 3: case 12: add(left(), right()); break;
        case 4: case 11: add(top(), right()); break;
        case 6: case 9: add(top(), bottom()); break;
        case 7: case 8: add(left(), top()); break;
        case 5:
          if (centreInside) { add(left(), top()); add(bottom(), right()); }
          else { add(top(), right()); add(left(), bottom()); }
          break;
        case 10:
          if (centreInside) { add(top(), right()); add(left(), bottom()); }
          else { add(left(), top()); add(bottom(), right()); }
          break;
      }
    }
  }

  const used = new Uint8Array(segments.length);
  const next = (edge: number, from: number) => (touching.get(edge) ?? []).find((s) => s !== from && !used[s]);
  const lines: Polyline[] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const [a, b] = segments[start];
    const forward = [a, b];
    let seg = start;
    let edge = b;
    let closed = false;
    for (;;) {
      const s = next(edge, seg);
      if (s === undefined) break;
      used[s] = 1;
      edge = segments[s][0] === edge ? segments[s][1] : segments[s][0];
      seg = s;
      if (edge === a) {
        closed = true;
        break;
      }
      forward.push(edge);
    }
    if (!closed) {
      seg = start;
      edge = a;
      for (;;) {
        const s = next(edge, seg);
        if (s === undefined) break;
        used[s] = 1;
        edge = segments[s][0] === edge ? segments[s][1] : segments[s][0];
        seg = s;
        forward.unshift(edge);
      }
    }
    lines.push({ points: forward.map((e) => points.get(e)!), closed });
  }
  return lines;
}
