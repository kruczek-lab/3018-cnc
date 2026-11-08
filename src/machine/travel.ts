import type { Vec3 } from './status';
import type { Move } from '../gcode/analyze';

/**
 * The box the machine can reach, in GRBL machine coordinates (MPos).
 *
 * Without limit switches GRBL counts position from wherever the machine was at power-on,
 * so the box comes from a reference: the user jogs to the X−/Y−/Z-top corner and says
 * "this is the corner". With switches, homing ($H) sets it exactly (GRBL's own convention:
 * machine coordinates run from −max travel up to 0 on every axis).
 */
export interface TravelLimits {
  source: 'reference' | 'homing';
  min: Vec3;
  max: Vec3;
}

/** The 3018-PRO's nominal travel in mm. */
export const DEFAULT_TRAVEL: Vec3 = [300, 180, 45];

export interface LimitViolation {
  axis: 0 | 1 | 2;
  side: 'min' | 'max';
  /** How far past the limit, in mm. */
  by: number;
}

/**
 * Limits from the reference corner: X at its minimum, Y at its minimum, Z at the top.
 * The margin keeps clear of the far ends; the corner itself is where the user put the machine.
 */
export function limitsFromReference(corner: Vec3, size: Vec3, margin: number): TravelLimits {
  return {
    source: 'reference',
    min: [corner[0], corner[1], corner[2] - size[2] + margin],
    max: [corner[0] + size[0] - margin, corner[1] + size[1] - margin, corner[2]],
  };
}

/** Limits after homing, from GRBL's max travel settings ($130–$132). */
export function limitsFromHoming(maxTravel: Vec3, margin: number): TravelLimits {
  return {
    source: 'homing',
    min: [-maxTravel[0] + margin, -maxTravel[1] + margin, -maxTravel[2] + margin],
    max: [0, 0, 0],
  };
}

const EPSILON = 1e-6;

/** Checks the end point of every move of a program (in work coordinates, offset by `wco`). */
export function checkMoves(moves: Move[], wco: Vec3, limits: TravelLimits): LimitViolation[] {
  const worst = new Map<string, LimitViolation>();
  const note = (axis: 0 | 1 | 2, side: 'min' | 'max', by: number) => {
    const key = `${axis}${side}`;
    if (by > EPSILON && by > (worst.get(key)?.by ?? 0)) worst.set(key, { axis, side, by });
  };
  for (const m of moves) {
    for (const axis of [0, 1, 2] as const) {
      const v = m.to[axis] + wco[axis];
      note(axis, 'min', limits.min[axis] - v);
      note(axis, 'max', v - limits.max[axis]);
    }
  }
  return [...worst.values()];
}

export function checkPoint(machinePos: Vec3, limits: TravelLimits): LimitViolation[] {
  return checkMoves([{ line: 0, from: machinePos, to: machinePos, rapid: true }], [0, 0, 0], limits);
}

const AXES = ['X', 'Y', 'Z'];

export function describeViolations(violations: LimitViolation[]): string {
  return violations
    .map(({ axis, side, by }) => {
      const where = axis === 2 ? (side === 'max' ? 'above the top of Z' : 'below the lowest point Z can reach') : `past the ${AXES[axis]}${side === 'max' ? '+' : '−'} end`;
      return `${by.toFixed(1)} mm ${where}`;
    })
    .join(', ');
}

/**
 * Shortens a jog so it stops at the limits. A jog that starts outside the box (e.g. after
 * the margin) may still move back inside, just not further out.
 */
export function clampJog(from: Vec3, delta: Vec3, limits: TravelLimits): Vec3 {
  return delta.map((d, i) => {
    const target = from[i] + d;
    if (d > 0) return Math.min(target, Math.max(from[i], limits.max[i])) - from[i];
    if (d < 0) return Math.max(target, Math.min(from[i], limits.min[i])) - from[i];
    return 0;
  }) as Vec3;
}
