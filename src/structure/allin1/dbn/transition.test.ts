import { describe, expect, it } from "vitest";
import { sampled, spaces } from "./fixtures.js";
import { barStateSpace } from "./stateSpace.js";
import { barTransitionModel, exponentialTransition, numpySum } from "./transition.js";

describe("barTransitionModel (madmom BarTransitionModel, scipy canonical CSR)", () => {
  for (const bar of spaces.bars) {
    describe(`${bar.beatsPerBar} beats per bar`, () => {
      const st = barStateSpace(bar.beatsPerBar, spaces.minInterval, spaces.maxInterval, spaces.numTempi);
      const tm = barTransitionModel(st, spaces.transitionLambda);

      it(`has ${bar.nnz} transitions over ${bar.numStates} destination rows`, () => {
        expect(tm.pointers).toHaveLength(bar.numStates + 1);
        expect(tm.states).toHaveLength(bar.nnz);
        expect(tm.logProbs).toHaveLength(bar.nnz);
        expect(tm.pointers[bar.numStates]).toBe(bar.nnz);
      });

      it("has madmom's pointers and source states", () => {
        expect(sampled(tm.pointers, bar.pointers)).toEqual(bar.pointers.values);
        expect(tm.pointers.reduce((a, b) => a + b, 0)).toBe(bar.pointers.sum);
        expect(sampled(tm.states, bar.states)).toEqual(bar.states.values);
        expect(tm.states.reduce((a, b) => a + b, 0)).toBe(bar.states.sum);
      });

      it("has madmom's log probabilities (within 1e-12)", () => {
        sampled(tm.logProbs, bar.logProbs).forEach((v, i) => expect(Math.abs(v - bar.logProbs.values[i])).toBeLessThanOrEqual(1e-12));
        expect(Math.abs(tm.logProbs.reduce((a, b) => a + b, 0) - bar.logProbs.sum)).toBeLessThan(1e-9);
      });

      it("keeps source states ascending inside each row", () => {
        for (let s = 0; s < bar.numStates; s++)
          for (let p = tm.pointers[s] + 1; p < tm.pointers[s + 1]; p++) expect(tm.states[p]).toBeGreaterThan(tm.states[p - 1]);
      });

      it("leaves every source state with outgoing probability 1", () => {
        const out = new Float64Array(bar.numStates);
        for (let p = 0; p < tm.states.length; p++) out[tm.states[p]] += Math.exp(tm.logProbs[p]);
        for (const v of out) expect(Math.abs(v - 1)).toBeLessThan(1e-12);
      });
    });
  }
});

describe("exponentialTransition", () => {
  it("is row-normalised, peaks on the diagonal, and zeroes values at or below eps", () => {
    const iv = new Uint16Array([28, 40, 60, 109]);
    const p = exponentialTransition(iv, iv, 100);
    for (let i = 0; i < 4; i++) {
      const row = Array.from(p.subarray(i * 4, i * 4 + 4));
      expect(Math.abs(row.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-15);
      expect(row[i]).toBe(Math.max(...row));
    }
    expect(p[0 * 4 + 3]).toBe(0); // exp(-100 * (109/28 - 1)) underflows below eps
  });
});

describe("numpySum (numpy pairwise summation)", () => {
  it("adds fewer than 8 values left to right", () => {
    expect(numpySum([0.1, 0.2, 0.3], 0, 3)).toBe(0.1 + 0.2 + 0.3);
  });
  it("uses 8 interleaved accumulators, then adds the remainder", () => {
    const a = Array.from({ length: 13 }, (_, i) => 1 / (i + 3));
    const r = a.slice(0, 8);
    const want = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7])) + a[8] + a[9] + a[10] + a[11] + a[12];
    expect(numpySum(a, 0, 13)).toBe(want);
  });
});
