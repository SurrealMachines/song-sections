// Structure-mode dialog state: letters, function hints, group colours, renames. Plain (non-rune), like state.ts.
// Everything is recomputed here from the payload's analysis, because the dialog cannot reach the extension.
import { boundariesToSections, addBoundary, MIN_SECTION_SEC, moveBoundary, removeBoundary } from "../core/sections.js";
import type { ArrangementOutput, Rgb, Section } from "../core/types.js";
import { CELL_RATE, PATTERN_LEVELS, patternText, type Marker } from "../patterns/contract.js";
import { createPatternEngine, sectionSpans, type PatternEngine, type PatternSlice } from "../patterns/engine.js";
import { assignCell, deleteCut, insertCut, moveCut, patternHues, renamePattern as renameInLane, unassignCell, type CutOwner, type LaneCut, type LaneEdits } from "../patterns/lane.js";
import { STEM_NAMES, type FunctionLabel, type StemName, type StructureAnalysis } from "../structure/contract.js";
import { labelGroup, letterName, nameKey, sectionFunction, structureLabel } from "../grouping/labels.js";
import { closeGaps, insertKey, isBareKey, letterKey, numberKey } from "../grouping/renumber.js";
import { CANDIDATE_FLOOR, granularBoundaries, type RepeatCut } from "../grouping/granularity.js";
import { cutLinkage, linkage, MELODY_DIST_SCALE, type Linkage, type SectionGroup } from "../grouping/letters.js";
import { dim, groupColor, groupShades, OTHER_COLORS, type Palette } from "../grouping/palette.js";
import { repeatPlan } from "../grouping/repetition.js";
import { melodyVariant, sectionLoudness, sectionVectors } from "../grouping/sectionVectors.js";
import { snapBoundaries, snapTime } from "../grouping/snap.js";
import { correctedGrid } from "./gridChoice.js";
import { resnap, shiftForAdd, shiftForRemove } from "./labelShift.js";
import { SLICE_BYS, type DialogResult, type GroupBy, type SliceBy, type SnapTarget, type StructureColorMode, type StructurePayload, type StructurePrefs } from "./protocol.js";
import { sanitize } from "./state.js";

/** One section of one stem lane: the stem's own letter, and a colour dimmed by the stem's loudness there. */
export interface LaneSection {
  start: number;
  end: number;
  label: string;
  color: Rgb;
}

/** One cell of a pattern lane (Plan 6): a slice of one source, named and coloured by its pattern. */
export interface LaneCell {
  start: number;
  end: number;
  /** "1", "2′", a rename (+ ′ for its variants); "" for a rest, which is never named. */
  label: string;
  /** groupColor(patternHues − 1, variant); a rest is the dark colour, 0x141414. */
  color: Rgb;
  /** A near-silent slice: Apply and the sends leave it out. */
  rest: boolean;
  /** Who owns the cut the cell starts at; null for the first cell. */
  owner: CutOwner | null;
}

/** A selected lane cut: its index among that lane's cuts (cell index + 1 starts at it). */
export interface LaneCutRef {
  source: StemName;
  index: number;
}

/** Loudness (dBFS) mapped to brightness: -60 dB is dark, -12 dB and above is full. */
const BRIGHTNESS_FLOOR_DB = -60;
const BRIGHTNESS_RANGE_DB = 48;

export interface StructureDialogState {
  boundaries: number[];
  /** Label overrides keyed by section index; missing entries read as the computed `A′ - chorus`. */
  labels: Record<number, string>;
  /** Plan 6: what the clip is sliced by. Does not touch the letters, which always come from all stems. */
  sliceBy: SliceBy;
  /**
   * The Patterns slider's engine level, an integer 0 .. PATTERN_LEVELS. With pattern lanes it is one of patternSteps()
   * when it is set (the payload's level snaps down to a step on first use); a marker edit can later leave it between
   * steps, where its lanes are those of the step below it. Without lanes it keeps the payload's. prefs() remembers the
   * payload's level, not this, until setPatternLevel is called (final review I1: a clip with fewer steps must not lower
   * the level the next clip opens at).
   */
  readonly patternLevel: number;
  colorMode: StructureColorMode;
  output: ArrangementOutput;
  /** Index of the selected boundary, or null. Selecting one (setting it non-null) clears selectedCut. */
  selected: number | null;
  /** The user's snap preference. It only takes effect when canSnap. */
  snap: boolean;
  /** Sections slider, -1..1 (feedback round 1). */
  granularity: number;
  /** True when the analysis has boundary candidates for the Sections slider. */
  readonly canGranulate: boolean;
  /** Letters slider: the grouping distance (feedback round 1). Boundaries and renames are kept when it moves. */
  groupDist: number;
  /** Stem lanes show each stem's waveform (feedback round 1). */
  showStems: boolean;
  /**
   * What snapping snaps to: allin1's downbeats (with pattern features, the bar starts of their corrected grid), or Live's
   * bars. Always one that is available, when either is.
   */
  snapTarget: SnapTarget;
  /** True when there is a grid to snap to: downbeats or bars. */
  readonly canSnap: boolean;
  /** True when the analysis has downbeats. */
  readonly canSnapDownbeats: boolean;
  /** True when the payload has Live's bar grid (not for an unwarped Session clip). */
  readonly canSnapBars: boolean;
  /** How many boundaries the last snapping pass dropped (two landing on one downbeat, or onto an end); 0 after any edit. */
  snapMerged: number;
  /**
   * Snap on re-snaps the current boundaries; off leaves them where they are. While the Sections slider (off 0) owns
   * the boundaries, with no hand edit since it last moved, they are instead rebuilt from its value on the new basis,
   * so its next step up only adds boundaries (review I1).
   */
  setSnap(on: boolean): void;
  /**
   * Moves the Sections slider: the boundaries become granularBoundaries(g) (no added one leaves a section under a
   * bar once snapped), snapped when snap is on, and hand-moved boundaries and the selection are cleared (they were made
   * against other boundaries). A rename stays on a section whose start and end both survive; the rest are dropped.
   * Ignored when !canGranulate.
   */
  setGranularity(g: number): void;
  setGroupDist(d: number): void;
  setShowStems(on: boolean): void;
  /** Records the target and, with snap on, re-snaps the current boundaries to it, or rebuilds them, as setSnap does. */
  setSnapTarget(t: SnapTarget): void;
  /** `free`: Cmd (Mac) / Ctrl (Windows) was held, so this edit skips snapping (feedback round 2); Snap stays as set. */
  move(i: number, t: number, free?: boolean): void;
  /** `free` as for move. */
  add(t: number, free?: boolean): void;
  remove(i: number): void;
  /**
   * Names section i (Matt, 2026-11-11). With `insert` (the + in the rename list) a letter alone that another section
   * uses moves that letter and every later one up, so the new one is free. Then no letter is left unused: any gap the
   * rename made closes, and the letters after it move down. Colours follow the letters (colorOf).
   */
  rename(i: number, s: string, insert?: boolean): void;
  setColorMode(m: StructureColorMode): void;
  /**
   * True when the dialog holds hand edits that a fresh analysis would discard: a move, add, remove or rename since the
   * Sections slider last set the boundaries, or a rename that survived it (fb2 review I2: Re-analyze asks first).
   */
  readonly handEdited: boolean;
  /** Records what the clip is sliced by. The boundaries, letters and renames are untouched. */
  setSliceBy(s: SliceBy): void;
  /**
   * The interior boundaries in order, each with an id that stays with it through moves, snaps and slider rebuilds
   * (Plan 6: the stem lanes follow section markers by id). Ids are never reused within one dialog.
   */
  markers(): Marker[];
  /** Plan 6: the stems with a pattern lane (the engine's, STEM_NAMES order); [] without pattern features or kept stems. */
  readonly patternSources: StemName[];
  /**
   * What the clip is cut by: sliceBy, or "sections" when sliceBy's source has no pattern lane (a remembered choice this
   * clip cannot use), when its lane is all rests (nothing to name), or when Output = Locators in Arrangement cuts
   * nothing. sliceBy itself is kept for prefs().
   */
  readonly effectiveSliceBy: SliceBy;
  /**
   * The engine levels that change something for this clip ("only real levels", Matt): 0, then each level whose machine
   * cuts differ, in some source, from those of the last level kept. His edits do not count. [0] without pattern lanes.
   * Memoised on the boundaries.
   */
  patternSteps(): number[];
  /** Sets the engine level, and the one prefs() remembers: rounded, clamped to 0 .. PATTERN_LEVELS and snapped down to a step. Never touches his lane edits. */
  setPatternLevel(level: number): void;
  /**
   * One lane per pattern source, at patternLevel with his edits. Memoised on the markers, edits and palette, and kept
   * for each level visited at those markers and edits.
   */
  patternLanes(): Partial<Record<StemName, LaneCell[]>>;
  /**
   * The pattern lanes for the current markers without asking the engine, for the frames of a marker drag (final review
   * item 7: on a long clip patternLanes() costs a frame or more). They are the lanes patternLanes() last gave, with the
   * cut at each marker that has moved since following it; other cuts it passes over, or comes within MIN_SECTION_SEC
   * of, are hidden (a marker's cut wins, as in laneCuts), and each cell takes the label, colour and rest of the cell
   * under its middle, as respan does for the bands. The machine cuts of the sections it touches are not recomputed:
   * patternLanes() after the drop is exact. patternLanes() itself before it has run, or once a marker was added or removed.
   */
  previewLanes(): Partial<Record<StemName, LaneCell[]>>;
  /** The selected lane cut, or null. Selecting one (setting it non-null, here or through selectLaneCut) clears `selected`. */
  selectedCut: LaneCutRef | null;
  selectLaneCut(sel: LaneCutRef | null): void;
  /** Moves a lane cut (it becomes his), snapped as move() is unless `free`, and kept MIN_SECTION_SEC from its neighbours. A selected cut stays selected when a cut it hid comes back and shifts the indices. */
  moveLaneCut(source: StemName, index: number, t: number, free?: boolean): void;
  /** Adds his own cut, snapped as add() is unless `free`, and selects it. Nothing within MIN_SECTION_SEC of another cut. */
  insertLaneCut(source: StemName, t: number, free?: boolean): void;
  deleteLaneCut(source: StemName, index: number): void;
  /**
   * Names the pattern of the lane's cell (every cell of that base pattern; its variants show the name with ′); "" or the
   * default text clears it. `insert` and the closing of gaps work on the lane's pattern numbers as rename's do on letters.
   */
  renamePattern(source: StemName, cellIndex: number, name: string, insert?: boolean): void;
  /** One entry per section, lettered from all stems. Memoised on the boundaries and groupDist. */
  groups(): SectionGroup[];
  /** Four preview lanes, cut at the section edges and grouped per stem. Memoised on the boundaries, groupDist and the palette. */
  lanes(): Record<StemName, LaneSection[]>;
  sections(): Section[];
  /**
   * Colors every section named like section i (nameKey) `color`, from the menu's swatches (Matt, 2026-11-12); null
   * gives the name its automatic color back. The color belongs to the name: a section renamed to it takes it, one
   * renamed away loses it. Clip color still colors everything the clip's.
   */
  setNameColor(i: number, color: Rgb | null): void;
  /**
   * What the menu offers for section i: its letter's five Live shades, lightest first (none for a name with no letter),
   * one of every other hue, the section's color now, and whether its name has a picked color.
   */
  swatches(i: number): { shades: Rgb[]; others: Rgb[]; current: Rgb; picked: boolean };
  /**
   * Colors every cell of `source`'s pattern lane named like cell `cellIndex` (Matt, 2026-11-12), or with null gives it
   * its automatic color back. Per lane, as the numbers are: drums' 1 is not bass's 1. A rest is never colored.
   */
  setPatternColor(source: StemName, cellIndex: number, color: Rgb | null): void;
  /** As swatches(), for a pattern lane's cell: the shades are its number's. */
  patternSwatches(source: StemName, cellIndex: number): { shades: Rgb[]; others: Rgb[]; current: Rgb; picked: boolean };
  /**
   * What Apply cuts the clip at under Slice by a source (Plan 6): the effectiveSliceBy lane's cells, each named
   * `<source> <pattern>` (`drums 2′`, `bass Groove`) and coloured by its pattern, or the clip's colour under
   * Clip color. A rest is never a piece: in Arrangement, which cannot remove audio from the clip, it joins the piece
   * before it (a leading rest the piece after), so the pieces tile the clip; in Session it is left out. Null when the
   * clip is cut at the sections (effectiveSliceBy is "sections"). A last piece the clip's end leaves under
   * MIN_SECTION_SEC (the lanes run over the features' duration, which may be a little longer) joins the piece before
   * it; in Session, where a rest may lie between them, it is left out instead.
   */
  applyPieces(): Section[] | null;
  /**
   * Plan 6, Task 7: `source`'s lane as a send from it takes it: its cells that are not rests, named and coloured as
   * applyPieces names them, clamped to the clip, with gaps where the rests were (applyPieces' Session pieces, for any
   * lane). A last slice the clip's end leaves under MIN_SECTION_SEC joins the slice before it when they meet, and is
   * left out otherwise. Empty for an all-rest lane.
   */
  laneSlices(source: StemName): Section[];
  /** The choices to remember (settings.json), sent with Apply and with a mode switch. */
  prefs(): StructurePrefs;
  result(): DialogResult;
  cancel(): DialogResult;
}

/**
 * allin1's own segment label for each section whose span is exactly one engine segment, keyed by section index.
 * Sections that sanitising merged (a segment shorter than MIN_SECTION_SEC) are left out, so they re-derive.
 */
function modelWords(a: StructureAnalysis, boundaries: number[], duration: number): Record<number, FunctionLabel> {
  const byStart = new Map(a.segments.map((g, k) => [g.start, k]));
  const edges = [0, ...boundaries, duration];
  const out: Record<number, FunctionLabel> = {};
  for (let i = 0; i < edges.length - 1; i++) {
    const k = byStart.get(edges[i]);
    if (k === undefined) continue;
    const last = i === edges.length - 2;
    const next = a.segments[k + 1];
    if (last ? next === undefined : next?.start === edges[i + 1]) out[i] = a.segments[k].label;
  }
  return out;
}

/** Section letters, and the Sections slider's repetition splits, always come from all stems (Plan 6: Group by is gone). */
const LETTERS_FROM: GroupBy = "all";

/** Two times this close are the same time (a boundary that a rebuild left where it was). */
const SAME_TIME = 1e-6;
const near = (a: number, b: number) => Math.abs(a - b) <= SAME_TIME;

const TRAILING_PRIMES = /′+$/u;
/** The primes a rename may end with: ′, ″ and ‴, and the ' and ’ a keyboard types. */
const TYPED_PRIMES = /['’′″‴]+$/u;
const REST_COLOR: Rgb = dim(groupColor(null, false), 0); // 0x141414
const sameCuts = (a: number[], b: number[]) => a.length === b.length && a.every((t, i) => t === b[i]);
const blankEdits = (): LaneEdits => ({ detached: [], removed: [], added: [], renames: [] }); // never the frozen NO_EDITS
const hasEdits = (e: LaneEdits) => e.detached.length + e.removed.length + e.added.length + e.renames.length + (e.assigns?.length ?? 0) > 0;

/**
 * Moves picked colors (by nameKey) from each `was` label to the `now` label at the same place, where `moves(j)` and the
 * label changed: a rename's renumbering. Unmoved names keep theirs; a moved one wins a clash.
 */
function remapColors(colors: Map<string, Rgb>, was: string[], now: string[], moves: (j: number) => boolean): void {
  const to = new Map<string, string>();
  was.forEach((w, j) => {
    if (moves(j) && w !== now[j]) to.set(nameKey(w), nameKey(now[j]));
  });
  if (to.size === 0 || ![...to.keys()].some((k) => colors.has(k))) return;
  const moved: [string, Rgb][] = [];
  for (const [k, c] of [...colors]) {
    const dest = to.get(k);
    if (dest === undefined) continue;
    colors.delete(k);
    moved.push([dest, c]);
  }
  for (const [k, c] of moved) colors.set(k, c);
}

export function createStructureState(p: StructurePayload): StructureDialogState {
  const a = p.analysis;
  const duration = p.durationSec;
  let memo: { key: string; groups: SectionGroup[] } | null = null;
  let laneMemo: { key: string; lanes: Record<StemName, LaneSection[]> } | null = null;
  // One linkage per source (all stems, and each stem for the lanes) for the current boundaries: the Letters slider only cuts it.
  const linkMemo = new Map<GroupBy, { key: string; vectors: (Float64Array | null)[]; link: Linkage }>();
  const linked = (by: GroupBy, sp: { start: number; end: number }[]) => {
    const key = state.boundaries.join(",");
    let m = linkMemo.get(by);
    if (m?.key !== key) {
      const vectors = sectionVectors(a, sp, by);
      m = { key, vectors, link: linkage(vectors) };
      linkMemo.set(by, m);
    }
    return m;
  };
  const grouped = (by: GroupBy, sp: { start: number; end: number }[]) => {
    const m = linked(by, sp);
    if (by !== "melody") return cutLinkage(m.vectors, m.link, state.groupDist);
    // Melody (fb2): chroma-only distances are smaller, so the slider's value is scaled; the prime comes from the
    // backing, Other's timbre, not from the melody's own distance (melodyVariant).
    return cutLinkage(m.vectors, m.link, state.groupDist * MELODY_DIST_SCALE, undefined, (r, k) => melodyVariant(a, sp[r], sp[k]));
  };

  /** Soft only under Soft; Vivid and Clip color both colour the lanes Vivid. */
  const palette = (): Palette => (state.colorMode === "soft" ? "soft" : "vivid");
  const spans = () => boundariesToSections(state.boundaries, duration, () => "");
  // Final review item 8 (Matt, Flim): with pattern features the downbeats are the bar starts of the corrected grid the
  // lengths count on (correctedGrid: allin1's downbeats, re-derived where its bars are irregular, nothing outside its
  // first and last), for snapping, re-snapping, the model's words, the Sections slider and the repetition splits, so a
  // snapped boundary reads whole bars. Without pattern features, allin1's own.
  const downbeats = p.patterns ? correctedGrid({ beats: a.beats, bars: a.downbeats }, p.patterns.grid).bars : a.downbeats;
  const grids: Record<SnapTarget, number[]> = { downbeats, bars: p.barGrid ?? [] };
  const canSnapDownbeats = grids.downbeats.length > 0;
  const canSnapBars = grids.bars.length > 0;
  const canSnap = canSnapDownbeats || canSnapBars;
  /** The wanted target if it has a grid, else the other one. */
  const usable = (t: SnapTarget): SnapTarget => (grids[t].length > 0 ? t : t === "bars" ? "downbeats" : canSnapBars ? "bars" : "downbeats");
  const grid = () => grids[state.snapTarget];
  const snapping = () => state.snap && canSnap;
  const initial = sanitize(
    a.segments.slice(1).map((s) => s.start),
    duration,
  );

  // Live fix 1, made stateless (review M1): a section shows allin1's own word when its span IS an engine segment,
  // raw or snapped to the downbeats, however it got there (so dragging a boundary away and back restores it, and
  // toggling snap off keeps it). Any other span re-derives its word from the function probabilities.
  // One rule for merges (review M2): a span that also covers another segment re-derives, whether sanitising merged
  // them (modelWords) or snapping did (a segment whose snapped image vanished widens every span it overlaps).
  const spanKey = (start: number, end: number) => `${start}|${end}`;
  const reference = new Map<string, string>();
  const rawWords = modelWords(a, initial, duration);
  const e0 = [0, ...initial, duration];
  for (const [k, w] of Object.entries(rawWords)) reference.set(spanKey(e0[+k], e0[+k + 1]), w);
  // The model's words also hold on each grid's snapped image of a segment (both targets, so switching keeps them).
  for (const g of [grids.downbeats, grids.bars]) {
    if (g.length === 0) continue;
    const e1 = [0, ...snapBoundaries(initial, g, duration), duration];
    const img = (t: number) => (t === 0 || t === duration ? t : snapTime(t, g));
    const startsAt = new Map(e1.slice(0, -1).map((t, j) => [t, j]));
    /** The snapped section that is section k's image, or null when snapping collapsed or dropped it. */
    const imageOf = (k: number) => {
      const j = startsAt.get(img(e0[k]));
      return j !== undefined && e1[j + 1] === img(e0[k + 1]) ? j : null;
    };
    const widened = new Set<number>();
    for (let k = 0; k < e0.length - 1; k++) {
      if (imageOf(k) !== null) continue;
      for (let j = 0; j < e1.length - 1; j++) if (e1[j] < e0[k + 1] && e1[j + 1] > e0[k]) widened.add(j);
    }
    for (const [k, w] of Object.entries(rawWords)) {
      const j = imageOf(+k);
      const key = j === null ? "" : spanKey(e1[j], e1[j + 1]);
      if (j !== null && !widened.has(j) && !reference.has(key)) reference.set(key, w);
    }
  }
  const word = (start: number, end: number) => (reference.get(spanKey(start, end)) as FunctionLabel | undefined) ?? sectionFunction(a, start, end);
  const defaultLabel = (g: SectionGroup, start: number, end: number) => structureLabel(g, word(start, end), LETTERS_FROM);

  /** The user's choice, kept for prefs() when this clip cannot use it (Bars on an unwarped Session clip). */
  let wantedTarget: SnapTarget = p.snapTarget ?? "downbeats";
  const target0 = usable(wantedTarget);
  const candidates = a.boundaryCandidates ?? []; // always present since allin1-onnx-3; empty disables the slider
  const canGranulate = candidates.length > 0;
  /**
   * The repetition splits (fb2) are scored on the downbeats (Live's bars when there are none), whatever the snap
   * target: the features are downbeat-synchronous. Memoised on the g = 0.5 boundaries, a few entries deep, so
   * moving the slider back and forth reuses the plan (fb2 review M7).
   */
  const repeatGrid = canSnapDownbeats ? grids.downbeats : grids.bars;
  const REPEAT_MEMO_SIZE = 12; // a few slider positions, on two snap bases
  const repeatMemo = new Map<string, { drop: number[]; cuts: RepeatCut[] }>();
  const cutsFor = (base: number[], weak: number[]) => {
    const key = `${base.join(",")}|${weak.join(",")}`;
    let plan = repeatMemo.get(key);
    if (plan) repeatMemo.delete(key); // re-inserted below as the most recent
    else plan = repeatPlan(a, LETTERS_FROM, repeatGrid, base, duration, weak);
    repeatMemo.set(key, plan);
    if (repeatMemo.size > REPEAT_MEMO_SIZE) repeatMemo.delete(repeatMemo.keys().next().value!);
    return plan;
  };
  /**
   * The Sections slider's boundaries at g, before snapping. The top half adds the repetition splits of all stems. No added piece is under a bar of the active snap grid, or of allin1's downbeats when snap is off.
   */
  const boundariesAt = (g: number, snapOn: boolean, target: SnapTarget) => {
    if (!canGranulate) return initial;
    const snapGrid = snapOn && canSnap ? grids[target] : [];
    return granularBoundaries(initial, candidates, g, duration, CANDIDATE_FLOOR, snapGrid.length > 0 ? snapGrid : grids.downbeats, snapGrid, cutsFor);
  };
  const start = boundariesAt(p.granularity ?? 0, p.snap, target0);
  const snapped = p.snap && canSnap ? resnap(start, {}, grids[target0], duration) : null;

  /**
   * True once the boundaries or names were edited by hand (move, add, remove, rename) since the Sections slider last
   * set them (opening counts as setting them). Until then a snap or target change rebuilds the slider's boundaries on
   * the new basis, so the next step up only adds (review I1); after one, it re-snaps them and the edits are kept.
   */
  let edited = false;
  const sliderOwns = () => canGranulate && state.granularity !== 0 && !edited;

  /**
   * Rebuilds the boundaries from the slider's value on the current snap basis, as setGranularity does. A rename moves
   * to the new section with exactly the same start and end, when there is one; only the others are dropped (dev-H,
   * fb2: a slider move must not silently clear the renames).
   */
  const regranulate = () => {
    const named = new Map(spans().flatMap((sp, i) => (state.labels[i] === undefined ? [] : [[spanKey(sp.start, sp.end), state.labels[i]] as const])));
    state.boundaries = boundariesAt(state.granularity, state.snap, state.snapTarget);
    state.labels = {};
    state.selected = null;
    state.selectedCut = null;
    state.snapMerged = 0;
    if (snapping()) resnapNow();
    spans().forEach((sp, i) => {
      const name = named.get(spanKey(sp.start, sp.end));
      if (name !== undefined) state.labels[i] = name;
    });
  };

  // Marker ids run alongside state.boundaries. They start at 1..n and are never reused: `nextId` only goes up.
  let markerIds: number[] = [];
  let nextId = 1;
  const freshId = () => nextId++;
  const markersNow = (): Marker[] => state.boundaries.map((time, i) => ({ id: markerIds[i], time }));
  /** Where the current snap setting puts a time: onto the grid, or nowhere when snap is off. */
  const snapper = (): ((t: number) => number) => {
    if (!snapping()) return (t) => t;
    const g = grid();
    return (t) => snapTime(t, g);
  };
  /**
   * Runs a change that rebuilds the boundaries, then hands the ids on. A new boundary keeps the id of the old one it
   * was re-snapped from (the old one snapped lands on it, or it snapped back lands on the old one); failing that, of an
   * old one at the same time; otherwise it gets a fresh id. An old id goes to at most one boundary, the earliest.
   */
  const rebuilding = (change: () => void) => {
    const prev = markersNow();
    const wasSnapped = snapper();
    change();
    const snapped = snapper();
    const used = new Set<number>();
    const claim = (n: number, fits: (old: number) => boolean) => {
      const k = prev.findIndex((m, j) => !used.has(j) && fits(m.time));
      if (k >= 0) used.add(k);
      return k;
    };
    const from = state.boundaries.map((n) => claim(n, (o) => near(snapped(o), n) || near(o, wasSnapped(n))));
    markerIds = state.boundaries.map((n, i) => {
      const k = from[i] >= 0 ? from[i] : claim(n, (o) => near(o, n));
      return k >= 0 ? prev[k].id : freshId();
    });
  };

  /** Re-snaps the current boundaries to the current grid; renames follow the surviving spans. */
  const resnapNow = () => {
    const r = resnap(state.boundaries, state.labels, grid(), duration);
    state.boundaries = r.boundaries;
    state.labels = r.labels;
    state.snapMerged = r.merged;
    state.selected = null;
    state.selectedCut = null;
  };

  // Plan 6: the pattern lanes. The engine is made on first use (it decodes every source); features it cannot take at all
  // are as none: no pattern lanes, the v2 lanes only.
  const features = p.patterns ?? null;
  const laneDuration = features?.durationSec ?? duration;
  let engine: PatternEngine | null | undefined; // undefined: not made yet
  const engineNow = (): PatternEngine | null => {
    if (engine !== undefined) return engine;
    engine = null;
    if (features) {
      if (Math.abs(features.durationSec - duration) > 1 / CELL_RATE) {
        console.warn(`Song Sections: the pattern features are ${features.durationSec} s long, the clip ${duration} s: the pattern lanes will not tile it`);
      }
      try {
        engine = createPatternEngine(features, { warn: (message) => console.warn(message) });
      } catch (error) {
        console.warn(`Song Sections: no pattern lanes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return engine;
  };
  // The lanes, the Patterns levels and Slice by are the four stems'. The engine still reads the mix (it is the only
  // source of a clip without kept stems, and the scorer's answer keys name it), but nothing here shows or counts it.
  const noSources: StemName[] = [];
  let stemSources: { engine: PatternEngine; sources: StemName[] } | null = null;
  const sourcesNow = (): StemName[] => {
    const e = engineNow();
    if (!e) return noSources;
    if (stemSources?.engine !== e) stemSources = { engine: e, sources: e.sources.filter((s): s is StemName => s !== "mix") };
    return stemSources.sources;
  };
  const hasLane = (s: StemName) => sourcesNow().includes(s);

  const noSteps = [0];
  let stepsMemo: { key: string; steps: number[] } | null = null;
  const stepsNow = (): number[] => {
    const e = engineNow();
    const sources = sourcesNow();
    if (!e || sources.length === 0) return noSteps;
    const key = state.boundaries.join(",");
    if (stepsMemo?.key === key) return stepsMemo.steps;
    const sections = sectionSpans(markersNow(), laneDuration);
    // Every level at once: the engine splits a section for all levels at once and keeps a bounded number of sections, so
    // asking a level at a time over every section could split each section once per level. And over every section at
    // once: a section that repeats an earlier stretch is cut like it (cutAlike), so its cuts depend on the sections before.
    const bySource = sources.map((src) => e.machineLevels(src, sections));
    const steps = [0];
    for (let l = 1; l <= PATTERN_LEVELS; l++) {
      const last = steps[steps.length - 1];
      if (bySource.some((levels) => !sameCuts(levels[l], levels[last]))) steps.push(l);
    }
    stepsMemo = { key, steps };
    return steps;
  };
  /** An engine level: rounded and clamped to 0 .. PATTERN_LEVELS. */
  const clampLevel = (l: number) => Math.min(PATTERN_LEVELS, Math.max(0, Math.round(Number.isFinite(l) ? l : 0)));
  /** An engine level: clamped, then (with pattern lanes) the step at or below it. */
  const snapLevel = (l: number) => {
    const r = clampLevel(l);
    if (sourcesNow().length === 0) return r; // no lanes: keep the remembered level for the next clip (as review M4)
    let step = 0;
    for (const s of stepsNow()) if (s <= r) step = s;
    return step;
  };
  let level: number | null = null; // the payload's level, snapped on first use (the steps need the engine)
  const levelNow = () => (level ??= snapLevel(p.patternLevel));
  /** The level prefs() remembers: the payload's as it came (clamped), until the slider sets one (as wantedTarget for snap). */
  let wantedLevel = clampLevel(p.patternLevel);

  // His edits, per lane. They live as long as the dialog: the slider, colours and snap never touch them.
  const laneEdits = new Map<StemName, LaneEdits>();
  const editsOf = (src: StemName): LaneEdits => {
    let e = laneEdits.get(src);
    if (!e) laneEdits.set(src, (e = blankEdits()));
    return e;
  };
  /** The lanes' key besides the level and the edits: the markers' contents (markers() is a new array each call). */
  const laneKey = () => markersNow().map((m) => `${m.id}@${m.time}`).join(",");
  /**
   * Each lane at every level visited since the markers or its edits last changed, so a Patterns step back to a level
   * is a lookup (final review item 7: on a long clip, naming a lane again costs hundreds of ms).
   */
  const sliceMemo = new Map<StemName, { key: string; edits: LaneEdits; byLevel: Map<number, PatternSlice[]> }>();
  const slicesOf = (src: StemName, key = laneKey()): PatternSlice[] => {
    const e = engineNow();
    if (!e) return [];
    const edits = editsOf(src);
    let m = sliceMemo.get(src);
    if (!m || m.key !== key || m.edits !== edits) sliceMemo.set(src, (m = { key, edits, byLevel: new Map() }));
    const l = levelNow();
    let slices = m.byLevel.get(l);
    if (!slices) m.byLevel.set(l, (slices = e.lane(src, markersNow(), l, edits)));
    return slices;
  };
  const cutsOf = (src: StemName): LaneCut[] => slicesOf(src).slice(1).map((s) => s.cut!);
  /** Colors picked for patterns, per lane, by nameKey of the cell's label (Matt, 2026-11-12). */
  const laneColors = new Map<StemName, Map<string, Rgb>>();
  const hueOf = (slices: PatternSlice[]) => patternHues(slices.map((s) => s.name), slices.map((s) => s.label));
  const cellsOf = (src: StemName, slices: PatternSlice[], pal: Palette): LaneCell[] => {
    const hues = hueOf(slices);
    const picked = laneColors.get(src);
    return slices.map(({ start, end, name, label, cut }, i) => {
      const hue = hues[i];
      const rest = hue === null;
      const color = rest ? REST_COLOR : (picked?.get(nameKey(label ?? "")) ?? groupColor(hue - 1, name.variant, pal));
      return { start, end, label: label ?? "", rest, color, owner: cut?.owner ?? null };
    });
  };
  let patternMemo: { palette: Palette; parts: PatternSlice[][]; lanes: Partial<Record<StemName, LaneCell[]>> } | null = null;
  /** The lanes patternLanes() last gave, and the markers they were made at: what previewLanes() moves the cuts of. */
  let shownLanes: { markers: Marker[]; lanes: Partial<Record<StemName, LaneCell[]>> } | null = null;
  /** Applies one edit to a lane's edits; true when they changed. */
  const editLane = (src: StemName, edit: (edits: LaneEdits, cuts: LaneCut[]) => LaneEdits): boolean => {
    if (!hasLane(src)) return false;
    const before = editsOf(src);
    const next = edit(before, cutsOf(src));
    if (next === before) return false;
    laneEdits.set(src, next);
    return true;
  };
  /** Where a lane edit lands: snapped as a marker edit is, unless free. Machine cuts are never snapped. */
  const laneTime = (t: number, free: boolean) => (snapping() && !free ? snapTime(t, grid()) : t);
  let selectedBoundary: number | null = null;
  let selectedLaneCut: LaneCutRef | null = null;

  /** A rename that starts with a letter takes that letter's colour (feedback round 2); any other label keeps its group's. */
  const colorOf = (renamed: string | undefined, g: SectionGroup): Rgb => {
    const named = renamed === undefined ? null : labelGroup(renamed);
    return named ? groupColor(named.group, named.variant, palette()) : groupColor(g.group, g.variant, palette());
  };

  /** Colors picked from the menu's swatches, by nameKey (Matt, 2026-11-12). */
  const nameColors = new Map<string, Rgb>();

  const opening = snapped ? snapped.boundaries : start;
  markerIds = opening.map(freshId);

  const state: StructureDialogState = {
    boundaries: opening,
    snapMerged: snapped ? snapped.merged : 0,
    snap: p.snap,
    snapTarget: target0,
    granularity: canGranulate ? (p.granularity ?? 0) : 0,
    get canGranulate() {
      return canGranulate;
    },
    groupDist: p.groupDist,
    showStems: p.showStems,
    get canSnap() {
      return canSnap;
    },
    get canSnapDownbeats() {
      return canSnapDownbeats;
    },
    get canSnapBars() {
      return canSnapBars;
    },
    get handEdited() {
      return edited || Object.keys(state.labels).length > 0 || nameColors.size > 0 || laneColors.size > 0 || [...laneEdits.values()].some(hasEdits);
    },
    labels: {},
    sliceBy: SLICE_BYS.includes(p.sliceBy) ? p.sliceBy : "sections", // a stored "mix" (the removed All) is Sections
    get patternLevel() {
      return levelNow();
    },
    colorMode: p.colorMode,
    output: p.output,
    get selected() {
      return selectedBoundary;
    },
    set selected(i) {
      selectedBoundary = i;
      if (i !== null) state.selectedCut = null;
    },
    get selectedCut() {
      return selectedLaneCut;
    },
    set selectedCut(sel) {
      selectedLaneCut = sel;
      if (sel !== null) selectedBoundary = null;
    },

    setSnap(on) {
      rebuilding(() => {
        state.snap = on;
        if (sliderOwns()) regranulate();
        else if (on && canSnap) resnapNow();
      });
    },

    setGranularity(g) {
      if (!canGranulate) return;
      rebuilding(() => {
        state.granularity = g;
        edited = false;
        regranulate();
      });
    },

    setGroupDist(d) {
      state.groupDist = d;
    },

    setShowStems(on) {
      state.showStems = on;
    },

    setSnapTarget(t) {
      if (grids[t].length > 0) wantedTarget = t;
      const next = usable(t);
      if (next === state.snapTarget) return;
      rebuilding(() => {
        state.snapTarget = next;
        if (sliderOwns()) regranulate();
        else if (snapping()) resnapNow();
      });
    },

    move(i, t, free = false) {
      edited = true;
      state.snapMerged = 0;
      state.selectedCut = null; // the marker's cut may pass others in a lane, so lane indices can shift
      state.boundaries = moveBoundary(state.boundaries, i, snapping() && !free ? snapTime(t, grid()) : t, duration);
    },

    add(t, free = false) {
      state.snapMerged = 0;
      if (snapping() && !free) t = snapTime(t, grid());
      const next = addBoundary(state.boundaries, t, duration);
      if (next.length === state.boundaries.length) return;
      edited = true;
      const k = next.indexOf(t);
      state.boundaries = next;
      markerIds.splice(k, 0, freshId());
      state.labels = shiftForAdd(state.labels, k);
      state.selected = k;
    },

    remove(i) {
      edited = true;
      state.snapMerged = 0;
      state.boundaries = removeBoundary(state.boundaries, i);
      markerIds.splice(i, 1);
      state.labels = shiftForRemove(state.labels, i);
      state.selected = null;
      state.selectedCut = null;
    },

    rename(i, s, insert = false) {
      const sp = spans();
      if (!sp[i]) return;
      edited = true;
      const gs = state.groups();
      const defaults = sp.map((x, j) => defaultLabel(gs[j], x.start, x.end));
      const blank = s.trim() === "";
      const name = blank ? defaults[i] : s.trim();
      let labels = sp.map((_, j) => state.labels[j] ?? defaults[j]);
      const was = [...labels];
      const k = letterKey(name);
      if (insert && k && isBareKey(name, letterKey) && labels.some((l, j) => j !== i && letterKey(l)?.key === k.key)) labels = insertKey(labels, letterKey, k.key);
      // A blank name is the automatic one back (Matt, 2026-11-12). When a rename closed that letter's gap, the sections
      // moved down into it move back up, as the + would, so every label comes back.
      if (blank && k && labels.some((l, j) => j !== i && letterKey(l)?.key === k.key && letterKey(defaults[j])?.key !== k.key)) {
        labels = insertKey(labels, letterKey, k.key);
      }
      labels[i] = name;
      labels = closeGaps(labels, letterKey);
      // A color picked for a name follows it when the + or a closed gap renumbers it (the renamed section leaves its own).
      remapColors(nameColors, was, labels, (j) => j !== i);
      // A default label is not an override: storing it would pin a stale letter after the next edit.
      const next: Record<number, string> = {};
      labels.forEach((l, j) => {
        if (l !== defaults[j]) next[j] = l;
      });
      state.labels = next;
    },

    setColorMode(m) {
      state.colorMode = m;
    },

    setSliceBy(sliceBy) {
      state.sliceBy = sliceBy;
    },

    markers: markersNow,

    get patternSources() {
      return sourcesNow();
    },

    get effectiveSliceBy() {
      const by = state.sliceBy;
      if (by === "sections") return by;
      if (p.view === "arrangement" && state.output === "locators") return "sections";
      if (!hasLane(by)) return "sections";
      return state.patternLanes()[by]?.some((c) => !c.rest) ? by : "sections";
    },

    patternSteps: stepsNow,

    setPatternLevel(l) {
      const next = snapLevel(l);
      wantedLevel = next;
      if (next === levelNow()) return;
      level = next;
      state.selectedCut = null; // machine cuts come and go, so lane indices shift
    },

    patternLanes() {
      const sources = sourcesNow();
      const key = laneKey();
      const parts = sources.map((src) => slicesOf(src, key));
      const pal = palette();
      const old = patternMemo?.palette === pal ? patternMemo : null;
      let lanes: Partial<Record<StemName, LaneCell[]>>;
      if (old && parts.every((x, i) => x === old.parts[i])) lanes = old.lanes;
      else {
        lanes = {};
        for (const [i, src] of sources.entries()) lanes[src] = old && old.parts[i] === parts[i] ? old.lanes[src] : cellsOf(src, parts[i], pal);
        patternMemo = { palette: pal, parts, lanes };
      }
      shownLanes = { markers: markersNow(), lanes };
      return lanes;
    },

    previewLanes() {
      const now = markersNow();
      const shown = shownLanes;
      if (!shown || shown.markers.length !== now.length || shown.markers.some((m, i) => m.id !== now[i].id)) return state.patternLanes();
      const moves = now.flatMap((m, i) => (m.time === shown.markers[i].time ? [] : [{ from: shown.markers[i].time, to: m.time }]));
      if (moves.length === 0) return shown.lanes;
      const lanes: Partial<Record<StemName, LaneCell[]>> = {};
      for (const src of sourcesNow()) {
        const cells = shown.lanes[src];
        if (cells) lanes[src] = followMarkers(cells, moves, laneDuration);
      }
      return lanes;
    },

    selectLaneCut(sel) {
      state.selectedCut = sel;
    },

    moveLaneCut(source, index, t, free = false) {
      const before = editsOf(source).added;
      if (!editLane(source, (e, cuts) => moveCut(e, cuts, index, laneTime(t, free), laneDuration))) return;
      // moveCut keeps the cut between its neighbours, but a cut it hid (a machine cut closer than MIN_SECTION_SEC, from a
      // slider move after his cut) comes back as it moves away, and the indices shift. The selection follows the moved
      // cut, his own now, by the time it landed at: the one entry of `added` that is new.
      const sel = state.selectedCut;
      if (sel?.source !== source || sel.index !== index) return;
      const landed = editsOf(source).added.find((a) => !before.includes(a));
      const k = cutsOf(source).findIndex((c) => c.owner === "user" && c.time === landed);
      if (k >= 0 && k !== index) state.selectedCut = { source, index: k };
    },

    insertLaneCut(source, t, free = false) {
      const at = laneTime(t, free);
      if (!editLane(source, (e, cuts) => insertCut(e, cuts, at, laneDuration))) return;
      const index = cutsOf(source).findIndex((c) => c.owner === "user" && c.time === at);
      state.selectLaneCut(index >= 0 ? { source, index } : null);
    },

    deleteLaneCut(source, index) {
      if (editLane(source, (e, cuts) => deleteCut(e, cuts, index)) && state.selectedCut?.source === source) state.selectedCut = null;
    },

    renamePattern(source, cellIndex, name, insert = false) {
      if (!hasLane(source)) return;
      const slices = slicesOf(source);
      const pattern = slices[cellIndex]?.name.pattern;
      if (pattern == null) return; // a rest is never named
      // The lane's base patterns and the names they show now (a variant's label without its prime).
      const patterns = [...new Set(slices.map((s) => s.name.pattern).filter((p): p is number => p !== null))].sort((x, y) => x - y);
      const shown = (p: number) => {
        const s = slices.find((x) => x.name.pattern === p)!;
        return s.name.variant ? (s.label ?? "").replace(TRAILING_PRIMES, "") : (s.label ?? patternText(s.name));
      };
      const before = patterns.map(shown);
      const fallbackOf = (p: number) => patternText({ pattern: p, variant: false });
      // Primes in any spelling and number (an ASCII ' is what a keyboard types).
      const raw = name.trim();
      // A blank name is the automatic one back (Matt, 2026-11-12): a reassigned cell goes back to its own pattern;
      // otherwise the pattern takes its own number again, and any moved down into it move back up, as the + does.
      if (raw === "" && !insert) {
        const cell = slices[cellIndex];
        const without = unassignCell(editsOf(source), { start: cell.start, end: cell.end });
        if (without === editsOf(source)) return state.renamePattern(source, cellIndex, fallbackOf(pattern), true);
        laneEdits.set(source, without);
        const picked = laneColors.get(source);
        const after = slicesOf(source);
        if (picked && after.length === slices.length) remapColors(picked, slices.map((x) => x.label ?? ""), after.map((x) => x.label ?? ""), (j) => j !== cellIndex);
        patternMemo = null;
        return;
      }
      const primed = TYPED_PRIMES.test(raw);
      const base = raw.replace(TYPED_PRIMES, "").trimEnd();
      // A name in use in this lane (Matt, 2026-11-12): just this cell moves to that pattern, as a variant when primed.
      // Typing the cell's own name with or without a prime makes it, alone, a variant of its pattern or not.
      const target = insert || base === "" ? undefined : patterns.find((p) => nameKey(shown(p)) === nameKey(base));
      if (target !== undefined) {
        const cell = slices[cellIndex];
        if (target === pattern && primed === cell.name.variant) return;
        const span = { start: cell.start, end: cell.end };
        const want = nameKey(shown(target) + (primed ? "′" : ""));
        const without = unassignCell(editsOf(source), span);
        laneEdits.set(source, without);
        // What the other edits make it already (choosing its own name back): no reassignment.
        if (nameKey(slicesOf(source)[cellIndex]?.label ?? "") !== want) {
          const members = slices.filter((x, j) => j !== cellIndex && x.name.pattern === target).map(({ start, end }) => ({ start, end }));
          laneEdits.set(source, assignCell(without, span, members.length > 0 ? members : [span], primed));
        }
        const picked = laneColors.get(source);
        const after = slicesOf(source);
        if (picked && after.length === slices.length) remapColors(picked, slices.map((x) => x.label ?? ""), after.map((x) => x.label ?? ""), (j) => j !== cellIndex);
        patternMemo = null;
        return;
      }
      // A new name renames the whole pattern. The prime is the variants', never the name's, so no variant shows ″.
      const typed = base || fallbackOf(pattern);
      const at = patterns.indexOf(pattern);
      let names = [...before];
      const k = numberKey(typed);
      if (insert && k && isBareKey(typed, numberKey) && names.some((n, j) => j !== at && numberKey(n)?.key === k.key)) names = insertKey(names, numberKey, k.key);
      names[at] = typed;
      names = closeGaps(names, numberKey);
      let edits = editsOf(source);
      patterns.forEach((p, j) => {
        if (names[j] === before[j] && j !== at) return;
        // Every cell of the base pattern, its variants included, so the rename finds the whole pattern again by time.
        const members = slices.filter((s) => s.name.pattern === p).map(({ start, end }) => ({ start, end }));
        const fallback = fallbackOf(p);
        const cleared = renameInLane(edits, members, "", fallback);
        edits = names[j] === fallback ? cleared : renameInLane(cleared, members, names[j], fallback);
      });
      laneEdits.set(source, edits);
      // As for sections: a picked color follows a pattern the rename renumbered, not the renamed one.
      const picked = laneColors.get(source);
      if (picked) {
        const after = slicesOf(source);
        if (after.length === slices.length) {
          remapColors(picked, slices.map((x) => x.label ?? ""), after.map((x) => x.label ?? ""), (j) => slices[j].name.pattern !== pattern);
          patternMemo = null;
        }
      }
    },

    groups() {
      const key = `${state.groupDist}|${state.boundaries.join(",")}`;
      if (memo?.key !== key) memo = { key, groups: grouped(LETTERS_FROM, spans()) };
      return memo.groups;
    },

    lanes() {
      const key = `${palette()}|${state.groupDist}|${state.boundaries.join(",")}`;
      if (laneMemo?.key !== key) {
        const sp = spans();
        const lanes = {} as Record<StemName, LaneSection[]>;
        for (const stem of STEM_NAMES) {
          const gs = grouped(stem, sp);
          lanes[stem] = sp.map(({ start, end }, i) => {
            const g = gs[i];
            const silent = g.group === null;
            const loud = silent ? -Infinity : sectionLoudness(a, stem, start, end);
            const brightness = silent ? 0 : Math.min(Math.max((loud - BRIGHTNESS_FLOOR_DB) / BRIGHTNESS_RANGE_DB, 0), 1);
            return {
              start,
              end,
              label: silent ? "–" : letterName(g.group!) + (g.variant ? "′" : ""),
              color: dim(groupColor(g.group, g.variant, palette()), brightness),
            };
          });
        }
        laneMemo = { key, lanes };
      }
      return laneMemo.lanes;
    },

    sections() {
      const gs = state.groups();
      return spans().map((s, i) => {
        const label = state.labels[i] ?? defaultLabel(gs[i], s.start, s.end);
        return {
          start: s.start,
          end: s.end,
          label,
          color: state.colorMode === "uniform" ? p.sourceColor : (nameColors.get(nameKey(label)) ?? colorOf(state.labels[i], gs[i])),
        };
      });
    },

    setNameColor(i, color) {
      const sec = state.sections()[i];
      if (!sec) return;
      if (color === null) nameColors.delete(nameKey(sec.label));
      else nameColors.set(nameKey(sec.label), color);
    },

    setPatternColor(source, cellIndex, color) {
      const cell = state.patternLanes()[source]?.[cellIndex];
      if (!cell || cell.rest) return;
      const key = nameKey(cell.label);
      const picked = laneColors.get(source) ?? new Map<string, Rgb>();
      if (color === null) picked.delete(key);
      else picked.set(key, color);
      if (picked.size > 0) laneColors.set(source, picked);
      else laneColors.delete(source);
      patternMemo = null; // the cells are the same; their colors are not
    },

    patternSwatches(source, cellIndex) {
      const cell = state.patternLanes()[source]?.[cellIndex];
      const hue = cell && !cell.rest ? hueOf(slicesOf(source))[cellIndex] : null;
      return {
        shades: hue === null || hue === undefined ? [] : groupShades(hue - 1, palette()),
        others: OTHER_COLORS[palette()],
        current: cell?.color ?? 0,
        picked: cell ? (laneColors.get(source)?.has(nameKey(cell.label)) ?? false) : false,
      };
    },

    swatches(i) {
      const sec = state.sections()[i];
      const named = sec ? labelGroup(sec.label) : null;
      return {
        shades: named ? groupShades(named.group, palette()) : [],
        others: OTHER_COLORS[palette()],
        current: sec?.color ?? 0,
        picked: sec ? nameColors.has(nameKey(sec.label)) : false,
      };
    },

    prefs() {
      const { sliceBy, colorMode, snap, groupDist, showStems } = state;
      // Without candidates the slider is disabled at 0; keep the remembered value for the next clip (review M4).
      const granularity = canGranulate ? state.granularity : (p.granularity ?? 0);
      return { sliceBy, patternLevel: wantedLevel, colorMode, snap, snapTarget: wantedTarget, granularity, groupDist, showStems };
    },

    laneSlices(source) {
      const cells = state.patternLanes()[source] ?? [];
      const color = (c: LaneCell) => (state.colorMode === "uniform" ? p.sourceColor : c.color);
      // The lanes run over the features' duration, which may be a cell or so off the clip's: clamp to the clip.
      const slices: Section[] = cells
        .filter((c) => !c.rest && c.start < duration)
        .map((c) => ({ start: c.start, end: Math.min(c.end, duration), label: `${source} ${c.label}`, color: color(c) }));
      const last = slices.at(-1);
      if (last && last.end - last.start < MIN_SECTION_SEC - SAME_TIME) {
        slices.pop();
        const before = slices.at(-1);
        if (before && near(before.end, last.start)) before.end = last.end;
      }
      return slices;
    },

    applyPieces() {
      const by = state.effectiveSliceBy;
      if (by === "sections") return null;
      const pieces = state.laneSlices(by);
      if (pieces.length === 0) return null;
      if (p.view === "session") return pieces;
      // Arrangement: each piece runs to the next one's start, and the first from 0 and the last to the clip's end (so a
      // short last slice left out after a rest joins the piece before it here too).
      return pieces.map((x, i) => ({ ...x, start: i === 0 ? 0 : x.start, end: i === pieces.length - 1 ? duration : pieces[i + 1].start }));
    },

    result() {
      const pieces = state.applyPieces();
      return { action: "apply", sections: state.sections(), output: state.output, ...(pieces ? { pieces } : {}), prefs: state.prefs() };
    },

    cancel() {
      return { action: "cancel" };
    },
  };
  return state;
}

/**
 * A lane's cells with the cut at each moved marker (`from` → `to`) following it (previewLanes). A lane whose cut at
 * `from` is not a marker's (his edits detached it) does not follow that marker, nor does one `to` leaves outside the lane. Other cuts strictly between `from` and
 * `to`, or within MIN_SECTION_SEC of `to`, are hidden; markers never pass each other (moveBoundary keeps them apart).
 * Each cell keeps the owner of the cut it starts at, and takes the rest from the old cell under its middle (respan).
 */
function followMarkers(cells: LaneCell[], moves: { from: number; to: number }[], duration: number): LaneCell[] {
  const owner = new Map(cells.slice(1).map((c) => [c.start, c.owner]));
  const followed = moves.filter((m) => owner.get(m.from) === "marker" && m.to > 0 && m.to < duration);
  const from = new Set(followed.map((m) => m.from));
  const passed = (t: number) => followed.some((m) => (t > Math.min(m.from, m.to) && t < Math.max(m.from, m.to)) || Math.abs(t - m.to) < MIN_SECTION_SEC);
  const edges = cells
    .slice(1)
    .map((c) => c.start)
    .filter((t) => !from.has(t) && (owner.get(t) === "marker" || !passed(t)));
  for (const m of followed) {
    edges.push(m.to);
    owner.set(m.to, "marker");
  }
  edges.sort((x, y) => x - y);
  return respan(edges, duration, cells).map((c, i) => ({ ...c, owner: i === 0 ? null : (owner.get(c.start) ?? null) }));
}

/**
 * The spans of `boundaries` over [0, duration], each carrying the other fields (label, colour) of the `prev` item that
 * covers its midpoint. `prev` is contiguous and ascending. A cheap preview for the bands and lanes while the letters
 * for new boundaries wait (fix round, review I3): the edges are right at once, the letters catch up.
 */
export function respan<T extends { start: number; end: number }>(boundaries: number[], duration: number, prev: T[]): T[] {
  if (prev.length === 0) return [];
  const edges = [0, ...boundaries, duration];
  const out: T[] = [];
  let k = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const mid = (edges[i] + edges[i + 1]) / 2;
    while (k < prev.length - 1 && prev[k].end <= mid) k++;
    out.push({ ...prev[k], start: edges[i], end: edges[i + 1] });
  }
  return out;
}

/**
 * The Patterns slider's position for an engine level: the index of the last of `steps` (ascending, starting at 0) at or
 * below it. A marker edit can leave the level between steps (Task 3 keeps it, so moving a marker back never lowers it);
 * it then shows, and its lanes are, the step below.
 */
export function stepIndex(steps: readonly number[], level: number): number {
  let index = 0;
  steps.forEach((s, i) => {
    if (s <= level) index = i;
  });
  return index;
}

/** The index of the span (contiguous, ascending) holding time `t`; an edge belongs to the span it starts. Clamped. */
export function sectionAt(spans: readonly { start: number; end: number }[], t: number): number {
  let i = 0;
  while (i < spans.length - 1 && spans[i].end <= t) i++;
  return i;
}
