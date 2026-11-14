import type { Section } from "../core/types.js";
import { fileSpan, secToBeat } from "../core/warpMap.js";
import type { ClipInfo } from "./acquire.js";
import { secondsToBeats, secondsToMarkerDelta } from "./time.js";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * The one tolerance (arrangement beats) for telling edges and pieces apart. Live snaps a cut to
 * ~1e-7 beats (F9: pieces start up to 9.3e-8 off, a 1e-6 clear snaps to 1.04e-6), so anything
 * closer than this is the same edge: arrangementOps drops sections shorter than it, and
 * executeArrangement uses it to decide which clips lie inside the split span.
 */
export const MIN_PIECE_BEATS = 1e-6;

export interface SliceGeometry {
  startMarker: number;
  endMarker: number;
  /** fb3: a warped Session clip with warp markers, the slice as file seconds too (for an unwarped slice). */
  file?: { startSec: number; endSec: number };
}

/**
 * Every slice boundary is computed once and shared by the two slices that meet
 * there, so slice i's marker end is bit-for-bit slice i+1's marker start.
 * Boundaries are clamped to the source clip's span / markers (R17) and kept
 * non-decreasing. The first edges are the clip's own start and the last are its
 * own end, because the rendered audio can be a few samples longer than the clip.
 *
 * `times` (arrangement beats) are the split positions of the Arrangement view's
 * native split; `markers` are the clip-marker ranges Session slices are created with.
 *
 * fb3, item 1: a warped Session clip with warp markers was rendered unwarped (acquireAudio), so its sections are file
 * seconds from the start marker's file time. Its marker edges go through the source's own warp map, whatever the song
 * tempo, and `fileSec` has the same edges in file seconds, for slices that must be made unwarped.
 */
export function sliceEdges(info: ClipInfo, sections: Section[], tempo: number) {
  const n = sections.length;
  const spanEnd = info.startTime + info.lengthBeats;
  const span = fileSpan(info);
  const times = new Array<number>(n + 1);
  const markers = new Array<number>(n + 1);
  const fileSec = span ? new Array<number>(n + 1) : null;
  times[0] = info.startTime;
  markers[0] = info.startMarker;
  if (fileSec) fileSec[0] = span!.startSec;
  for (let k = 1; k < n; k++) {
    const s = sections[k].start;
    times[k] = clamp(info.startTime + secondsToBeats(s, tempo), times[k - 1], spanEnd);
    if (span && fileSec) {
      fileSec[k] = clamp(span.startSec + s, fileSec[k - 1], span.endSec);
      markers[k] = clamp(secToBeat(info.warpMarkers, fileSec[k])!, markers[k - 1], info.endMarker);
    } else {
      markers[k] = clamp(info.startMarker + secondsToMarkerDelta(s, info.warped, tempo), markers[k - 1], info.endMarker);
    }
  }
  times[n] = spanEnd;
  markers[n] = info.endMarker;
  if (fileSec) fileSec[n] = span!.endSec;
  return { times, markers, fileSec };
}

/**
 * Pieces with gaps (left-out rests) as contiguous tiles, for sliceGeometry's shared edges: a tile for each gap,
 * including one before the first piece, and a last one from the last piece's end (sliceEdges ends the last tile at the
 * clip's end, whatever its own end). `at[i]` is piece i's tile. The trailing tile is the caller's to drop when the last
 * piece already ends at the clip's end. Contiguous sections from 0 are their own tiles, plus that trailing one.
 */
export function tiled(pieces: Section[]): { tiles: Section[]; at: number[] } {
  const tiles: Section[] = [];
  const at: number[] = [];
  let end = 0;
  const gap = (from: number, to: number) => tiles.push({ start: from, end: to, label: "", color: 0 });
  for (const p of pieces) {
    if (p.start > end) gap(end, p.start);
    at.push(tiles.length);
    tiles.push(p);
    end = p.end;
  }
  gap(end, end);
  return { tiles, at };
}

/** Marker range of every section slice, built from shared edges (Session slices). */
export function sliceGeometry(info: ClipInfo, sections: Section[], tempo: number): SliceGeometry[] {
  if (sections.length === 0) return [];
  const { markers, fileSec } = sliceEdges(info, sections, tempo);
  return sections.map((_, i) => ({
    startMarker: markers[i],
    endMarker: markers[i + 1],
    ...(fileSec ? { file: { startSec: fileSec[i], endSec: fileSec[i + 1] } } : {}),
  }));
}
