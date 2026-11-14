import { describe, expect, it, vi } from "vitest";
import type { ClipInfo } from "./acquire.js";
import { arrangementOps, type ArrangementOp } from "./arrangementOps.js";
import { ArrangementApplyError, executeArrangement } from "./execute.js";

interface FakeClip {
  id: string;
  startTime: number;
  endTime: number;
  name: string;
  color: number;
}

/**
 * These tests pin OUR handling of the split (order, piece collection, labelling, error counts).
 * That Live really splits on a zero-width clearClipsInRange is an assumption measured in Live
 * (docs/live-api-findings.md F9); no test here can fail if Live stops doing so.
 *
 * Fake arrangement track. `clearClipsInRange(a, b)` with a === b behaves like Live's native split:
 * the clip strictly covering `a` keeps its identity as the LEFT piece, a new clip becomes the RIGHT piece.
 * Any other call is recorded but does nothing (the real thing would delete clips; we must never rely on it).
 */
function makeFakes(initial: Array<Omit<FakeClip, "name" | "color" | "id"> & { id?: string }>) {
  const log: string[] = [];
  let depth = 0;
  let transactions = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let nextId = 0;
  const all: FakeClip[] = [];
  const mkClip = (startTime: number, endTime: number, base?: FakeClip, id?: string): FakeClip => {
    const store = { name: base?.name ?? "orig", color: base?.color ?? 7 };
    const c = { id: id ?? `c${nextId++}`, startTime, endTime } as FakeClip;
    for (const key of ["name", "color"] as const) {
      Object.defineProperty(c, key, {
        enumerable: true,
        get: () => store[key],
        set: (v) => {
          log.push(`set ${c.id}.${key}@${depth > 0 ? "tx" : "outside"}`);
          (store as Record<string, unknown>)[key] = v;
        },
      });
    }
    all.push(c);
    return c;
  };
  let clips = initial.map((i) => mkClip(i.startTime, i.endTime, undefined, i.id));
  const track = {
    get arrangementClips() {
      // Deliberately unsorted: callers must sort by startTime themselves.
      return [...clips].reverse();
    },
    clearClipsInRange: vi.fn(async (a: number, b: number) => {
      log.push(`clear ${a}-${b}@${depth}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (a === b) {
        const left = clips.find((c) => c.startTime < a && a < c.endTime);
        if (left) {
          const right = mkClip(a, left.endTime, left);
          left.endTime = a;
          clips = [...clips, right];
        }
      }
    }),
    createAudioClip: vi.fn(async () => {
      throw new Error("createAudioClip must not be called");
    }),
  };
  const cues: Array<{ time: number; name: string }> = [];
  const song = {
    createCuePoint: vi.fn(async (time: number) => {
      log.push(`cue ${time}@${depth}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const cue = { time, name: "" };
      cues.push(cue);
      return cue;
    }),
  };
  const context = {
    application: { song },
    withinTransaction: <T>(fn: () => T): T => {
      transactions++;
      depth++;
      log.push(`begin tx${transactions}`);
      try {
        return fn();
      } finally {
        depth--;
        log.push(`end tx${transactions}`);
      }
    },
  };
  return { context, track, song, log, cues, all, current: () => clips, tx: () => transactions, maxInFlight: () => maxInFlight };
}

const info = (track: unknown, over: Partial<ClipInfo> = {}): ClipInfo =>
  ({
    view: "arrangement",
    clip: {},
    track,
    startTime: 32,
    lengthBeats: 60,
    startMarker: 4,
    endMarker: 64,
    warped: true,
    warpMode: 3,
    filePath: "/samples/a.wav",
    color: 0,
    name: "x",
    ...over,
  }) as unknown as ClipInfo;

const splitOps: ArrangementOp[] = [
  { kind: "split", time: 44 },
  { kind: "split", time: 62 },
  { kind: "label", name: "A", color: 0xff0000 },
  { kind: "label", name: "B", color: 0x00ff00 },
  { kind: "label", name: "C", color: 0x0000ff },
];

/** The source clip plus unrelated neighbours on the track, which must be ignored. */
const trackWithNeighbours = () =>
  makeFakes([
    { id: "before", startTime: 0, endTime: 32 },
    { id: "src", startTime: 32, endTime: 92 },
    { id: "after", startTime: 92, endTime: 120 },
  ]);

describe("executeArrangement (native split)", () => {
  it("splits at each time in ascending order, strictly one at a time, never creating clips", async () => {
    const f = trackWithNeighbours();
    await executeArrangement(f.context as never, info(f.track), splitOps);

    expect(f.track.clearClipsInRange.mock.calls).toEqual([
      [44, 44],
      [62, 62],
    ]);
    expect(f.maxInFlight()).toBe(1);
    expect(f.track.createAudioClip).not.toHaveBeenCalled();
    // every split is issued outside any transaction
    expect(f.log.filter((l) => l.startsWith("clear"))).toEqual(["clear 44-44@0", "clear 62-62@0"]);
  });

  it("awaits each split before issuing the next", async () => {
    const f = trackWithNeighbours();
    // The second split only has a clip to cut if the first has already completed.
    const seen: number[] = [];
    const orig = f.track.clearClipsInRange.getMockImplementation()!;
    f.track.clearClipsInRange.mockImplementation(async (a: number, b: number) => {
      seen.push(f.current().filter((c) => c.startTime >= 32 && c.endTime <= 92).length);
      await orig(a, b);
    });
    await executeArrangement(f.context as never, info(f.track), splitOps);
    expect(seen).toEqual([1, 2]);
    expect(f.current().filter((c) => c.startTime >= 32 && c.endTime <= 92)).toHaveLength(3);
  });

  it("labels the pieces in time order inside a single transaction, keeping the left piece's identity", async () => {
    const f = trackWithNeighbours();
    await executeArrangement(f.context as never, info(f.track), splitOps);

    expect(f.tx()).toBe(1);
    const pieces = f.current().filter((c) => c.startTime >= 32 && c.endTime <= 92).sort((a, b) => a.startTime - b.startTime);
    expect(pieces.map((p) => [p.startTime, p.endTime])).toEqual([
      [32, 44],
      [44, 62],
      [62, 92],
    ]);
    expect(pieces.map((p) => [p.name, p.color])).toEqual([
      ["A", 0xff0000],
      ["B", 0x00ff00],
      ["C", 0x0000ff],
    ]);
    expect(pieces[0].id).toBe("src");
    // neighbours untouched
    for (const id of ["before", "after"]) {
      const c = f.current().find((x) => x.id === id)!;
      expect([c.name, c.color]).toEqual(["orig", 7]);
    }
    // all sets are inside the transaction, after every split
    const sets = f.log.filter((l) => l.startsWith("set"));
    expect(sets).toHaveLength(6);
    expect(sets.every((l) => l.endsWith("@tx"))).toBe(true);
    const begin = f.log.indexOf("begin tx1");
    f.log.forEach((l, i) => {
      if (l.startsWith("clear")) expect(i).toBeLessThan(begin);
      if (l.startsWith("set")) expect(i).toBeGreaterThan(begin);
    });
  });

  it("never sets warpMode", async () => {
    const f = trackWithNeighbours();
    await executeArrangement(f.context as never, info(f.track, { warpMode: 3 as never }), splitOps);
    expect(f.log.some((l) => l.includes("warpMode"))).toBe(false);
  });

  it("a single section: no split, just one label on the original clip", async () => {
    const f = trackWithNeighbours();
    await executeArrangement(f.context as never, info(f.track), [{ kind: "label", name: "Only", color: 5 }]);
    expect(f.track.clearClipsInRange).not.toHaveBeenCalled();
    const src = f.current().find((c) => c.id === "src")!;
    expect([src.name, src.color]).toEqual(["Only", 5]);
  });

  it("throws naming both counts when the piece count differs from the label count", async () => {
    const f = trackWithNeighbours();
    // Fake Live refuses to split at 62 (e.g. a changed clip): only 2 pieces for 3 labels.
    const orig = f.track.clearClipsInRange.getMockImplementation()!;
    f.track.clearClipsInRange.mockImplementation(async (a: number, b: number) => {
      if (a === 62) return;
      await orig(a, b);
    });
    await expect(executeArrangement(f.context as never, info(f.track), splitOps)).rejects.toThrow(/2.*3|3.*2/);
    // nothing was renamed
    expect(f.tx()).toBe(0);
    expect(f.log.some((l) => l.startsWith("set"))).toBe(false);
  });

  it("the error message names the found piece count and the expected label count", async () => {
    const f = trackWithNeighbours();
    f.track.clearClipsInRange.mockImplementation(async () => undefined);
    await expect(executeArrangement(f.context as never, info(f.track), splitOps)).rejects.toThrow(
      /found 1 .*expected 3/i,
    );
  });

  it("tolerates float noise at both span edges, and ignores neighbours just outside", async () => {
    const f = makeFakes([
      { id: "left", startTime: 0, endTime: 32 - 2e-6 },
      { id: "src", startTime: 32 - 5e-7, endTime: 92 + 5e-7 },
      { id: "right", startTime: 92 + 2e-6, endTime: 120 },
    ]);
    await executeArrangement(f.context as never, info(f.track), [splitOps[0], splitOps[2], splitOps[3]]);
    const names = (id: string) => f.current().filter((c) => c.id === id).map((c) => c.name);
    expect(names("left")).toEqual(["orig"]);
    expect(names("right")).toEqual(["orig"]);
    expect(f.current().filter((c) => c.name === "A" || c.name === "B")).toHaveLength(2);
  });

  it("excludes a clip that starts inside the span but ends beyond it (the clip changed under us)", async () => {
    // The dialog saw 32..92; by apply time the clip runs to 110, so the right piece overruns the span.
    const f = makeFakes([{ id: "src", startTime: 32, endTime: 110 }]);
    await expect(
      executeArrangement(f.context as never, info(f.track), [splitOps[0], splitOps[2], splitOps[3]]),
    ).rejects.toThrow(/found 1 .*expected 2/i);
    expect(f.tx()).toBe(0);
  });

  it("a section shorter than the shared tolerance is dropped by the ops and does not throw", async () => {
    const f = trackWithNeighbours();
    const sections = [
      { start: 0, end: 10, label: "A", color: 0xff0000 },
      { start: 10, end: 10 + 4e-7, label: "Sliver", color: 0x00ff00 },
      { start: 10 + 4e-7, end: 30, label: "C", color: 0x0000ff },
    ];
    const ops = arrangementOps(info(f.track), sections, "split", 120);
    await executeArrangement(f.context as never, info(f.track), ops);
    expect(f.track.clearClipsInRange).toHaveBeenCalledTimes(1);
    const pieces = f.current().filter((c) => c.startTime >= 32 && c.endTime <= 92).sort((a, b) => a.startTime - b.startTime);
    expect(pieces.map((p) => p.name)).toEqual(["A", "C"]);
  });
});

describe("executeArrangement failures report the completed cuts", () => {
  const catchError = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected rejection");
  };

  it("a split that rejects partway: cuts counts the completed ones, no names are set", async () => {
    const f = trackWithNeighbours();
    const orig = f.track.clearClipsInRange.getMockImplementation()!;
    f.track.clearClipsInRange.mockImplementation(async (a: number, b: number) => {
      if (a === 62) throw new Error("rejected");
      await orig(a, b);
    });
    const e = await catchError(executeArrangement(f.context as never, info(f.track), splitOps));
    expect(e).toBeInstanceOf(ArrangementApplyError);
    expect((e as ArrangementApplyError).cuts).toBe(1);
    expect((e as ArrangementApplyError).cues).toBe(0);
    expect((e as Error).message).toMatch(/rejected/);
    expect(f.tx()).toBe(0);
    expect(f.log.some((l) => l.startsWith("set"))).toBe(false);
  });

  it("the first split rejecting reports zero cuts", async () => {
    const f = trackWithNeighbours();
    f.track.clearClipsInRange.mockRejectedValue(new Error("frozen track"));
    const e = await catchError(executeArrangement(f.context as never, info(f.track), splitOps));
    expect(e).toBeInstanceOf(ArrangementApplyError);
    expect((e as ArrangementApplyError).cuts).toBe(0);
  });

  it("a piece-count mismatch after all cuts reports every cut", async () => {
    const f = trackWithNeighbours();
    const e = await catchError(
      executeArrangement(f.context as never, info(f.track, { lengthBeats: 30 }), splitOps),
    );
    expect(e).toBeInstanceOf(ArrangementApplyError);
    expect((e as ArrangementApplyError).cuts).toBe(2);
  });

  it("a failing cue point reports the cuts and the cues made so far", async () => {
    const f = trackWithNeighbours();
    f.song.createCuePoint.mockImplementation(async (t: number) => {
      if (t === 44) throw new Error("no cue");
      return { time: t, name: "" };
    });
    const ops: ArrangementOp[] = [
      ...splitOps,
      { kind: "cue", time: 32, name: "A" },
      { kind: "cue", time: 44, name: "B" },
    ];
    const e = (await catchError(executeArrangement(f.context as never, info(f.track), ops))) as ArrangementApplyError;
    expect(e.cuts).toBe(2);
    expect(e.cues).toBe(1);
  });
});

describe("executeArrangement cue points", () => {
  it("creates cues sequentially after the splits and names them in the transaction", async () => {
    const f = trackWithNeighbours();
    const ops: ArrangementOp[] = [
      ...splitOps,
      { kind: "cue", time: 32, name: "A" },
      { kind: "cue", time: 44, name: "B" },
      { kind: "cue", time: 62, name: "C" },
    ];
    await executeArrangement(f.context as never, info(f.track), ops);
    expect(f.maxInFlight()).toBe(1);
    expect(f.song.createCuePoint.mock.calls.map((c) => c[0])).toEqual([32, 44, 62]);
    expect(f.cues.map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect(f.tx()).toBe(1);
    const clearAfter = f.log.lastIndexOf("clear 62-62@0");
    expect(f.log.indexOf("cue 32@0")).toBeGreaterThan(clearAfter);
  });

  it("locators only: no splits, no clip collection, cues named in one transaction", async () => {
    const f = trackWithNeighbours();
    await executeArrangement(f.context as never, info(f.track), [
      { kind: "cue", time: 32, name: "A" },
      { kind: "cue", time: 52, name: "B" },
    ]);
    expect(f.track.clearClipsInRange).not.toHaveBeenCalled();
    expect(f.cues.map((c) => c.name)).toEqual(["A", "B"]);
    expect(f.tx()).toBe(1);
    expect(f.current().every((c) => c.name === "orig")).toBe(true);
  });

  it("no ops: no transaction", async () => {
    const f = trackWithNeighbours();
    await executeArrangement(f.context as never, info(f.track), []);
    expect(f.tx()).toBe(0);
  });
});
