import { describe, expect, it } from "vitest";
import { barGrid, cueBeatGrid } from "./beatGrid.js";

const clip = (over: Partial<Parameters<typeof cueBeatGrid>[0]> = {}) => ({
  view: "arrangement" as const,
  warped: false,
  startTime: 0,
  startMarker: 0,
  ...over,
});

describe("cueBeatGrid", () => {
  it("Arrangement: song beats from the clip's start time, in clip seconds", () => {
    expect(cueBeatGrid(clip({ startTime: 3.5 }), 120, 3)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);
  });

  it("Arrangement: an integer start puts a beat at 0 and includes the last beat at the clip end", () => {
    expect(cueBeatGrid(clip({ startTime: 8 }), 120, 2)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("Arrangement ignores the start marker, and an unwarped Arrangement clip still has the song grid", () => {
    expect(cueBeatGrid(clip({ startTime: 0, startMarker: 0.5 }), 60, 2)).toEqual([0, 1, 2]);
  });

  it("warped Session clip: the clip grid from its start marker", () => {
    expect(cueBeatGrid(clip({ view: "session", warped: true, startTime: 0, startMarker: 1.5 }), 60, 2)).toEqual([0.5, 1.5]);
  });

  it("unwarped Session clip: no grid", () => {
    expect(cueBeatGrid(clip({ view: "session", warped: false }), 120, 10)).toBeNull();
  });

  it("does not lose the last beat to floating-point drift", () => {
    // 0.1 + 0.2 style error: (startTime + duration × tempo / 60) lands a hair under the integer.
    const grid = cueBeatGrid(clip({ startTime: 0.1 }), 90, (2.9 * 60) / 90)!;
    expect(grid).toHaveLength(3);
    expect(grid.at(-1)).toBeCloseTo((3 - 0.1) * (60 / 90), 9);
  });

  it("gives no grid for a non-finite or non-positive tempo or duration", () => {
    for (const [tempo, dur] of [[0, 10], [Number.NaN, 10], [120, Number.NaN], [-120, 10]]) {
      expect(cueBeatGrid(clip(), tempo, dur)).toBeNull();
    }
  });
});

describe("barGrid (feedback round 1: snap to Live's bars)", () => {
  const FOUR = { numerator: 4, denominator: 4 };

  it("Arrangement: every 4th song beat from the song's bar 1 (beat 0), in clip seconds", () => {
    // 120 bpm: a beat is 0.5 s. The clip starts at beat 6, so bar 3 (beat 8) is at 1 s, bar 4 (beat 12) at 3 s.
    expect(barGrid(clip({ startTime: 6 }), 120, 8, FOUR)).toEqual([1, 3, 5, 7]);
  });

  it("is a subset of the Cue beat grid", () => {
    const beats = cueBeatGrid(clip({ startTime: 6.25 }), 97, 30)!;
    const bars = barGrid(clip({ startTime: 6.25 }), 97, 30, FOUR)!;
    expect(bars.length).toBeGreaterThan(5);
    for (const t of bars) expect(beats.some((b) => Math.abs(b - t) < 1e-9)).toBe(true);
  });

  it("includes a bar at the clip start and at the clip end", () => {
    expect(barGrid(clip({ startTime: 8 }), 120, 4, FOUR)).toEqual([0, 2, 4]);
  });

  it("warped Session clip: bars at clip beats 0, 4, 8 (Live's clip ruler), not counted from the start marker", () => {
    // Start marker at clip beat 2 (1.3.1): the first bar line is clip beat 4, 2 beats into the playing clip.
    expect(barGrid(clip({ view: "session", warped: true, startMarker: 2 }), 60, 10, FOUR)).toEqual([2, 6, 10]);
  });

  it("unwarped Session clip: no bar grid", () => {
    expect(barGrid(clip({ view: "session", warped: false }), 120, 10, FOUR)).toBeNull();
  });

  it("follows the time signature: 3/4 is every 3rd beat, 6/8 every 3 quarter-note beats, 7/8 every 3.5", () => {
    expect(barGrid(clip(), 60, 9, { numerator: 3, denominator: 4 })).toEqual([0, 3, 6, 9]);
    expect(barGrid(clip(), 60, 9, { numerator: 6, denominator: 8 })).toEqual([0, 3, 6, 9]);
    expect(barGrid(clip({ startTime: 1 }), 60, 10, { numerator: 7, denominator: 8 })).toEqual([2.5, 6, 9.5]);
  });

  it("gives no grid for a nonsense signature, tempo or duration", () => {
    expect(barGrid(clip(), 120, 10, { numerator: 0, denominator: 4 })).toBeNull();
    expect(barGrid(clip(), 120, 10, { numerator: 4, denominator: 0 })).toBeNull();
    expect(barGrid(clip(), 120, 10, { numerator: NaN, denominator: 4 })).toBeNull();
    expect(barGrid(clip(), 0, 10, FOUR)).toBeNull();
    expect(barGrid(clip(), 120, 0, FOUR)).toBeNull();
  });
});

// fb3, item 1: a warped Session clip with warp markers is rendered unwarped from its start marker's file time, so its
// grid is its own beats through its warp map, in file seconds from there; the song tempo plays no part.
describe("warped Session clip with warp markers (fb3)", () => {
  const at150 = [
    { beatTime: 0, sampleTime: 0 },
    { beatTime: 1, sampleTime: 0.4 },
  ];
  const c = clip({ view: "session", warped: true, startMarker: 1.5, endMarker: 9, warpMarkers: at150 } as never);
  for (const tempo of [150, 120]) {
    it(`beats every 0.4 s from the first whole beat after the start marker (song at ${tempo})`, () => {
      const grid = cueBeatGrid(c, tempo, 3)!;
      expect(grid.map((t) => +t.toFixed(9))).toEqual([0.2, 0.6, 1, 1.4, 1.8, 2.2, 2.6, 3]);
    });
    it(`bars every 4 beats of the clip (song at ${tempo})`, () => {
      const bars = barGrid(c, tempo, 3, { numerator: 4, denominator: 4 })!;
      expect(bars.map((t) => +t.toFixed(9))).toEqual([1, 2.6]);
    });
  }
});
