import { describe, expect, test } from "vitest";
import {
  addBoundary,
  assertValidPieces,
  boundariesToSections,
  cueLabel,
  MIN_SECTION_SEC,
  moveBoundary,
  removeBoundary,
  uniqueLabels,
} from "./sections.js";

describe("boundariesToSections", () => {
  test("splits duration at interior boundaries", () => {
    expect(boundariesToSections([10, 20], 30, cueLabel)).toEqual([
      { start: 0, end: 10, label: "Cue 1" },
      { start: 10, end: 20, label: "Cue 2" },
      { start: 20, end: 30, label: "Cue 3" },
    ]);
  });

  test("no boundaries gives one section spanning the clip", () => {
    expect(boundariesToSections([], 30, cueLabel)).toEqual([
      { start: 0, end: 30, label: "Cue 1" },
    ]);
  });
});

describe("moveBoundary", () => {
  test("moves a boundary to the requested time", () => {
    expect(moveBoundary([10, 20], 0, 15, 30)).toEqual([15, 20]);
  });

  test("clamps against the next boundary keeping the minimum section length", () => {
    expect(moveBoundary([10, 20], 0, 19.5, 30)).toEqual([19, 20]);
  });

  test("clamps against the clip start keeping the minimum section length", () => {
    expect(moveBoundary([10, 20], 0, -5, 30)).toEqual([1, 20]);
  });

  test("does not mutate the input array", () => {
    const input = [10, 20];
    moveBoundary(input, 0, 15, 30);
    expect(input).toEqual([10, 20]);
  });
});

describe("addBoundary", () => {
  test("ignores a boundary that would leave a section shorter than the minimum", () => {
    expect(addBoundary([10], 10.5, 30)).toEqual([10]);
  });

  test("adds a boundary and keeps the array sorted", () => {
    expect(addBoundary([10], 15, 30)).toEqual([10, 15]);
    expect(addBoundary([10, 20], 5, 30)).toEqual([5, 10, 20]);
  });

  test("does not mutate the input array", () => {
    const input = [10];
    addBoundary(input, 15, 30);
    expect(input).toEqual([10]);
  });
});

describe("removeBoundary", () => {
  test("removes the boundary at the given index", () => {
    expect(removeBoundary([10, 20], 0)).toEqual([20]);
  });

  test("does not mutate the input array", () => {
    const input = [10, 20];
    removeBoundary(input, 0);
    expect(input).toEqual([10, 20]);
  });
});

describe("cueLabel", () => {
  test("is 1-based", () => {
    expect(cueLabel(0)).toBe("Cue 1");
    expect(cueLabel(4)).toBe("Cue 5");
  });
});

describe("uniqueLabels (Task 13, Live fix 5: Session scene names)", () => {
  const sec = (label: string, i: number) => ({ start: i, end: i + 1, label, color: 0 });
  const labels = (xs: string[]) => uniqueLabels(xs.map(sec)).map((s) => s.label);

  test("numbers repeats from 2 and leaves first occurrences alone", () => {
    expect(labels(["A - intro", "B′ - inst", "B′ - inst", "C - solo", "B′ - inst"])).toEqual([
      "A - intro",
      "B′ - inst",
      "B′ - inst 2",
      "C - solo",
      "B′ - inst 3",
    ]);
  });

  test("skips a number another label already uses", () => {
    expect(labels(["X", "X 2", "X", "X"])).toEqual(["X", "X 2", "X 3", "X 4"]);
  });

  test("returns new objects and keeps times and colours", () => {
    const input = [sec("A", 0), sec("A", 1)];
    const out = uniqueLabels(input);
    expect(input[1].label).toBe("A");
    expect(out[1]).toEqual({ ...input[1], label: "A 2" });
  });

  test("unique labels pass through unchanged", () => {
    expect(labels(["Cue 1", "Cue 2"])).toEqual(["Cue 1", "Cue 2"]);
  });
});

describe("assertValidPieces (Plan 6: Session pieces, which may leave gaps for rests)", () => {
  const piece = (start: number, end: number) => ({ start, end, label: "other 1", color: 0 });

  test("accepts ascending pieces with gaps, ending at or before the clip end", () => {
    expect(() => assertValidPieces([piece(0, 4), piece(6, 10), piece(12, 20)], 20)).not.toThrow();
    expect(() => assertValidPieces([piece(2, 8)], 20)).not.toThrow();
  });

  test("throws on overlap", () => {
    expect(() => assertValidPieces([piece(0, 5), piece(4, 10)], 20)).toThrow(/overlap/);
    expect(() => assertValidPieces([piece(6, 10), piece(0, 4)], 20)).toThrow(/overlap/);
  });

  test("throws on start >= end", () => {
    expect(() => assertValidPieces([piece(5, 5)], 20)).toThrow(/empty or reversed/);
    expect(() => assertValidPieces([piece(0, 4), piece(8, 6)], 20)).toThrow(/empty or reversed/);
  });

  test("throws on a piece under MIN_SECTION_SEC (Review Focus 4)", () => {
    expect(() => assertValidPieces([piece(0, 4), piece(6, 6 + MIN_SECTION_SEC / 2)], 20)).toThrow(/shorter/);
    expect(() => assertValidPieces([piece(0, MIN_SECTION_SEC)], 20)).not.toThrow();
  });

  test("throws beyond durationSec, before 0, on non-finite times and on none", () => {
    expect(() => assertValidPieces([piece(0, 4), piece(12, 21)], 20)).toThrow(/after the clip/);
    expect(() => assertValidPieces([piece(-1, 4)], 20)).toThrow(/before 0/);
    expect(() => assertValidPieces([piece(0, Number.NaN)], 20)).toThrow(/finite/);
    expect(() => assertValidPieces([], 20)).toThrow(/empty/);
  });
});
