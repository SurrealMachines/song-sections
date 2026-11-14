// v2, key per section: the harmonic chroma time series of a mono signal (the dialog's keys come from it, key/key.ts).
// No Node imports (fft.js is plain JS), so tests and tools can run it on any signal.
//
// Why not the chroma already in the repo: analysis/features.ts takes Meyda's chroma, which is normalised per frame (a
// near-silent frame weighs as much as a loud chord) and then z-scored per clip, which throws away the very shape a key
// profile is matched against. grouping/sectionVectors.ts folds allin1's 81 bands into pitch classes, but below
// ~500 Hz those bands are one FFT bin each, 21.5 Hz apart (contract.ts ALLIN1_BAND_HZ), so most of the bass register
// lands on a few pitch classes and the bass, the surest sign of a key, is mostly lost. This one uses a 0.37 s window
// (2.7 Hz bins at 11 kHz). Its Hann main lobe is ±2 bins, ±5.4 Hz, narrower than a semitone only from about 95 Hz
// (G2) up: a bass note from C2 to F♯2 still spreads onto its neighbouring pitch classes, held back but not removed by
// the cos² weight and the whitening (review M2). A longer window for the lowest octave would be the next step if bass
// keys look off.
import { abortError } from "../core/abort.js";
import { FOREGROUND, type Pace } from "../core/pace.js";
import { createRealFft } from "../structure/dsp/fft.js";

/** Frames per second of the chroma series (the 0.5 s blocks every other per-frame array of the dialog uses). */
export const HARMONY_RATE = 2;
/** The window, in seconds; rounded up to a power of two in samples. */
const WINDOW_SEC = 0.37;
/**
 * Lowest and highest frequency folded in: a half semitone below C2 to a half semitone above B6, five whole octaves, so
 * every pitch class gets the same span of spectrum (the overtones above add little but noise).
 */
const FMIN = 65.406 * 2 ** (-0.5 / 12);
const FMAX = 1975.53 * 2 ** (0.5 / 12);
/**
 * Whitening: each bin's compressed magnitude less the mean of the bins around it (at least FLOOR_MIN_BINS, or two
 * semitones, each side) and PEAK_MARGIN, floored at 0, so only what stands out of the spectrum (partials) is folded. Without it a
 * noisy source (hats, breath, a vocal stem that is all bleed) gives a ramp up each octave, as higher pitch classes
 * span more bins, and that ramp reads as a key.
 */
const FLOOR_MIN_BINS = 8;
const FLOOR_SEMITONES = 2;
/**
 * What a bin must stand above that floor by to count (compressed log units, so about a factor 1.65 at normal levels):
 * a partial 10 dB or more above its surroundings counts; noise counts at a fraction (a Rayleigh magnitude clears its
 * log-mean by that much about a fifth of the time, and then by little). The drums stem of a real song folds to about
 * 1% of the other stems; white noise folds to nothing at all once its level is brought to REF_RMS (key.test.ts).
 */
const PEAK_MARGIN = 0.5;
/**
 * log(1 + GAMMA x) compression of the magnitudes (Müller's chroma), so a loud partial does not outvote a chord. It, and
 * PEAK_MARGIN and MIN_PEAK, act on magnitudes brought to REF_RMS first (review I2), so they are relative to the clip's
 * own level: a quiet recording keys as a loud one does.
 */
const GAMMA = 100;
/**
 * The level the harmonic signal is brought to before compression: -16 dBFS RMS, about where the cached real songs'
 * bass + other + vocals sit (-14.5 to -22.6 dBFS) and where the thresholds below were set.
 */
export const REF_RMS = 10 ** (-16 / 20);
/** The level is measured over 0.5 s blocks louder than this (dBFS RMS), so digital silence does not count. */
const LEVEL_GATE_DB = -100;
/** The gain is kept within -20 dB … +60 dB. */
const MIN_GAIN = 0.1;
const MAX_GAIN = 1000;
/** STFT frames per slice in the foreground (about 40 ms of work); a background pace cuts it finer (core/pace.ts). */
const SLICE_FRAMES = 400;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Fine bins per semitone: the chroma is gathered at 10 cents, then tuned and folded to 12 (review M1). */
export const FINE = 10;
const FINE_BINS = 12 * FINE;

/** The bins folded, and each one's place on the fine grid (0 = C at A = 440 Hz, FINE per semitone, mod FINE_BINS). */
function fineMap(n: number, rate: number): { bin: Int32Array; pos: Float64Array } {
  const bins: number[] = [];
  const pos: number[] = [];
  for (let k = 1; k < n / 2; k++) {
    const hz = (k * rate) / n;
    if (hz < FMIN || hz > FMAX) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    bins.push(k);
    pos.push((((midi % 12) + 12) % 12) * FINE);
  }
  return { bin: Int32Array.from(bins), pos: Float64Array.from(pos) };
}

/**
 * The clip's tuning (review M1), in semitones from A = 440 Hz, -0.5 … 0.5: the circular mean of where, within its
 * semitone, the fine chroma's energy lies. Material tuned to A = 432 Hz reads about -0.32; 0 when there is nothing.
 */
export function estimateTuning(fine: Float64Array): number {
  let c = 0;
  let s = 0;
  for (let i = 0; i < fine.length; i++) {
    const v = fine[i];
    if (!(v > 0)) continue;
    const a = (2 * Math.PI * (i % FINE)) / FINE;
    c += v * Math.cos(a);
    s += v * Math.sin(a);
  }
  if (c === 0 && s === 0) return 0;
  const t = Math.atan2(s, c) / (2 * Math.PI);
  return t >= 0.5 ? t - 1 : t;
}

/**
 * Fine chroma (`frames * FINE_BINS`) to 12 pitch classes about a tuning: each fine bin goes to its nearest tuned
 * semitone, weighted cos² by its distance from it (1 on the semitone, 0 halfway).
 */
export function foldChroma(fine: Float64Array, tuning: number): Float64Array {
  const frames = fine.length / FINE_BINS;
  const pc = new Int32Array(FINE_BINS);
  const w = new Float64Array(FINE_BINS);
  for (let j = 0; j < FINE_BINS; j++) {
    const d = j / FINE - tuning;
    const near = Math.round(d);
    pc[j] = ((near % 12) + 12) % 12;
    w[j] = Math.cos(Math.PI * (d - near)) ** 2;
  }
  const out = new Float64Array(frames * 12);
  for (let f = 0; f < frames; f++) {
    for (let j = 0; j < FINE_BINS; j++) {
      const v = fine[f * FINE_BINS + j];
      if (v > 0) out[f * 12 + pc[j]] += w[j] * v;
    }
  }
  return out;
}

/** The mean power of `x` (mono, at `rate`) over its 0.5 s blocks louder than LEVEL_GATE_DB; 0 when none is. */
export function gatedPower(x: Float32Array, rate: number): number {
  const block = Math.max(1, Math.round(rate / HARMONY_RATE));
  const gate = 10 ** (LEVEL_GATE_DB / 10);
  let sum = 0;
  let n = 0;
  for (let a = 0; a < x.length; a += block) {
    const b = Math.min(x.length, a + block);
    let p = 0;
    for (let i = a; i < b; i++) p += x[i] * x[i];
    p /= b - a;
    if (p >= gate) {
      sum += p;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * The gain that brings a signal of this mean power to REF_RMS, within MIN_GAIN … MAX_GAIN; 1 for silence. Stems share
 * one gain from their powers summed, as their powers add in the signal they make together.
 */
export function levelGain(power: number): number {
  if (!(power > 0)) return 1;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, REF_RMS / Math.sqrt(power)));
}

/**
 * The fine chroma of `x` (mono, at `rate`): `frames * FINE_BINS` values (10 cents each, from C at A = 440 Hz), frame f
 * the mean over the STFT frames whose centre falls in [f / HARMONY_RATE, (f + 1) / HARMONY_RATE) of their
 * log-compressed, whitened magnitudes, each bin shared between the two fine bins about its pitch. frames =
 * ceil(duration * HARMONY_RATE). Not normalised: louder harmony weighs more. foldChroma makes the 12 pitch classes.
 * `pace` (core/pace.ts): how it yields between slices; a background Structure run passes its own, so this rests,
 * cuts finer and stops while the host has foreground work, as the rest of the run does. The result is the same.
 * `gain`: applied to the magnitudes before compression (levelGain); 1 by default.
 */
export async function fineChroma(
  x: Float32Array,
  rate: number,
  signal?: AbortSignal,
  pace: Pace = FOREGROUND,
  gain = 1,
): Promise<Float64Array> {
  const frames = Math.ceil((x.length / rate) * HARMONY_RATE);
  const out = new Float64Array(frames * FINE_BINS);
  if (frames === 0) return out;
  const n = nextPow2(WINDOW_SEC * rate);
  const hop = n / 4;
  const fft = createRealFft(n);
  const win = new Float64Array(n);
  let winSum = 0;
  for (let i = 0; i < n; i++) winSum += win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const { bin, pos } = fineMap(n, rate);
  // The floor's bins: the range folded, with room for the floor's own window on both sides.
  const lo = Math.max(1, bin[0] - FLOOR_MIN_BINS * 4);
  const hi = Math.min(n / 2, bin[bin.length - 1] + Math.ceil(bin[bin.length - 1] * (2 ** (FLOOR_SEMITONES / 12) - 1)) + 1);
  const halfWidth = new Int32Array(n / 2 + 1);
  for (let k = lo; k <= hi; k++) halfWidth[k] = Math.max(FLOOR_MIN_BINS, Math.round(k * (2 ** (FLOOR_SEMITONES / 12) - 1)));
  const mag = new Float64Array(n / 2 + 2);
  const cumMag = new Float64Array(n / 2 + 2);
  const buf = new Float64Array(n);
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  const counts = new Uint32Array(frames);
  const scale = (2 / winSum) * gain; // a full-scale sine on a bin reads 1, before the gain
  // STFT frames centred from 0 to the end; samples outside the signal are zero.
  const steps = Math.floor(x.length / hop) + 1;
  let sliceEnd = pace.slice(SLICE_FRAMES);
  for (let s = 0; s < steps; s++) {
    if (s === sliceEnd) {
      await pace.yield(signal);
      if (signal?.aborted) throw abortError("Analysis aborted");
      sliceEnd = s + pace.slice(SLICE_FRAMES);
    }
    const centre = s * hop;
    const f = Math.min(frames - 1, Math.floor((centre / rate) * HARMONY_RATE));
    const from = centre - n / 2;
    for (let i = 0; i < n; i++) {
      const j = from + i;
      buf[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
    }
    fft.forward(buf, re, im);
    for (let k = lo; k <= hi; k++) {
      mag[k] = Math.log1p(GAMMA * Math.hypot(re[k], im[k]) * scale);
      cumMag[k + 1] = cumMag[k] + mag[k];
    }
    const o = f * FINE_BINS;
    for (let b = 0; b < bin.length; b++) {
      const k = bin[b];
      const a = Math.max(lo, k - halfWidth[k]);
      const z = Math.min(hi, k + halfWidth[k]);
      const floor = (cumMag[z + 1] - cumMag[a]) / (z + 1 - a);
      const v = mag[k] - floor - PEAK_MARGIN;
      if (v <= 0) continue;
      const p = pos[b];
      const j = Math.floor(p);
      const t = p - j;
      out[o + (j % FINE_BINS)] += (1 - t) * v;
      out[o + ((j + 1) % FINE_BINS)] += t * v;
    }
    counts[f]++;
  }
  for (let f = 0; f < frames; f++) {
    if (counts[f] > 1) for (let k = 0; k < FINE_BINS; k++) out[f * FINE_BINS + k] /= counts[f];
  }
  return out;
}

/**
 * The chroma of `x`: `frames * 12` values (C first), its fine chroma folded about its own tuning (estimateTuning). The
 * arguments are fineChroma's.
 */
export async function harmonicChroma(
  x: Float32Array,
  rate: number,
  signal?: AbortSignal,
  pace: Pace = FOREGROUND,
  gain = 1,
): Promise<Float64Array> {
  const fine = await fineChroma(x, rate, signal, pace, gain);
  return foldChroma(fine, estimateTuning(fine));
}

/**
 * Under this largest value (of the chroma at REF_RMS), nothing in the clip stood out of the spectrum, and every row is
 * zero: no keys. Relative to the clip's level, as the gain comes first.
 */
const MIN_PEAK = 0.5;

/** `frames * 12` chroma as the payload carries it: rows of 12, scaled so the largest value is 1, 4 decimals. */
export function chromaRows(c: Float64Array): number[][] {
  let max = 0;
  for (const v of c) if (v > max) max = v;
  const k = max >= MIN_PEAK ? 1 / max : 0;
  const rows: number[][] = [];
  for (let f = 0; f < c.length / 12; f++) {
    const row: number[] = [];
    for (let p = 0; p < 12; p++) row.push(Math.round(c[f * 12 + p] * k * 1e4) / 1e4);
    rows.push(row);
  }
  return rows;
}
