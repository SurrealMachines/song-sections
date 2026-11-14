import { toLiveColor } from "../core/colors.js";
import type { ArrangementOutput, Section } from "../core/types.js";
import type { ClipInfo } from "./acquire.js";
import { MIN_PIECE_BEATS, sliceEdges } from "./clamp.js";
import { secondsToBeats } from "./time.js";

export type ArrangementOp =
  /** Native split of the clip covering `time` (arrangement beats), meant to match Cmd+E. */
  | { kind: "split"; time: number }
  /** Name and colour of the next piece, in time order. Applied after all splits. */
  | { kind: "label"; name: string; color: number }
  | { kind: "cue"; time: number; name: string };

/**
 * One split per interior boundary, then one label per resulting piece, in order.
 *
 * Boundaries are the shared slice edges (clamp.ts), already clamped to the clip's span and
 * non-decreasing. A section whose span is empty (its end edge is within MIN_PIECE_BEATS of its start
 * edge, because the edge was clamped to the clip's end or coincides with the previous one) cannot
 * become a piece: it is dropped together with its label, and its neighbour with positive length
 * covers the region. So the labels are the sections with positive length, the splits are the
 * start edges of all of them but the first, and labels.length === splits.length + 1 always
 * (if every section is empty, e.g. a zero-length clip, the first label alone is emitted).
 * Every split is therefore strictly inside the clip and more than MIN_PIECE_BEATS after the previous one.
 *
 * `kept` are the indices of the sections that become pieces.
 */
function keptSections(info: ClipInfo, sections: Section[], tempo: number) {
  const { times } = sliceEdges(info, sections, tempo);
  const kept = sections.map((_, i) => i).filter((i) => times[i + 1] - times[i] > MIN_PIECE_BEATS);
  if (kept.length === 0 && sections.length > 0) kept.push(0);
  return { times, kept };
}

function splitOps(info: ClipInfo, sections: Section[], tempo: number): ArrangementOp[] {
  if (sections.length === 0) return [];
  const { times, kept } = keptSections(info, sections, tempo);
  const ops: ArrangementOp[] = kept.slice(1).map((i) => ({ kind: "split", time: times[i] }));
  for (const i of kept) ops.push({ kind: "label", name: sections[i].label, color: toLiveColor(sections[i].color) });
  return ops;
}

/**
 * A locator at each section's start (clamped to the clip's end), named `markerName(label, keys[i])`; only the sections
 * `only` lists, when given. Output Locators places them all, and so does Send all stems in the Arrangement.
 */
export function cueOps(info: ClipInfo, sections: Section[], tempo: number, only?: number[], keys?: readonly (string | null)[]): Array<Extract<ArrangementOp, { kind: "cue" }>> {
  return sections
    .map((s, i): ArrangementOp & { kind: "cue" } => ({
      kind: "cue",
      time: Math.min(info.startTime + secondsToBeats(s.start, tempo), info.startTime + info.lengthBeats),
      name: markerName(s.label, keys?.[i]),
    }))
    .filter((_, i) => !only || only.includes(i));
}

/** v2 (Matt, 31 Oct): a locator or scene name carries its section's sure key, `<label> · Dm`; the clips stay plain. */
export const markerName = (label: string, key?: string | null) => (key ? `${label} · ${key}` : label);

/**
 * `keys[i]`: section i's key for its locator ("Dm"), or null for none (v2).
 * `pieces` (Plan 6, Slice by a source): contiguous over the clip, they give the splits and the clips' names and colours
 * in place of the sections; the locators always come from the sections ("section markers still go in as locators").
 */
export function arrangementOps(
  info: ClipInfo,
  sections: Section[],
  output: ArrangementOutput,
  tempo: number,
  keys?: readonly (string | null)[],
  pieces?: Section[],
): ArrangementOp[] {
  const cuts = pieces ?? sections;
  if (output === "split") return splitOps(info, cuts, tempo);
  if (output === "locators") return cueOps(info, sections, tempo, undefined, keys);
  // Dropped sections get no locator: it would sit on its neighbour's start.
  return [...splitOps(info, cuts, tempo), ...cueOps(info, sections, tempo, keptSections(info, sections, tempo).kept, keys)];
}
