// The pattern engine the Structure dialog calls (Plan 5, Task 8). Browser-safe: no Node imports.
//
// One engine per clip's features. It decodes every source once, and makes one Similarity per source on first use, with
// rests gated against the loudest source (the highest sourceLevelDb), so a stem that is only bleed is all rests. A
// source whose cells do not decode as its kind's (a stale or damaged entry) is left out, with a warning. A section's
// own cuts are computed for all levels at once and kept per section span (the KEPT_SECTIONS most recently used), as is
// the music it repeats (repeatLags, the KEPT_LAGS most recently used), so the Patterns slider recomputes no split, and a
// marker move splits only the two sections it touches. A section heard before may then be cut at that stretch's machine
// cuts (cutAlike, cheap), so a marker move can change the cuts of a later section that repeats the music around it. Comparisons are kept
// by the Similarity (a bounded number), so naming a lane again after an edit compares only the slices that are new. A
// lane is named with its sections: slices group within a section first (see nameSlices).
import { PATTERN_LEVELS, PATTERN_SOURCES, sourceKind, type GridBar, type Marker, type PatternFeatures, type PatternSource, type SliceName, type Span } from "./contract.js";
import { FEATURE_LAYOUT, decodeSource, type DecodedSource } from "./features.js";
import { assignedNames, laneCuts, patternLabels, type LaneCut, type LaneEdits } from "./lane.js";
import { nameSlices } from "./naming.js";
import { createSimilarity, sourceLevelDb, type Similarity } from "./similarity.js";
import { cutAlike, repeatLags, sectionCuts, barsCost } from "./split.js";

export interface PatternSlice {
  start: number;
  end: number;
  name: SliceName;
  label: string | null; // patternLabels: "1′", a rename, or null for a rest
  cut: LaneCut | null; // the cut it starts at; null for the first slice
}
export interface PatternEngine {
  readonly sources: PatternSource[]; // those present in the features, PATTERN_SOURCES order
  readonly grid: GridBar[];
  machineCuts(source: PatternSource, sections: Span[], level: number): number[];
  /** machineCuts at every level, 0 … PATTERN_LEVELS, splitting each section once. */
  machineLevels(source: PatternSource, sections: Span[]): number[][];
  lane(source: PatternSource, markers: Marker[], level: number, edits: LaneEdits): PatternSlice[];
}

/** The sections the markers cut [0, durationSec] into, in time order; markers outside it, or on another, cut nothing. */
export function sectionSpans(markers: Marker[], durationSec: number): Span[] {
  const edges = [0];
  for (const t of markers.map((m) => m.time).sort((a, b) => a - b)) {
    if (t > edges[edges.length - 1] && t < durationSec) edges.push(t);
  }
  edges.push(durationSec);
  return edges.slice(1).map((end, i) => ({ start: edges[i], end }));
}

/** Section spans whose cuts are kept per source: every section of a song, and the ones a marker drag passes through. */
export const KEPT_SECTIONS = 64;
/**
 * Section spans whose repeatLags are kept per source (at most REPEAT_LAGS numbers each): more than their cuts, since
 * finding them costs more than a split on a repetitive song, and a lane past KEPT_SECTIONS sections splits every section
 * again.
 */
export const KEPT_LAGS = 4096;

interface SourceState {
  sim: Similarity;
  cuts: Map<string, number[][]>; // section `start|end` → sectionCuts, every level; most recently used last
  lags: Map<string, number[]>; // section `start|end` → repeatLags; most recently used last
}

/** The value kept under `key` (now the most recently used), or made and kept, dropping the least recently used past `max`. */
function recent<T>(map: Map<string, T>, key: string, max: number, make: () => T): T {
  let v = map.get(key);
  if (v !== undefined) map.delete(key);
  else v = make();
  map.set(key, v);
  if (map.size > max) map.delete(map.keys().next().value!);
  return v;
}

export interface PatternEngineOptions {
  /** Told of each source left out because its cells do not decode (the engine goes on without it). */
  warn?(message: string): void;
}

/** The source's cells decoded, or why they cannot be: a kind or dims other than its kind's, or a count that is off. */
function decodeChecked(f: PatternFeatures, s: PatternSource): DecodedSource | string {
  const cells = f.sources[s]!;
  if (cells.kind !== sourceKind(s)) return `${s} has cells of kind ${cells.kind}`;
  const dims = FEATURE_LAYOUT[cells.kind]?.dims;
  if (cells.dims !== dims) return `${s} has ${cells.dims} dims a cell, not ${dims}`;
  try {
    return decodeSource(cells);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function createPatternEngine(f: PatternFeatures, opts: PatternEngineOptions = {}): PatternEngine {
  const { grid, durationSec } = f;
  const decoded = new Map<PatternSource, DecodedSource>();
  for (const s of PATTERN_SOURCES.filter((s) => f.sources[s] !== undefined)) {
    const d = decodeChecked(f, s);
    if (typeof d === "string") opts.warn?.(`Song Sections: the ${s} patterns are left out: ${d}`);
    else decoded.set(s, d);
  }
  const sources = [...decoded.keys()];
  const referenceDb = Math.max(...[...decoded.values()].map((src) => sourceLevelDb(src, grid)));
  const states = new Map<PatternSource, SourceState>();

  function state(source: PatternSource): SourceState | null {
    let st = states.get(source);
    if (st) return st;
    const src = decoded.get(source);
    if (!src) return null;
    st = { sim: createSimilarity(src, grid, { referenceDb }), cuts: new Map(), lags: new Map() };
    states.set(source, st);
    return st;
  }

  /** Every section's cuts at every level (cuts[i][level]), cut alike across the sections (cutAlike). */
  function sectionLevels(st: SourceState, sections: Span[]): number[][][] {
    const keys = sections.map((s) => `${s.start}|${s.end}`);
    const own = sections.map((s, i) => recent(st.cuts, keys[i], KEPT_SECTIONS, () => sectionCuts(st.sim, grid, s)));
    const lags = sections.map((s, i) => recent(st.lags, keys[i], KEPT_LAGS, () => repeatLags(st.sim, grid, s)));
    return cutAlike(grid, sections, own, lags, (s, cuts) => barsCost(st.sim, grid, s, cuts));
  }

  function machineCuts(source: PatternSource, sections: Span[], level: number): number[] {
    if (!Number.isInteger(level) || level < 0 || level > PATTERN_LEVELS) throw new RangeError(`no pattern level ${level}`);
    const st = state(source);
    return st ? sectionLevels(st, sections).flatMap((c) => c[level]) : [];
  }

  function machineLevels(source: PatternSource, sections: Span[]): number[][] {
    const st = state(source);
    const cuts = st ? sectionLevels(st, sections) : [];
    return Array.from({ length: PATTERN_LEVELS + 1 }, (_, level) => cuts.flatMap((c) => c[level]));
  }

  return {
    sources,
    grid,
    machineCuts,
    machineLevels,
    lane(source, markers, level, edits) {
      const st = state(source);
      if (!st) return [];
      const sections = sectionSpans(markers, durationSec);
      const cuts = laneCuts(markers, machineCuts(source, sections, level), edits, durationSec);
      const at = [0, ...cuts.map((c) => c.time), durationSec];
      const slices: Span[] = at.slice(1).map((end, i) => ({ start: at[i], end }));
      const names = assignedNames(slices, nameSlices(st.sim, slices, sections), edits.assigns);
      const labels = patternLabels(slices, names, edits.renames);
      return slices.map((s, i) => ({ ...s, name: names[i], label: labels[i], cut: i > 0 ? cuts[i - 1] : null }));
    },
  };
}
