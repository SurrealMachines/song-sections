// Bundled into the dialog webview as well as the extension: import nothing
// from Node, and nothing that imports Node.

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Picks section boundaries from a novelty curve sampled at `blocksPerSec`.
 * `granularity` in [0, 1] trades fewer, well-separated boundaries (0) for
 * more, closer ones (1):
 * - minimum gap: 32 · (1/16)^granularity seconds (32 s, 8 s at 0.5, 2 s at 1)
 * - threshold: median + (2.5 − 2·granularity) · MAD
 * A peak is a local maximum within ±gap that is strictly above the threshold,
 * so consecutive peaks are at least `gap` apart.
 * Returns boundary times in seconds, ascending.
 */
export function pickPeaks(novelty: ArrayLike<number>, blocksPerSec: number, granularity: number): number[] {
  const n = novelty.length;
  if (n === 0) return [];
  const g = Math.min(1, Math.max(0, granularity));
  const gapSec = 32 * (1 / 16) ** g;
  const gap = Math.max(1, Math.round(gapSec * blocksPerSec)); // in blocks

  const values = Array.from(novelty);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const threshold = med + (2.5 - 2 * g) * mad;

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!(v > threshold)) continue;
    let isPeak = true;
    const lo = Math.max(0, i - gap);
    const hi = Math.min(n - 1, i + gap);
    // Strict on the left, non-strict on the right: a plateau yields its first index.
    for (let j = lo; j < i && isPeak; j++) if (values[j] >= v) isPeak = false;
    for (let j = i + 1; j <= hi && isPeak; j++) if (values[j] > v) isPeak = false;
    if (isPeak) out.push(i / blocksPerSec);
  }
  return out;
}
