// Port of allin1 1.1.0's spectrogram chain (madmom 0.16.1) and demucs's int16 write-out
// (spike `allin1_dsp.py`, verdict 5.2; `demucs.audio.prevent_clip` + `_pcm_bytes`).
import type { StemName } from "../contract.js";
import { throwIfAborted } from "../../core/abort.js";
import { FOREGROUND, type Pace } from "../../core/pace.js";
import { createRealFft } from "../dsp/fft.js";

export const FPS = 100;
export const FRAME_SIZE = 2048;
export const HOP = 441; // 44100 / FPS
export const BANDS = 81;
export const MODEL_STEM_ORDER = ["bass", "drums", "other", "vocals"] as const; // not Demucs's output order

const SAMPLE_RATE = 44100;
const NUM_BINS = FRAME_SIZE / 2; // rfft bins 0..1023; Nyquist dropped
const BANDS_PER_OCTAVE = 12;
const FMIN = 30;
const FMAX = 17000;
const FREF = 440;
const INT16_MAX = 32767;

interface Filterbank {
  matrix: Float32Array; // 1024 x 81, row-major
  bins: number[];
  centerHz: number[];
  starts: Int32Array; // first and last+1 bin of each band's triangle
  stops: Int32Array;
}

let cache: Filterbank | undefined;

/**
 * madmom `Filterbank.center_frequencies`: among the band's non-zero bins, the middle one if the filter is flat,
 * otherwise the first maximum over [min_bin, max_bin) (madmom's slice excludes max_bin, so a two-bin filter
 * centres on its first bin). This is the definition of the contract's ALLIN1_BAND_HZ.
 */
function madmomCenterBin(matrix: Float32Array, n: number, band: number, start: number, stop: number): number {
  let lo = -1;
  let hi = -1;
  for (let k = start; k < stop; k++) {
    if (matrix[k * n + band] !== 0) {
      if (lo < 0) lo = k;
      hi = k;
    }
  }
  if (matrix[lo * n + band] === matrix[hi * n + band]) return lo + Math.trunc((hi - lo) / 2);
  let best = lo;
  for (let k = lo; k < hi; k++) if (matrix[k * n + band] > matrix[best * n + band]) best = k;
  return best;
}

function build(): Filterbank {
  // numpy fftfreq(2048, 1/44100)[:1024]
  const val = 1 / (FRAME_SIZE * (1 / SAMPLE_RATE));
  const binFreqs = Float64Array.from({ length: NUM_BINS }, (_, k) => k * val);

  const left = Math.floor(Math.log2(FMIN / FREF) * BANDS_PER_OCTAVE);
  const right = Math.ceil(Math.log2(FMAX / FREF) * BANDS_PER_OCTAVE);
  let freqs: number[] = [];
  for (let k = left; k < right; k++) freqs.push(FREF * Math.pow(2, k / BANDS_PER_OCTAVE));
  freqs = freqs.filter((f) => f >= FMIN && f <= FMAX); // searchsorted left for fmin, right for fmax

  // Nearest bin, ties to the upper bin, then unique.
  const idx = freqs.map((f) => {
    let i = 0;
    while (i < NUM_BINS && binFreqs[i] < f) i++; // searchsorted (left)
    i = Math.min(Math.max(i, 1), NUM_BINS - 1);
    if (f - binFreqs[i - 1] < binFreqs[i] - f) i -= 1;
    return i;
  });
  const bins = [...new Set(idx)].sort((a, b) => a - b);

  const n = bins.length - 2;
  const matrix = new Float32Array(NUM_BINS * n);
  const centerHz: number[] = [];
  const starts = new Int32Array(n);
  const stops = new Int32Array(n);
  for (let b = 0; b < n; b++) {
    const start = bins[b];
    let center = bins[b + 1];
    let stop = bins[b + 2];
    if (stop - start < 2) {
      // degenerate triangle: a single bin
      center = start;
      stop = start + 1;
    }
    const rise = center - start;
    const length = stop - start;
    const tri = new Float64Array(length);
    for (let i = 0; i < rise; i++) tri[i] = i / rise; // linspace(0, 1, rise, endpoint=False)
    const fall = length - rise;
    for (let i = 0; i < fall; i++) tri[rise + i] = 1 + i * (-1 / fall); // linspace(1, 0, fall, endpoint=False)
    let sum = 0;
    for (const v of tri) sum += v;
    for (let i = 0; i < length; i++) matrix[(start + i) * n + b] = tri[i] / sum; // unit area
    centerHz.push(binFreqs[madmomCenterBin(matrix, n, b, start, stop)]);
    starts[b] = start;
    stops[b] = stop;
  }
  return { matrix, bins, centerHz, starts, stops };
}

/** madmom's LogarithmicFilterbank (12 bands/octave, 30-17000 Hz, unique bins, unit-area triangles), 1024 x 81; `centerHz` = madmom's center_frequencies. */
export function filterbank(): { matrix: Float32Array; bins: number[]; centerHz: number[] } {
  cache ??= build();
  return cache;
}

/**
 * demucs `save_audio(clip="rescale", 16 bit)` followed by madmom's mono `remix`: scale by
 * 1/max(1.01 * peak, 1), clamp, x32767, truncate to int16 per channel, then mean and truncate.
 * `peak` is max |x| over both channels of the WHOLE stem. Every step is rounded to float32.
 */
export function quantiseStem(left: Float32Array, right: Float32Array, peak: number): Int16Array {
  const d = Math.max(Math.fround(Math.fround(1.01) * peak), 1); // wav / max(1.01 * peak, 1): a division, as torch does
  const q = (x: number) => {
    const v = Math.fround(x / d);
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    return Math.trunc(Math.fround(c * INT16_MAX));
  };
  const out = new Int16Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = Math.trunc((q(left[i]) + q(right[i])) / 2);
  return out;
}

// np.hanning(2048) / 32767 as float32: 0.5 + 0.5 cos(pi n / (M - 1)) for n = 1-M, 3-M, ..., M-1.
const WINDOW = (() => {
  const w = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    const n = 1 - FRAME_SIZE + 2 * i;
    w[i] = Math.fround((0.5 + 0.5 * Math.cos((Math.PI * n) / (FRAME_SIZE - 1))) / INT16_MAX);
  }
  return w;
})();

/** One int16 mono stem -> (T, 81) float32 log-filtered magnitude spectrogram, T = ceil(N / 441). */
export function stemSpectrogram(mono: Int16Array): Float32Array {
  const fb = filterbank() as ReturnType<typeof build>;
  const n = mono.length;
  const frames = Math.ceil(n / HOP);
  const out = new Float32Array(frames * BANDS);
  const fft = createRealFft(FRAME_SIZE);
  const frame = new Float64Array(FRAME_SIZE);
  const re = new Float64Array(NUM_BINS + 1);
  const im = new Float64Array(NUM_BINS + 1);
  const mag = new Float64Array(NUM_BINS);
  const half = FRAME_SIZE / 2;
  for (let t = 0; t < frames; t++) {
    const first = t * HOP - half; // frame covers [t*441 - 1024, t*441 + 1024), zero outside the signal
    for (let i = 0; i < FRAME_SIZE; i++) {
      const p = first + i;
      frame[i] = p >= 0 && p < n ? Math.fround(mono[p] * WINDOW[i]) : 0;
    }
    fft.forward(frame, re, im);
    for (let k = 0; k < NUM_BINS; k++) mag[k] = Math.fround(Math.sqrt(re[k] * re[k] + im[k] * im[k])); // hypot() is several times slower
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = fb.starts[b]; k < fb.stops[b]; k++) sum += mag[k] * fb.matrix[k * BANDS + b];
      out[t * BANDS + b] = Math.log10(Math.fround(sum) + 1);
    }
  }
  return out;
}

const CONTEXT_FRAMES = Math.ceil(FRAME_SIZE / 2 / HOP); // 3: a frame reaches 1024 samples back, 3 hops = 1323

/**
 * stemSpectrogram, bit for bit, computed `framesPerSlice` frames at a time with a yield between slices, so a long
 * stem (5 min: ~0.8 s of work) never blocks the host for long (1000 frames: ~25 ms). Each slice starts CONTEXT_FRAMES hops early, on a
 * multiple of HOP, so its frames see exactly the samples the whole-stem frames see; the extra frames are dropped.
 * Checks `signal` before every slice.
 */
export async function stemSpectrogramSliced(mono: Int16Array, signal: AbortSignal, framesPerSlice = 1000, pace: Pace = FOREGROUND): Promise<Float32Array> {
  const n = mono.length;
  const T = Math.ceil(n / HOP);
  const out = new Float32Array(T * BANDS);
  for (let t0 = 0, t1 = 0; t0 < T; t0 = t1) {
    throwIfAborted(signal);
    t1 = Math.min(T, t0 + pace.slice(framesPerSlice));
    const first = Math.max(0, t0 - CONTEXT_FRAMES); // slice-local frame j is global frame first + j
    const end = Math.min(n, (t1 - 1) * HOP + FRAME_SIZE / 2);
    const part = stemSpectrogram(mono.subarray(first * HOP, end));
    out.set(part.subarray((t0 - first) * BANDS, (t1 - first) * BANDS), t0 * BANDS);
    if (t1 < T) await pace.yield(signal);
  }
  return out;
}

/** Stack per-stem (T, 81) spectrograms into the model input (1, 4, T, 81) in MODEL_STEM_ORDER. */
export function stackSpec(specs: Record<StemName, Float32Array>, T: number): Float32Array {
  const out = new Float32Array(4 * T * BANDS);
  MODEL_STEM_ORDER.forEach((stem, i) => {
    const s = specs[stem];
    if (s.length !== T * BANDS) throw new Error(`${stem} spectrogram has ${s.length} values, expected ${T * BANDS}`);
    out.set(s, i * T * BANDS);
  });
  return out;
}
