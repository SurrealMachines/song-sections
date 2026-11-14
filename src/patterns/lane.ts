// Lane cuts, ownership and renames (Plan 5, Task 7). Pure and browser-safe: the dialog bundles this file.
// The musician's edits are his: the Patterns slider never wipes them, a cut on a section marker follows that marker until he
// moves it in a lane, and a pattern rename sticks. Every edit returns new LaneEdits and never mutates its input.
import { MIN_SECTION_SEC } from "../core/sections.js";
import { LABEL_SEP } from "../grouping/labels.js";
import { patternText, type Marker, type SliceName, type Span } from "./contract.js";

export type CutOwner = "marker" | "machine" | "user";
export interface LaneCut {
  time: number;
  owner: CutOwner;
  markerId?: number; // only for "marker"
}
export interface PatternRename {
  name: string;
  members: Span[];
}
/**
 * One cell moved to another pattern (Matt, 2026-11-12: "reassign" a cell to a name in use): the cell at `cell`, by time,
 * takes the pattern whose slices are `target` (found again by time, as a rename's members are), as a variant or not.
 */
export interface PatternAssign {
  cell: Span;
  target: Span[];
  variant: boolean;
}
export interface LaneEdits {
  detached: number[]; // ids of markers this lane no longer follows
  removed: number[]; // times of machine cuts the user deleted or moved away
  added: number[]; // the user's own cuts
  renames: PatternRename[];
  /** Absent: none. */
  assigns?: PatternAssign[];
}

/** No edits. Shared by every lane, so frozen, arrays and all: an edit makes new LaneEdits, never changes these. */
const none = <T>(): T[] => Object.freeze([]) as unknown as T[]; // typed as LaneEdits' arrays, which it is passed as
export const NO_EDITS: Readonly<LaneEdits> = Object.freeze({
  detached: none<number>(),
  removed: none<number>(),
  added: none<number>(),
  renames: none<PatternRename>(),
});
export const SUPPRESS_TOL_SEC = 0.05; // a removed time suppresses a machine cut within this

const EPS = 1e-9; // float slack so cuts exactly MIN_SECTION_SEC apart (a clamped move) count as far enough apart
const PRIME = "′";
const PRIORITY: Record<CutOwner, number> = { marker: 0, user: 1, machine: 2 }; // lower wins

const tooClose = (a: number, b: number) => Math.abs(a - b) < MIN_SECTION_SEC - EPS;

/** The lane's cuts in time order: its markers, the machine's cuts the user has not removed, and his own. */
export function laneCuts(markers: Marker[], machine: number[], edits: LaneEdits, durationSec: number): LaneCut[] {
  const all: LaneCut[] = [
    ...markers.filter((m) => !edits.detached.includes(m.id)).map((m): LaneCut => ({ time: m.time, owner: "marker", markerId: m.id })),
    ...machine
      .filter((t) => !edits.removed.some((r) => Math.abs(t - r) <= SUPPRESS_TOL_SEC + EPS))
      .map((t): LaneCut => ({ time: t, owner: "machine" })),
    ...edits.added.map((t): LaneCut => ({ time: t, owner: "user" })),
  ].filter((c) => c.time > 0 && c.time < durationSec);
  // Greedy by priority (the earlier one at equal priority): a cut survives unless a kept cut is closer than MIN_SECTION_SEC.
  const byPriority = [...all].sort((a, b) => PRIORITY[a.owner] - PRIORITY[b.owner] || a.time - b.time);
  const kept: LaneCut[] = [];
  for (const c of byPriority) if (!kept.some((k) => tooClose(k.time, c.time))) kept.push(c);
  return kept.sort((a, b) => a.time - b.time);
}

/**
 * Moves cuts[index] to `to`, clamped MIN_SECTION_SEC inside its neighbours as moveBoundary does. A marker cut detaches for this
 * lane only and becomes his; a machine cut is removed and replaced by his; a user cut moves its own entry.
 */
export function moveCut(edits: LaneEdits, cuts: LaneCut[], index: number, to: number, durationSec: number): LaneEdits {
  const cut = cuts[index];
  if (!cut) return edits;
  const lo = index > 0 ? cuts[index - 1].time + MIN_SECTION_SEC : MIN_SECTION_SEC;
  const hi = index < cuts.length - 1 ? cuts[index + 1].time - MIN_SECTION_SEC : durationSec - MIN_SECTION_SEC;
  const t = Math.min(Math.max(to, lo), hi);
  if (t === cut.time) return edits; // a click without a drag claims nothing
  if (cut.owner === "marker") {
    const id = cut.markerId as number;
    return { ...edits, detached: edits.detached.includes(id) ? edits.detached : [...edits.detached, id], added: [...edits.added, t] };
  }
  if (cut.owner === "machine") return { ...edits, removed: [...edits.removed, cut.time], added: [...edits.added, t] };
  const at = edits.added.indexOf(cut.time);
  return at < 0 ? edits : { ...edits, added: edits.added.map((a, i) => (i === at ? t : a)) };
}

/** Adds his own cut at t. Changes nothing when t is within MIN_SECTION_SEC of an existing cut or an end. */
export function insertCut(edits: LaneEdits, cuts: LaneCut[], t: number, durationSec: number): LaneEdits {
  if (t < MIN_SECTION_SEC - EPS || durationSec - t < MIN_SECTION_SEC - EPS) return edits;
  if (cuts.some((c) => tooClose(c.time, t))) return edits;
  return { ...edits, added: [...edits.added, t] };
}

/** Deletes cuts[index]. A machine cut stays gone when the slider moves: deleting it is his edit. */
export function deleteCut(edits: LaneEdits, cuts: LaneCut[], index: number): LaneEdits {
  const cut = cuts[index];
  if (!cut) return edits;
  if (cut.owner === "marker") {
    const id = cut.markerId as number;
    return edits.detached.includes(id) ? edits : { ...edits, detached: [...edits.detached, id] };
  }
  if (cut.owner === "machine") return { ...edits, removed: [...edits.removed, cut.time] };
  const at = edits.added.indexOf(cut.time);
  return at < 0 ? edits : { ...edits, added: edits.added.filter((_, i) => i !== at) };
}

const span = (ss: Span[]) => ss.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
function overlap(a: Span[], b: Span[]): number {
  let n = 0;
  for (const x of a) for (const y of b) n += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return n;
}
/** A rename claims a pattern's slices when they overlap its members by at least half the members' length (in seconds). */
const claims = (ov: number, r: PatternRename) => ov > 0 && ov >= span(r.members) / 2 - EPS;

/**
 * Names the pattern whose slices are `members`. Renaming to `fallback` (its computed text) or to "" clears the renames that
 * claim that pattern instead. Renames find their pattern again by time, so they survive the slider and the numbering shifting.
 */
export function renamePattern(edits: LaneEdits, members: Span[], name: string, fallback: string): LaneEdits {
  if (name === "" || name === fallback) {
    return { ...edits, renames: edits.renames.filter((r) => !claims(overlap(r.members, members), r)) };
  }
  return { ...edits, renames: [...edits.renames, { name, members: members.map((m) => ({ ...m })) }] };
}

/** The slice a reassignment's cell is: the one overlapping it most, by at least half its length; or -1. */
function cellOf(slices: Span[], names: SliceName[], cell: Span): number {
  let best = -1;
  let bestOv = 0;
  slices.forEach((s, i) => {
    if (names[i]?.pattern == null) return;
    const ov = overlap([s], [cell]);
    if (ov > bestOv + EPS) [best, bestOv] = [i, ov];
  });
  return best >= 0 && bestOv >= span([cell]) / 2 - EPS ? best : -1;
}

/**
 * Each slice's name after the lane's reassignments, in order: a reassigned cell takes the pattern overlapping its
 * target most (the lowest on a tie; the cell itself left out, so it can go back to its own pattern's slices), with the
 * assignment's variant. Then no number is left unused: the patterns still named are numbered 1, 2, … in their order.
 */
export function assignedNames(slices: Span[], names: SliceName[], assigns: readonly PatternAssign[] = []): SliceName[] {
  if (assigns.length === 0) return names;
  const out = names.map((n) => ({ ...n }));
  for (const a of assigns) {
    const k = cellOf(slices, out, a.cell);
    if (k < 0) continue;
    const by = new Map<number, Span[]>();
    out.forEach((n, i) => {
      if (n.pattern !== null && i !== k) by.set(n.pattern, [...(by.get(n.pattern) ?? []), slices[i]]);
    });
    let best: number | null = null;
    let bestOv = 0;
    for (const p of [...by.keys()].sort((x, y) => x - y)) {
      const ov = overlap(a.target, by.get(p)!);
      if (ov > bestOv + EPS) [best, bestOv] = [p, ov];
    }
    // A target with no other slice (the cell was its pattern's only one) keeps the cell's own pattern.
    out[k] = { pattern: best ?? out[k].pattern, variant: a.variant };
  }
  const used = [...new Set(out.map((n) => n.pattern).filter((p): p is number => p !== null))].sort((x, y) => x - y);
  return used.every((p, i) => p === i + 1) ? out : out.map((n) => (n.pattern === null ? n : { ...n, pattern: used.indexOf(n.pattern) + 1 }));
}

/** The reassignments of `edits` without any claiming `cell` (the slice it is now). */
export function unassignCell(edits: LaneEdits, cell: Span): LaneEdits {
  const kept = (edits.assigns ?? []).filter((a) => overlap([a.cell], [cell]) < Math.min(span([a.cell]), span([cell])) / 2 - EPS);
  return kept.length === (edits.assigns ?? []).length ? edits : { ...edits, assigns: kept };
}

/** Moves the cell at `cell` to the pattern whose slices are `target`, as a variant or not; replaces any earlier one of it. */
export function assignCell(edits: LaneEdits, cell: Span, target: Span[], variant: boolean): LaneEdits {
  const base = unassignCell(edits, cell);
  return { ...base, assigns: [...(base.assigns ?? []), { cell: { ...cell }, target: target.map((t) => ({ ...t })), variant }] };
}

/** One label per slice: null for a rest; a claimed pattern's rename (+ ′ for its variants); else patternText. */
export function patternLabels(slices: Span[], names: SliceName[], renames: PatternRename[]): (string | null)[] {
  const bySlices = new Map<number, Span[]>(); // base pattern → all its slices, variants included
  slices.forEach((s, i) => {
    const p = names[i]?.pattern;
    if (p != null) bySlices.set(p, [...(bySlices.get(p) ?? []), s]);
  });
  const claimed = new Map<number, string>();
  for (const r of renames) {
    // The pattern overlapping the most seconds, the lowest number on a tie; a later rename overwrites an earlier one.
    let best: number | null = null;
    let bestOv = 0;
    for (const p of [...bySlices.keys()].sort((a, b) => a - b)) {
      const ov = overlap(r.members, bySlices.get(p) as Span[]);
      if (ov > bestOv + EPS) {
        best = p;
        bestOv = ov;
      }
    }
    if (best !== null && claims(bestOv, r)) claimed.set(best, r.name);
  }
  return slices.map((_, i) => {
    const n = names[i];
    if (!n || n.pattern === null) return null;
    const rename = claimed.get(n.pattern);
    return rename === undefined ? patternText(n) : rename + (n.variant ? PRIME : "");
  });
}

const PATTERN_NUMBER = /^[1-9]\d*$/;

/**
 * The pattern whose colour each slice wears; null for a rest. A pattern named after another takes that one's colour, as a
 * section named after a letter does: a number (the whole name, or the part before LABEL_SEP) is that pattern, and a name
 * several patterns share is the lowest of them. Any other name keeps its own pattern's colour.
 */
export function patternHues(names: SliceName[], labels: (string | null)[]): (number | null)[] {
  const named = labels.map((l, i) => (l !== null && names[i].variant ? l.slice(0, -PRIME.length) : l));
  const lowest = new Map<string, number>();
  names.forEach(({ pattern }, i) => {
    const name = named[i];
    if (pattern !== null && name !== null) lowest.set(name, Math.min(pattern, lowest.get(name) ?? pattern));
  });
  return names.map(({ pattern }, i) => {
    const name = named[i];
    if (pattern === null || name === null) return null;
    const k = name.indexOf(LABEL_SEP);
    const head = k > 0 ? name.slice(0, k) : name;
    return PATTERN_NUMBER.test(head) ? Number(head) : (lowest.get(name) as number);
  });
}
