// Repetition splits for the top half of the Sections slider (feedback round 2, "More" that follows the music).
// Inside a section, find the period, in downbeats, at which a melody or riff repeats, and cut there. Pure; no Node
// imports (the dialog bundles it).
//
// Features: per stem and per downbeat interval, the stem's chroma (its timbre for drums) summed over the interval
// from the 2 Hz analysis (spanFeature), unit length. Each stem is scored on its own. Group by All scores the pitched
// stems (bass, vocals, other) audible in the section and takes the one whose cuts come in first (controller rulings,
// fb2: a melody can live in any pitched stem, mixing the stems diluted Flim's Other melody below the threshold, and a
// repeating drum loop is not what More should find). Group by Drums still scores drums, on its timbre. Group by
// Melody scores the chroma of vocals and other summed per frame, as its letters do.
//
// Scores, for a section of n downbeat intervals:
// - P = 2, 4, 8: the vectors are centred on the section's own mean, so what every downbeat shares (the key, the pad
//   that spans the section) drops out and what changes from one downbeat to the next is left. Pieces P apart are
//   compared with parts that are not aligned to P: the mean cosine at lags P, 3P, 5P… (odd multiples, so a
//   period of 2P does not pass for P) minus the mean at lags that are not multiples of P, over the spread of all
//   the section's cosines (a z score: periodZ). A section that does not divide into whole pieces loses UNEVEN_PENALTY.
// - P = 1: centring on the section would remove a one-downbeat loop entirely, so instead the vectors are centred on
//   the song's mean, and the score is how much more alike the section's downbeats are to each other than to the rest
//   of the song (sectionHomogeneity, a cosine difference). Only at the very top of the slider (UNIT_FROM_G), and only
//   once the section already splits at P = 2 (controller ruling, fb2: no one-downbeat pieces without a two-downbeat
//   repeat, which kept the top of the slider from filling with one-bar pieces).
//
// The slider (granularity.ts) lowers the score a section needs as g rises: TAU_HI just above the middle, TAU_LO at
// the top. A section is cut at the multiples of the smallest period whose score passes, counted from its first
// downbeat. The candidates are powers of two, so each period's cuts contain the coarser ones': as g rises a section
// only gains cuts.
import type { GroupBy } from "../dialog/protocol.js";
import { STEM_NAMES, type StructureAnalysis } from "../structure/contract.js";
import type { RepeatCut } from "./granularity.js";
import { SILENT_DB } from "./letters.js";
import { hasChroma, melodyAudible, sectionLoudness, spanFeature, type Source } from "./sectionVectors.js";
import { snapTime } from "./snap.js";

export type Period = 1 | 2 | 4 | 8;
const PERIODS: readonly Period[] = [1, 2, 4, 8];

/**
 * The z score a period needs just above the slider's middle, and at its top (fb2 report). On random downbeats the
 * score's 95th percentile is 1.7 to 2.0 (a simulation over 4 to 32 downbeats), so TAU_LO keeps chance alignments out
 * even at the top. Flim under Group by Other: the intro's melody scores 3.35 at P = 2 (in from g = 0.73), the
 * 86.98 to 112.95 s section 4.40 at P = 4 and 4.51 at P = 8 (in just above the middle).
 */
export const TAU_HI = 4.5;
export const TAU_LO = 2;
/** Taken off a period's score when the section is not a whole number of pieces ("prefer the period that divides"). */
export const UNEVEN_PENALTY = 1;
/** One-downbeat pieces (P = 1) only from here up. */
export const UNIT_FROM_G = 0.95;
/**
 * The homogeneity P = 1 needs at UNIT_FROM_G, and at the top. Flim's intro (Group by Other) is 0.61 and its
 * 86.98 to 112.95 s section 0.48; most sections of both songs are under 0.4.
 */
export const UNIT_HI = 0.8;
export const UNIT_LO = 0.4;
/** Grid points within this of a section edge count as on it (allin1's boundaries sit a few ms off its downbeats). */
const EDGE_SLACK_SEC = 0.05;
const HALF_G = 0.5;

/**
 * How clearly pieces `P` downbeats apart repeat, from the n × n similarity matrix `sim` (row-major) of a section's
 * centred downbeat vectors: the mean similarity at odd multiples of P minus the mean at lags that are not multiples
 * of P, divided by the spread of all the section's similarities times sqrt(1/count + 1/count) of those two sets.
 * Null when the section is not two whole pieces long (n < 2P), or its similarities have no spread.
 */
export function periodZ(sim: Float64Array, n: number, P: number): number | null {
  if (P < 2 || n < 2 * P) return null;
  let sOdd = 0, nOdd = 0, sCross = 0, nCross = 0, s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = sim[i * n + j];
      s += v;
      s2 += v * v;
      const lag = j - i;
      if (lag % P !== 0) {
        sCross += v;
        nCross++;
      } else if ((lag / P) % 2 === 1) {
        sOdd += v;
        nOdd++;
      }
    }
  }
  const pairs = (n * (n - 1)) / 2;
  const sd = Math.sqrt(Math.max(0, s2 / pairs - (s / pairs) ** 2));
  if (nOdd === 0 || nCross === 0 || !(sd > 1e-9)) return null;
  return (sOdd / nOdd - sCross / nCross) / (sd * Math.sqrt(1 / nOdd + 1 / nCross));
}

/** Where on the slider (g in [0.5, 1]) a period with score z starts to cut: Infinity when it never does. */
export function periodEntry(z: number): number {
  if (!(z >= TAU_LO)) return Infinity;
  return HALF_G + (1 - HALF_G) * Math.max(0, (TAU_HI - z) / (TAU_HI - TAU_LO));
}

/** Where one-downbeat pieces start, for a section with homogeneity h: UNIT_FROM_G at UNIT_HI and above, 1 at UNIT_LO. */
export function unitEntry(h: number): number {
  if (!(h >= UNIT_LO)) return Infinity;
  return UNIT_FROM_G + (1 - UNIT_FROM_G) * Math.max(0, (UNIT_HI - h) / (UNIT_HI - UNIT_LO));
}

/**
 * The entry (as periodEntry gives) of each cut k = 1 … n - 1 of a section of n downbeat intervals, given the entry of
 * each period that applies (missing: never). Cut k is in once the section's period divides k, which (all periods
 * are powers of two) is once any period up to the largest one dividing k has entered.
 */
export function cutEntries(n: number, entries: Partial<Record<Period, number>>): number[] {
  const out: number[] = [];
  for (let k = 1; k < n; k++) {
    let e = Infinity;
    for (const P of PERIODS) if (k % P === 0) e = Math.min(e, entries[P] ?? Infinity);
    out.push(e);
  }
  return out;
}

// ---- Features ----

interface StemBeats {
  /** Per grid interval: the stem's feature, unit length (all zeros when the stem is silent there). */
  u: Float64Array[];
  /** Per grid interval: unit(u - the song's mean of the non-zero u), or null where u is zero. */
  y: (Float64Array | null)[];
  /** The sum of the non-null y, and how many there are. */
  ySum: Float64Array;
  yCount: number;
}

// Memoised per analysis and grid (both must not be mutated after first use), like sectionVectors' stats.
const cache = new WeakMap<StructureAnalysis, WeakMap<number[], Partial<Record<Source, StemBeats>>>>();

function unit(v: Float64Array): Float64Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function stemBeats(a: StructureAnalysis, stem: Source, grid: number[]): StemBeats {
  let perGrid = cache.get(a);
  if (!perGrid) cache.set(a, (perGrid = new WeakMap()));
  let per = perGrid.get(grid);
  if (!per) perGrid.set(grid, (per = {}));
  const hit = per[stem];
  if (hit) return hit;

  const kind = hasChroma(stem) ? "chroma" : "timbre";
  const u: Float64Array[] = [];
  for (let k = 0; k + 1 < grid.length; k++) u.push(unit(spanFeature(a, stem, grid[k], grid[k + 1], kind)));
  const dim = u[0]?.length ?? 0;
  const mean = new Float64Array(dim);
  let count = 0;
  for (const v of u) {
    if (!v.some((x) => x !== 0)) continue;
    count++;
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  if (count > 0) for (let i = 0; i < dim; i++) mean[i] /= count;
  const ySum = new Float64Array(dim);
  const y = u.map((v) => {
    if (!v.some((x) => x !== 0)) return null;
    const c = unit(v.map((x, i) => x - mean[i]));
    for (let i = 0; i < dim; i++) ySum[i] += c[i];
    return c;
  });
  return (per[stem] = { u, y, ySum, yCount: count });
}

/** The grid intervals [first, first + n) a section covers: from the grid point nearest its start (as snapping puts it). */
function gridSpan(grid: number[], start: number, end: number, duration: number): { first: number; n: number } | null {
  const s = snapTime(start, grid);
  let first = grid.indexOf(s);
  if (first < 0) first = grid.findIndex((t) => t >= start - EDGE_SLACK_SEC);
  if (first < 0) return null;
  const e = end >= duration ? end : snapTime(end, grid);
  let last = first;
  while (last + 1 < grid.length && grid[last + 1] <= e + EDGE_SLACK_SEC) last++;
  return last > first ? { first, n: last - first } : null;
}

/** The n × n similarity of the section's downbeat vectors, each stem centred on its section mean. */
function sectionSim(beats: [StemBeats, number][], first: number, n: number): Float64Array {
  const sim = new Float64Array(n * n);
  for (const [b, w] of beats) {
    const rows = b.u.slice(first, first + n);
    const dim = rows[0].length;
    const mean = new Float64Array(dim);
    for (const r of rows) for (let i = 0; i < dim; i++) mean[i] += r[i] / n;
    const x = rows.map((r) => unit(r.map((v, i) => v - mean[i])));
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) sim[i * n + j] = sim[j * n + i] += w * dot(x[i], x[j]);
  }
  return sim;
}

/**
 * How much more alike the section's downbeats are to each other than to the rest of the song, on song-centred
 * vectors: the mean cosine within minus the mean cosine to the other downbeats, weighted over the stems. Null when
 * no stem has two downbeats to compare.
 */
function sectionHomogeneity(beats: [StemBeats, number][], first: number, n: number): number | null {
  let h = 0;
  let any = false;
  for (const [b, w] of beats) {
    const dim = b.ySum.length;
    const s = new Float64Array(dim);
    let m = 0;
    for (let k = first; k < first + n; k++) {
      const v = b.y[k];
      if (!v) continue;
      m++;
      for (let i = 0; i < dim; i++) s[i] += v[i];
    }
    if (m < 2) continue;
    const within = (dot(s, s) - m) / (m * (m - 1));
    const rest = b.yCount - m;
    const out = rest > 0 ? dot(s, b.ySum.map((x, i) => x - s[i])) / (m * rest) : 0;
    h += w * (within - out);
    any = true;
  }
  return any ? h : null;
}

/**
 * One section's scores: its grid intervals, the stem they come from (under All, the winning stem; for tests and
 * debugging, not shown), and the entry of each period that applies (missing: never).
 */
export interface SectionRepeat {
  first: number;
  n: number;
  stem: Source;
  z: Partial<Record<Period, number>>;
  entries: Partial<Record<Period, number>>;
}

/** One stem's scores for the section [first, first + n) of `grid`. */
function stemRepeat(a: StructureAnalysis, stem: Source, grid: number[], first: number, n: number): SectionRepeat {
  const beats: [StemBeats, number][] = [[stemBeats(a, stem, grid), 1]];
  const sim = sectionSim(beats, first, n);
  const z: Partial<Record<Period, number>> = {};
  const entries: Partial<Record<Period, number>> = {};
  for (const P of [2, 4, 8] as const) {
    const raw = periodZ(sim, n, P);
    if (raw === null) continue;
    z[P] = raw - (n % P === 0 ? 0 : UNEVEN_PENALTY);
    entries[P] = periodEntry(z[P]!);
  }
  const h = sectionHomogeneity(beats, first, n);
  if (h !== null) {
    z[1] = h;
    // One-downbeat pieces only where the section already splits at two downbeats.
    entries[1] = Math.max(unitEntry(h), entries[2] ?? Infinity);
  }
  return { first, n, stem, z, entries };
}

/** The slider value from which a section's first cut comes in (Infinity: never). */
const firstEntry = (r: SectionRepeat) => Math.min(Infinity, ...Object.values(r.entries));

/**
 * A section's repetition scores on the Group by stem; under All, those of the audible pitched stem whose first cut
 * comes in earliest (ties: the first in STEM_NAMES order). Null when the section has under two grid intervals or no audible stem.
 */
export function sectionRepeat(a: StructureAnalysis, groupBy: GroupBy, grid: number[], start: number, end: number, duration: number): SectionRepeat | null {
  const span = gridSpan(grid, start, end, duration);
  if (!span || span.n < 2) return null;
  const stems: Source[] =
    groupBy === "melody"
      ? melodyAudible(a, start, end) ? ["melody"] : []
      : (groupBy === "all" ? STEM_NAMES.filter(hasChroma) : [groupBy]).filter((s) => sectionLoudness(a, s, start, end) >= SILENT_DB);
  let best: SectionRepeat | null = null;
  for (const stem of stems) {
    const r = stemRepeat(a, stem, grid, span.first, span.n);
    if (!best || firstEntry(r) < firstEntry(best)) best = r;
  }
  return best;
}

/**
 * The repetition cuts of every section of `boundaries` (over [0, duration]) on `grid` (allin1's downbeats), each with
 * the slider value from which it is in, scored on the Group by stem (All: the audible pitched stem that repeats most
 * clearly). Cuts that never enter are left out. In time order.
 */
export function repeatCuts(a: StructureAnalysis, groupBy: GroupBy, grid: number[], boundaries: number[], duration: number): RepeatCut[] {
  if (grid.length < 3) return [];
  const edges = [0, ...boundaries, duration];
  const out: RepeatCut[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const r = sectionRepeat(a, groupBy, grid, edges[i], edges[i + 1], duration);
    if (!r) continue;
    cutEntries(r.n, r.entries).forEach((entry, k) => {
      if (entry <= 1) out.push({ time: grid[r.first + k + 1], entry });
    });
  }
  return out;
}

/** How much more clearly (in z) a merged span must repeat than either of its parts for a weak boundary to give way. */
export const CORRECTION_MARGIN = 1;
/** The furthest, in downbeats, a weak boundary moves onto the merged span's period. Further: it is dropped. */
export const MAX_MOVE_DOWNBEATS = 2;

/** The highest score at P = 2, 4 or 8 (-Infinity when none applies). */
const bestZ = (r: SectionRepeat | null) => Math.max(-Infinity, ...([2, 4, 8] as const).map((P) => r?.z[P] ?? -Infinity));

/**
 * The top half's plan (controller ruling, fb2): the base correction, then the repetition cuts.
 *
 * Base correction, the one place the slider removes boundaries: allin1 sometimes puts a weak boundary inside a
 * repeat (Flim, Matt's second reference: 44.83 s inside his B B, whose 13 s period only shows across it; 129.17 s inside
 * the second B B). For each boundary in `weak` (allin1's own, under the dialog's candidate floor), in time order: when
 * the span from the boundary before it to the one after it repeats (some period enters by g = 1) more clearly than
 * either part does, by CORRECTION_MARGIN, the boundary gives way. When neither part can be scored (each is under four
 * downbeats, or silent), there is nothing to beat, so the merged span must reach TAU_HI on its own (fb2 review M1: a
 * score of 2 is within the null distribution's 95th percentile). It moves onto the nearest of the merged span's cuts
 * when that is within MAX_MOVE_DOWNBEATS downbeats (the moved boundary comes in with every g above the middle), or
 * else is dropped. The plan is the same for every g above the middle, so the top half stays monotonic from its first
 * step on; only the step across the middle can remove the boundaries in `drop`.
 *
 * Returns the boundaries to drop and the cuts to add (with their entries), the moved ones at entry 0.5.
 */
export function repeatPlan(
  a: StructureAnalysis,
  groupBy: GroupBy,
  grid: number[],
  boundaries: number[],
  duration: number,
  weak: number[] = [],
): { drop: number[]; cuts: RepeatCut[] } {
  if (grid.length < 3) return { drop: [], cuts: [] };
  const list = [...boundaries];
  const drop: number[] = [];
  const moved: RepeatCut[] = [];
  for (const b of [...weak].sort((x, y) => x - y)) {
    const i = list.indexOf(b);
    if (i < 0) continue;
    const lo = i > 0 ? list[i - 1] : 0;
    const hi = i + 1 < list.length ? list[i + 1] : duration;
    const merged = sectionRepeat(a, groupBy, grid, lo, hi, duration);
    const P = ([2, 4, 8] as const).find((q) => (merged?.entries[q] ?? Infinity) <= 1);
    if (!merged || P === undefined) continue;
    const parts = Math.max(bestZ(sectionRepeat(a, groupBy, grid, lo, b, duration)), bestZ(sectionRepeat(a, groupBy, grid, b, hi, duration)));
    if (!(parts === -Infinity ? merged.z[P]! >= TAU_HI : merged.z[P]! > parts + CORRECTION_MARGIN)) continue;
    list.splice(i, 1);
    drop.push(b);
    const at = grid.indexOf(snapTime(b, grid));
    let best = -1;
    for (let k = merged.first + P; k < merged.first + merged.n; k += P) {
      if (at >= 0 && Math.abs(k - at) <= MAX_MOVE_DOWNBEATS && (best < 0 || Math.abs(k - at) < Math.abs(best - at))) best = k;
    }
    if (best >= 0) moved.push({ time: grid[best], entry: HALF_G });
  }
  const to = new Set(moved.map((c) => c.time));
  return { drop, cuts: [...moved, ...repeatCuts(a, groupBy, grid, list, duration).filter((c) => !to.has(c.time))] };
}
