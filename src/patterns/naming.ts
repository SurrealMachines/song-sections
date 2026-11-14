// Naming a lane's slices by similarity (Plan 5, Task 6). Browser-safe: no Node imports.
//
// Every sounding slice of the lane is compared with every other, across sections, and the slices are grouped by
// average-linkage clustering of that matrix (spike 3): the two groups whose slices are most alike on average merge,
// while that average is SAME or more (on a noisy source SAME and VARIANT move towards their _STEMS values: see
// similarity's tuned). A slice joins a group only when it is close to the group as a whole, so a generic slice that is
// a bit like everything cannot chain unrelated slices together (spike 2's "F everywhere"). Only
// slices of the same bar count are ever alike. Nothing depends on the order the slices come in: they are taken in time
// order, and only time order breaks ties. Given the lane's sections, groups merge within a section first, and only then
// across sections: a repeat inside one section (one take, one mix) is surer than a likeness to another section's slice.
// So Flim's Intro 1 stays B B B B, though its third phrase is more like Instrumental 3's first and third (0.73 on
// average; that section is B′, B's melody over other chords) than like its own neighbours (0.69).
//
// Groups are then linked, bigger groups first (a tie: the earlier one), each to an earlier plain group that plays
// before it does. A group is a transposition of one that has TRANSPOSE_MIN_MEMBERS slices or more when, on average
// over their pairs, the rotated score is SAME or more, beats the unshifted score by TRANSPOSE_GAIN and the median over
// the 12 rotations by TRANSPOSE_OVER_MEDIAN, all pairs at the one rotation (spike 2's guards). Failing that, it is a
// variation of the plain group it is closest to on average, if that is VARIANT or more. Both show as a prime. Anything
// weaker is a new number, never a prime, and since a link goes only to a group that plays earlier, the first slice
// of a pattern is never a prime. Patterns are numbered from 1 in time order of their first slice.
import type { SliceName, Span } from "./contract.js";
import { tuned, type Comparison, type Similarity } from "./similarity.js";

/** Slices this alike on average, or more, are one pattern (on a clean source; SAME_STEMS on real stems, see tuned). */
export const SAME = 0.9;
/** A group this alike an earlier pattern on average, or more (and below SAME), is a close variation of it. */
export const VARIANT = 0.7;
/**
 * SAME and VARIANT on real stems (see tuned), fitted on Matt's answer key and Kashmir. There a repeated 4-bar phrase
 * scores 0.63 to 0.80 (Flim's Intro 1, whose weakest join is 0.693), and bars spike 2 told apart score 0.52 at their
 * 90th percentile (Kashmir's A against B: 0.66). SAME passes the gate from 0.55 to 0.69; VARIANT below 0.55 makes
 * Kashmir's A, B and C bars variants of each other.
 */
export const SAME_STEMS = 0.65;
export const VARIANT_STEMS = 0.6;
// Spike 2's transposition guard, pinned by the spec ("If shown, it needs the guards from spike 2"):
export const TRANSPOSE_GAIN = 0.15; // best must beat the unshifted score by this
export const TRANSPOSE_OVER_MEDIAN = 0.3; // and beat the median of the 12 rotations by this
export const TRANSPOSE_MIN_MEMBERS = 2; // and the pattern must already have this many unshifted members

interface Group {
  members: number[]; // indices into the time-ordered sounding slices, ascending
  bars: number;
}

/**
 * One name per slice: patterns numbered from 1 by first occurrence; rests { pattern: null, variant: false }. With
 * `sections` (the lane's, in any order), slices group within each section before they group across sections.
 */
export function nameSlices(sim: Similarity, slices: Span[], sections: Span[] = []): SliceName[] {
  const out: SliceName[] = slices.map(() => ({ pattern: null, variant: false }));
  const same = tuned(sim, SAME, SAME_STEMS);
  const variant = tuned(sim, VARIANT, VARIANT_STEMS);
  // the sounding slices in time order, so that nothing below depends on the order they came in
  const order = slices
    .map((_, i) => i)
    .filter((i) => !sim.rest(slices[i]))
    .sort((i, j) => slices[i].start - slices[j].start || slices[i].end - slices[j].end || i - j);
  const m = order.length;
  if (m === 0) return out;
  const span = (u: number) => slices[order[u]];
  const compare = (u: number, v: number): Comparison | null => sim.compare(span(u), span(v));
  const score = sim.score ? (u: number, v: number) => sim.score!(span(u), span(v)) : (u: number, v: number) => compare(u, v)?.score ?? null;

  // all against all: the unshifted score of every pair, summed per pair of groups as they merge
  const sum = Array.from({ length: m }, () => new Float64Array(m));
  for (let u = 0; u < m; u++) {
    for (let v = u + 1; v < m; v++) sum[u][v] = sum[v][u] = score(u, v) ?? 0;
  }
  // the section each slice is in (by its midpoint), -1 for none
  const sectionOf = Array.from({ length: m }, (_, u) => {
    const mid = (span(u).start + span(u).end) / 2;
    return sections.findIndex((s) => mid >= s.start && mid < s.end);
  });
  const groups: (Group | null)[] = Array.from({ length: m }, (_, u) => ({ members: [u], bars: sim.bars(span(u)) }));
  let inside = true; // first only groups within one section merge, then any
  const pairs = (g: number, h: number) => groups[h]!.bars === groups[g]!.bars && (!inside || (sectionOf[g] >= 0 && sectionOf[g] === sectionOf[h]));
  const mean = (g: number, h: number) => sum[g][h] / (groups[g]!.members.length * groups[h]!.members.length);
  // Each group's closest later group of its bar count (`top` their mean, `at` its index, the first on a tie; -1 for none),
  // kept up to date across merges, so that each merge rescans only the rows it changed. The pair merged is the one a
  // full scan in (g, h) order would pick: the first row with the highest top, at its `at`.
  const top = new Float64Array(m).fill(-Infinity);
  const at = new Int32Array(m).fill(-1);
  const scan = (g: number) => {
    [top[g], at[g]] = [-Infinity, -1];
    for (let h = g + 1; h < m; h++) {
      if (!groups[h] || !pairs(g, h)) continue;
      const s = mean(g, h);
      if (s > top[g]) [top[g], at[g]] = [s, h];
    }
  };
  for (let g = 0; g < m; g++) scan(g);
  for (;;) {
    let bg = -1;
    for (let g = 0; g < m; g++) if (groups[g] && at[g] >= 0 && (bg < 0 || top[g] > top[bg])) bg = g;
    if (bg < 0 || top[bg] < same) {
      if (!inside) break;
      inside = false;
      for (let g = 0; g < m; g++) if (groups[g]) scan(g);
      continue;
    }
    const bh = at[bg];
    // h joins g; g is the group of the earlier slice, so a group's index is its first slice
    groups[bg]!.members = [...groups[bg]!.members, ...groups[bh]!.members].sort((p, q) => p - q);
    for (let k = 0; k < m; k++) {
      sum[bg][k] += sum[bh][k];
      sum[k][bg] = sum[bg][k];
    }
    groups[bh] = null;
    scan(bg);
    // rows after bh never held bg or bh; a row before bh that pointed at either is rescanned, and one before bg may
    // now point at bg
    for (let k = 0; k < bh; k++) {
      if (k === bg || !groups[k] || !pairs(k, bg)) continue;
      if (at[k] === bg || at[k] === bh) scan(k);
      else if (k < bg) {
        const s = mean(k, bg);
        if (s > top[k] || (s === top[k] && bg < at[k])) [top[k], at[k]] = [s, bg];
      }
    }
  }
  const live = groups.flatMap((g, i) => (g ? [i] : []));

  /** The transposition guard between an earlier pattern r and a group g: their mean rotated score, or null if it fails. */
  function transposed(r: number, g: number): number | null {
    const R = groups[r]!.members;
    if (R.length < TRANSPOSE_MIN_MEMBERS) return null;
    let score = 0;
    let best = 0;
    let median = 0;
    let shift = -1;
    for (const x of R) {
      for (const y of groups[g]!.members) {
        const c = compare(x, y);
        if (!c || c.shift === 0 || (shift >= 0 && c.shift !== shift)) return null; // one transposition, the same for all
        shift = c.shift;
        score += c.score;
        best += c.best;
        median += c.median;
      }
    }
    const n = R.length * groups[g]!.members.length;
    [score, best, median] = [score / n, best / n, median / n];
    return best >= same && best >= score + TRANSPOSE_GAIN && best >= median + TRANSPOSE_OVER_MEDIAN ? best : null;
  }

  // links: bigger groups first, each to an earlier plain group (one not itself linked) that plays before it
  const linkOf = new Map<number, number>();
  const plain: number[] = [];
  const bySize = [...live].sort((g, h) => groups[h]!.members.length - groups[g]!.members.length || g - h);
  for (const g of bySize) {
    const refs = plain.filter((r) => r < g && groups[r]!.bars === groups[g]!.bars);
    let to = -1;
    let top = -Infinity;
    for (const r of refs) {
      const t = transposed(r, g);
      if (t !== null && t > top) [to, top] = [r, t];
    }
    if (to < 0) {
      let closest = -Infinity;
      for (const r of refs) {
        const s = mean(r, g);
        if (s > closest) [to, closest] = [r, s];
      }
      if (closest < variant) to = -1;
    }
    if (to >= 0) linkOf.set(g, to);
    else plain.push(g);
  }

  // numbers in time order of each pattern's first slice, which is its plain group's first slice
  const number = new Map([...plain].sort((g, h) => g - h).map((g, k) => [g, k + 1]));
  for (const g of live) {
    const to = linkOf.get(g);
    const name: SliceName = { pattern: number.get(to ?? g)!, variant: to !== undefined };
    for (const u of groups[g]!.members) out[order[u]] = { ...name };
  }
  return out;
}
