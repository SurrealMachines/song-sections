import { describe, expect, it } from "vitest";
import type { GridBar, SourceKind, Span } from "./contract.js";
import { cellExtractor, decodeSource, type DecodedSource } from "./features.js";
import { CLEAN_FIDELITY, STEM_FIDELITY, createSimilarity, repeatFidelity, sourceLevelDb, tuned, type Similarity } from "./similarity.js";
import { renderSong, rng, type BarScript, type Hit, type SynthSong } from "./synth.js";
import { bleed, fourBarPhrase, genericBar, heldSound, played, playedPhrase, transposedRepeat, twoBarIdea } from "../test/patternSongs.js";

/** A song's cells for one kind, and the regular grid of its true downbeats. */
function render(song: SynthSong, kind: SourceKind = "tonal"): { src: DecodedSource; grid: GridBar[] } {
  const r = renderSong(song);
  const ex = cellExtractor(kind, r.rate);
  ex.push(r.x);
  const end = r.x.length / r.rate;
  const grid = r.downbeats.map((start, i) => ({ start, end: r.downbeats[i + 1] ?? end, unsure: false }));
  return { src: decodeSource(ex.finish()), grid };
}

/** createSimilarity referenced to the source's own level. */
function selfSimilarity(song: SynthSong, kind: SourceKind = "tonal") {
  const { src, grid } = render(song, kind);
  return createSimilarity(src, grid, { referenceDb: sourceLevelDb(src, grid) });
}

const span = (start: number, end: number): Span => ({ start, end });
/** Bar i of a song of 2 s bars. */
const barSpan = (i: number) => span(2 * i, 2 * i + 2);

const BEAT: Hit[] = [{ drum: "kick", at: 0 }, { drum: "hat", at: 1 }, { drum: "snare", at: 2 }, { drum: "hat", at: 3 }];
const D2: BarScript = { hits: [{ drum: "kick", at: 0 }, { drum: "kick", at: 1.5 }, { drum: "snare", at: 3 }] };

describe("compare", () => {
  const sim = selfSimilarity(twoBarIdea().song);

  it("scores a repeated bar as the same, and a different bar well below it", () => {
    const same = sim.compare(barSpan(0), barSpan(2))!;
    const other = sim.compare(barSpan(0), barSpan(1))!;
    expect(same.score).toBeGreaterThanOrEqual(0.9);
    expect(other.score).toBeLessThan(same.score - 0.3);
  });

  it("never compares spans of different bar counts", () => {
    expect(sim.bars(span(0, 2))).toBe(1);
    expect(sim.bars(span(0, 4))).toBe(2);
    expect(sim.compare(span(0, 2), span(0, 4))).toBeNull();
  });

  it("finds a transposed repeat by its chroma rotation", () => {
    const t = selfSimilarity(transposedRepeat().song);
    const P = span(0, 4);
    const repeat = t.compare(P, span(4, 8))!;
    const up4 = t.compare(P, span(8, 12))!;
    expect(up4.shift).toBe(4);
    expect(up4.best).toBeGreaterThanOrEqual(repeat.score - 0.1);
    expect(up4.score).toBeLessThan(up4.best - 0.15);
    expect(up4.median).toBeLessThan(up4.best);
    // the same pair the other way round is the rotation back down
    expect(t.compare(span(8, 12), P)!.shift).toBe(8);
  });

  it("never rotates drums", () => {
    const D1: BarScript = { hits: BEAT };
    const d = selfSimilarity({ bpm: 120, bars: [D1, D2, D1, D2] }, "drums");
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 3], [0, 3]];
    for (const [i, j] of pairs) {
      const c = d.compare(barSpan(i), barSpan(j))!;
      expect(c.shift).toBe(0);
      expect(c.best).toBe(c.score);
      expect(c.median).toBe(c.score);
    }
    expect(d.compare(barSpan(0), barSpan(2))!.score).toBeGreaterThanOrEqual(0.9);
    expect(d.compare(barSpan(0), barSpan(1))!.score).toBeLessThan(d.compare(barSpan(0), barSpan(2))!.score - 0.3);
  });

  it("still matches a bar played a cell (50 ms) or a sixteenth (125 ms) late", () => {
    const X = twoBarIdea().song.bars[0].notes!;
    /** Bar 0 against the same bar played `late` beats late (at 120 bpm), each followed by a different or empty bar. */
    const lateBy = (late: number) => {
      const drums = selfSimilarity({ bpm: 120, bars: [{ hits: BEAT }, D2, { hits: BEAT.map((h) => ({ ...h, at: h.at + late })) }, D2] }, "drums");
      const tonal = selfSimilarity({ bpm: 120, bars: [{ notes: X }, {}, { notes: X.map((n) => ({ ...n, at: n.at + late })) }, {}] });
      return { drums: drums.compare(barSpan(0), barSpan(2))!.score, tonal: tonal.compare(barSpan(0), barSpan(2))!.score };
    };
    const cell = lateBy(0.1);
    expect(cell.drums).toBeGreaterThanOrEqual(0.9);
    expect(cell.tonal).toBeGreaterThanOrEqual(0.9);
    // a whole step late: only the ±1-step tolerance keeps these (0.35 and 0.81 without it)
    const step = lateBy(0.25);
    expect(step.drums).toBeGreaterThanOrEqual(0.8);
    expect(step.tonal).toBeGreaterThanOrEqual(0.9);
  });

  it("compares a stretched bar as its music, not as its seconds", () => {
    // twoBarIdea's X Y at 120 bpm (2 s bars), then again at 80 bpm (3 s bars)
    const XY = twoBarIdea().song.bars.slice(0, 2);
    const fast = renderSong({ bpm: 120, bars: XY });
    const slow = renderSong({ bpm: 80, bars: XY });
    const x = new Float32Array(fast.x.length + slow.x.length);
    x.set(fast.x);
    x.set(slow.x, fast.x.length);
    const ex = cellExtractor("tonal", fast.rate);
    ex.push(x);
    const src = decodeSource(ex.finish());
    const grid: GridBar[] = [0, 2, 4, 7].map((start, i, all) => ({ start, end: all[i + 1] ?? 10, unsure: false }));
    const sim = createSimilarity(src, grid, { referenceDb: sourceLevelDb(src, grid) });
    const music = sim.compare(span(0, 2), span(4, 7))!.score;
    expect(music).toBeGreaterThanOrEqual(0.9);
    expect(sim.compare(span(0, 4), span(4, 10))!.score).toBeGreaterThanOrEqual(0.9);
    expect(sim.compare(span(0, 2), span(7, 10))!.score).toBeLessThan(music - 0.3);
    expect(sim.compare(span(0, 2), span(4, 6))!.score).toBeLessThan(music - 0.3); // the slow bar's first 2 s
  });

  it("works without a grid, and on a span of no length", () => {
    const { src } = render(twoBarIdea().song);
    const level = sourceLevelDb(src, []);
    expect(Number.isFinite(level)).toBe(true);
    const flat = createSimilarity(src, [], { referenceDb: level });
    expect(flat.bars(span(0, 16))).toBe(1);
    const c = flat.compare(span(0, 2), span(4, 6))!;
    expect(c.score).toBeGreaterThanOrEqual(0.9);
    expect([c.score, c.best, c.median].every(Number.isFinite)).toBe(true);
    expect(flat.rest(span(3, 3))).toBe(true);
    expect(sim.rest(span(3, 3))).toBe(true);
  });

  it("gives each pair the very same comparison every time, both ways round, kept or let go", () => {
    const t = selfSimilarity(transposedRepeat().song);
    const P = span(0, 4);
    const P4 = span(8, 12);
    const first = { ...t.compare(P, P4)! };
    const back = { ...t.compare(P4, P)! };
    expect(first.shift).toBe(4);
    expect(back).toEqual({ ...first, shift: 8 });
    expect({ ...t.compare(P, P4)! }).toEqual(first);
    expect(t.score!(P, P4)).toBe(first.score);
    expect(t.score!(P4, P)).toBe(first.score);
    expect(t.score!(P, span(0, 2))).toBeNull(); // bar counts differ, as compare
    // more spans than it keeps (KEPT_BARS): the pair is found afresh, and scores the same
    for (let k = 1; k <= 1500; k++) t.rest(span(k / 1000, 24));
    expect({ ...t.compare(P, P4)! }).toEqual(first);
    expect({ ...t.compare(P4, P)! }).toEqual(back);
  });
});

describe("rest", () => {
  const quiet: SynthSong = { bpm: 120, bars: [{}, {}, {}, {}], noiseDb: -70 };

  it("is a span at −70 dBFS, even referenced to its own level", () => {
    const own = selfSimilarity(quiet);
    expect(own.rest(span(0, 8))).toBe(true);
    expect(own.rest(barSpan(1))).toBe(true);
    const loud = render(twoBarIdea().song);
    const { src, grid } = render(quiet);
    const s = createSimilarity(src, grid, { referenceDb: sourceLevelDb(loud.src, loud.grid) });
    expect(s.rest(span(0, 8))).toBe(true);
  });

  it("is not a span of the song at its level", () => {
    const sim = selfSimilarity(twoBarIdea().song);
    expect(sim.rest(span(0, 16))).toBe(false);
    for (let i = 0; i < 8; i++) expect(sim.rest(barSpan(i))).toBe(false);
  });

  it("is every bar of a bleed-only stem beside a loud source (Review Focus 1)", () => {
    const b = bleed();
    const loud = render(b.loud);
    const noise = render(b.bleed);
    const sim = createSimilarity(noise.src, noise.grid, { referenceDb: sourceLevelDb(loud.src, loud.grid) });
    for (let i = 0; i < 16; i++) expect(sim.rest(barSpan(i))).toBe(true);
    expect(sim.rest(b.sections[0])).toBe(true);
    expect(sim.compare(barSpan(0), barSpan(1))).toBeNull();
  });

  it("makes compare null", () => {
    const { src, grid } = render({ bpm: 120, bars: [...twoBarIdea().song.bars.slice(0, 2), {}, {}] });
    const sim = createSimilarity(src, grid, { referenceDb: sourceLevelDb(src, grid) });
    expect(sim.rest(barSpan(2))).toBe(true);
    expect(sim.compare(barSpan(0), barSpan(2))).toBeNull();
    expect(sim.compare(barSpan(2), barSpan(0))).toBeNull();
    expect(sim.compare(barSpan(2), barSpan(3))).toBeNull();
    expect(sim.compare(barSpan(0), barSpan(1))).not.toBeNull();
  });
});

describe("sourceLevelDb", () => {
  it("is the 90th-percentile bar loudness", () => {
    const b = bleed();
    const loud = render(b.loud);
    const noise = render(b.bleed);
    expect(sourceLevelDb(loud.src, loud.grid)).toBeGreaterThan(-16);
    expect(sourceLevelDb(loud.src, loud.grid)).toBeLessThan(-11);
    expect(sourceLevelDb(noise.src, noise.grid)).toBeCloseTo(-45, 0);
  });
});

describe("repeatFidelity and tuned", () => {
  it("reads clean synthesis with repeats as exact: 1", () => {
    for (const song of [twoBarIdea().song, fourBarPhrase().song, transposedRepeat().song, genericBar().song]) {
      expect(repeatFidelity(selfSimilarity(song))).toBeGreaterThanOrEqual(CLEAN_FIDELITY);
    }
  });

  it("reads the same songs played, never twice the same, as stems", () => {
    for (const song of [playedPhrase().song, played(twoBarIdea().song), played(fourBarPhrase().song), played(genericBar().song)]) {
      expect(repeatFidelity(selfSimilarity(song))).toBeLessThanOrEqual(STEM_FIDELITY);
    }
  });

  it("measures repetition, not noise: clean music that never repeats reads low", () => {
    const rand = rng(11);
    const bars: BarScript[] = Array.from({ length: 16 }, () => ({
      notes: Array.from({ length: 8 }, (_, i) => ({ pitch: 55 + Math.floor(rand() * 20), at: i * 0.5, len: 0.5 })),
    }));
    expect(repeatFidelity(selfSimilarity({ bpm: 120, bars }))!).toBeLessThan(0.5);
  });

  it("cannot tell on fewer than 8 sounding bars, and takes such a source as a stem", () => {
    // five sounding bars of a played stem, then silence (a vocal heard in a few bars); no noise floor, so the silence rests
    const bars = [...twoBarIdea().song.bars.slice(0, 5), ...Array.from({ length: 11 }, () => ({}))];
    const sim = selfSimilarity({ ...played({ bpm: 120, bars }), noiseDb: undefined });
    expect(Array.from({ length: 16 }, (_, i) => sim.rest(barSpan(i))).filter((r) => !r)).toHaveLength(5);
    expect(repeatFidelity(sim)).toBeNull();
    expect(tuned(sim, 0.9, 0.6)).toBe(0.6);
    expect(repeatFidelity(selfSimilarity(heldSound().song))).toBeNull();
  });

  it("takes a hand-written Similarity as exact, so that the clean values can be tested on one", () => {
    const stub: Similarity = { bars: () => 1, rest: () => false, compare: () => ({ score: 0, best: 0, shift: 0, median: 0 }) };
    expect(repeatFidelity(stub)).toBe(1);
    expect(tuned(stub, 0.9, 0.6)).toBe(0.9);
  });

  it("gives the clean value on exact repeats and the stems' on played ones", () => {
    expect(tuned(selfSimilarity(twoBarIdea().song), 0.9, 0.6)).toBe(0.9);
    expect(tuned(selfSimilarity(playedPhrase().song), 0.9, 0.6)).toBeCloseTo(0.6, 9);
  });
});
