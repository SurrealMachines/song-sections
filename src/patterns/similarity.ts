// Span similarity and rests for one source (Plan 5, Task 3). Browser-safe: no Node imports.
//
// A span is read in bar time, not in seconds: each of the corrected-grid bars it covers is resampled into STEPS_PER_BAR
// steps, so a stretched bar compares as its music. Two spans of the same bar count compare bar by bar, position by
// position. A bar's score is the cosine of its z-scored, weighted steps, where the other bar may sit one step early or
// late at a small cost (an off-grid onset can land a cell late, or split across two cells). A span's score is the mean
// of its bars' scores. A tonal source (and the mix) is also scored with its chroma rotated by each of the 12
// semitones, for transpositions (only once best, shift or median is read: the split and the grouping need only the
// unshifted score); the shape and onset dims are never rotated.
//
// How faithfully a source repeats is measured once, as its repeat fidelity: real stems never repeat as exactly as a
// synth does (bleed, reverb tails, legato and a player's timing all differ from one take of a bar to the next), so the
// same bar played again scores about 0.8 there, not 1. The thresholds of the split and the naming are fitted at both
// ends, exact repeats (clean synthesis, the unit tests) and Demucs stems of real songs (Matt's answer key), and
// `tuned` moves each one between the two by the source's repeat fidelity.
//
// What is kept is bounded, whatever the clip's length and however long the dialog stays open: the steps of at most
// KEPT_BARS bars of spans, the unshifted scores of at most KEPT_PAIRS pairs and the rotations of KEPT_ROTATIONS, each
// the most recently used (see Recent). A Comparison holds only its numbers and computes its rotations when first read.
//
// Rests are decided per span, from loudness alone, against the loudest source of the clip (`referenceDb`): a span is a
// rest when none of its bars reaches the gate. Never per cell: real stems have no silent cells between notes, and a
// near-silent cell still shows small onset values from noise.
import { CELL_RATE, LOUD_FLOOR_DB, barsIn, type GridBar, type SourceKind, type Span } from "./contract.js";
import { FEATURE_LAYOUT, type DecodedSource } from "./features.js";

export interface Comparison {
  score: number; // unshifted similarity: 1 the same, about 0 unrelated, can be negative
  best: number; // the best score over chroma rotations (= score for drums)
  shift: number; // the rotation (semitones 0..11, b's chroma = a's rotated up by shift) that gave `best`; 0 for drums
  median: number; // the median score over the 12 rotations (= score for drums)
}
export interface Similarity {
  bars(s: Span): number; // corrected-grid bars the span covers (barsIn), at least 1
  compare(a: Span, b: Span): Comparison | null; // null when bars(a) !== bars(b), or either is a rest
  rest(s: Span): boolean;
  /**
   * compare(a, b)?.score ?? null, without making the Comparison (naming reads only the scores of most pairs); kept as
   * compare's are unless `keep` is false (the split, which keeps its own for as long as it needs them).
   */
  score?(a: Span, b: Span, opts?: { keep?: boolean }): number | null;
}

/** A span is a rest when no bar of it is within this many dB of the clip's loudest source (its 90th-percentile bar). */
export const REST_BELOW_DB = 27;
/** ...or when no bar of it reaches this, whatever the reference (an all-quiet clip is all rests). */
export const REST_FLOOR_DB = -60;

/** A source that repeats this faithfully or more (clean synthesis with repeats measures 1) takes the clean values... */
export const CLEAN_FIDELITY = 0.98;
/** ...and this faithfully or less the stems' (Flim's and Kashmir's stems measure 0.59 to 0.92); between, a share. */
export const STEM_FIDELITY = 0.95;
// The percentile of the bars' best matches: a high one, so that a source with exact repeats reads as exact even where
// some of its bars repeat nowhere.
const FIDELITY_PERCENTILE = 0.75;
// Fewer sounding bars say too little about a source. It is taken as a stem (real input is the likelier case there:
// a sparse stem of a real song, such as a vocal heard in a few bars).
const FIDELITY_MIN_BARS = 8;
const FIDELITY_REACH = 32; // a bar looks for its best match this many bars either side
const FIDELITY_PROBES = 48; // and so many bars do (evenly spread): the cost does not grow with the clip

// What a Similarity keeps, at most (see Recent: what was used in the last half of it is surely still there). Full, the
// three hold about 11 + 16 + 8 MB.
/** Spans, by their bars (about 1.3 kB a bar of steps): a 30-minute lane's slices, and its bars and their nudges. */
export const KEPT_BARS = 8192;
/** Pair scores (about 60 B a pair): naming a lane of 500 slices all against all, again after an edit. */
export const KEPT_PAIRS = 1 << 18;
/** Pair rotations (about 125 B a pair): what naming's transposition guard asks of a lane, several times over. */
export const KEPT_ROTATIONS = 1 << 16;
const MAX_IDS = 2 ** 26; // span ids stay below this, so a pair of them is one exact number

const STEPS_PER_BAR = 16; // the spikes needed 8–16; 16 resolves sixteenths
const SHIFTED = 0.97; // a match one step early or late keeps this much of its score (spike 1)
const ROTATIONS = 12;

/** Per-group weights after z-scoring (spike 1: chroma 1, spectral shape 0.6, its one rhythm dim 1.2). */
export const WEIGHTS: Record<SourceKind, { chroma: number; shape: number; flux: number }> = {
  tonal: { chroma: 1, shape: 0.6, flux: 1.2 },
  mix: { chroma: 1, shape: 0.6, flux: 1 },
  drums: { chroma: 0, shape: 0.6, flux: 1 },
};

const toDb = (power: number) => (power > 0 ? Math.max(LOUD_FLOOR_DB, 10 * Math.log10(power)) : LOUD_FLOOR_DB);

/** Mean power of cells, overlap-weighted over [t0, t1) seconds; 0 outside the cells. */
function meanPower(power: Float64Array, t0: number, t1: number): number {
  const a = Math.max(0, t0 * CELL_RATE);
  const b = Math.min(power.length, t1 * CELL_RATE);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = Math.floor(a); i < b; i++) sum += power[i] * (Math.min(b, i + 1) - Math.max(a, i));
  return sum / (b - a);
}

function cellPowers(src: DecodedSource): Float64Array {
  return Float64Array.from(src.loudDb, (db) => (db <= LOUD_FLOOR_DB ? 0 : 10 ** (db / 10)));
}

/** The source's 90th-percentile bar loudness in dBFS (RMS over each bar); the whole clip's without a grid. */
export function sourceLevelDb(src: DecodedSource, grid: GridBar[]): number {
  const power = cellPowers(src);
  if (grid.length === 0) return toDb(meanPower(power, 0, src.cells / CELL_RATE));
  const db = grid.map((b) => toDb(meanPower(power, b.start, b.end))).sort((p, q) => p - q);
  return db[Math.floor(0.9 * (db.length - 1))];
}

/** Piecewise-linear map between seconds and bar position (bar i spans [i, i + 1)); seconds themselves without a grid. */
function barClock(grid: GridBar[]): { pos(t: number): number; time(p: number): number } {
  if (grid.length === 0) return { pos: (t) => t, time: (p) => p };
  const len = (i: number) => Math.max(1e-9, grid[i].end - grid[i].start);
  return {
    pos(t) {
      let lo = 0;
      let hi = grid.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (grid[mid].start <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo + (t - grid[lo].start) / len(lo);
    },
    time(p) {
      const i = Math.min(grid.length - 1, Math.max(0, Math.floor(p)));
      return grid[i].start + (p - i) * len(i);
    },
  };
}

/**
 * The source's cells z-scored per dim (chroma pooled over its 12 classes), then weighted by WEIGHTS, as Float32
 * [cells · dims]. The statistics come from the `include`d cells (every cell when none is). Shared with grid.ts.
 */
export function zScoreCells(src: DecodedSource, include: Uint8Array): Float32Array {
  const { dims, cells, data, kind } = src;
  const layout = FEATURE_LAYOUT[kind];
  let n = 0;
  for (let i = 0; i < cells; i++) n += include[i];
  const all = n === 0; // nothing sounding: use every cell
  const sum = new Float64Array(dims);
  const sq = new Float64Array(dims);
  for (let i = 0; i < cells; i++) {
    if (!all && !include[i]) continue;
    for (let d = 0; d < dims; d++) {
      const x = data[i * dims + d];
      sum[d] += x;
      sq[d] += x * x;
    }
  }
  const count = Math.max(1, all ? cells : n);
  const mean = new Float64Array(dims);
  const sd = new Float64Array(dims);
  const stats = (s: number, q: number, c: number): [number, number] => {
    const m = s / c;
    return [m, Math.sqrt(Math.max(1e-12, q / c - m * m))];
  };
  for (let d = 0; d < dims; d++) [mean[d], sd[d]] = stats(sum[d], sq[d], count);
  const weight = new Float64Array(dims);
  const w = WEIGHTS[kind];
  const fill = (at: number, len: number, v: number) => weight.fill(v, at, at + len);
  fill(layout.shape.at, layout.shape.n, w.shape);
  fill(layout.flux.at, layout.flux.n, w.flux);
  if (layout.chroma) {
    // one mean and sd over all 12 classes, so that rotating the chroma commutes with the normalisation (spike 2)
    const { at, n: k } = layout.chroma;
    let s = 0;
    let q = 0;
    for (let d = at; d < at + k; d++) {
      s += sum[d];
      q += sq[d];
    }
    const [m, sdev] = stats(s, q, count * k);
    mean.fill(m, at, at + k);
    sd.fill(sdev, at, at + k);
    fill(at, k, w.chroma);
  }
  const z = new Float32Array(cells * dims);
  for (let i = 0; i < cells; i++) {
    for (let d = 0; d < dims; d++) z[i * dims + d] = ((data[i * dims + d] - mean[d]) / sd[d]) * weight[d];
  }
  return z;
}

interface SpanData {
  id: number; // the span's number in this Similarity, below MAX_IDS
  bars: number;
  rest: boolean;
  p0: number; // its start and end in bar position (barClock)
  p1: number;
  steps: Float32Array | null; // [bars · STEPS_PER_BAR · dims], on first compare; never for a rest
  energy: Float64Array | null; // [bars · STEPS_PER_BAR]: each step's sum of squares, with the steps
}

const key = (s: Span) => `${s.start},${s.end}`;

/**
 * A cache of the recently used, in two generations: entries go into the young one, and once it weighs half of `kept`
 * it becomes the old one and the old one goes; an entry found in the old one moves back into the young. So it holds no
 * more than `kept` (by weight, 1 an entry unless said), and an entry used in the last half of that stays, at the cost
 * of one Map lookup or two (a true LRU pays a delete and a set on every hit).
 */
class Recent<K, V> {
  private young = new Map<K, V>();
  private old = new Map<K, V>();
  private weight = 0; // of the young generation
  constructor(
    private readonly kept: number,
    private readonly weigh: (v: V) => number = () => 1,
  ) {}
  get(k: K): V | undefined {
    const v = this.young.get(k);
    if (v !== undefined) return v;
    const o = this.old.get(k);
    if (o !== undefined) this.set(k, o);
    return o;
  }
  set(k: K, v: V) {
    this.young.set(k, v);
    this.weight += this.weigh(v);
    if (this.weight >= this.kept / 2) {
      [this.old, this.young, this.weight] = [this.young, new Map(), 0];
    }
  }
  clear() {
    this.young.clear();
    this.old.clear();
    this.weight = 0;
  }
}

const fidelities = new WeakMap<Similarity, () => number | null>();

/**
 * How faithfully a source repeats: a sounding grid bar's best unshifted score against any other sounding bar within
 * FIDELITY_REACH bars, taken for FIDELITY_PROBES bars spread evenly over the clip, at their FIDELITY_PERCENTILE. It
 * measures repetition, not noise: 1 when most bars have an exact repeat, about 0.9 on a real stem, low on music that
 * never repeats (which then takes the stem values; nothing in it is alike anyway). null when the clip has fewer than
 * FIDELITY_MIN_BARS sounding bars. A Similarity that createSimilarity did not make (a test's hand-written matrix) is
 * taken as exact: 1.
 */
export function repeatFidelity(sim: Similarity): number | null {
  const f = fidelities.get(sim);
  return f ? f() : 1;
}

/**
 * `clean` on a source of exact repeats, `stems` on one at STEM_FIDELITY or less (or too short to tell), and in
 * proportion between (see repeatFidelity).
 */
export function tuned(sim: Similarity, clean: number, stems: number): number {
  const f = repeatFidelity(sim);
  const share = f === null ? 1 : Math.min(1, Math.max(0, (CLEAN_FIDELITY - f) / (CLEAN_FIDELITY - STEM_FIDELITY)));
  return clean + (stems - clean) * share;
}

export function createSimilarity(src: DecodedSource, grid: GridBar[], opts: { referenceDb: number }): Similarity {
  const { dims, cells } = src;
  const chroma = FEATURE_LAYOUT[src.kind].chroma;
  const rotations = chroma ? ROTATIONS : 1;
  const gate = Number.isFinite(opts.referenceDb) ? Math.max(REST_FLOOR_DB, opts.referenceDb - REST_BELOW_DB) : REST_FLOOR_DB;
  const power = cellPowers(src);
  const clock = barClock(grid);

  // The normalisation's statistics come from the cells of the bars that are not rests.
  const units = grid.length ? grid : [{ start: 0, end: cells / CELL_RATE }];
  const include = new Uint8Array(cells);
  for (const u of units) {
    if (toDb(meanPower(power, u.start, u.end)) < gate) continue;
    const a = Math.max(0, Math.ceil(u.start * CELL_RATE - 0.5));
    const b = Math.min(cells, Math.ceil(u.end * CELL_RATE - 0.5));
    include.fill(1, a, b);
  }
  const z = zScoreCells(src, include);

  /** The overlap-weighted mean of the z-scored cells over [t0, t1) into out[at..at + dims); zeros outside the cells. */
  function window(t0: number, t1: number, out: Float32Array, at: number) {
    let a = Math.max(0, t0 * CELL_RATE);
    let b = Math.min(cells, t1 * CELL_RATE);
    if (b <= a) {
      // an empty window (a span of no length) takes the cell it falls in; past the clip, zeros
      const i = Math.floor(t0 * CELL_RATE);
      if (i < 0 || i >= cells) return;
      [a, b] = [i, i + 1];
    }
    let total = 0;
    for (let i = Math.floor(a); i < b; i++) {
      const w = Math.min(b, i + 1) - Math.max(a, i);
      total += w;
      for (let d = 0; d < dims; d++) out[at + d] += w * z[i * dims + d];
    }
    for (let d = 0; d < dims; d++) out[at + d] /= total;
  }

  // The spans seen, KEPT_BARS bars of them at most (a span weighs its bars, steps or not).
  const spans = new Recent<string, SpanData>(KEPT_BARS, (sd) => sd.bars);
  let nextId = 0;
  // The pairs' unshifted scores and their rotations, from the lower id to the higher.
  const memo = new Recent<number, number>(KEPT_PAIRS); // pairKey → score
  const turns = new Recent<number, Omit<Comparison, "score">>(KEPT_ROTATIONS); // pairKey → rotations
  // The same Span object is asked about again and again (naming compares every slice with every other), so it is
  // found by identity first, without building its key; its start and end are checked, in case the caller changed them.
  let seen = new WeakMap<Span, { start: number; end: number; sd: SpanData }>();
  function spanData(s: Span): SpanData {
    const o = seen.get(s);
    if (o && o.start === s.start && o.end === s.end) return o.sd;
    const k = key(s);
    let sd = spans.get(k);
    if (sd) {
      seen.set(s, { start: s.start, end: s.end, sd });
      return sd;
    }
    if (nextId === MAX_IDS) {
      // ids would no longer pair exactly: start afresh (after 67 million spans, if ever)
      [nextId, seen] = [0, new WeakMap()];
      spans.clear();
      memo.clear();
      turns.clear();
    }
    const n = barsIn(grid, s);
    const p0 = clock.pos(s.start);
    const p1 = clock.pos(s.end);
    const at = (u: number) => clock.time(p0 + u * (p1 - p0)); // u in [0, 1] across the span, in bar time
    let loudest = -Infinity;
    for (let b = 0; b < n; b++) loudest = Math.max(loudest, toDb(meanPower(power, at(b / n), at((b + 1) / n))));
    sd = { id: nextId++, bars: n, rest: loudest < gate, p0, p1, steps: null, energy: null };
    spans.set(k, sd);
    seen.set(s, { start: s.start, end: s.end, sd });
    return sd;
  }

  /** The span's steps and their energies, computed on first use. Never asked of a rest. */
  function stepsOf(sd: SpanData): { steps: Float32Array; energy: Float64Array } {
    if (!sd.steps || !sd.energy) {
      const { p0, p1 } = sd;
      const at = (u: number) => clock.time(p0 + u * (p1 - p0));
      const N = sd.bars * STEPS_PER_BAR;
      const steps = new Float32Array(N * dims);
      for (let j = 0; j < N; j++) window(at(j / N), at((j + 1) / N), steps, j * dims);
      const energy = new Float64Array(N);
      for (let j = 0; j < N; j++) for (let d = 0; d < dims; d++) energy[j] += steps[j * dims + d] ** 2;
      [sd.steps, sd.energy] = [steps, energy];
    }
    return { steps: sd.steps, energy: sd.energy };
  }

  // per-bar scratch: the chroma cross-products and the score at each rotation
  const cross = new Float64Array(144);
  const barBest = new Float64Array(rotations);
  const sums = new Float64Array(rotations);
  const c0 = chroma?.at ?? 0;
  const cn = chroma?.n ?? 0;

  /** Score sums over the bars at each rotation, into `sums`. */
  function scoreBars(a: Float32Array, b: Float32Array, n: number) {
    sums.fill(0);
    for (let bar = 0; bar < n; bar++) {
      barBest.fill(-Infinity);
      const first = bar * STEPS_PER_BAR;
      for (let shift = -1; shift <= 1; shift++) {
        let aa = 0;
        let bb = 0;
        let fixed = 0; // the dot product of the dims that never rotate
        cross.fill(0);
        for (let j = Math.max(0, -shift); j < Math.min(STEPS_PER_BAR, STEPS_PER_BAR - shift); j++) {
          const ra = (first + j) * dims;
          const rb = (first + j + shift) * dims;
          for (let d = 0; d < dims; d++) {
            const x = a[ra + d];
            const y = b[rb + d];
            aa += x * x;
            bb += y * y;
            if (d < c0 || d >= c0 + cn) fixed += x * y;
          }
          for (let p = 0; p < cn; p++) {
            const x = a[ra + c0 + p];
            for (let q = 0; q < cn; q++) cross[p * 12 + q] += x * b[rb + c0 + q];
          }
        }
        const norm = Math.sqrt(aa * bb) + 1e-12;
        const keep = shift === 0 ? 1 : SHIFTED;
        for (let k = 0; k < rotations; k++) {
          let dot = fixed;
          for (let p = 0; p < cn; p++) dot += cross[p * 12 + ((p + k) % 12)];
          barBest[k] = Math.max(barBest[k], (keep * dot) / norm);
        }
      }
      for (let k = 0; k < rotations; k++) sums[k] += barBest[k];
    }
  }

  /**
   * The unshifted score sum over the bars: scoreBars' sums[0] (the same up to float rounding), from plain dot products
   * and the steps' stored energies, without the chroma cross-products of the other 11 rotations (the split and the
   * grouping read only this; the rotations wait until asked for).
   */
  function scoreUnshifted(a: SpanData, b: SpanData): number {
    const { steps: x, energy: ex } = stepsOf(a);
    const { steps: y, energy: ey } = stepsOf(b);
    let total = 0;
    for (let bar = 0; bar < a.bars; bar++) {
      let top = -Infinity;
      const first = bar * STEPS_PER_BAR;
      for (let shift = -1; shift <= 1; shift++) {
        let aa = 0;
        let bb = 0;
        let dot = 0;
        for (let j = Math.max(0, -shift); j < Math.min(STEPS_PER_BAR, STEPS_PER_BAR - shift); j++) {
          const ra = (first + j) * dims;
          const rb = (first + j + shift) * dims;
          aa += ex[first + j];
          bb += ey[first + j + shift];
          for (let d = 0; d < dims; d++) dot += x[ra + d] * y[rb + d];
        }
        const norm = Math.sqrt(aa * bb) + 1e-12;
        top = Math.max(top, ((shift === 0 ? 1 : SHIFTED) * dot) / norm);
      }
      total += top;
    }
    return total;
  }

  /** best, shift and median over the 12 rotations, for spans already known to compare; `score` is scores[0]. */
  function rotated(a: Float32Array, b: Float32Array, n: number, score: number): Omit<Comparison, "score"> {
    scoreBars(a, b, n);
    const scores = Array.from(sums, (s) => s / n);
    scores[0] = score; // scoreUnshifted's value, so that best ≥ score whatever the rounding
    let shift = 0;
    for (let r = 1; r < rotations; r++) if (scores[r] > scores[shift]) shift = r;
    const sorted = [...scores].sort((p, q) => p - q);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { best: scores[shift], shift, median };
  }

  /** A Comparison whose rotations are computed on first read of best, shift or median. */
  function lazy(score: number, rotate: () => Omit<Comparison, "score">): Comparison {
    let r: Omit<Comparison, "score"> | null = null;
    const get = () => (r ??= rotate());
    return {
      score,
      get best() {
        return get().best;
      },
      get shift() {
        return get().shift;
      },
      get median() {
        return get().median;
      },
    };
  }

  let fidelity: number | null | undefined;
  function measureFidelity(): number | null {
    const sounding = grid.map((b) => spanData({ start: b.start, end: b.end })).filter((sd) => !sd.rest);
    if (sounding.length < FIDELITY_MIN_BARS) return null;
    // at most FIDELITY_PROBES bars, evenly spread, each against every sounding bar within reach (a bounded cost)
    const probes = Math.min(sounding.length, FIDELITY_PROBES);
    const best: number[] = [];
    for (let k = 0; k < probes; k++) {
      const i = Math.floor((k * sounding.length) / probes);
      let top = -Infinity;
      for (let j = Math.max(0, i - FIDELITY_REACH); j <= Math.min(sounding.length - 1, i + FIDELITY_REACH); j++) {
        if (j !== i) top = Math.max(top, scoreUnshifted(sounding[i], sounding[j]) / sounding[i].bars);
      }
      best.push(top);
    }
    const sorted = best.sort((p, q) => p - q);
    return Math.min(1, sorted[Math.floor(FIDELITY_PERCENTILE * (sorted.length - 1))]);
  }

  const pairKey = (a: SpanData, b: SpanData) => (a.id < b.id ? a.id * MAX_IDS + b.id : b.id * MAX_IDS + a.id);
  /** The pair's unshifted score, for spans that compare: kept, or computed and kept (unless `keep` is false). */
  function pairScore(da: SpanData, db: SpanData, keep: boolean): number {
    const k = pairKey(da, db);
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    // the lower id first, so that both ways round give the very same number
    const score = (da.id <= db.id ? scoreUnshifted(da, db) : scoreUnshifted(db, da)) / da.bars;
    if (keep) memo.set(k, score);
    return score;
  }
  const compares = (da: SpanData, db: SpanData) => !da.rest && !db.rest && da.bars === db.bars;

  const sim: Similarity = {
    bars: (s) => spanData(s).bars,
    rest: (s) => spanData(s).rest,
    compare(a, b) {
      const da = spanData(a);
      const db = spanData(b);
      if (!compares(da, db)) return null;
      const score = pairScore(da, db, true);
      if (!chroma) return { score, best: score, shift: 0, median: score };
      // the rotations from the lower id to the higher; the other way round is the rotation back down, with the same scores
      return lazy(score, () => {
        const [lo, hi] = da.id <= db.id ? [da, db] : [db, da];
        const k = pairKey(da, db);
        let r = turns.get(k);
        if (!r) turns.set(k, (r = rotated(stepsOf(lo).steps, stepsOf(hi).steps, lo.bars, score)));
        return lo === da ? r : { ...r, shift: (rotations - r.shift) % rotations };
      });
    },
    score(a, b, opts) {
      const da = spanData(a);
      const db = spanData(b);
      return compares(da, db) ? pairScore(da, db, opts?.keep ?? true) : null;
    },
  };
  fidelities.set(sim, () => (fidelity === undefined ? (fidelity = measureFidelity()) : fidelity));
  return sim;
}
