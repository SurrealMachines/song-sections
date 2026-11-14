import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, snrDb } from "../../test/golden.js";
import { readNpy } from "../../test/npy.js";
import { testSignal } from "../../test/signals.js";
import { ALLIN1_BAND_HZ, type StemName } from "../contract.js";
import { BANDS, FPS, FRAME_SIZE, HOP, MODEL_STEM_ORDER, filterbank, quantiseStem, stackSpec, stemSpectrogram, stemSpectrogramSliced } from "./features.js";
import { vi } from "vitest";

describe("constants", () => {
  it("are allin1's", () => {
    expect([FPS, FRAME_SIZE, HOP, BANDS]).toEqual([100, 2048, 441, 81]);
    expect(MODEL_STEM_ORDER).toEqual(["bass", "drums", "other", "vocals"]);
  });
});

describe("filterbank", () => {
  const golden = JSON.parse(readFileSync(join(FIXTURES, "allin1_filterbank.json"), "utf8")) as {
    bins: number[]; centerHz: number[]; entries: [number, number, number][];
  };
  const fb = filterbank();

  it("has 81 bands over 1024 bins and the exact madmom bins", () => {
    expect(fb.matrix).toBeInstanceOf(Float32Array);
    expect(fb.matrix).toHaveLength(1024 * 81);
    expect(fb.bins).toEqual(golden.bins);
    expect(fb.centerHz).toHaveLength(81);
  });

  it("matches every non-zero entry within 1e-7 and has no others", () => {
    let nonzero = 0;
    for (const v of fb.matrix) if (v !== 0) nonzero++;
    expect(nonzero).toBe(golden.entries.length);
    for (const [row, col, value] of golden.entries) {
      expect(Math.abs(fb.matrix[row * 81 + col] - value)).toBeLessThanOrEqual(1e-7);
    }
  });

  it("gives madmom's centre frequencies", () => {
    expect(fb.centerHz).toEqual(golden.centerHz);
  });

  it("centerHz equals the contract's ALLIN1_BAND_HZ", () => {
    expect(fb.centerHz).toEqual([...ALLIN1_BAND_HZ]);
  });

  it("normalises every band to unit area", () => {
    for (let b = 0; b < 81; b++) {
      let sum = 0;
      for (let k = 0; k < 1024; k++) sum += fb.matrix[k * 81 + b];
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it("is cached", () => {
    expect(filterbank()).toBe(fb);
  });
});

describe("stemSpectrogram", () => {
  const [l, r] = testSignal(88200, 2, 44100);
  // Same float32 steps as numpy: (x * f32(0.8)) * 32767, truncated to int16.
  const q = (v: number) => Math.trunc(Math.fround(Math.fround(v * Math.fround(0.8)) * 32767));
  const mono = Int16Array.from(l, (v, i) => Math.trunc((q(v) + q(r[i])) / 2));

  it("matches allin1_dsp.stem_spectrogram (max abs <= 1e-5, 200 frames)", () => {
    const ref = readNpy(join(FIXTURES, "allin1_stemspec.npy"));
    expect(ref.shape).toEqual([200, 81]);
    const got = stemSpectrogram(mono);
    expect(got).toHaveLength(200 * 81);
    let max = 0;
    for (let i = 0; i < got.length; i++) max = Math.max(max, Math.abs(got[i] - ref.data[i]));
    expect(max).toBeLessThanOrEqual(1e-5);
  });

  it("uses T = ceil(N / 441) frames and handles tiny and empty input", () => {
    expect(stemSpectrogram(new Int16Array(0))).toHaveLength(0);
    expect(stemSpectrogram(new Int16Array(1))).toHaveLength(81);
    expect(stemSpectrogram(new Int16Array(442))).toHaveLength(2 * 81);
    for (const v of stemSpectrogram(new Int16Array(3000))) expect(v).toBe(0); // log10(0 + 1)
  });

  // Wall-clock bounds are opt-in: they flake under parallel load. Run with SONG_SECTIONS_PERF=1.
  it.skipIf(!process.env.SONG_SECTIONS_PERF)("takes 5 minutes of mono in under 1.5 s", () => {
    const n = 44100 * 300;
    const big = new Int16Array(n);
    for (let i = 0; i < n; i++) big[i] = Math.round(8000 * Math.sin(i * 0.05) + 3000 * Math.sin(i * 0.9));
    const t0 = performance.now();
    const s = stemSpectrogram(big);
    const ms = performance.now() - t0;
    expect(s).toHaveLength(Math.ceil(n / 441) * 81);
    expect(ms).toBeLessThan(1500);
  }, 30000);
});

describe("quantiseStem", () => {
  it("matches demucs save_audio(rescale, 16 bit) + madmom remix (<= 1 LSB, >= 99.9 % exact)", () => {
    const [l, r] = testSignal(44100, 2, 44100);
    const k = Math.fround(1.5); // testSignal peaks near 0.85, so 1.5 makes the stem peak above 1 and exercises the rescale
    const L = Float32Array.from(l, (v) => Math.fround(v * k));
    const R = Float32Array.from(r, (v) => Math.fround(v * k));
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    expect(peak).toBeGreaterThan(1); // the rescale actually triggers
    const ref = readNpy(join(FIXTURES, "stem_quantise.npy"));
    expect(ref.shape).toEqual([44100]);
    const got = quantiseStem(L, R, peak);
    expect(got).toBeInstanceOf(Int16Array);
    expect(got).toHaveLength(44100);
    let exact = 0;
    for (let i = 0; i < got.length; i++) {
      const d = Math.abs(got[i] - ref.data[i]);
      expect(d).toBeLessThanOrEqual(1);
      if (d === 0) exact++;
    }
    expect(exact / got.length).toBeGreaterThanOrEqual(0.999);
  });

  it("does not rescale quiet stems and truncates toward zero", () => {
    const got = quantiseStem(Float32Array.of(0.5, -0.5, 1e-6), Float32Array.of(0.5, -0.5, -1e-6), 0.5);
    expect(Array.from(got)).toEqual([16383, -16383, 0]);
  });
});

describe("stackSpec", () => {
  it("puts bass first and vocals last: (1, 4, T, 81)", () => {
    const T = 3;
    const specs = {} as Record<StemName, Float32Array>;
    (["drums", "bass", "vocals", "other"] as const).forEach((s, i) => (specs[s] = new Float32Array(T * 81).fill(i + 1)));
    const out = stackSpec(specs, T);
    expect(out).toHaveLength(4 * T * 81);
    expect(out[0]).toBe(2); // bass
    expect(out[T * 81]).toBe(1); // drums
    expect(out[2 * T * 81]).toBe(4); // other
    expect(out[3 * T * 81]).toBe(3); // vocals
  });
  it("rejects a spectrogram of the wrong size", () => {
    const bad = { drums: new Float32Array(81), bass: new Float32Array(81), vocals: new Float32Array(81), other: new Float32Array(81) };
    expect(() => stackSpec(bad, 2)).toThrow();
  });
});

describe("stemSpectrogramSliced", () => {
  const signal = () => new AbortController().signal;
  const mono = (n: number) => {
    let seed = 7;
    return Int16Array.from({ length: n }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.round((seed / 2 ** 31) * 60000 - 30000);
    });
  };

  it("is bit-identical to stemSpectrogram for any slice size and length", async () => {
    for (const n of [0, 1, 440, 441, 442, 1500, 20 * 441 + 17, 44100 + 3]) {
      const x = mono(n);
      const want = stemSpectrogram(x);
      for (const per of [1, 2, 3, 4, 7, 50, 10_000]) {
        const got = await stemSpectrogramSliced(x, signal(), per);
        expect(got.length, `n=${n} per=${per}`).toBe(want.length);
        for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) throw new Error(`n=${n} per=${per}: differs at ${i}`);
      }
    }
  });

  it("yields between slices and stops on abort", async () => {
    const x = mono(100 * 441);
    const spy = vi.spyOn(globalThis, "setTimeout");
    await stemSpectrogramSliced(x, signal(), 10);
    expect(spy.mock.calls.filter(([, ms]) => ms === 0).length).toBeGreaterThanOrEqual(9);
    spy.mockRestore();
    const c = new AbortController();
    c.abort();
    await expect(stemSpectrogramSliced(x, c.signal, 10)).rejects.toMatchObject({ name: "AbortError" });
  });
});
