// How section-label overrides follow the section indices when a boundary is added or removed.
// Shared by Cue and Structure state; no Node imports.
import { MIN_SECTION_SEC } from "../core/sections.js";
import { snapBoundaries, snapTime } from "../grouping/snap.js";

/** A boundary added at index k splits section k: it keeps its label and the sections after it move up by one. */
export function shiftForAdd(labels: Record<number, string>, k: number): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [key, v] of Object.entries(labels)) {
    const j = Number(key);
    out[j > k ? j + 1 : j] = v;
  }
  return out;
}

/** Removing boundary i merges sections i and i+1: section i's label survives, i+1's goes, later ones move down. */
export function shiftForRemove(labels: Record<number, string>, i: number): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [key, v] of Object.entries(labels)) {
    const j = Number(key);
    if (j === i + 1) continue;
    out[j > i + 1 ? j - 1 : j] = v;
  }
  return out;
}

/**
 * Re-snaps existing boundaries to the grid. snapBoundaries drops the LATER boundary of a colliding pair (or one that
 * lands within MIN_SECTION_SEC of an end). `merged` is how many were dropped. `boundaries` must be ascending.
 *
 * Label overrides follow the span that survives, which is not what remove() does:
 * - A dropped boundary i that collided with the boundary before it (or with the start) collapses section i, the sliver
 *   between them. Section i+1 survives, stretched back over it, so section i's label goes and i+1's moves down:
 *   shiftForRemove(i - 1).
 * - A boundary that collided with the clip end collapses the last section, so section i's label stays and i+1's goes:
 *   shiftForRemove(i), as for remove().
 */
export function resnap(
  boundaries: number[],
  labels: Record<number, string>,
  grid: number[],
  duration: number,
): { boundaries: number[]; labels: Record<number, string>; merged: number } {
  const next = snapBoundaries(boundaries, grid, duration);
  // Snapping is monotone (snapTime never reorders its inputs), so surviving boundaries keep their order:
  // match them off against `next` in turn.
  const dropped: { i: number; atEnd: boolean }[] = [];
  let k = 0;
  boundaries.forEach((b, i) => {
    const t = snapTime(b, grid);
    if (k < next.length && t === next[k]) k++;
    else dropped.push({ i, atEnd: duration - t < MIN_SECTION_SEC });
  });
  // Highest index first, so earlier indices are still valid when their turn comes.
  let out = labels;
  for (const { i, atEnd } of dropped.reverse()) out = shiftForRemove(out, atEnd ? i : i - 1);
  return { boundaries: next, labels: out, merged: dropped.length };
}
