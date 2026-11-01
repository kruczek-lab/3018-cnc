export type Word = [letter: string, value: number];

const WORD = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;

/** Splits a cleaned (upper-case, no spaces/comments) G-code line into words. Returns null if malformed. */
export function parseWords(line: string): Word[] | null {
  const words: Word[] = [];
  let consumed = 0;
  WORD.lastIndex = 0;
  for (let m = WORD.exec(line); m; m = WORD.exec(line)) {
    if (m.index !== consumed) return null;
    words.push([m[1], Number(m[2])]);
    consumed = WORD.lastIndex;
  }
  return consumed === line.length ? words : null;
}
