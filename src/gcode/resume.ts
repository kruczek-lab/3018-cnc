import { parseWords } from './words';
import { formatNumber as n } from '../cam/operation';

export interface ResumePlan {
  /** Lines to stream: a short preamble, then the program from the chosen line. */
  lines: string[];
  /** How many preamble lines come first. */
  preamble: number;
}

/**
 * Builds a program that picks a job up at `start` (index into the prepared lines). It replays the
 * modal state the earlier lines set up (units, feed, spindle, position), lifts to
 * `safeZ` (mm, work coordinates), starts the spindle, moves above where line `start` begins and
 * plunges there, then carries on with the rest of the program.
 */
export function resumeFrom(lines: string[], start: number, safeZ: number): ResumePlan {
  if (start <= 0) return { lines, preamble: 0 };
  if (start >= lines.length) throw new Error(`The program only has ${lines.length} lines.`);
  let inches = false;
  let motion = 0;
  let feed = 0;
  let spindle: 'M3' | 'M4' | 'M5' = 'M5';
  let speed = 0;
  const pos = [0, 0, 0];
  for (const [i, line] of lines.slice(0, start).entries()) {
    if (line.startsWith('$')) continue;
    const words = parseWords(line);
    if (!words) throw new Error(`Line ${i + 1} can't be read: ${line}`);
    const axes: (number | undefined)[] = [undefined, undefined, undefined];
    for (const [letter, value] of words) {
      if (letter === 'G') {
        if ([0, 1, 2, 3].includes(value)) motion = value;
        else if (value === 20) inches = true;
        else if (value === 21) inches = false;
        else if (value === 91) {
          // Relative moves depend on where the machine was when the job started, which isn't known.
          throw new Error(`Line ${i + 1} (${line}) uses relative moves (G91), so the job can't be picked up part-way.`);
        }
        else if ([10, 28, 30, 53, 92].includes(value) || (value >= 38 && value < 39)) {
          throw new Error(`Line ${i + 1} (${line}) changes coordinates, so the job can't be safely picked up after it.`);
        }
      } else if (letter === 'M') {
        if (value === 3 || value === 4 || value === 5) spindle = `M${value}` as 'M3' | 'M4' | 'M5';
        if (value === 2 || value === 30) spindle = 'M5';
      } else if (letter === 'S') speed = value;
      else if (letter === 'F') feed = value;
      else if (letter === 'X' || letter === 'Y' || letter === 'Z') axes['XYZ'.indexOf(letter)] = value;
    }
    axes.forEach((v, a) => {
      if (v !== undefined) pos[a] = v;
    });
  }
  const unit = inches ? 1 / 25.4 : 1;
  const lift = Math.max(safeZ * unit, pos[2]);
  const preamble = [
    inches ? 'G20' : 'G21',
    'G90',
    `G0Z${n(lift)}`,
    ...(spindle !== 'M5' ? [`${spindle}S${n(speed)}`, 'G4P3'] : []),
    `G0X${n(pos[0])}Y${n(pos[1])}`,
    `G1Z${n(pos[2])}F${n(Math.min(feed || 100 * unit, 200 * unit))}`,
    ...(feed ? [`F${n(feed)}`] : []),
    ...(motion === 0 || motion === 1 ? [`G${motion}`] : []),
  ];
  return { lines: [...preamble, ...lines.slice(start)], preamble: preamble.length };
}
