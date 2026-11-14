// Chunked htdemucs separation around an injected core (spike `demucs_dsp.separate`, batch 1).
import {
  SEGMENT_LENGTH,
  chunkPlan,
  chunkWeight,
  coreInputsBuilder,
  coreOutputSourceInto,
} from "./dsp.js";
import { abortError, throwIfAborted } from "../../core/abort.js";
import { FOREGROUND, type Pace } from "../../core/pace.js";

export type DemucsCore = (inputs: { mix: Float32Array; spec: Float32Array }) => Promise<{ specOut: Float32Array; waveOut: Float32Array }>;

export interface StemSink {
  /** Finalised, de-normalised samples of `source` (DEMUCS_SOURCES order) at `offset`, ascending and contiguous per source. */
  write(source: number, left: Float32Array, right: Float32Array, offset: number): Promise<void>;
}

const SOURCES = 4;
/** Samples per slice of a whole-track pass between yields (~5–10 ms of work; Global Constraints: yield every ~100 ms). */
const PASS_SLICE = 1 << 22;

/**
 * Normalise (unbiased std, as torch), run the core chunk by chunk with triangular overlap-add, and
 * stream the finished samples to `sink`. Working state is one segment per source and channel.
 */
export async function separate(
  left: Float32Array,
  right: Float32Array,
  core: DemucsCore,
  sink: StemSink,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
  pace: Pace = FOREGROUND,
): Promise<void> {
  const n = left.length;
  if (right.length !== n) throw new Error("Channel length mismatch");
  if (n === 0) return;
  if (signal.aborted) throw abortError();

  // ref = mean over channels; wav = (wav - mean(ref)) / (std(ref, ddof=1) + 1e-8). Sliced only to yield: the
  // additions happen in the same order as one loop.
  let sum = 0;
  for (let a = 0, b = 0; a < n; a = b) {
    b = Math.min(n, a + pace.slice(PASS_SLICE));
    for (let i = a; i < b; i++) sum += (left[i] + right[i]) / 2;
    if (b < n) {
      await pace.yield(signal);
      throwIfAborted(signal);
    }
  }
  const mean = sum / n;
  let sq = 0;
  for (let a = 0, b = 0; a < n; a = b) {
    b = Math.min(n, a + pace.slice(PASS_SLICE));
    for (let i = a; i < b; i++) {
      const d = (left[i] + right[i]) / 2 - mean;
      sq += d * d;
    }
    if (b < n) {
      await pace.yield(signal);
      throwIfAborted(signal);
    }
  }
  if (signal.aborted) throw abortError();
  const std = (n > 1 ? Math.sqrt(sq / (n - 1)) : 0) + 1e-8;

  const plan = chunkPlan(n);
  const weight = chunkWeight();
  // acc[s * 2 + c] and sumW cover [base, base + SEGMENT_LENGTH).
  const acc = Array.from({ length: SOURCES * 2 }, () => new Float32Array(SEGMENT_LENGTH));
  const sumW = new Float32Array(SEGMENT_LENGTH);
  let base = 0;

  const cl = new Float32Array(SEGMENT_LENGTH);
  const cr = new Float32Array(SEGMENT_LENGTH);
  const est = new Float32Array(SOURCES * 2 * SEGMENT_LENGTH);

  for (let k = 0; k < plan.length; k++) {
    if (signal.aborted) throw abortError();
    const { offset, chunkLen, srcStart, srcEnd, padLeft } = plan[k];

    cl.fill(0);
    cr.fill(0);
    for (let i = srcStart; i < srcEnd; i++) {
      cl[padLeft + i - srcStart] = (left[i] - mean) / std;
      cr[padLeft + i - srcStart] = (right[i] - mean) / std;
    }
    // A background pace cuts finer (fb2 review I1): one channel's STFT, then the other's, with a yield between (each
    // ~30 ms), and the iSTFT below one channel at a time. The foreground yields as it did.
    const fine = pace.slice(2) < 2;
    const build = coreInputsBuilder(cl, cr);
    build.channel(0);
    if (fine) await pace.yield(signal);
    build.channel(1);
    const { mix, spec } = build.inputs;
    await pace.yield(signal);
    const { specOut, waveOut } = await core({ mix, spec });
    if (signal.aborted) throw abortError();
    // The iSTFT of one chunk is ~200 ms of work: one source at a time, yielding in between.
    for (let s = 0; s < SOURCES; s++) {
      await pace.yield(signal);
      if (!fine) coreOutputSourceInto(specOut, waveOut, s, est);
      else {
        coreOutputSourceInto(specOut, waveOut, s, est, 0);
        await pace.yield(signal);
        coreOutputSourceInto(specOut, waveOut, s, est, 1);
      }
    }

    // center_trim the estimate back to chunkLen, then weight[:chunkLen] from the window start.
    const trim = Math.floor((SEGMENT_LENGTH - chunkLen) / 2);
    const rel = offset - base;
    for (let s = 0; s < SOURCES; s++) {
      for (let c = 0; c < 2; c++) {
        const a = acc[s * 2 + c];
        const e = (s * 2 + c) * SEGMENT_LENGTH + trim;
        for (let j = 0; j < chunkLen; j++) a[rel + j] += weight[j] * est[e + j];
      }
    }
    for (let j = 0; j < chunkLen; j++) sumW[rel + j] += weight[j];
    await pace.yield(signal);

    // Everything before the next chunk's offset (or the end of the track) is final.
    const upTo = k + 1 < plan.length ? plan[k + 1].offset : n;
    const count = upTo - base;
    for (let s = 0; s < SOURCES; s++) {
      const l = new Float32Array(count);
      const r = new Float32Array(count);
      const al = acc[s * 2];
      const ar = acc[s * 2 + 1];
      for (let j = 0; j < count; j++) {
        l[j] = (al[j] / sumW[j]) * std + mean;
        r[j] = (ar[j] / sumW[j]) * std + mean;
      }
      await sink.write(s, l, r, base);
    }
    // Slide the window forward.
    for (const a of acc) {
      a.copyWithin(0, count);
      a.fill(0, SEGMENT_LENGTH - count);
    }
    sumW.copyWithin(0, count);
    sumW.fill(0, SEGMENT_LENGTH - count);
    base = upTo;

    onProgress((k + 1) / plan.length);
    await pace.yield(signal);
  }
}
