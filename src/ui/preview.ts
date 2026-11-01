import type { Move, ProgramInfo } from '../gcode/analyze';
import type { Vec3 } from '../machine/status';

/** A bitmap placed on the bed, e.g. what the carved block will look like. Sizes in mm, bottom-left at X0 Y0. */
export interface ImageLayer {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

interface Chunk {
  firstLine: number;
  lastLine: number;
  moves: Move[];
  rapid: Path2D;
  cuts: Path2D[];
  all: Path2D;
}

const DEPTH_BUCKETS = 4;
const CHUNK = 400;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Top-down view of the bed: grid, background image, toolpaths (coloured by depth) and the live tool position. */
export class PreviewCanvas {
  mode: 'toolpath' | 'print' = 'toolpath';
  private ctx: CanvasRenderingContext2D;
  private scale = 2;
  private ox = 40;
  private oy = 300;
  private chunks: Chunk[] = [];
  private info: ProgramInfo | null = null;
  private block: ImageLayer | null = null;
  private print: ImageLayer | null = null;
  private doneLine = -1;
  private tool: Vec3 | null = null;
  private pending = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.redraw());
    this.bindInteraction();
  }

  setProgram(info: ProgramInfo | null, block: ImageLayer | null): void {
    this.info = info;
    this.block = block;
    this.doneLine = -1;
    this.chunks = [];
    if (info) {
      const deepest = Math.min(-0.001, info.cutBounds?.min[2] ?? 0);
      for (let i = 0; i < info.moves.length; i += CHUNK) {
        const moves = info.moves.slice(i, i + CHUNK);
        const chunk: Chunk = {
          firstLine: moves[0].line,
          lastLine: moves[moves.length - 1].line,
          moves,
          rapid: new Path2D(),
          cuts: Array.from({ length: DEPTH_BUCKETS }, () => new Path2D()),
          all: new Path2D(),
        };
        for (const m of moves) {
          const target = m.rapid ? chunk.rapid : chunk.cuts[bucket(m, deepest)];
          target.moveTo(m.from[0], m.from[1]);
          target.lineTo(m.to[0], m.to[1]);
          if (!m.rapid) {
            chunk.all.moveTo(m.from[0], m.from[1]);
            chunk.all.lineTo(m.to[0], m.to[1]);
          }
        }
        this.chunks.push(chunk);
      }
    }
    this.fit();
  }

  setPrint(layer: ImageLayer | null): void {
    this.print = layer;
    if (this.mode === 'print') this.fit();
  }

  setProgress(doneLine: number): void {
    if (doneLine !== this.doneLine) {
      this.doneLine = doneLine;
      this.redraw();
    }
  }

  setTool(position: Vec3 | null): void {
    const same = position && this.tool && position.every((v, i) => v === this.tool![i]);
    if (!same && (position || this.tool)) {
      this.tool = position;
      if (this.mode === 'toolpath') this.redraw();
    }
  }

  setMode(mode: 'toolpath' | 'print'): void {
    this.mode = mode;
    this.fit();
  }

  /** Zooms to show the program, its background image and the origin. */
  fit(): void {
    let minX = 0, minY = 0, maxX = 50, maxY = 50;
    const include = (x0: number, y0: number, x1: number, y1: number, first: boolean) => {
      if (first) [minX, minY, maxX, maxY] = [x0, y0, x1, y1];
      minX = Math.min(minX, x0); minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
    };
    if (this.mode === 'print') {
      if (this.print) include(0, 0, this.print.width, this.print.height, true);
    } else {
      const b = this.info?.cutBounds;
      if (b) include(Math.min(0, b.min[0]), Math.min(0, b.min[1]), b.max[0], b.max[1], true);
      if (this.block) include(0, 0, this.block.width, this.block.height, !b);
    }
    const { width, height } = this.canvas.getBoundingClientRect();
    const pad = 28;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    this.scale = Math.max(0.05, Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY));
    this.ox = (width - spanX * this.scale) / 2 - minX * this.scale;
    this.oy = height - ((height - spanY * this.scale) / 2 - minY * this.scale);
    this.redraw();
  }

  redraw(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.fit();
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css('--canvas-bg');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Work coordinates → device pixels, Y up.
    const toDevice = () => ctx.setTransform(this.scale * dpr, 0, 0, -this.scale * dpr, this.ox * dpr, this.oy * dpr);
    const px = 1 / this.scale;
    toDevice();

    if (this.mode === 'print') {
      if (this.print) this.drawLayer(this.print);
      return;
    }

    this.drawGrid(px);
    if (this.block) this.drawLayer(this.block);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const done = css('--done');
    const rapidColor = css('--rapid');
    const cutColors = depthColors(css('--text'));
    for (const chunk of this.chunks) {
      if (chunk.lastLine < this.doneLine) {
        ctx.strokeStyle = done;
        ctx.lineWidth = 2 * px;
        ctx.stroke(chunk.all);
        continue;
      }
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.lineWidth = px;
      ctx.strokeStyle = rapidColor;
      ctx.stroke(chunk.rapid);
      ctx.setLineDash([]);
      ctx.lineWidth = 1.2 * px;
      chunk.cuts.forEach((path, i) => {
        ctx.strokeStyle = cutColors[i];
        ctx.stroke(path);
      });
      if (chunk.firstLine < this.doneLine) {
        ctx.strokeStyle = done;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        for (const m of chunk.moves) {
          if (m.line >= this.doneLine) break;
          if (m.rapid) continue;
          ctx.moveTo(m.from[0], m.from[1]);
          ctx.lineTo(m.to[0], m.to[1]);
        }
        ctx.stroke();
      }
    }

    if (this.tool) {
      const [x, y] = this.tool;
      ctx.strokeStyle = css('--tool');
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(x, y, 5 * px, 0, Math.PI * 2);
      ctx.moveTo(x - 9 * px, y);
      ctx.lineTo(x + 9 * px, y);
      ctx.moveTo(x, y - 9 * px);
      ctx.lineTo(x, y + 9 * px);
      ctx.stroke();
    }
  }

  private drawLayer(layer: ImageLayer): void {
    const { ctx } = this;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // Images are stored top row first; flip back so they sit upright in Y-up space.
    ctx.translate(0, layer.height);
    ctx.scale(1, -1);
    ctx.drawImage(layer.canvas, 0, 0, layer.width, layer.height);
    ctx.restore();
  }

  private drawGrid(px: number): void {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const x0 = -this.ox / this.scale;
    const x1 = (canvas.width / dpr - this.ox) / this.scale;
    const y1 = this.oy / this.scale;
    const y0 = (this.oy - canvas.height / dpr) / this.scale;
    const step = this.scale > 4 ? 10 : this.scale > 0.8 ? 50 : 100;
    ctx.lineWidth = px;
    ctx.strokeStyle = css('--grid');
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    ctx.strokeStyle = css('--grid-strong');
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.moveTo(0, y0); ctx.lineTo(0, y1);
    ctx.moveTo(x0, 0); ctx.lineTo(x1, 0);
    ctx.stroke();
  }

  private bindInteraction(): void {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.ox = mx - (mx - this.ox) * factor;
      this.oy = my - (my - this.oy) * factor;
      this.scale *= factor;
      this.redraw();
    }, { passive: false });
    let drag: { x: number; y: number } | null = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.ox += e.clientX - drag.x;
      this.oy += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      this.redraw();
    });
    const end = () => {
      drag = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => this.fit());
  }
}

function bucket(m: Move, deepest: number): number {
  const depth = Math.min(m.from[2], m.to[2]);
  if (depth >= 0) return 0;
  return Math.min(DEPTH_BUCKETS - 1, Math.floor((depth / deepest) * DEPTH_BUCKETS));
}

/** Shallow cuts lighter, deep cuts in the full text colour. */
function depthColors(base: string): string[] {
  return Array.from({ length: DEPTH_BUCKETS }, (_, i) => `color-mix(in srgb, ${base} ${35 + (65 * (i + 1)) / DEPTH_BUCKETS}%, transparent)`);
}

/** Paints a coverage/mask bitmap into a canvas using the given colours per value. */
export function bitmapLayer(
  values: Uint8Array,
  width: number,
  height: number,
  res: number,
  colors: Record<number, string>,
  mirror = false,
): ImageLayer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const rgb = Object.fromEntries(Object.entries(colors).map(([k, c]) => [k, parseColor(ctx, c)]));
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * width + (mirror ? width - 1 - x : x);
      const c = rgb[values[src]] ?? [255, 0, 255];
      const o = (y * width + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, width: width * res, height: height * res };
}

function parseColor(ctx: CanvasRenderingContext2D, color: string): [number, number, number] {
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

export { css as cssVar };
