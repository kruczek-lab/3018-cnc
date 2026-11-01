const INF = 1e20;

// Felzenszwalb & Huttenlocher's exact 1-D squared distance transform.
function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared Euclidean distance (in pixels²) from every pixel centre to the nearest pixel where `feature` is set. */
export function squaredDistanceTo(feature: Uint8Array, width: number, height: number): Float64Array {
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = feature[i] ? 0 : INF;
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    transform1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = out[y * width + x];
    transform1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[y * width + x] = d[x];
  }
  return out;
}

/**
 * Distance in mm from each pixel centre to the edge of the kept area. Kept pixels are
 * -res/2 and their uncut neighbours +res/2, so the 0 level runs along the pixel boundary.
 * With nothing kept, every pixel gets a very large value.
 */
export function edgeDistanceField(keep: Uint8Array, width: number, height: number, res: number): Float32Array {
  const d2 = squaredDistanceTo(keep, width, height);
  const field = new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) {
    field[i] = d2[i] >= INF ? 1e6 : Math.sqrt(d2[i]) * res - res / 2;
  }
  return field;
}
