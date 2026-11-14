import { describe, expect, it } from "vitest";
import { beatToSec, fileSpan, sameWarp, secToBeat, usableWarp } from "./warpMap.js";

// A file at 150 BPM warped straight at 150: beat b is b × 0.4 s (Matt's fb3 clip). Live's LOM lists one extra
// marker after the last one, which also gives the last segment's slope.
const at150 = [
  { beatTime: 0, sampleTime: 0 },
  { beatTime: 1, sampleTime: 0.4 },
];
// Live's own grid for a clip it creates from the file (fb3: the slices came out at 120.00 BPM).
const at120 = [
  { beatTime: 0, sampleTime: 0 },
  { beatTime: 1, sampleTime: 0.5 },
];
// Two segments: 120 BPM up to beat 8 (4 s), then 60 BPM; markers listed out of order.
const bent = [
  { beatTime: 8, sampleTime: 4 },
  { beatTime: 0, sampleTime: 0 },
  { beatTime: 9, sampleTime: 5 },
];

describe("warp map", () => {
  it("maps beats to file seconds on a straight grid, extrapolating past the markers", () => {
    expect(beatToSec(at150, 0)).toBe(0);
    expect(beatToSec(at150, 32)).toBeCloseTo(12.8, 12);
    expect(beatToSec(at150, -2)).toBeCloseTo(-0.8, 12);
    expect(secToBeat(at150, 12.8)).toBeCloseTo(32, 12);
  });

  it("follows each segment's own slope, sorted by beat", () => {
    expect(beatToSec(bent, 4)).toBeCloseTo(2, 12);
    expect(beatToSec(bent, 10)).toBeCloseTo(6, 12); // 60 BPM past beat 8
    expect(secToBeat(bent, 4.5)).toBeCloseTo(8.5, 12);
    for (const b of [0, 3.3, 8, 8.7, 20]) expect(secToBeat(bent, beatToSec(bent, b)!)).toBeCloseTo(b, 9);
  });

  it("is null without two markers at distinct beats and times (no slope to go by)", () => {
    expect(usableWarp(undefined)).toBe(false);
    expect(usableWarp([{ beatTime: 0, sampleTime: 0 }])).toBe(false);
    expect(usableWarp([{ beatTime: 0, sampleTime: 0 }, { beatTime: 0, sampleTime: 1 }])).toBe(false);
    expect(beatToSec([{ beatTime: 0, sampleTime: 0 }], 4)).toBeNull();
    expect(usableWarp(at150)).toBe(true);
  });

  it("tells Live's 120 BPM grid from the source's 150 one, and accepts the same grid listed differently", () => {
    expect(sameWarp(at150, at120, 0, 64)).toBe(false);
    expect(sameWarp(at150, [...at150, { beatTime: 64, sampleTime: 25.6 }], 0, 64)).toBe(true);
    // Equal inside the range only matters: a different marker past the slice's end is ignored.
    const later = [...at150, { beatTime: 100, sampleTime: 40 }, { beatTime: 101, sampleTime: 41 }];
    expect(sameWarp(at150, later, 0, 64)).toBe(true);
    expect(sameWarp(at150, later, 0, 101)).toBe(false);
    expect(sameWarp(at150, undefined, 0, 64)).toBe(false);
  });
});

describe("fileSpan", () => {
  const clip = { view: "session" as const, warped: true, startMarker: 4, endMarker: 64, warpMarkers: at150 };
  it("is a warped Session clip's markers in file seconds by its own warp markers", () => {
    const s = fileSpan(clip)!;
    expect(s.startSec).toBeCloseTo(1.6, 12);
    expect(s.endSec).toBeCloseTo(25.6, 12);
  });
  it("is null for Arrangement, unwarped clips and clips without a map", () => {
    expect(fileSpan({ ...clip, view: "arrangement" })).toBeNull();
    expect(fileSpan({ ...clip, warped: false })).toBeNull();
    expect(fileSpan({ ...clip, warpMarkers: undefined })).toBeNull();
  });
  it("starts at the file's start when the start marker is before it", () => {
    expect(fileSpan({ ...clip, startMarker: -4 })!.startSec).toBe(0);
  });
});
