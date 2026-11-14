import { describe, expect, it } from "vitest";
import { pickPeaks } from "./peaks.js";

/** A flat-zero curve with triangular bumps of the given heights at the given block indices. */
function bumps(n: number, at: Array<[index: number, height: number]>): Float32Array {
  const v = new Float32Array(n);
  for (const [i, h] of at) {
    for (let d = -3; d <= 3; d++) {
      const j = i + d;
      if (j >= 0 && j < n) v[j] = Math.max(v[j], h * (1 - Math.abs(d) / 4));
    }
  }
  return v;
}

describe("pickPeaks", () => {
  it("returns peak times in seconds", () => {
    const v = bumps(400, [[100, 1], [200, 0.8], [300, 0.9]]);
    expect(pickPeaks(v, 2, 0.5)).toEqual([50, 100, 150]);
  });

  it("finds nothing on a flat curve", () => {
    expect(pickPeaks(new Float32Array(200), 2, 0.5)).toEqual([]);
    expect(pickPeaks(new Float32Array(200).fill(0.3), 2, 1)).toEqual([]);
  });

  it("finds nothing on an empty curve", () => {
    expect(pickPeaks([], 2, 0.5)).toEqual([]);
  });

  it("suppresses a weaker peak closer than the gap", () => {
    // Gap at granularity 0 is 32 s = 64 blocks, so the window is ±64 blocks.
    // The second peak is 25 s away: beyond half the gap but within the gap.
    const v = bumps(400, [[100, 1], [150, 0.9], [300, 0.9]]);
    expect(pickPeaks(v, 2, 0)).toEqual([50, 150]);
    // Gap at granularity 1 is 2 s = 4 blocks; both close peaks survive.
    expect(pickPeaks(v, 2, 1)).toEqual([50, 75, 150]);
  });

  it("keeps consecutive peaks at least the gap apart on a dense curve", () => {
    let s = 987654321;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const v = new Float32Array(4000);
    for (let i = 0; i < v.length; i++) v[i] = rnd() ** 4;
    for (const [g, gap] of [[0, 32], [0.5, 8], [1, 2]] as const) {
      const peaks = pickPeaks(v, 2, g);
      expect(peaks.length).toBeGreaterThan(1);
      for (let i = 1; i < peaks.length; i++) expect(peaks[i] - peaks[i - 1]).toBeGreaterThanOrEqual(gap);
    }
  });

  it("reports one time for a plateau", () => {
    const v = new Float32Array(200);
    v.fill(1, 100, 104);
    expect(pickPeaks(v, 2, 0.5)).toEqual([50]);
  });

  it("is monotonic in granularity", () => {
    // Deterministic pseudo-random bumpy curve.
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const v = new Float32Array(2000);
    for (let i = 0; i < v.length; i++) v[i] = rnd() ** 4;
    const n0 = pickPeaks(v, 2, 0).length;
    const n5 = pickPeaks(v, 2, 0.5).length;
    const n1 = pickPeaks(v, 2, 1).length;
    expect(n1).toBeGreaterThanOrEqual(n5);
    expect(n5).toBeGreaterThanOrEqual(n0);
    expect(n1).toBeGreaterThan(n0);
  });
});
