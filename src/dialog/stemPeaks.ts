// Show stems (feedback round 1): the stem lanes' waveforms from StemFeatures.peak. Pure; the dialog bundles it.
import type { StemFeatures, StemName } from "../structure/contract.js";

/**
 * The data points under pixel column `x` of `columns` that show points [from, to) (fractional; the whole data when
 * not zoomed): [a, b), at least one point, clamped to [0, n). fb3: a zoomed view draws only what is on screen.
 */
export function columnBlocks(x: number, columns: number, n: number, from = 0, to = n): [number, number] {
  const w = (to - from) / columns;
  const a = Math.max(0, Math.min(n - 1, Math.floor(from + x * w)));
  const b = Math.min(n, Math.max(a + 1, Math.floor(from + (x + 1) * w)));
  return [a, b];
}

/**
 * The max of the peak blocks under each of `columns` pixel columns (a block spans several columns when zoomed in),
 * for blocks [from, to) (fractional: the view's edges), the whole lane by default.
 */
export function columnPeaks(peak: number[], columns: number, from = 0, to = peak.length): number[] {
  const n = peak.length;
  const out: number[] = [];
  for (let x = 0; x < columns; x++) {
    if (n === 0) {
      out.push(0);
      continue;
    }
    const [a, b] = columnBlocks(x, columns, n, from, to);
    let hi = 0;
    for (let i = a; i < b; i++) if (peak[i] > hi) hi = peak[i];
    out.push(hi);
  }
  return out;
}

/**
 * The full-lane level: the loudest peak over all stems, so the loudest stem fills its lane and the quieter ones keep
 * their level relative to it. 1 when every stem is silent (or has no peaks).
 */
export function peakScale(stems: Record<StemName, StemFeatures>): number {
  let max = 0;
  for (const s of Object.values(stems)) for (const v of s.peak ?? []) if (v > max) max = v;
  return max > 0 ? max : 1;
}
