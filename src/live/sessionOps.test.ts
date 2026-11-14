import type { ClipLoopSettings } from "@ableton-extensions/sdk";
import { describe, expect, it, vi } from "vitest";
import type { Section } from "../core/types.js";
import type { ClipInfo } from "./acquire.js";
import { executeSession } from "./execute.js";
import { sceneNames, sessionOps, type SessionOp } from "./sessionOps.js";
import { parkedRegion } from "./execute.js";
import { beatToSec, secToBeat, type WarpPoint } from "../core/warpMap.js";

const sections: Section[] = [
  { start: 0, end: 10, label: "Cue 1", color: 0xff0000 },
  { start: 10, end: 20, label: "Cue 2", color: 0x00ff00 },
  { start: 20, end: 30, label: "Cue 3", color: 0x0000ff },
];

/** The source clip is deleted by the arrangement clear; any access afterwards throws like Live's "Invalid object reference". */
const deadClip = new Proxy(
  {},
  {
    get() {
      throw new TypeError("Invalid object reference");
    },
  },
);

const info = (over: Partial<ClipInfo> = {}): ClipInfo =>
  ({
    view: "session",
    clip: deadClip,
    track: {},
    sceneIndex: 2,
    startTime: 0,
    lengthBeats: 60,
    startMarker: 4,
    endMarker: 64,
    warped: true,
    filePath: "/samples/a.wav",
    color: 0,
    name: "x",
    ...over,
  }) as unknown as ClipInfo;

const loop = (startMarker: number, endMarker: number, looping: boolean) => ({
  startMarker,
  endMarker,
  loopStart: startMarker,
  loopEnd: endMarker,
  looping,
});

describe("sessionOps", () => {
  it("creates scenes below the source scene, then one slot clip per section", () => {
    const ops = sessionOps(info(), sections, 120);
    expect(ops).toEqual([
      { kind: "scene", index: 3, name: "Cue 1" },
      { kind: "scene", index: 4, name: "Cue 2" },
      { kind: "scene", index: 5, name: "Cue 3" },
      { kind: "slotClip", sceneIndex: 3, loop: loop(4, 24, true), isWarped: true, name: "Cue 1", color: 0xff0000 },
      { kind: "slotClip", sceneIndex: 4, loop: loop(24, 44, true), isWarped: true, name: "Cue 2", color: 0x00ff00 },
      { kind: "slotClip", sceneIndex: 5, loop: loop(44, 64, true), isWarped: true, name: "Cue 3", color: 0x0000ff },
    ]);
  });

  it("numbers repeated names on the scenes only; each clip keeps its section's plain label (feedback round 1)", () => {
    const dup: Section[] = [
      { start: 0, end: 10, label: "B′ - inst", color: 1 },
      { start: 10, end: 20, label: "C - solo", color: 2 },
      { start: 20, end: 30, label: "B′ - inst", color: 1 },
    ];
    const ops = sessionOps(info(), dup, 120);
    const names = (kind: SessionOp["kind"]) => ops.filter((o) => o.kind === kind).map((o) => o.name);
    expect(names("scene")).toEqual(["B′ - inst", "C - solo", "B′ - inst 2"]);
    expect(names("slotClip")).toEqual(["B′ - inst", "C - solo", "B′ - inst"]);
  });

  it("throws when the source scene index is missing or negative", () => {
    expect(() => sessionOps(info({ sceneIndex: undefined }), sections, 120)).toThrow(/scene/i);
    expect(() => sessionOps(info({ sceneIndex: -1 }), sections, 120)).toThrow(/scene/i);
  });

  it("unwarped: markers in seconds, isWarped false, not looping", () => {
    const ops = sessionOps(info({ warped: false, startMarker: 4, endMarker: 34 }), sections, 120);
    const clips = ops.filter((o) => o.kind === "slotClip");
    expect(clips.map((o) => o.isWarped)).toEqual([false, false, false]);
    expect(clips[0].loop).toEqual(loop(4, 14, false));
    expect(clips[2].loop).toEqual(loop(24, 34, false));
  });
});

describe("sceneNames (Plan 6: Session scenes are <section label> <n>)", () => {
  const verses: Section[] = [
    { start: 0, end: 8, label: "A - verse", color: 1 },
    { start: 8, end: 16, label: "B - chorus", color: 2 },
    { start: 16, end: 24, label: "A - verse", color: 1 },
  ];

  it("numbers each scene within its section's label, across every section sharing it, in time order", () => {
    expect(sceneNames(verses, [0, 4, 8, 16, 20])).toEqual(["A - verse 1", "A - verse 2", "B - chorus 1", "A - verse 3", "A - verse 4"]);
  });

  it("adds the section's key after the number", () => {
    expect(sceneNames(verses, [0, 4, 8, 16, 20], ["Dm", null, "Dm"])).toEqual([
      "A - verse 1 · Dm",
      "A - verse 2 · Dm",
      "B - chorus 1",
      "A - verse 3 · Dm",
      "A - verse 4 · Dm",
    ]);
  });

  it("a start on a section edge belongs to the section it starts; one at or past the end to the last", () => {
    expect(sceneNames(verses, [7.9, 8, 24])).toEqual(["A - verse 1", "B - chorus 1", "A - verse 2"]);
  });
});

describe("sessionOps with pieces (Plan 6: Slice by)", () => {
  const verseChorus: Section[] = [
    { start: 0, end: 10, label: "A - verse", color: 1 },
    { start: 10, end: 20, label: "B - chorus", color: 2 },
    { start: 20, end: 30, label: "A - verse", color: 1 },
  ];
  // A rest from 8 to 12 s is left out: no clip there.
  const pieces: Section[] = [
    { start: 0, end: 8, label: "other 1", color: 0x110000 },
    { start: 12, end: 20, label: "other 2", color: 0x220000 },
    { start: 20, end: 30, label: "other 1", color: 0x110000 },
  ];

  it("makes one scene per piece below the source scene, named by sceneNames, each clip named and coloured as its piece", () => {
    expect(sessionOps(info(), verseChorus, 120, undefined, pieces)).toEqual([
      { kind: "scene", index: 3, name: "A - verse 1" },
      { kind: "scene", index: 4, name: "B - chorus 1" },
      { kind: "scene", index: 5, name: "A - verse 2" },
      { kind: "slotClip", sceneIndex: 3, loop: loop(4, 20, true), isWarped: true, name: "other 1", color: 0x110000 },
      { kind: "slotClip", sceneIndex: 4, loop: loop(28, 44, true), isWarped: true, name: "other 2", color: 0x220000 },
      { kind: "slotClip", sceneIndex: 5, loop: loop(44, 64, true), isWarped: true, name: "other 1", color: 0x110000 },
    ]);
  });

  it("a leading and a trailing rest are left out too; the scenes carry the section keys", () => {
    const inner: Section[] = [{ start: 2, end: 26, label: "other 1", color: 0x110000 }];
    const ops = sessionOps(info(), verseChorus, 120, ["Dm", null, "Dm"], inner);
    expect(ops).toEqual([
      { kind: "scene", index: 3, name: "A - verse 1 · Dm" },
      { kind: "slotClip", sceneIndex: 3, loop: loop(8, 56, true), isWarped: true, name: "other 1", color: 0x110000 },
    ]);
  });

  it("a last piece ending at the clip's end ends at the clip's own end marker, as the last section does", () => {
    // 30 s - 1e-8 s maps to 64 - 2e-8 beats: the same edge as the clip's end within MIN_PIECE_BEATS.
    const toEnd: Section[] = [pieces[0], { ...pieces[1], end: 30 - 1e-8 }];
    const clips = sessionOps(info(), verseChorus, 120, undefined, toEnd).filter((o) => o.kind === "slotClip");
    expect(clips.map((o) => o.loop)).toEqual([loop(4, 20, true), loop(28, 64, true)]);
    expect(clips[1].loop.endMarker).toBe(info().endMarker);
    // With a real trailing rest, the last piece still ends at its own end.
    const short: Section[] = [pieces[0], { ...pieces[1], end: 26 }];
    expect(sessionOps(info(), verseChorus, 120, undefined, short).filter((o) => o.kind === "slotClip")[1].loop).toEqual(loop(28, 56, true));
  });

  it("without pieces nothing changes", () => {
    expect(sessionOps(info(), verseChorus, 120, undefined, undefined)).toEqual(sessionOps(info(), verseChorus, 120));
  });
});

/**
 * `liveGrid`: the warp markers Live gives a warped clip it creates from the file (an unwarped one gets none here).
 * fb4, item 3: a clip keeps its markers and loop region; `warping = false` converts them from beats to file seconds
 * through its warp markers and keeps the markers (`unwarp: "keeps"`, what Live is expected to do), or leaves the
 * numbers as they are (`"loses"`). `looping = true` on an unwarped clip turns warping back on (SDK: Clip.looping), onto
 * the markers it kept, the region going back to beats.
 */
/**
 * `throwOn` (fb4 review I2): slots whose parked create rejects (a warped create with `looping: false`), whose clip's
 * `warping` setter throws, whose `warpMode` setter throws, or whose plain unwarped create rejects.
 */
interface Throws {
  parkedCreate?: number[];
  warping?: number[];
  warpMode?: number[];
  plainCreate?: number[];
}
function makeFakes(
  liveGrid?: { beatTime: number; sampleTime: number }[],
  unwarp: "keeps" | "loses" = "keeps",
  losesIn: number[] = [],
  throwOn: Throws = {},
) {
  const log: string[] = [];
  let depth = 0;
  let transactions = 0;
  const objs: Record<string, unknown>[] = [];
  const mk = (label: string, init: Record<string, unknown> = {}, loses = unwarp === "loses", slot = -1) => {
    const o: Record<string, unknown> = {};
    const state: Record<string, unknown> = { ...init };
    const REGION = ["startMarker", "endMarker", "loopStart", "loopEnd"] as const;
    const convert = (f: (x: number) => number | null) => {
      for (const k of REGION) if (typeof state[k] === "number") state[k] = f(state[k] as number);
    };
    for (const key of ["name", "color", "warpMode", "warping", "looping", ...REGION, "warpMarkers"]) {
      Object.defineProperty(o, key, {
        get: () => state[key],
        set: (x) => {
          log.push(`set ${label}.${key}@tx${transactions}${depth > 0 ? ":in" : ":out"}`);
          if ((key === "warping" && throwOn.warping?.includes(slot)) || (key === "warpMode" && throwOn.warpMode?.includes(slot))) {
            throw new Error(`${key} refused on ${label}`);
          }
          if (key === "warping" && state.warping === true && x === false) {
            if (!loses) convert((b) => beatToSec(state.warpMarkers as WarpPoint[], b));
            state.looping = false;
          }
          if (key === "looping" && x === true && state.warping === false) {
            state.warping = true;
            convert((t) => secToBeat(state.warpMarkers as WarpPoint[], t));
          }
          state[key] = x;
        },
        enumerable: true,
      });
    }
    objs.push(o);
    return o;
  };
  const slots: { createAudioClip: ReturnType<typeof vi.fn> }[] = [];
  const created: Array<{ slot: number; clip: Record<string, unknown> }> = [];
  const concurrency = { inFlight: 0, max: 0, calls: 0 };
  const makeSlot = (i: number) => ({
    createAudioClip: vi.fn(async (args: { isWarped?: boolean }) => {
      concurrency.calls++;
      concurrency.max = Math.max(concurrency.max, ++concurrency.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      concurrency.inFlight--;
      const { loopSettings } = args as { loopSettings?: Record<string, unknown> };
      const parkedCall = args?.isWarped === true && loopSettings?.looping === false;
      if ((parkedCall && throwOn.parkedCreate?.includes(i)) || (args?.isWarped === false && throwOn.plainCreate?.includes(i))) {
        log.push(`refused create slot ${i}${args?.isWarped === false ? " unwarped" : ""}`);
        throw new Error(`create refused in slot ${i}`);
      }
      log.push(`create slot ${i}${args?.isWarped === false ? " unwarped" : ""}`);
      const clip = mk(`clip${i}`, { ...loopSettings, warping: args?.isWarped !== false, warpMarkers: args?.isWarped ? (liveGrid ?? []) : [] }, unwarp === "loses" || losesIn.includes(i), i);
      created.push({ slot: i, clip });
      return clip;
    }),
    deleteClip: vi.fn(async () => {
      log.push(`delete slot ${i}`);
    }),
  });
  // Source scene 2 plus a few existing scenes below it.
  const inTrack = [0, 1, 2, 3].map(makeSlot) as unknown[];
  // As the SDK's getter: each read is a copy, and a slot already read stays on its own scene when scenes go in above it.
  const track = {
    get clipSlots() {
      return [...inTrack];
    },
  };
  slots.push(...(track.clipSlots as typeof slots));
  const song = {
    createScene: vi.fn(async (index: number) => {
      await Promise.resolve();
      log.push(`create scene ${index}`);
      inTrack.splice(index, 0, makeSlot(index));
      return mk(`scene${index}`);
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
  /** The clip each slot holds at the end (the last one created there). */
  const inSlot = (i: number) => created.filter((c) => c.slot === i).at(-1)?.clip;
  return { log, context, song, track, objs, concurrency, inSlot };
}

describe("sessionOps clamping (R17)", () => {
  const overshoot: Section[] = [
    { start: 0, end: 10, label: "A", color: 1 },
    { start: 10, end: 20, label: "B", color: 2 },
    { start: 20, end: 32.00000645885468, label: "C", color: 3 },
  ];
  const lastClip = (ops: SessionOp[]) => ops[ops.length - 1] as Extract<SessionOp, { kind: "slotClip" }>;

  it("snaps the last warped slice to info.endMarker", () => {
    const ops = sessionOps(info({ startMarker: 0, endMarker: 64 }), overshoot, 120);
    expect(lastClip(ops).loop.endMarker).toBe(64);
    expect(lastClip(ops).loop.loopEnd).toBe(64);
  });

  it("clamps unwarped markers (seconds) to info.endMarker", () => {
    const ops = sessionOps(info({ warped: false, startMarker: 0, endMarker: 32 }), overshoot, 120);
    expect(lastClip(ops).loop.endMarker).toBe(32);
  });
});

describe("executeSession", () => {
  const ops: SessionOp[] = sessionOps(info(), sections, 120);

  it("creates scenes in ascending order, then slot clips, then sets names/colors in one sync transaction", async () => {
    const f = makeFakes();
    await executeSession(f.context as never, info({ track: f.track as never, warpMode: 2 as never }), ops);
    const creates = f.log.filter((l) => l.startsWith("create"));
    expect(creates).toEqual([
      "create scene 3",
      "create scene 4",
      "create scene 5",
      "create slot 3",
      "create slot 4",
      "create slot 5",
    ]);
    expect(f.song.createScene.mock.calls.map((c) => c[0])).toEqual([3, 4, 5]);
    const sets = f.log.filter((l) => l.startsWith("set "));
    expect(sets).toHaveLength(3 + 9); // 3 scene names; 3 clip names, colors, warp modes
    expect(sets.every((s) => s.endsWith(":in"))).toBe(true);
    expect(new Set(sets.map((s) => s.match(/@tx(\d+)/)![1])).size).toBe(1);
    // All sets come after all creates.
    const lastCreate = f.log.map((l) => l.startsWith("create")).lastIndexOf(true);
    expect(f.log.findIndex((l) => l.startsWith("set "))).toBeGreaterThan(lastCreate);
  });

  it("puts each slice in the new scene named for it, not in the scenes those pushed down", async () => {
    const f = makeFakes();
    const below = f.track.clipSlots[3] as { createAudioClip: ReturnType<typeof vi.fn> };
    await executeSession(f.context as never, info({ track: f.track as never }), ops);
    expect(f.track.clipSlots[6]).toBe(below);
    expect(below.createAudioClip).not.toHaveBeenCalled();
    for (const i of [3, 4, 5]) {
      expect((f.track.clipSlots[i] as { createAudioClip: ReturnType<typeof vi.fn> }).createAudioClip).toHaveBeenCalledOnce();
    }
  });

  it("passes file, warping and loop settings; never touches the source slot", async () => {
    const f = makeFakes();
    const source = f.track.clipSlots[2] as { createAudioClip: ReturnType<typeof vi.fn> };
    await executeSession(f.context as never, info({ track: f.track as never }), ops);
    expect(source.createAudioClip).not.toHaveBeenCalled();
    const slot4 = f.track.clipSlots[4] as { createAudioClip: ReturnType<typeof vi.fn> };
    expect(slot4.createAudioClip).toHaveBeenCalledWith({
      filePath: "/samples/a.wav",
      isWarped: true,
      loopSettings: loop(24, 44, true),
    });
  });

  it("copies the source warp mode onto warped slices, in the finalizer transaction", async () => {
    const f = makeFakes();
    await executeSession(f.context as never, info({ track: f.track as never, warpMode: 4 as never }), ops);
    expect(f.objs.filter((o) => o.warpMode !== undefined).map((o) => o.warpMode)).toEqual([4, 4, 4]);
    expect(f.log.filter((l) => l.includes(".warpMode")).every((l) => l.endsWith(":in"))).toBe(true);
  });

  it("does not set warpMode on unwarped slices", async () => {
    const f = makeFakes();
    const uw = info({ track: f.track as never, warped: false, warpMode: 4 as never });
    await executeSession(f.context as never, uw, sessionOps(uw, sections, 120));
    expect(f.objs.some((o) => o.warpMode !== undefined)).toBe(false);
  });

  it("applies scene names and clip names/colors", async () => {
    const f = makeFakes();
    await executeSession(f.context as never, info({ track: f.track as never }), ops);
    expect(f.objs.map((o) => o.name)).toEqual(expect.arrayContaining(["Cue 1", "Cue 2", "Cue 3"]));
    expect(f.objs.filter((o) => o.color !== undefined).map((o) => o.color)).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
  });
});

// fb3, item 1 (Matt): a Session clip warped at 150 BPM, song at 150; the slices came out warped at 120.00 BPM, so
// they played back fast. Live gives a clip it creates from the file its own warp grid, and the SDK cannot set markers.
describe("a warped Session source with its own warp markers (fb3)", () => {
  const at150 = [
    { beatTime: 0, sampleTime: 0 },
    { beatTime: 1, sampleTime: 0.4 },
  ];
  const at120 = [
    { beatTime: 0, sampleTime: 0 },
    { beatTime: 1, sampleTime: 0.5 },
  ];
  // Beats 4..64 at 150 BPM are 1.6..25.6 s of the file. The render is unwarped from 1.6 s, so the sections are file
  // seconds from there: 0..10, 10..20, 20..24.
  const fileSections: Section[] = [
    { start: 0, end: 10, label: "Cue 1", color: 0xff0000 },
    { start: 10, end: 20, label: "Cue 2", color: 0x00ff00 },
    { start: 20, end: 24, label: "Cue 3", color: 0x0000ff },
  ];
  const src = (over: Partial<ClipInfo> = {}) => info({ warpMarkers: at150, warpMode: 4 as never, ...over });
  const slotClips = (ops: SessionOp[]) => ops.filter((o): o is Extract<SessionOp, { kind: "slotClip" }> => o.kind === "slotClip");

  for (const tempo of [150, 120]) {
    it(`slices at the source's own beats, through its warp markers, with the song at ${tempo}`, () => {
      const clips = slotClips(sessionOps(src(), fileSections, tempo));
      // 1.6 + 10 = 11.6 s is beat 29 at 150 BPM; 21.6 s is beat 54. The song tempo plays no part.
      const edges = [clips[0].loop.startMarker, ...clips.map((c) => c.loop.endMarker)];
      expect(edges[0]).toBe(4);
      expect(edges[1]).toBeCloseTo(29, 9);
      expect(edges[2]).toBeCloseTo(54, 9);
      expect(edges[3]).toBe(64);
      expect(clips.every((c) => c.isWarped && c.loop.looping)).toBe(true);
      // The same slices as unwarped clips, in file seconds.
      expect(clips.map((c) => [c.unwarped!.startMarker, c.unwarped!.endMarker])).toEqual([
        [expect.closeTo(1.6, 9), expect.closeTo(11.6, 9)],
        [expect.closeTo(11.6, 9), expect.closeTo(21.6, 9)],
        [expect.closeTo(21.6, 9), expect.closeTo(25.6, 9)],
      ]);
      expect(clips.every((c) => c.unwarped!.looping === false && c.unwarped!.loopStart === c.unwarped!.startMarker)).toBe(true);
    });
  }

  it("a source without warp markers, or unwarped, has no unwarped variant (as before)", () => {
    expect(slotClips(sessionOps(info(), sections, 120)).some((c) => c.unwarped)).toBe(false);
    expect(slotClips(sessionOps(info({ warped: false, warpMarkers: at150 }), sections, 120)).some((c) => c.unwarped)).toBe(false);
  });

  it("Live warps the new clip at 120: the first slice is replaced, and every slice plays unwarped (fb4: parked)", async () => {
    const f = makeFakes(at120);
    const i = src({ track: f.track as never });
    await executeSession(f.context as never, i, sessionOps(i, fileSections, 150));
    // fb4, item 3: each slice is made warped on Live's grid (the region in its beats), then switched to unwarped.
    expect(f.log.filter((l) => l.startsWith("create slot") || l.startsWith("delete"))).toEqual([
      "create slot 3",
      "delete slot 3",
      "create slot 3",
      "create slot 4",
      "create slot 5",
    ]);
    const slot4 = f.track.clipSlots[4] as { createAudioClip: ReturnType<typeof vi.fn> };
    const args = slot4.createAudioClip.mock.calls[0][0] as { isWarped: boolean; loopSettings: ClipLoopSettings };
    // 11.6..21.6 s of the file on Live's 120 BPM grid (0.5 s a beat) are beats 23.2..43.2.
    expect(args.isWarped).toBe(true);
    expect(args.loopSettings).toEqual({
      startMarker: expect.closeTo(23.2, 9),
      endMarker: expect.closeTo(43.2, 9),
      loopStart: expect.closeTo(23.2, 9),
      loopEnd: expect.closeTo(43.2, 9),
      looping: false,
    });
    // Each ends up unwarped at the slice's file seconds, as the plain unwarped slices were.
    const ends = [3, 4, 5].map((k) => f.inSlot(k)!);
    expect(ends.every((c) => c.warping === false && c.looping === false)).toBe(true);
    expect(ends.map((c) => [c.startMarker, c.endMarker])).toEqual([
      [expect.closeTo(1.6, 9), expect.closeTo(11.6, 9)],
      [expect.closeTo(11.6, 9), expect.closeTo(21.6, 9)],
      [expect.closeTo(21.6, 9), expect.closeTo(25.6, 9)],
    ]);
    // The first is unwarped (and checked) at once; the others in the one finalizer transaction, with the names.
    // fb4 review M2: the first slice's two setters (warp mode, warping) are one transaction, so one undo step.
    expect(f.log.filter((l) => l.includes(".warping") || l.includes("clip3.warpMode"))).toEqual([
      "set clip3.warpMode@tx1:in",
      "set clip3.warping@tx1:in",
      "set clip4.warping@tx2:in",
      "set clip5.warping@tx2:in",
    ]);
    // Names, colours, and the source's warp mode for when Live warps them again.
    expect(f.objs.filter((o) => o.color !== undefined).map((o) => o.color)).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    expect(ends.map((c) => c.warpMode)).toEqual([4, 4, 4]);
  });

  it("fb4: turning Loop on a parked slice warps it back onto Live's grid with the slice as its loop: the place is kept", async () => {
    const f = makeFakes(at120);
    const i = src({ track: f.track as never });
    await executeSession(f.context as never, i, sessionOps(i, fileSections, 150));
    const c = f.inSlot(4)!;
    c.looping = true; // what Matt does in Live
    expect(c.warping).toBe(true);
    expect([c.startMarker, c.endMarker, c.loopStart, c.loopEnd].map((x) => Math.round((x as number) * 1e6) / 1e6)).toEqual([23.2, 43.2, 23.2, 43.2]);
    // Beat 23.2 on its kept grid is 11.6 s of the file: the slice's own start, not the file's.
    expect(beatToSec(c.warpMarkers as WarpPoint[], c.startMarker as number)).toBeCloseTo(11.6, 9);
  });

  it("fb4: a Live that does not keep the place when unwarping: the first parked slice is replaced, the rest are plain unwarped", async () => {
    const f = makeFakes(at120, "loses");
    const i = src({ track: f.track as never });
    await executeSession(f.context as never, i, sessionOps(i, fileSections, 150));
    expect(f.log.filter((l) => l.startsWith("create slot") || l.startsWith("delete"))).toEqual([
      "create slot 3",
      "delete slot 3",
      "create slot 3",
      "delete slot 3",
      "create slot 3 unwarped",
      "create slot 4 unwarped",
      "create slot 5 unwarped",
    ]);
    const slot4 = f.track.clipSlots[4] as { createAudioClip: ReturnType<typeof vi.fn> };
    const args = slot4.createAudioClip.mock.calls[0][0] as { isWarped: boolean; loopSettings: ClipLoopSettings };
    expect(args).toMatchObject({ isWarped: false, loopSettings: { startMarker: expect.closeTo(11.6, 9), endMarker: expect.closeTo(21.6, 9), looping: false } });
    expect(f.objs.filter((o) => o.color !== undefined).map((o) => o.color)).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    expect([3, 4, 5].every((k) => f.inSlot(k)!.warpMode === undefined)).toBe(true);
  });

  it("fb4: a later parked slice Live got wrong is made again as a plain unwarped clip", async () => {
    const f = makeFakes(at120, "keeps", [5]); // Live keeps the place on slot 3's and 4's slices, not on slot 5's
    const i = src({ track: f.track as never });
    const slot5 = () => f.track.clipSlots[5] as { createAudioClip: ReturnType<typeof vi.fn> };
    await executeSession(f.context as never, i, sessionOps(i, fileSections, 150));
    expect(f.log.filter((l) => l.startsWith("create slot 5") || l.startsWith("delete slot 5"))).toEqual(["create slot 5", "delete slot 5", "create slot 5 unwarped"]);
    expect(slot5().createAudioClip.mock.calls[1][0]).toMatchObject({ isWarped: false, loopSettings: { startMarker: expect.closeTo(21.6, 9) } });
    expect(f.inSlot(5)!.name).toBe("Cue 3");
    expect(f.inSlot(5)!.color).toBe(0x0000ff);
  });

  // fb4 review I2: a parked create or unwarp that throws must not leave Apply half-made. Every slot ends as a named,
  // coloured, unwarped clip at the slice's file seconds (the plain path that existed before parking).
  describe("a parking step that throws (fb4 review I2)", () => {
    const FILE_SECONDS = [
      [1.6, 11.6],
      [11.6, 21.6],
      [21.6, 25.6],
    ];
    const run = async (throwOn: Throws, unwarp: "keeps" | "loses" = "keeps") => {
      const f = makeFakes(at120, unwarp, [], throwOn);
      const i = src({ track: f.track as never });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      let logged: string[] = [];
      try {
        await executeSession(f.context as never, i, sessionOps(i, fileSections, 150));
      } finally {
        logged = err.mock.calls.map((c) => c.join(" "));
        err.mockRestore();
      }
      return { f, logged };
    };
    /** Every slot holds a named, coloured clip, unwarped, at the slice's file seconds. */
    const expectAllRight = (f: ReturnType<typeof makeFakes>) => {
      const ends = [3, 4, 5].map((k) => f.inSlot(k)!);
      expect(ends.map((c) => c.name)).toEqual(["Cue 1", "Cue 2", "Cue 3"]);
      expect(ends.map((c) => c.color)).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
      expect(ends.every((c) => c.warping === false)).toBe(true);
      expect(ends.map((c) => [c.startMarker, c.endMarker])).toEqual(FILE_SECONDS.map(([a, b]) => [expect.closeTo(a, 9), expect.closeTo(b, 9)]));
    };

    it("the first slice's parked create rejects: it is made plain unwarped, and parking stops for the rest", async () => {
      const { f, logged } = await run({ parkedCreate: [3] });
      expectAllRight(f);
      expect(f.log.filter((l) => l.includes("slot"))).toEqual([
        "create slot 3",
        "delete slot 3",
        "refused create slot 3",
        "create slot 3 unwarped",
        "create slot 4 unwarped",
        "create slot 5 unwarped",
      ]);
      expect(logged.join("\n")).toMatch(/park/i);
    });

    it("a later slice's parked create rejects: that slice is plain unwarped, the others stay parked", async () => {
      const { f, logged } = await run({ parkedCreate: [4] });
      expectAllRight(f);
      expect(f.log.filter((l) => l.startsWith("create slot 4") || l.startsWith("refused"))).toEqual(["refused create slot 4", "create slot 4 unwarped"]);
      // Slice 3 was parked and checked; the rest of the run is plain once one parked create has failed.
      expect(f.log.filter((l) => l.startsWith("create slot 5"))).toEqual(["create slot 5 unwarped"]);
      expect(logged.join("\n")).toMatch(/slot 4|slice 2|Cue 2/i);
    });

    it("the first slice's warping = false throws while checking it: it is replaced by a plain unwarped clip", async () => {
      const { f } = await run({ warping: [3] });
      expectAllRight(f);
    });

    it("a later slice's warping = false throws in the finalizers: the names and colours still apply, and read-back repairs it", async () => {
      const { f, logged } = await run({ warping: [4] });
      expectAllRight(f);
      expect(f.log.filter((l) => l.startsWith("create slot 4") || l.startsWith("delete slot 4"))).toEqual(["create slot 4", "delete slot 4", "create slot 4 unwarped"]);
      // The slice after it was still parked and unwarped in the same transaction.
      expect(f.log.filter((l) => l.startsWith("create slot 5"))).toEqual(["create slot 5"]);
      expect(logged.join("\n")).toMatch(/warping/);
    });

    it("a later slice's warpMode throws in the finalizers: it is still unwarped and parked, and every name applies", async () => {
      const { f, logged } = await run({ warpMode: [4] });
      expectAllRight(f);
      expect(f.log.filter((l) => l.startsWith("delete slot 4"))).toEqual([]);
      expect(logged.join("\n")).toMatch(/warpMode/);
    });

    it("a plain create that fails after the parked ones were made: the slices already made are still named and unwarped, and the error is rethrown", async () => {
      const f = makeFakes(at120, "keeps", [], { parkedCreate: [5], plainCreate: [5] });
      const i = src({ track: f.track as never });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(executeSession(f.context as never, i, sessionOps(i, fileSections, 150))).rejects.toThrow(/create refused in slot 5/);
      err.mockRestore();
      for (const k of [3, 4]) {
        const c = f.inSlot(k)!;
        expect(c.warping).toBe(false);
        expect(c.name).toBe(k === 3 ? "Cue 1" : "Cue 2");
      }
      expect(f.objs.filter((o) => typeof o.name === "string").map((o) => o.name)).toEqual(expect.arrayContaining(["Cue 1", "Cue 2"]));
    });

    it("the read-back repair runs even when the finalizer transaction itself throws", async () => {
      const f = makeFakes(at120);
      const i = src({ track: f.track as never });
      const tx = f.context.withinTransaction;
      // Refuse the finalizer transaction: the one that comes once the last slice has been made.
      f.context.withinTransaction = <T,>(fn: () => T): T => {
        if (f.inSlot(5)) throw new Error("transaction refused");
        return tx(fn);
      };
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(executeSession(f.context as never, i, sessionOps(i, fileSections, 150))).rejects.toThrow(/transaction refused/);
      err.mockRestore();
      // Slices 4 and 5 were parked and never unwarped: read-back remade them plain, unwarped, at the right seconds.
      for (const [k, [a, b]] of [[4, FILE_SECONDS[1]], [5, FILE_SECONDS[2]]] as const) {
        const c = f.inSlot(k)!;
        expect(c.warping).toBe(false);
        expect(c.startMarker).toBeCloseTo(a, 9);
        expect(c.endMarker).toBeCloseTo(b, 9);
      }
    });
  });

  it("fb4: the region on the warped path is the slice too, and it loops", () => {
    const clips = slotClips(sessionOps(src(), fileSections, 150));
    expect(clips.every((c) => c.loop.loopStart === c.loop.startMarker && c.loop.loopEnd === c.loop.endMarker && c.loop.looping)).toBe(true);
  });

  it("Live gives the new clip the source's own grid: every slice stays warped, with the source's warp mode", async () => {
    const f = makeFakes([...at150, { beatTime: 64, sampleTime: 25.6 }]);
    const i = src({ track: f.track as never });
    await executeSession(f.context as never, i, sessionOps(i, fileSections, 120));
    expect(f.log.filter((l) => l.startsWith("create slot") || l.startsWith("delete"))).toEqual(["create slot 3", "create slot 4", "create slot 5"]);
    const slot4 = f.track.clipSlots[4] as { createAudioClip: ReturnType<typeof vi.fn> };
    expect(slot4.createAudioClip.mock.calls[0][0]).toMatchObject({ isWarped: true, loopSettings: { looping: true } });
    expect(f.objs.filter((o) => o.warpMode !== undefined).map((o) => o.warpMode)).toEqual([4, 4, 4]);
  });
});

describe("executeSession ordering", () => {
  it("creates slot clips one at a time", async () => {
    const f = makeFakes();
    await executeSession(f.context as never, info({ track: f.track as never }), sessionOps(info(), sections, 120));
    expect(f.concurrency.max).toBe(1);
    expect(f.concurrency.calls).toBe(3);
  });
});

describe("parkedRegion (fb4, item 3)", () => {
  const at120 = [
    { beatTime: 0, sampleTime: 0 },
    { beatTime: 1, sampleTime: 0.5 },
  ];
  const file = (a: number, b: number) => ({ startMarker: a, endMarker: b, loopStart: a, loopEnd: b, looping: false });
  it("the slice's file seconds as beats on Live's grid, loop region the same, not looping", () => {
    expect(parkedRegion(file(11.6, 21.6), at120)).toEqual({ startMarker: 23.2, endMarker: 43.2, loopStart: 23.2, loopEnd: 43.2, looping: false });
  });
  it("none for a grid that maps nothing, or under the SDK's shortest loop", () => {
    expect(parkedRegion(file(1, 2), [])).toBeNull();
    expect(parkedRegion(file(1, 1.1), at120)).toBeNull(); // 0.2 beats
  });
});

describe("sessionOps marker keys (v2)", () => {
  it("scene names carry the sure key after the repeat number; the clips keep their plain labels", () => {
    const repeated: Section[] = [
      { start: 0, end: 10, label: "A - verse", color: 1 },
      { start: 10, end: 20, label: "B - chorus", color: 2 },
      { start: 20, end: 30, label: "A - verse", color: 1 },
    ];
    const ops = sessionOps(info(), repeated, 120, ["Dm", null, "Dm"]);
    expect(ops.filter((o) => o.kind === "scene").map((o) => (o as { name: string }).name)).toEqual([
      "A - verse · Dm",
      "B - chorus",
      "A - verse 2 · Dm",
    ]);
    expect(ops.filter((o) => o.kind === "slotClip").map((o) => (o as { name: string }).name)).toEqual(["A - verse", "B - chorus", "A - verse"]);
  });
});
