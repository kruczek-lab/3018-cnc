import type { CutPath } from './operation';

export type Rotation = 0 | 90 | 180 | 270;

/** Where a design goes on the material: turned anticlockwise, then its bottom-left corner moved to (x, y). */
export interface Placement {
  x: number;
  y: number;
  rotation: Rotation;
}

/** Rotates a point of a width × height design anticlockwise and moves the design's corner to the placement. */
export function placePoint(px: number, py: number, width: number, height: number, p: Placement): [number, number] {
  // Exact cases (no trig) so right angles don't leave 1e-16 noise in the G-code.
  switch (p.rotation) {
    case 90: return [p.x + height - py, p.y + px];
    case 180: return [p.x + width - px, p.y + height - py];
    case 270: return [p.x + py, p.y + width - px];
    default: return [p.x + px, p.y + py];
  }
}

export function placePaths(paths: CutPath[], width: number, height: number, p: Placement): CutPath[] {
  if (!p.rotation && !p.x && !p.y) return paths;
  return paths.map((path) => path.map(([x, y, z]) => [...placePoint(x, y, width, height, p), z]));
}
