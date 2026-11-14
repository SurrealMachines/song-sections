// The Cue mode beat grid (Plan 4, Global Constraints: Snapping). No Node imports: the dialog may bundle this file.
import type { View } from "./types.js";
import { beatToSec, fileSpan, type WarpPoint } from "./warpMap.js";

/** Slack for float drift at both ends of the beat range, in beats. */
const EPS_BEATS = 1e-9;

export interface BeatGridClip {
  view: View;
  warped: boolean;
  /** Arrangement beats (0 for Session clips). */
  startTime: number;
  /** Beats for warped clips, seconds for unwarped ones. */
  startMarker: number;
  /** fb3: with the warp markers, a warped Session clip's grid goes through its own warp map (core/warpMap.ts). */
  endMarker?: number;
  warpMarkers?: readonly WarpPoint[];
}

/**
 * The beats Cue snaps to, in clip seconds (0 = the clip's first rendered sample), ascending.
 * Arrangement: the song grid, every integer beat k in [ceil(startTime), startTime + durationSec × tempo / 60] at
 * (k − startTime) × 60 / tempo. A warped Session clip: the clip grid, the same with startMarker for startTime.
 * An unwarped Session clip has no grid: null (snapping unavailable).
 */
export function cueBeatGrid(o: BeatGridClip, tempo: number, durationSec: number): number[] | null {
  return everyStep(o, tempo, durationSec, 1);
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

/**
 * Live's bars (feedback round 1: Snap to Bars), in clip seconds, ascending: the beat grid's points at every bar line,
 * counted from the song's bar 1 (Arrangement: song beat 0; a warped Session clip: clip beat 0, as Live's clip ruler
 * shows them, so with the start marker off a bar line the first bar line is inside the clip; review M3, to confirm
 * with Matt against launching quantised, where the start marker lands on the global bar). A bar is numerator × 4 / denominator beats (Live's beats are quarter notes), so 4/4 takes every 4th beat and
 * 6/8 every 3rd. One signature and tempo for the whole clip, as for the beat grid. An unwarped Session clip: null.
 */
export function barGrid(o: BeatGridClip, tempo: number, durationSec: number, sig: TimeSignature): number[] | null {
  const barBeats = (sig.numerator * 4) / sig.denominator;
  if (!(sig.numerator > 0) || !(sig.denominator > 0) || !Number.isFinite(barBeats)) return null;
  return everyStep(o, tempo, durationSec, barBeats);
}

/** Every multiple of `stepBeats` (counted from beat 0 of the grid's origin) inside the clip, in clip seconds. */
function everyStep(o: BeatGridClip, tempo: number, durationSec: number, stepBeats: number): number[] | null {
  if (o.view === "session" && !o.warped) return null;
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return null;
  const span = o.endMarker === undefined ? null : fileSpan({ ...o, endMarker: o.endMarker });
  if (span) {
    // Rendered unwarped from span.startSec (acquireAudio): the clip's own beats, through its warp map.
    const grid: number[] = [];
    for (let k = Math.ceil(o.startMarker / stepBeats - EPS_BEATS); ; k++) {
      const t = beatToSec(o.warpMarkers, k * stepBeats)! - span.startSec;
      if (t > durationSec + 1e-9) break;
      if (t >= -1e-9) grid.push(Math.min(durationSec, Math.max(0, t)));
    }
    return grid;
  }
  if (!(tempo > 0) || !Number.isFinite(tempo)) return null;
  const origin = o.view === "arrangement" ? o.startTime : o.startMarker;
  if (!Number.isFinite(origin)) return null;
  const first = Math.ceil(origin / stepBeats - EPS_BEATS);
  const last = Math.floor((origin + (durationSec * tempo) / 60) / stepBeats + EPS_BEATS);
  const grid: number[] = [];
  for (let k = first; k <= last; k++) grid.push(Math.min(durationSec, Math.max(0, ((k * stepBeats - origin) * 60) / tempo)));
  return grid;
}
