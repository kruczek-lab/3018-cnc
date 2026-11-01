/**
 * A black-and-white bitmap of the design at a fixed physical resolution.
 * `keep[i] === 1` means "leave the surface here" (for a linocut: the parts that print).
 * Row 0 is the top of the image.
 */
export interface Mask {
  width: number;
  height: number;
  /** Millimetres per pixel. */
  res: number;
  keep: Uint8Array;
}

/**
 * Converts RGBA pixels to a mask. Dark pixels (luminance below `threshold`) are kept;
 * transparent pixels count as light. `invert` swaps that, e.g. to engrave a dark drawing.
 */
export function maskFromRGBA(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  res: number,
  threshold: number,
  invert: boolean,
): Mask {
  const keep = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const lum = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    const onWhite = lum * a + 255 * (1 - a);
    const dark = onWhite < threshold;
    keep[i] = dark !== invert ? 1 : 0;
  }
  return { width, height, res, keep };
}

/** Mirrors left-to-right. Prints come out reversed, so blocks are carved mirrored. */
export function mirrorMask(mask: Mask): Mask {
  const { width, height } = mask;
  const keep = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) keep[y * width + x] = mask.keep[y * width + (width - 1 - x)];
  }
  return { ...mask, keep };
}
