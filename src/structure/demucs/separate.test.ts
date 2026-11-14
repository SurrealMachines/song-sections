import { describe, expect, it, vi } from "vitest";
import { FIXTURES, snrDb } from "../../test/golden.js";
import { readNpy } from "../../test/npy.js";
import { testSignal } from "../../test/signals.js";
import { SEGMENT_LENGTH } from "./dsp.js";
import { separate, type DemucsCore, type StemSink } from "./separate.js";

// Identical to fake_core in tools/golden/fixtures_demucs.py.
const G = [0.5, 0.25, 0, 1];
const H = [0, 0.5, 1, 0.25];
const L = SEGMENT_LENGTH;
const fakeCore: DemucsCore = async ({ mix, spec }) => {
  const specOut = new Float32Array(4 * spec.length);
  const waveOut = new Float32Array(4 * 2 * L);
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < spec.length; i++) specOut[s * spec.length + i] = G[s] * spec[i];
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < L; i++) waveOut[(s * 2 + c) * L + i] = H[s] * mix[c * L + i] * (i / L);
    }
  }
  return { specOut, waveOut };
};

function collectingSink(n: number) {
  const out = Array.from({ length: 4 }, () => [new Float32Array(n), new Float32Array(n)]);
  const writes: Array<[number, number, number]> = []; // source, offset, length
  const sink: StemSink = {
    async write(source, left, right, offset) {
      writes.push([source, offset, left.length]);
      expect(right.length).toBe(left.length);
      out[source][0].set(left, offset);
      out[source][1].set(right, offset);
    },
  };
  return { out, writes, sink };
}

describe("separate with the fake core", () => {
  const N = 600000;
  const [l, r] = testSignal(N, 2, 44100);

  it("matches demucs_dsp.separate (SNR >= 90 dB per source) and covers [0, N) in order", async () => {
    const ref = readNpy(`${FIXTURES}/demucs_separate.npy`);
    expect(ref.shape).toEqual([4, 2, 600]);
    const { out, writes, sink } = collectingSink(N);
    const progress: number[] = [];
    await separate(l, r, fakeCore, sink, new AbortController().signal, (f) => progress.push(f));

    for (let s = 0; s < 4; s++) {
      for (let c = 0; c < 2; c++) {
        const dec = new Float32Array(600);
        for (let j = 0; j < 600; j++) dec[j] = out[s][c][j * 1000];
        const want = (ref.data as Float32Array).subarray((s * 2 + c) * 600, (s * 2 + c + 1) * 600);
        // source 2 (G = 0, H = 1) and source 0 are non-trivial; silent-ish rows still must match closely.
        const snr = snrDb(want, dec);
        expect(snr, `source ${s} channel ${c}`).toBeGreaterThanOrEqual(90);
      }
      const mine = writes.filter((w) => w[0] === s);
      let next = 0;
      for (const [, off, len] of mine) {
        expect(off).toBe(next);
        next = off + len;
      }
      expect(next).toBe(N);
    }
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  }, 60000);

  it("rejects AbortError after the first core call, with no further core calls", async () => {
    const ac = new AbortController();
    const core = vi.fn<DemucsCore>(async (inputs) => {
      const r = await fakeCore(inputs);
      ac.abort();
      return r;
    });
    const { sink } = collectingSink(N);
    const err = await separate(l, r, core, sink, ac.signal, () => {}).catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(core).toHaveBeenCalledTimes(1);
  }, 30000);

  it("stops the normalisation passes at the next slice when aborted during a yield (Task 11 review M2)", async () => {
    // Two slices per pass (1 << 22 samples each) so each pass yields; the abort lands during the first yield.
    const n = (1 << 23) + 1;
    const a = new Float32Array(n).fill(0.1);
    const b = new Float32Array(n).fill(0.1);
    const ac = new AbortController();
    const core = vi.fn<DemucsCore>(fakeCore);
    setTimeout(() => ac.abort(), 0); // queued before the first yield's timer, so it fires first
    const yields = vi.spyOn(globalThis, "setTimeout");
    try {
      const { sink } = collectingSink(n);
      const err = await separate(a, b, core, sink, ac.signal, () => {}).catch((e) => e);
      expect((err as Error).name).toBe("AbortError");
      expect(core).not.toHaveBeenCalled();
      expect(yields).toHaveBeenCalledTimes(1); // one yield, then the check; not the 4 yields of both passes
    } finally {
      yields.mockRestore();
    }
  }, 30000);

  it("handles tracks shorter than one segment (centred tail chunk)", async () => {
    const n = 50000;
    const [a, b] = testSignal(n, 2, 44100);
    const { out, writes, sink } = collectingSink(n);
    await separate(a, b, fakeCore, sink, new AbortController().signal, () => {});
    expect(writes.filter((w) => w[0] === 0).reduce((s, w) => s + w[2], 0)).toBe(n);
    for (const s of out) for (const ch of s) for (let i = 0; i < n; i += 997) expect(Number.isFinite(ch[i])).toBe(true);
  }, 30000);

  it("writes nothing for an empty track", async () => {
    const { writes, sink } = collectingSink(0);
    await separate(new Float32Array(0), new Float32Array(0), fakeCore, sink, new AbortController().signal, () => {});
    expect(writes).toEqual([]);
  });
});
