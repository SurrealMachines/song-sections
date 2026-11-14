import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CELL_RATE, PATTERN_ENGINE, PATTERN_LEVELS, encodeInt8, sourceKind } from "./contract.js";
import type { GridBar, Marker, PatternFeatures, PatternSource, Span } from "./contract.js";
import { KEPT_SECTIONS, createPatternEngine, sectionSpans, type PatternEngine, type PatternSlice } from "./engine.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { fakePatternFeatures } from "./fake.js";
import { cellExtractor } from "./features.js";
import { NO_EDITS, insertCut, renamePattern } from "./lane.js";
import { sectionCuts } from "./split.js";
import { renderSong, type SynthSong } from "./synth.js";
import { bleed, genericBar, randomFeatures, twoBarIdea } from "../test/patternSongs.js";

// a pass-through spy, so the tests can see which sections the engine splits
vi.mock("./split.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./split.js")>();
  return { ...real, sectionCuts: vi.fn(real.sectionCuts) };
});
const splitCalls = vi.mocked(sectionCuts);

/** Features of songs rendered per source, all cut to `durationSec`, on `grid` (the first song's true bars if none). */
function features(songs: Partial<Record<PatternSource, SynthSong>>, durationSec?: number, grid?: GridBar[]): PatternFeatures {
  const out: PatternFeatures["sources"] = {};
  let bars: GridBar[] = [];
  let dur = durationSec ?? Infinity;
  for (const [src, song] of Object.entries(songs) as [PatternSource, SynthSong][]) {
    const r = renderSong(song);
    const end = r.x.length / r.rate;
    dur = Math.min(dur, end);
    if (bars.length === 0) bars = r.downbeats.map((start, i) => ({ start, end: r.downbeats[i + 1] ?? end, unsure: false }));
    const ex = cellExtractor(sourceKind(src), r.rate);
    ex.push(r.x.subarray(0, Math.round(dur * r.rate)));
    out[src] = ex.finish();
  }
  const g = grid ?? bars.filter((b) => b.start < dur - 1e-9).map((b) => ({ ...b, end: Math.min(dur, b.end) }));
  return { engine: PATTERN_ENGINE, rate: CELL_RATE, durationSec: dur, grid: g, sources: out };
}

/** Interior section boundaries as markers, ids from 1. */
const markersAt = (sections: Span[]): Marker[] => sections.slice(1).map((s, i) => ({ id: i + 1, time: s.start }));

function expectTiles(slices: PatternSlice[], durationSec: number) {
  expect(slices[0].start).toBe(0);
  expect(slices.at(-1)!.end).toBe(durationSec);
  for (let i = 1; i < slices.length; i++) expect(slices[i].start, `slice ${i}`).toBe(slices[i - 1].end);
  for (const s of slices) expect(s.end).toBeGreaterThan(s.start);
}

// genericBar: A×4 | G×4 | B×4 | G×4 | A×4 | B B B N as other; twoBarIdea three times over as drums
const gb = genericBar();
const drums: SynthSong = { bpm: 120, bars: Array.from({ length: 3 }, () => twoBarIdea().song.bars).flat() };
let shared: { engine: PatternEngine; f: PatternFeatures } | undefined;
function song() {
  shared ??= (() => {
    const f = features({ other: gb.song, drums });
    return { engine: createPatternEngine(f), f };
  })();
  return shared;
}
const markers = markersAt(gb.sections);
const A_SECTIONS = [0, 4];
const B_SECTIONS = [2, 5];
const inSection = (s: Span, k: number) => s.start >= gb.sections[k].start - 1e-9 && s.end <= gb.sections[k].end + 1e-9;

describe("createPatternEngine", () => {
  it("lists the sources present, in PATTERN_SOURCES order, and the features' grid", () => {
    const { engine, f } = song();
    expect(engine.sources).toEqual(["drums", "other"]);
    expect(engine.grid).toEqual(f.grid);
  });

  it("gives one slice per section at level 0, cut at the markers", () => {
    const { engine } = song();
    const slices = engine.lane("other", markers, 0, NO_EDITS);
    expect(slices.map((s) => ({ start: s.start, end: s.end }))).toEqual(gb.sections);
    expect(slices[0].cut).toBeNull();
    expect(slices.slice(1).map((s) => s.cut)).toEqual(markers.map((m) => ({ time: m.time, owner: "marker", markerId: m.id })));
  });

  it("names A sections' level-1 slices alike, and never like a B section's", () => {
    const { engine } = song();
    const slices = engine.lane("other", markers, 1, NO_EDITS);
    const inA = slices.filter((s) => A_SECTIONS.some((k) => inSection(s, k)));
    const inB = slices.filter((s) => B_SECTIONS.some((k) => inSection(s, k)));
    expect(inA.length).toBeGreaterThan(A_SECTIONS.length); // level 1 splits the A sections
    const byLength = new Map<number, Set<number | null>>();
    for (const s of inA) byLength.set(s.end - s.start, (byLength.get(s.end - s.start) ?? new Set()).add(s.name.pattern));
    for (const [len, bases] of byLength) {
      expect([...bases], `A's ${len} s slices`).toHaveLength(1);
      expect([...bases][0], `A's ${len} s slices`).not.toBeNull();
    }
    const aBases = new Set(inA.map((s) => s.name.pattern));
    for (const s of inB) expect(aBases.has(s.name.pattern), `B slice at ${s.start}`).toBe(false);
  });

  it("tiles [0, durationSec] exactly at every level, with labels from the names", () => {
    const { engine, f } = song();
    for (const src of engine.sources) {
      for (let level = 0; level <= PATTERN_LEVELS; level++) {
        const slices = engine.lane(src, markers, level, NO_EDITS);
        expectTiles(slices, f.durationSec);
        for (const s of slices) expect(s.label).toBe(s.name.pattern === null ? null : `${s.name.pattern}${s.name.variant ? "′" : ""}`);
      }
    }
  });

  it("keeps the user's cut, and his renames", () => {
    const { engine } = song();
    const before = engine.lane("other", markers, 0, NO_EDITS);
    const cuts = before.slice(1).map((s) => s.cut!);
    const edits = insertCut(NO_EDITS, cuts, 13, 48);
    expect(edits.added).toEqual([13]);
    const after = engine.lane("other", markers, 0, edits);
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((s) => s.start === 13)?.cut).toEqual({ time: 13, owner: "user" });
    const first = after[0];
    const members = after.filter((s) => s.name.pattern === first.name.pattern);
    const renamed = engine.lane("other", markers, 0, renamePattern(edits, members, "Riff", first.label!));
    for (const s of renamed.filter((s) => s.name.pattern === first.name.pattern)) expect(s.label).toMatch(/^Riff′?$/);
  });

  it("gives [] for an unknown source, or one the features do not have", () => {
    const { engine } = song();
    expect(engine.lane("nope" as PatternSource, markers, 1, NO_EDITS)).toEqual([]);
    expect(engine.lane("bass", markers, 1, NO_EDITS)).toEqual([]);
    expect(engine.machineCuts("vocals", gb.sections, 1)).toEqual([]);
  });

  it("refuses a level outside 0 … PATTERN_LEVELS", () => {
    const { engine } = song();
    expect(() => engine.machineCuts("other", gb.sections, PATTERN_LEVELS + 1)).toThrow(RangeError);
    expect(() => engine.lane("other", markers, -1, NO_EDITS)).toThrow(RangeError);
  });

  it("splits each section once for all levels, and after a marker move only the two sections it touches", () => {
    const f = features({ other: gb.song });
    const engine = createPatternEngine(f);
    splitCalls.mockClear();
    engine.lane("other", markers, 1, NO_EDITS);
    expect(splitCalls).toHaveBeenCalledTimes(gb.sections.length);
    splitCalls.mockClear();
    for (let level = 0; level <= PATTERN_LEVELS; level++) engine.lane("other", markers, level, NO_EDITS);
    expect(splitCalls, "the slider recomputes nothing").not.toHaveBeenCalled();
    const moved = markers.map((m) => (m.id === 3 ? { ...m, time: 26 } : m));
    engine.lane("other", moved, 2, NO_EDITS);
    expect(splitCalls.mock.calls.map(([, , s]) => s)).toEqual([
      { start: 16, end: 26 },
      { start: 26, end: 32 },
    ]);
  });

  it("gives machineCuts at every level from machineLevels, splitting each section once", () => {
    const engine = createPatternEngine(features({ other: gb.song }));
    splitCalls.mockClear();
    const levels = engine.machineLevels("other", gb.sections);
    expect(splitCalls).toHaveBeenCalledTimes(gb.sections.length);
    expect(levels).toHaveLength(PATTERN_LEVELS + 1);
    for (let level = 0; level <= PATTERN_LEVELS; level++) expect(levels[level]).toEqual(engine.machineCuts("other", gb.sections, level));
    expect(engine.machineLevels("vocals", gb.sections)).toEqual(Array.from({ length: PATTERN_LEVELS + 1 }, () => []));
  });

  it("keeps the cuts of the KEPT_SECTIONS sections most recently split, and splits an older one again", () => {
    const engine = createPatternEngine(features({ other: gb.song }));
    const spans = Array.from({ length: KEPT_SECTIONS + 1 }, (_, k) => ({ start: 0, end: 10 + k / 10 }));
    splitCalls.mockClear();
    const first = engine.machineCuts("other", spans.slice(0, 1), 1);
    engine.machineCuts("other", spans.slice(1, KEPT_SECTIONS), 1);
    engine.machineCuts("other", spans.slice(0, 1), 1); // used again: now the most recent
    engine.machineCuts("other", spans.slice(KEPT_SECTIONS), 1); // one too many: the least recent goes
    expect(splitCalls).toHaveBeenCalledTimes(KEPT_SECTIONS + 1);
    engine.machineCuts("other", spans.slice(0, 1), 1);
    expect(splitCalls, "the first span is kept").toHaveBeenCalledTimes(KEPT_SECTIONS + 1);
    engine.machineCuts("other", spans.slice(1, 2), 1);
    expect(splitCalls, "the second span went").toHaveBeenCalledTimes(KEPT_SECTIONS + 2);
  });

  it("leaves out, with a warning, a source whose cells do not decode as its kind's, and goes on with the rest", () => {
    const f = features({ other: gb.song, drums, bass: gb.song });
    const other = f.sources.other!;
    const broken: PatternFeatures = {
      ...f,
      sources: {
        ...f.sources,
        drums: { ...f.sources.drums!, cells: f.sources.drums!.cells + 1 }, // its data no longer fills its cells
        bass: { ...other, kind: "tonal", dims: 3, data: encodeInt8(new Int8Array(other.cells * 3)) }, // a stale layout
      },
    };
    const warn = vi.fn();
    const engine = createPatternEngine(broken, { warn });
    expect(engine.sources).toEqual(["other"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([m]) => m).join("\n")).toMatch(/drums[\s\S]*bass|bass[\s\S]*drums/);
    expect(engine.lane("drums", markers, 1, NO_EDITS)).toEqual([]);
    const alone = createPatternEngine(features({ other: gb.song }));
    expect(engine.lane("other", markers, 1, NO_EDITS)).toEqual(alone.lane("other", markers, 1, NO_EDITS));
    expect(() => createPatternEngine(broken)).not.toThrow(); // no warn given: quietly
  });

  it("gates rests against the loudest source, not each source's own level", () => {
    const b = bleed();
    const engine = createPatternEngine(features({ other: b.loud, bass: b.bleed }));
    for (let level = 0; level <= PATTERN_LEVELS; level++) {
      expect(engine.lane("other", [], level, NO_EDITS).some((s) => s.label !== null)).toBe(true);
      for (const s of engine.lane("bass", [], level, NO_EDITS)) expect(s.label, `level ${level}`).toBeNull();
    }
  });

  it("gives one slice per section at every level, and no NaN, for 3 s on one 2 s bar (Review Focus 2)", () => {
    const short: SynthSong = { bpm: 120, bars: [twoBarIdea().song.bars[0], { ...twoBarIdea().song.bars[1], beats: 2 }] };
    for (const grid of [[{ start: 0, end: 2, unsure: false }], [{ start: 0, end: 2, unsure: false }, { start: 2, end: 3, unsure: true }]]) {
      const f = features({ other: short, drums: short, mix: short }, 3, grid);
      expect(f.durationSec).toBe(3);
      const engine = createPatternEngine(f);
      for (const ms of [[], [{ id: 1, time: 1.5 }]] as Marker[][]) {
        for (const src of engine.sources) {
          for (let level = 0; level <= PATTERN_LEVELS; level++) {
            const slices = engine.lane(src, ms, level, NO_EDITS);
            expect(slices, `${src} level ${level}`).toHaveLength(ms.length + 1);
            expectTiles(slices, 3);
            for (const s of slices) {
              for (const v of [s.start, s.end, s.name.pattern ?? 0]) expect(Number.isNaN(v)).toBe(false);
              expect(s.label ?? "").not.toContain("NaN");
            }
          }
        }
      }
    }
  });
});

describe("sectionSpans", () => {
  it("cuts [0, durationSec] at the markers in time order, ignoring any outside it", () => {
    const ms = [
      { id: 2, time: 20 },
      { id: 1, time: 10 },
      { id: 3, time: 0 },
      { id: 4, time: 30 },
      { id: 5, time: 20 },
    ];
    expect(sectionSpans(ms, 30)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]);
    expect(sectionSpans([], 30)).toEqual([{ start: 0, end: 30 }]);
  });
});

describe.skipIf(!process.env.SONG_SECTIONS_PERF)("speed", () => {
  const ms = (fn: () => void): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const allLanes = (engine: PatternEngine, markers: Marker[], level: number) => {
    for (const src of engine.sources) engine.lane(src, markers, level, NO_EDITS);
  };
  const evenMarkers = (n: number, durationSec: number): Marker[] =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, time: ((i + 1) * durationSec) / (n + 1) }));

  it("keeps the dialog live on 10 minutes with 19 markers", () => {
    const f = randomFeatures(600, 120, 1);
    const markers = evenMarkers(19, 600);
    let engine!: PatternEngine;
    const cold = ms(() => {
      engine = createPatternEngine(f);
      allLanes(engine, markers, 4);
    });
    expect(engine.sources).toHaveLength(5);

    const lane = engine.lane("other", markers, 4, NO_EDITS);
    const edits = insertCut(NO_EDITS, lane.slice(1).map((s) => s.cut!), 101, 600);
    expect(edits.added).toEqual([101]);
    const cut = ms(() => engine.lane("other", markers, 4, edits));

    allLanes(engine, markers, 1);
    const slider = ms(() => allLanes(engine, markers, 2));

    const moved = markers.map((m) => (m.id === 10 ? { ...m, time: m.time + 2 } : m));
    allLanes(engine, markers, 4);
    const move = ms(() => allLanes(engine, moved, 4));

    console.log(`10 min: cold ${cold.toFixed(0)} ms, insertCut ${cut.toFixed(1)} ms, level 1→2 ${slider.toFixed(1)} ms, marker ${move.toFixed(1)} ms`);
    expect(cold).toBeLessThan(300);
    expect(cut).toBeLessThan(30);
    expect(slider).toBeLessThan(50);
    expect(move).toBeLessThan(50);
  });

  // random cells never repeat, so no section splits and naming is barely measured: a repetitive 10-minute song too
  let repetitive: PatternFeatures;
  beforeAll(() => {
    repetitive = fakePatternFeatures(fakeStructureAnalysis(600));
  }, 60_000);

  it("keeps the dialog live on a repetitive 10-minute song, split down to bars", () => {
    const markers = evenMarkers(19, 600).map((m) => ({ ...m, time: 2 * Math.round(m.time / 2) })); // on bar lines
    let engine!: PatternEngine;
    const cold = ms(() => {
      engine = createPatternEngine(repetitive);
      allLanes(engine, markers, 4);
    });
    expect(engine.lane("drums", markers, 4, NO_EDITS).length).toBeGreaterThan(200);
    const at = (d: number) => markers.map((m) => (m.id === 10 ? { ...m, time: m.time + d } : m));
    const first = ms(() => allLanes(engine, at(2), 4));
    const later = [4, 6, 8].map((d) => ms(() => allLanes(engine, at(d), 4)));
    const slider = ms(() => allLanes(engine, at(8), 3));

    const laterText = later.map((t) => t.toFixed(0)).join("/");
    console.log(`repetitive 10 min: cold ${cold.toFixed(0)} ms, first marker move ${first.toFixed(0)} ms, later ${laterText} ms, level 4→3 ${slider.toFixed(0)} ms`);
    expect(cold).toBeLessThan(1000);
    expect(first).toBeLessThan(200);
    for (const t of later) expect(t).toBeLessThan(80);
    expect(slider).toBeLessThan(50);
  });

  // One section of a long clip (the Sections slider at its lowest, no markers, a 30-minute take): the split's work and
  // what the engine keeps grow with the section's bars, not with their pairs (final review C1).
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void; // a full collection, so heapUsed is what is still reachable
  const MB = 2 ** 20;
  for (const [durationSec, bound] of [
    [600, 1000],
    [1800, 3000],
  ] as const) {
    it(`does ${durationSec / 60} minutes in one section cold in under ${bound / 1000} s, keeping under 300 MB`, () => {
      const f = randomFeatures(durationSec, 120, 3);
      gc();
      const before = process.memoryUsage().heapUsed;
      let engine!: PatternEngine;
      const cold = ms(() => {
        engine = createPatternEngine(f);
        allLanes(engine, [], 4);
      });
      gc();
      const kept = (process.memoryUsage().heapUsed - before) / MB;
      expect(engine.sources).toHaveLength(5);
      console.log(`${durationSec / 60} min in one section: cold ${cold.toFixed(0)} ms, kept ${kept.toFixed(1)} MB`);
      expect(cold).toBeLessThan(bound);
      expect(kept).toBeLessThan(300);
    });
  }

  it("does 30 minutes cold in under 2 s (Review Focus 5)", () => {
    const f = randomFeatures(1800, 120, 2);
    const markers = markersAt(f.sections);
    const cold = ms(() => allLanes(createPatternEngine(f), markers, 4));
    console.log(`30 min, ${markers.length} markers: cold ${cold.toFixed(0)} ms`);
    expect(cold).toBeLessThan(2000);
  });
});
