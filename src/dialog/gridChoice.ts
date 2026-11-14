// Which grid the section lengths and the nudges go by (fb4, item 1). Pure, so it tests without the DOM.
// Matt: "section lengths should be in bars and beats not seconds... when I turned Snap [on] it does that, but doesn't
// seem to get bars in Cue mode." The lengths now use the best grid the clip has, whatever the Snap toggle says:
// - Structure: the grid the handles snap to while snapping (Live's under Snap to Bars), otherwise allin1's beats and
//   downbeats (Live's when allin1 found no beats).
// - Cue: Live's grid for the clip (the song grid in Arrangement, the clip grid of a warped Session clip); without one
//   (an unwarped Session clip), the beats of a cached Structure analysis of the same audio.
// Seconds only when there is none of these. A nudge goes by the same grid: onto its points while snapping, by one of
// its beats (or bars) keeping the handle's offset from them with snap off.
// Matt (Live, Flim at 150 BPM): where allin1's beat tracker goes half-time, a section that sounds 5 bars read "3.1.1".
// With pattern features, allin1's grid gives way to the patterns' corrected bar grid wherever allin1's would be used
// (correctedGrid): it re-derives the bars where allin1's are irregular. Snapping to Downbeats lands on its bar starts
// too (final review item 8: the Structure state snaps to correctedGrid(…).bars), so a snapped section reads whole bars.
import type { GridBar } from "../patterns/contract.js";
import { beatsPerBar, type LengthGrid } from "./lengths.js";
import { beatSeconds, type NudgeGrid } from "./nudge.js";

const usable = (g: LengthGrid | null | undefined): g is LengthGrid => !!g && g.beats.length > 1;

export interface CueGrids {
  /** Live's beats and bars (payload beatGrid and barGrid); null without Live's grid. */
  live: LengthGrid | null;
  /** A cached Structure analysis's beats and downbeats; null without one. */
  structure: LengthGrid | null;
}

/** The Cue lengths' grid: Live's, else the cached Structure analysis's, else none (seconds). */
export function cueLengthGrid(g: CueGrids): LengthGrid | null {
  return usable(g.live) ? g.live : usable(g.structure) ? g.structure : null;
}

export interface StructureGrids {
  /** allin1's beats and downbeats. */
  allin1: LengthGrid;
  /** Live's beats and bars; empty arrays when there is no Live grid (an unwarped Session clip). */
  live: LengthGrid;
  /** allin1's grid with the patterns' corrected bars (correctedGrid); null or absent without pattern features. */
  corrected?: LengthGrid | null;
}

/** Two grid times this close are the same time (the corrected grid's trusted bars start on allin1's downbeats exactly). */
const SAME_TIME = 1e-6;

/**
 * allin1's beats and downbeats, with the patterns' corrected bars (PatternFeatures.grid, src/patterns/grid.ts) between
 * its first and last downbeat. A corrected bar that holds allin1's usual number of beats per bar, the first on its
 * start, keeps them (so where allin1's bars are regular nothing changes); any other (re-derived where allin1's bars
 * are irregular, or one of its own bars whose beats went half-time) is split into that many beats, evenly. Before the
 * first downbeat and after the last, allin1's beats as they are. allin1's grid unchanged when it has fewer than two
 * downbeats or there are no corrected bars.
 */
export function correctedGrid(allin1: LengthGrid, bars: readonly GridBar[]): LengthGrid {
  const d = allin1.bars;
  if (d.length < 2 || allin1.beats.length < 2 || bars.length === 0) return allin1;
  const per = beatsPerBar(allin1);
  const first = d[0];
  const last = d[d.length - 1];
  const within = (xs: readonly number[], from: number, to: number) => xs.filter((t) => t >= from - SAME_TIME && t < to - SAME_TIME);
  const beats = allin1.beats.filter((t) => t < first - SAME_TIME);
  const starts: number[] = [];
  // Where the corrected bars leave a gap (grid.ts drops a downbeat too close to the one before), allin1's grid fills it.
  let at = first;
  const fill = (to: number) => {
    beats.push(...within(allin1.beats, at, to));
    starts.push(...within(d, at, to));
  };
  for (const b of bars) {
    if (b.start < first - SAME_TIME || b.end > last + SAME_TIME || b.end - b.start <= SAME_TIME) continue;
    if (b.start > at + SAME_TIME) fill(b.start);
    starts.push(b.start);
    const own = within(allin1.beats, b.start, b.end);
    if (own.length === per && Math.abs(own[0] - b.start) <= SAME_TIME) beats.push(...own);
    else for (let j = 0; j < per; j++) beats.push(b.start + ((b.end - b.start) * j) / per);
    at = b.end;
  }
  fill(last);
  beats.push(...allin1.beats.filter((t) => t >= last - SAME_TIME));
  return { beats, bars: [...starts, last] };
}

/**
 * The grid the Structure handles snap to: Live's under Snap to Bars; under Snap to Downbeats allin1's, or the corrected
 * grid when there is one (the Structure state snaps to its bar starts).
 */
export function structureSnapGrid(g: StructureGrids, target: "downbeats" | "bars"): LengthGrid {
  if (target === "bars") return g.live;
  return usable(g.corrected) ? g.corrected : g.allin1;
}

/**
 * The Structure lengths' grid: Live's while snapping to Bars (if it has beats), else allin1's (the corrected grid when
 * there is one), else Live's, else none.
 */
export function structureLengthGrid(g: StructureGrids, snapping: boolean, target: "downbeats" | "bars"): LengthGrid | null {
  if (snapping && target === "bars" && usable(g.live)) return g.live;
  if (usable(g.allin1)) return usable(g.corrected) ? g.corrected : g.allin1;
  return usable(g.live) ? g.live : null;
}

/**
 * What an arrow key moves a handle by: while snapping, the snap grid's points; with snap off, a beat (or a bar) of
 * the lengths' grid; with no grid at all, a beat of `bpm` (or of the beats' spacing, or 120 BPM).
 */
export function nudgeGridFor(snapping: boolean, snapGrid: LengthGrid | null, lengthGrid: LengthGrid | null, bpm: number | null | undefined): NudgeGrid {
  const g = snapping && snapGrid && snapGrid.beats.length > 0 ? snapGrid : lengthGrid;
  const beats = g?.beats ?? [];
  const beatSec = beats.length > 1 ? beatSeconds(null, beats) : beatSeconds(bpm, beats);
  return { beats, bars: g?.bars ?? [], beatSec, beatsPerBar: g ? beatsPerBar(g) : 4, snapping: snapping && g === snapGrid };
}
