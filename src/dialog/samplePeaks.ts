// The zoomed waveform from the clip's own samples (fb4, item 2: "The resolution of the zoom is quite lo-fi"). Pure.
//
// The overview is 2000 min/max bins for the whole clip: at 8x on a 30-minute clip a bin is 4 px wide. Once the preview
// is in memory (player.ts preload: 16-bit, mono at 22.05 or 24 kHz), a zoomed view draws the min and max of the
// samples under each pixel column instead:
// - Under BASE frames a column (deep zoom), straight from the samples of the visible range: at most BASE a column.
// - From BASE frames a column, from a min/max mipmap: level k has a bin per BASE << k frames, each the min and max of
//   two bins of level k - 1. A column then reads one to three bins of the level whose bin fits in it, so a frame costs
//   the same at 2x as at 1000x and panning reads only the columns' bins.
// The mipmap's base level is one pass over the samples (43 M of them on a 30-minute clip), so it is built in slices
// (build(budget)) off the frames; until it is complete, a range of up to DIRECT_MAX_FRAMES is scanned directly and a
// longer one is left to the overview (columns() returns false). Memory: two Int16 per BASE frames, 1.3 MB for 30 min.

import type { Pcm16 } from "./player.js";

/** Frames per bin of the mipmap's base level (a power of two). */
export const BASE = 256;
const BASE_SHIFT = 8;
/** The longest range a draw scans sample by sample before the mipmap is ready: ~4 ms at 24 kHz mono. */
export const DIRECT_MAX_FRAMES = 1 << 21;

export interface SamplePeaks {
  readonly frames: number;
  readonly rate: number;
  /** Whether the mipmap is complete. */
  readonly ready: boolean;
  /** Builds about `budget` more frames' worth of the mipmap; true once it is complete. */
  build(budget: number): boolean;
  /**
   * The min and max (-1..1) of frames [f0, f1) under each of `cols` columns, into `lo` and `hi`. false (nothing
   * written) when that needs the mipmap and it is not ready yet.
   */
  columns(f0: number, f1: number, cols: number, lo: Float32Array, hi: Float32Array): boolean;
}

export function createSamplePeaks(pcm: Pcm16): SamplePeaks {
  const { frames, rate, channels: c, samples } = pcm;
  const bins = Math.ceil(frames / BASE);
  // levels[0] is the base; levels[k] halves levels[k - 1]. Filled in by build().
  const levels: Array<{ lo: Int16Array; hi: Int16Array }> = [{ lo: new Int16Array(bins), hi: new Int16Array(bins) }];
  let next = 0; // the next base bin to fill
  let ready = bins === 0;

  function build(budget: number): boolean {
    if (ready) return true;
    const base = levels[0];
    const end = Math.min(bins, next + Math.max(1, Math.ceil(budget / BASE)));
    for (let b = next; b < end; b++) {
      const s0 = b * BASE * c;
      const s1 = Math.min(frames, (b + 1) * BASE) * c;
      let lo = 32767;
      let hi = -32768;
      for (let i = s0; i < s1; i++) {
        const v = samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      base.lo[b] = lo;
      base.hi[b] = hi;
    }
    next = end;
    if (next < bins) return false;
    // The coarser levels are a few per cent of the base's work: all at once.
    for (let prev = base; prev.lo.length > 1; ) {
      const n = Math.ceil(prev.lo.length / 2);
      const lv = { lo: new Int16Array(n), hi: new Int16Array(n) };
      for (let i = 0; i < n; i++) {
        const j = 2 * i;
        const k = Math.min(prev.lo.length - 1, j + 1);
        lv.lo[i] = Math.min(prev.lo[j], prev.lo[k]);
        lv.hi[i] = Math.max(prev.hi[j], prev.hi[k]);
      }
      levels.push(lv);
      prev = lv;
    }
    ready = true;
    return true;
  }

  function direct(f0: number, spp: number, cols: number, lo: Float32Array, hi: Float32Array) {
    for (let x = 0; x < cols; x++) {
      const a = Math.max(0, Math.floor(f0 + x * spp));
      const b = Math.min(frames, Math.max(a + 1, Math.floor(f0 + (x + 1) * spp)));
      let mn = 32767;
      let mx = -32768;
      for (let i = a * c, e = b * c; i < e; i++) {
        const v = samples[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (b <= a) mn = mx = 0;
      lo[x] = mn / 32768;
      hi[x] = mx / 32768;
    }
  }

  function columns(f0: number, f1: number, cols: number, lo: Float32Array, hi: Float32Array): boolean {
    if (cols <= 0) return true;
    const spp = (f1 - f0) / cols;
    if (spp < BASE) {
      direct(f0, spp, cols, lo, hi);
      return true;
    }
    if (!ready) {
      if (f1 - f0 > DIRECT_MAX_FRAMES) return false;
      direct(f0, spp, cols, lo, hi);
      return true;
    }
    // The level whose bin is at most a column: BASE << k <= spp.
    const k = Math.min(levels.length - 1, Math.floor(Math.log2(spp)) - BASE_SHIFT);
    const lv = levels[k];
    const n = lv.lo.length;
    const bin = BASE * 2 ** k;
    for (let x = 0; x < cols; x++) {
      // Past the preview's end is silence (fb4 review M5), as the direct path draws it, not the last bin again.
      if (Math.floor(f0 + x * spp) >= frames) {
        lo[x] = hi[x] = 0;
        continue;
      }
      // Floors at both ends: neighbouring columns share no bin and leave none out.
      const a = Math.max(0, Math.min(n - 1, Math.floor((f0 + x * spp) / bin)));
      const b = Math.min(n, Math.max(a + 1, Math.floor((f0 + (x + 1) * spp) / bin)));
      let mn = 32767;
      let mx = -32768;
      for (let i = a; i < b; i++) {
        if (lv.lo[i] < mn) mn = lv.lo[i];
        if (lv.hi[i] > mx) mx = lv.hi[i];
      }
      lo[x] = mn / 32768;
      hi[x] = mx / 32768;
    }
    return true;
  }

  return {
    frames,
    rate,
    get ready() {
      return ready;
    },
    build,
    columns,
  };
}
