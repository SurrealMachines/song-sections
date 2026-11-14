// Live's extension host has no DOMException. Cancelling must still reject with an Error named "AbortError",
// not a ReferenceError from `new DOMException(...)`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreparedAudio } from "../audio/prepare.js";
import { analyseCue } from "./cue.js";

function prepared(seconds: number): PreparedAudio {
  const rate = 11025;
  const analysis = new Float32Array(seconds * rate);
  for (let i = 0; i < analysis.length; i++) analysis[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * (1 + (i % 7) / 7);
  return { analysis, analysisRate: rate, durationSec: seconds, waveform: { min: [], max: [] }, previewPath: "/dev/null", hash: "t" };
}

describe("analyseCue cancel without DOMException (Live's extension host)", () => {
  const g = globalThis as { DOMException?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = g.DOMException;
    delete g.DOMException;
  });
  afterEach(() => {
    g.DOMException = saved;
  });

  async function rejection(p: Promise<unknown>): Promise<Error> {
    try {
      await p;
    } catch (e) {
      return e as Error;
    }
    throw new Error("did not reject");
  }

  it("has no DOMException during these tests", () => {
    expect(typeof g.DOMException).toBe("undefined");
  });

  it("rejects with AbortError when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await rejection(analyseCue(prepared(1), ac.signal, () => {}));
    expect(e).not.toBeInstanceOf(ReferenceError);
    expect(e.name).toBe("AbortError");
  });

  it("rejects with AbortError when aborted after feature extraction", async () => {
    const ac = new AbortController();
    const e = await rejection(analyseCue(prepared(3), ac.signal, (f) => f === 1 && ac.abort()));
    expect(e).not.toBeInstanceOf(ReferenceError);
    expect(e.name).toBe("AbortError");
  });

  it("rejects with AbortError when aborted halfway", async () => {
    const ac = new AbortController();
    const e = await rejection(analyseCue(prepared(300), ac.signal, (f) => f >= 0.5 && ac.abort()));
    expect(e).not.toBeInstanceOf(ReferenceError);
    expect(e.name).toBe("AbortError");
  });
});
