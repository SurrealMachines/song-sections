import { describe, expect, it } from "vitest";
import type { GridBar, SourceKind } from "./contract.js";
import { cellExtractor, decodeSource, type DecodedSource } from "./features.js";
import { UNSURE_LENGTH, patternGrid, type GridInput } from "./grid.js";
import { renderSong, type BarScript, type SynthSong } from "./synth.js";
import { irregularBar, randomFeatures, twoBarIdea } from "../test/patternSongs.js";

/** A song rendered to one source of cells, with its true downbeats and beats and its length. */
function render(song: SynthSong, kinds: SourceKind[] = ["tonal"]) {
  const r = renderSong(song);
  const evidence: DecodedSource[] = kinds.map((kind) => {
    const ex = cellExtractor(kind, r.rate);
    ex.push(r.x);
    return decodeSource(ex.finish());
  });
  return { evidence, downbeats: r.downbeats, beats: r.beats, durationSec: r.x.length / r.rate };
}

const input = (g: Partial<GridInput> & { durationSec: number }): GridInput => ({
  downbeats: [],
  beats: [],
  bpm: null,
  evidence: [],
  ...g,
});

/** Contiguous from 0 to durationSec, every bar of positive length, no NaN. */
function expectWellFormed(bars: GridBar[], durationSec: number) {
  expect(bars.length).toBeGreaterThan(0);
  expect(bars[0].start).toBe(0);
  for (const [i, b] of bars.entries()) {
    expect(Number.isFinite(b.start) && Number.isFinite(b.end), `bar ${i} is finite`).toBe(true);
    expect(b.end, `bar ${i} has a length`).toBeGreaterThan(b.start);
    if (i > 0) expect(b.start, `bar ${i} starts where bar ${i - 1} ends`).toBe(bars[i - 1].end);
  }
  expect(bars[bars.length - 1].end).toBe(durationSec);
}

const starts = (bars: GridBar[]) => bars.map((b) => b.start);

describe("patternGrid on regular downbeats", () => {
  it("gives exactly the downbeats of a regular song, none unsure", () => {
    const r = render(twoBarIdea().song);
    const bars = patternGrid({ ...r, bpm: 120 });
    expectWellFormed(bars, r.durationSec);
    expect(r.durationSec).toBeCloseTo(16, 6);
    expect(starts(bars)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(bars.some((b) => b.unsure)).toBe(false);
  });

  it("gives an unsure pickup bar before a first downbeat at 0.7 s, then bars from 0.7", () => {
    const bars = patternGrid(input({ downbeats: [0.7, 2.7, 4.7, 6.7], bpm: 120, durationSec: 8.7 }));
    expectWellFormed(bars, 8.7);
    expect(bars[0]).toEqual({ start: 0, end: 0.7, unsure: true });
    expect(starts(bars)).toEqual([0, 0.7, 2.7, 4.7, 6.7]);
    expect(bars.slice(1).some((b) => b.unsure)).toBe(false);
  });

  it("extrapolates whole bars back to a pickup before a late first downbeat, all unsure", () => {
    const bars = patternGrid(input({ downbeats: [4.7, 6.7, 8.7], durationSec: 10.7 }));
    expectWellFormed(bars, 10.7);
    expect(starts(bars).map((t) => +t.toFixed(9))).toEqual([0, 0.7, 2.7, 4.7, 6.7, 8.7]);
    expect(bars.map((b) => b.unsure)).toEqual([true, true, true, false, false, false]);
  });

  it("extrapolates past the last downbeat's bar to the clip's end, unsure", () => {
    const bars = patternGrid(input({ downbeats: [0, 2, 4], durationSec: 9 }));
    expectWellFormed(bars, 9);
    expect(starts(bars)).toEqual([0, 2, 4, 6, 8]);
    expect(bars.map((b) => b.unsure)).toEqual([false, false, false, true, true]);
  });

  it("marks a bar more than UNSURE_LENGTH off the median as unsure", () => {
    const long = 2 * (1 + UNSURE_LENGTH) + 0.05;
    const bars = patternGrid(input({ downbeats: [0, 2, 4, 4 + long, 6 + long], durationSec: 8 + long }));
    expectWellFormed(bars, 8 + long);
    // with no evidence the irregular bar cannot be re-derived: it stays as one bar, and is unsure
    expect(bars.find((b) => b.start === 4)).toEqual({ start: 4, end: 4 + long, unsure: true });
  });

  it("ignores downbeats that are not finite, out of the clip, out of order or repeated", () => {
    const bars = patternGrid(input({ downbeats: [4, NaN, 2, -1, 0, 2, 6, 11, Infinity], durationSec: 8 }));
    expectWellFormed(bars, 8);
    expect(starts(bars)).toEqual([0, 2, 4, 6]);
    expect(bars.some((b) => b.unsure)).toBe(false);
  });
});

describe("patternGrid through irregular bars", () => {
  const song = irregularBar();

  for (const kinds of [["tonal"], ["mix"]] as SourceKind[][]) {
    it(`re-derives the bar starts where allin1 goes half-time, from the ${kinds[0]} cells`, () => {
      const r = render(song.song, kinds);
      const bars = patternGrid({ ...r, downbeats: song.allin1Downbeats, bpm: 120 });
      expectWellFormed(bars, r.durationSec);
      const inside = bars.filter((b) => b.start >= 12 - 1e-9 && b.start < 19 - 1e-9);
      expect(inside.map((b) => b.start)).toHaveLength(3);
      [12, 15, 17].forEach((t, i) => expect(Math.abs(inside[i].start - t), `bar at ${t}`).toBeLessThanOrEqual(0.05));
      // the 3 s bar (6 beats: the riff, then its last note decaying through the pause) is unsure
      expect(inside[0].unsure).toBe(true);
      // outside the stretch the bars are allin1's (the true) downbeats
      expect(bars.filter((b) => b.start < 12).map((b) => b.start)).toEqual(song.downbeats.filter((d) => d < 12));
      const after = bars.filter((b) => b.start >= 19);
      expect(after.map((b) => b.start)).toEqual(song.downbeats.filter((d) => d >= 19));
      expect(after.some((b) => b.unsure)).toBe(false);
    });
  }

  it("marks re-derived bars with weak support from the music as unsure", () => {
    // six bars of the riff, a held D4 (not in the riff) for 16 beats, then six bars of the riff again
    const R: BarScript = irregularBar().song.bars[0];
    const held: BarScript = { beats: 16, notes: [{ pitch: 62, at: 0, len: 16 }], swell: true };
    const r = render({ bpm: 120, bars: [...Array(6).fill(R), held, ...Array(6).fill(R)] });
    // allin1 gets the held stretch wrong: 12 → 15 → 20 instead of one 8 s bar
    const downbeats = r.downbeats.filter((d) => d !== 12).concat(12, 15).sort((a, b) => a - b);
    const bars = patternGrid({ ...r, downbeats, bpm: 120 });
    expectWellFormed(bars, r.durationSec);
    const inside = bars.filter((b) => b.start >= 12 && b.start < 20);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((b) => b.unsure)).toBe(true);
    expect(bars.filter((b) => b.start < 12 || b.start >= 20).some((b) => b.unsure)).toBe(false);
  });

  it("with no evidence, keeps a stretch's bars contiguous and unsure", () => {
    const r = render(song.song);
    const bars = patternGrid({ ...r, evidence: [], downbeats: song.allin1Downbeats, bpm: 120 });
    expectWellFormed(bars, r.durationSec);
    const inside = bars.filter((b) => b.start >= 12 && b.start < 19);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((b) => b.unsure)).toBe(true);
  });
});

describe("patternGrid without downbeats (Review Focus 2)", () => {
  it("gives even unsure 2 s bars from bpm 120, the last one partial", () => {
    const bars = patternGrid(input({ bpm: 120, durationSec: 9 }));
    expectWellFormed(bars, 9);
    expect(bars.map((b) => [b.start, b.end])).toEqual([[0, 2], [2, 4], [4, 6], [6, 8], [8, 9]]);
    expect(bars.every((b) => b.unsure)).toBe(true);
  });

  it("gives 2 s bars with neither beats nor bpm", () => {
    const bars = patternGrid(input({ bpm: null, durationSec: 3 }));
    expectWellFormed(bars, 3);
    expect(bars).toEqual([
      { start: 0, end: 2, unsure: true },
      { start: 2, end: 3, unsure: true },
    ]);
  });

  it("gives one bar for a clip shorter than a bar", () => {
    const bars = patternGrid(input({ durationSec: 0.5 }));
    expectWellFormed(bars, 0.5);
    expect(bars).toEqual([{ start: 0, end: 0.5, unsure: true }]);
  });

  it("gives one unsure bar for a clip no longer than a cell, with or without downbeats", () => {
    for (const g of [input({ durationSec: 0.03 }), input({ downbeats: [0, 0.01], bpm: 120, durationSec: 0.03 })]) {
      const bars = patternGrid(g);
      expectWellFormed(bars, 0.03);
      expect(bars).toEqual([{ start: 0, end: 0.03, unsure: true }]);
    }
  });

  it("gives even unsure bars from the beats, in phase with the first beat", () => {
    const beats = Array.from({ length: 20 }, (_, i) => 0.5 + 0.4 * i); // 150 bpm: a 1.6 s bar
    const bars = patternGrid(input({ beats, bpm: 120, durationSec: 8.5 }));
    expectWellFormed(bars, 8.5);
    expect(starts(bars).map((t) => +t.toFixed(9))).toEqual([0, 0.5, 2.1, 3.7, 5.3, 6.9]);
    expect(bars.every((b) => b.unsure)).toBe(true);
  });

  it("ignores a bpm that is not a positive number", () => {
    for (const bpm of [0, -120, NaN, Infinity]) {
      expect(patternGrid(input({ bpm, durationSec: 3 })).map((b) => b.end)).toEqual([2, 3]);
    }
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("speed", () => {
  it("re-derives a 30-minute clip where every other 8 bars are irregular in under 10 s", { timeout: 60_000 }, () => {
    const durationSec = 30 * 60;
    const f = randomFeatures(durationSec, 150, 7);
    const evidence = (["other", "drums", "bass"] as const).map((s) => decodeSource(f.sources[s]!));
    const bar = 1.6;
    const downbeats: number[] = [];
    for (let t = 0, i = 0; t < durationSec - bar; i++) {
      downbeats.push(t);
      t += Math.floor(i / 8) % 2 ? bar * (i % 2 ? 1.5 : 0.7) : bar; // a stretch of uneven bars every other 8 bars
    }
    const t0 = performance.now();
    const bars = patternGrid({ downbeats, beats: [], bpm: 150, durationSec, evidence });
    const ms = performance.now() - t0;
    expectWellFormed(bars, durationSec);
    expect(bars.length).toBeGreaterThan(durationSec / bar / 2);
    expect(ms).toBeLessThan(10_000);
  });
});
