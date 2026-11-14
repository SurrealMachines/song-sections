import { describe, expect, it } from "vitest";
import type { PreparedAudio } from "../audio/prepare.js";
import { analyseCue, DEFAULT_GRANULARITY } from "./cue.js";
import { noveltyCurve } from "./novelty.js";
import { pickPeaks } from "./peaks.js";

function prepared(analysis: Float32Array, analysisRate = 11025): PreparedAudio {
  return {
    analysis,
    analysisRate,
    durationSec: analysis.length / analysisRate,
    waveform: { min: [], max: [] },
    previewPath: "/dev/null",
    hash: "test",
  };
}

/** Deterministic white noise in [-0.5, 0.5). */
function noise(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s / 2 ** 32 - 0.5;
  }
  return out;
}

function sine(n: number, freq: number, rate: number, offset = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * (i + offset)) / rate);
  return out;
}

/** 20 s of 220 Hz sine, 20 s of white noise, 20 s of 880 Hz sine. */
function threeSections(rate: number): Float32Array {
  const seg = 20 * rate;
  const x = new Float32Array(3 * seg);
  x.set(sine(seg, 220, rate), 0);
  x.set(noise(seg), seg);
  x.set(sine(seg, 880, rate, 2 * seg), 2 * seg);
  return x;
}

const never = new AbortController().signal;
const noop = () => {};

describe("analyseCue", () => {
  it("finds the boundaries between sine, noise and sine sections", async () => {
    const r = await analyseCue(prepared(threeSections(11025)), never, noop);
    expect(r.engine).toBe("cue-dsp-1");
    expect(r.blocksPerSec).toBe(2);
    expect(r.novelty).toHaveLength(120);
    expect(r.boundaries).toHaveLength(2);
    expect(Math.abs(r.boundaries[0] - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.boundaries[1] - 40)).toBeLessThanOrEqual(1);
  });

  it("is independent of the analysis rate (12000 Hz)", async () => {
    const r = await analyseCue(prepared(threeSections(12000), 12000), never, noop);
    expect(r.novelty).toHaveLength(120);
    expect(r.boundaries).toHaveLength(2);
    expect(Math.abs(r.boundaries[0] - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.boundaries[1] - 40)).toBeLessThanOrEqual(1);
  });

  it("uses DEFAULT_GRANULARITY for boundaries, monotonic across granularity", async () => {
    const r = await analyseCue(prepared(threeSections(11025)), never, noop);
    expect(DEFAULT_GRANULARITY).toBe(0.5);
    expect(r.boundaries).toEqual(pickPeaks(r.novelty, 2, DEFAULT_GRANULARITY));
    const n0 = pickPeaks(r.novelty, 2, 0).length;
    const n5 = pickPeaks(r.novelty, 2, 0.5).length;
    const n1 = pickPeaks(r.novelty, 2, 1).length;
    expect(n1).toBeGreaterThanOrEqual(n5);
    expect(n5).toBeGreaterThanOrEqual(n0);
  });

  it("reports no boundaries and finite novelty for silence", async () => {
    const r = await analyseCue(prepared(new Float32Array(60 * 11025)), never, noop);
    expect(r.boundaries).toEqual([]);
    expect(r.novelty).toHaveLength(120);
    expect(r.novelty.every(Number.isFinite)).toBe(true);
  });

  it("handles a 3 s clip without boundaries", async () => {
    const r = await analyseCue(prepared(sine(3 * 11025, 440, 11025)), never, noop);
    expect(r.boundaries).toEqual([]);
    expect(r.novelty.every(Number.isFinite)).toBe(true);
  });

  it("handles a clip shorter than one analysis frame", async () => {
    const r = await analyseCue(prepared(sine(100, 440, 11025)), never, noop);
    expect(r.boundaries).toEqual([]);
    expect(r.novelty.every(Number.isFinite)).toBe(true);
  });

  it("handles an empty clip without boundaries", async () => {
    const r = await analyseCue(prepared(new Float32Array(0)), never, noop);
    expect(r.boundaries).toEqual([]);
    expect(r.novelty).toEqual([]);
  });

  it("rejects with AbortError when aborted after feature extraction", async () => {
    const ac = new AbortController();
    const p = analyseCue(prepared(sine(3 * 11025, 440, 11025)), ac.signal, (f) => {
      if (f === 1) ac.abort();
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports progress from 0 to 1", async () => {
    const seen: number[] = [];
    await analyseCue(prepared(noise(300 * 11025)), never, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1]))).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("rejects with AbortError when aborted halfway", async () => {
    const ac = new AbortController();
    const p = analyseCue(prepared(noise(300 * 11025)), ac.signal, (f) => {
      if (f >= 0.5) ac.abort();
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(analyseCue(prepared(noise(11025)), ac.signal, noop)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  // Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1).
  it.skipIf(!process.env.SONG_SECTIONS_PERF)("analyses 5 min of noise in under 5 s", async () => {
    const p = prepared(noise(300 * 11025));
    const t = performance.now();
    await analyseCue(p, never, noop);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(5000);
  });

  it.skipIf(!process.env.SONG_SECTIONS_PERF)("analyses 60 min of noise in under 60 s", { timeout: 120_000 }, async () => {
    const p = prepared(noise(3600 * 11025));
    const t = performance.now();
    await analyseCue(p, never, noop);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(60_000);
  });
});

describe("noveltyCurve", () => {
  it("is in [0, 1] with zeros at the edges", () => {
    const blocks = Array.from({ length: 100 }, (_, i) => {
      const v = new Float32Array(4);
      v[i < 50 ? 0 : 1] = 1;
      v[2] = Math.sin(i);
      return v;
    });
    const n = noveltyCurve(blocks, 8);
    expect(n).toHaveLength(100);
    expect(Math.max(...n)).toBeCloseTo(1);
    expect(Math.min(...n)).toBeGreaterThanOrEqual(0);
    expect(n[0]).toBe(0);
    expect(n[99]).toBe(0);
    expect(n.indexOf(Math.max(...n))).toBe(50);
  });

  it("is all zeros when fewer blocks than the kernel", () => {
    const blocks = Array.from({ length: 10 }, () => new Float32Array([1, 0]));
    expect(Array.from(noveltyCurve(blocks, 16))).toEqual(new Array(10).fill(0));
  });
});
