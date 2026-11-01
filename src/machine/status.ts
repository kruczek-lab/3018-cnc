export type Vec3 = [number, number, number];

export interface StatusReport {
  state: string;
  subState?: number;
  mpos?: Vec3;
  wpos?: Vec3;
  wco?: Vec3;
  feed?: number;
  spindle?: number;
  plannerFree?: number;
  rxFree?: number;
  pins?: string;
  overrides?: Vec3;
}

function vec3(text: string): Vec3 | undefined {
  const n = text.split(',').map(Number);
  return n.length >= 3 && n.every(Number.isFinite) ? [n[0], n[1], n[2]] : undefined;
}

/** Parses a GRBL 1.1 status report such as `<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>`. */
export function parseStatus(line: string): StatusReport | null {
  if (!line.startsWith('<') || !line.endsWith('>')) return null;
  const fields = line.slice(1, -1).split('|');
  const [state, sub] = fields[0].split(':');
  const report: StatusReport = { state };
  if (sub !== undefined) report.subState = Number(sub);
  for (const field of fields.slice(1)) {
    const colon = field.indexOf(':');
    if (colon < 0) continue;
    const key = field.slice(0, colon);
    const value = field.slice(colon + 1);
    switch (key) {
      case 'MPos': report.mpos = vec3(value); break;
      case 'WPos': report.wpos = vec3(value); break;
      case 'WCO': report.wco = vec3(value); break;
      case 'Ov': report.overrides = vec3(value); break;
      case 'Pn': report.pins = value; break;
      case 'FS': {
        const [f, s] = value.split(',').map(Number);
        report.feed = f;
        report.spindle = s;
        break;
      }
      case 'F': report.feed = Number(value); break;
      case 'Bf': {
        const [planner, rx] = value.split(',').map(Number);
        report.plannerFree = planner;
        report.rxFree = rx;
        break;
      }
    }
  }
  return report;
}
