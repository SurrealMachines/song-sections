// Arrow-key nudges of a selected handle (fb3, item 4). Pure.
// Left/Right move it one beat of the active grid (allin1's beats under Downbeats, Live's beats under Bars, the beat
// grid in Cue); Shift moves it one bar (to the next bar line). With snap off: one beat (or bar) at the analysed tempo.
// fb4, item 1: with snap off, a nudge goes by the lengths' grid (gridChoice.ts) when there is one: one of its beats (or
// beatsPerBar of them), keeping the handle's offset from the grid, so the lengths on either side change by exactly a
// beat or a bar; the analysed tempo only without a grid.
import { index, timeAtIndex } from "./lengths.js";

export interface NudgeGrid {
  beats: number[];
  /** Bar lines; empty when there are none (Shift then steps beatsPerBar beats). */
  bars: number[];
  /** A beat at the analysed tempo, for snap off without a grid. */
  beatSec: number;
  beatsPerBar: number;
  /** Snap is on and has a grid: nudges land on it. Off: they step along `beats` (two points or more) or by beatSec. */
  snapping: boolean;
}

/** After each nudge, this many seconds play from the nudged handle or lane cut (fb3, item 4; Plan 6). */
export const AUDITION_SEC = 2;

/** Closer than this to a grid point is on it, in seconds. */
const ON_POINT_SEC = 1e-6;

/**
 * `steps` grid points on from `t` in direction `dir`: from a point, its neighbour `steps` away; from between points,
 * the first point past `t` is the first step. null when that runs off the grid.
 */
export function stepOnGrid(t: number, grid: number[], dir: 1 | -1, steps: number): number | null {
  let k: number;
  const on = grid.findIndex((g) => Math.abs(g - t) <= ON_POINT_SEC);
  if (on >= 0) k = on + dir * steps;
  else if (dir > 0) {
    const first = grid.findIndex((g) => g > t);
    k = first < 0 ? grid.length : first + steps - 1;
  } else {
    let last = -1;
    for (let i = 0; i < grid.length && grid[i] < t; i++) last = i;
    k = last < 0 ? -1 : last - (steps - 1);
  }
  return k >= 0 && k < grid.length ? grid[k] : null;
}

/** Where a nudge takes a handle at `t` (it stays when the grid runs out). */
export function nudgeTime(t: number, dir: 1 | -1, bar: boolean, g: NudgeGrid): number {
  if (g.snapping && g.beats.length > 0) {
    const next = bar ? (g.bars.length > 0 ? stepOnGrid(t, g.bars, dir, 1) : stepOnGrid(t, g.beats, dir, g.beatsPerBar)) : stepOnGrid(t, g.beats, dir, 1);
    return next ?? t;
  }
  if (g.beats.length > 1) return timeAtIndex(g.beats, index(g.beats, t) + dir * (bar ? g.beatsPerBar : 1));
  return t + dir * (bar ? g.beatsPerBar : 1) * g.beatSec;
}

/** One beat in seconds: at `bpm`, else the median spacing of `beats`, else at 120 BPM. */
export function beatSeconds(bpm: number | null | undefined, beats: number[]): number {
  if (bpm && bpm > 0) return 60 / bpm;
  const d = beats.slice(1).map((b, i) => b - beats[i]).sort((x, y) => x - y);
  return d.length > 0 && d[d.length >> 1] > 0 ? d[d.length >> 1] : 0.5;
}
