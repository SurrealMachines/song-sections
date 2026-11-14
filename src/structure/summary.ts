// Summaries of the engine's 100 fps (allin1) and 44.1 kHz data at the contract's FEATURE_RATE (2 per second).
// 50 allin1 frames = 22050 samples = 0.5 s, and ceil(T / 50) = ceil(N / 22050) = ceil(durationSec * 2) when
// T = ceil(N / 441), so every per-frame array has the contract's `frames` length.
import { FEATURE_BANDS, FUNCTION_LABELS, PEAK_RATE } from "./contract.js";

const FRAMES_PER_BLOCK = 50; // allin1 frames (100 fps) per feature frame
const SAMPLES_PER_BLOCK = 22050; // 44.1 kHz samples per feature frame
const FLOOR_DB = -100;
/** 44.1 kHz samples per StemFeatures.peak block (1 / PEAK_RATE s). */
export const PEAK_BLOCK = 44100 / PEAK_RATE;

const round = (x: number, decimals: number) => {
  const k = 10 ** decimals;
  return Math.round(x * k) / k;
};

/** Mean of each block of 50 rows of a row-major T×width array; the last block may be partial. */
function blockMeans(data: Float32Array, T: number, width: number, decimals: number): number[][] {
  if (data.length !== T * width) throw new Error(`expected ${T}×${width} values, got ${data.length}`);
  const out: number[][] = [];
  for (let t0 = 0; t0 < T; t0 += FRAMES_PER_BLOCK) {
    const t1 = Math.min(T, t0 + FRAMES_PER_BLOCK);
    const sums = new Float64Array(width);
    for (let t = t0; t < t1; t++) for (let c = 0; c < width; c++) sums[c] += data[t * width + c];
    out.push(Array.from(sums, (s) => round(s / (t1 - t0), decimals)));
  }
  return out;
}

/** (T, 81) stem spectrogram -> [frames][81], the mean of each 0.5 s block, 3 decimals. */
export function bandsAt2Hz(spec: Float32Array, T: number): number[][] {
  return blockMeans(spec, T, FEATURE_BANDS, 3);
}

/** RMS over both channels of each 22050-sample block (last may be partial), dBFS, floored at -100, 1 decimal. */
export function loudnessAt2Hz(left: Float32Array, right: Float32Array): number[] {
  const n = Math.min(left.length, right.length);
  const out: number[] = [];
  for (let i0 = 0; i0 < n; i0 += SAMPLES_PER_BLOCK) {
    const i1 = Math.min(n, i0 + SAMPLES_PER_BLOCK);
    let sq = 0;
    for (let i = i0; i < i1; i++) sq += left[i] * left[i] + right[i] * right[i];
    const db = 10 * Math.log10(sq / (2 * (i1 - i0))); // 20 log10(rms)
    out.push(round(Math.max(FLOOR_DB, Number.isFinite(db) ? db : FLOOR_DB), 1));
  }
  return out;
}

/** Frame-major T×10 softmax probabilities -> [frames][10], block means, 3 decimals. */
export function functionProbsAt2Hz(probs: Float32Array, T: number): number[][] {
  return blockMeans(probs, T, FUNCTION_LABELS.length, 3);
}

/**
 * max |sample| over both channels of each PEAK_BLOCK-sample block (the last may be partial), as float32. A slice
 * that starts on a block boundary gives that slice's blocks, so slices can be concatenated.
 */
export function peakBlocks(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(Math.ceil(n / PEAK_BLOCK));
  for (let b = 0, i0 = 0; i0 < n; b++, i0 += PEAK_BLOCK) {
    const i1 = Math.min(n, i0 + PEAK_BLOCK);
    let p = 0;
    for (let i = i0; i < i1; i++) {
      const l = Math.abs(left[i]);
      const r = Math.abs(right[i]);
      if (l > p) p = l;
      if (r > p) p = r;
    }
    out[b] = p;
  }
  return out;
}

/**
 * peakBlocks of the analysed (scaled by gainDb) stem -> the contract's StemFeatures.peak: back at the clip's own
 * level, clamped to [0, 1], 3 decimals, `length` = ceil(durationSec * PEAK_RATE) long (zeros pad a short tail).
 */
export function peakAtClipLevel(raw: Float32Array, gainDb: number, length: number): number[] {
  const k = 10 ** (-gainDb / 20);
  const out = new Array<number>(length);
  for (let b = 0; b < length; b++) {
    const v = b < raw.length ? raw[b] * k : 0;
    out[b] = round(Math.min(1, Math.max(0, v)), 3);
  }
  return out;
}
