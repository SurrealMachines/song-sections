import { describe, expect, it } from "vitest";
import { correctedGrid, cueLengthGrid, nudgeGridFor, structureLengthGrid, structureSnapGrid } from "./gridChoice.js";
import { formatLength } from "./lengths.js";

const even = (step: number, from = 0, n = 200) => Array.from({ length: n }, (_, i) => from + i * step);
const grid = (beats: number[], per = 4) => ({ beats, bars: beats.filter((_, i) => i % per === 0) });
const none = { beats: [], bars: [] };

describe("cueLengthGrid (fb4, item 1)", () => {
  const live = grid(even(0.5));
  const struct = grid(even(0.45, 0.2));
  it("Arrangement and a warped Session clip: Live's grid for the clip", () => {
    expect(cueLengthGrid({ live, structure: null })).toBe(live);
    expect(cueLengthGrid({ live, structure: struct })).toBe(live);
  });
  it("an unwarped Session clip: a cached Structure analysis's beats, else none (seconds)", () => {
    expect(cueLengthGrid({ live: null, structure: struct })).toBe(struct);
    expect(cueLengthGrid({ live: null, structure: null })).toBeNull();
    expect(cueLengthGrid({ live: none, structure: { beats: [3], bars: [] } })).toBeNull();
  });
});

describe("structureLengthGrid (fb4, item 1)", () => {
  const allin1 = grid(even(0.48, 0.1));
  const live = grid(even(0.5));
  const g = { allin1, live };
  it("snapping: the snap target's grid", () => {
    expect(structureLengthGrid(g, true, "downbeats")).toBe(allin1);
    expect(structureLengthGrid(g, true, "bars")).toBe(live);
  });
  it("snap off: allin1's beats and downbeats, whatever the target", () => {
    expect(structureLengthGrid(g, false, "downbeats")).toBe(allin1);
    expect(structureLengthGrid(g, false, "bars")).toBe(allin1);
  });
  it("allin1 found no beats: Live's; neither: none", () => {
    expect(structureLengthGrid({ allin1: none, live }, false, "downbeats")).toBe(live);
    expect(structureLengthGrid({ allin1: none, live: none }, false, "downbeats")).toBeNull();
  });
  it("snap off, a handle off the grid still reads in bars and beats", () => {
    const lg = structureLengthGrid(g, false, "downbeats")!;
    expect(formatLength(0.1, 0.1 + 32 * 0.48, lg)).toBe("8 bars");
    expect(formatLength(0.3, 0.1 + 32 * 0.48, lg)).toMatch(/^7\.3\.\d$/);
  });
  it("structureSnapGrid follows the target", () => {
    expect(structureSnapGrid(g, "bars")).toBe(live);
    expect(structureSnapGrid(g, "downbeats")).toBe(allin1);
  });
  it("structureSnapGrid under Downbeats is the corrected grid when there is one (final review item 8)", () => {
    const corrected = grid(even(0.5, 0.1));
    expect(structureSnapGrid({ ...g, corrected }, "downbeats")).toBe(corrected);
    expect(structureSnapGrid({ ...g, corrected }, "bars")).toBe(live);
    expect(structureSnapGrid({ ...g, corrected: null }, "downbeats")).toBe(allin1);
  });
});

describe("nudgeGridFor (fb4, item 1)", () => {
  it("Snap on under the Bars target with no Live grid (an unwarped Session clip): allin1's beats, not snapping (fb4 review M6)", () => {
    const allin1 = grid(even(0.48, 0.1));
    const g = { allin1, live: none };
    const nudge = nudgeGridFor(true, structureSnapGrid(g, "bars"), structureLengthGrid(g, true, "bars"), 125);
    expect(nudge).toMatchObject({ beats: allin1.beats, snapping: false });
  });
  const snapGrid = grid(even(0.5));
  const lengthGrid = grid(even(0.4, 0.1), 3);
  it("snapping: the snap grid's points", () => {
    expect(nudgeGridFor(true, snapGrid, lengthGrid, 150)).toMatchObject({ beats: snapGrid.beats, bars: snapGrid.bars, snapping: true, beatsPerBar: 4 });
  });
  it("snap off: the lengths' grid, its own beats per bar", () => {
    expect(nudgeGridFor(false, snapGrid, lengthGrid, 150)).toMatchObject({ beats: lengthGrid.beats, snapping: false, beatsPerBar: 3 });
  });
  it("no grid: a beat at the tempo given", () => {
    expect(nudgeGridFor(false, null, null, 150)).toMatchObject({ beats: [], snapping: false, beatSec: 0.4, beatsPerBar: 4 });
    expect(nudgeGridFor(true, none, null, 120)).toMatchObject({ beats: [], snapping: false, beatSec: 0.5 });
  });
});

// Matt (Live, Flim at 150 BPM): allin1's beat tracker goes half-time for a stretch, so a section there that sounds 5 bars
// read "3.1.1". The patterns' corrected bar grid (src/patterns/grid.ts) re-derives those bars.
describe("correctedGrid and the lengths (Matt, Flim)", () => {
  // 150 BPM: a beat is 0.4 s, a bar 1.6 s. allin1 is right to 16 s and from 28.8 s, and half-time between: 8 real
  // bars read as 4, with beats 0.8 s apart.
  const beats = [...even(0.4, 0, 40), ...even(0.8, 16, 16), ...even(0.4, 28.8, 40)];
  const downbeats = [...even(1.6, 0, 10), ...even(3.2, 16, 4), ...even(1.6, 28.8, 10)];
  const allin1 = { beats, bars: downbeats };
  const end = downbeats[downbeats.length - 1] + 1.6; // the end of allin1's last bar
  // The patterns grid: allin1's own downbeats where they are regular (exactly, as grid.ts keeps them), a bar every
  // 1.6 s re-derived in the stretch, and the last allin1 bar's end.
  const starts = [...downbeats.filter((t) => t < 16), ...even(1.6, 16, 8), ...downbeats.filter((t) => t >= 28.8), end];
  const patternBars = starts.slice(0, -1).map((t, i) => ({ start: t, end: starts[i + 1], unsure: false }));
  const corrected = correctedGrid(allin1, patternBars);
  const g = { allin1, live: grid(even(0.5)), corrected };

  it("on allin1's grid a 5-bar section in the half-time stretch reads short and fractional (the bug)", () => {
    expect(formatLength(17.6, 25.6, allin1)).not.toBe("5 bars");
  });

  it("the corrected grid gives whole bars there, snapping to Downbeats and with snap off", () => {
    for (const lg of [structureLengthGrid(g, true, "downbeats")!, structureLengthGrid(g, false, "downbeats")!, structureLengthGrid(g, false, "bars")!]) {
      expect(lg).toBe(corrected);
      expect(formatLength(17.6, 25.6, lg)).toBe("5 bars");
      expect(formatLength(16, 28.8, lg)).toBe("8 bars");
      expect(formatLength(9.6, 32, lg)).toBe("14 bars"); // across both edges of the stretch
      expect(formatLength(17.6, 18.4, lg)).toBe("0.2");
    }
  });

  it("keeps Live's bars when the user chose Bars, and allin1's when there is no corrected grid", () => {
    expect(structureLengthGrid(g, true, "bars")).toBe(g.live);
    expect(structureLengthGrid({ allin1, live: none, corrected: null }, false, "downbeats")).toBe(allin1);
    // No allin1 beats: Live's, as before, even with a corrected grid.
    expect(structureLengthGrid({ allin1: none, live: g.live, corrected }, false, "downbeats")).toBe(g.live);
  });

  it("keeps allin1's own beats and downbeats where its bars are regular", () => {
    expect(corrected.beats.filter((t) => t < 16 || t >= 28.8)).toEqual(beats.filter((t) => t < 16 || t >= 28.8));
    expect(corrected.bars.filter((t) => t < 16 || t >= 28.8)).toEqual(downbeats.filter((t) => t < 16 || t >= 28.8));
    expect(corrected.bars.filter((t) => t >= 16 && t < 28.8)).toEqual(even(1.6, 16, 8));
    expect(corrected.beats.filter((t) => t >= 16 && t < 28.8).map((t) => +t.toFixed(9))).toEqual(even(0.4, 16, 32).map((t) => +t.toFixed(9)));
    expect(formatLength(end - 1.6, end, corrected)).toBe("1 bar");
  });

  it("a corrected grid that skips one of allin1's downbeats, or has an empty bar, leaves allin1's grid there", () => {
    // Bars to 6.4, an empty bar at 6.4, then nothing until 9.6: allin1's 6.4 and 8.0 bars fill the gap.
    const gappy = [...patternBars.filter((b) => b.end <= 6.4 + 1e-9), { start: 6.4, end: 6.4, unsure: true }, ...patternBars.filter((b) => b.start >= 9.6 - 1e-9)];
    const c = correctedGrid(allin1, gappy);
    expect(c.bars.filter((t) => t < 16)).toEqual(downbeats.filter((t) => t < 16));
    expect(c.beats.filter((t) => t < 16)).toEqual(beats.filter((t) => t < 16));
    expect(formatLength(17.6, 25.6, c)).toBe("5 bars");
  });

  it("a bar of allin1's own whose beats went half-time is split into a bar's beats too", () => {
    // 120 BPM; allin1's bar from 6 s to 8 s has only the beats 6 and 7.
    const a2 = { beats: [...even(0.5, 0, 12), 6, 7, ...even(0.5, 8, 8)], bars: [0, 2, 4, 6, 8, 10] };
    const c = correctedGrid(a2, even(2, 0, 6).map((t) => ({ start: t, end: t + 2, unsure: false })));
    expect(c.beats).toEqual(even(0.5, 0, 24));
    expect(formatLength(4, 10, c)).toBe("3 bars");
  });

  it("without allin1 downbeats or pattern bars, it is allin1's grid unchanged", () => {
    expect(correctedGrid(allin1, [])).toBe(allin1);
    const noBars = { beats, bars: [] };
    expect(correctedGrid(noBars, patternBars)).toBe(noBars);
  });
});
