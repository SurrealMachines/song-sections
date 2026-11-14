// Port of everything htdemucs does outside the ONNX core (spike `demucs_dsp.py`, verdict 5.1 steps 2-7).
import FFT from "fft.js";
import { createRealFft, type RealFft } from "../dsp/fft.js";

export const SAMPLE_RATE = 44100;
export const SEGMENT_LENGTH = 343980;
export const STRIDE = 257985; // int(0.75 * SEGMENT_LENGTH)
export const NFFT = 4096;
export const HOP = 1024;
export const FREQ_BINS = 2048;
export const SPEC_FRAMES = 336;
export const DEMUCS_SOURCES = ["drums", "bass", "other", "vocals"] as const; // the model's output order

const PAD = (HOP / 2) * 3; // 1536
const CENTER_PAD = NFFT / 2; // 2048 (torch.stft center=True)

export interface Chunk {
  offset: number;
  chunkLen: number;
  srcStart: number;
  srcEnd: number;
  padLeft: number;
}

/** apply_model's split=True chunking; each chunk is read SEGMENT_LENGTH long, centred on its span. */
export function chunkPlan(length: number): Chunk[] {
  const plan: Chunk[] = [];
  for (let offset = 0; offset < length; offset += STRIDE) {
    const chunkLen = Math.min(length - offset, SEGMENT_LENGTH);
    const delta = SEGMENT_LENGTH - chunkLen;
    const start = offset - Math.floor(delta / 2);
    const end = start + SEGMENT_LENGTH;
    const srcStart = Math.max(0, start);
    plan.push({ offset, chunkLen, srcStart, srcEnd: Math.min(length, end), padLeft: srcStart - start });
  }
  return plan;
}

let weightCache: Float32Array | undefined;
/** apply_model's triangular overlap-add weight (transition_power = 1), normalised to a peak of 1. */
export function chunkWeight(): Float32Array {
  if (weightCache) return weightCache;
  const n = SEGMENT_LENGTH;
  const half = Math.floor(n / 2);
  const w = new Float32Array(n);
  const max = Math.max(half, n - half);
  for (let i = 0; i < half; i++) w[i] = (i + 1) / max;
  for (let i = half; i < n; i++) w[i] = (n - i) / max;
  return (weightCache = w);
}

// torch.hann_window(4096) (periodic), rounded to float32 like the reference.
const WINDOW = (() => {
  const w = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) w[i] = Math.fround(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT));
  return w;
})();

let fftCache: RealFft | undefined;
const fft = () => (fftCache ??= createRealFft(NFFT));

/** numpy mode="reflect" index (repeats the reflection for pads longer than the signal). */
function reflectIndex(i: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * (n - 1);
  const m = ((i % period) + period) % period;
  return m < n ? m : period - m;
}

function reflectPad(x: Float32Array, left: number, right: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(left + n + right);
  out.set(x, left);
  for (let j = 0; j < left; j++) out[j] = x[reflectIndex(j - left, n)];
  for (let j = 0; j < right; j++) out[left + n + j] = x[reflectIndex(n + j, n)];
  return out;
}

/** HTDemucs._spec: x (L) -> 2048 bins x ceil(L/1024) frames, bin-major [bin * frames + frame]. */
export function spec(x: Float32Array): { re: Float32Array; im: Float32Array; frames: number } {
  const length = x.length;
  const frames = Math.ceil(length / HOP);
  const re = new Float32Array(FREQ_BINS * frames);
  const im = new Float32Array(FREQ_BINS * frames);
  if (length === 0) return { re, im, frames };
  const padded = reflectPad(reflectPad(x, PAD, PAD + frames * HOP - length), CENTER_PAD, CENTER_PAD);
  const f = fft();
  const frame = new Float64Array(NFFT);
  const bre = new Float64Array(NFFT / 2 + 1);
  const bim = new Float64Array(NFFT / 2 + 1);
  const scale = 1 / Math.sqrt(NFFT); // normalized=True
  for (let t = 0; t < frames; t++) {
    const start = (t + 2) * HOP; // keep stft frames [2, 2 + frames)
    for (let i = 0; i < NFFT; i++) frame[i] = Math.fround(padded[start + i] * WINDOW[i]);
    f.forward(frame, bre, bim);
    for (let k = 0; k < FREQ_BINS; k++) {
      re[k * frames + t] = bre[k] * scale;
      im[k * frames + t] = bim[k] * scale;
    }
  }
  return { re, im, frames };
}

let envCache: { frames: number; length: number; env: Float64Array } | undefined;

/** Sum of window^2 over the output range of ispec, counting the 4 padding frames like torch.istft. */
function envelope(frames: number, length: number, lo: number): Float64Array {
  if (envCache && envCache.frames === frames && envCache.length === length) return envCache.env;
  const env = new Float64Array(length);
  const hi = lo + length;
  for (let j = 0; j < frames + 4; j++) {
    const s = j * HOP;
    const a = Math.max(s, lo);
    const b = Math.min(s + NFFT, hi);
    for (let t = a; t < b; t++) env[t - lo] += WINDOW[t - s] * WINDOW[t - s];
  }
  envCache = { frames, length, env };
  return env;
}

/**
 * Which inverse FFT ispecInto uses (spike/cpu-speed): "paired" inverts two frames with one complex FFT, "single" is the
 * original one-frame-per-FFT path. Exported for the bench and the equivalence test only.
 */
export const ISTFT = { impl: "paired" as "paired" | "single" };

let pairCache: { cin: Float64Array; cout: Float64Array; fft: InstanceType<typeof FFT> } | undefined;

/**
 * Two real frames from one complex inverse FFT: with Z = X1 + j·X2 (each Hermitian-completed), IDFT(Z) = x1 + j·x2.
 * The unscaled IDFT is conj(FFT(conj(Z))). As in the single path, a bin-0 imaginary part is dropped (irfft) and the
 * Nyquist bin is 0. `o1` and `o2` get the two frames, unscaled.
 */
function inversePair(re: Float32Array, im: Float32Array, frames: number, t1: number, t2: number, o1: Float64Array, o2: Float64Array): void {
  const n = NFFT;
  const half = n / 2;
  pairCache ??= { cin: new Float64Array(2 * n), cout: new Float64Array(2 * n), fft: new FFT(n) };
  const { cin, cout, fft: f } = pairCache;
  cin[0] = re[t1];
  cin[1] = -re[t2];
  cin[n] = 0; // Nyquist (k = half), both frames
  cin[n + 1] = 0;
  for (let k = 1; k < half; k++) {
    const a = re[k * frames + t1];
    const b = im[k * frames + t1];
    const c = re[k * frames + t2];
    const d = im[k * frames + t2];
    cin[2 * k] = a - d;
    cin[2 * k + 1] = -b - c;
    cin[2 * (n - k)] = a + d;
    cin[2 * (n - k) + 1] = b - c;
  }
  f.transform(cout, cin);
  for (let i = 0; i < n; i++) {
    o1[i] = cout[2 * i];
    o2[i] = -cout[2 * i + 1];
  }
}

/** HTDemucs._ispec into `dst` (length samples): Nyquist = 0, 2 zero frames each side, overlap-add / envelope. */
function ispecInto(re: Float32Array, im: Float32Array, frames: number, length: number, dst: Float32Array): void {
  const lo = CENTER_PAD + PAD; // first wanted sample of the overlap-add buffer
  const hi = lo + length;
  const acc = new Float64Array(length);
  const f = fft();
  const bre = new Float64Array(NFFT / 2 + 1);
  const bim = new Float64Array(NFFT / 2 + 1);
  const out = new Float64Array(NFFT);
  const scale = 1 / Math.sqrt(NFFT); // x sqrt(n) before an irfft that divides by n
  const add = (t: number, frame: Float64Array) => {
    const s = (t + 2) * HOP;
    const a = Math.max(s, lo);
    const b = Math.min(s + NFFT, hi);
    for (let p = a; p < b; p++) acc[p - lo] += frame[p - s] * scale * WINDOW[p - s];
  };
  const inRange = (t: number) => {
    const s = (t + 2) * HOP;
    return !(s >= hi || s + NFFT <= lo);
  };
  let first = 0;
  if (ISTFT.impl === "paired") {
    const out2 = new Float64Array(NFFT);
    for (; first + 1 < frames; first += 2) {
      if (!inRange(first) && !inRange(first + 1)) continue;
      inversePair(re, im, frames, first, first + 1, out, out2);
      if (inRange(first)) add(first, out);
      if (inRange(first + 1)) add(first + 1, out2);
    }
  }
  for (let t = first; t < frames; t++) {
    const s = (t + 2) * HOP;
    if (s >= hi || s + NFFT <= lo) continue;
    for (let k = 0; k < FREQ_BINS; k++) {
      bre[k] = re[k * frames + t];
      bim[k] = im[k * frames + t];
    }
    bre[FREQ_BINS] = 0;
    bim[FREQ_BINS] = 0;
    f.inverse(bre, bim, out);
    const a = Math.max(s, lo);
    const b = Math.min(s + NFFT, hi);
    for (let p = a; p < b; p++) acc[p - lo] += out[p - s] * scale * WINDOW[p - s];
  }
  const env = envelope(frames, length, lo);
  for (let i = 0; i < length; i++) {
    if (!(env[i] > 1e-11)) throw new Error("istft window envelope (NOLA) violated");
    dst[i] = acc[i] / env[i];
  }
}

export function ispec(re: Float32Array, im: Float32Array, frames: number, length: number): Float32Array {
  const dst = new Float32Array(length);
  ispecInto(re, im, frames, length, dst);
  return dst;
}

/** Core inputs for one SEGMENT_LENGTH chunk: mix (1,2,L) and CaC spec (1,4,2048,336) = [L.re, L.im, R.re, R.im]. */
export function coreInputs(left: Float32Array, right: Float32Array): { mix: Float32Array; spec: Float32Array } {
  const build = coreInputsBuilder(left, right);
  build.channel(0);
  build.channel(1);
  return build.inputs;
}

/**
 * coreInputs one channel's STFT at a time (~30 ms each), so a caller can yield in between (fb2 review I1). `inputs`
 * is complete once both channels are done.
 */
export function coreInputsBuilder(left: Float32Array, right: Float32Array): { channel(c: 0 | 1): void; inputs: { mix: Float32Array; spec: Float32Array } } {
  if (left.length !== SEGMENT_LENGTH || right.length !== SEGMENT_LENGTH) {
    throw new Error(`Demucs chunks must be ${SEGMENT_LENGTH} samples`);
  }
  const mix = new Float32Array(2 * SEGMENT_LENGTH);
  mix.set(left, 0);
  mix.set(right, SEGMENT_LENGTH);
  const plane = FREQ_BINS * SPEC_FRAMES;
  const out = new Float32Array(4 * plane);
  return {
    channel(c) {
      const x = spec(c === 0 ? left : right);
      out.set(x.re, 2 * c * plane);
      out.set(x.im, (2 * c + 1) * plane);
    },
    inputs: { mix, spec: out },
  };
}

/**
 * coreOutputsToWave for source `s` only, written into its rows of `out` (4,2,L). ~50 ms of work per call; ~25 ms with
 * `channel` (only that channel's row).
 */
export function coreOutputSourceInto(specOut: Float32Array, waveOut: Float32Array, s: number, out: Float32Array, channel?: 0 | 1): void {
  const plane = FREQ_BINS * SPEC_FRAMES;
  for (let c = channel ?? 0; c < (channel ?? 0) + (channel === undefined ? 2 : 1); c++) {
    const base = (s * 4 + 2 * c) * plane;
    const o = (s * 2 + c) * SEGMENT_LENGTH;
    const dst = out.subarray(o, o + SEGMENT_LENGTH);
    ispecInto(specOut.subarray(base, base + plane), specOut.subarray(base + plane, base + 2 * plane), SPEC_FRAMES, SEGMENT_LENGTH, dst);
    for (let i = 0; i < SEGMENT_LENGTH; i++) dst[i] += waveOut[o + i];
  }
}

/** iSTFT(frequency branch) + time branch for all 4 sources: specOut (1,4,4,2048,336), waveOut (1,4,2,L) -> (4,2,L). */
export function coreOutputsToWave(specOut: Float32Array, waveOut: Float32Array): Float32Array {
  const out = new Float32Array(4 * 2 * SEGMENT_LENGTH);
  for (let s = 0; s < 4; s++) coreOutputSourceInto(specOut, waveOut, s, out);
  return out;
}
