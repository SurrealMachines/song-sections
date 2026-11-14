// The pattern engine's public interface (Plan 5, Task 1). No Node imports: the dialog bundles this file.
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import { base64Decode, base64Encode } from "./base64.js";

export const PATTERN_ENGINE = "patterns-1";
export const CELL_RATE = 20; // feature cells per second (50 ms)
export const PATTERN_LEVELS = 4; // Patterns slider: 0 (Fewer: one slice per section) … 4 (More)
export const PART_BARS = [1, 2, 3, 4, 5, 6, 8] as const; // the phrase lengths the split tries, in bars
export const LOUD_FLOOR_DB = -127; // the loudness cells' floor (Int8)

export type PatternSource = "mix" | StemName;
export const PATTERN_SOURCES: readonly PatternSource[] = ["mix", ...STEM_NAMES];
export type SourceKind = "mix" | "drums" | "tonal";

export function sourceKind(s: PatternSource): SourceKind {
  return s === "mix" ? "mix" : s === "drums" ? "drums" : "tonal";
}

export interface SourceCells {
  kind: SourceKind;
  dims: number; // features per cell (per kind; the same for every clip)
  cells: number; // ceil(durationSec · CELL_RATE)
  data: string; // base64 of an Int8Array [cells · dims], row-major
  loud: string; // base64 of an Int8Array [cells]: RMS dBFS per cell, rounded, floored at LOUD_FLOOR_DB
}
export interface GridBar {
  start: number;
  end: number;
  unsure: boolean;
}
export interface PatternFeatures {
  engine: typeof PATTERN_ENGINE;
  rate: typeof CELL_RATE;
  durationSec: number;
  grid: GridBar[]; // contiguous over [0, durationSec]
  sources: Partial<Record<PatternSource, SourceCells>>;
}
export interface Span {
  start: number;
  end: number;
}
export interface Marker {
  id: number;
  time: number;
} // an interior section boundary with a stable id
export interface SliceName {
  pattern: number | null;
  variant: boolean;
}

const PRIME = "′";
/** {1,false} → "1", {2,true} → "2′", {null,…} → "" (a rest is never named). */
export function patternText(n: SliceName): string {
  return n.pattern === null ? "" : `${n.pattern}${n.variant ? PRIME : ""}`;
}

// base64 without btoa/atob: Live's extension host has neither (src/patterns/base64.ts).
export function encodeInt8(a: Int8Array): string {
  return base64Encode(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

export function decodeInt8(s: string): Int8Array {
  return new Int8Array(base64Decode(s).buffer);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Decoded byte length of a base64 string without decoding it, or -1 if it is not valid base64. */
function base64Bytes(s: unknown): number {
  if (typeof s !== "string" || !BASE64.test(s)) return -1;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const GRID_EPS = 1e-6;

function isSourceCells(key: PatternSource, v: unknown): boolean {
  if (!isRecord(v)) return false;
  const { kind, dims, cells, data, loud } = v;
  if (kind !== sourceKind(key)) return false;
  if (!Number.isInteger(dims) || (dims as number) < 1) return false;
  if (!Number.isInteger(cells) || (cells as number) < 0) return false;
  return base64Bytes(data) === (cells as number) * (dims as number) && base64Bytes(loud) === cells;
}

export function isPatternFeatures(v: unknown): v is PatternFeatures {
  if (!isRecord(v) || v.engine !== PATTERN_ENGINE || v.rate !== CELL_RATE) return false;
  const { durationSec, grid, sources } = v;
  if (!isNum(durationSec) || durationSec < 0 || !Array.isArray(grid) || !isRecord(sources)) return false;
  let prevEnd = 0;
  for (const [i, b] of grid.entries()) {
    if (!isRecord(b) || !isNum(b.start) || !isNum(b.end) || typeof b.unsure !== "boolean" || b.end < b.start) return false;
    if (i === 0 ? Math.abs(b.start) > GRID_EPS : b.start !== prevEnd) return false;
    prevEnd = b.end;
  }
  if (prevEnd < durationSec - GRID_EPS) return false; // also rejects an empty grid on a non-empty clip
  for (const [key, src] of Object.entries(sources)) {
    if (!(PATTERN_SOURCES as readonly string[]).includes(key) || !isSourceCells(key as PatternSource, src)) return false;
  }
  return true;
}

/** Index in [0, n) of the value nearest `t` in a sorted sequence `at(0..n-1)`; the earlier one on a tie. */
function nearestIndex(n: number, at: (i: number) => number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t - at(lo - 1) <= at(lo) - t ? lo - 1 : lo;
}

/** Bars between the grid points (bar starts, plus the last bar's end) nearest s.start and s.end; at least 1. */
export function barsIn(grid: GridBar[], s: Span): number {
  if (grid.length === 0) return 1;
  const n = grid.length + 1;
  const at = (i: number) => (i < grid.length ? grid[i].start : grid[grid.length - 1].end);
  return Math.max(1, nearestIndex(n, at, s.end) - nearestIndex(n, at, s.start));
}

/** Index of the bar whose start is nearest t. */
export function barIndexAt(grid: GridBar[], t: number): number {
  return grid.length === 0 ? 0 : nearestIndex(grid.length, (i) => grid[i].start, t);
}
