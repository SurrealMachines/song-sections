// Port of madmom 0.16.1 exponential_transition / BarTransitionModel (madmom/features/beats_hmm.py) and
// TransitionModel.make_sparse (madmom/ml/hmm.pyx). See downbeats.ts for the licence notice.
import type { BarStateSpace } from "./stateSpace.js";

/**
 * Sparse transitions in scipy canonical CSR form, keyed by destination state: the sources of state s are
 * states[pointers[s] .. pointers[s+1]-1], ascending, with log probabilities logProbs[...].
 */
export interface TransitionModel {
  pointers: Uint32Array;
  states: Uint32Array;
  logProbs: Float64Array;
}

/** np.spacing(1): values at or below it are dropped by exponential_transition. */
const EPS = 2.220446049250313e-16;

/** numpy's float64 pairwise summation (the inner loop of np.add.reduce over a contiguous axis), plus its 0 identity. */
export function numpySum(a: ArrayLike<number>, offset: number, n: number): number {
  return 0 + pairwise(a, offset, n);
}

function pairwise(a: ArrayLike<number>, o: number, n: number): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[o + i];
    return res;
  }
  if (n <= 128) {
    const r = [a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o + 6], a[o + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[o + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[o + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(a, o, n2) + pairwise(a, o + n2, n - n2);
}

/**
 * exponential_transition(from, to, lambda): row-major [from][to] matrix of exp(-lambda * |to/from - 1|), values
 * <= eps set to 0, each row normalised to sum to 1 (numpy's summation order).
 */
export function exponentialTransition(fromIntervals: ArrayLike<number>, toIntervals: ArrayLike<number>, lambda: number): Float64Array {
  const nf = fromIntervals.length;
  const nt = toIntervals.length;
  const prob = new Float64Array(nf * nt);
  for (let i = 0; i < nf; i++) {
    for (let j = 0; j < nt; j++) {
      const ratio = toIntervals[j] / fromIntervals[i];
      const p = Math.exp(-lambda * Math.abs(ratio - 1));
      prob[i * nt + j] = p <= EPS ? 0 : p;
    }
    const sum = numpySum(prob, i * nt, nt);
    for (let j = 0; j < nt; j++) prob[i * nt + j] /= sum;
  }
  return prob;
}

/**
 * BarTransitionModel(state_space, lambda). Every state that is not the first state of a tempo has the single
 * source s-1 with probability 1; the first state of tempo j in beat b has a source from each last state of the
 * previous beat (b-1, wrapping) whose exponential tempo transition is non-zero.
 */
export function barTransitionModel(space: BarStateSpace, lambda: number): TransitionModel {
  const S = space.numStates;
  const nt = space.firstStates[0].length;
  // first-state index -> (beat, tempo)
  const firstOf = new Int32Array(S).fill(-1);
  space.firstStates.forEach((fs, b) => fs.forEach((s, j) => (firstOf[s] = b * nt + j)));

  const probs = space.firstStates.map((fs, b) => {
    const from = space.lastStates[(b - 1 + space.numBeats) % space.numBeats];
    const fromInt = Array.from(from, (s) => space.stateIntervals[s]);
    const toInt = Array.from(fs, (s) => space.stateIntervals[s]);
    return exponentialTransition(fromInt, toInt, lambda);
  });

  let nnz = 0;
  for (let s = 0; s < S; s++) {
    if (firstOf[s] < 0) nnz++;
    else {
      const b = Math.floor(firstOf[s] / nt);
      const j = firstOf[s] % nt;
      for (let i = 0; i < nt; i++) if (probs[b][i * nt + j] !== 0) nnz++;
    }
  }

  const pointers = new Uint32Array(S + 1);
  const states = new Uint32Array(nnz);
  const logProbs = new Float64Array(nnz);
  let p = 0;
  for (let s = 0; s < S; s++) {
    pointers[s] = p;
    if (firstOf[s] < 0) {
      states[p] = s - 1;
      logProbs[p] = 0; // log(1)
      p++;
    } else {
      const b = Math.floor(firstOf[s] / nt);
      const j = firstOf[s] % nt;
      const from = space.lastStates[(b - 1 + space.numBeats) % space.numBeats];
      // last states ascend with the tempo index, so this is scipy's ascending column order
      for (let i = 0; i < nt; i++) {
        const v = probs[b][i * nt + j];
        if (v === 0) continue;
        states[p] = from[i];
        logProbs[p] = Math.log(v);
        p++;
      }
    }
  }
  pointers[S] = p;
  return { pointers, states, logProbs };
}
