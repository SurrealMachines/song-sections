// One host-log line per Apply (feedback round 2, item 1: "I did a lot of edits and then hit Apply but the edits weren't
// in the output"). The host recomputes, from the payload it sent, what the dialog would have sent with no edits, and
// counts how the result differs, so the next such report can be checked against the log. Pure; no Node imports.
import { cueLabel } from "../core/sections.js";
import type { Section } from "../core/types.js";
import type { DialogPayload, DialogResult } from "./protocol.js";
import { createDialogState } from "./state.js";
import { createStructureState } from "./structureState.js";

type Apply = Extract<DialogResult, { action: "apply" }>;

/** Two boundary times closer than this are the same one (the result is JSON, the payload too: exact in practice). */
const SAME_SEC = 1e-6;

export interface ApplyCounts {
  sections: number;
  /** Sections whose label is not the one the dialog computes for the applied boundaries and choices. */
  renamed: number;
  /** Applied boundaries that are not at any boundary the dialog opened with (moved or added). */
  newBoundaries: number;
  /** Boundaries the dialog opened with that are not in the result (moved or removed). */
  goneBoundaries: number;
}

const notIn = (xs: number[], ys: number[]) => xs.filter((x) => !ys.some((y) => Math.abs(x - y) < SAME_SEC)).length;

/**
 * The boundaries the dialog opened with, and the computed default labels for `starts` under the result's choices.
 * One Structure state serves both (fb2 review M6: opening one costs the Sections slider's plan, hundreds of ms on a
 * long clip above the middle): the opening boundaries come from the payload's choices, then its Letters
 * are set to the result's directly (the boundaries are replaced anyway).
 */
function openedAndDefaults(payload: DialogPayload, r: Apply, starts: number[]): { opened: number[]; dflt: string[] } {
  if (payload.mode === "cue") return { opened: createDialogState(payload).boundaries, dflt: r.sections.map((_, i) => cueLabel(i)) };
  const prefs = r.prefs ?? payload;
  const s = createStructureState(payload);
  const opened = [...s.boundaries];
  s.groupDist = prefs.groupDist;
  s.boundaries = starts;
  return { opened, dflt: s.sections().map((x) => x.label) };
}

export function applyCounts(payload: DialogPayload, r: Apply): ApplyCounts {
  const starts = r.sections.slice(1).map((s: Section) => s.start);
  const { opened, dflt } = openedAndDefaults(payload, r, starts);
  return {
    sections: r.sections.length,
    renamed: r.sections.filter((s, i) => s.label !== dflt[i]).length,
    newBoundaries: notIn(starts, opened),
    goneBoundaries: notIn(opened, starts),
  };
}

/** Plan 6: `, cut into 20 drums pieces` under Slice by a source (a piece is named `<source> <pattern>`); "" without pieces. */
const piecesNote = (r: Apply) => (r.pieces ? `, cut into ${r.pieces.length} ${r.pieces[0]?.label.split(" ")[0] ?? ""} pieces` : "");

/**
 * `Song Sections: Apply structure (split): 12 sections, 3 renamed, boundaries 2 new or moved, 1 gone vs the opening`,
 * then `, cut into 20 drums pieces` under Slice by a source.
 */
export function applySummary(payload: DialogPayload, r: Apply): string {
  try {
    const c = applyCounts(payload, r);
    return (
      `Song Sections: Apply ${payload.mode} (${payload.view === "session" ? "session" : r.output}): ${c.sections} sections, ` +
      `${c.renamed} renamed, boundaries ${c.newBoundaries} new or moved, ${c.goneBoundaries} gone vs the opening${piecesNote(r)}`
    );
  } catch (error) {
    // The log line must never stop an Apply.
    return `Song Sections: Apply ${payload.mode}: ${r.sections.length} sections (could not compare with the defaults: ${String(error)})`;
  }
}
