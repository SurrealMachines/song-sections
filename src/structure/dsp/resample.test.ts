import { describe, expect, it } from "vitest";
import { readNpy } from "../../test/npy.js";
import { snrDb, FIXTURES } from "../../test/golden.js";
import { testSignal } from "../../test/signals.js";
import { createResampler } from "./resample.js";

function oneShot(x: Float32Array, from: number, to: number): Float32Array {
  const r = createResampler(from, to);
  const a = r.push(x);
  const b = r.end();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

describe("createResampler", () => {
  const [x] = testSignal(24000, 1, 48000);

  it("matches julius.resample_frac (SNR >= 90 dB)", () => {
    const ref = readNpy(`${FIXTURES}/resample_48k_44k.npy`);
    expect(ref.shape).toEqual([22050]);
    const y = oneShot(x, 48000, 44100);
    expect(y).toHaveLength(22050);
    expect(snrDb(ref.data, y)).toBeGreaterThanOrEqual(90);
  });

  it("matches julius for other ratios: 96 kHz down and 22.05 kHz up (SNR >= 90 dB)", () => {
    for (const [name, from, n, outLen] of [["96k", 96000, 4800, 2205], ["22k", 22050, 2000, 4000]] as const) {
      const ref = readNpy(`${FIXTURES}/resample_${name}_44k.npy`);
      const y = oneShot(testSignal(n, 1, from)[0], from, 44100);
      expect(y).toHaveLength(outLen);
      expect(snrDb(ref.data, y), name).toBeGreaterThanOrEqual(90);
    }
  });

  it("gives identical output when pushed in chunks", () => {
    const whole = oneShot(x, 48000, 44100);
    const r = createResampler(48000, 44100);
    const parts: Float32Array[] = [];
    let pos = 0;
    for (const n of [1, 37, 4096, x.length]) {
      parts.push(r.push(x.subarray(pos, Math.min(x.length, pos + n))));
      pos += n;
      if (pos >= x.length) break;
    }
    parts.push(r.end());
    const total = parts.reduce((s, p) => s + p.length, 0);
    const got = new Float32Array(total);
    let o = 0;
    for (const p of parts) { got.set(p, o); o += p.length; }
    expect(got).toEqual(whole);
  });

  it("has the julius output length floor(to * N / from)", () => {
    expect(oneShot(new Float32Array(48000).fill(0.5), 48000, 44100)).toHaveLength(44100);
    expect(oneShot(new Float32Array(1).fill(0.5), 48000, 44100)).toHaveLength(0);
    expect(oneShot(new Float32Array(0), 48000, 44100)).toHaveLength(0);
    expect(oneShot(new Float32Array(1001), 22050, 44100)).toHaveLength(2002);
    expect(oneShot(new Float32Array(1001), 96000, 44100)).toHaveLength(Math.floor((44100 * 1001) / 96000));
  });

  it("preserves a constant signal, including at the edges", () => {
    const y = oneShot(new Float32Array(5000).fill(0.5), 48000, 44100);
    for (const v of y) expect(v).toBeCloseTo(0.5, 6);
  });

  it("is the identity for equal rates", () => {
    const y = oneShot(x, 44100, 44100);
    expect(y).toEqual(x);
  });

  it("rejects non-positive, non-integer and absurd rate pairs", () => {
    expect(() => createResampler(0, 44100)).toThrow();
    expect(() => createResampler(22254.5, 44100)).toThrow(/22254\.5/);
    expect(() => createResampler(44101, 44100 * 7919)).toThrow();
  });

  // Wall-clock bounds are opt-in: they flake under parallel load. Run with SONG_SECTIONS_PERF=1.
  it.skipIf(!process.env.SONG_SECTIONS_PERF)("only convolves the sinc support (60 s of 48 kHz stereo in under 1.0 s; the full-tap version took 1.1 s)", () => {
    const [l, r] = testSignal(48000 * 60, 2, 48000);
    const t0 = performance.now();
    for (const ch of [l, r]) {
      const rs = createResampler(48000, 44100);
      rs.push(ch);
      rs.end();
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 30000);

  it.skipIf(!process.env.SONG_SECTIONS_PERF)("resamples 60 s of 48 kHz stereo in under 1.5 s", () => {
    const [l, r] = testSignal(48000 * 60, 2, 48000);
    const t0 = performance.now();
    for (const ch of [l, r]) {
      const rs = createResampler(48000, 44100);
      rs.push(ch);
      rs.end();
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  }, 30000);
});
