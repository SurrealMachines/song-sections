import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES, snrDb } from "../../test/golden.js";
import { readNpy } from "../../test/npy.js";
import { testSignal } from "../../test/signals.js";
import {
  DEMUCS_SOURCES, FREQ_BINS, HOP, ISTFT, NFFT, SAMPLE_RATE, SEGMENT_LENGTH, SPEC_FRAMES, STRIDE,
  chunkPlan, chunkWeight, coreInputs, coreOutputsToWave, ispec, spec,
} from "./dsp.js";

describe("constants", () => {
  it("are htdemucs's", () => {
    expect([SAMPLE_RATE, SEGMENT_LENGTH, STRIDE, NFFT, HOP, FREQ_BINS, SPEC_FRAMES]).toEqual([44100, 343980, 257985, 4096, 1024, 2048, 336]);
    expect(DEMUCS_SOURCES).toEqual(["drums", "bass", "other", "vocals"]);
  });
});

describe("chunk plan and weights", () => {
  const golden = JSON.parse(readFileSync(`${FIXTURES}/demucs_chunks.json`, "utf8")) as {
    plans: Record<string, number[][]>; weightIdx: number[]; weight: number[];
  };
  it("equal the Python plan exactly", () => {
    for (const [n, plan] of Object.entries(golden.plans)) {
      expect(chunkPlan(Number(n)).map((c) => [c.offset, c.chunkLen, c.srcStart, c.srcEnd, c.padLeft])).toEqual(plan);
    }
  });
  it("gives an empty plan for an empty track", () => {
    expect(chunkPlan(0)).toEqual([]);
  });
  it("weights equal the Python weights exactly", () => {
    const w = chunkWeight();
    expect(w).toHaveLength(SEGMENT_LENGTH);
    expect(golden.weightIdx.map((i) => w[i])).toEqual(golden.weight);
    expect(chunkWeight()).toBe(w); // cached
  });
});

describe("spec / ispec", () => {
  const [x] = testSignal(8192, 1, 44100);
  const z = spec(x);

  it("matches HTDemucs._spec (SNR >= 100 dB on re and im)", () => {
    const g = readNpy(`${FIXTURES}/demucs_spec.npy`);
    expect(g.shape).toEqual([2, 2048, 8]);
    expect(z.frames).toBe(8);
    expect(z.re).toHaveLength(2048 * 8);
    const n = 2048 * 8;
    expect(snrDb(g.data.subarray(0, n), z.re)).toBeGreaterThanOrEqual(100);
    expect(snrDb(g.data.subarray(n), z.im)).toBeGreaterThanOrEqual(100);
  });

  it("matches HTDemucs._ispec (SNR >= 100 dB)", () => {
    const re = Float32Array.from(z.re), im = Float32Array.from(z.im);
    for (let k = 0; k < 2048; k++) for (let f = 0; f < 8; f++) { re[k * 8 + f] *= k / 2048; im[k * 8 + f] *= k / 2048; }
    const y = ispec(re, im, 8, 8192);
    expect(y).toHaveLength(8192);
    expect(snrDb(readNpy(`${FIXTURES}/demucs_ispec.npy`).data, y)).toBeGreaterThanOrEqual(100);
  });

  it("round-trips in the interior: ispec(spec(x)) reproduces x within 1e-5", () => {
    // Like HTDemucs, the first and last ~3000 samples are lossy (the 2 frames dropped at each end
    // still count in the iSTFT envelope: Python's own error there is up to 0.33), so compare the interior.
    const [s] = testSignal(20000, 1, 44100);
    const zz = spec(s);
    expect(zz.frames).toBe(20);
    const y = ispec(zz.re, zz.im, zz.frames, 20000);
    let max = 0;
    for (let i = 3200; i < 20000 - 3200; i++) max = Math.max(max, Math.abs(y[i] - s[i]));
    expect(max).toBeLessThanOrEqual(1e-5);
  });

  it("handles lengths that are not a multiple of the hop", () => {
    const [s] = testSignal(5000, 1, 44100);
    const zz = spec(s);
    expect(zz.frames).toBe(5);
    expect(ispec(zz.re, zz.im, zz.frames, 5000)).toHaveLength(5000);
  });
});

describe("core inputs and outputs", () => {
  const [l, r] = testSignal(SEGMENT_LENGTH, 2, 44100);

  it("lays out mix (1,2,L) and CaC spec (1,4,2048,336)", () => {
    const { mix, spec: sp } = coreInputs(l, r);
    expect(mix).toHaveLength(2 * SEGMENT_LENGTH);
    expect(mix.subarray(0, SEGMENT_LENGTH)).toEqual(l);
    expect(mix.subarray(SEGMENT_LENGTH)).toEqual(r);
    expect(sp).toHaveLength(4 * 2048 * 336);
    const zl = spec(l), zr = spec(r);
    const plane = 2048 * 336;
    expect(sp.subarray(0, plane)).toEqual(zl.re);
    expect(sp.subarray(plane, 2 * plane)).toEqual(zl.im);
    expect(sp.subarray(2 * plane, 3 * plane)).toEqual(zr.re);
    expect(sp.subarray(3 * plane)).toEqual(zr.im);
  }, 30000);

  it("rejects a chunk that is not SEGMENT_LENGTH", () => {
    expect(() => coreInputs(new Float32Array(10), new Float32Array(10))).toThrow();
  });

  it("turns core outputs back into (4, 2, L) waves", () => {
    const { mix, spec: sp } = coreInputs(l, r);
    // One source (index 2) carries the CaC input, the rest are silent; the time branch adds mix.
    const specOut = new Float32Array(4 * 4 * 2048 * 336);
    specOut.set(sp, 2 * 4 * 2048 * 336);
    const waveOut = new Float32Array(4 * 2 * SEGMENT_LENGTH);
    for (let c = 0; c < 2; c++) waveOut.set(mix.subarray(c * SEGMENT_LENGTH, (c + 1) * SEGMENT_LENGTH), (2 * 2 + c) * SEGMENT_LENGTH);
    const out = coreOutputsToWave(specOut, waveOut);
    expect(out).toHaveLength(4 * 2 * SEGMENT_LENGTH);
    expect(out.subarray(0, 2 * SEGMENT_LENGTH).every((v) => v === 0)).toBe(true);
    // Source 2: ispec(spec(x)) + x = 2x (to the Nyquist-bin error).
    for (let c = 0; c < 2; c++) {
      const got = out.subarray((2 * 2 + c) * SEGMENT_LENGTH, (2 * 2 + c + 1) * SEGMENT_LENGTH);
      const want = Float32Array.from(c ? r : l, (v) => 2 * v);
      // Interior only: the first and last ~3000 samples of an iSTFT are lossy (see the spec/ispec round trip).
      expect(snrDb(want.subarray(3200, -3200), got.subarray(3200, -3200))).toBeGreaterThan(100);
    }
  }, 30000);

  // Wall-clock bounds are opt-in: they flake under parallel load. Run with SONG_SECTIONS_PERF=1.
  it.skipIf(!process.env.SONG_SECTIONS_PERF)("builds inputs and outputs for one chunk in under 400 ms", () => {
    const specOut = new Float32Array(4 * 4 * 2048 * 336).fill(0.001);
    const waveOut = new Float32Array(4 * 2 * SEGMENT_LENGTH);
    const t0 = performance.now();
    coreInputs(l, r);
    coreOutputsToWave(specOut, waveOut);
    expect(performance.now() - t0).toBeLessThan(400);
  }, 20000);
});

describe("paired inverse FFT (spike/cpu-speed)", () => {
  const random = (n: number, seed: number) => {
    let x = seed;
    return new Float32Array(n).map(() => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1);
  };
  const both = (frames: number, length: number, seed: number, dcImag = 0) => {
    const re = random(2048 * frames, seed);
    const im = random(2048 * frames, seed + 1);
    for (let t = 0; t < frames; t++) im[t] = dcImag; // bin 0's imaginary part, which irfft drops
    ISTFT.impl = "single";
    const a = ispec(re, im, frames, length);
    ISTFT.impl = "paired";
    const b = ispec(re, im, frames, length);
    return { a, b };
  };
  const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

  it("matches the one-frame-per-FFT path within float32 rounding, for an even and an odd frame count", () => {
    for (const [frames, length] of [[336, 343980], [7, 3 * 1024]] as const) {
      const { a, b } = both(frames, length, frames);
      expect(maxDiff(a, b)).toBeLessThan(1e-6);
    }
  });

  it("drops a bin-0 imaginary part as the single path does, so one frame never leaks into its pair", () => {
    const { a, b } = both(8, 4 * 1024, 3, 5);
    expect(maxDiff(a, b)).toBeLessThan(1e-6);
  });
});
