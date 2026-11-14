import { describe, expect, it } from "vitest";
import { CELL_RATE, LOUD_FLOOR_DB, type SourceKind } from "./contract.js";
import { FEATURE_LAYOUT, cellExtractor, decodeSource, type DecodedSource } from "./features.js";
import { renderSong, type BarScript } from "./synth.js";
import * as songs from "../test/patternSongs.js";
import { isPatternFeatures } from "./contract.js";

const { randomFeatures, twoBarIdea } = songs;

const RATE = 11025;
const KINDS: SourceKind[] = ["tonal", "drums", "mix"];

function extract(kind: SourceKind, x: Float32Array, chunk = x.length || 1): DecodedSource {
  const ex = cellExtractor(kind, RATE);
  for (let i = 0; i < x.length; i += chunk) ex.push(x.subarray(i, i + chunk));
  return decodeSource(ex.finish());
}

/** The cells [from, from + n) of a decoded source, row-major. */
const block = (d: DecodedSource, from: number, n: number) => d.data.subarray(from * d.dims, (from + n) * d.dims);
const maxDiff = (a: Int8Array, b: Int8Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const mean = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0) / a.length;

describe("renderSong", () => {
  it("renders twoBarIdea at 11025 Hz with its true downbeats", () => {
    const r = renderSong(twoBarIdea().song);
    expect(r.rate).toBe(RATE);
    expect(Math.abs(r.x.length - 16 * RATE)).toBeLessThanOrEqual(1);
    expect(r.downbeats).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(r.beats).toHaveLength(32);
    expect(r.beats.slice(0, 5)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("is deterministic, and its noise follows the seed", () => {
    const song = { bpm: 120, bars: [{ hits: [{ drum: "snare" as const, at: 1 }] }], noiseDb: -40, seed: 7 };
    expect(renderSong(song).x).toEqual(renderSong(song).x);
    expect(renderSong({ ...song, seed: 8 }).x).not.toEqual(renderSong(song).x);
  });

  it("puts the noise floor at noiseDb RMS", () => {
    const r = renderSong({ bpm: 120, bars: [{}, {}], noiseDb: -45 });
    const ms = r.x.reduce((s, v) => s + v * v, 0) / r.x.length;
    expect(10 * Math.log10(ms)).toBeCloseTo(-45, 1);
  });

  it("makes a longer bar from beats", () => {
    const r = renderSong({ bpm: 120, bars: [{}, { beats: 6 }, {}] });
    expect(r.downbeats).toEqual([0, 2, 5]);
    expect(r.x.length).toBe(7 * RATE);
  });
});

describe("cellExtractor", () => {
  it("gives 20 cells a second, all at the loudness floor, for silence", () => {
    const s = extract("tonal", new Float32Array(4 * RATE));
    expect(s.cells).toBe(4 * CELL_RATE);
    expect(s.cells).toBe(80);
    expect(s.data).toHaveLength(80 * s.dims);
    expect(s.loudDb.every((v) => v === LOUD_FLOOR_DB)).toBe(true);
  });

  it.each(KINDS)("gives the same cells whether %s input arrives whole or in chunks", (kind) => {
    const { x } = renderSong({
      ...twoBarIdea().song,
      bars: [...twoBarIdea().song.bars.slice(0, 2), { hits: [{ drum: "kick", at: 0 }, { drum: "hat", at: 0.5 }] }],
      noiseDb: -50,
    });
    const whole = extract(kind, x);
    const chunked = extract(kind, x, 1000);
    expect(chunked.cells).toBe(whole.cells);
    expect(chunked.data).toEqual(whole.data);
    expect(chunked.loudDb).toEqual(whole.loudDb);
  });

  it.each(KINDS)("repeats a repeated bar within one quantisation step (%s), and tells X from Y", (kind) => {
    const d = extract(kind, renderSong(twoBarIdea().song).x);
    expect(maxDiff(block(d, 0, 40), block(d, 80, 40))).toBeLessThanOrEqual(1); // X (bar 0) vs X (bar 2)
    expect(maxDiff(block(d, 0, 40), block(d, 40, 40))).toBeGreaterThan(1); // X vs Y
  });

  it("puts a bar at gainDb -6 six dB lower in loudness", () => {
    const X = twoBarIdea().song.bars[0];
    const d = extract("tonal", renderSong({ bpm: 120, bars: [X, { ...X, gainDb: -6 }] }).x);
    const drop = mean(d.loudDb.subarray(0, 40)) - mean(d.loudDb.subarray(40, 80));
    expect(Math.abs(drop - 6)).toBeLessThanOrEqual(1);
  });

  it.each(KINDS)("keeps the %s features level-free: a quieter bar's cells match within a step or two", (kind) => {
    const X = twoBarIdea().song.bars[0];
    const d = extract(kind, renderSong({ bpm: 120, bars: [X, {}, { ...X, gainDb: -12 }, {}] }).x); // rests: same context
    expect(maxDiff(block(d, 0, 40), block(d, 80, 40))).toBeLessThanOrEqual(2);
  });

  it.each(KINDS)("gives %s the same dims for every call, at most 20 (the size budget)", (kind) => {
    const a = cellExtractor(kind, RATE);
    a.push(new Float32Array(RATE / 10));
    const b = cellExtractor(kind, 44100);
    b.push(renderSong({ bpm: 90, rate: 44100, bars: [{ notes: [{ pitch: 40, at: 0, len: 2 }] }] }).x);
    const dims = a.finish().dims;
    expect(b.finish().dims).toBe(dims);
    expect(dims).toBe(FEATURE_LAYOUT[kind].dims);
    expect(dims).toBeLessThanOrEqual(20);
  });

  it("returns no cells for no input", () => {
    const s = cellExtractor("mix", RATE).finish();
    expect(s.cells).toBe(0);
    expect(decodeSource(s).data).toHaveLength(0);
  });
});

describe("what the features say", () => {
  const chromaArgmax = (d: DecodedSource, cell: number) => {
    const at = FEATURE_LAYOUT[d.kind].chroma!.at;
    const c = Array.from(d.data.subarray(cell * d.dims + at, cell * d.dims + at + 12));
    return c.indexOf(Math.max(...c));
  };

  it.each([
    [28, "E1, a low bass note"],
    [45, "A2"],
    [57, "A3"],
    [73, "C#5"],
  ])("puts a held MIDI %i (%s) in its pitch class", (pitch) => {
    const d = extract("tonal", renderSong({ bpm: 120, bars: [{ notes: [{ pitch, at: 0, len: 4 }], swell: true }] }).x);
    expect(chromaArgmax(d, 20)).toBe(pitch % 12);
  });

  it.each([1, 4, 7, -5])("rotates the chroma with a transposition of %i", (k) => {
    const bar = (t: number): BarScript => ({ notes: [60, 64, 67, 64].map((p, i) => ({ pitch: p + t, at: i, len: 1 })) });
    const d = extract("tonal", renderSong({ bpm: 120, bars: [bar(0), {}, bar(k), {}] }).x); // rests: the same context
    const { at } = FEATURE_LAYOUT.tonal.chroma!;
    let worst = 0;
    for (let c = 0; c < 40; c++) {
      for (let pc = 0; pc < 12; pc++) {
        const a = d.data[c * d.dims + at + pc];
        const b = d.data[(c + 80) * d.dims + at + ((pc + k + 12) % 12)];
        worst = Math.max(worst, Math.abs(a - b));
      }
    }
    expect(worst).toBeLessThanOrEqual(8); // of a 254-step range: the partials sit in slightly different places
  });

  it("marks drum onsets in the band of the drum", () => {
    const d = extract("drums", renderSong({ bpm: 120, bars: [{ hits: [{ drum: "kick", at: 0 }, { drum: "hat", at: 2 }] }] }).x);
    const { flux } = FEATURE_LAYOUT.drums;
    const fluxAt = (cell: number, band: number) => d.data[cell * d.dims + flux.at + band];
    // the kick (cell 0) rises most in the lowest band; the hat (cell 20, beat 2) in the highest
    const kick = Array.from({ length: flux.n }, (_, b) => fluxAt(0, b));
    const hat = Array.from({ length: flux.n }, (_, b) => Math.max(fluxAt(19, b), fluxAt(20, b)));
    expect(kick.indexOf(Math.max(...kick))).toBe(0);
    expect(hat.indexOf(Math.max(...hat))).toBe(flux.n - 1);
    // between the hits nothing rises
    expect(fluxAt(12, 0)).toBe(-127);
  });
});

describe("pattern songs", () => {
  const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length);
  const durationOf = (song: Parameters<typeof renderSong>[0]) => renderSong(song).x.length / RATE;

  it.each(["twoBarIdea", "fourBarPhrase", "heldSound", "transposedRepeat", "genericBar", "irregularBar"] as const)(
    "%s's sections tile the whole song",
    (name) => {
      const { song, sections } = songs[name]();
      expect(sections[0].start).toBe(0);
      sections.slice(1).forEach((s, i) => expect(s.start).toBe(sections[i].end));
      expect(sections[sections.length - 1].end).toBeCloseTo(durationOf(song), 3);
    },
  );

  it("irregularBar has a 3 s bar 6 and allin1's half-time misreading of 12–19 s", () => {
    const { song, downbeats, allin1Downbeats } = songs.irregularBar();
    expect(renderSong(song).downbeats).toEqual(downbeats);
    expect(downbeats).toEqual([0, 2, 4, 6, 8, 10, 12, 15, 17, 19, 21, 23]);
    expect(allin1Downbeats).toEqual([0, 2, 4, 6, 8, 10, 12, 15.5, 19, 21, 23]);
    expect(durationOf(song)).toBe(25);
  });

  it("genericBar ends its last section with N", () => {
    const { song } = songs.genericBar();
    expect(song.bars).toHaveLength(24);
    expect(song.bars[23]).not.toEqual(song.bars[22]);
    expect(song.bars[23].notes!.map((n) => n.at)).toEqual(song.bars[0].notes!.map((n) => n.at));
  });

  it("genericBar's N shares one pitch class with A and is no transposition of it", () => {
    const { song } = songs.genericBar();
    const classes = (b: number) => song.bars[b].notes!.map((n) => n.pitch % 12);
    const [a, n] = [classes(0), classes(23)];
    expect(new Set(n).size).toBe(3);
    expect([...new Set(n)].filter((c) => a.includes(c))).toHaveLength(1);
    for (let k = 0; k < 12; k++) expect(n, `A + ${k}`).not.toEqual(a.map((c) => (c + k) % 12));
  });

  it("bleed puts the song at -14 dBFS and the bleed at -45 dBFS RMS, 16 bars each", () => {
    const b = songs.bleed();
    expect(rmsDb(renderSong(b.loud).x)).toBeCloseTo(-14, 1);
    expect(rmsDb(renderSong(b.bleed).x)).toBeCloseTo(-45, 1);
    expect(durationOf(b.loud)).toBe(32);
    expect(durationOf(b.bleed)).toBe(32);
    expect(b.sections).toEqual([{ start: 0, end: 32 }]);
  });
});

describe("randomFeatures", () => {
  it("builds valid features for all five sources", () => {
    const f = randomFeatures(60, 120, 3);
    expect(isPatternFeatures(f)).toBe(true);
    expect(Object.keys(f.sources)).toHaveLength(5);
    expect(f.grid).toHaveLength(30);
    expect(f.sections).toEqual([{ start: 0, end: 32 }, { start: 32, end: 60 }]);
    expect(f.sources.drums!.dims).toBe(FEATURE_LAYOUT.drums.dims);
    expect(f.sources.mix!.cells).toBe(1200);
  });
});
