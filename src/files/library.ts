import { prepareProgram } from '../gcode/clean';
import { analyzeProgram, type ProgramInfo } from '../gcode/analyze';
import type { ImageLayer } from '../ui/preview';
import type { RemoteMachine } from '../remote/remoteMachine';

export interface FileEntry {
  id: string;
  name: string;
  tool: string;
  /** One-line description for the list: size, depth, time. */
  summary: string;
  createdAt: number;
}

export interface LoadedFile extends FileEntry {
  text: string;
  lines: string[];
  info: ProgramInfo;
  /** What the carved block looks like (placed on the bed), and the print it makes. */
  block: ImageLayer | null;
  print: ImageLayer | null;
}

export interface NewFile {
  name: string;
  tool: string;
  text: string;
  block?: ImageLayer | null;
  print?: ImageLayer | null;
}

/** The list of G-code files: kept in this browser, or on the Pi so every device shares it. */
export interface Library {
  list(): FileEntry[];
  onChange(fn: () => void): void;
  add(file: NewFile): Promise<LoadedFile>;
  load(id: string): Promise<LoadedFile | null>;
  remove(id: string): Promise<void>;
}

const minutes = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);

export function summarize(info: ProgramInfo): string {
  const b = info.cutBounds;
  const size = b
    ? `${(b.max[0] - Math.min(0, b.min[0])).toFixed(1)} × ${(b.max[1] - Math.min(0, b.min[1])).toFixed(1)} mm, ${(-b.min[2]).toFixed(2)} mm deep`
    : 'no cutting moves';
  return `${size} · ~${minutes(info.estimatedMinutes)}`;
}

function loaded(entry: Omit<FileEntry, 'summary'>, text: string, block: ImageLayer | null, print: ImageLayer | null): LoadedFile {
  const lines = prepareProgram(text);
  const info = analyzeProgram(lines);
  return { ...entry, summary: summarize(info), text, lines, info, block, print };
}

/** Files kept in this browser tab only (USB mode). */
export class LocalLibrary implements Library {
  private files: LoadedFile[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;

  list(): FileEntry[] {
    return this.files;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  async add(file: NewFile): Promise<LoadedFile> {
    const entry = loaded({ id: `local${this.nextId++}`, name: file.name, tool: file.tool, createdAt: Date.now() }, file.text, file.block ?? null, file.print ?? null);
    this.files.unshift(entry);
    this.emit();
    return entry;
  }

  async load(id: string): Promise<LoadedFile | null> {
    return this.files.find((f) => f.id === id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.files = this.files.filter((f) => f.id !== id);
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

interface StoredLayer {
  png: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  rotation?: number;
}

const toStored = (layer: ImageLayer | null | undefined): StoredLayer | undefined =>
  layer ? { png: layer.canvas.toDataURL('image/png'), width: layer.width, height: layer.height, x: layer.x, y: layer.y, rotation: layer.rotation } : undefined;

async function fromStored(layer: StoredLayer | undefined): Promise<ImageLayer | null> {
  if (!layer) return null;
  const img = new Image();
  img.src = layer.png;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return { canvas, width: layer.width, height: layer.height, x: layer.x, y: layer.y, rotation: layer.rotation };
}

/** Files stored on the Pi: shared by every device and kept when browsers close. */
export class RemoteLibrary implements Library {
  private entries: FileEntry[] = [];
  private cache = new Map<string, LoadedFile>();
  private listeners = new Set<() => void>();

  constructor(private remote: RemoteMachine) {
    remote.onFiles((files) => {
      this.entries = files;
      for (const id of this.cache.keys()) if (!files.some((f) => f.id === id)) this.cache.delete(id);
      this.emit();
    });
  }

  list(): FileEntry[] {
    return this.entries;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  async add(file: NewFile): Promise<LoadedFile> {
    const lines = prepareProgram(file.text);
    const summary = summarize(analyzeProgram(lines));
    const meta = await this.remote.addFile({
      name: file.name,
      tool: file.tool,
      summary,
      gcode: file.text,
      layers: { block: toStored(file.block), print: toStored(file.print) },
    });
    const result = loaded(meta, file.text, file.block ?? null, file.print ?? null);
    this.cache.set(meta.id, result);
    if (!this.entries.some((e) => e.id === meta.id)) this.entries = [meta, ...this.entries];
    this.emit();
    return result;
  }

  async load(id: string): Promise<LoadedFile | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const stored = await this.remote.getFile(id).catch(() => null);
    if (!stored) return null;
    const file = loaded(stored, stored.gcode, await fromStored(stored.layers.block), await fromStored(stored.layers.print));
    this.cache.set(id, file);
    return file;
  }

  async remove(id: string): Promise<void> {
    await this.remote.removeFile(id);
    this.cache.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
