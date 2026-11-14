// Snapping boundaries to a beat or downbeat grid (Plan 4, Task 8). Pure; no Node imports.
import { addBoundary } from "../core/sections.js";

export const MAX_SNAP_SEC = 2;

/** The nearest grid point (earlier on a tie), or t when none is within MAX_SNAP_SEC. `grid` is ascending. */
export function snapTime(t: number, grid: number[]): number {
  if (grid.length === 0) return t;
  let lo = 0; // first index with grid[i] >= t
  let hi = grid.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = t;
  let bestD = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= grid.length) continue;
    const d = Math.abs(grid[i] - t);
    if (d < bestD) {
      bestD = d;
      best = grid[i];
    }
  }
  return bestD <= MAX_SNAP_SEC ? best : t;
}

/**
 * Snaps each boundary, sorts, drops duplicates, then re-inserts through addBoundary in ascending order,
 * so no section ends up shorter than MIN_SECTION_SEC (the later boundary of a too-close pair is dropped).
 */
export function snapBoundaries(b: number[], grid: number[], duration: number): number[] {
  if (grid.length === 0) return [...b];
  const snapped = [...new Set(b.map((t) => snapTime(t, grid)))].sort((x, y) => x - y);
  return snapped.reduce<number[]>((acc, t) => addBoundary(acc, t, duration), []);
}
