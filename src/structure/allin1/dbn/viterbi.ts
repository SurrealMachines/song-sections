// Port of madmom 0.16.1 HiddenMarkovModel.viterbi (madmom/ml/hmm.pyx), storing backpointers only where they carry
// information. See downbeats.ts for the licence notice.
import { throwIfAborted } from "../../../core/abort.js";
import { FOREGROUND, type Pace } from "../../../core/pace.js";
import type { TransitionModel } from "./transition.js";

export interface ViterbiOptions {
  signal?: AbortSignal;
  /** How it yields (core/pace.ts); FOREGROUND when absent. */
  pace?: Pace;
}

/** Frames of forward work between yields to the host (500 frames at 15k states: ~40 ms of work, 77 ms for 1000). */
const YIELD_FRAMES = 500;

/**
 * In madmom's bar state space every state but the first of each tempo (per beat) has exactly one source, the state
 * before it, so its backpointer is known without storing it. Returns, per state, its column in the stored backpointer
 * table (-1 for a single-source state), and the column count. States with no source at all count as stored: they
 * are -Infinity on every frame, so never on a path, and storing them keeps the decode identical for any model.
 */
function storedColumns(tm: TransitionModel): { column: Int32Array; count: number } {
  const S = tm.pointers.length - 1;
  const column = new Int32Array(S).fill(-1);
  let count = 0;
  for (let s = 0; s < S; s++) if (tm.pointers[s + 1] - tm.pointers[s] !== 1) column[s] = count++;
  return { column, count };
}

/** States whose backpointer is stored (240 for madmom's 4/4 bar model with 60 tempi). */
export function multiSourceStates(tm: TransitionModel): number {
  return storedColumns(tm).count;
}

/** Bytes the decode allocates for T frames: two Viterbi vectors, the stored backpointers (uint16) and the path. */
export function viterbiWorkspaceBytes(tm: TransitionModel, T: number): number {
  const S = tm.pointers.length - 1;
  return 2 * S * 8 + T * multiSourceStates(tm) * 2 + S * 4 + T * 4;
}

/** One forward frame: cur[s] = max over sources p of prev[p] + logProb + density, first (lowest) source on ties. */
function forward(
  tm: TransitionModel,
  omPointers: Uint8Array,
  densities: Float64Array,
  t: number,
  prev: Float64Array,
  cur: Float64Array,
  column: Int32Array,
  bp: Uint16Array,
  bpOffset: number,
): void {
  const ptr = tm.pointers;
  const src = tm.states;
  const lp = tm.logProbs;
  const S = cur.length;
  const d0 = densities[3 * t];
  const d1 = densities[3 * t + 1];
  const d2 = densities[3 * t + 2];
  for (let s = 0; s < S; s++) {
    const o = omPointers[s];
    const d = o === 0 ? d0 : o === 1 ? d1 : d2;
    let p = ptr[s];
    const end = ptr[s + 1];
    if (end - p === 1) {
      // single source (every state but the first state of a tempo): its backpointer is always src[p] on a finite
      // path, so it is not stored (madmom stores 0 when the score is -Infinity; such a state is never on the path)
      const v = prev[src[p]] + lp[p] + d;
      cur[s] = v > -Infinity ? v : -Infinity;
      continue;
    }
    let best = -Infinity;
    let arg = 0;
    for (; p < end; p++) {
      const q = src[p];
      const v = prev[q] + lp[p] + d;
      if (v > best) {
        best = v;
        arg = q;
      }
    }
    cur[s] = best;
    bp[bpOffset + column[s]] = arg;
  }
}

/**
 * Most likely state path for T frames of densities (row-major T×3, indexed by om.pointers). The initial
 * distribution is uniform. Returns an empty path when the best log probability is -Infinity, as madmom does.
 * Bit-identical to storing every backpointer: only the multi-source states' backpointers are stored (uint16,
 * T × 240 for 4/4: 58 MB for 20 minutes), and a single-source state's predecessor is its one source.
 */
export async function viterbi(
  tm: TransitionModel,
  om: { pointers: Uint8Array },
  densities: Float64Array,
  T: number,
  opts: ViterbiOptions = {},
): Promise<{ path: Uint32Array; logProb: number }> {
  const { signal, pace = FOREGROUND } = opts;
  throwIfAborted(signal);
  const S = tm.pointers.length - 1;
  if (S > 65536) throw new RangeError(`uint16 backpointers need at most 65536 states, got ${S}`);
  if (densities.length < 3 * T) throw new RangeError(`need ${3 * T} densities, got ${densities.length}`);

  let prev: Float64Array = new Float64Array(S).fill(Math.log(1 / S));
  let cur: Float64Array = new Float64Array(S);
  if (T === 0) return { path: new Uint32Array(0), logProb: prev[0] };

  const { column, count: M } = storedColumns(tm);
  const bp = new Uint16Array(T * M);
  for (let t = 0; t < T; t++) {
    forward(tm, om.pointers, densities, t, prev, cur, column, bp, t * M);
    const swap = prev;
    prev = cur;
    cur = swap;
    if ((t + 1) % pace.slice(YIELD_FRAMES) === 0) {
      await pace.yield(signal);
      throwIfAborted(signal);
    }
  }

  let state = 0;
  let logProb = -Infinity;
  for (let s = 0; s < S; s++)
    if (prev[s] > logProb) {
      logProb = prev[s];
      state = s;
    }
  if (logProb === -Infinity) return { path: new Uint32Array(0), logProb };

  const path = new Uint32Array(T);
  const ptr = tm.pointers;
  const src = tm.states;
  for (let t = T - 1; t >= 0; t--) {
    path[t] = state;
    const c = column[state];
    state = c < 0 ? src[ptr[state]] : bp[t * M + c];
  }
  return { path, logProb };
}
