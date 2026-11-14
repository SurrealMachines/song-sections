// fb2 review m2: pollStructure keeps going through polls that get no answer, and gives up cleanly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRUCTURE_POLL_FAILURES, pollStructure } from "./bridge.js";
import type { StructureProgress } from "./protocol.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pollStructure", () => {
  it("after STRUCTURE_POLL_FAILURES polls in a row with no answer, reports none and stops", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:" });
    const fetch = vi.fn(async () => {
      throw new TypeError("Load failed");
    });
    vi.stubGlobal("fetch", fetch);
    const seen: StructureProgress[] = [];
    pollStructure((p) => seen.push(p), 100);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(STRUCTURE_POLL_FAILURES);
    expect(seen).toEqual([{ state: "none", percent: 0 }]);
  });

  it("an answer resets the count", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:" });
    let n = 0;
    const fetch = vi.fn(async () => {
      if (++n % 2 === 1) throw new TypeError("Load failed"); // every other poll gets no answer
      return { ok: true, json: async () => ({ state: "running", percent: n }) };
    });
    vi.stubGlobal("fetch", fetch);
    const seen: StructureProgress[] = [];
    const stop = pollStructure((p) => seen.push(p), 100);
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(seen.length).toBeGreaterThan(STRUCTURE_POLL_FAILURES);
    expect(seen.every((p) => p.state === "running")).toBe(true);
  });
});
