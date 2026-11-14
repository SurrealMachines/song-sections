import { describe, expect, it } from "vitest";
import { PEAK_RATE } from "./contract.js";
import { PEAK_BLOCK, bandsAt2Hz, functionProbsAt2Hz, loudnessAt2Hz, peakAtClipLevel, peakBlocks } from "./summary.js";

describe("bandsAt2Hz", () => {
  it("averages each block of 50 frames (last one partial) per band, 3 decimals", () => {
    const T = 120; // blocks of 50, 50, 20
    const spec = new Float32Array(T * 81);
    for (let t = 0; t < T; t++) for (let b = 0; b < 81; b++) spec[t * 81 + b] = t + b / 1000;
    const out = bandsAt2Hz(spec, T);
    expect(out).toHaveLength(3);
    for (const row of out) expect(row).toHaveLength(81);
    expect(out[0][0]).toBe(24.5); // mean of 0..49
    expect(out[1][0]).toBe(74.5);
    expect(out[2][0]).toBe(109.5); // mean of 100..119
    expect(out[0][80]).toBe(24.58); // 24.5 + 0.080
    expect(out[2][7]).toBe(109.507);
  });

  it("rounds to 3 decimals", () => {
    const spec = new Float32Array(81).fill(1 / 3);
    expect(bandsAt2Hz(spec, 1)[0][0]).toBe(0.333);
  });

  it("is empty for no frames and rejects a wrong length", () => {
    expect(bandsAt2Hz(new Float32Array(0), 0)).toEqual([]);
    expect(() => bandsAt2Hz(new Float32Array(80), 1)).toThrow(/81/);
  });
});

describe("loudnessAt2Hz", () => {
  it("gives the RMS over both channels of each 22050-sample block in dBFS, 1 decimal", () => {
    const n = 22050 * 2 + 100;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    l.fill(0.5, 0, 22050); // block 0: rms over both channels = sqrt(0.25 / 2)
    r.fill(0.5, 0, 22050);
    l.fill(0.1, 22050, 44100); // block 1: left only
    l.fill(1, 44100); // block 2: 100 samples, left only
    const out = loudnessAt2Hz(l, r);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(Math.round(10 * 20 * Math.log10(0.5)) / 10); // -6.0
    expect(out[1]).toBe(Math.round(10 * 20 * Math.log10(Math.sqrt(0.01 / 2))) / 10); // -23.0
    expect(out[2]).toBe(-3); // 20 log10(sqrt(1/2)) = -3.01
  });

  it("floors silence at -100", () => {
    expect(loudnessAt2Hz(new Float32Array(30000), new Float32Array(30000))).toEqual([-100, -100]);
    const tiny = new Float32Array(22050).fill(1e-7);
    expect(loudnessAt2Hz(tiny, tiny)).toEqual([-100]);
  });

  it("frame count is ceil(n / 22050), the contract's ceil(durationSec * 2)", () => {
    for (const n of [0, 1, 22050, 22051, 1323000]) {
      expect(loudnessAt2Hz(new Float32Array(n), new Float32Array(n))).toHaveLength(Math.ceil(((n / 44100) * 2)));
    }
  });
});

describe("functionProbsAt2Hz", () => {
  it("averages frame-major T×10 probabilities over 50-frame blocks, 3 decimals", () => {
    const T = 75;
    const probs = new Float32Array(T * 10);
    for (let t = 0; t < T; t++) probs[t * 10 + (t < 50 ? 8 : 9)] = 1; // verse, then chorus
    probs[0 * 10 + 8] = 0.5;
    probs[0 * 10 + 0] = 0.5;
    const out = functionProbsAt2Hz(probs, T);
    expect(out).toHaveLength(2);
    expect(out[0][8]).toBe(0.99);
    expect(out[0][0]).toBe(0.01);
    expect(out[1][9]).toBe(1);
    for (const row of out) {
      expect(row).toHaveLength(10);
      expect(Math.abs(row.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(0.005);
    }
  });
});

describe("peakBlocks / peakAtClipLevel", () => {
  it("is max |sample| over both channels per 2205-sample block (1/PEAK_RATE s), the last block partial", () => {
    expect(PEAK_BLOCK).toBe(44100 / PEAK_RATE);
    const n = 2 * PEAK_BLOCK + 10;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    left[5] = -0.5;
    right[100] = 0.25;
    right[PEAK_BLOCK + 3] = -0.75;
    left[2 * PEAK_BLOCK + 9] = 0.125;
    expect(Array.from(peakBlocks(left, right))).toEqual([0.5, 0.75, 0.125]);
  });

  it("uses the shorter channel's length and gives [] for no samples", () => {
    expect(Array.from(peakBlocks(new Float32Array(0), new Float32Array(0)))).toEqual([]);
    expect(peakBlocks(new Float32Array(PEAK_BLOCK + 1), new Float32Array(PEAK_BLOCK))).toHaveLength(1);
  });

  it("takes the analysis gain back out, clamps to [0, 1], rounds to 3 decimals and pads or trims to the contract length", () => {
    const raw = Float32Array.from([0.5, 2, 0.00049, 0.1234]);
    expect(peakAtClipLevel(raw, 0, 4)).toEqual([0.5, 1, 0, 0.123]);
    expect(peakAtClipLevel(Float32Array.from([0.5, 0.2]), 20, 2)).toEqual([0.05, 0.02]);
    expect(peakAtClipLevel(Float32Array.from([0.5, 0.2]), 0, 3)).toEqual([0.5, 0.2, 0]);
    expect(peakAtClipLevel(Float32Array.from([0.5, 0.2]), 0, 1)).toEqual([0.5]);
  });
});
