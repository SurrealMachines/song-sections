// v2 sends: the right-click menu's items, and the result a choice closes the dialog with.
// No Node imports: the dialog bundles this file.
import type { Section } from "../core/types.js";
import type { StemName } from "../structure/contract.js";
import type { DialogResult, SendSource, SendTarget, SendUnit, StructurePrefs } from "./protocol.js";

export interface SendItem {
  target: SendTarget;
  label: string;
  /** Plan 6, Task 7: a rest cell has no slice of its own to send. */
  disabled?: boolean;
}

/** Plan 6, Task 8: the last item of every menu when stems are kept. */
export const SEND_ALL_STEMS = "Send all stems to new tracks";

/**
 * The menu: what this section (or slice) can go to, then what all of the source's sections can. Plan 6, Task 7: from a pattern lane (`unit`
 * "patterns") the all-items send the lane's slices, the Drum Rack a pad per pattern; on a rest cell (`rest`) the
 * one-slice items are disabled. Plan 6, Task 8: with kept stems (`stems`), Send all stems to new tracks comes last,
 * whatever was right-clicked.
 */
export function sendItems(
  source: SendSource,
  unit: SendUnit = "sections",
  cell: { rest?: boolean; stems?: boolean } = {},
): { section: SendItem[]; all: SendItem[] } {
  const rest = cell.rest === true;
  return {
    section: [
      { target: "simpler", label: "Send to Simpler", disabled: rest },
      { target: "audioSection", label: "Send to new audio track", disabled: rest },
    ],
    all: [
      { target: "drumRack", label: `Send all ${source} ${unit} to Drum Rack` },
      { target: "audioWhole", label: `Send all ${source} to new audio track` },
      ...(cell.stems ? [{ target: "allStems" as const, label: SEND_ALL_STEMS }] : []),
    ],
  };
}

/**
 * Plan 6: what a right-click on a pattern lane's cell is for: the slice holding the cell's middle (`index`, its place
 * among the lane's `slices`), titled by the cell's label. A rest (no `cell`) is no slice, and neither is a cell that
 * laneSlices left out (a short last one, Task 7 review): both are titled "rest", with `rest` set.
 */
export function laneCellTarget(cell: { start: number; end: number; label: string } | undefined, slices: readonly Section[]): { index: number; label: string; rest: boolean } {
  const mid = cell ? (cell.start + cell.end) / 2 : NaN;
  const k = slices.findIndex((s) => s.start <= mid && mid < s.end);
  return k < 0 ? { index: 0, label: "rest", rest: true } : { index: k, label: cell!.label, rest: false };
}

/** Shown in the menu of a stem lane when no stems were kept for this analysis (as on the lanes' cells). */
export const NO_STEMS_TO_SEND = "Click Re-analyze to send stems";
/** Plan 6, Task 7: shown in the menu of a pattern lane whose every cell is a rest. */
export const ALL_RESTS = "This lane is all rests, so there is nothing to send";

/**
 * The right-clicked section and source, and where the menu opens (client px). Plan 6, Task 7: from a pattern lane's
 * cell, `unit` is "patterns" and `index` is the cell's place among the lane's slices; `rest` when it is a rest (its
 * `index` then names no slice of its own).
 */
export interface SendMenuAt {
  source: SendSource;
  index: number;
  x: number;
  y: number;
  unit?: SendUnit;
  rest?: boolean;
}

/**
 * v2: a result with the send menu's "Key in names" toggle on it (the flow remembers it). A cancel is left alone, and so
 * is every result of a dialog with no keys (`on` undefined), which does not offer the toggle.
 */
export function withKeyInNames(r: DialogResult, on: boolean | undefined): DialogResult {
  return r.action === "cancel" || on === undefined ? r : { ...r, keyInNames: on };
}

/**
 * The send result, with the dialog's sections as they are now (as Apply sends them), or (Plan 6, `at.unit` "patterns")
 * the lane's slices.
 */
export function sendResult(target: SendTarget, at: SendMenuAt, sections: Section[], prefs?: StructurePrefs): DialogResult {
  const unit = at.unit === "patterns" ? { unit: at.unit } : {};
  return { action: "send", target, source: at.source, index: at.index, sections, ...unit, ...(prefs ? { prefs } : {}) };
}

/** Plan 6, Task 8: Send all stems: each stem's slices, and the dialog's sections for the scene names. */
export function allStemsResult(sections: Section[], stems: Record<StemName, Section[]>, prefs?: StructurePrefs): DialogResult {
  return { action: "send", target: "allStems", source: "mix", index: 0, sections, stems, ...(prefs ? { prefs } : {}) };
}
