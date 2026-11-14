// allin1's 8 Harmonix folds, run one at a time and averaged in JS (ruling S8, verdict §5.3), never
// allin1_harmonix_all.onnx. Peak memory is one fold session plus the running sums.
import { join } from "node:path";
import { abortError } from "../../core/abort.js";
import { FOREGROUND, type Pace } from "../../core/pace.js";
import { BANDS } from "../allin1/features.js";
import { FUNCTION_LABELS } from "../contract.js";
import { type Ort, hostFloat32 } from "../runtime.js";
import { type SessionOptions, SESSION_OPTIONS, flushReleased, openSession, outputData, runSession } from "./sessions.js";

export const FOLD_COUNT = 8;

/**
 * Longest input one fold run gets (frames, 100 per second: 6 minutes). A run's memory grows with its length,
 * ~125 MB + 37.7 KB per frame (findings E10: 1.23 GB at 5 min, 2.29 GB at 10, 4.63 GB at 20), so longer inputs are
 * run in overlapping windows of at most this many frames. Up to this length the fold sees the whole input at once.
 * In Live's host the first fold run lands on top of the memory Demucs released (E10), so this bounds the peak:
 * 48 000 frames gave 3.03 GB at 20 minutes in the host, 36 000 gave 2.54 GB for ~20 % more fold time than 48 000.
 */
export const FOLD_MAX_FRAMES = 36_000;

/**
 * Frames of input a window keeps on each side of the frames it outputs. allin1's 11 dilated blocks (dilations 1..1024,
 * kernel 5, in the time and in the instrument-time attention) see 2 * 2 * 2047 = 8188 frames each way, plus the
 * convolutional embedding: measured on Flim, a window edge changes outputs up to 8000-8250 frames away and none
 * beyond. With this context a window's outputs differ from a whole-input run's only at ORT's own noise floor (E10).
 */
export const FOLD_CONTEXT_FRAMES = 8_500;

/** One fold run: input frames [inStart, inEnd), of which [outStart, outEnd) are kept. */
export interface FoldWindow {
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
}

/**
 * The windows for T frames: one over everything when T <= maxFrames; otherwise the fewest windows of at most
 * maxFrames input frames whose outputs tile [0, T) and that keep `context` frames on every side away from the ends.
 * The outputs are sized so that every window's input has the same length (the end windows need context on one side).
 */
export function foldWindows(T: number, maxFrames = FOLD_MAX_FRAMES, context = FOLD_CONTEXT_FRAMES): FoldWindow[] {
  if (!(maxFrames > 2 * context)) throw new RangeError(`foldWindows: maxFrames (${maxFrames}) must exceed twice the context (${context})`);
  if (T <= maxFrames) return [{ inStart: 0, inEnd: T, outStart: 0, outEnd: T }];
  for (let n = Math.max(2, Math.ceil((T - 2 * context) / (maxFrames - 2 * context))); ; n++) {
    const middle = (T - 2 * context) / n; // outputs: the end windows get middle + context, the others middle
    const bounds = [0];
    for (let i = 1; i < n; i++) bounds.push(Math.round(middle + context + (i - 1) * middle));
    bounds.push(T);
    const plan = bounds.slice(0, -1).map((outStart, i) => {
      const outEnd = bounds[i + 1];
      return { inStart: Math.max(0, outStart - context), inEnd: Math.min(T, outEnd + context), outStart, outEnd };
    });
    if (plan.every((w) => w.inEnd - w.inStart <= maxFrames)) return plan;
  }
}

export interface FoldOptions {
  session?: SessionOptions;
  /** Window settings (tests); see FOLD_MAX_FRAMES and FOLD_CONTEXT_FRAMES. */
  maxFrames?: number;
  context?: number;
  /** How it yields between runs (core/pace.ts); FOREGROUND when absent. A run itself cannot be split. */
  pace?: Pace;
}

/** flushReleased with fold 0 (findings E10): returns released sessions' memory before the next big allocation. */
export function flushReleasedMemory(ort: Ort, modelDir: string): Promise<void> {
  return flushReleased(ort, join(modelDir, foldFile(0)));
}
const STEMS = 4;
const FUNCTIONS = FUNCTION_LABELS.length; // 10

export function foldFile(k: number): string {
  return `allin1_harmonix_fold${k}.onnx`;
}

export interface FoldLogits {
  beat: Float32Array; // T
  downbeat: Float32Array; // T
  section: Float32Array; // T
  fn: Float32Array; // 10×T, function-major (logits_function [1,10,T])
}

/**
 * Runs fold k = 0..7 on `spec` [1,4,T,81] (stems in MODEL_STEM_ORDER), adding each output into a float32
 * running sum and releasing the session before the next fold, then divides by 8. That is exactly what the
 * spike's make_ref_mean.py does in numpy (float32 adds in fold order, then /8, which is exact), so the result
 * matches its allin1_mean_*.npy bit for bit when the per-fold outputs do.
 *
 * Up to FOLD_MAX_FRAMES (6 min) each fold sees the whole spec in one run. Longer inputs run as foldWindows: each fold
 * session runs once per window and keeps the window's output frames, so memory and the time of one run stay bounded.
 *
 * `signal` is checked before each fold and each window (a run cannot be interrupted, so a cancel lands within one
 * run: ~3 s at 5 min; within one fold window, ~4–6 s, worst case not timed); an abort rejects with an Error named "AbortError".
 * `onFold(k)` is called after fold k is released. Every opened session is released on every exit path.
 */
export async function runFolds(
  ort: Ort,
  modelDir: string,
  spec: Float32Array,
  T: number,
  signal: AbortSignal,
  onFold: (k: number) => void,
  options: FoldOptions = {},
): Promise<FoldLogits> {
  if (!Number.isInteger(T) || T < 1) throw new Error(`runFolds: T must be a positive integer, got ${T}`);
  if (spec.length !== STEMS * T * BANDS) throw new Error(`runFolds: spec has ${spec.length} values, expected 4·T·81 = ${STEMS * T * BANDS}`);
  const sum: FoldLogits = {
    beat: new Float32Array(T),
    downbeat: new Float32Array(T),
    section: new Float32Array(T),
    fn: new Float32Array(FUNCTIONS * T),
  };
  const outputs: [name: string, into: Float32Array, rows: number][] = [
    ["logits_beat", sum.beat, 0],
    ["logits_downbeat", sum.downbeat, 0],
    ["logits_section", sum.section, 0],
    ["logits_function", sum.fn, FUNCTIONS],
  ];
  const plan = foldWindows(T, options.maxFrames, options.context);
  const whole = plan.length === 1 ? hostFloat32(spec) : undefined; // zero-copy, shared by all 8 runs
  const longest = Math.max(...plan.map((w) => w.inEnd - w.inStart));
  const windowBuffer = whole ? undefined : new Float32Array(STEMS * longest * BANDS);
  const windowInput = (w: FoldWindow): Float32Array => {
    if (whole) return whole;
    const L = w.inEnd - w.inStart;
    const buf = windowBuffer!.subarray(0, STEMS * L * BANDS);
    for (let s = 0; s < STEMS; s++) buf.set(spec.subarray((s * T + w.inStart) * BANDS, (s * T + w.inEnd) * BANDS), s * L * BANDS);
    return hostFloat32(buf);
  };

  const pace = options.pace ?? FOREGROUND;
  for (let k = 0; k < FOLD_COUNT; k++) {
    if (signal.aborted) throw abortError();
    const file = foldFile(k);
    const { session, release } = await openSession(ort, join(modelDir, file), options.session ?? SESSION_OPTIONS);
    try {
      for (const [i, w] of plan.entries()) {
        if (i > 0) await pace.yield(signal); // between the windows of a long input
        if (signal.aborted) throw abortError();
        const L = w.inEnd - w.inStart;
        const out = await runSession(session, { spec: new ort.Tensor("float32", windowInput(w), [1, STEMS, L, BANDS]) }, file);
        for (const [name, into, rows] of outputs) {
          const data = outputData(out, name, rows ? [1, rows, L] : [1, L], file);
          for (let r = 0; r < Math.max(1, rows); r++) {
            const from = r * L - w.inStart;
            const to = r * T;
            for (let t = w.outStart; t < w.outEnd; t++) into[to + t] += data[from + t]; // stored as float32, like numpy's float32 +
          }
        }
      }
    } finally {
      await release();
    }
    onFold(k);
    await pace.yield(signal);
  }
  for (const [, into] of outputs) {
    for (let i = 0; i < into.length; i++) into[i] /= FOLD_COUNT;
  }
  return sum;
}
