// Plain (non-rune) dialog state so it tests without the Svelte compiler.
// App.svelte bumps a version counter after each mutation to re-render.
import { pickPeaks } from "../analysis/peaks.js";
import { colorsFor } from "../core/colors.js";
import {
  addBoundary,
  boundariesToSections,
  cueLabel,
  moveBoundary,
  removeBoundary,
} from "../core/sections.js";
import type { ArrangementOutput, ColorMode, Section } from "../core/types.js";
import { snapTime } from "../grouping/snap.js";
import { resnap, shiftForAdd, shiftForRemove } from "./labelShift.js";
import type { CuePayload, DialogResult } from "./protocol.js";

export interface DialogState {
  boundaries: number[];
  /** Label overrides keyed by section index; missing entries read as `Cue N`. */
  labels: Record<number, string>;
  granularity: number;
  colorMode: ColorMode;
  output: ArrangementOutput;
  /** Index of the selected boundary, or null. */
  selected: number | null;
  /** The user's snap preference. It only takes effect when canSnap. */
  snap: boolean;
  /** True when the clip has a beat grid (Arrangement song grid, or a warped Session clip). */
  readonly canSnap: boolean;
  /** How many boundaries the last snapping pass dropped (two landing on one beat, or onto an end); 0 after any edit. */
  snapMerged: number;
  setSnap(on: boolean): void;
  setGranularity(g: number): void;
  /** `free`: Cmd (Mac) / Ctrl (Windows) was held, so this edit skips snapping (feedback round 2); Snap stays as set. */
  move(i: number, t: number, free?: boolean): void;
  /** `free` as for move. */
  add(t: number, free?: boolean): void;
  remove(i: number): void;
  rename(i: number, s: string): void;
  sections(): Section[];
  result(): DialogResult;
  cancel(): DialogResult;
}

/** Inserts each time in turn, dropping any that would leave a section under MIN_SECTION_SEC. */
export function sanitize(times: number[], duration: number): number[] {
  return times.reduce<number[]>((b, t) => addBoundary(b, t, duration), []);
}

export function createDialogState(p: CuePayload): DialogState {
  const duration = p.durationSec;
  const grid = p.beatGrid ?? [];
  const canSnap = grid.length > 0;
  const snapping = () => state.snap && canSnap;
  const initial = sanitize(p.boundaries, duration);
  const snapped = p.snap && canSnap ? resnap(initial, {}, grid, duration) : null;
  const state: DialogState = {
    boundaries: snapped ? snapped.boundaries : initial,
    snapMerged: snapped ? snapped.merged : 0,
    snap: p.snap,
    get canSnap() {
      return canSnap;
    },
    labels: {},
    granularity: p.granularity,
    colorMode: p.colorMode,
    output: p.output,
    selected: null,

    setSnap(on) {
      state.snap = on;
      if (!on || !canSnap) return;
      const r = resnap(state.boundaries, state.labels, grid, duration);
      state.boundaries = r.boundaries;
      state.labels = r.labels;
      state.snapMerged = r.merged;
      state.selected = null;
    },

    setGranularity(g) {
      state.granularity = g;
      const picked = sanitize(pickPeaks(p.novelty, p.blocksPerSec, g), duration);
      const r = snapping() ? resnap(picked, {}, grid, duration) : null;
      state.boundaries = r ? r.boundaries : picked;
      state.snapMerged = r ? r.merged : 0;
      state.labels = {};
      state.selected = null;
    },

    move(i, t, free = false) {
      state.snapMerged = 0;
      state.boundaries = moveBoundary(state.boundaries, i, snapping() && !free ? snapTime(t, grid) : t, duration);
    },

    add(t, free = false) {
      state.snapMerged = 0;
      if (snapping() && !free) t = snapTime(t, grid);
      const next = addBoundary(state.boundaries, t, duration);
      if (next.length === state.boundaries.length) return;
      // The new boundary at index k splits section k; sections after it shift up by one.
      const k = next.indexOf(t);
      state.boundaries = next;
      state.labels = shiftForAdd(state.labels, k);
      state.selected = k;
    },

    remove(i) {
      state.snapMerged = 0;
      // Removing boundary i merges sections i and i+1, keeping section i's label.
      state.boundaries = removeBoundary(state.boundaries, i);
      state.labels = shiftForRemove(state.labels, i);
      state.selected = null;
    },

    rename(i, s) {
      const name = s.trim();
      // The default label is not an override: storing it would pin a stale number after add/remove.
      if (name && name !== cueLabel(i)) state.labels[i] = name;
      else delete state.labels[i];
    },

    sections() {
      const base = boundariesToSections(state.boundaries, duration, (i) => state.labels[i] ?? cueLabel(i));
      const colors = colorsFor(state.colorMode, base.length, p.sourceColor);
      return base.map((s, i) => ({ ...s, color: colors[i] }));
    },

    result() {
      return { action: "apply", sections: state.sections(), output: state.output };
    },

    cancel() {
      return { action: "cancel" };
    },
  };
  return state;
}
