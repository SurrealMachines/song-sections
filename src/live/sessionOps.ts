import type { ClipLoopSettings } from "@ableton-extensions/sdk";
import { toLiveColor } from "../core/colors.js";
import { uniqueLabels } from "../core/sections.js";
import type { Section } from "../core/types.js";
import type { ClipInfo } from "./acquire.js";
import { markerName } from "./arrangementOps.js";
import { MIN_PIECE_BEATS, sliceGeometry, tiled } from "./clamp.js";

export type SessionOp =
  | { kind: "scene"; index: number; name: string }
  | {
      kind: "slotClip";
      sceneIndex: number;
      loop: ClipLoopSettings;
      isWarped: boolean;
      /**
       * fb3: a warped source with warp markers, the slice as an unwarped clip (file seconds, not looping). Live gives a
       * clip it creates its own warp grid, and the SDK cannot set warp markers; executeSession uses this when Live's
       * grid is not the source's.
       */
      unwarped?: ClipLoopSettings;
      name: string;
      color: number;
    };

/**
 * Plan 6: the scene names for scenes starting at `starts` (ascending). A scene starting at t belongs to the section
 * containing t (an edge belongs to the section it starts; past the end, the last one) and is named `<label> <n>`, n
 * counting from 1 over the scenes of every section with that label, in time order, so the names stay distinct (Live fix
 * 5). markerName then adds that section's key: `A - verse 3 · Dm`.
 */
export function sceneNames(sections: Section[], starts: number[], keys?: readonly (string | null)[]): string[] {
  const counts = new Map<string, number>();
  return starts.map((t) => {
    let j = 0;
    while (j < sections.length - 1 && sections[j].end <= t) j++;
    const label = sections[j].label;
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    return markerName(`${label} ${n}`, keys?.[j]);
  });
}

/**
 * Section i goes into scene `info.sceneIndex + 1 + i`. Scene ops come first, in
 * ascending index order, so each createScene index is valid when it is issued.
 * Warped slices loop when launched; unwarped clips cannot loop (ClipLoopSettings).
 * Scene names must tell repeats apart (Live fix 5), so they go through uniqueLabels (`B′ - inst 2`); each clip keeps
 * its section's plain label (feedback round 1).
 *
 * Plan 6, `pieces` (Slice by a source; rests left out, so there may be gaps): piece i goes into scene
 * `info.sceneIndex + 1 + i` instead, named by sceneNames after the section it starts in, and its clip takes the piece's
 * label (`other 2`) and colour.
 */
export function sessionOps(info: ClipInfo, sections: Section[], tempo: number, keys?: readonly (string | null)[], pieces?: Section[]): SessionOp[] {
  if (info.sceneIndex === undefined || info.sceneIndex < 0) {
    throw new Error(`Cannot place sections: source scene index is ${info.sceneIndex}`);
  }
  const base = info.sceneIndex + 1;
  const slices = pieces ?? sections;
  const names = pieces ? sceneNames(sections, pieces.map((x) => x.start), keys) : uniqueLabels(sections).map((s, i) => markerName(s.label, keys?.[i]));
  const scenes: SessionOp[] = names.map((name, i) => ({ kind: "scene", index: base + i, name }));
  const { tiles, at } = pieces ? tiled(pieces) : { tiles: sections, at: sections.map((_, i) => i) };
  let geometry = sliceGeometry(info, tiles, tempo);
  // A last piece that ends at the clip's end (its trailing tile is empty in markers) ends at the clip's own end marker,
  // as the last section does without pieces, not at its own end's image, which can be a hair off it.
  const tail = geometry.at(-1);
  if (pieces && tail && tail.endMarker - tail.startMarker <= MIN_PIECE_BEATS) geometry = sliceGeometry(info, tiles.slice(0, -1), tempo);
  const clips: SessionOp[] = slices.map((s, i) => {
    const { startMarker, endMarker, file } = geometry[at[i]];
    return {
      kind: "slotClip",
      sceneIndex: base + i,
      loop: { startMarker, endMarker, loopStart: startMarker, loopEnd: endMarker, looping: info.warped },
      isWarped: info.warped,
      ...(file
        ? { unwarped: { startMarker: file.startSec, endMarker: file.endSec, loopStart: file.startSec, loopEnd: file.endSec, looping: false } }
        : {}),
      name: s.label,
      color: toLiveColor(s.color),
    };
  });
  return [...scenes, ...clips];
}
