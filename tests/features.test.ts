import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioServer } from '../server/studio';
import { FileStore } from '../server/files';
import { placePaths, placePoint } from '../src/cam/placement';
import { resumeFrom } from '../src/gcode/resume';
import { analyzeProgram } from '../src/gcode/analyze';
import { prepareProgram } from '../src/gcode/clean';
import { emitGcode } from '../src/cam/operation';

describe('placement', () => {
  it('turns a 40 × 20 design anticlockwise and puts its corner at the offset', () => {
    const p = (rotation: 0 | 90 | 180 | 270) => ({ x: 10, y: 5, rotation });
    // The design's own bottom-right corner (40, 0) …
    expect(placePoint(40, 0, 40, 20, p(0))).toEqual([50, 5]);
    expect(placePoint(40, 0, 40, 20, p(90))).toEqual([30, 45]);
    expect(placePoint(40, 0, 40, 20, p(180))).toEqual([10, 25]);
    expect(placePoint(40, 0, 40, 20, p(270))).toEqual([10, 5]);
  });

  it('keeps the placed design inside the box that starts at the offset', () => {
    const path = [[0, 0, -1], [40, 0, -1], [40, 20, -1], [0, 20, -1]] as [number, number, number][];
    for (const rotation of [0, 90, 180, 270] as const) {
      const [placed] = placePaths([path], 40, 20, { x: 10, y: 5, rotation });
      const xs = placed.map((q) => q[0]);
      const ys = placed.map((q) => q[1]);
      const [w, h] = rotation % 180 ? [20, 40] : [40, 20];
      expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual([10, 5, 10 + w, 5 + h]);
      expect(placed.every((q) => q[2] === -1)).toBe(true);
    }
  });
});

describe('resumeFrom', () => {
  const program = prepareProgram(emitGcode({
    name: 't', tool: 'bit', spindle: 800, feed: 600, plungeFeed: 150, stepdown: 1, safeZ: 3,
    paths: [[[0, 0, -1], [10, 0, -1]], [[20, 20, -0.5], [30, 20, -0.5], [30, 30, -0.5]]],
  }));

  it('restores spindle, position and feed, then carries on from the chosen line', () => {
    const start = program.indexOf('G1X30Y20Z-0.5F600');
    const { lines, preamble } = resumeFrom(program, start, 3);
    expect(lines.slice(0, preamble)).toEqual(['G21', 'G90', 'G0Z3', 'M3S800', 'G4P3', 'G0X20Y20', 'G1Z-0.5F150', 'F150', 'G1']);
    expect(lines.slice(preamble)).toEqual(program.slice(start));
    // The resumed cut follows the same path as the original from that point.
    const resumed = analyzeProgram(lines).moves.filter((m) => !m.rapid).map((m) => m.to);
    expect(resumed.slice(-2)).toEqual([[30, 20, -0.5], [30, 30, -0.5]]);
  });

  it('refuses programs that can\'t be picked up safely', () => {
    expect(() => resumeFrom(['G91', 'G1X1F100', 'G1X2'], 2, 3)).toThrow(/relative/);
    expect(() => resumeFrom(['G28', 'G1X1F100', 'G1X2'], 2, 3)).toThrow(/coordinates/);
    expect(resumeFrom(program, 0, 3).lines).toBe(program);
  });
});

describe('FileStore', () => {
  it('keeps files across restarts, newest first, and drops bad previews', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    const store = new FileStore(dir);
    const a = store.add({ name: 'a.nc', tool: 'V-bit', summary: 's', gcode: 'G0X1', layers: { block: { png: 'data:image/png;base64,AAAA', width: 10, height: 5, rotation: 90 } } });
    const b = store.add({ name: 'b.nc', tool: '', summary: '', gcode: 'G0X2', layers: { print: { png: 'javascript:alert(1)', width: 1, height: 1 } } });
    const again = new FileStore(dir);
    expect(again.list().map((f) => f.name).sort()).toEqual(['a.nc', 'b.nc']);
    expect(again.get(a.id)?.layers.block?.rotation).toBe(90);
    expect(again.get(b.id)?.layers).toEqual({});
    expect(again.get('../../etc/passwd')).toBeNull();
    expect(again.remove(a.id)).toBe(true);
    expect(new FileStore(dir).list().map((f) => f.name)).toEqual(['b.nc']);
    again.saveSettings({ vAngle: '20', imgMirror: true });
    expect(new FileStore(dir).settings()).toEqual({ vAngle: '20', imgMirror: true });
  });
});

describe('server files and settings API', () => {
  let studio: StudioServer | null = null;
  afterEach(async () => studio?.close());

  it('adds, lists, fetches and deletes files, and shares settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-'));
    writeFileSync(join(dir, 'index.html'), 'app');
    studio = new StudioServer({ staticDir: dir, dataDir: mkdtempSync(join(tmpdir(), 'data-')) });
    const base = `http://127.0.0.1:${await studio.listen(0, '127.0.0.1')}`;
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(body) });
    const meta = await (await post('/api/files', { name: 'lino 1-clearing.nc', tool: '3 mm end mill', summary: '80 × 50 mm', gcode: 'G0 X1\n' })).json();
    expect(meta.name).toBe('lino 1-clearing.nc');
    expect((await (await fetch(base + '/api/files')).json()).files.map((f: { id: string }) => f.id)).toEqual([meta.id]);
    expect((await (await fetch(`${base}/api/files/${meta.id}`)).json()).gcode).toBe('G0 X1\n');
    expect((await post('/api/files', { name: '', gcode: 'x' })).status).toBe(400);
    expect((await post('/api/files/delete', { id: meta.id })).status).toBe(200);
    expect((await fetch(`${base}/api/files/${meta.id}`)).status).toBe(404);
    expect((await post('/api/settings', { values: { vAngle: '30', clearEnabled: false } })).status).toBe(200);
    expect((await (await fetch(base + '/api/settings')).json()).values).toEqual({ vAngle: '30', clearEnabled: false });
    expect((await post('/api/settings', { values: { bad: { nested: 1 } } })).status).toBe(400);
  });
});
