import { describe, expect, it } from "vitest";
import type { Pcm16 } from "./player.js";
import { BASE, createSamplePeaks, DIRECT_MAX_FRAMES } from "./samplePeaks.js";

/** A deterministic test signal: a few sines and some noise, 16-bit, `channels` interleaved. */
function signal(frames: number, channels = 1, seed = 3): Pcm16 {
  let x = seed;
  const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const samples = new Int16Array(frames * channels);
  for (let f = 0; f < frames; f++)
    for (let ch = 0; ch < channels; ch++)
      samples[f * channels + ch] = Math.round(20000 * Math.sin(f / (37 + ch)) * Math.sin(f / 9000) + 6000 * (rand() - 0.5));
  return { rate: 24000, channels, frames, samples };
}

/** The reference: a straight scan of every column's frames, the same column edges as columns(). */
function scan(p: Pcm16, f0: number, f1: number, cols: number, binFloor = 1) {
  const spp = (f1 - f0) / cols;
  const lo: number[] = [];
  const hi: number[] = [];
  for (let x = 0; x < cols; x++) {
    // Column edges rounded down to the bin they fall in, as the mipmap reads them.
    const a = Math.floor(Math.floor(f0 + x * spp) / binFloor) * binFloor;
    const b = Math.min(p.frames, Math.max(a + binFloor, Math.floor(Math.floor(f0 + (x + 1) * spp) / binFloor) * binFloor));
    let mn = 32767;
    let mx = -32768;
    for (let i = a * p.channels; i < b * p.channels; i++) {
      mn = Math.min(mn, p.samples[i]);
      mx = Math.max(mx, p.samples[i]);
    }
    lo.push(mn / 32768);
    hi.push(mx / 32768);
  }
  return { lo, hi };
}

const run = (pk: ReturnType<typeof createSamplePeaks>, f0: number, f1: number, cols: number) => {
  const lo = new Float32Array(cols);
  const hi = new Float32Array(cols);
  const ok = pk.columns(f0, f1, cols, lo, hi);
  return { ok, lo: [...lo], hi: [...hi] };
};

describe("samplePeaks (fb4, item 2)", () => {
  const p = signal(3_000_000);
  it("deep zoom (under BASE frames a column): the samples' own min and max per column", () => {
    const pk = createSamplePeaks(p);
    const got = run(pk, 1_234_567.3, 1_234_567.3 + 100 * 1000, 1000);
    expect(got.ok).toBe(true);
    const want = scan(p, 1_234_567.3, 1_234_567.3 + 100 * 1000, 1000);
    expect(got.lo).toEqual(want.lo.map(Math.fround));
    expect(got.hi).toEqual(want.hi.map(Math.fround));
  });

  it("before the mipmap is built: a short range is scanned, a long one is refused (the overview draws it)", () => {
    const pk = createSamplePeaks(p);
    expect(pk.ready).toBe(false);
    expect(run(pk, 0, DIRECT_MAX_FRAMES, 1000).ok).toBe(true);
    expect(run(pk, 0, DIRECT_MAX_FRAMES + 1000, 1000).ok).toBe(false);
  });

  it("builds in slices of about the budget, then every zoom reads the level whose bin fits a column", () => {
    const pk = createSamplePeaks(p);
    let calls = 0;
    while (!pk.build(1 << 18)) calls++;
    expect(calls).toBe(Math.ceil(p.frames / (1 << 18)) - 1);
    expect(pk.ready).toBe(true);
    for (const [f0, span, cols] of [
      [0, p.frames, 1000],
      [517_000, 400_000, 1000],
      [2_000_000.5, 999_999, 1789],
      [3, BASE * 1000, 1000],
    ]) {
      const got = run(pk, f0, f0 + span, cols);
      const spp = span / cols;
      const bin = BASE * 2 ** Math.floor(Math.log2(spp / BASE));
      const want = scan(p, f0, f0 + span, cols, bin);
      expect(got.ok).toBe(true);
      expect(got.lo).toEqual(want.lo.map(Math.fround));
      expect(got.hi).toEqual(want.hi.map(Math.fround));
    }
  });

  it("stereo: both channels count", () => {
    const s = signal(100_000, 2);
    const pk = createSamplePeaks(s);
    pk.build(Infinity);
    const got = run(pk, 0, 100_000, 100);
    const want = scan(s, 0, 100_000, 100, 512);
    expect(got.hi).toEqual(want.hi.map(Math.fround));
    expect(got.lo).toEqual(want.lo.map(Math.fround));
  });

  it("an empty preview, and columns past the end, are silent", () => {
    const e = createSamplePeaks({ rate: 24000, channels: 1, frames: 0, samples: new Int16Array(0) });
    expect(e.build(1)).toBe(true);
    const short = createSamplePeaks(signal(1000));
    const got = run(short, 900, 1100, 200);
    expect(got.hi.slice(150)).toEqual(new Array(50).fill(0));
  });

  // fb4 review M5: the mipmap clamped a column past the preview's end to the last bin, so it drew that bin's peaks
  // again (a preview may be up to 0.1 s shorter than the clip). It draws silence, as the direct path does.
  it("mipmap columns past the end are silent too, not the last bin repeated", () => {
    const s = signal(20_000);
    const pk = createSamplePeaks(s);
    expect(pk.build(Infinity)).toBe(true);
    const cols = 100;
    const spp = 512 * 2; // wide columns: the mipmap path
    const got = run(pk, 15_000, 15_000 + cols * spp, cols);
    const firstPast = Math.ceil((s.frames - 15_000) / spp);
    expect(firstPast).toBeLessThan(cols - 5);
    expect(got.hi.slice(firstPast).every((v) => v === 0)).toBe(true);
    expect(got.lo.slice(firstPast).every((v) => v === 0)).toBe(true);
    // The columns before the end still draw the signal.
    expect(got.hi.slice(0, firstPast - 1).some((v) => v > 0)).toBe(true);
    // The same view, drawn from the samples before the mipmap is built, agrees.
    const direct = createSamplePeaks(s);
    const want = run(direct, 15_000, 15_000 + cols * spp, cols);
    expect(want.hi.slice(firstPast).every((v) => v === 0)).toBe(true);
  });
});
