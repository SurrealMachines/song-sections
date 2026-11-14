// No Node imports: the dialog bundles this file too.
import { STEM_NAMES, type StemName, type StructureAnalysis } from "../structure/contract.js";
import { GROUP_DIST_MAX, GROUP_DIST_MIN } from "../grouping/letters.js";
import type { ArrangementOutput, ColorMode, Rgb, Section, View } from "../core/types.js";
import { PATTERN_LEVELS, type PatternFeatures } from "../patterns/contract.js";

/** Which stem the letters come from: all of them, one, or the melody (vocals and other together, fb2). Kept for src/grouping; the dialog always uses "all". */
export type GroupBy = "all" | StemName | "melody";
/** Plan 6: what the dialog slices the clip by. A remembered "mix" (the removed All) reads as "sections", as any unknown value does. */
export type SliceBy = "sections" | StemName;
export const SLICE_BYS: readonly SliceBy[] = ["sections", ...STEM_NAMES];
/** "groups" is Vivid (the stored value predates Soft), "soft" Live's muted rows, "uniform" the clip's own colour. */
export type StructureColorMode = "groups" | "soft" | "uniform";
export type DialogMode = "cue" | "structure";
/** Structure snapping: allin1's downbeats, or Live's bar grid (feedback round 1). */
export type SnapTarget = "downbeats" | "bars";

/** The modal dialog's [width, height] per mode. The layout fills it (the waveform takes the spare height). */
export const DIALOG_SIZE: Record<DialogMode, [number, number]> = { cue: [1000, 560], structure: [1000, 680] };

export interface ModeInfo {
  structure: {
    available: boolean;
    reason: string | null; // why not, when !available
    cached: boolean;
    needsDownload: boolean;
    downloadBytes: number;
    /** fb/hfmodels: what the models take on disk once built (the consent prompt quotes it); absent in older payloads. */
    diskBytes?: number;
    estimateSec: number;
    warn: boolean; // long track: warn before analysing
    retryable?: boolean; // the last model download failed for a reason a second attempt can fix; a switch retries it
    /** fb2: the last mode applied was Structure, so the Cue view highlights its tab as the suggestion. */
    suggested?: boolean;
    /**
     * fb2: a Structure analysis of this clip is running in the host, or starts once this page is up. The Cue view polls
     * STRUCTURE_PROGRESS_ROUTE for its progress and shows it on the Structure tab.
     */
    background?: boolean;
  };
}

/** fb2: the route, next to the page, that answers with the background Structure analysis's StructureProgress. */
export const STRUCTURE_PROGRESS_ROUTE = "structure";

/**
 * The background Structure analysis as the dialog server reports it: "pending" until it starts (once the page is up),
 * "none" when there is none (never started, or stopped by a new run). `percent` is 0..100 while "running".
 */
export interface StructureProgress {
  state: "pending" | "running" | "done" | "failed" | "none";
  percent: number;
}

/**
 * v2, key per section: the harmonic chroma time series the dialog keys sections from (key/key.ts). `chroma[f]` is 12
 * pitch-class energies (C first) of the frame [f / rate, (f + 1) / rate) seconds, scaled so the clip's largest is 1.
 * `source`: "stems" is bass + other + vocals (no drums), from a Structure analysis's kept stems; "mix" the clip itself.
 */
export interface Harmony {
  source: "stems" | "mix";
  rate: number;
  chroma: number[][];
  /** The tuning the chroma was folded about, in cents from A = 440 Hz (-50 … 50); absent in older entries. */
  tuningCents?: number;
}

/** v2: Live's Scale Mode was on: the Set's scale (Song.rootNote, 0 = C, and scaleName), shown beside the clip key. */
export interface SetScale {
  root: number;
  name: string;
}

interface PayloadBase {
  view: View;
  clipName: string;
  durationSec: number;
  audioUrl: string; // relative to the dialog page's origin
  waveform: { min: number[]; max: number[] };
  sourceColor: Rgb;
  output: ArrangementOutput; // ignored when view === "session"
  warpNote: boolean; // Session only: info.warped (fb3: Live may warp the slices differently; Arrangement split keeps markers)
  /** fb3: the song tempo (BPM), for nudging by a beat with no grid; absent from older payloads. */
  tempo?: number;
  modes: ModeInfo;
  /** v2: the harmonic chroma for the keys; absent or null: no keys (it could not be computed). */
  harmony?: Harmony | null;
  /** v2: the Set's scale when Scale Mode is on; absent or null otherwise. */
  setScale?: SetScale | null;
  /** v2: the "Key in names" toggle of the send menu (remembered in settings.json); absent: on. */
  keyInNames?: boolean;
}

export interface CuePayload extends PayloadBase {
  mode: "cue";
  novelty: number[];
  blocksPerSec: number;
  boundaries: number[];
  granularity: number;
  colorMode: ColorMode;
  beatGrid: number[] | null; // null: no grid, snapping unavailable
  /** fb3: Live's bar lines in clip seconds (null: none), for Shift+arrow nudges and the length labels. */
  barGrid?: number[] | null;
  /**
   * fb4, item 1: without Live's grid (beatGrid null: an unwarped Session clip), a cached Structure analysis's beats
   * and downbeats for this audio, so the lengths and nudges still go by bars and beats. Absent or null: none.
   */
  structureGrid?: { beats: number[]; downbeats: number[] } | null;
  snap: boolean;
}

/** The Structure dialog's choices, remembered across runs in settings.json (feedback round 1). */
export interface StructurePrefs {
  sliceBy: SliceBy;
  /** Patterns slider: an integer 0 (Fewer) .. PATTERN_LEVELS (More). */
  patternLevel: number;
  colorMode: StructureColorMode;
  snap: boolean;
  snapTarget: SnapTarget;
  /** Sections slider, -1 (Fewer) .. 1 (More); 0 is allin1's own boundaries. */
  granularity: number;
  /** Letters slider: the grouping distance, GROUP_DIST_MIN (Strict) .. GROUP_DIST_MAX (Loose). */
  groupDist: number;
  showStems: boolean;
}

/**
 * What a fresh install opens with (Matt, Live, 4 Nov: the settings he works with) and what a double-click on a slider
 * resets it to. Patterns is the top level; the dialog snaps it down to the clip's highest real step.
 */
export const DEFAULT_STRUCTURE_PREFS: StructurePrefs = {
  sliceBy: "sections",
  patternLevel: PATTERN_LEVELS,
  colorMode: "soft",
  snap: true,
  snapTarget: "bars",
  granularity: -0.14,
  groupDist: 0.22,
  showStems: true,
};

const COLOR_MODES: readonly StructureColorMode[] = ["groups", "soft", "uniform"];
const SNAP_TARGETS: readonly SnapTarget[] = ["downbeats", "bars"];

/** Valid fields of `v` over the defaults; the sliders are clamped to their ranges. Never throws. */
export function structurePrefs(v: unknown): StructurePrefs {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_STRUCTURE_PREFS;
  const pick = <T>(x: unknown, ok: readonly T[], dflt: T) => (ok.includes(x as T) ? (x as T) : dflt);
  const num = (x: unknown, lo: number, hi: number, dflt: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt);
  return {
    sliceBy: pick(o.sliceBy, SLICE_BYS, d.sliceBy),
    patternLevel: Math.round(num(o.patternLevel, 0, PATTERN_LEVELS, d.patternLevel)),
    colorMode: pick(o.colorMode, COLOR_MODES, d.colorMode),
    snap: typeof o.snap === "boolean" ? o.snap : d.snap,
    snapTarget: pick(o.snapTarget, SNAP_TARGETS, d.snapTarget),
    granularity: num(o.granularity, -1, 1, d.granularity),
    groupDist: num(o.groupDist, GROUP_DIST_MIN, GROUP_DIST_MAX, d.groupDist),
    showStems: typeof o.showStems === "boolean" ? o.showStems : d.showStems,
  };
}

export interface StructurePayload extends PayloadBase, StructurePrefs {
  mode: "structure";
  analysis: StructureAnalysis;
  barGrid: number[] | null; // Live's bars in clip seconds (barGrid in core/beatGrid.ts); null: no bar grid (unwarped Session)
  /** fb3: Live's beats in clip seconds (cueBeatGrid), for nudging by a beat under Snap to Bars; null: none. */
  beatGrid?: number[] | null;
  /**
   * Feedback round 2 B: each stem's audition WAV, relative to the page like audioUrl (the server also takes
   * `?start=&end=` in seconds for a slice). null or absent: no stems kept for this analysis (a lane click does nothing).
   */
  stemUrls?: Record<StemName, string> | null;
  /** Plan 5: each source's feature cells and the corrected bar grid, for the pattern lanes. Absent or null: no pattern lanes. */
  patterns?: PatternFeatures | null;
}

export type DialogPayload = CuePayload | StructurePayload;

/**
 * v2 sends (Matt, 31 Oct): what a right-click on a band (the mix) or a stem lane cell sends, and where.
 * "simpler": that section into a Simpler on a new MIDI track. "drumRack": every section of the source into a Drum Rack,
 * one pad each, with a MIDI clip that plays them in order. "audioSection": that section as one clip on a new audio
 * track. "audioWhole": the whole source on a new audio track, one unwarped clip per section (Arrangement).
 * Plan 6, Task 8, "allStems": every kept stem on a new audio track of its own, cut at its own lane's slices; in Session,
 * a scene at every stem's cut, named `<section label> <n>`; in the Arrangement (Matt, 3 Nov), a locator at each of
 * `sections`, as Output Locators places them, whatever Output is. The send menu's item and the footer's Send to new
 * tracks button send the same result, so the locators need no flag of their own.
 */
export type SendTarget = "simpler" | "drumRack" | "audioSection" | "audioWhole" | "allStems";
/** A kept Structure stem, or the mix: the clip's own audio, which the dialog previews. */
export type SendSource = StemName | "mix";
export const SEND_TARGETS: readonly SendTarget[] = ["simpler", "drumRack", "audioSection", "audioWhole", "allStems"];
export const SEND_SOURCES: readonly SendSource[] = ["mix", ...STEM_NAMES];
/**
 * Plan 6: what a send's `sections` are. "sections" (the default): the dialog's sections, from a band or a letter lane.
 * "patterns": a pattern lane's slices, rests left out, each labelled `<source> <pattern>`; its Drum Rack gets a pad
 * per pattern.
 */
export type SendUnit = "sections" | "patterns";

/**
 * A "switch" to Structure carries `download: true` when the user agreed, in the Cue view's prompt, to download the
 * models (fb/hfmodels).
 * `prefs`: the Structure dialog's choices, so the flow can remember them (absent from Cue). "reanalyse" (Structure only,
 * when no stems were kept for its analysis): the flow drops the clip's cached analysis, runs it again so the stems are
 * kept, and reopens Structure with these choices; the dialog's hand edits are not carried over.
 */
export type DialogResult =
  | { action: "cancel" }
  /**
   * `pieces` (Plan 6, Slice by a source): what Apply cuts the clip at instead of the sections, which still give the
   * locators. In Arrangement they tile the clip (a rest joins a neighbour); in Session they leave the rests out.
   */
  | ({ action: "apply"; sections: Section[]; output: ArrangementOutput; pieces?: Section[]; prefs?: StructurePrefs } & KeyPref)
  | ({ action: "switch"; mode: DialogMode; prefs?: StructurePrefs; download?: true } & KeyPref)
  | ({ action: "reanalyse"; prefs?: StructurePrefs } & KeyPref)
  /**
   * v2: closes the dialog as Apply does, and the flow sends. `sections` are the dialog's sections as edited (as Apply's);
   * `index` is the section right-clicked (the one sent by "simpler" and "audioSection"). Plan 6, `unit: "patterns"` (a
   * pattern lane's cell): `sections` are that lane's slices, rests left out, and `index` is the clicked slice's place
   * among them. Absent `unit` means sections. Plan 6, Task 8, target "allStems": `stems` holds each stem's slices (its
   * lane's non-rest cells, as a lane send's; the dialog's sections without pattern lanes; [] for an all-rest lane), and
   * `sections` the dialog's sections, which name the Session scenes; `source` is "mix" and `index` 0.
   */
  | ({
      action: "send";
      target: SendTarget;
      source: SendSource;
      index: number;
      sections: Section[];
      unit?: SendUnit;
      stems?: Record<StemName, Section[]>;
      prefs?: StructurePrefs;
    } & KeyPref);

/** v2: the send menu's "Key in names" toggle as the dialog closed with it (absent: unchanged). */
interface KeyPref {
  keyInNames?: boolean;
}

const MARKER = "<!--PAYLOAD-->";

export function injectPayload(html: string, payload: DialogPayload): string {
  if (!html.includes(MARKER)) throw new Error("Dialog HTML has no <!--PAYLOAD--> marker");
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const script = `<script id="payload" type="application/json">${json}</script>`;
  return html.replace(MARKER, () => script);
}

export function readPayload(doc: Document): DialogPayload {
  const el = doc.getElementById("payload");
  if (!el?.textContent) throw new Error("Dialog payload missing");
  return JSON.parse(el.textContent) as DialogPayload;
}

const CANCEL: DialogResult = { action: "cancel" };
const OUTPUTS = ["split", "locators", "both"];
const MODES: DialogMode[] = ["cue", "structure"];

function withPrefs<T extends DialogResult>(r: T, prefs: unknown, keyInNames?: unknown): T {
  const k = typeof keyInNames === "boolean" ? { keyInNames } : {};
  return prefs === undefined ? { ...r, ...k } : { ...r, prefs: structurePrefs(prefs), ...k };
}

const isSections = (v: unknown): v is Section[] =>
  Array.isArray(v) &&
  v.every(
    (s: Section) =>
      s && typeof s.start === "number" && typeof s.end === "number" &&
      typeof s.label === "string" && typeof s.color === "number",
  );

export function parseResult(raw: string): DialogResult {
  try {
    const v = JSON.parse(raw);
    if (v?.action === "apply" && isSections(v.sections) && OUTPUTS.includes(v.output)) {
      const pieces = isSections(v.pieces) ? { pieces: v.pieces } : {};
      return withPrefs({ action: "apply", sections: v.sections, output: v.output, ...pieces }, v.prefs, v.keyInNames);
    }
    if (
      v?.action === "send" &&
      SEND_TARGETS.includes(v.target) &&
      SEND_SOURCES.includes(v.source) &&
      isSections(v.sections) &&
      Number.isInteger(v.index) &&
      v.index >= 0 &&
      v.index < v.sections.length
    ) {
      if (v.target === "allStems") {
        // Plan 6, Task 8: all four stems, each valid, and nothing else.
        const stems = v.stems;
        if (typeof stems !== "object" || stems === null || !STEM_NAMES.every((s) => isSections(stems[s]))) return CANCEL;
        const four = Object.fromEntries(STEM_NAMES.map((s) => [s, stems[s]])) as Record<StemName, Section[]>;
        return withPrefs({ action: "send", target: v.target, source: v.source, index: v.index, sections: v.sections, stems: four }, v.prefs, v.keyInNames);
      }
      const unit = v.unit === "patterns" ? { unit: "patterns" as const } : {};
      return withPrefs({ action: "send", target: v.target, source: v.source, index: v.index, sections: v.sections, ...unit }, v.prefs, v.keyInNames);
    }
    if (v?.action === "switch" && MODES.includes(v.mode)) {
      // fb/hfmodels: `download: true` is the user's Download in the Structure tab's prompt, the only consent the flow takes.
      return withPrefs({ action: "switch", mode: v.mode, ...(v.download === true && v.mode === "structure" ? { download: true as const } : {}) }, v.prefs, v.keyInNames);
    }
    if (v?.action === "reanalyse") return withPrefs({ action: "reanalyse" }, v.prefs, v.keyInNames);
  } catch {
    // fall through
  }
  return CANCEL;
}
