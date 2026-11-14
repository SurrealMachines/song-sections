// The Sections slider (feedback round 1): fewer or more boundaries than allin1 chose, from its own boundary
// candidates and, in the top half, repetition splits (feedback round 2, repetition.ts). Pure; no Node imports (the
// dialog bundles it).
import { MIN_SECTION_SEC } from "../core/sections.js";
import type { BoundaryCandidate } from "../structure/contract.js";
import { snapTime } from "./snap.js";

/**
 * The dialog's floor for the bottom half of More. The engine reports every local maximum of allin1's section
 * probability down to 0.001; the ones at or above this fill the bottom half. Tuned on Flim and Inner City Life with
 * snap on (feedback round 1, after the engine's 0.001 floor): 0.015 gives about 8 bars per section at g = 0.5 on both
 * (Flim 13 sections, 8.5 bars; Inner City Life 19, 7.8 bars). The weaker ones are not used (feedback round 2: the top
 * half splits only where the music repeats).
 */
export const CANDIDATE_FLOOR = 0.015;

/** The slider's middle: below it More adds the strong candidates; above it, repetition splits. */
export const HALF_G = 0.5;

/**
 * Slack when comparing grid points with section edges, in seconds: allin1's raw boundaries sit a few ms off its own
 * downbeats (Flim: boundary 28.62, downbeat 28.63). Well under any bar.
 */
const EDGE_SLACK_SEC = 0.05;

/** A repetition split (repetition.ts): a time, and the slider value from which it is in (in (0.5, 1]). */
export interface RepeatCut {
  time: number;
  entry: number;
}

/** The shortest section an added boundary may leave when there is no grid (controller ruling: no slivers). */
export const MIN_ADDED_SEC = 2;

/** The length of the bar of `grid` (ascending, one point per bar) around t; the nearest bar outside its range. */
function barAt(grid: number[], t: number): number {
  let i = grid.findIndex((x) => x > t);
  if (i < 0) i = grid.length - 1;
  i = Math.max(1, i);
  return grid[i] - grid[i - 1];
}

/**
 * Adds the slider's boundaries `times` to `b` in order, each through addBoundary, skipping one that would leave a
 * section shorter than one bar of `barGrid` (MIN_ADDED_SEC without a grid) once snapped to `snapGrid` (none: as is).
 * A skip depends only on what was added before it, so a longer prefix of `times` keeps every boundary a shorter one
 * kept. `b` itself (allin1's own boundaries) is never checked.
 */
function addAllClear(b: number[], times: number[], duration: number, barGrid: number[], snapGrid: number[]): number[] {
  const img = (t: number) => (snapGrid.length > 0 ? snapTime(t, snapGrid) : t);
  const minLen = (t: number) => (barGrid.length > 1 ? barAt(barGrid, t) - EDGE_SLACK_SEC : MIN_ADDED_SEC);
  // `acc` and its images stay sorted (img is monotone), so each addition is two binary searches and two inserts
  // rather than rescans: the same decisions as filtering both arrays and calling addBoundary (review I3).
  const acc = [...b];
  const images = acc.map(img);
  for (const t of times) {
    const at = img(t);
    if (at <= 0 || at >= duration) continue;
    const i = firstAtOrAbove(images, at);
    const lo = images[i] === at ? at : i > 0 ? Math.max(0, images[i - 1]) : 0;
    const hi = i < images.length ? Math.min(duration, images[i]) : duration;
    const need = minLen(at);
    if (at - lo < need || hi - at < need) continue;
    // addBoundary(acc, t, duration): the nearest boundary at or below t and the first above it, MIN_SECTION_SEC away.
    const j = firstAbove(acc, t);
    const below = j > 0 ? acc[j - 1] : 0;
    const above = j < acc.length ? acc[j] : duration;
    if (t - below < MIN_SECTION_SEC || above - t < MIN_SECTION_SEC) continue;
    acc.splice(j, 0, t);
    images.splice(i, 0, at);
  }
  return acc;
}

/** The first index of ascending `xs` whose value is >= x (xs.length if none). */
function firstAtOrAbove(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first index of ascending `xs` whose value is > x (xs.length if none). */
function firstAbove(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * allin1's boundaries moved along the Sections slider, g in [-1, 1]:
 * - 0: `chosen` (allin1's own boundaries) unchanged.
 * - g < 0: drops round(|g| × chosen.length) of them, weakest first (a boundary's strength is its candidate's; one
 *   without a candidate counts as 0). At -1 the clip is one section.
 * - 0 < g <= 0.5: adds round(2g × strong) of the other candidates, strongest first, where strong are those at or
 *   above `floor` (all of them at 0.5).
 * - 0.5 < g <= 1: the plan `repeat(base, weak)` gives for the g = 0.5 boundaries `base` (repetition.ts repeatPlan):
 *   first the base correction, which drops (or moves, as a cut at entry 0.5) allin1 boundaries in `weak` (under
 *   `floor`) that sit inside a clearer repeat; then the repetition cuts whose entry is at or below g, in the order of
 *   their entry (then time). The plan is fixed, so each g takes a prefix.
 * The one exception to "only adds": the step across 0.5, where the base correction can remove weak allin1 boundaries
 * (controller ruling, fb2). From the first step above 0.5 on, the slider only adds again.
 * Everything goes through addAllClear in that one fixed order, so a step up the slider only ever adds boundaries.
 * An addition is skipped when, snapped to `snapGrid` (none: as is), it would leave a section shorter than one bar of
 * `barGrid` (MIN_ADDED_SEC without one): no slivers. allin1's own boundaries are never dropped for that.
 * Ties go to the earlier time. Returns a new ascending array.
 */
export function granularBoundaries(
  chosen: number[],
  candidates: BoundaryCandidate[],
  g: number,
  duration: number,
  floor: number = CANDIDATE_FLOOR,
  barGrid: number[] = [],
  snapGrid: number[] = [],
  repeat?: (base: number[], weak: number[]) => { drop: number[]; cuts: RepeatCut[] },
): number[] {
  const strength = new Map(candidates.map((c) => [c.time, c.strength]));
  if (g < 0) {
    const n = Math.round(Math.min(1, -g) * chosen.length);
    const weakest = [...chosen].sort((a, b) => (strength.get(a) ?? 0) - (strength.get(b) ?? 0) || a - b).slice(0, n);
    const drop = new Set(weakest);
    return chosen.filter((t) => !drop.has(t));
  }
  const taken = new Set(chosen);
  const strong = candidates
    .filter((c) => !taken.has(c.time) && c.strength >= floor)
    .sort((a, b) => b.strength - a.strength || a.time - b.time)
    .map((c) => c.time);
  const lower = Math.round((Math.min(g, HALF_G) / HALF_G) * strong.length);
  const base = addAllClear([...chosen], strong.slice(0, lower), duration, barGrid, snapGrid);
  if (g <= HALF_G || !repeat) return base;
  const weak = chosen.filter((t) => (strength.get(t) ?? 0) < floor);
  const { drop, cuts } = repeat(base, weak);
  const gone = new Set(drop);
  return addAllClear(base.filter((t) => !gone.has(t)), repeatOrder(cuts, g), duration, barGrid, snapGrid);
}

/** The times of `cuts` whose entry is at or below g, in entry order, then time: a prefix of one fixed order. */
export function repeatOrder(cuts: RepeatCut[], g: number): number[] {
  return cuts
    .filter((c) => c.entry <= g)
    .sort((a, b) => a.entry - b.entry || a.time - b.time)
    .map((c) => c.time);
}
