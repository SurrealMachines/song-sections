// Port of madmom 0.16.1 DBNDownBeatTrackingProcessor (madmom/features/downbeats.py), as allin1 1.1.0's
// postprocess_metrical_structure configures it: beats_per_bar [3, 4], threshold 0.24, fps 100, and madmom's
// defaults (55–215 bpm, 60 tempi, transition lambda 100, observation lambda 16, correct=True).
//
// madmom is BSD licensed:
// Copyright (c) 2012-2014 Department of Computational Perception, Johannes Kepler University, Linz, Austria and
// Austrian Research Institute for Artificial Intelligence (OFAI), Vienna, Austria
// (full notice: licenses/madmom.txt). The ported files are this directory's stateSpace.ts, transition.ts,
// observation.ts, viterbi.ts and this file.
import { throwIfAborted } from "../../../core/abort.js";
import { FOREGROUND, type Pace } from "../../../core/pace.js";
import { downbeatActivations } from "./activations.js";
import { observationModel, type ObservationModel } from "./observation.js";
import { barStateSpace, type BarStateSpace } from "./stateSpace.js";
import { barTransitionModel, type TransitionModel } from "./transition.js";
import { viterbi } from "./viterbi.js";

export const DBN = {
  beatsPerBar: [3, 4],
  fps: 100,
  minBpm: 55,
  maxBpm: 215,
  numTempi: 60,
  transitionLambda: 100,
  observationLambda: 16,
  threshold: 0.24,
} as const;

export interface DownbeatOptions {
  signal?: AbortSignal;
  /** How it yields (core/pace.ts); FOREGROUND when absent. */
  pace?: Pace;
}

export interface Downbeats {
  /** Beat times, seconds. */
  beats: number[];
  /** Beat number inside the bar for each beat; 1 is a downbeat. */
  positions: number[];
}

interface Hmm {
  st: BarStateSpace;
  tm: TransitionModel;
  om: ObservationModel;
}

let hmms: Hmm[] | undefined;

/** The two bar-length HMMs (built once; ~1 MB together). */
function models(): Hmm[] {
  hmms ??= DBN.beatsPerBar.map((beats) => {
    const st = barStateSpace(beats, (60 * DBN.fps) / DBN.maxBpm, (60 * DBN.fps) / DBN.minBpm, DBN.numTempi);
    return { st, tm: barTransitionModel(st, DBN.transitionLambda), om: observationModel(st, DBN.observationLambda) };
  });
  return hmms;
}

/**
 * DBNDownBeatTrackingProcessor.process on row-major T×2 float32 activations [beat-not-downbeat, downbeat].
 * Reproduces madmom's quirks: the `idx.any()` threshold crop (a lone frame 0 over the threshold gives no beats),
 * the `(beats + first) / fps` offset, and `argmax(activations[left:right]) // 2` over the flattened 2-column
 * slice when correcting beats. The bar length with the higher log probability wins; 3 wins a tie.
 */
export async function decodeDownbeats(act: Float32Array, T: number, opts: DownbeatOptions = {}): Promise<Downbeats> {
  const { signal, pace = FOREGROUND } = opts;
  throwIfAborted(signal);
  const empty: Downbeats = { beats: [], positions: [] };

  // Threshold crop. numpy 1.23 compares a float32 array with a Python float in float32.
  const thr = Math.fround(DBN.threshold);
  let lo = Infinity;
  let hi = -1;
  let anyNonZeroIdx = false;
  for (let t = 0; t < T; t++) {
    if (act[2 * t] >= thr || act[2 * t + 1] >= thr) {
      if (t < lo) lo = t;
      hi = t;
      if (t !== 0) anyNonZeroIdx = true;
    }
  }
  // `if idx.any()` tests the frame indices' values, not emptiness.
  const first = anyNonZeroIdx ? lo : 0;
  const last = anyNonZeroIdx ? Math.min(T, hi + 1) : first;
  const n = last - first;
  const obs = act.subarray(2 * first, 2 * last);
  if (!obs.some((v) => v !== 0)) return empty; // `if not activations.any()`

  let best: { hmm: Hmm; path: Uint32Array; logProb: number } | undefined;
  for (const hmm of models()) {
    await pace.yield(signal);
    const densities = hmm.om.logDensities(obs, n);
    await pace.yield(signal);
    const r = await viterbi(hmm.tm, hmm.om, densities, n, { signal, pace });
    if (!best || r.logProb > best.logProb) best = { hmm, ...r }; // np.argmax: first maximum
  }
  const { hmm, path } = best!;
  // madmom raises IndexError on an empty path (no finite-probability path); we return no beats.
  if (path.length === 0) return empty;

  const beatNumber = (t: number) => Math.trunc(hmm.st.statePositions[path[t]]) + 1;
  const inRange = (t: number) => hmm.om.pointers[path[t]] >= 1;

  // Change points of the beat range, plus 0 / length when the path starts / ends inside one.
  const idx: number[] = [];
  if (inRange(0)) idx.push(0);
  for (let t = 1; t < n; t++) if (inRange(t) !== inRange(t - 1)) idx.push(t);
  if (inRange(n - 1)) idx.push(n);

  const beats: number[] = [];
  const positions: number[] = [];
  if (idx.some((v) => v !== 0)) {
    for (let k = 0; k + 1 < idx.length; k += 2) {
      const left = idx[k];
      const right = idx[k + 1];
      // np.argmax over the flattened [left:right] × 2 slice (first maximum), then // 2
      let arg = 2 * left;
      for (let i = 2 * left + 1; i < 2 * right; i++) if (obs[i] > obs[arg]) arg = i;
      const peak = Math.floor((arg - 2 * left) / 2) + left;
      beats.push((peak + first) / DBN.fps);
      positions.push(beatNumber(peak));
    }
  }
  return { beats, positions };
}

/**
 * Beats and downbeats from allin1's 8-fold mean beat and downbeat logits (one value per 10 ms frame), exactly as
 * allin1 1.1.0 + madmom 0.16.1 compute them.
 */
export async function trackDownbeats(beatLogits: Float32Array, downbeatLogits: Float32Array, opts: DownbeatOptions = {}): Promise<Downbeats> {
  throwIfAborted(opts.signal);
  const T = Math.min(beatLogits.length, downbeatLogits.length);
  const act = downbeatActivations(beatLogits, downbeatLogits);
  await (opts.pace ?? FOREGROUND).yield(opts.signal);
  return decodeDownbeats(act, T, opts);
}
