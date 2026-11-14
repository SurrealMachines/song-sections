// Streaming port of julius 0.2.7 `ResampleFrac` (zeros = 24, rolloff = 0.945), the resampler demucs
// uses in convert_audio. Same maths as `$SITE/julius/resample.py`. Not bit-exact by design: kernels are
// float64 (julius uses float32), and taps outside the sinc support are skipped (they are about 1e-49 in
// julius too, clamped to +-24 pi). Measured 118 dB SNR against julius for 48 kHz -> 44.1 kHz.

const ZEROS = 24;
const ROLLOFF = 0.945;
const MAX_KERNEL_VALUES = 2_000_000; // 16 MB of float64; 192 kHz -> 44.1 kHz needs ~130k

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

const sinc = (t: number) => (t === 0 ? 1 : Math.sin(t) / t);

export interface Resampler {
  /** Feed samples; returns the output that is final so far (possibly empty). */
  push(x: Float32Array): Float32Array;
  /** Flush the tail; the concatenated output has floor(toRate * N / fromRate) samples. */
  end(): Float32Array;
}

export function createResampler(fromRate: number, toRate: number): Resampler {
  const near = (r: number) => (Math.abs(r - Math.round(r)) < 1e-6 ? Math.round(r) : r);
  fromRate = near(fromRate);
  toRate = near(toRate);
  if (!Number.isInteger(fromRate) || !Number.isInteger(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error(`Unsupported sample rate ${fromRate} -> ${toRate} Hz (need positive whole numbers)`);
  }
  const g = gcd(fromRate, toRate);
  const oldSr = fromRate / g;
  const newSr = toRate / g;

  if (oldSr === newSr) {
    return { push: (x) => Float32Array.from(x), end: () => new Float32Array(0) };
  }

  const sr = Math.min(newSr, oldSr) * ROLLOFF;
  const width = Math.ceil((ZEROS * oldSr) / sr);
  const taps = 2 * width + oldSr;
  if (newSr * taps > MAX_KERNEL_VALUES) throw new Error(`Unsupported resampling ratio ${fromRate} -> ${toRate}`);

  // kernel[i * taps + k]: output phase i, tap k; idx runs -width .. width + oldSr - 1.
  // lo[i]..hi[i] is the range of taps whose unclamped |t| < ZEROS: the rest are clamped and ~1e-49, so skipped.
  const kernel = new Float64Array(newSr * taps);
  const lo = new Int32Array(newSr);
  const hi = new Int32Array(newSr);
  for (let i = 0; i < newSr; i++) {
    let sum = 0;
    const base = i * taps;
    lo[i] = taps;
    hi[i] = 0;
    for (let k = 0; k < taps; k++) {
      let t = (-i / newSr + (k - width) / oldSr) * sr;
      if (Math.abs(t) < ZEROS) {
        if (k < lo[i]) lo[i] = k;
        hi[i] = k + 1;
      }
      t = Math.max(-ZEROS, Math.min(ZEROS, t));
      t *= Math.PI;
      const w = Math.cos(t / ZEROS / 2) ** 2;
      const v = sinc(t) * w;
      kernel[base + k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) kernel[base + k] /= sum; // constant signals are preserved
  }

  let tail = new Float64Array(0); // padded samples not yet consumed by a whole frame
  let started = false;
  let last = 0;
  let total = 0; // input samples seen
  let emitted = 0;

  /** Convolve every whole frame available in `work`; keep the rest in `tail`. */
  function run(work: Float64Array): Float32Array {
    const frames = work.length >= taps ? Math.floor((work.length - taps) / oldSr) + 1 : 0;
    const out = new Float32Array(frames * newSr);
    for (let m = 0; m < frames; m++) {
      const off = m * oldSr;
      for (let i = 0; i < newSr; i++) {
        const kb = i * taps;
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        let k = lo[i];
        const end = hi[i];
        for (; k + 3 < end; k += 4) {
          a0 += kernel[kb + k] * work[off + k];
          a1 += kernel[kb + k + 1] * work[off + k + 1];
          a2 += kernel[kb + k + 2] * work[off + k + 2];
          a3 += kernel[kb + k + 3] * work[off + k + 3];
        }
        for (; k < end; k++) a0 += kernel[kb + k] * work[off + k];
        out[m * newSr + i] = a0 + a1 + a2 + a3;
      }
    }
    tail = work.slice(frames * oldSr);
    return out;
  }

  function concat(head: Float64Array, x: ArrayLike<number>, lead: number, trail: number, trailValue: number) {
    const w = new Float64Array(head.length + lead + x.length + trail);
    w.set(head);
    if (lead) w.fill(x[0], head.length, head.length + lead);
    const at = head.length + lead;
    for (let i = 0; i < x.length; i++) w[at + i] = x[i];
    if (trail) w.fill(trailValue, at + x.length);
    return w;
  }

  return {
    push(x) {
      if (x.length === 0) return new Float32Array(0);
      const lead = started ? 0 : width;
      started = true;
      total += x.length;
      last = x[x.length - 1];
      const out = run(concat(tail, x, lead, 0, 0));
      emitted += out.length;
      return out;
    },
    end() {
      if (total === 0) return new Float32Array(0);
      const out = run(concat(tail, [], 0, width + oldSr, last));
      const want = Math.floor((newSr * total) / oldSr) - emitted;
      const res = out.subarray(0, Math.max(0, Math.min(out.length, want)));
      emitted += res.length;
      tail = new Float64Array(0);
      return res;
    },
  };
}
