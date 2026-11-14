// The corrected bar grid (Plan 5, Task 4). Browser-safe: no Node imports.
//
// allin1's downbeats are trusted where consecutive ones are about one median bar apart; those bars are exactly its
// downbeats. A run of intervals that are not (Flim 0:56–1:10: a sound decays through a pause and the beat tracker goes
// half-time, so its bars come out 1.5–2× long) is an irregular stretch, and its bar starts are re-derived from the
// music (spike 3):
//   match(t)  how well the one-median-bar window of `evidence` starting at t matches the windows starting on trusted
//             downbeats elsewhere in the clip (the mean of the best 3 cosines), i.e. "does a bar of this song start
//             here?".
//   A dynamic programme over 50 ms candidate starts then picks the bars between the stretch's two (allin1) ends that
//   maximise the mean, over its bars, of match(start) minus a penalty for the bar's length away from the median. The
//   number of bars is free (a bar is 0.5–2 median bars long); the mean, not the sum, so that more bars are not
//   favoured for their own sake. The mean is maximised exactly by Dinkelbach's iteration over an additive DP.
// Before the first downbeat and after the last downbeat's bar the grid is extrapolated in median bars, with a partial
// pickup or tail bar where the clip does not hold a whole one.
//
// A bar is unsure when its length is more than UNSURE_LENGTH off the median, when it was re-derived with weak support
// (its start matches below halfway between how well trusted downbeats match and how well arbitrary times do), or when
// it is extrapolated. Without downbeats the beats or bpm give even bars, all unsure; with neither, 2 s bars.
import { CELL_RATE, LOUD_FLOOR_DB, type GridBar } from "./contract.js";
import type { DecodedSource } from "./features.js";
import { REST_BELOW_DB, REST_FLOOR_DB, zScoreCells } from "./similarity.js";

export interface GridInput {
  downbeats: number[];
  beats: number[];
  bpm: number | null;
  durationSec: number;
  evidence: DecodedSource[]; // other, drums and bass when kept, else the mix: what bar starts are found from
}

/** A bar more than 10 % longer or shorter than the median bar is unsure (spike 3). */
export const UNSURE_LENGTH = 0.1;

const FALLBACK_BAR_SEC = 2;
const MIN_PART = 1 / CELL_RATE; // a pickup or tail shorter than one cell joins its neighbouring bar
const MIN_BAR = 0.5; // re-derived bars are 0.5–2 median bars long
const MAX_BAR = 2;
const LENGTH_PENALTY = 1; // per bar, × ((length − median) / median)²: a 1.5× bar costs 0.25, a 2× bar 1
const STEPS = 16; // steps per match window
const TOP = 3; // match(t) is the mean of the best TOP cosines against trusted downbeats
const MAX_REFS = 48; // trusted downbeats compared against, evenly sampled
const MIN_REFS = 2; // fewer trusted downbeats than this, and a stretch cannot be re-derived
const BACKGROUND = 48; // arbitrary times sampled for how well a time that is not a bar start matches
const TRUSTED_Q = 0.1; // the trusted level is this quantile of trusted downbeats' own match
const MAX_ITER = 30;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))];
}

/** Finite times in [0, end − MIN_PART), sorted, each at least MIN_PART after the one before. */
function cleanTimes(ts: number[], end: number): number[] {
  const out: number[] = [];
  for (const t of ts.filter((t) => finite(t) && t >= 0 && t < end - MIN_PART).sort((a, b) => a - b)) {
    if (out.length === 0 || t - out[out.length - 1] >= MIN_PART) out.push(t);
  }
  return out;
}

/** Boundaries of a grid under construction, and whether each bar so far is unsure. */
class Points {
  readonly at: number[] = [0];
  readonly unsure: boolean[] = [];
  constructor(private readonly med: number) {}
  /** The bar from the last point to t. */
  to(t: number, unsure: boolean) {
    const len = t - this.at[this.at.length - 1];
    this.at.push(t);
    this.unsure.push(unsure || Math.abs(len / this.med - 1) > UNSURE_LENGTH + 1e-9);
  }
  /** The bars, contiguous from 0 to end: a clip too short for any other bar (≤ one cell) is one unsure bar. */
  bars(end: number): GridBar[] {
    if (this.unsure.length === 0) this.to(end, true);
    return this.unsure.map((unsure, i) => ({ start: this.at[i], end: this.at[i + 1], unsure }));
  }
}

/** Extrapolated bar starts before t0 (ascending, 0 first): whole bars back, then a pickup unless it is tiny. */
function startsBefore(t0: number, med: number): number[] {
  const out: number[] = [];
  let t = t0;
  while (t > MIN_PART) {
    t = t - med < MIN_PART ? 0 : t - med;
    out.unshift(t);
  }
  return out;
}

/** Bar ends from t0 to end, a median bar apart, the last one partial unless the remainder is tiny. */
function endsAfter(t0: number, med: number, end: number): number[] {
  const out: number[] = [];
  let t = t0;
  while (end - t > MIN_PART) {
    t = end - (t + med) < MIN_PART ? end : t + med;
    out.push(t);
  }
  return out;
}

/** The median bar: from the downbeats, else 4 median beats, else bpm, else FALLBACK_BAR_SEC. */
function medianBar(downbeats: number[], beats: number[], bpm: number | null): number {
  if (downbeats.length >= 2) return median(downbeats.slice(1).map((t, i) => t - downbeats[i]));
  if (beats.length >= 2) return 4 * median(beats.slice(1).map((t, i) => t - beats[i]));
  if (finite(bpm) && bpm > 0) return 240 / bpm;
  return FALLBACK_BAR_SEC;
}

export function patternGrid(g: GridInput): GridBar[] {
  const dur = finite(g.durationSec) && g.durationSec > 0 ? g.durationSec : 0;
  if (dur === 0) return [];
  const downbeats = cleanTimes(g.downbeats, dur);
  const beats = cleanTimes(g.beats, dur);
  const med = medianBar(downbeats, beats, g.bpm);
  const pts = new Points(med);

  if (downbeats.length === 0) {
    // even bars in phase with the first beat (or from 0), all unsure
    const anchor = beats.length >= 2 && beats[0] >= MIN_PART ? beats[0] : 0;
    for (const t of startsBefore(anchor, med).slice(1)) pts.to(t, true);
    if (anchor > 0) pts.to(anchor, true);
    for (const t of endsAfter(anchor, med, dur)) pts.to(t, true);
    return pts.bars(dur);
  }

  const d = downbeats[0] < MIN_PART ? [0, ...downbeats.slice(1)] : downbeats;
  for (const t of startsBefore(d[0], med).slice(1)) pts.to(t, true);
  if (d[0] > 0) pts.to(d[0], true);

  const ok = d.slice(1).map((t, k) => Math.abs((t - d[k]) / med - 1) <= UNSURE_LENGTH + 1e-9);
  let matcher: StartMatcher | null | undefined; // built on the first stretch
  for (let k = 0; k < ok.length; ) {
    if (ok[k]) {
      pts.to(d[k + 1], false);
      k++;
      continue;
    }
    let e = k;
    while (e < ok.length && !ok[e]) e++;
    if (matcher === undefined) {
      const trusted = d.filter((_, i) => i < ok.length && ok[i]);
      matcher = createStartMatcher(g.evidence, med, dur, trusted);
    }
    const derived = matcher && rederive(d[k], d[e], med, matcher);
    if (derived) {
      for (const b of derived) pts.to(b.end, b.weak);
    } else {
      // nothing to re-derive from: each of allin1's intervals split into whole bars, unsure
      for (let q = k; q < e; q++) {
        const n = Math.max(1, Math.round((d[q + 1] - d[q]) / med));
        for (let j = 1; j <= n; j++) pts.to(j === n ? d[q + 1] : d[q] + ((d[q + 1] - d[q]) * j) / n, true);
      }
    }
    k = e;
  }

  // the last downbeat's bar, then extrapolated bars to the end
  endsAfter(d[d.length - 1], med, dur).forEach((t, i) => pts.to(t, i > 0));
  return pts.bars(dur);
}

interface StartMatcher {
  match(t: number): number;
  weakBelow: number; // a re-derived start that matches below this has weak support
}

/**
 * The source's z-scored, weighted cells (zScoreCells, as similarity compares them), with the stats taken over the cells
 * that are not near-silent against the source's loud cells, and those near-silent cells zeroed (their features are noise).
 */
function evidenceCells(src: DecodedSource): Float32Array {
  const sounding = Array.from(src.loudDb).filter((db) => db > LOUD_FLOOR_DB);
  const gate = sounding.length ? Math.max(REST_FLOOR_DB, quantile(sounding, 0.9) - REST_BELOW_DB) : Infinity;
  const on = Uint8Array.from(src.loudDb, (db) => (db >= gate ? 1 : 0));
  const z = zScoreCells(src, on);
  for (let i = 0; i < src.cells; i++) if (!on[i]) z.fill(0, i * src.dims, (i + 1) * src.dims);
  return z;
}

function createStartMatcher(evidence: DecodedSource[], med: number, dur: number, trusted: number[]): StartMatcher | null {
  if (evidence.length === 0) return null;
  const sources = evidence.map((src) => ({ src, z: evidenceCells(src) }));
  const len = STEPS * sources.reduce((s, x) => s + x.src.dims, 0);
  const stepSec = med / STEPS;

  /** The unit-length window vector of one median bar from t into out; false when it is all zeros. */
  function windowAt(t: number, out: Float32Array): boolean {
    out.fill(0);
    let at = 0;
    for (const { src, z } of sources) {
      const { dims, cells } = src;
      for (let s = 0; s < STEPS; s++, at += dims) {
        const a = Math.max(0, (t + s * stepSec) * CELL_RATE);
        const b = Math.min(cells, (t + (s + 1) * stepSec) * CELL_RATE);
        if (b <= a) continue;
        for (let i = Math.floor(a); i < b; i++) {
          const wgt = (Math.min(b, i + 1) - Math.max(a, i)) / (b - a);
          for (let j = 0; j < dims; j++) out[at + j] += wgt * z[i * dims + j];
        }
      }
    }
    let norm = 0;
    for (let i = 0; i < len; i++) norm += out[i] * out[i];
    if (norm <= 1e-12) return false;
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < len; i++) out[i] *= inv;
    return true;
  }

  // trusted downbeats whose window fits in the clip, evenly sampled
  const usable = trusted.filter((t) => t + med <= dur + MIN_PART);
  const stride = Math.max(1, usable.length / MAX_REFS);
  const refs: { t: number; v: Float32Array }[] = [];
  for (let q = 0; q < usable.length && refs.length < MAX_REFS; q += stride) {
    const t = usable[Math.floor(q)];
    const v = new Float32Array(len);
    if (windowAt(t, v)) refs.push({ t, v });
  }
  if (refs.length < MIN_REFS) return null;

  const scratch = new Float32Array(len);
  const best = new Float64Array(TOP);
  function match(t: number): number {
    if (!windowAt(t, scratch)) return 0;
    best.fill(-Infinity);
    let found = 0;
    for (const r of refs) {
      if (Math.abs(r.t - t) < 0.5 * med) continue; // never against itself or a window it half-covers
      let dot = 0;
      for (let i = 0; i < len; i++) dot += scratch[i] * r.v[i];
      found++;
      for (let k = 0; k < TOP; k++) {
        if (dot > best[k]) {
          best.copyWithin(k + 1, k, TOP - 1);
          best[k] = dot;
          break;
        }
      }
    }
    const n = Math.min(TOP, found);
    let s = 0;
    for (let k = 0; k < n; k++) s += best[k];
    return n ? s / n : 0;
  }

  const trustedLevel = quantile(refs.map((r) => match(r.t)), TRUSTED_Q);
  const span = Math.max(0, dur - med);
  const background = median(Array.from({ length: BACKGROUND }, (_, i) => match(((i + 0.5) * span) / BACKGROUND)));
  // no contrast between bar starts and arbitrary times: the music cannot support any re-derived start
  const weakBelow = trustedLevel > background ? (trustedLevel + background) / 2 : Infinity;
  return { match, weakBelow };
}

/** The bars of the stretch [from, to] that maximise their mean score, or null when no bars of allowed length fit. */
function rederive(from: number, to: number, med: number, m: StartMatcher): { end: number; weak: boolean }[] | null {
  const lo = MIN_BAR * med;
  const hi = MAX_BAR * med;
  if (to - from < lo) return null;
  const times = [from];
  for (let c = Math.ceil((from + lo) * CELL_RATE); c / CELL_RATE <= to - lo; c++) times.push(c / CELL_RATE);
  times.push(to);
  const n = times.length;
  const score = times.map((t, i) => (i < n - 1 ? m.match(t) : 0));
  const penalty = (len: number) => LENGTH_PENALTY * ((len - med) / med) ** 2;

  const value = new Float64Array(n);
  const back = new Int32Array(n);
  /** The best path under max Σ (score − penalty − tau) over bars; its sum of (score − penalty) and its bar count. */
  function solve(tau: number): { sum: number; bars: number } | null {
    value.fill(-Infinity);
    value[0] = 0;
    let first = 0; // the earliest node within hi of node j
    for (let j = 1; j < n; j++) {
      while (times[j] - times[first] > hi + 1e-9) first++;
      for (let i = first; i < j && times[j] - times[i] >= lo - 1e-9; i++) {
        if (value[i] === -Infinity) continue;
        const v = value[i] + score[i] - penalty(times[j] - times[i]) - tau;
        if (v > value[j]) {
          value[j] = v;
          back[j] = i;
        }
      }
    }
    if (value[n - 1] === -Infinity) return null;
    let sum = 0;
    let bars = 0;
    for (let j = n - 1; j > 0; j = back[j]) {
      sum += score[back[j]] - penalty(times[j] - times[back[j]]);
      bars++;
    }
    return { sum, bars };
  }

  // Dinkelbach: tau rises to the best mean, where the best path under it scores no better than tau per bar
  let path = solve(0);
  if (!path) return null;
  for (let it = 0; it < MAX_ITER; it++) {
    const tau: number = path.sum / path.bars;
    path = solve(tau)!;
    if (path.sum / path.bars <= tau + 1e-12) break;
  }

  const nodes: number[] = [];
  for (let j = n - 1; j > 0; j = back[j]) nodes.unshift(j);
  let prev = 0;
  return nodes.map((j) => {
    const bar = { end: times[j], weak: score[prev] < m.weakBelow };
    prev = j;
    return bar;
  });
}
