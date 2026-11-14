import { describe, expect, it } from "vitest";
import { exact, sampled, sha256Of, spaces } from "./fixtures.js";
import { readNpy } from "../../../test/npy.js";
import { FIXTURES } from "../../../test/golden.js";
import { downbeatActivations } from "./activations.js";
import { observationModel } from "./observation.js";
import { barStateSpace } from "./stateSpace.js";

const f32 = Math.fround;

describe("observationModel (madmom RNNDownBeatTrackingObservationModel)", () => {
  for (const bar of spaces.bars) {
    it(`has madmom's pointers for ${bar.beatsPerBar} beats per bar`, () => {
      const st = barStateSpace(bar.beatsPerBar, spaces.minInterval, spaces.maxInterval, spaces.numTempi);
      const om = observationModel(st, spaces.observationLambda);
      expect(om.pointers).toHaveLength(bar.numStates);
      expect(sampled(om.pointers, bar.obsPointers)).toEqual(bar.obsPointers.values);
      expect([0, 1, 2].map((v) => om.pointers.filter((p) => p === v).length)).toEqual(bar.obsPointerCounts);
    });
  }

  it("computes log densities in float32 and widens them", () => {
    const st = barStateSpace(3, spaces.minInterval, spaces.maxInterval, spaces.numTempi);
    const om = observationModel(st, 16);
    const obs = new Float32Array([0.2, 0.3, 0.01, 0.9]);
    const d = om.logDensities(obs, 2);
    expect(d).toBeInstanceOf(Float64Array);
    expect(d).toHaveLength(6);
    const o = Array.from(obs);
    expect(Array.from(d)).toEqual([
      f32(Math.log(f32(f32(1 - f32(o[0] + o[1])) / 15))),
      f32(Math.log(o[0])),
      f32(Math.log(o[1])),
      f32(Math.log(f32(f32(1 - f32(o[2] + o[3])) / 15))),
      f32(Math.log(o[2])),
      f32(Math.log(o[3])),
    ]);
    for (const v of d) expect(f32(v)).toBe(v);
  });

  it("gives -Infinity for a zero activation, as numpy's log does", () => {
    const st = barStateSpace(3, spaces.minInterval, spaces.maxInterval, spaces.numTempi);
    const d = observationModel(st, 16).logDensities(new Float32Array([0, 0.5]), 1);
    expect(d[1]).toBe(-Infinity);
  });

  it("matches madmom's log_densities on the Flim activations bit for bit", () => {
    // downbeatActivations is itself pinned bit-exact against allin1 in activations.test.ts
    const beat = readNpy(`${FIXTURES}/flim_logits_beat.npy`).data as Float32Array;
    const downbeat = readNpy(`${FIXTURES}/flim_logits_downbeat.npy`).data as Float32Array;
    const act = downbeatActivations(beat, downbeat);
    const st = barStateSpace(3, spaces.minInterval, spaces.maxInterval, spaces.numTempi);
    const got = observationModel(st, spaces.observationLambda).logDensities(act, exact.frames);
    const want = exact.logDensities;
    expect(got).toHaveLength(want.count);
    expect(want.count).toBe(3 * exact.frames);
    expect(want.indices.map((i) => got[i])).toEqual(want.values);
    expect(sha256Of(got)).toBe(want.sha256);
  });
});
