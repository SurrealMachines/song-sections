import { describe, expect, it } from "vitest";
import { sampled, spaces } from "./fixtures.js";
import { barStateSpace, beatIntervals } from "./stateSpace.js";

describe("barStateSpace (madmom BarStateSpace)", () => {
  for (const bar of spaces.bars) {
    describe(`${bar.beatsPerBar} beats per bar`, () => {
      const st = barStateSpace(bar.beatsPerBar, spaces.minInterval, spaces.maxInterval, spaces.numTempi);

      it(`has ${bar.numStates} states`, () => {
        expect(st.numStates).toBe(bar.numStates);
        expect(st.statePositions).toHaveLength(bar.numStates);
        expect(st.stateIntervals).toHaveLength(bar.numStates);
      });

      it("has madmom's first and last states per beat", () => {
        expect(st.firstStates.map((a) => Array.from(a))).toEqual(bar.firstStates);
        expect(st.lastStates.map((a) => Array.from(a))).toEqual(bar.lastStates);
      });

      it("has madmom's state positions exactly at the samples", () => {
        expect(sampled(st.statePositions, bar.statePositions)).toEqual(bar.statePositions.values);
        expect(st.statePositions.reduce((a, b) => a + b, 0)).toBeCloseTo(bar.statePositions.sum, 6);
      });

      it("has madmom's state intervals", () => {
        expect(sampled(st.stateIntervals, bar.stateIntervals)).toEqual(bar.stateIntervals.values);
        expect(st.stateIntervals.reduce((a, b) => a + b, 0)).toBe(bar.stateIntervals.sum);
      });
    });
  }

  it("quantises 60 log-spaced tempi to 60 distinct integer intervals", () => {
    const iv = beatIntervals(spaces.minInterval, spaces.maxInterval, 60);
    expect(iv).toHaveLength(60);
    expect(iv[0]).toBe(28);
    expect(iv.at(-1)).toBe(109);
    for (let i = 1; i < iv.length; i++) expect(iv[i]).toBeGreaterThan(iv[i - 1]);
  });

  it("uses the linear spacing when it has fewer intervals than requested", () => {
    expect(Array.from(beatIntervals(3.2, 6.6, 60))).toEqual([3, 4, 5, 6, 7]);
  });
});
