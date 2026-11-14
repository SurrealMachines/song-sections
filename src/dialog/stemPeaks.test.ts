import { describe, expect, it } from "vitest";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { columnBlocks, columnPeaks, peakScale } from "./stemPeaks.js";

describe("columnPeaks (Show stems, feedback round 1)", () => {
  it("takes the max of the blocks under each pixel column", () => {
    expect(columnPeaks([0.1, 0.5, 0.2, 0.9, 0.3, 0.4], 3)).toEqual([0.5, 0.9, 0.4]);
  });

  it("repeats a block over several columns when there are more columns than blocks", () => {
    expect(columnPeaks([0.2, 0.8], 4)).toEqual([0.2, 0.2, 0.8, 0.8]);
  });

  it("covers every block exactly once when the counts do not divide", () => {
    const peak = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    const cols = columnPeaks(peak, 3);
    expect(cols).toHaveLength(3);
    expect(Math.max(...cols)).toBe(0.7);
    expect(cols).toEqual([...cols].sort());
  });

  it("is empty for no columns or no blocks", () => {
    expect(columnPeaks([0.5], 0)).toEqual([]);
    expect(columnPeaks([], 3)).toEqual([0, 0, 0]);
  });
});

// fb3, item 5: zoomed, only the blocks on screen are read.
describe("columnPeaks over a visible range", () => {
  const peak = Array.from({ length: 36000 }, (_, i) => (i % 1000) / 1000); // 30 minutes at 20 blocks/s

  it("reads only the blocks in [from, to), spread over the columns", () => {
    const cols = columnPeaks(peak, 4, 2000, 2400); // 100 blocks a column
    expect(cols).toEqual([0.099, 0.199, 0.299, 0.399]);
  });

  it("repeats a block over several columns at a deep zoom, and clamps at the lane's end", () => {
    expect(columnPeaks([0.2, 0.8, 0.5], 4, 1, 3)).toEqual([0.8, 0.8, 0.5, 0.5]);
    expect(columnPeaks([0.2, 0.8, 0.5], 2, 2.5, 3.5)).toEqual([0.5, 0.5]);
  });

  it("matches the whole-lane drawing when the range is the whole lane", () => {
    const p = [0.1, 0.5, 0.2, 0.9, 0.3, 0.4, 0.7];
    expect(columnPeaks(p, 3, 0, p.length)).toEqual(columnPeaks(p, 3));
    expect(columnBlocks(0, 3, 7)).toEqual([0, 2]);
  });
});

describe("peakScale", () => {
  it("is the loudest peak over all four stems, so the loudest stem fills its lane and the others keep their level", () => {
    const a = fakeStructureAnalysis(30);
    const max = Math.max(...Object.values(a.stems).flatMap((s) => s.peak));
    expect(peakScale(a.stems)).toBe(max);
  });

  it("is 1 for silence or missing peaks, so nothing divides by zero", () => {
    const a = fakeStructureAnalysis(30);
    const silent = Object.fromEntries(Object.entries(a.stems).map(([k, s]) => [k, { ...s, peak: s.peak.map(() => 0) }]));
    expect(peakScale(silent as typeof a.stems)).toBe(1);
    const none = Object.fromEntries(Object.entries(a.stems).map(([k, s]) => [k, { ...s, peak: undefined }]));
    expect(peakScale(none as unknown as typeof a.stems)).toBe(1);
  });
});
