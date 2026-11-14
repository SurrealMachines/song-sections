import { describe, expect, it } from "vitest";
import { beatSeconds, nudgeTime, stepOnGrid } from "./nudge.js";

const beats = Array.from({ length: 41 }, (_, i) => i * 0.5); // 120 BPM, 0..20 s
const bars = beats.filter((_, i) => i % 4 === 0);

describe("stepOnGrid", () => {
  it("from a grid point, the next or previous one, or `steps` of them", () => {
    expect(stepOnGrid(4, beats, 1, 1)).toBe(4.5);
    expect(stepOnGrid(4, beats, -1, 1)).toBe(3.5);
    expect(stepOnGrid(4, beats, 1, 4)).toBe(6);
  });
  it("from between points, the first one past it counts as the first step", () => {
    expect(stepOnGrid(4.2, beats, 1, 1)).toBe(4.5);
    expect(stepOnGrid(4.2, beats, -1, 1)).toBe(4);
    expect(stepOnGrid(4.2, beats, 1, 4)).toBe(6);
  });
  it("treats float noise as on the point", () => {
    expect(stepOnGrid(4 + 1e-9, beats, -1, 1)).toBe(3.5);
  });
  it("null past either end", () => {
    expect(stepOnGrid(20, beats, 1, 1)).toBeNull();
    expect(stepOnGrid(0, beats, -1, 1)).toBeNull();
    expect(stepOnGrid(19, beats, 1, 4)).toBeNull();
  });
});

describe("nudgeTime (fb3, item 4)", () => {
  const snapped = { beats, bars, beatSec: 0.5, beatsPerBar: 4, snapping: true };
  it("snap on: one beat of the grid, Shift one bar line", () => {
    expect(nudgeTime(4, 1, false, snapped)).toBe(4.5);
    expect(nudgeTime(4, 1, true, snapped)).toBe(6);
    expect(nudgeTime(4, -1, true, snapped)).toBe(2);
    expect(nudgeTime(5, 1, true, snapped)).toBe(6); // off a bar line: to the next one
  });
  it("snap on without bar lines: Shift moves by beatsPerBar beats", () => {
    expect(nudgeTime(4.5, 1, true, { ...snapped, bars: [] })).toBe(6.5);
  });
  it("snap on, at the grid's end: stays", () => {
    expect(nudgeTime(20, 1, false, snapped)).toBe(20);
  });
  it("snap off without a grid: one beat at the analysed tempo, Shift a bar of them, from wherever the handle is", () => {
    const free = { beats: [], bars: [], beatSec: 60 / 150, beatsPerBar: 4, snapping: false };
    expect(nudgeTime(4.1, 1, false, free)).toBeCloseTo(4.5, 12);
    expect(nudgeTime(4.1, -1, true, free)).toBeCloseTo(2.5, 12);
  });
  it("fb4: snap off with a grid: one of its beats (Shift: beatsPerBar of them), keeping the offset from it", () => {
    const free = { beats, bars, beatSec: 60 / 150, beatsPerBar: 4, snapping: false };
    expect(nudgeTime(4.1, 1, false, free)).toBeCloseTo(4.6, 12);
    expect(nudgeTime(4.1, -1, true, free)).toBeCloseTo(2.1, 12);
    // A grid whose tempo changes: a beat is whatever the grid's next interval is.
    const g = { beats: [0, 0.5, 1, 1.6, 2.2], bars: [], beatSec: 0.5, beatsPerBar: 4, snapping: false };
    expect(nudgeTime(0.75, 1, false, g)).toBeCloseTo(1.3, 12);
    // Past the grid's ends, its end intervals carry on.
    expect(nudgeTime(2.2, 1, false, g)).toBeCloseTo(2.8, 12);
    expect(nudgeTime(0.1, -1, false, g)).toBeCloseTo(-0.4, 12);
  });
});

describe("beatSeconds", () => {
  it("the analysed tempo, else the beats' median spacing, else 120 BPM", () => {
    expect(beatSeconds(150, beats)).toBe(0.4);
    expect(beatSeconds(null, [0, 0.4, 0.8, 1.3, 1.7])).toBe(0.4);
    expect(beatSeconds(null, [])).toBe(0.5);
    expect(beatSeconds(0, [1])).toBe(0.5);
  });
});
