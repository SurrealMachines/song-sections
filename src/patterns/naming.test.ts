import { describe, expect, it } from "vitest";
import { patternText, type GridBar, type SliceName, type Span } from "./contract.js";
import { cellExtractor, decodeSource, type DecodedSource } from "./features.js";
import { SAME, TRANSPOSE_GAIN, TRANSPOSE_MIN_MEMBERS, TRANSPOSE_OVER_MEDIAN, VARIANT, nameSlices } from "./naming.js";
import { createSimilarity, sourceLevelDb, tuned, type Comparison, type Similarity } from "./similarity.js";
import { sectionCuts } from "./split.js";
import { renderSong, type SynthSong } from "./synth.js";
import { bleed, fourBarPhrase, genericBar, played, playedPhrase, transposedRepeat, twoBarIdea, type PatternSong } from "../test/patternSongs.js";

/** A song's tonal cells and the regular grid of its true downbeats. */
function render(song: SynthSong): { src: DecodedSource; grid: GridBar[] } {
  const r = renderSong(song);
  const ex = cellExtractor("tonal", r.rate);
  ex.push(r.x);
  const end = r.x.length / r.rate;
  const grid = r.downbeats.map((start, i) => ({ start, end: r.downbeats[i + 1] ?? end, unsure: false }));
  return { src: decodeSource(ex.finish()), grid };
}

/** createSimilarity on a song's own grid, referenced to its own level. */
function selfSimilarity(song: SynthSong): { sim: Similarity; grid: GridBar[] } {
  const { src, grid } = render(song);
  return { sim: createSimilarity(src, grid, { referenceDb: sourceLevelDb(src, grid) }), grid };
}

/** Every section's level-1 pieces, in time order. */
function levelOne(sim: Similarity, grid: GridBar[], sections: Span[]): Span[] {
  return sections.flatMap((s) => {
    const at = [s.start, ...sectionCuts(sim, grid, s)[1], s.end];
    return at.slice(1).map((end, i) => ({ start: at[i], end }));
  });
}

/** Consecutive slices of `bars` 2 s bars each over `count` of them. */
const slicesOf = (bars: number, count: number): Span[] =>
  Array.from({ length: count }, (_, i) => ({ start: 2 * bars * i, end: 2 * bars * (i + 1) }));

/** Names a song's slices, and checks what holds for every lane: a pattern's first slice in time is never a variant. */
function names(sim: Similarity, slices: Span[]): SliceName[] {
  const out = nameSlices(sim, slices);
  expect(out).toHaveLength(slices.length);
  const order = slices.map((_, i) => i).sort((i, j) => slices[i].start - slices[j].start);
  const seen = new Set<number>();
  for (const i of order) {
    const n = out[i];
    if (n.pattern === null) {
      expect(n.variant).toBe(false);
      continue;
    }
    if (!seen.has(n.pattern)) expect(n.variant, `the first slice of ${n.pattern} is not a variant`).toBe(false);
    seen.add(n.pattern);
  }
  return out;
}

/** Slice index pairs that share a pattern number. */
function sharing(ns: SliceName[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      if (ns[i].pattern !== null && ns[i].pattern === ns[j].pattern) pairs.push(`${i}-${j}`);
    }
  }
  return pairs;
}

function song1(make: () => PatternSong) {
  const { song, sections } = make();
  return { ...selfSimilarity(song), sections };
}

describe("nameSlices", () => {
  it("names twoBarIdea's level-1 pieces 1 1 1 1", () => {
    const { sim, grid, sections } = song1(twoBarIdea);
    const slices = levelOne(sim, grid, sections);
    expect(names(sim, slices).map(patternText)).toEqual(["1", "1", "1", "1"]);
  });

  it("names fourBarPhrase's level-1 pieces 1 1 1 1, with no primes", () => {
    const { sim, grid, sections } = song1(fourBarPhrase);
    const slices = levelOne(sim, grid, sections);
    expect(names(sim, slices).map(patternText)).toEqual(["1", "1", "1", "1"]);
  });

  it("names a phrase played four times, never quite the same, 1 1 1 1, which the clean thresholds would not", () => {
    const { sim, grid, sections } = song1(playedPhrase);
    const slices = levelOne(sim, grid, sections);
    expect(slices.map((s) => s.end - s.start)).toEqual([8, 8, 8, 8]);
    expect(names(sim, slices).map(patternText)).toEqual(["1", "1", "1", "1"]);
    // the same comparisons through a hand-written Similarity (taken as exact): the clean SAME (0.9) tells the takes apart
    const clean: Similarity = { bars: (s) => sim.bars(s), rest: (s) => sim.rest(s), compare: (a, b) => sim.compare(a, b) };
    expect(names(clean, slices).map(patternText)).not.toEqual(["1", "1", "1", "1"]);
  });

  it("names a transposed repeat as a variation, and a new idea a new number", () => {
    const { sim } = song1(transposedRepeat);
    expect(names(sim, slicesOf(2, 6)).map(patternText)).toEqual(["1", "1", "1′", "1′", "2", "2"]);
  });

  it("makes a bar with one note changed a variation of its bar", () => {
    const { sim } = song1(fourBarPhrase);
    // bars a1 a2 a3 a4 four times; a2..a4 are a1 with one note changed
    const phrase = ["1", "1′", "1′", "1′"];
    expect(names(sim, slicesOf(1, 16)).map(patternText)).toEqual([...phrase, ...phrase, ...phrase, ...phrase]);
  });

  it("never makes a pattern's first slice a variant, even when a variation of it plays first", () => {
    const [a1, a2] = fourBarPhrase().song.bars;
    const { sim } = selfSimilarity({ bpm: 120, bars: [a2, a1, a1, a1] });
    const out = names(sim, slicesOf(1, 4));
    expect(out[0].variant).toBe(false);
    expect(out.slice(1).map(patternText)).toEqual(Array.from({ length: 3 }, () => patternText(out[1])));
  });

  describe("genericBar, by the bar", () => {
    // A×4 | G×4 | B×4 | G×4 | A×4 | B B B N
    const A = [0, 1, 2, 3, 16, 17, 18, 19];
    const G = [4, 5, 6, 7, 12, 13, 14, 15];
    const B = [8, 9, 10, 11, 20, 21, 22];
    const N = 23;
    const slices = slicesOf(1, 24);
    let lane: { sim: Similarity; out: SliceName[]; a: number | null; b: number | null } | undefined;
    /** The song's similarity and its bars' names, computed once, on first use. */
    function named() {
      if (!lane) {
        const { sim } = song1(genericBar);
        const out = names(sim, slices);
        lane = { sim, out, a: out[A[0]].pattern, b: out[B[0]].pattern };
      }
      return lane;
    }

    it("gives every A bar one plain number and every B bar another", () => {
      const { out, a, b } = named();
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
      for (const i of A) expect(out[i], `bar ${i}`).toEqual({ pattern: a, variant: false });
      for (const i of B) expect(out[i], `bar ${i}`).toEqual({ pattern: b, variant: false });
    });

    it("does not let the generic bar absorb A or B", () => {
      const { out, a, b } = named();
      for (const i of G) {
        expect(out[i].pattern, `bar ${i}`).not.toBe(a);
        expect(out[i].pattern, `bar ${i}`).not.toBe(b);
      }
    });

    it("gives N a number of its own, not a variant of A's", () => {
      const { out } = named();
      expect(out[N].pattern).not.toBeNull();
      expect(out[N].variant).toBe(false);
      for (let i = 0; i < N; i++) expect(out[i].pattern, `bar ${i}`).not.toBe(out[N].pattern);
    });

    it("gives the same partition whatever order the slices come in", () => {
      const { sim, out } = named();
      const forward = sharing(out);
      const reversed = [...slices].reverse();
      const back = names(sim, reversed).reverse();
      expect(sharing(back)).toEqual(forward);
      expect(back.map((n) => n.variant)).toEqual(out.map((n) => n.variant));
      expect(back, "numbered in time order, whatever order the slices come in").toEqual(out);
      const shuffle = slices.map((_, i) => (i * 7) % slices.length); // 7 is coprime to 24
      const shuffled = names(sim, shuffle.map((i) => slices[i]));
      const unshuffled: SliceName[] = [];
      shuffle.forEach((i, k) => (unshuffled[i] = shuffled[k]));
      expect(sharing(unshuffled)).toEqual(forward);
    });
  });

  it("names no slice of a bleed-only stem: they are all rests (Review Focus 1)", () => {
    const b = bleed();
    const loud = render(b.loud);
    const noise = render(b.bleed);
    const sim = createSimilarity(noise.src, noise.grid, { referenceDb: sourceLevelDb(loud.src, loud.grid) });
    for (const slices of [levelOne(sim, noise.grid, b.sections), slicesOf(1, 16), slicesOf(2, 8)]) {
      for (const n of names(sim, slices)) expect(n).toEqual({ pattern: null, variant: false });
    }
  });

  it("gives a lane of rests only rests, and no slices no names", () => {
    const { sim } = selfSimilarity({ bpm: 120, bars: [{}, {}, {}, {}] });
    expect(names(sim, slicesOf(1, 4))).toEqual(Array.from({ length: 4 }, () => ({ pattern: null, variant: false })));
    expect(nameSlices(sim, [])).toEqual([]);
  });

  it("skips rests in the numbering, and never matches slices of different lengths", () => {
    const [X, Y] = twoBarIdea().song.bars;
    const { sim } = selfSimilarity({ bpm: 120, bars: [{}, X, Y, X, Y, X] });
    const slices = [{ start: 0, end: 2 }, { start: 2, end: 6 }, { start: 6, end: 10 }, { start: 10, end: 12 }];
    expect(names(sim, slices).map(patternText)).toEqual(["", "1", "1", "2"]);
  });

  it("keeps the thresholds in order, and spike 2's transposition guards", () => {
    expect(VARIANT).toBeLessThan(SAME);
    expect([TRANSPOSE_GAIN, TRANSPOSE_OVER_MEDIAN, TRANSPOSE_MIN_MEMBERS]).toEqual([0.15, 0.3, 2]);
  });
});

// The same guards on songs played, never twice the same (see played): these run on the stem values of SAME and
// VARIANT, which are what real stems get.
describe("nameSlices on a played stem", () => {
  /** A played song's similarity, checked to be on the stem values. */
  function stem(make: () => PatternSong) {
    const { song, sections } = make();
    const s = selfSimilarity(played(song));
    expect(tuned(s.sim, 0, 1), "on the stem values").toBe(1);
    return { ...s, sections };
  }

  it("names fourBarPhrase's and twoBarIdea's level-1 pieces 1 1 1 1", () => {
    for (const make of [fourBarPhrase, twoBarIdea]) {
      const { sim, grid, sections } = stem(make);
      expect(names(sim, levelOne(sim, grid, sections)).map(patternText)).toEqual(["1", "1", "1", "1"]);
    }
  });

  it("names a transposed repeat as a variation, and a new idea a new number", () => {
    const { sim } = stem(transposedRepeat);
    expect(names(sim, slicesOf(2, 6)).map(patternText)).toEqual(["1", "1", "1′", "1′", "2", "2"]);
  });

  describe("genericBar, by the bar", () => {
    const A = [0, 1, 2, 3, 16, 17, 18, 19];
    const G = [4, 5, 6, 7, 12, 13, 14, 15];
    const B = [8, 9, 10, 11, 20, 21, 22];
    const N = 23;
    let out: SliceName[] | undefined;
    const named = () => (out ??= names(stem(genericBar).sim, slicesOf(1, 24)));

    it("gives every A bar one plain number and every B bar another", () => {
      const o = named();
      const [a, b] = [o[A[0]].pattern, o[B[0]].pattern];
      expect(a).not.toBeNull();
      expect(a).not.toBe(b);
      for (const i of A) expect(o[i], `bar ${i}`).toEqual({ pattern: a, variant: false });
      for (const i of B) expect(o[i], `bar ${i}`).toEqual({ pattern: b, variant: false });
    });

    it("does not let the generic bar absorb A or B", () => {
      const o = named();
      for (const i of G) {
        expect(o[i].pattern, `bar ${i}`).not.toBe(o[A[0]].pattern);
        expect(o[i].pattern, `bar ${i}`).not.toBe(o[B[0]].pattern);
      }
    });

    it("gives N a number of its own, not a variant of A's", () => {
      const o = named();
      expect(o[N].pattern).not.toBeNull();
      expect(o[N].variant).toBe(false);
      for (let i = 0; i < N; i++) expect(o[i].pattern, `bar ${i}`).not.toBe(o[N].pattern);
    });
  });
});

/**
 * A lane of 1-bar slices, slice i at [i, i + 1), of the given kinds ("-" a rest). Slices of one kind are the same;
 * `pairs` gives other kinds' comparisons as "ab" (b against a; "ba" is the rotation back); any other pair is unrelated.
 */
function lane(kinds: string[], pairs: Record<string, Partial<Comparison>>): { sim: Similarity; slices: Span[] } {
  const slices = kinds.map((_, i) => ({ start: i, end: i + 1 }));
  const kind = (s: Span) => kinds[s.start];
  const sim: Similarity = {
    bars: () => 1,
    rest: (s) => kind(s) === "-",
    compare(a, b) {
      const [ka, kb] = [kind(a), kind(b)];
      if (ka === "-" || kb === "-") return null;
      if (ka === kb) return { score: 1, best: 1, shift: 0, median: 0 };
      const there = pairs[ka + kb];
      const back = pairs[kb + ka];
      const c = { score: 0, best: 0.1, shift: 1, median: 0, ...(there ?? back) };
      return there || !back ? c : { ...c, shift: (12 - c.shift) % 12 };
    },
  };
  return { sim, slices };
}
const texts = ({ sim, slices }: { sim: Similarity; slices: Span[] }) => names(sim, slices).map(patternText);
const unshifted = (score: number): Partial<Comparison> => ({ score, best: score, shift: 0, median: score / 2 });

describe("nameSlices on a hand-written matrix", () => {
  it("does not let a slice that is like two patterns chain them together", () => {
    const pairs = { ag: unshifted(0.95), bg: unshifted(0.95), ab: unshifted(0.2) };
    const { sim, slices } = lane(["a", "a", "a", "g", "b", "b", "b"], pairs);
    const out = names(sim, slices);
    expect(out[0].pattern).not.toBe(out[4].pattern);
    for (const i of [0, 1, 2]) expect(out[i]).toEqual({ pattern: out[0].pattern, variant: false });
    for (const i of [4, 5, 6]) expect(out[i]).toEqual({ pattern: out[4].pattern, variant: false });
  });

  it("makes a close match a variation and a weak one a new number", () => {
    expect(texts(lane(["a", "a", "b"], { ab: unshifted(VARIANT + 0.02) }))).toEqual(["1", "1", "1′"]);
    expect(texts(lane(["a", "a", "b"], { ab: unshifted(VARIANT - 0.02) }))).toEqual(["1", "1", "2"]);
    expect(texts(lane(["a", "a", "b"], { ab: unshifted(SAME) }))).toEqual(["1", "1", "1"]);
  });

  it("makes a transposition a variation only through all of spike 2's guards, and SAME", () => {
    const t = (c: Partial<Comparison>, kinds = ["a", "a", "-", "t"], more: Record<string, Partial<Comparison>> = {}) =>
      texts(lane(kinds, { at: { score: 0.1, best: 0.95, shift: 4, median: 0.1, ...c }, ...more }));
    expect(t({})).toEqual(["1", "1", "", "1′"]);
    expect(t({ best: SAME - 0.02 }), "below SAME").toEqual(["1", "1", "", "2"]);
    expect(t({ median: 0.95 - TRANSPOSE_OVER_MEDIAN + 0.02 }), "not over the median").toEqual(["1", "1", "", "2"]);
    expect(t({}, ["a", "-", "t", "t"]), "a pattern of one").toEqual(["1", "", "2", "2"]);
    const other = { ab: unshifted(1), bt: { score: 0.1, best: 0.95, shift: 5, median: 0.1 } };
    expect(t({}, ["a", "b", "-", "t"], other), "two transpositions at once").toEqual(["1", "1", "", "2"]);
  });

  it("groups slices within a section first, then across sections (Flim: Intro 1's B B B B, where Inst 3's E is B′)", () => {
    // c is like its own section's a and b (SAME + 0.01), but more like d and e in the next section
    const pairs = { ab: unshifted(0.99), ac: unshifted(SAME + 0.01), bc: unshifted(SAME + 0.01), cd: unshifted(0.98), ce: unshifted(0.98), de: unshifted(0.99) };
    const { sim, slices } = lane(["a", "b", "c", "d", "e"], pairs);
    expect(nameSlices(sim, slices).map(patternText), "across the lane at once").toEqual(["1", "1", "2", "2", "2"]);
    const sections = [
      { start: 0, end: 3 },
      { start: 3, end: 5 },
    ];
    expect(nameSlices(sim, slices, sections).map(patternText), "within each section first").toEqual(["1", "1", "1", "2", "2"]);
    // and across sections after: d and e join a b c when the groups are alike as a whole
    const close = { ...pairs, ad: unshifted(0.95), ae: unshifted(0.95), bd: unshifted(0.95), be: unshifted(0.95) };
    expect(nameSlices(lane(["a", "b", "c", "d", "e"], close).sim, slices, sections).map(patternText)).toEqual(["1", "1", "1", "1", "1"]);
  });

  it("links a variation to the bigger pattern, not to a variation of it", () => {
    const pairs = { ab: unshifted(0.8), ac: unshifted(0.6), bc: unshifted(0.8) };
    expect(texts(lane(["a", "a", "a", "b", "b", "c"], pairs))).toEqual(["1", "1", "1", "1′", "1′", "2"]);
  });
});
