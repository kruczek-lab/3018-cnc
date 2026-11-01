import type { Vec3 } from '../machine/status';
import { parseWords } from './words';

export interface Move {
  /** Index into the prepared program lines. */
  line: number;
  from: Vec3;
  to: Vec3;
  rapid: boolean;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface ProgramInfo {
  moves: Move[];
  /** Bounds of cutting (non-rapid) moves, in work coordinates. */
  cutBounds: Bounds | null;
  cutLength: number;
  rapidLength: number;
  estimatedMinutes: number;
  warnings: string[];
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/**
 * Walks a prepared program to produce straight-line moves for the preview and a rough
 * time estimate. Arcs (G2/G3 with I/J) are broken into short segments.
 * `rapidRate` defaults to the 3018's stock max rate ($110) of 1000 mm/min.
 */
export function analyzeProgram(lines: string[], rapidRate = 1000): ProgramInfo {
  const moves: Move[] = [];
  const warnings = new Set<string>();
  let pos: Vec3 = [0, 0, 0];
  let absolute = true;
  let scale = 1;
  let motion = 0;
  let feed = 0;
  let cutLength = 0;
  let rapidLength = 0;
  let minutes = 0;
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];

  const push = (line: number, to: Vec3, rapid: boolean) => {
    const len = dist(pos, to);
    if (len === 0) return;
    moves.push({ line, from: pos, to, rapid });
    if (rapid) {
      rapidLength += len;
      minutes += len / rapidRate;
    } else {
      cutLength += len;
      minutes += len / Math.max(1, Math.min(feed, rapidRate));
      for (const p of [pos, to]) {
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], p[i]);
          max[i] = Math.max(max[i], p[i]);
        }
      }
    }
    pos = to;
  };

  lines.forEach((line, index) => {
    if (line.startsWith('$')) {
      if (line.startsWith('$J=')) warnings.add('Program contains jog commands; they are not previewed.');
      return;
    }
    const words = parseWords(line);
    if (!words) {
      warnings.add(`Could not parse line ${index + 1}: ${line}`);
      return;
    }
    let target: Partial<Record<'X' | 'Y' | 'Z' | 'I' | 'J' | 'R', number>> = {};
    let nonModal = false;
    for (const [letter, value] of words) {
      switch (letter) {
        case 'G':
          if ([0, 1, 2, 3].includes(value)) motion = value;
          else if (value === 90) absolute = true;
          else if (value === 91) absolute = false;
          else if (value === 20) scale = 25.4;
          else if (value === 21) scale = 1;
          else if ([10, 28, 30, 53, 92].includes(value)) {
            nonModal = true;
            warnings.add(`G${value} changes coordinates in ways the preview does not follow.`);
          } else if (value === 38.2 || value === 38.3 || value === 38.4 || value === 38.5) {
            nonModal = true;
            warnings.add('Program contains probing moves; they are not previewed.');
          }
          break;
        case 'F':
          feed = value * scale;
          break;
        case 'X': case 'Y': case 'Z': case 'I': case 'J': case 'R':
          target[letter] = value * scale;
          break;
      }
    }
    if (nonModal) return;
    const axis = (i: 0 | 1 | 2, key: 'X' | 'Y' | 'Z') => {
      const v = target[key];
      if (v === undefined) return pos[i];
      return absolute ? v : pos[i] + v;
    };
    if (target.X === undefined && target.Y === undefined && target.Z === undefined) return;
    const end: Vec3 = [axis(0, 'X'), axis(1, 'Y'), axis(2, 'Z')];
    if (motion === 2 || motion === 3) {
      if (target.R !== undefined || (target.I === undefined && target.J === undefined)) {
        warnings.add('Radius-format arcs are previewed as straight lines.');
        push(index, end, false);
        return;
      }
      const cx = pos[0] + (target.I ?? 0);
      const cy = pos[1] + (target.J ?? 0);
      const r = Math.hypot(pos[0] - cx, pos[1] - cy);
      const a0 = Math.atan2(pos[1] - cy, pos[0] - cx);
      let a1 = Math.atan2(end[1] - cy, end[0] - cx);
      const cw = motion === 2;
      let sweep = a1 - a0;
      if (cw && sweep >= 0) sweep -= 2 * Math.PI;
      if (!cw && sweep <= 0) sweep += 2 * Math.PI;
      const steps = Math.max(4, Math.ceil((Math.abs(sweep) * r) / 0.5));
      const z0 = pos[2];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const a = a0 + sweep * t;
        const p: Vec3 = s === steps ? end : [cx + r * Math.cos(a), cy + r * Math.sin(a), z0 + (end[2] - z0) * t];
        push(index, p, false);
      }
      return;
    }
    push(index, end, motion === 0);
  });

  return {
    moves,
    cutBounds: Number.isFinite(min[0]) ? { min, max } : null,
    cutLength,
    rapidLength,
    estimatedMinutes: minutes,
    warnings: [...warnings],
  };
}
