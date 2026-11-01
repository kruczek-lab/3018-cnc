import type { Point } from './contours';
import { simplify } from './simplify';

/**
 * Samples every shape in an SVG (paths, lines, rects, circles, text converted to paths …) into
 * polylines, scaled so the drawing is `width` mm wide with its bottom-left at 0,0.
 * Uses the browser's own SVG engine, so transforms and curves are handled exactly.
 */
export function svgToPolylines(svgText: string, width: number, mirror: boolean): { lines: Point[][]; height: number } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG file');
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden';
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  host.appendChild(svg);
  document.body.appendChild(host);
  try {
    const shapes = [...svg.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')] as SVGGeometryElement[];
    const raw: Point[][] = [];
    const lengths = shapes.map((el) => el.getTotalLength());
    const box = svg.getBBox();
    const sample = Math.max(box.width, box.height, 1) / 4000;
    shapes.forEach((el, k) => {
      const len = lengths[k];
      if (!(len > 0)) return;
      const ctm = el.getCTM();
      const count = Math.min(20000, Math.max(2, Math.ceil(len / sample)));
      let line: Point[] = [];
      let prev: Point | null = null;
      for (let i = 0; i <= count; i++) {
        let p = el.getPointAtLength((len * i) / count);
        if (ctm) p = p.matrixTransform(ctm);
        const pt: Point = [p.x, p.y];
        // getPointAtLength skips over "move to" gaps between sub-paths; split there.
        if (prev && Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > (len / count) * 3 + 1e-9) {
          if (line.length > 1) raw.push(line);
          line = [];
        }
        line.push(pt);
        prev = pt;
      }
      if (line.length > 1) raw.push(line);
    });
    if (!raw.length) throw new Error('No drawable shapes found in the SVG. Convert text to paths first.');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const line of raw) for (const [x, y] of line) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const scale = width / Math.max(maxX - minX, 1e-9);
    const height = (maxY - minY) * scale;
    const lines = raw.map((line) =>
      simplify(
        line.map(([x, y]): Point => {
          const mx = (x - minX) * scale;
          return [mirror ? width - mx : mx, (maxY - y) * scale];
        }),
        0.01,
      ),
    );
    return { lines, height };
  } finally {
    host.remove();
  }
}
