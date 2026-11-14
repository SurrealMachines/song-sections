import { describe, expect, it } from "vitest";
import { MIN_SECTION_SEC } from "../core/sections.js";
import { MAX_SNAP_SEC, snapBoundaries, snapTime } from "./snap.js";

const grid = [8, 10, 12];

describe("snapTime", () => {
  it("snaps to the nearest grid point", () => {
    expect(snapTime(10.3, grid)).toBe(10);
    expect(snapTime(11.2, grid)).toBe(12);
    expect(snapTime(8.0, grid)).toBe(8);
  });
  it("leaves a time with no grid point within MAX_SNAP_SEC alone", () => {
    expect(snapTime(15, grid)).toBe(15);
    expect(snapTime(5, grid)).toBe(5);
    expect(MAX_SNAP_SEC).toBe(2);
  });
  it("snaps at exactly MAX_SNAP_SEC and prefers the earlier point on a tie", () => {
    expect(snapTime(14, grid)).toBe(12);
    expect(snapTime(9, grid)).toBe(8);
  });
  it("returns t for an empty grid", () => {
    expect(snapTime(3.3, [])).toBe(3.3);
  });
  it("works on a long grid (binary search)", () => {
    const g = Array.from({ length: 5000 }, (_, i) => i * 0.5);
    expect(snapTime(1234.6, g)).toBe(1234.5);
    expect(snapTime(9999, g)).toBe(9999);
  });
});

describe("snapBoundaries", () => {
  it("merges two boundaries that snap to the same point", () => {
    expect(snapBoundaries([9.9, 10.2], grid, 30)).toEqual([10]);
  });
  it("drops the later boundary when snapping would leave a section under MIN_SECTION_SEC", () => {
    // Both land on a 0.5 s grid, 0.5 s apart.
    const out = snapBoundaries([10.1, 10.6], [10, 10.5], 30);
    expect(out).toEqual([10]);
  });
  it("keeps every section at least MIN_SECTION_SEC long", () => {
    const g = Array.from({ length: 60 }, (_, i) => i * 0.5);
    const out = snapBoundaries([3.1, 3.4, 3.9, 4.6, 8.2, 29.8], g, 30);
    const edges = [0, ...out, 30];
    for (let i = 1; i < edges.length; i++) expect(edges[i] - edges[i - 1]).toBeGreaterThanOrEqual(MIN_SECTION_SEC);
  });
  it("sorts the result", () => {
    expect(snapBoundaries([20.1, 10.2], grid.concat([20]), 30)).toEqual([10, 20]);
  });
  it("returns the boundaries unchanged for an empty grid", () => {
    expect(snapBoundaries([3.3, 9.1], [], 30)).toEqual([3.3, 9.1]);
  });
  it("leaves boundaries far from the grid where they are", () => {
    expect(snapBoundaries([20, 25], grid, 30)).toEqual([20, 25]);
  });
  it("does not mutate its inputs", () => {
    const b = [9.9, 10.2];
    snapBoundaries(b, grid, 30);
    expect(b).toEqual([9.9, 10.2]);
  });
});
