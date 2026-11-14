/**
 * Foote novelty over block feature vectors: a Gaussian-tapered (σ = halfWidth/2)
 * checkerboard kernel slid along the diagonal of the cosine self-similarity
 * matrix. Only the band |i − j| < 2·halfWidth is ever computed, so the cost is
 * O(N · halfWidth²) with no N×N matrix.
 *
 * Value i scores a boundary between block i − 1 and block i. Positions where
 * the kernel would leave the clip are 0. The result is clamped at 0 and scaled
 * so its maximum is 1 (all zeros if nothing is novel).
 */
export function noveltyCurve(blocks: Float32Array[], halfWidth = 16): Float32Array {
  const n = blocks.length;
  const h = halfWidth;
  const out = new Float32Array(n);
  if (n < 2 * h || h < 1) return out;

  // Unit vectors, so cosine similarity is a dot product. Zero vectors stay zero.
  const unit = blocks.map((b) => {
    let s = 0;
    for (let k = 0; k < b.length; k++) s += b[k] * b[k];
    const u = new Float32Array(b.length);
    if (s > 0 && Number.isFinite(s)) {
      const inv = 1 / Math.sqrt(s);
      for (let k = 0; k < b.length; k++) u[k] = b[k] * inv;
    }
    return u;
  });

  // Kernel over offsets a, b ∈ [−h, h): sign +1 within the same side of the
  // boundary, −1 across it; Gaussian taper on the distance from the centre.
  const size = 2 * h;
  const sigma = h / 2;
  const kernel = new Float64Array(size * size);
  for (let a = 0; a < size; a++) {
    for (let b = 0; b < size; b++) {
      const da = a - h + 0.5;
      const db = b - h + 0.5;
      const sign = a < h === b < h ? 1 : -1;
      kernel[a * size + b] = sign * Math.exp(-(da * da + db * db) / (2 * sigma * sigma));
    }
  }

  // band[i * size + d] = sim(i, i + d) for d in [0, size).
  const band = new Float64Array(n * size);
  for (let i = 0; i < n; i++) {
    const u = unit[i];
    for (let d = 0; d < size && i + d < n; d++) {
      const v = unit[i + d];
      let dot = 0;
      for (let k = 0; k < u.length; k++) dot += u[k] * v[k];
      band[i * size + d] = dot;
    }
  }

  let max = 0;
  for (let c = h; c + h <= n; c++) {
    const base = c - h;
    let sum = 0;
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        const lo = a < b ? a : b;
        const d = a < b ? b - a : a - b;
        sum += kernel[a * size + b] * band[(base + lo) * size + d];
      }
    }
    const v = sum > 0 && Number.isFinite(sum) ? sum : 0;
    out[c] = v;
    if (v > max) max = v;
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}
