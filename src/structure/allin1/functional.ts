// Port of allin1 1.1.0 postprocessing/functional.py + helpers.py (local_maxima, peak_picking, event_frames_to_time).
// Golden: identical boundary frames and labels against the Python on the Flim logits (Plan 3, Task 6).
import { FUNCTION_LABELS, type BoundaryCandidate, type StructureSegment } from "../contract.js";
import { torchSigmoid } from "./dbn/activations.js";

const FPS = 100;
const HOP = 441;
const SAMPLE_RATE = 44100;
const MIN_HOPS_PER_BEAT = 24;
const LOCAL_MAX_FILTER = 4 * MIN_HOPS_PER_BEAT + 1; // 97
const PEAK_WINDOW = 12 * FPS; // past = future = 1200 frames
const CLASSES = FUNCTION_LABELS.length;

const f32 = Math.fround;

/** The contract's floor for StructureAnalysis.boundaryCandidates (chosen boundaries are kept below it too). */
export const CANDIDATE_MIN_STRENGTH = 0.001; // controller ruling (fb1): 0.01 left Flim only 7 extra candidates

/**
 * allin1's `torch.sigmoid(logits_section)`: the DBN's bit-exact port of torch 2.5.1's CPU sigmoid (Sleef expf on
 * 16-lane blocks, std::exp on the tail), applied to the whole T-vector as torch does. Known limit (Task 7): above
 * 32768 frames torch may split the vector across threads, which moves the block/tail split.
 */
export function sectionProbabilities(section: Float32Array): Float32Array {
  return torchSigmoid(section);
}

/** librosa.frames_to_time(frame, sr, hop_length): same expression order as the Python, so the float64 result is identical. */
const frameToTime = (frame: number) => (frame * HOP) / SAMPLE_RATE;

/**
 * max(x[i - half .. i + half]) (clipped to the array) for every i, in O(n) with a monotonic deque. NaN is never a
 * maximum, as with the `>` scans it replaces; -Infinity when the window holds nothing else.
 */
function windowMax(x: Float32Array, half: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const dq = new Int32Array(n); // indices with decreasing values
  let head = 0;
  let tail = 0;
  let next = 0; // next index to push
  for (let i = 0; i < n; i++) {
    for (const e = Math.min(n - 1, i + half); next <= e; next++) {
      const v = x[next];
      if (Number.isNaN(v)) continue;
      while (tail > head && x[dq[tail - 1]] <= v) tail--;
      dq[tail++] = next;
    }
    while (tail > head && dq[head] < i - half) head++;
    out[i] = tail > head ? x[dq[head]] : -Infinity;
  }
  return out;
}

/** helpers.local_maxima: keep a value only where it equals the max of its 97-wide window (-inf padding). */
function localMaxima(x: Float32Array): Float32Array {
  const n = x.length;
  const max = windowMax(x, (LOCAL_MAX_FILTER - 1) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) if (x[i] === max[i]) out[i] = x[i];
  return out;
}

/**
 * helpers.peak_picking with past = future = 1200 and zero padding. Returns the frames whose strength is > 0:
 * a local maximum (> 0) of the 2401-wide window whose value exceeds the mean of the past and future windows.
 * Only non-zero frames can qualify.
 */
function pickPeaks(a: Float32Array): number[] {
  const n = a.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + a[i];
  const max = windowMax(a, PEAK_WINDOW); // O(n): a long plateau made the per-frame scan O(n x 2401) (Task 11)
  const picked: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(a[i] > 0)) continue;
    if (max[i] > a[i]) continue; // some frame in the window is larger

    // Windows are always PEAK_WINDOW long: frames outside [0, n) count as zeros.
    const past = (prefix[i] - prefix[Math.max(0, i - PEAK_WINDOW)]) / PEAK_WINDOW;
    const future = (prefix[Math.min(n, i + 1 + PEAK_WINDOW)] - prefix[i + 1]) / PEAK_WINDOW;
    if (a[i] - (past + future) / 2 > 0) picked.push(i);
  }
  return picked;
}

/** softmax over the 10 classes of class-major logits (10 × T), float32, for one frame. */
function softmaxFrame(fn: Float32Array, T: number, t: number, out: Float32Array, o: number): void {
  let max = -Infinity;
  for (let c = 0; c < CLASSES; c++) if (fn[c * T + t] > max) max = fn[c * T + t];
  let sum = 0;
  for (let c = 0; c < CLASSES; c++) {
    const e = f32(Math.exp(f32(fn[c * T + t] - max)));
    out[o + c] = e;
    sum = f32(sum + e);
  }
  for (let c = 0; c < CLASSES; c++) out[o + c] = f32(out[o + c] / sum);
}

/** The T × 10 (frame-major) softmax of the function logits. Task 9 summarises it into functionProbs. */
export function functionProbsPerFrame(fn: Float32Array, T: number): Float32Array {
  const out = new Float32Array(T * CLASSES);
  for (let t = 0; t < T; t++) softmaxFrame(fn, T, t, out, t * CLASSES);
  return out;
}

/**
 * allin1's postprocess_functional_structure, plus the frames it could have chosen. `section` is T logits, `fn` is
 * 10 × T class-major. Boundaries are the sigmoid section probabilities after local-maximum filtering and peak
 * picking; each segment's label is the argmax of its mean softmax. Returns no segments when T is 0.
 * Unlike allin1, which raises IndexError when no frame has a section probability above 0, this gives one segment.
 * `probs` is functionProbsPerFrame(fn, T), when the caller has it already.
 *
 * `candidates` (the contract's boundaryCandidates): every frame > 0 that survives the 97-frame local-maximum filter
 * with probability >= CANDIDATE_MIN_STRENGTH, plus every chosen boundary frame whatever its probability (so each
 * segment start after the first is a candidate, as the same float), ascending.
 */
export function functionalStructure(
  section: Float32Array,
  fn: Float32Array,
  T: number,
  probs?: Float32Array,
): { segments: StructureSegment[]; candidates: BoundaryCandidate[] } {
  if (T <= 0) return { segments: [], candidates: [] };
  const prob = sectionProbabilities(section.length === T ? section : section.subarray(0, T));
  const maxima = localMaxima(prob);
  const frames = pickPeaks(maxima);

  const candidates: BoundaryCandidate[] = [];
  for (let i = 1, k = 0; i < T; i++) {
    while (k < frames.length && frames[k] < i) k++;
    if ((maxima[i] > 0 && maxima[i] >= CANDIDATE_MIN_STRENGTH) || frames[k] === i) {
      candidates.push({ time: frameToTime(i), strength: Math.round(prob[i] * 10000) / 10000 });
    }
  }

  const duration = frameToTime(T);
  const times = frames.map(frameToTime);
  if (times.length === 0 || times[0] !== 0) times.unshift(0);
  if (times[times.length - 1] !== duration) times.push(duration);

  // np.split at the boundary frames > 0: label ranges [0, i1), [i1, i2) ... [ik, T).
  const cuts = [0, ...frames.filter((f) => f > 0), T];
  probs ??= functionProbsPerFrame(fn, T);
  const labels: StructureSegment["label"][] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const sums = new Float64Array(CLASSES);
    for (let t = cuts[k]; t < cuts[k + 1]; t++) for (let c = 0; c < CLASSES; c++) sums[c] += probs[t * CLASSES + c];
    let best = 0;
    for (let c = 1; c < CLASSES; c++) if (sums[c] > sums[best]) best = c;
    labels.push(FUNCTION_LABELS[best]);
  }

  const segments: StructureSegment[] = [];
  for (let i = 0; i + 1 < times.length && i < labels.length; i++) segments.push({ start: times[i], end: times[i + 1], label: labels[i] });
  return { segments, candidates };
}

/** functionalStructure's segments alone. */
export function functionalSegments(section: Float32Array, fn: Float32Array, T: number, probs?: Float32Array): StructureSegment[] {
  return functionalStructure(section, fn, T, probs).segments;
}
