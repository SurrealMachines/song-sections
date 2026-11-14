import MeydaModule from "meyda";
import { describe, expect, it } from "vitest";
import { blockFeatures } from "./features.js";

/**
 * Drops Meyda's cached filter banks so the next extract builds them from the
 * current settings. Meyda never rebuilds them on a rate change by itself, so
 * this is the only way to get a known-fresh reference within one process.
 */
function resetMeydaCache(): void {
  const m = MeydaModule as unknown as Record<string, unknown>;
  m.barkScale = m.melFilterBank = m.chromaFilterBank = undefined;
  m.sampleRate = undefined;
}

function tones(seconds: number, rate: number, freqs: number[]): Float32Array {
  const seg = Math.floor((seconds * rate) / freqs.length);
  const x = new Float32Array(seg * freqs.length);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * freqs[Math.floor(i / seg)] * i) / rate);
  return x;
}

describe("blockFeatures", () => {
  it("does not reuse filter banks built for a previous sample rate", async () => {
    const x = tones(8, 12000, [220, 330, 440, 660]);
    const y = tones(4, 11025, [500]);

    resetMeydaCache();
    await blockFeatures(y, 11025); // builds banks for 11025
    const afterOtherRate = await blockFeatures(x, 12000);

    resetMeydaCache();
    const fresh = await blockFeatures(x, 12000);

    expect(afterOtherRate.map((v) => Array.from(v))).toEqual(fresh.map((v) => Array.from(v)));
  });

  it("returns no blocks for empty input", async () => {
    expect(await blockFeatures(new Float32Array(0), 11025)).toEqual([]);
  });

  it("completes over >200 blocks without a global setImmediate (Live's host lacks it)", async () => {
    const x = tones(110, 11025, [220, 330]);
    const saved = (globalThis as { setImmediate?: unknown }).setImmediate;
    delete (globalThis as { setImmediate?: unknown }).setImmediate;
    try {
      const blocks = await blockFeatures(x, 11025);
      expect(blocks.length).toBeGreaterThan(200);
    } finally {
      (globalThis as { setImmediate?: unknown }).setImmediate = saved;
    }
  }, 60000);
});
