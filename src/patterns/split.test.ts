import { describe, expect, it } from "vitest";
import { MIN_SECTION_SEC } from "../core/sections.js";
import { PATTERN_LEVELS, type GridBar, type SourceKind, type Span } from "./contract.js";
import { cellExtractor, decodeSource, type DecodedSource } from "./features.js";
import { patternGrid } from "./grid.js";
import { createSimilarity, sourceLevelDb, tuned, type Similarity } from "./similarity.js";
import { REPEAT_LAGS, barsCost, cutAlike, machineCuts, repeatLags, sectionCuts } from "./split.js";
import { renderSong, type BarScript, type SynthSong } from "./synth.js";
import {
  DRUM_JITTER,
  bleed,
  fourBarPhrase,
  genericBar,
  heldSound,
  irregularBar,
  leftoverPhrase,
  letteredPhrase,
  oddPhrase,
  played,
  playedPhrase,
  transposedRepeat,
  twoBarIdea,
} from "../test/patternSongs.js";

/** A song's cells (tonal unless said), the regular grid of its true downbeats, and its length. */
function render(song: SynthSong, kind: SourceKind = "tonal"): { src: DecodedSource; grid: GridBar[]; durationSec: number; beats: number[] } {
  const r = renderSong(song);
  const ex = cellExtractor(kind, r.rate);
  ex.push(r.x);
  const durationSec = r.x.length / r.rate;
  const grid = r.downbeats.map((start, i) => ({ start, end: r.downbeats[i + 1] ?? durationSec, unsure: false }));
  return { src: decodeSource(ex.finish()), grid, durationSec, beats: r.beats };
}

/** createSimilarity on a song's own grid, referenced to its own level. */
function selfSimilarity(song: SynthSong, kind: SourceKind = "tonal"): { sim: Similarity; grid: GridBar[] } {
  const { src, grid } = render(song, kind);
  return { sim: createSimilarity(src, grid, { referenceDb: sourceLevelDb(src, grid) }), grid };
}

/** The bar counts of the pieces that `cuts` (seconds, on 2 s bars) make of a section of n bars from 0. */
function partLengths(cuts: number[], n: number): number[] {
  const at = [0, ...cuts.map((c) => c / 2), n];
  return at.slice(1).map((b, i) => b - at[i]);
}

/** The pieces a section's cuts make. */
function pieces(section: Span, cuts: number[]): Span[] {
  const at = [section.start, ...cuts, section.end];
  return at.slice(1).map((end, i) => ({ start: at[i], end }));
}

function expectMonotone(levels: number[][]) {
  expect(levels).toHaveLength(PATTERN_LEVELS + 1);
  expect(levels[0]).toEqual([]);
  for (let k = 0; k < PATTERN_LEVELS; k++) {
    for (const c of levels[k]) expect(levels[k + 1], `level ${k} cut ${c} is kept at level ${k + 1}`).toContain(c);
  }
}

describe("sectionCuts", () => {
  it("cuts twoBarIdea into its four 2-bar ideas, and leaves each X Y whole", () => {
    const { song, sections } = twoBarIdea();
    const { sim, grid } = selfSimilarity(song);
    const cuts = sectionCuts(sim, grid, sections[0]);
    expect(cuts[1]).toEqual([4, 8, 12]);
    expect(cuts[2]).toEqual(cuts[1]);
  });

  it("cuts fourBarPhrase into four 4-bar phrases, not sixteen similar bars, and splits each phrase alike", () => {
    const { song, sections } = fourBarPhrase();
    const { sim, grid } = selfSimilarity(song);
    const cuts = sectionCuts(sim, grid, sections[0]);
    expect(cuts[1]).toEqual([8, 16, 24]);
    const phrases = pieces(sections[0], cuts[1]);
    for (let k = 2; k <= PATTERN_LEVELS; k++) {
      const offsets = phrases.map((p) => cuts[k].filter((c) => c > p.start && c < p.end).map((c) => c - p.start));
      for (const o of offsets.slice(1)) expect(o, `level ${k}`).toEqual(offsets[0]);
    }
  });

  // Matt: "Pattern finder should be smart enough to find 3, 5 and 6 bar repetitions"
  it.each([
    [3, 2],
    [3, 4],
    [5, 2],
    [5, 3],
    [6, 2],
    [6, 3],
  ])("cuts a phrase of %i different bars played %i times into its phrases, at every level", (bars, times) => {
    const { song, sections } = oddPhrase(bars, times);
    const { sim, grid } = selfSimilarity(song);
    const levels = sectionCuts(sim, grid, sections[0]);
    const phrases = Array.from({ length: times - 1 }, (_, k) => 2 * bars * (k + 1));
    for (let level = 1; level <= PATTERN_LEVELS; level++) expect(levels[level], `level ${level}`).toEqual(phrases);
  });

  // review 1: a steady loop has no 3-, 5- or 6-bar phrase in it, at any length of section
  it.each([12, 18, 30])("counts a steady 1-bar loop of %i bars in 1, 2, 4 or 8 bars, never 3, 5 or 6", (n) => {
    const { sim, grid } = selfSimilarity(oddPhrase(1, n).song);
    const levels = sectionCuts(sim, grid, { start: 0, end: 2 * n });
    expect(levels[1].length).toBeGreaterThan(0);
    for (const cuts of levels.slice(1)) expect(partLengths(cuts, n).filter((b) => ![1, 2, 4, 8].includes(b)), JSON.stringify(cuts)).toEqual([]);
  });

  // re-review 1: a tag bar or a new idea inside a phrase keeps the phrase; only a loop is counted in 1, 2, 4 or 8 bars
  it.each([
    ["AAAAB", 4],
    ["ABABAC", 4],
    ["AAAAAB", 3],
  ] as const)("keeps %s, played %i times, as its phrases: a tag or a new idea is no loop", (phrase, times) => {
    const { song, sections } = letteredPhrase(phrase, times);
    const { sim, grid } = selfSimilarity(song);
    const L = phrase.length;
    expect(sectionCuts(sim, grid, sections[0])[1]).toEqual(Array.from({ length: times - 1 }, (_, k) => 2 * L * (k + 1)));
  });

  // fix round 3: two takes of a 5-bar phrase that differ at the end (Flim's D) repeat neither a bar on nor one take on,
  // only two takes on: that is no loop at 1 bar, and keeps its 5-bar parts
  it.each(["ABACDABACE", "ABCDEABCFG", "ABCDEAFGHE"])("keeps %s, twice, in 5-bar parts: music new a bar on is no loop", (phrase) => {
    const { song, sections } = letteredPhrase(phrase, 2);
    const { sim, grid } = selfSimilarity(song);
    expect(sectionCuts(sim, grid, sections[0])[1]).toEqual([10, 20, 30]);
  });

  it("keeps the bars before a phrase as one leftover, longer than the phrase: 6 + 5 + 5 (Flim's Instrumental 1)", () => {
    const { song, sections } = leftoverPhrase();
    const { sim, grid } = selfSimilarity(song);
    expect(sectionCuts(sim, grid, sections[0])[1]).toEqual([12, 22]);
  });

  it("cuts a phrase played four times, never quite the same, into its four 4-bar phrases, each left whole", () => {
    const { song, sections } = playedPhrase();
    const { sim, grid } = selfSimilarity(song);
    const levels = sectionCuts(sim, grid, sections[0]);
    expectMonotone(levels);
    for (let level = 1; level <= PATTERN_LEVELS; level++) expect(levels[level], `level ${level}`).toEqual([8, 16, 24]);
  });

  it("cuts a four-on-the-floor beat, which repeats every beat, into parts", () => {
    const hits: BarScript["hits"] = [
      ...[0, 1, 2, 3].map((at) => ({ drum: "kick" as const, at })),
      ...Array.from({ length: 8 }, (_, i) => ({ drum: "hat" as const, at: i / 2 })),
    ];
    const { sim, grid } = selfSimilarity({ bpm: 120, bars: Array.from({ length: 8 }, () => ({ hits })) }, "drums");
    const levels = sectionCuts(sim, grid, { start: 0, end: 16 });
    expectMonotone(levels);
    expect(levels[1].length).toBeGreaterThan(0);
    for (const c of levels[PATTERN_LEVELS]) expect(grid.map((b) => b.start)).toContain(c);
  });

  it("never cuts a held sound", () => {
    const { song, sections } = heldSound();
    const { sim, grid } = selfSimilarity(song);
    expect(sectionCuts(sim, grid, sections[0])).toEqual(Array.from({ length: PATTERN_LEVELS + 1 }, () => []));
  });

  it("cuts irregularBar on the corrected grid, on the true downbeats after the irregular bar", () => {
    const ir = irregularBar();
    const { src, durationSec, beats } = render(ir.song);
    const grid = patternGrid({ downbeats: ir.allin1Downbeats, beats, bpm: 120, durationSec, evidence: [src] });
    const sim = createSimilarity(src, grid, { referenceDb: sourceLevelDb(src, grid) });
    const cuts = sectionCuts(sim, grid, ir.sections[0])[1];
    const starts = grid.map((b) => b.start);
    expect(cuts.length).toBeGreaterThan(0);
    for (const c of cuts) expect(starts, `cut ${c} is a corrected bar start`).toContain(c);
    const late = cuts.filter((c) => c >= 15 - 0.05);
    expect(late.length).toBeGreaterThan(0);
    for (const c of late) {
      const off = Math.min(...ir.downbeats.map((d) => Math.abs(d - c)));
      expect(off, `cut ${c} is on a true downbeat`).toBeLessThanOrEqual(0.05);
    }
  });

  it("is monotone from level 0 (no cuts) up, for every song and section", () => {
    for (const { song, sections } of [twoBarIdea(), fourBarPhrase(), heldSound(), transposedRepeat(), genericBar(), irregularBar()]) {
      const { sim, grid } = selfSimilarity(song);
      for (const section of sections) expectMonotone(sectionCuts(sim, grid, section));
    }
  });

  it("cuts an off-grid section only at grid bar starts, and leaves no piece under 1 s (Review Focus 3)", () => {
    const { sim, grid } = selfSimilarity(twoBarIdea().song);
    const section = { start: 0.3, end: 15.6 };
    const levels = sectionCuts(sim, grid, section);
    expectMonotone(levels);
    const starts = grid.map((b) => b.start);
    expect(levels[1].length).toBeGreaterThan(0);
    for (const cuts of levels) {
      for (const c of cuts) {
        expect(starts).toContain(c);
        expect(c > section.start && c < section.end).toBe(true);
      }
      for (const p of pieces(section, cuts)) expect(p.end - p.start).toBeGreaterThanOrEqual(MIN_SECTION_SEC);
    }
  });

  it("splits the edge phrases of an off-grid section like the middle ones (Review Focus 3)", () => {
    const { sim, grid } = selfSimilarity(fourBarPhrase().song);
    const levels = sectionCuts(sim, grid, { start: 0.3, end: 31.6 });
    expect(levels[1]).toEqual([8, 16, 24]);
    for (let k = 2; k <= PATTERN_LEVELS; k++) {
      // each phrase's cuts, from the bar it starts on
      const offsets = [0, 8, 16, 24].map((p) => levels[k].filter((c) => c > p && c < p + 8).map((c) => c - p));
      expect(offsets[0].length, `level ${k}`).toBeGreaterThan(0);
      for (const o of offsets.slice(1)) expect(o, `level ${k}`).toEqual(offsets[0]);
    }
  });

  it("never cuts a section made of rests", () => {
    const b = bleed();
    const loud = render(b.loud);
    const noise = render(b.bleed);
    const sim = createSimilarity(noise.src, noise.grid, { referenceDb: sourceLevelDb(loud.src, loud.grid) });
    expect(sectionCuts(sim, noise.grid, b.sections[0])).toEqual(Array.from({ length: PATTERN_LEVELS + 1 }, () => []));
  });

  it("does not let silent bars make unrelated parts alike, nor split silence on its own", () => {
    const [X, Y] = twoBarIdea().song.bars;
    const section = { start: 0, end: 8 };
    const unrelated = selfSimilarity({ bpm: 120, bars: [X, {}, Y, {}] });
    expect(sectionCuts(unrelated.sim, unrelated.grid, section)[PATTERN_LEVELS]).toEqual([]);
    const repeated = selfSimilarity({ bpm: 120, bars: [X, {}, X, {}] });
    const levels = sectionCuts(repeated.sim, repeated.grid, section);
    expect(levels[1]).toEqual([4]);
    expect(levels[PATTERN_LEVELS]).toEqual([4]);
  });

  it("makes a run of rest bars one piece, cut only where it starts", () => {
    const [X] = twoBarIdea().song.bars;
    const { sim, grid } = selfSimilarity({ bpm: 120, bars: [X, X, X, X, ...Array.from({ length: 12 }, () => ({}))] });
    const levels = sectionCuts(sim, grid, { start: 0, end: 32 });
    expect(levels[1].length).toBeGreaterThan(0);
    for (const cuts of levels.slice(1)) expect(cuts.filter((c) => c >= 8)).toEqual([8]);
  });
});

// The same guards on songs played, never twice the same (see played): these run on the stem values of the
// thresholds, which are what real stems get.
describe("sectionCuts on a played stem", () => {
  /** selfSimilarity, checked to be on the stem values. */
  function stem(song: SynthSong, kind: SourceKind = "tonal") {
    const s = selfSimilarity(song, kind);
    expect(tuned(s.sim, 0, 1), "on the stem values").toBe(1);
    return s;
  }
  const FOUR_HITS: BarScript["hits"] = [
    ...[0, 1, 2, 3].map((at) => ({ drum: "kick" as const, at })),
    ...Array.from({ length: 8 }, (_, i) => ({ drum: "hat" as const, at: i / 2 })),
  ];

  it("cuts twoBarIdea into its four 2-bar ideas, and leaves each X Y whole", () => {
    const { song, sections } = twoBarIdea();
    const { sim, grid } = stem(played(song));
    const cuts = sectionCuts(sim, grid, sections[0]);
    expect(cuts[1]).toEqual([4, 8, 12]);
    expect(cuts[2]).toEqual(cuts[1]);
  });

  // twelve takes: noise lets a take's bars look like repeats in one take and not in the next
  const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

  it("counts a played 1-bar loop of 24, 30 or 36 bars in 1, 2, 4 or 8 bars, never 3, 5 or 6 (review 1)", () => {
    for (const n of [24, 30, 36]) {
      for (const seed of SEEDS.slice(0, 3)) {
        const { sim, grid } = stem(played(oddPhrase(1, n).song, seed));
        const levels = sectionCuts(sim, grid, { start: 0, end: 2 * n });
        expect(levels[1].length, `${n} bars, seed ${seed}`).toBeGreaterThan(0);
        for (const cuts of levels.slice(1)) expect(partLengths(cuts, n).filter((b) => ![1, 2, 4, 8].includes(b)), `${n} bars, seed ${seed}`).toEqual([]);
      }
    }
  });

  it("keeps A A A A B and A B A B A C, played, as their 5- and 6-bar phrases (re-review 1)", () => {
    // A A A A A B, played, is 2 × 9 here as it was before the loop guard: its cost, not the guard, decides
    for (const [phrase, times] of [
      ["AAAAB", 4],
      ["ABABAC", 4],
    ] as const) {
      const { song, sections } = letteredPhrase(phrase, times);
      const L = phrase.length;
      for (const seed of SEEDS.slice(0, 6)) {
        const { sim, grid } = stem(played(song, seed));
        expect(sectionCuts(sim, grid, sections[0])[1], `${phrase}, seed ${seed}`).toEqual(Array.from({ length: times - 1 }, (_, k) => 2 * L * (k + 1)));
      }
    }
  });

  it("keeps two played takes of a 5-bar phrase that differ at the end in 5-bar parts (fix round 3)", () => {
    for (const phrase of ["ABCDEABCFG", "ABCDEAFGHE"]) {
      const { song, sections } = letteredPhrase(phrase, 2);
      for (const seed of SEEDS.slice(0, 6)) {
        const { sim, grid } = stem(played(song, seed));
        expect(sectionCuts(sim, grid, sections[0])[1], `${phrase}, seed ${seed}`).toEqual([10, 20, 30]);
      }
    }
  });

  it("cuts phrases of 3, 5 and 6 bars at their length, and keeps a 6-bar leftover before two 5-bar phrases", () => {
    for (const [bars, times] of [
      [3, 4],
      [5, 2],
      [6, 2],
    ]) {
      const { song, sections } = oddPhrase(bars, times);
      for (const seed of SEEDS.slice(0, 6)) {
        const { sim, grid } = stem(played(song, seed));
        const phrases = Array.from({ length: times - 1 }, (_, k) => 2 * bars * (k + 1));
        expect(sectionCuts(sim, grid, sections[0])[1], `${bars} × ${times}, seed ${seed}`).toEqual(phrases);
      }
    }
    const { song, sections } = leftoverPhrase();
    for (const seed of SEEDS.slice(0, 6)) {
      const { sim, grid } = stem(played(song, seed));
      expect(sectionCuts(sim, grid, sections[0])[1], `leftover, seed ${seed}`).toEqual([12, 22]);
    }
  });

  it("cuts fourBarPhrase into four 4-bar phrases, not sixteen similar bars, and splits each phrase alike", () => {
    const { song, sections } = fourBarPhrase();
    for (const seed of SEEDS) {
      const { sim, grid } = stem(played(song, seed));
      const cuts = sectionCuts(sim, grid, sections[0]);
      expectMonotone(cuts);
      expect(cuts[1], `seed ${seed}`).toEqual([8, 16, 24]);
      const phrases = pieces(sections[0], cuts[1]);
      for (let k = 2; k <= PATTERN_LEVELS; k++) {
        const offsets = phrases.map((p) => cuts[k].filter((c) => c > p.start && c < p.end).map((c) => c - p.start));
        for (const o of offsets.slice(1)) expect(o, `seed ${seed} level ${k}`).toEqual(offsets[0]);
      }
    }
  });

  it("splits the edge phrases of an off-grid section like the middle ones", () => {
    for (const seed of SEEDS) {
      const { sim, grid } = stem(played(fourBarPhrase().song, seed));
      const levels = sectionCuts(sim, grid, { start: 0.3, end: 31.6 });
      expect(levels[1], `seed ${seed}`).toEqual([8, 16, 24]);
      for (let k = 2; k <= PATTERN_LEVELS; k++) {
        const offsets = [0, 8, 16, 24].map((p) => levels[k].filter((c) => c > p && c < p + 8).map((c) => c - p));
        expect(offsets[0].length, `seed ${seed} level ${k}`).toBeGreaterThan(0);
        for (const o of offsets.slice(1)) expect(o, `seed ${seed} level ${k}`).toEqual(offsets[0]);
      }
    }
  });

  it("cuts a four-on-the-floor beat, which repeats every beat, into parts", () => {
    const beat: SynthSong = { bpm: 120, bars: Array.from({ length: 8 }, () => ({ hits: FOUR_HITS })) };
    const { sim, grid } = stem(played(beat, 7, DRUM_JITTER), "drums");
    const levels = sectionCuts(sim, grid, { start: 0, end: 16 });
    expectMonotone(levels);
    expect(levels[1].length).toBeGreaterThan(0);
    for (const c of levels[PATTERN_LEVELS]) expect(grid.map((b) => b.start)).toContain(c);
  });

  it("never cuts a held sound", () => {
    const { song, sections } = heldSound();
    const { sim, grid } = stem(played(song));
    expect(sectionCuts(sim, grid, sections[0])).toEqual(Array.from({ length: PATTERN_LEVELS + 1 }, () => []));
  });

  it("leaves a sparse stem whole: a few bars among rests, two of them heard again (final review I1)", () => {
    // Flim's bass in Intro 1 reads 1 2 3 . | 4 5 . 3 | 6 7 8 9 | . . 2 . : silence repeating silence costs nothing,
    // so the rests must not pay for leaving the section whole either, or the bars win on silence alone
    const roots = [33, 38, 40, 36, 41, 31, 32, 35, 34]; // A1 D2 E2 C2 F2 G1 G♯1 B1 A♯1: no two share a pitch class
    const line = (r: number): BarScript => ({ notes: [0, 0, 12, 0, 7, 0, 12, 7].map((d, i) => ({ pitch: r + d, at: i / 2, len: 0.5 })) });
    const layout = [0, 1, 2, -1, 3, 4, -1, 2, 5, 6, 7, 8, -1, -1, 1, -1]; // -1 a rest
    const song: SynthSong = { bpm: 120, bars: layout.map((k) => (k < 0 ? {} : line(roots[k]))) };
    for (const seed of SEEDS.slice(0, 6)) {
      const { sim, grid } = stem({ ...played(song, seed), noiseDb: -70 }); // its rests below the gate, as a stem's silence is
      expect(grid.map((b) => sim.rest(b)), `seed ${seed}`).toEqual(layout.map((k) => k < 0));
      expect(sectionCuts(sim, grid, { start: 0, end: 32 })[1], `seed ${seed}`).toEqual([]);
    }
  });

  it("is monotone from level 0 (no cuts) up, for every song and section", () => {
    for (const { song, sections } of [twoBarIdea(), fourBarPhrase(), heldSound(), transposedRepeat(), genericBar(), irregularBar()]) {
      const { sim, grid } = stem(played(song));
      for (const section of sections) expectMonotone(sectionCuts(sim, grid, section));
    }
  });
});

describe("repeatLags", () => {
  /** leftoverPhrase (16 bars: 6 new, then a 5-bar phrase D twice), then 8 bars of it again: its last 3 new bars and D. */
  function heardBefore(song: (s: SynthSong) => SynthSong = (s) => s) {
    const bars = leftoverPhrase().song.bars;
    return { ...selfSimilarity(song({ bpm: 120, bars: [...bars, ...bars.slice(3, 11)] })), sections: [{ start: 0, end: 32 }, { start: 32, end: 48 }] };
  }

  it("finds how many bars back a section was heard before, and nothing for music heard first", () => {
    const { sim, grid, sections } = heardBefore();
    expect(repeatLags(sim, grid, sections[0])).toEqual([]);
    expect(repeatLags(sim, grid, sections[1])).toEqual([13]);
  });

  it("finds it on a played stem too", () => {
    for (const seed of [1, 2, 3]) {
      const { sim, grid, sections } = heardBefore((s) => played(s, seed));
      expect(tuned(sim, 0, 1), "on the stem values").toBe(1);
      expect(repeatLags(sim, grid, sections[1]), `seed ${seed}`).toEqual([13]);
    }
  });

  it("gives a loop many lags, the best REPEAT_LAGS at most, and a held sound none", () => {
    const { sim, grid } = selfSimilarity(oddPhrase(1, 40).song);
    const lags = repeatLags(sim, grid, { start: 60, end: 68 });
    expect(lags).toHaveLength(REPEAT_LAGS);
    for (const lag of lags) expect(lag).toBeGreaterThanOrEqual(4);
    const held = selfSimilarity({ bpm: 120, bars: Array.from({ length: 12 }, () => ({ notes: [{ pitch: 57, at: 0, len: 4 }] })) });
    expect(repeatLags(held.sim, held.grid, { start: 16, end: 24 })).toEqual([]);
  });
});

describe("cutAlike", () => {
  /** n bars of `bar` s from 0. */
  const gridOf = (n: number, bar = 2): GridBar[] => Array.from({ length: n }, (_, i) => ({ start: i * bar, end: (i + 1) * bar, unsure: false }));
  const grid = gridOf(24);
  const levels = (...cuts: number[][]) => [[], ...cuts, ...Array.from({ length: PATTERN_LEVELS - cuts.length }, () => cuts[cuts.length - 1])];
  const sections = [
    { start: 0, end: 16 },
    { start: 16, end: 32 },
    { start: 32, end: 48 },
  ];
  // A is cut at 4 bars, then at 2; B is left whole by its own split; C is cut at 36 s by its own
  const own = [levels([8], [4, 8, 12]), levels([]), levels([36])];
  const free = () => 0; // every way of cutting a section costs the same

  it("cuts a section heard before where that stretch of the lane is cut, at every level, instead of by its own split", () => {
    const out = cutAlike(grid, sections, own, [[], [8], []], free);
    expect(out[0]).toEqual(own[0]);
    expect(out[1]).toEqual(levels([24], [20, 24, 28]));
    expect(out[2]).toEqual(own[2]);
  });

  it("passes on cuts it copied, and copies when every stretch the section repeats agrees", () => {
    // C repeats B (8 bars back), which is cut like A, and A (16 back): the same cuts either way
    const out = cutAlike(grid, sections, own, [[], [8], [8, 16]], free);
    expect(out[2]).toEqual(levels([40], [36, 40, 44]));
  });

  it("keeps the section's own cuts when two stretches it repeats would cut it differently (a steady loop)", () => {
    // 10 bars back, the stretch holds B's cut at bar 12: 44 s, where 8 bars back gives 40
    expect(cutAlike(grid, sections, own, [[], [8], [8, 10]], free)[2]).toEqual(own[2]);
  });

  it("keeps the section's own cuts when the copied ones describe its bars worse (review 2: 4 + 1 + 1 + 1 + 1 over a 2-bar loop)", () => {
    const fewer = (_: Span, cuts: number[]) => cuts.length; // here, every cut costs
    expect(cutAlike(grid, sections, own, [[], [8], []], fewer)[1]).toEqual(own[1]);
    // the check is at level 1: the copied cuts against the section's own there
    const seen: Array<[Span, number[]]> = [];
    cutAlike(grid, sections, own, [[], [8], []], (sp, cuts) => (seen.push([sp, cuts]), 0));
    expect(seen).toEqual([
      [sections[1], [24]],
      [sections[1], []],
    ]);
  });

  it("copies machine cuts only, never a section start (a marker, which allin1 or he placed)", () => {
    const whole = [levels([]), levels([]), levels([40])];
    // 10 bars back, the stretch (bars 6 to 13) holds only B's start, bar 8
    expect(cutAlike(grid, sections, whole, [[], [], [10]], free)[2]).toEqual(levels([]));
  });

  it("leaves out a copied cut that would leave a piece under MIN_SECTION_SEC", () => {
    const fast = gridOf(16, 0.6); // bars of 0.6 s
    const s = [
      { start: 0, end: fast[8].start },
      { start: fast[8].start, end: fast[15].end },
    ];
    const everyBar = fast.slice(1, 8).map((b) => b.start);
    const out = cutAlike(fast, s, [levels(everyBar), levels([])], [[], [8]], free);
    expect(out[1][1]).toEqual([fast[10].start, fast[12].start, fast[14].start]);
    for (const level of out[1]) {
      const at = [s[1].start, ...level, s[1].end];
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(MIN_SECTION_SEC);
    }
  });

  it("keeps every copied cut of a level at the levels above, though a new one there comes closer than MIN_SECTION_SEC (review 6)", () => {
    const fast = gridOf(16, 0.6);
    const s = [
      { start: 0, end: fast[8].start },
      { start: fast[8].start, end: fast[15].end },
    ];
    // the stretch is cut at bar 3, then also at bar 2, 0.6 s before it
    const out = cutAlike(fast, s, [levels([fast[3].start], [fast[2].start, fast[3].start]), levels([])], [[], [8]], free);
    expect(out[1][1]).toEqual([fast[11].start]);
    for (let level = 1; level < PATTERN_LEVELS; level++) for (const c of out[1][level]) expect(out[1][level + 1]).toContain(c);
  });
});

describe("machineCuts", () => {
  it("is every section's cuts at the level, cut alike across sections, in time order", () => {
    for (const { song, sections } of [genericBar(), transposedRepeat()]) {
      const { sim, grid } = selfSimilarity(song);
      const alike = cutAlike(
        grid,
        sections,
        sections.map((s) => sectionCuts(sim, grid, s)),
        sections.map((s) => repeatLags(sim, grid, s)),
        (s, cuts) => barsCost(sim, grid, s, cuts),
      );
      for (let level = 0; level <= PATTERN_LEVELS; level++) {
        const cuts = machineCuts(sim, grid, sections, level);
        expect(cuts).toEqual(alike.flatMap((c) => c[level]));
        expect(cuts).toEqual([...cuts].sort((a, b) => a - b));
        if (level > 0) for (const c of machineCuts(sim, grid, sections, level - 1)) expect(cuts).toContain(c);
      }
      expect(machineCuts(sim, grid, sections, 0)).toEqual([]);
    }
  });

  it("cuts a section heard before like the music it repeats, though its own split leaves it whole (Flim's Instrumental 2)", () => {
    // leftoverPhrase is 6 new bars, then D D; the next section is its last 3 new bars and D again
    const bars = leftoverPhrase().song.bars;
    const { sim, grid } = selfSimilarity({ bpm: 120, bars: [...bars, ...bars.slice(3, 11)] });
    const sections = [
      { start: 0, end: 32 },
      { start: 32, end: 48 },
    ];
    expect(sectionCuts(sim, grid, sections[1])[1]).toEqual([]);
    expect(machineCuts(sim, grid, sections, 1)).toEqual([12, 22, 38]);
  });
});
