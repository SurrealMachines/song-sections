// v2 sends (Matt, 31 Oct): a section, or every section, of the mix or a kept Structure stem, sent to a new track.
//
// Drag-out from the dialog is impossible (macOS WKWebView), so the dialog closes with a "send" result (as Apply does)
// and this module performs it: the sections are cut out of the source file into WAVs in a temp folder, each WAV is
// copied into the Live project (importIntoProject, so the Set does not depend on our temp or cache files), and the
// copies are loaded into Live:
//   simpler       one section → a new MIDI track holding a Simpler with it
//   drumRack      every section → a new MIDI track holding a Drum Rack, one pad each from C1 up in time order, and a
//                 MIDI clip that plays the pads in order (Live's own "Slice to New MIDI Track", rebuilt)
//   audioSection  one section → one clip on a new audio track
//   audioWhole    the whole source on a new audio track: one unwarped clip per section (Arrangement), one clip (Session)
// Plan 6: a send from a pattern lane (`unit: "patterns"`) sends that lane's slices, rests left out (so there may be
// gaps); its Drum Rack gets one pad per pattern instead, and its MIDI clip plays the pattern sequence (1, 2, 1, 3…).
//   allStems      (Task 8) each kept stem on a new audio track of its own, cut at its own lane's slices: one unwarped
//                 clip per slice at its place (Arrangement), or, in Session, a scene at every stem's cut (named
//                 `<section label> <n>`) and a clip of each stem that plays there, so firing the scenes in order
//                 plays the song. Matt (Live, 3 Nov): in the Arrangement it also puts a locator at each of the
//                 dialog's sections, as Apply's Output Locators does ("the split from the stems and markers from the
//                 mix"); the source clip is not touched. The footer's Send to new tracks button sends this too.
//
// SDK 1.0.0-beta.0 gaps, found in dist/index.d.mts: Track and Chain have no colour, and Chain has no name, so the new
// tracks and the Drum Rack's pads are not coloured and the pads are not named (Live may name a pad after its sample;
// the sample's file name carries the label). Only clips are coloured. createMidiTrack/createAudioTrack put the track
// "after the last selected track, or appended if no track is selected", and there is no way to select or move one.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ClipLoopSettings, ExtensionContext } from "@ableton-extensions/sdk";
import { writeSlices, type SliceCut } from "../audio/slice.js";
import { toLiveColor } from "../core/colors.js";
import type { Section } from "../core/types.js";
import type { Harmony, SendSource, SendTarget, SendUnit } from "../dialog/protocol.js";
import { MIN_SECTION_SEC } from "../core/sections.js";
import { clipKey, keyShort, sectionKeys, type KeyEstimate } from "../key/key.js";
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import type { ClipInfo } from "./acquire.js";
import { cueOps } from "./arrangementOps.js";
import { MIN_PIECE_BEATS, sliceEdges, tiled } from "./clamp.js";
import { sceneNames } from "./sessionOps.js";
import { secondsToBeats } from "./time.js";

type Ctx = ExtensionContext<"1.0.0">;

/** The device names Track/Chain.insertDevice is given. The SDK's docs name only "Reverb" and "Auto Filter" as examples. */
export const SIMPLER_DEVICE = "Simpler";
export const DRUM_RACK_DEVICE = "Drum Rack";
/** C1 in Live's note names (C3 = 60): the Drum Rack's first pad. */
export const FIRST_PAD_NOTE = 36;
/** Pads go up from C1 to the top MIDI note, G8 (127): this many sections fit. */
export const MAX_PADS = 128 - FIRST_PAD_NOTE;
const NOTE_VELOCITY = 100;

export interface SendRequest {
  target: SendTarget;
  source: SendSource;
  /** The section right-clicked: the one "simpler" and "audioSection" send. */
  index: number;
  /**
   * The dialog's sections, as edited; seconds from the start of `sourcePath`. Plan 6, `unit: "patterns"`: a lane's
   * slices instead, labelled `<source> <pattern>`, ascending, with gaps where its rests were.
   */
  sections: Section[];
  /** Plan 6: "patterns" for a send from a pattern lane; absent means sections. */
  unit?: SendUnit;
  /**
   * The source's length in seconds (the dialog's). Plan 6: a lane slice that ends there runs to the file's end (the
   * render may be a few frames longer) and, in the Arrangement, to the clip's end; one before a trailing rest does not.
   * The dialog's sections tile the source, so their last always runs to its end, as before. Absent: the last slice's end.
   */
  durationSec?: number;
  /** The file the sections are cut from: the clip's render (the mix) or a kept stem. */
  sourcePath: string;
  /**
   * Plan 6, Task 8, target "allStems": each stem's slices (its lane's non-rest cells, ascending, perhaps with gaps; []
   * when it rests throughout), and each stem's file. `sections` are then the dialog's sections, which name the scenes.
   */
  stems?: Record<StemName, Section[]>;
  stemPaths?: Record<StemName, string>;
  tempo: number;
  /**
   * v2: the harmony the dialog keyed its sections from (key/key.ts). With it, and `keyInNames` not false, what is sent
   * from a non-drum source carries the key in its names. Absent or null: no keys.
   */
  harmony?: Harmony | null;
  keyInNames?: boolean;
}

export interface SendEnv {
  /** A folder for the slices, deleted again whatever happens. */
  tempDir: string;
  /** Where a slice Live did not copy into the project is kept instead (see importSlices). */
  storageDir: string;
  log(...args: unknown[]): void;
}

export interface SendOutcome {
  /** Set changes made, each believed to be one undo step (README "Known limits": creations are not grouped). */
  steps: number;
  /** What to tell the user once it is done (nothing when there is nothing to say). */
  notes: string[];
}

/**
 * A send that failed. `steps` Set changes had already been made (0: the Set is untouched); `made` says what they were,
 * for the message (e.g. "a MIDI track with a Drum Rack and 3 of 8 pads"). Plan 6, Task 8 review: `what` is what was
 * being sent ("stems" for Send all stems), and `plural` says that `made` is more than one thing (2 new audio tracks).
 */
export class SendError extends Error {
  readonly what: "sections" | "stems";
  readonly plural: boolean;
  constructor(
    message: string,
    readonly steps: number,
    readonly made: string,
    options?: { cause?: unknown; what?: "sections" | "stems"; plural?: boolean },
  ) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SendError";
    this.what = options?.what ?? "sections";
    this.plural = options?.plural ?? false;
  }
}

export function sendFailedMessage(error: SendError): string {
  if (error.steps === 0) return `Song Sections couldn't send the ${error.what}. Your Set was not changed.`;
  const times = error.steps === 1 ? "once" : `${error.steps} times`;
  return `Song Sections couldn't finish sending the ${error.what}. It made ${error.made}; use Edit › Undo ${times} to remove ${error.plural ? "them" : "it"}.`;
}

/** Characters no file name may hold on macOS or Windows, and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
/** Well under the 255-byte name limit of APFS, NTFS and ext4, with room for " 99.wav". */
const NAME_BYTES = 200;

/** `text` made safe as (part of) a file name on macOS and Windows; never empty. */
export function safeFileName(text: string, maxBytes = NAME_BYTES): string {
  let s = text.replace(UNSAFE, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (Buffer.byteLength(s) > maxBytes) {
    const chars = [...s];
    while (Buffer.byteLength(chars.join("")) > maxBytes) chars.pop();
    s = chars.join("").replace(/[. ]+$/, "");
  }
  return s || "Untitled";
}

const HASH_CHARS = 6;

/**
 * `base` made safe and short enough that ` [<hash>]` still fits the name limit after it (review M2, re-review N1); v2:
 * with ` - <key>` before the hash when there is one ("Dm"), kept as the hash is when a long base is shortened (key
 * review M3). A key is ASCII and safe already.
 */
export function withHash(base: string, sha256: string, key?: string | null): string {
  const tag = `${key ? ` - ${key}` : ""} [${sha256.slice(0, HASH_CHARS)}]`;
  return safeFileName(base, NAME_BYTES - tag.length) + tag;
}

/** File names for `bases` (without extension), made safe and unique within the list (case-insensitively). */
export function uniqueFileNames(bases: string[], ext = ".wav"): string[] {
  const taken = new Set<string>();
  return bases.map((b) => {
    const base = safeFileName(b);
    let name = base + ext;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}${ext}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

/**
 * `<clip name> - <label> - <stem or mix>`, or `<clip name> - <stem or mix>` for the whole source (withHash adds the key).
 * Plan 6 (Task 7 review): a lane's slice is `<clip name> - <label>`, since its label (`drums 1`) carries the source.
 */
export const sliceBase = (clipName: string, source: SendSource, label?: string, unit: SendUnit = "sections") =>
  label === undefined ? `${clipName} - ${source}` : unit === "patterns" ? `${clipName} - ${label}` : `${clipName} - ${label} - ${source}`;

/** v2: `<name> · <key>` ("Dm"), or the name alone. */
export const withKey = (name: string, key?: string | null) => (key ? `${name} · ${key}` : name);

export const simplerTrackName = (label: string, source: SendSource, key?: string | null) => withKey(`${label} (${source})`, key);
/** Plan 6: `… patterns` for a lane's pattern kit. */
export const drumRackTrackName = (clipName: string, source: SendSource, key?: string | null, unit: SendUnit = "sections") =>
  withKey(`${clipName} (${source}) ${unit}`, key);
export const audioSectionTrackName = (label: string, source: SendSource, key?: string | null) => withKey(`${label} (${source})`, key);
export const audioWholeTrackName = (clipName: string, source: SendSource, key?: string | null) => withKey(`${clipName} (${source})`, key);

/** v2: the keys a send's names carry: each section's and the clip's, or none (the drums, the toggle off, no harmony). */
export interface NameKeys {
  sections: (KeyEstimate | null)[];
  clip: KeyEstimate | null;
}
const NO_KEYS = (n: number): NameKeys => ({ sections: new Array<KeyEstimate | null>(n).fill(null), clip: null });

export function nameKeys(req: Pick<SendRequest, "source" | "sections" | "harmony" | "keyInNames">): NameKeys {
  if (req.source === "drums" || req.keyInNames === false || !req.harmony) return NO_KEYS(req.sections.length);
  return { sections: sectionKeys(req.harmony, req.sections), clip: clipKey(req.harmony) };
}

/**
 * The key a name carries ("Dm"), or null. Controller ruling: only a sure key goes into a track, clip or file name; an
 * unsure one shows with its "?" in the dialog only, so nothing in Live carries a guess.
 */
export const nameKey = (k: KeyEstimate | null) => (k?.sure ? keyShort(k) : null);
const fileKey = nameKey;

/** Within this many seconds of the source's end, a section ends there (as assertValidPieces's slack). */
const END_SLACK_SEC = 1e-3;

/** Whether section `i` ends at the source's end (`durationSec`, or the last section's end). */
const endsAtEnd = (sections: Section[], i: number, durationSec?: number) =>
  sections[i].end >= (durationSec ?? sections.at(-1)!.end) - END_SLACK_SEC;

/** Where a request's source ends, for endsAtEnd and sectionBeats: the length for a lane's slices; sections tile it. */
const sourceEnd = (req: SendRequest) => (req.unit === "patterns" ? req.durationSec : undefined);

/**
 * Where each section starts and ends in beats from the clip's start, and the clip's length, for the Drum Rack's MIDI
 * clip and the audio clips. Arrangement: Apply's own edges (sliceEdges: song tempo from the clip's start, clamped to
 * the clip), since the render is what the Arrangement plays. Session: the sections' seconds at the song tempo; the
 * render of a warped Session clip is its file unwarped (acquireAudio), and the sent audio plays unwarped too.
 * Plan 6: each section has its own start and end, so a lane's slices may leave gaps (their rests). In the Arrangement
 * the gaps are tiles of their own (as Session Apply's pieces are), so sections that meet still share an edge, and only
 * a section that ends at the source's end (`durationSec`) runs to the clip's end.
 */
export function sectionBeats(info: ClipInfo, sections: Section[], tempo: number, durationSec?: number): { starts: number[]; ends: number[]; length: number } {
  const last = sections.length - 1;
  if (info.view === "arrangement") {
    const { tiles, at } = tiled(sections);
    if (endsAtEnd(sections, last, durationSec)) tiles.pop();
    const { times } = sliceEdges(info, tiles, tempo);
    const beat = (k: number) => times[k] - info.startTime;
    return { starts: at.map(beat), ends: at.map((k) => beat(k + 1)), length: info.lengthBeats };
  }
  const beats = (t: number) => secondsToBeats(t, tempo);
  return { starts: sections.map((s) => beats(s.start)), ends: sections.map((s) => beats(s.end)), length: beats(durationSec ?? sections[last].end) };
}

/**
 * Plan 6, Task 8: where Send all stems' Session scenes start, in seconds: the sorted union of every stem slice's start
 * and end and every section's start, from 0. The end (`durationSec`) is no start, and a point closer than
 * MIN_SECTION_SEC to another kept one, or to the end, is merged into it, so no scene is shorter than a section can be.
 * Task 8 review: 0 and the section starts are kept first, so a merge never moves a section's start (the scene holding
 * section B is named for B); the stem points then go in, in time order, where they are far enough from those kept.
 */
export function sceneStarts(stems: Record<StemName, Section[]>, sections: Section[], durationSec: number): number[] {
  const last = durationSec - MIN_SECTION_SEC;
  const starts = [...new Set([0, ...sections.map((s) => s.start)])].filter((t) => t <= last).sort((a, b) => a - b);
  if (starts.length === 0) return [0];
  const points = STEM_NAMES.flatMap((n) => stems[n].flatMap((s) => [s.start, s.end])).sort((a, b) => a - b);
  for (const t of points) {
    if (t > last) break;
    // The kept points either side of t (starts stays sorted).
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (starts[m] < t) lo = m + 1;
      else hi = m;
    }
    const far = (k: number) => k < 0 || k >= starts.length || Math.abs(starts[k] - t) >= MIN_SECTION_SEC;
    if (far(lo - 1) && far(lo)) starts.splice(lo, 0, t);
  }
  return starts;
}

/**
 * Plan 6: a lane's pattern kit. Pads go to the distinct labels in order of first occurrence: `firsts[p]` is the first
 * section with pad p's label, and `padOf[i]` is section i's pad.
 */
export function padPlan(sections: Section[]): { padOf: number[]; firsts: number[] } {
  const pads = new Map<string, number>();
  const firsts: number[] = [];
  const padOf = sections.map((s, i) => {
    let p = pads.get(s.label);
    if (p === undefined) {
      p = firsts.push(i) - 1;
      pads.set(s.label, p);
    }
    return p;
  });
  return { padOf, firsts };
}

/**
 * The Drum Rack's MIDI clip notes: one per section, on its pad (`padOf[i]`, from C1 up), at its start and as long as it.
 * A section whose pad is not among the first `pads` gets none, and so does an empty section.
 */
export function padNotes(
  beats: { starts: number[]; ends: number[] },
  padOf: readonly number[],
  pads: number,
): Array<{ pitch: number; startTime: number; duration: number; velocity: number }> {
  const notes = [];
  for (let i = 0; i < padOf.length; i++) {
    const duration = beats.ends[i] - beats.starts[i];
    if (padOf[i] < pads && duration > MIN_PIECE_BEATS) notes.push({ pitch: FIRST_PAD_NOTE + padOf[i], startTime: beats.starts[i], duration, velocity: NOTE_VELOCITY });
  }
  return notes;
}

async function samePath(a: string, b: string): Promise<boolean> {
  const real = (p: string) => realpath(p).catch(() => resolve(p));
  return resolve(a) === resolve(b) || (await real(a)) === (await real(b));
}

/**
 * Copies each slice into the Live project. A slice Live did not copy (the import rejected, or it gave back the slice's
 * own path: both perhaps an unsaved Set, which has no project folder yet; not verified in Live) is copied to
 * `<storage>/sent/<id>/` instead, so deleting the temp folder cannot pull it out from under the Set, and `kept` says
 * so (review I1). Only a failure of that copy too throws; nothing in the Set has changed then.
 */
async function importSlices(context: Ctx, files: string[], env: SendEnv): Promise<{ paths: string[]; kept: boolean }> {
  const paths: string[] = [];
  let keep: string | null = null;
  for (const file of files) {
    let why: string;
    try {
      const imported = await context.resources.importIntoProject(file);
      if (!(await samePath(imported, file))) {
        paths.push(imported);
        continue;
      }
      why = "it returned the same path";
    } catch (error) {
      why = `the import failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    keep ??= join(env.storageDir, "sent", randomUUID());
    await mkdir(keep, { recursive: true });
    const dest = join(keep, basename(file));
    await copyFile(file, dest);
    env.log(`Song Sections: Live did not copy ${file} into the project (${why}); it is kept as ${dest}`);
    paths.push(dest);
  }
  return { paths, kept: keep !== null };
}

const KEPT_NOTE =
  "Live did not copy the sent audio into the project (perhaps the Set is not saved yet), so Song Sections keeps it " +
  "in its own storage folder. Save the Set with File › Collect All and Save to keep the audio with it.";

/** "a Simpler", "an Audio Effect Rack". */
const withArticle = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** What a send makes, counted as it goes, for the undo count and the failure message. */
class Tally {
  steps = 0;
  track: "MIDI" | "audio" | null = null;
  /** Plan 6, Task 8: Send all stems makes four tracks, and scenes in Session or (3 Nov) locators in the Arrangement. */
  tracks = 0;
  scenes = 0;
  locators = 0;
  device: string | null = null;
  pads = 0;
  padsWanted = 0;
  clips = 0;
  /** Whether describe() names more than one thing (for "remove them"). */
  plural(): boolean {
    return this.tracks > 1 || this.scenes > 0 || this.locators > 0;
  }
  describe(): string {
    if (!this.track) return "nothing";
    if (this.plural()) {
      const parts = [count(this.tracks, `a new ${this.track} track`, `new ${this.track} tracks`)];
      if (this.scenes > 0) parts.push(count(this.scenes, "a scene", "scenes"));
      if (this.clips > 0) parts.push(count(this.clips, "a clip", "clips"));
      if (this.locators > 0) parts.push(count(this.locators, "a locator", "locators"));
      return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
    }
    let s = `a new ${this.track} track`;
    if (this.device === DRUM_RACK_DEVICE) s += ` with a Drum Rack and ${this.pads} of ${this.padsWanted} pads`;
    else if (this.device) s += ` with ${withArticle(this.device)}`;
    if (this.clips > 0) s += this.device ? ` and ${this.clips === 1 ? "a clip" : `${this.clips} clips`}` : ` with ${this.clips === 1 ? "a clip" : `${this.clips} clips`}`;
    return s;
  }
}

/** Logs where Live put the new track: right after the source clip's track, or not (never throws). */
function logPlacement(context: Ctx, info: ClipInfo, track: unknown, env: SendEnv): void {
  try {
    const tracks = context.application.song.tracks as unknown[];
    const at = tracks.indexOf(track);
    const source = tracks.indexOf(info.track);
    env.log(`Song Sections: the new track is track ${at + 1}; the source clip's track is ${source + 1}${at === source + 1 ? " (right after it)" : ""}`);
  } catch (error) {
    env.log("Song Sections: could not read where the new track went:", error);
  }
}

interface SimplerLike {
  name: string;
  replaceSample(path: string): Promise<unknown>;
}

/** The device must be what was asked for: its name may not be one insertDevice knows (not verified in Live). */
function asSimpler(device: { name?: string } | null | undefined): SimplerLike {
  if (!device || typeof (device as Partial<SimplerLike>).replaceSample !== "function") {
    throw new Error(`insertDevice("${SIMPLER_DEVICE}") made ${device?.name ? withArticle(device.name) : "no Simpler"}`);
  }
  return device as SimplerLike;
}

/**
 * Performs one send. The Set is changed only once every slice is in the project; Live's calls go strictly one at a
 * time, each counted, and one transaction at the end names (and colours, where the SDK can) what was made. When a step
 * fails, that transaction still runs for what was made, and a SendError carries the count. The temp folder is deleted
 * whatever happens.
 */
export async function executeSend(context: Ctx, info: ClipInfo, req: SendRequest, env: SendEnv): Promise<SendOutcome> {
  const { target, source, sections } = req;
  const unit = req.unit ?? "sections";
  const notes: string[] = [];
  const single = target === "simpler" || target === "audioSection";
  // The Drum Rack's pads: a section each, or (Plan 6) a pattern each, loaded with its first slice.
  const plan = unit === "patterns" ? padPlan(sections) : { padOf: sections.map((_, i) => i), firsts: sections.map((_, i) => i) };
  const sent = single ? [req.index] : target === "drumRack" ? plan.firsts.slice(0, MAX_PADS) : [];
  if (target === "drumRack" && plan.firsts.length > MAX_PADS) {
    notes.push(`A Drum Rack's pads go from C1 up to G8, so only the first ${MAX_PADS} of the ${plan.firsts.length} ${unit} were sent.`);
  }

  const keys = nameKeys(req);
  const what = target === "allStems" ? "stems" : "sections";
  const dir = join(env.tempDir, `send-${randomUUID()}`);
  const tally = new Tally();

  /** The slices `sent` (the whole source for audioWhole), cut from the source, then copied into the project. */
  const prepareSlices = async (): Promise<{ imported: string[]; wholeSec: number; kept: boolean }> => {
    const last = sections.length - 1;
    const bases = target === "audioWhole" ? [sliceBase(info.name, source)] : sent.map((i) => sliceBase(info.name, source, sections[i].label, unit));
    const fileKeys = target === "audioWhole" ? [fileKey(keys.clip)] : sent.map((i) => fileKey(keys.sections[i]));
    const cuts: SliceCut[] = (target === "audioWhole" ? [{ startSec: 0, endSec: sections[last].end, toEnd: true }] : sent.map((i) => ({
      startSec: sections[i].start,
      endSec: sections[i].end,
      toEnd: endsAtEnd(sections, i, sourceEnd(req)),
    }))).map((c, k) => ({ ...c, path: join(dir, `slice-${k}.wav`) }));
    const written = await writeSlices(req.sourcePath, cuts);
    // Review M2: the name ends in a short hash of the audio, so a later send of the same label with other edges gets
    // a file of its own in the project instead of perhaps replacing the one an earlier send's Simpler plays.
    // Re-review N1: the base is shortened first, so a long name keeps its hash.
    const names = uniqueFileNames(bases.map((b, k) => withHash(b, written.slices[k].sha256, fileKeys[k])));
    const files = names.map((n) => join(dir, n));
    for (let k = 0; k < files.length; k++) await rename(cuts[k].path, files[k]);
    const r = await importSlices(context, files, env);
    return { imported: r.paths, wholeSec: written.slices[0].frames / written.sampleRate, kept: r.kept };
  };

  try {
    // 1. The slices (Plan 6, Task 8: or the stems), then their copies in the project. Nothing in the Set has changed yet.
    let imported: string[] = [];
    /** The length of the first file written (the whole source, for audioWhole), in seconds. */
    let wholeSec = 0;
    /** Plan 6, Task 8: each stem's copy in the project and its length (for those that do not rest throughout), and its name keys. */
    let stems: { files: Partial<Record<StemName, StemFile>>; keys: Record<StemName, NameKeys> } | null = null;
    try {
      await mkdir(dir, { recursive: true });
      let kept: boolean;
      if (target === "allStems") ({ kept, ...stems } = await prepareStems(context, info, req, dir, env));
      else ({ imported, wholeSec, kept } = await prepareSlices());
      if (kept) notes.push(KEPT_NOTE);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new SendError(`Preparing the audio to send failed: ${why}`, 0, "nothing", { cause: error, what });
    }

    // 2. Live.
    const finalizers: Array<() => void> = [];
    let failure: unknown = null;
    try {
      if (target === "allStems") await sendAllStems(context, info, req, stems!, tally, finalizers, env);
      else if (target === "simpler") await sendSimpler(context, info, req, keys, imported[0], tally, finalizers, env);
      else if (target === "drumRack") await sendDrumRack(context, info, req, keys, plan.padOf, imported, tally, finalizers, env);
      else if (target === "audioSection") await sendAudioSection(context, info, req, keys, imported[0], tally, finalizers, env);
      else await sendAudioWhole(context, info, req, keys, imported[0], wholeSec, tally, finalizers, env);
    } catch (error) {
      failure = error;
    }
    if (finalizers.length > 0) {
      try {
        context.withinTransaction(() => {
          for (const f of finalizers) f();
        });
        tally.steps++;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) {
      const why = failure instanceof Error ? failure.message : String(failure);
      throw new SendError(`Sending to Live failed: ${why}`, tally.steps, tally.describe(), { cause: failure, what, plural: tally.plural() });
    }
    return { steps: tally.steps, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type Finalizers = Array<() => void>;
type AudioTrack = Awaited<ReturnType<Ctx["application"]["song"]["createAudioTrack"]>>;

async function newMidiTrack(context: Ctx, info: ClipInfo, tally: Tally, env: SendEnv) {
  const track = await context.application.song.createMidiTrack();
  tally.steps++;
  tally.tracks++;
  tally.track = "MIDI";
  logPlacement(context, info, track, env);
  return track;
}

async function newAudioTrack(context: Ctx, info: ClipInfo, tally: Tally, env: SendEnv) {
  const track = await context.application.song.createAudioTrack();
  tally.steps++;
  tally.tracks++;
  tally.track = "audio";
  logPlacement(context, info, track, env);
  return track;
}

/** The new track's slot in the source clip's scene row (Session). */
function sceneSlot<T>(track: { clipSlots: T[] }, info: ClipInfo): T {
  const slot = info.sceneIndex === undefined ? undefined : track.clipSlots[info.sceneIndex];
  if (!slot) throw new Error(`The new track has no clip slot in scene ${info.sceneIndex}`);
  return slot;
}

async function sendSimpler(context: Ctx, info: ClipInfo, req: SendRequest, keys: NameKeys, path: string, tally: Tally, fin: Finalizers, env: SendEnv) {
  const s = req.sections[req.index];
  const track = await newMidiTrack(context, info, tally, env);
  fin.push(() => void (track.name = simplerTrackName(s.label, req.source, nameKey(keys.sections[req.index]))));
  // Counted as soon as Live has made a device, before it is checked: a wrong one is in the Set too (review I2).
  const made = await track.insertDevice(SIMPLER_DEVICE, 0);
  tally.steps++;
  tally.device = made?.name || SIMPLER_DEVICE;
  const simpler = asSimpler(made);
  await simpler.replaceSample(path);
  tally.steps++;
}

async function sendDrumRack(
  context: Ctx,
  info: ClipInfo,
  req: SendRequest,
  keys: NameKeys,
  padOf: number[],
  paths: string[],
  tally: Tally,
  fin: Finalizers,
  env: SendEnv,
) {
  // One pad per path: the first slice of each pad's section or pattern.
  tally.padsWanted = paths.length;
  const track = await newMidiTrack(context, info, tally, env);
  fin.push(() => void (track.name = drumRackTrackName(info.name, req.source, nameKey(keys.clip), req.unit)));
  const rack = (await track.insertDevice(DRUM_RACK_DEVICE, 0)) as unknown as {
    name?: string;
    chains?: unknown[];
    insertChain?: (index: number) => Promise<{ receivingNote?: number; insertDevice(name: string, index: number): Promise<unknown> }>;
  };
  tally.steps++;
  if (typeof rack?.insertChain !== "function") {
    tally.device = rack?.name || "device";
    throw new Error(`insertDevice("${DRUM_RACK_DEVICE}") made ${rack?.name ? withArticle(rack.name) : "no rack"}`);
  }
  tally.device = DRUM_RACK_DEVICE;
  for (let k = 0; k < paths.length; k++) {
    // At the end of the rack's chains, whatever its default preset holds.
    const chain = await rack.insertChain(rack.chains?.length ?? k);
    tally.steps++;
    if (!chain || !("receivingNote" in chain)) throw new Error("insertChain on the Drum Rack made a chain that is not a drum chain");
    const note = FIRST_PAD_NOTE + k;
    fin.push(() => void (chain.receivingNote = note));
    const made = (await chain.insertDevice(SIMPLER_DEVICE, 0)) as { name?: string };
    tally.steps++;
    const simpler = asSimpler(made);
    await simpler.replaceSample(paths[k]);
    tally.steps++;
    tally.pads++;
  }

  // Live's "Slice to New MIDI Track" result: a MIDI clip at the source's place that plays every pad in order, or
  // (Plan 6) every slice on its pattern's pad.
  const beats = sectionBeats(info, req.sections, req.tempo, sourceEnd(req));
  const notes = padNotes(beats, padOf, paths.length);
  const { length } = beats;
  const clip =
    info.view === "arrangement"
      ? await track.createMidiClip(info.startTime, length)
      : await sceneSlot(track, info).createMidiClip(length);
  tally.steps++;
  tally.clips++;
  fin.push(() => {
    clip.notes = notes;
    clip.name = info.name;
    clip.color = toLiveColor(info.color);
  });
}

async function sendAudioSection(context: Ctx, info: ClipInfo, req: SendRequest, keys: NameKeys, path: string, tally: Tally, fin: Finalizers, env: SendEnv) {
  const s = req.sections[req.index];
  const key = nameKey(keys.sections[req.index]);
  const track = await newAudioTrack(context, info, tally, env);
  fin.push(() => void (track.name = audioSectionTrackName(s.label, req.source, key)));
  // Unwarped: it plays at the file's rate, so it lines up with the source at the song tempo it was rendered at.
  const clip =
    info.view === "arrangement"
      ? await track.createAudioClip({ filePath: path, startTime: info.startTime + sectionBeats(info, req.sections, req.tempo, sourceEnd(req)).starts[req.index], isWarped: false })
      : await sceneSlot(track, info).createAudioClip({ filePath: path, isWarped: false });
  tally.steps++;
  tally.clips++;
  checkUnwarped(clip, null, withKey(s.label, key), env);
  fin.push(() => {
    clip.name = withKey(s.label, key);
    clip.color = toLiveColor(s.color);
  });
}

/** Within this many seconds, a clip's markers are the ones it was made with (as executeSession's read-back). */
const MARKER_SEC = 1e-3;
/** Within this many beats, a clip sits where it was made to. */
const PLACE_BEATS = 1e-3;

/**
 * Says on the host's log when a clip made unwarped is not: warped after all, or with other markers than it was made
 * with (never throws). Live's own behaviour here is not verified; this is what the log shows when it differs.
 */
function checkUnwarped(
  clip: { warping?: boolean; startMarker?: number; endMarker?: number; startTime?: number; endTime?: number },
  want: ClipLoopSettings | null,
  what: string,
  env: SendEnv,
  place?: { startTime: number; endTime: number },
): void {
  try {
    const off: string[] = [];
    if (clip.warping !== false) off.push(`warping is ${clip.warping}`);
    if (want && !(Math.abs((clip.startMarker ?? NaN) - want.startMarker) <= MARKER_SEC && Math.abs((clip.endMarker ?? NaN) - want.endMarker) <= MARKER_SEC)) {
      off.push(`markers are ${clip.startMarker}..${clip.endMarker}, not ${want.startMarker}..${want.endMarker}`);
    }
    // Stem-fix review I1: where it sits and how long it is, in arrangement beats.
    if (place && !(Math.abs((clip.startTime ?? NaN) - place.startTime) <= PLACE_BEATS && Math.abs((clip.endTime ?? NaN) - place.endTime) <= PLACE_BEATS)) {
      off.push(`it spans beats ${clip.startTime}..${clip.endTime}, not ${place.startTime}..${place.endTime}`);
    }
    if (off.length > 0) env.log(`Song Sections: the clip "${what}" was made unwarped, but ${off.join(" and ")}`);
  } catch (error) {
    env.log(`Song Sections: could not read back the clip "${what}":`, error);
  }
}

async function sendAudioWhole(
  context: Ctx,
  info: ClipInfo,
  req: SendRequest,
  keys: NameKeys,
  path: string,
  fileSec: number,
  tally: Tally,
  fin: Finalizers,
  env: SendEnv,
) {
  const track = await newAudioTrack(context, info, tally, env);
  const name = audioWholeTrackName(info.name, req.source, nameKey(keys.clip));
  fin.push(() => void (track.name = name));
  if (info.view === "session") {
    const clip = await sceneSlot(track, info).createAudioClip({ filePath: path, isWarped: false });
    tally.steps++;
    tally.clips++;
    checkUnwarped(clip, null, name, env);
    fin.push(() => {
      clip.name = name;
      clip.color = toLiveColor(info.color);
    });
    return;
  }
  await arrangementClips(track, info, req.sections, keys.sections, path, fileSec, req.tempo, sourceEnd(req), tally, fin, env);
}

/**
 * Arrangement: one unwarped clip per section, each at its section's song time (Apply's edges) with the section's file
 * seconds as its markers. Matt, Live, 31 Oct: splitting one unwarped clip with Apply's zero-width clearClipsInRange left
 * the pieces from the third on warped, short and with gaps (F9 measured warped clips only). A section too short to be a
 * piece is dropped, as Apply drops it; the last runs to the file's end. That unwarped markers are file seconds is the
 * Session path's convention (F2), not yet seen in the Arrangement in Live: the read-back says on the log when a clip is
 * not what it was made to be.
 * Plan 6: a lane's slices leave gaps where its rests were, and nothing is put there; only a slice that ends at the
 * source's end (`durationSec`; absent: the sections tile it) runs to the file's end. `keys` are the sections' keys.
 * Task 8: Send all stems puts each stem's slices on its own track this way.
 */
async function arrangementClips(
  track: AudioTrack,
  info: ClipInfo,
  sections: Section[],
  keys: readonly (KeyEstimate | null)[],
  path: string,
  fileSec: number,
  tempo: number,
  durationSec: number | undefined,
  tally: Tally,
  fin: Finalizers,
  env: SendEnv,
) {
  const { starts, ends } = sectionBeats(info, sections, tempo, durationSec);
  for (let i = 0; i < sections.length; i++) {
    if (ends[i] - starts[i] <= MIN_PIECE_BEATS) continue;
    const s = sections[i];
    const a = Math.min(s.start, fileSec);
    const b = endsAtEnd(sections, i, durationSec) ? fileSec : Math.min(s.end, fileSec);
    if (b - a <= 0) continue;
    const markers: ClipLoopSettings = { startMarker: a, endMarker: b, loopStart: a, loopEnd: b, looping: false };
    const label = withKey(s.label, nameKey(keys[i]));
    // Stem-fix review I1: the length is given, not left to Live (the SDK's default is "the sample's natural length"):
    // the section's span between Apply's edges, the last to the clip's end. Where it is the markers' own span to within
    // an ulp's worth, that span is passed, so the two never disagree by a rounding (acquire.ts: a duration off the
    // markers was refused once). F10 saw Live take a duration that differs from the markers; one it refuses is logged
    // and the clip is made without, its length then Live's.
    const startTime = info.startTime + starts[i];
    const span = ((b - a) * tempo) / 60;
    const between = ends[i] - starts[i];
    const duration = Math.abs(span - between) <= MIN_PIECE_BEATS ? span : between;
    let clip;
    try {
      clip = await track.createAudioClip({ filePath: path, startTime, duration, isWarped: false, loopSettings: markers });
    } catch (error) {
      env.log(`Song Sections: Live refused the clip "${label}" with a duration of ${duration} beats; it is made without one`, error);
      clip = await track.createAudioClip({ filePath: path, startTime, isWarped: false, loopSettings: markers });
    }
    tally.steps++;
    tally.clips++;
    checkUnwarped(clip, markers, label, env, { startTime, endTime: startTime + duration });
    fin.push(() => {
      clip.name = label;
      clip.color = toLiveColor(s.color);
    });
  }
}

/** A scene holds a stem's slice when they overlap by more than this many seconds. */
const OVERLAP_SEC = 1e-3;

/** The slice that overlaps [a, b) the most, by more than OVERLAP_SEC; -1 when none does. */
function mostOverlap(slices: readonly Section[], a: number, b: number): number {
  let best = -1;
  let most = OVERLAP_SEC;
  slices.forEach((s, j) => {
    const o = Math.min(s.end, b) - Math.max(s.start, a);
    if (o > most) [best, most] = [j, o];
  });
  return best;
}

/**
 * `made` in their order among the Set's tracks, top to bottom; in the order they were made when that cannot be read
 * (a track not found, or the tracks not readable). Logs the order it took.
 */
function inSetOrder<T>(context: Ctx, made: T[], env: SendEnv): T[] {
  try {
    const all = context.application.song.tracks as unknown[];
    const at = made.map((t) => all.indexOf(t));
    if (at.every((k) => k >= 0)) {
      env.log(`Song Sections: the new stem tracks are tracks ${at.map((k) => k + 1).join(", ")} in the order they were made`);
      return made.map((t, k) => ({ t, at: at[k] })).sort((x, y) => x.at - y.at).map((x) => x.t);
    }
    env.log("Song Sections: a new stem track is not among the Set's tracks; the stems go to them in the order they were made");
  } catch (error) {
    env.log("Song Sections: could not read where the new stem tracks went; the stems go to them in the order they were made", error);
  }
  return made;
}

/** Plan 6, Task 8: a stem's copy in the project, and its length in seconds. */
interface StemFile {
  path: string;
  sec: number;
}

/** Each stem's name keys: its slices' and the clip's (none for the drums), as a send of that stem alone would have. */
const stemNameKeys = (req: SendRequest, stems: Record<StemName, Section[]>) =>
  Object.fromEntries(STEM_NAMES.map((stem) => [stem, nameKeys({ source: stem, sections: stems[stem], harmony: req.harmony, keyInNames: req.keyInNames })])) as Record<StemName, NameKeys>;

/** The keys the dialog's sections put in the scene and locator names, as Apply's (none with Key in names off). */
const sectionNameKeys = (req: SendRequest) => nameKeys({ source: "mix", sections: req.sections, harmony: req.harmony, keyInNames: req.keyInNames }).sections.map(nameKey);

/**
 * Plan 6, Task 8: each stem that does not rest throughout, whole, into the temp folder (`<clip> - <stem>`, with the
 * clip's key and a hash, as audioWhole names its file), then into the project.
 */
async function prepareStems(
  context: Ctx,
  info: ClipInfo,
  req: SendRequest,
  dir: string,
  env: SendEnv,
): Promise<{ files: Partial<Record<StemName, StemFile>>; keys: Record<StemName, NameKeys>; kept: boolean }> {
  const { stems, stemPaths } = req;
  if (!stems || !stemPaths) throw new Error("Send all stems needs every stem's slices and file");
  const keys = stemNameKeys(req, stems);
  const sent = STEM_NAMES.filter((s) => stems[s].length > 0);
  const written: Array<{ cut: SliceCut; sha256: string; sec: number }> = [];
  for (const [k, stem] of sent.entries()) {
    const cut = { startSec: 0, endSec: stems[stem].at(-1)!.end, toEnd: true, path: join(dir, `stem-${k}.wav`) };
    const w = await writeSlices(stemPaths[stem], [cut]);
    written.push({ cut, sha256: w.slices[0].sha256, sec: w.slices[0].frames / w.sampleRate });
  }
  const names = uniqueFileNames(sent.map((stem, k) => withHash(sliceBase(info.name, stem), written[k].sha256, fileKey(keys[stem].clip))));
  const temp = names.map((n) => join(dir, n));
  for (let k = 0; k < temp.length; k++) await rename(written[k].cut.path, temp[k]);
  const r = await importSlices(context, temp, env);
  return { files: Object.fromEntries(sent.map((stem, k) => [stem, { path: r.paths[k], sec: written[k].sec }])), keys, kept: r.kept };
}

/**
 * Plan 6, Task 8: Send all stems. Four new audio tracks, in STEM_NAMES order, each named `<clip> (<stem>)` (with the
 * clip's key, never the drums'), whether or not the stem rests throughout.
 *   Arrangement: each stem's slices as unwarped clips at their places, as a lane's audioWhole puts them; then a
 *   locator at each of the dialog's sections, as Apply's Output Locators places them (cueOps: named by the section,
 *   with its key as the scene names carry it), whatever Output is set to. The source clip is not touched.
 *   Session: one scene per sceneStarts entry, below the source clip's scene in ascending order (as executeSession
 *   makes them), named by sceneNames after the dialog's sections; then, in each scene, each stem whose slices cover the
 *   scene's middle gets an unwarped clip of the stem over the scene's span (its file seconds), named and coloured by
 *   that slice. A resting stem's slot stays empty. Firing the scenes in order plays the song.
 * Tracks first in both views, so a failure part way leaves whole tracks.
 */
async function sendAllStems(
  context: Ctx,
  info: ClipInfo,
  req: SendRequest,
  prepared: { files: Partial<Record<StemName, StemFile>>; keys: Record<StemName, NameKeys> },
  tally: Tally,
  fin: Finalizers,
  env: SendEnv,
) {
  const stems = req.stems!;
  const { files, keys: stemKeys } = prepared;
  const end = req.durationSec ?? req.sections.at(-1)!.end;
  // Task 8 review I1: Live puts a new track after the last selected track, and the SDK can neither select nor move one,
  // so the four may come out in any order (reversed, if each goes right after the source's). The stems go to them in
  // their order in the Set, top to bottom, so the drums are always on top; they are named once that is known, also
  // when a later track fails.
  const made: AudioTrack[] = [];
  let tracks: AudioTrack[] = [];
  try {
    for (let k = 0; k < STEM_NAMES.length; k++) made.push(await newAudioTrack(context, info, tally, env));
  } finally {
    tracks = inSetOrder(context, made, env);
    tracks.forEach((track, k) => {
      const name = audioWholeTrackName(info.name, STEM_NAMES[k], nameKey(stemKeys[STEM_NAMES[k]].clip));
      fin.push(() => void (track.name = name));
    });
  }

  if (info.view === "arrangement") {
    for (const [k, stem] of STEM_NAMES.entries()) {
      const file = files[stem];
      if (file) await arrangementClips(tracks[k], info, stems[stem], stemKeys[stem].sections, file.path, file.sec, req.tempo, end, tally, fin, env);
    }
    for (const op of cueOps(info, req.sections, req.tempo, undefined, sectionNameKeys(req))) {
      const cue = await context.application.song.createCuePoint(op.time);
      tally.steps++;
      tally.locators++;
      fin.push(() => void (cue.name = op.name));
    }
    return;
  }

  if (info.sceneIndex === undefined || info.sceneIndex < 0) throw new Error(`Cannot place the stems: the source scene index is ${info.sceneIndex}`);
  const base = info.sceneIndex + 1;
  const starts = sceneStarts(stems, req.sections, end);
  const names = sceneNames(req.sections, starts, sectionNameKeys(req));
  for (let i = 0; i < starts.length; i++) {
    const scene = await context.application.song.createScene(base + i);
    tally.steps++;
    tally.scenes++;
    fin.push(() => void (scene.name = names[i]));
  }
  const last = starts.length - 1;
  for (const [k, stem] of STEM_NAMES.entries()) {
    const file = files[stem];
    if (!file) continue;
    const slices = stems[stem];
    const keys = stemKeys[stem].sections;
    const slots = tracks[k].clipSlots;
    for (let i = 0; i < starts.length; i++) {
      const to = i < last ? starts[i + 1] : end;
      // Task 8 review: any of the stem's audio in the scene is played (dropped audio is heard; a rest's is near-silent),
      // under the name of the slice that fills most of it.
      const j = mostOverlap(slices, starts[i], to);
      if (j < 0) continue; // the stem rests here
      // The last scene runs to the file's end (the render may be a few frames longer than the clip).
      const a = Math.min(starts[i], file.sec);
      const b = i === last ? file.sec : Math.min(to, file.sec);
      if (b - a <= 0) continue;
      const slot = slots[base + i];
      if (!slot) throw new Error(`The new ${stem} track has no clip slot in scene ${base + i}`);
      const markers: ClipLoopSettings = { startMarker: a, endMarker: b, loopStart: a, loopEnd: b, looping: false };
      const s = slices[j];
      const label = withKey(s.label, nameKey(keys[j]));
      const clip = await slot.createAudioClip({ filePath: file.path, isWarped: false, loopSettings: markers });
      tally.steps++;
      tally.clips++;
      checkUnwarped(clip, markers, label, env);
      fin.push(() => {
        clip.name = label;
        clip.color = toLiveColor(s.color);
      });
    }
  }
}
