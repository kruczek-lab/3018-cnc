import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A preview image stored with a file, e.g. what the carved block will look like. */
export interface StoredLayer {
  /** PNG data URL. */
  png: string;
  /** Size in mm, and where it sits on the bed. */
  width: number;
  height: number;
  x?: number;
  y?: number;
  rotation?: number;
}

export interface FileMeta {
  id: string;
  name: string;
  tool: string;
  /** One-line description shown in the file list, e.g. size, depth and time. */
  summary: string;
  createdAt: number;
}

export interface StoredFile extends FileMeta {
  gcode: string;
  layers: { block?: StoredLayer; print?: StoredLayer };
}

export type NewFile = Omit<StoredFile, 'id' | 'createdAt'>;

const ID = /^[a-z0-9]{6,32}$/;
const MAX_LAYER_BYTES = 8 * 1024 * 1024;

/**
 * G-code files kept on the Pi, so every device sees the same list and nothing is lost when a
 * browser is closed. Each file is `<id>.nc` plus `<id>.json` (name, tool, previews) in `dir/files`.
 * Shared settings live in `dir/settings.json`.
 */
export class FileStore {
  private filesDir: string;
  private index = new Map<string, FileMeta>();

  constructor(private dir: string) {
    this.filesDir = join(dir, 'files');
    mkdirSync(this.filesDir, { recursive: true });
    for (const name of readdirSync(this.filesDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const { id, name: fileName, tool, summary, createdAt } = JSON.parse(readFileSync(join(this.filesDir, name), 'utf8')) as StoredFile;
        if (ID.test(id)) this.index.set(id, { id, name: fileName, tool, summary, createdAt });
      } catch {
        /* skip a damaged entry */
      }
    }
  }

  /** Newest first. */
  list(): FileMeta[] {
    return [...this.index.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  add(file: NewFile): FileMeta {
    const id = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    const meta: FileMeta = { id, name: file.name, tool: file.tool, summary: file.summary, createdAt: Date.now() };
    const layers = Object.fromEntries(
      Object.entries(file.layers ?? {}).filter(([, l]) => l && typeof l.png === 'string' && l.png.startsWith('data:image/png;base64,') && l.png.length < MAX_LAYER_BYTES),
    );
    this.write(`${id}.nc`, file.gcode);
    this.write(`${id}.json`, JSON.stringify({ ...meta, layers }));
    this.index.set(id, meta);
    return meta;
  }

  get(id: string): StoredFile | null {
    const meta = ID.test(id) ? this.index.get(id) : undefined;
    if (!meta) return null;
    const { layers } = JSON.parse(readFileSync(join(this.filesDir, `${id}.json`), 'utf8')) as StoredFile;
    return { ...meta, layers: layers ?? {}, gcode: readFileSync(join(this.filesDir, `${id}.nc`), 'utf8') };
  }

  remove(id: string): boolean {
    if (!ID.test(id) || !this.index.delete(id)) return false;
    rmSync(join(this.filesDir, `${id}.nc`), { force: true });
    rmSync(join(this.filesDir, `${id}.json`), { force: true });
    return true;
  }

  settings(): Record<string, string | boolean> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'settings.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  saveSettings(values: Record<string, string | boolean>): void {
    const tmp = join(this.dir, 'settings.json.tmp');
    writeFileSync(tmp, JSON.stringify(values));
    renameSync(tmp, join(this.dir, 'settings.json'));
  }

  // Write to a temporary name first so a power cut never leaves half a file behind.
  private write(name: string, data: string): void {
    const tmp = join(this.filesDir, `${name}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, join(this.filesDir, name));
  }
}
