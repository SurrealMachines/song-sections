import { describe, expect, it } from "vitest";
import { monoAndLoudness, sliced } from "./engine.js";
import type { createStemStore } from "./stems.js";

// Task 11 review M2: the sliced whole-track passes check the abort signal after each yield, so a cancel lands at the
// next slice instead of after the pass. Synthetic inputs only (no model files).

describe("sliced", () => {
  it("runs every slice when the signal never aborts", async () => {
    const seen: Array<[number, number]> = [];
    await sliced(10, 4, (a, b) => void seen.push([a, b]), new AbortController().signal);
    expect(seen).toEqual([[0, 4], [4, 8], [8, 10]]);
  });

  it("stops at the next slice when the signal aborts mid-run, rejecting with an AbortError", async () => {
    const c = new AbortController();
    let calls = 0;
    const run = sliced(100, 10, () => {
      if (++calls === 2) c.abort();
    }, c.signal);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(2);
  });

  it("an already-aborted signal stops after the first slice", async () => {
    const c = new AbortController();
    c.abort();
    let calls = 0;
    await expect(sliced(100, 10, () => void calls++, c.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});

describe("monoAndLoudness", () => {
  const fakeStore = (slices: number, onSlice: () => void) =>
    ({
      frames: () => slices * 22050,
      peak: () => 1,
      async readSlices(_source: number, _per: number, fn: (l: Float32Array, r: Float32Array, offset: number) => void | Promise<void>) {
        for (let k = 0; k < slices; k++) {
          onSlice();
          await fn(new Float32Array(22050).fill(0.1), new Float32Array(22050).fill(0.1), k * 22050);
        }
      },
    }) as unknown as ReturnType<typeof createStemStore>;

  it("reads every slice when not aborted", async () => {
    let reads = 0;
    const r = await monoAndLoudness(fakeStore(3, () => void reads++), 0, new AbortController().signal);
    expect(reads).toBe(3);
    expect(r.loudnessDb).toHaveLength(3);
    // 10 peak blocks of 2205 samples per 22050-sample slice, each at its slice's offset.
    expect(Array.from(r.peaks)).toEqual(new Array(30).fill(Math.fround(0.1)));
  });

  it("puts each slice's peak blocks at the slice's offset (a slice is a whole number of blocks)", async () => {
    const store = {
      frames: () => 3 * 22050 + 100,
      peak: () => 1,
      async readSlices(_source: number, per: number, fn: (l: Float32Array, r: Float32Array, offset: number) => void | Promise<void>) {
        expect(per % 2205).toBe(0);
        for (let k = 0, offset = 0; k < 4; k++, offset += 22050) {
          const n = k < 3 ? 22050 : 100;
          const l = new Float32Array(n);
          const r = new Float32Array(n);
          l[n - 1] = 0.25 * (k + 1); // last block of each slice
          r[0] = -0.125; // first block of each slice
          await fn(l, r, offset);
        }
      },
    } as unknown as ReturnType<typeof createStemStore>;
    const r = await monoAndLoudness(store, 0, new AbortController().signal);
    expect(r.peaks).toHaveLength(31);
    expect(r.peaks[0]).toBe(0.125);
    expect(r.peaks[9]).toBe(0.25);
    expect(r.peaks[10]).toBe(0.125);
    expect(r.peaks[29]).toBe(0.75);
    expect(r.peaks[30]).toBe(1);
  });

  it("hands each float slice to onSlice, in order, before the yield (the audition stems are written from it)", async () => {
    const seen: number[] = [];
    await monoAndLoudness(fakeStore(3, () => {}), 0, new AbortController().signal, async (l, r, offset) => {
      expect(l.length).toBe(22050);
      expect(r[0]).toBeCloseTo(0.1, 6);
      seen.push(offset);
    });
    expect(seen).toEqual([0, 22050, 44100]);
  });

  it("stops reading slices once the signal aborts", async () => {
    const c = new AbortController();
    let reads = 0;
    const store = fakeStore(3, () => {
      if (++reads === 2) c.abort();
    });
    await expect(monoAndLoudness(store, 0, c.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(2); // slice 2 was started, its callback aborted after the yield; slice 3 never read
  });
});
