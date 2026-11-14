// Stem lanes zoomed past their peak envelope (fb4, item 2). Pure, so it tests without the DOM.
//
// A stem lane draws StemFeatures.peak, PEAK_RATE (20) blocks a second. Zoomed so far that a block is DETAIL_PX or more
// wide (25 s across a 1000 px view), and with the stems kept, the lanes fetch the stems' own samples for the view and a
// margin either side (the existing `?start=&end=` slice route; 16-bit 44.1 kHz stereo) and draw the max |sample| per
// column from them. A fetched slice is reduced at once to one peak per bin of a power-of-two frames no wider than a
// column, and the samples are let go: the most held is one stem's slice while it is reduced (6.6 MB at 25 s), and the
// four reductions (2 KB to 160 KB each).
import { PEAK_RATE } from "../structure/contract.js";
import type { Pcm16 } from "./player.js";
import type { ZoomView } from "./zoom.js";

/** An envelope block this many pixels wide or more is too coarse: the lanes fetch the samples. */
export const DETAIL_PX = 2;
/** The fetched range runs this fraction of the view past each edge, so a pan needs no new fetch at once. */
export const DETAIL_MARGIN = 0.25;
/** The stem slice route's sample rate (live/dialogServer.ts AUDITION_RATE), whose frame its ends round to. */
const FRAME_RATE = 44100;
/** The finest bin, in frames. */
const MIN_BIN = 16;

export interface StemDetail {
  /** Clip seconds of the first bin's start. */
  start: number;
  /** Clip seconds the bins reach to. */
  end: number;
  binSec: number;
  /** Max |sample| over both channels per bin, 0..1. */
  peak: Float32Array;
}

/** Whether the view is zoomed past what the envelope resolves across `width` columns. */
export function needsDetail(v: ZoomView, width: number): boolean {
  return width > 0 && v.span * PEAK_RATE * DETAIL_PX < width;
}

/** The range to fetch for the view: the view and a margin either side, inside the clip. */
export function detailRange(v: ZoomView, duration: number): { start: number; end: number } {
  const m = v.span * DETAIL_MARGIN;
  return { start: Math.max(0, v.start - m), end: Math.min(duration, v.start + v.span + m) };
}

/** Frames per bin for the view: the largest power of two no wider than a column, and at least MIN_BIN. */
export function detailBin(v: ZoomView, width: number, rate: number): number {
  const spp = (v.span * rate) / Math.max(1, width);
  return 2 ** Math.max(Math.log2(MIN_BIN), Math.floor(Math.log2(Math.max(1, spp))));
}

/** A fetched slice (starting at clip second `start`) reduced to one peak per `bin` frames. */
export function reduceDetail(pcm: Pcm16, start: number, bin: number): StemDetail {
  const { frames, channels: c, samples, rate } = pcm;
  const n = Math.ceil(frames / bin);
  const peak = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let m = 0;
    for (let i = k * bin * c, e = Math.min(frames, (k + 1) * bin) * c; i < e; i++) {
      const v = samples[i] < 0 ? -samples[i] : samples[i];
      if (v > m) m = v;
    }
    peak[k] = Math.min(1, m / 32768);
  }
  return { start, end: start + frames / rate, binSec: bin / rate, peak };
}

/** A slice that stops this close to the clip's end, when the view is flush with the end, still covers the view. */
const END_TOL = 0.025;

/**
 * Whether `d` covers the view, with bins at most twice a column's width (a deeper zoom needs a finer fetch).
 *
 * fb4 review I1: the slice route rounds both ends of the range to a frame, and `d.end` is the end of the frames it
 * returned, so a slice asked for the view up to the clip's end (no margin there) can stop a frame short of it, or a
 * few ms short when the stem is a little shorter than the clip. A tolerance of a bin (never under a frame) absorbs
 * the rounding; with `duration`, a view flush with the clip's end is covered by a slice that reaches END_TOL of it,
 * since the view cannot go further.
 */
export function detailCovers(d: StemDetail | undefined, v: ZoomView, width: number, duration?: number): boolean {
  if (!d) return false;
  const tol = Math.max(1e-6, d.binSec, 1 / FRAME_RATE);
  const right = v.start + v.span;
  const reachesRight = d.end >= right - tol || (duration !== undefined && right >= duration - tol && d.end >= duration - END_TOL);
  return d.start <= v.start + tol && reachesRight && d.binSec <= (2 * v.span) / Math.max(1, width);
}

/**
 * The max peak under each of `cols` columns of the view, from `d`'s bins. With `into` (at least `cols` long) the
 * columns are written there, and `into` is returned, so a redraw allocates nothing (fb4 review M4).
 */
export function detailColumns(d: StemDetail, v: ZoomView, cols: number, into?: Float32Array): Float32Array {
  const out = into && into.length >= cols ? into : new Float32Array(cols);
  const n = d.peak.length;
  const w = v.span / cols;
  for (let x = 0; x < cols; x++) {
    const a = Math.max(0, Math.min(n - 1, Math.floor((v.start + x * w - d.start) / d.binSec)));
    const b = Math.min(n, Math.max(a + 1, Math.floor((v.start + (x + 1) * w - d.start) / d.binSec)));
    let m = 0;
    for (let i = a; i < b; i++) if (d.peak[i] > m) m = d.peak[i];
    out[x] = m;
  }
  return out;
}
