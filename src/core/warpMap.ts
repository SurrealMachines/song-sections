// A warped clip's beat <-> file time map, from its warp markers (fb3, item 1). No Node imports: the dialog may bundle it.
//
// Live's warp markers pin clip beats to file seconds; between two markers the map is linear, and past the first or
// last one it carries on at that end segment's slope (Live's LOM lists one extra marker after the last, so even a
// clip with a single user marker has two).

export interface WarpPoint {
  beatTime: number;
  sampleTime: number;
}

/** The markers sorted by beat, with any that share a beat or a time with the one before dropped (no slope there). */
function points(markers: readonly WarpPoint[] | undefined): WarpPoint[] {
  const sorted = [...(markers ?? [])]
    .filter((m) => Number.isFinite(m.beatTime) && Number.isFinite(m.sampleTime))
    .sort((a, b) => a.beatTime - b.beatTime);
  const out: WarpPoint[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && (m.beatTime - last.beatTime <= 1e-9 || m.sampleTime - last.sampleTime <= 1e-9)) continue;
    out.push(m);
  }
  return out;
}

/** Whether the markers define a map: at least two at distinct, increasing beats and times. */
export function usableWarp(markers: readonly WarpPoint[] | undefined): boolean {
  return points(markers).length >= 2;
}

function interpolate(p: WarpPoint[], x: number, from: keyof WarpPoint, to: keyof WarpPoint): number | null {
  if (p.length < 2) return null;
  let i = 0;
  while (i < p.length - 2 && x >= p[i + 1][from]) i++;
  const a = p[i];
  const b = p[i + 1];
  return a[to] + ((x - a[from]) * (b[to] - a[to])) / (b[from] - a[from]);
}

/** The file time, in seconds, at clip beat `beat`; null when the markers define no map. */
export function beatToSec(markers: readonly WarpPoint[] | undefined, beat: number): number | null {
  return interpolate(points(markers), beat, "beatTime", "sampleTime");
}

/** The clip beat at file time `sec`; null when the markers define no map. */
export function secToBeat(markers: readonly WarpPoint[] | undefined, sec: number): number | null {
  return interpolate(points(markers), sec, "sampleTime", "beatTime");
}

/** Within this many seconds everywhere, two grids play the file the same (a frame at 1 kHz). */
const SAME_SEC = 1e-3;

/**
 * Whether two marker lists warp the clip beats [from, to] onto the same file times: compared at the range's ends and
 * at every marker of either list inside it, which is where either map can bend.
 */
export function sameWarp(a: readonly WarpPoint[] | undefined, b: readonly WarpPoint[] | undefined, from: number, to: number): boolean {
  if (!usableWarp(a) || !usableWarp(b)) return false;
  const beats = [from, to, ...[...a!, ...b!].map((m) => m.beatTime).filter((t) => t > from && t < to)];
  return beats.every((t) => Math.abs(beatToSec(a, t)! - beatToSec(b, t)!) <= SAME_SEC);
}

/** What fileSpan reads of a clip (ClipInfo has it). */
export interface WarpedClip {
  view: "arrangement" | "session";
  warped: boolean;
  startMarker: number;
  endMarker: number;
  warpMarkers?: readonly WarpPoint[];
}

/**
 * A warped Session clip's start and end markers as file seconds, by its own warp markers; null for any other clip, or
 * when the markers define no map (fb3, item 1).
 *
 * Live's API cannot give a clip it creates from the file the source's warp markers: Live warps it on a grid of its
 * own (120 BPM on Matt's clip warped at 150). So a warped Session clip is rendered unwarped, from these file seconds
 * (acquireAudio), and its sections are in file seconds from `startSec`: the preview plays the file at its own rate,
 * and the slices' markers are found through the source's own map (clamp.ts sliceEdges).
 */
export function fileSpan(c: WarpedClip): { startSec: number; endSec: number } | null {
  if (c.view !== "session" || !c.warped || !usableWarp(c.warpMarkers)) return null;
  const startSec = Math.max(0, beatToSec(c.warpMarkers, c.startMarker)!);
  const endSec = beatToSec(c.warpMarkers, c.endMarker)!;
  return endSec > startSec ? { startSec, endSec } : null;
}
