import type { CutPath, Operation } from './operation';

export interface SurfacingSettings {
  width: number;
  height: number;
  diameter: number;
  depth: number;
  stepover: number;
  stepdown: number;
  feed: number;
  plungeFeed: number;
  spindle: number;
  safeZ: number;
}

/** Flattens a rectangle from X0 Y0 with a zig-zag, e.g. to level the spoilboard before carving shallow work. */
export function planSurfacing(s: SurfacingSettings): Operation {
  const step = Math.max(0.05, s.diameter * s.stepover);
  const rows = Math.max(1, Math.ceil(s.height / step));
  const path: CutPath = [];
  for (let r = 0; r <= rows; r++) {
    const y = Math.min(r * step, s.height);
    const [x0, x1] = r % 2 === 0 ? [0, s.width] : [s.width, 0];
    path.push([x0, y, -s.depth], [x1, y, -s.depth]);
  }
  return {
    name: 'Surfacing',
    tool: `${s.diameter} mm flat end mill`,
    spindle: s.spindle,
    feed: s.feed,
    plungeFeed: s.plungeFeed,
    stepdown: s.stepdown,
    safeZ: s.safeZ,
    paths: [path],
  };
}
