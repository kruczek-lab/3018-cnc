/** Strips comments and whitespace so the line takes as little of GRBL's 128-byte buffer as possible. */
export function cleanLine(raw: string): string {
  let s = raw.replace(/\([^)]*\)/g, '');
  const semicolon = s.indexOf(';');
  if (semicolon >= 0) s = s.slice(0, semicolon);
  s = s.replace(/\s+/g, '').toUpperCase();
  return s === '%' ? '' : s;
}

/** Turns a G-code file into the exact list of lines that will be streamed. */
export function prepareProgram(text: string): string[] {
  return text.split(/\r?\n/).map(cleanLine).filter((l) => l.length > 0);
}
