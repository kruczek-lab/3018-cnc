import type { Bounds } from './analyze';
import { formatNumber as n } from '../cam/operation';

/**
 * A program that moves around the edge of a job with the bit raised and the spindle off,
 * pausing a moment at each corner, so you can see where the job will land on the material.
 */
export function traceOutline(bounds: Bounds, liftZ: number): string[] {
  const [x0, y0] = bounds.min;
  const [x1, y1] = bounds.max;
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  return [
    'G21G90',
    'M5',
    `G0Z${n(liftZ)}`,
    ...corners.flatMap(([x, y]) => [`G0X${n(x)}Y${n(y)}`, 'G4P0.5']),
  ];
}
