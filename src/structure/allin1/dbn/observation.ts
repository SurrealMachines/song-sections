// Port of madmom 0.16.1 RNNDownBeatTrackingObservationModel (madmom/features/beats_hmm.py). See downbeats.ts for the licence notice.
import type { BarStateSpace } from "./stateSpace.js";

const f32 = Math.fround;

export interface ObservationModel {
  /** Density column per state: 0 no beat, 1 beat, 2 downbeat. */
  pointers: Uint8Array;
  /**
   * Log densities for T frames of [beat, downbeat] activations (row-major T×2, float32): row-major T×3
   * [log((1 - beat - downbeat) / (lambda - 1)), log(beat), log(downbeat)], computed in float32 as numpy does on
   * float32 input, then widened.
   */
  logDensities(obs: Float32Array, T: number): Float64Array;
}

export function observationModel(space: BarStateSpace, lambda: number): ObservationModel {
  const border = 1 / lambda;
  const pointers = new Uint8Array(space.numStates);
  for (let s = 0; s < space.numStates; s++) {
    const pos = space.statePositions[s];
    if (pos % 1 < border) pointers[s] = 1;
    if (pos < border) pointers[s] = 2;
  }
  const div = lambda - 1;
  return {
    pointers,
    logDensities(obs: Float32Array, T: number): Float64Array {
      const out = new Float64Array(3 * T);
      for (let t = 0; t < T; t++) {
        const b = obs[2 * t];
        const d = obs[2 * t + 1];
        out[3 * t] = f32(Math.log(f32(f32(1 - f32(b + d)) / div)));
        out[3 * t + 1] = f32(Math.log(b));
        out[3 * t + 2] = f32(Math.log(d));
      }
      return out;
    },
  };
}
