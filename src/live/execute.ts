import type { ClipLoopSettings, ExtensionContext, WarpMode } from "@ableton-extensions/sdk";
import type { ClipInfo } from "./acquire.js";
import type { ArrangementOp } from "./arrangementOps.js";
import { MIN_PIECE_BEATS } from "./clamp.js";
import type { SessionOp } from "./sessionOps.js";
import { sameWarp, secToBeat, usableWarp, type WarpPoint } from "../core/warpMap.js";

type Ctx = ExtensionContext<"1.0.0">;

/**
 * Thrown by executeArrangement for any failure. `cuts` and `cues` count the Set changes that had
 * already completed (each is believed to be one undo step; see README "Known limits"), so flow.ts
 * can say whether the Set is untouched or how many times to press Undo. `cause` is the original error.
 */
export class ArrangementApplyError extends Error {
  constructor(
    message: string,
    readonly cuts: number,
    readonly cues: number,
    options?: { cause: unknown },
  ) {
    super(message, options);
    this.name = "ArrangementApplyError";
  }
}

/**
 * Applies the ops to the arrangement with Live's native clip split, meant to match Cmd+E
 * (docs/live-api-findings.md F9).
 *
 * `track.clearClipsInRange(t, t)` with a zero-width range strictly inside an arrangement clip is a
 * native split: the original clip object stays as the LEFT piece (start..t) and a new clip is the
 * RIGHT piece (t..end). Measured in Live (F9): every piece still references the whole file at the
 * right file offset, and keeps the loop values, warp markers and warp mode. Gain, fades and
 * envelopes are expected to carry over too but are not yet verified (the SDK cannot read them).
 * Nothing is rebuilt with createAudioClip and no warp mode is set here.
 *
 * Whether each cut is one undo step is not measured either (F3 measured creations, not clears).
 * Cuts are awaited strictly one at a time in ascending order, each against the result of the
 * previous one. The pieces are then found by re-reading `track.arrangementClips` (the new right
 * piece's handle is not returned by the split), matched by time range with MIN_PIECE_BEATS
 * tolerance, and one synchronous transaction sets all names and colours. Cue points are created
 * sequentially and named in the same transaction.
 *
 * Any failure, including a piece count that does not match the label count (thrown before any
 * name is touched), is rethrown as an ArrangementApplyError carrying the completed cuts and cues.
 */
export async function executeArrangement(context: Ctx, info: ClipInfo, ops: ArrangementOp[]): Promise<void> {
  let cuts = 0;
  let cues = 0;
  try {
    await applyArrangement(context, info, ops, {
      cut: () => void cuts++,
      cue: () => void cues++,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ArrangementApplyError(message, cuts, cues, { cause: error });
  }
}

async function applyArrangement(
  context: Ctx,
  info: ClipInfo,
  ops: ArrangementOp[],
  count: { cut: () => void; cue: () => void },
): Promise<void> {
  const song = context.application.song;
  const track = info.track;
  const finalizers: Array<() => void> = [];

  const splits = ops.filter((o): o is Extract<ArrangementOp, { kind: "split" }> => o.kind === "split");
  const labels = ops.filter((o): o is Extract<ArrangementOp, { kind: "label" }> => o.kind === "label");

  for (const op of [...splits].sort((a, b) => a.time - b.time)) {
    await track.clearClipsInRange(op.time, op.time);
    count.cut();
  }

  if (labels.length > 0) {
    const spanStart = info.startTime;
    const spanEnd = info.startTime + info.lengthBeats;
    const pieces = track.arrangementClips
      .filter(
        (c) =>
          c.startTime >= spanStart - MIN_PIECE_BEATS &&
          c.startTime < spanEnd - MIN_PIECE_BEATS &&
          c.endTime <= spanEnd + MIN_PIECE_BEATS,
      )
      .sort((a, b) => a.startTime - b.startTime);
    if (pieces.length !== labels.length) {
      throw new Error(
        `Arrangement split produced a different number of clips than expected: found ${pieces.length} in ${spanStart}..${spanEnd}, expected ${labels.length}`,
      );
    }
    pieces.forEach((clip, i) => {
      finalizers.push(() => {
        clip.name = labels[i].name;
        clip.color = labels[i].color;
      });
    });
  }

  for (const op of ops) {
    if (op.kind !== "cue") continue;
    const cue = await song.createCuePoint(op.time);
    count.cue();
    finalizers.push(() => {
      cue.name = op.name;
    });
  }

  if (finalizers.length === 0) return;
  context.withinTransaction(() => {
    for (const apply of finalizers) apply();
  });
}

/**
 * Applies the ops to the Session view (findings F3, F7). Creations are not grouped
 * into one undo step (known limitation), so: scenes are created sequentially in
 * ascending index order (createScene(i) shifts later scenes down, so each index must
 * be valid when issued), then the slot clips are created in the freshly re-read
 * `track.clipSlots`, then one synchronous transaction sets every name and color.
 * The source slot is never written.
 */
export async function executeSession(context: Ctx, info: ClipInfo, ops: SessionOp[]): Promise<void> {
  const song = context.application.song;
  const finalizers: Array<() => void> = [];
  // Errors that stop Apply, the first of which is thrown at the end. The slices already made are still finished
  // first (named, coloured, unwarped, read back): left alone, a parked one plays warped on Live's grid.
  const errors: unknown[] = [];

  // fb3, item 1: a slice is a new clip made from the file, and Live warps a new clip on a grid of its own (Matt's
  // source was warped at 150 BPM; the slices came out at 120, so they played back fast and from the wrong place). The
  // SDK can read warp markers but not set them, so the first warped slice is checked: if Live gave it the source's
  // grid, every slice stays warped (looping, following the tempo); if not, it is replaced and every slice is made
  // unwarped from the file seconds the source's warp markers give, so it plays the right audio at the file's rate.
  //
  // fb4, item 3 ("I lose my place if I turn looping on in session"): Live turns warping on when Loop is turned on for
  // an unwarped clip (SDK: Clip.looping), and an unwarped clip made from the file has no warp markers or beat region to
  // go back to. So each such slice is "parked" instead: made warped on the grid Live just gave the first one, with its
  // markers and loop region the slice's file seconds in that grid's beats, then switched to unwarped. It plays as an
  // unwarped slice does (the right audio at the file's rate), and keeps the grid and the region for Live to warp it back
  // onto when Loop goes on. Read back: a parked slice whose markers are not the slice's file seconds once unwarped is
  // replaced by a plain unwarped clip, and the first such failure stops the parking for the rest.
  //
  // fb4 review I2: parking is only ever an addition to the plain unwarped slice. Every step of it that throws (the
  // parked create, the unwarp) is logged and falls back to that plain path, so the slice still comes out named,
  // unwarped and at the right file seconds; and the read-back runs whatever else went wrong.
  let slots = info.track.clipSlots;
  let unwarp = false;
  let checked = false;
  let liveGrid: WarpPoint[] | null = null; // the grid Live gave the first warped slice, when it was not the source's
  let parking = true;
  const parked: Array<{ slotIndex: number; clip: SliceClip; op: SlotOp }> = [];

  /** A parked create on `slot`; null (and parking stops for the rest) when it throws. */
  const createParked = async (slot: (typeof slots)[number], region: ClipLoopSettings, op: SlotOp): Promise<SliceClip | null> => {
    try {
      return await slot.createAudioClip({ filePath: info.filePath, isWarped: true, loopSettings: region });
    } catch (error) {
      parking = false;
      logStep(`creating the parked clip for "${op.name}" (scene ${op.sceneIndex}) failed; it is made unwarped from the file instead`, error);
      return null;
    }
  };

  try {
    for (const op of ops) {
      if (op.kind !== "scene") continue;
      const scene = await song.createScene(op.index);
      finalizers.push(() => {
        scene.name = op.name;
      });
    }

    // Read again: clipSlots is a copy, and a slot read before the scenes went in has moved down with its old scene.
    slots = info.track.clipSlots;
    for (const op of ops) {
      if (op.kind !== "slotClip") continue;
      const slot = slots[op.sceneIndex];
      const create = (warped: boolean) =>
        slot.createAudioClip({
          filePath: info.filePath,
          isWarped: warped,
          loopSettings: warped ? op.loop : (op.unwarped ?? op.loop),
        });
      let warped = op.isWarped && !(unwarp && op.unwarped);
      let park = false;
      let clip: SliceClip;
      if (!warped && unwarp && op.unwarped && parking && liveGrid) {
        const region = parkedRegion(op.unwarped, liveGrid);
        const made = region ? await createParked(slot, region, op) : null;
        clip = made ?? (await create(false));
        park = made !== null;
      } else clip = await create(warped);
      if (warped && op.unwarped && !checked) {
        checked = true;
        if (!keepsSourceWarp(clip, info)) {
          unwarp = true;
          warped = false;
          liveGrid = usableWarp(clip.warpMarkers) ? clip.warpMarkers.map((m) => ({ beatTime: m.beatTime, sampleTime: m.sampleTime })) : null;
          await slot.deleteClip();
          const region = liveGrid ? parkedRegion(op.unwarped, liveGrid) : null;
          const probe = region ? await createParked(slot, region, op) : null;
          if (probe) {
            clip = probe;
            // The first parked slice is checked at once, so a Live that does not keep the place stops it for the rest.
            if (!unwarpParked(context, clip, op.unwarped, info)) {
              parking = false;
              logStep(`the first parked clip ("${op.name}", scene ${op.sceneIndex}) did not keep its place when unwarped; the slices are made unwarped from the file instead`);
              await slot.deleteClip();
              clip = await create(false);
            }
          } else clip = await create(false);
        }
      }
      if (park) parked.push({ slotIndex: op.sceneIndex, clip, op });
      const made = clip;
      const parkIt = park;
      finalizers.push(() => {
        made.name = op.name;
        made.color = op.color;
        if (warped && info.warpMode !== undefined) made.warpMode = info.warpMode;
        if (parkIt) {
          // Each step on its own: a refused warp mode must not stop the unwarp, and neither stops the names of the
          // slices after this one. A slice left warped is found by the read-back and made again.
          if (info.warpMode !== undefined) {
            try {
              made.warpMode = info.warpMode; // the mode Live warps it with when Loop goes on
            } catch (error) {
              logStep(`setting the warp mode of the parked clip "${op.name}" failed`, error);
            }
          }
          try {
            made.warping = false;
          } catch (error) {
            logStep(`unwarping the parked clip "${op.name}" (scene ${op.sceneIndex}) failed; the read-back makes it again`, error);
          }
        }
      });
    }
  } catch (error) {
    errors.push(error);
  }

  if (finalizers.length > 0) {
    try {
      context.withinTransaction(() => {
        for (const apply of finalizers) apply();
      });
    } catch (error) {
      errors.push(error);
    }
  }

  // A parked slice Live did not turn into the right unwarped clip is made again as a plain one (fb4, item 3).
  for (const { slotIndex, clip, op } of parked) {
    if (parkedOk(clip, op.unwarped!)) continue;
    try {
      const slot = slots[slotIndex];
      await slot.deleteClip();
      const plain = await slot.createAudioClip({ filePath: info.filePath, isWarped: false, loopSettings: op.unwarped! });
      context.withinTransaction(() => {
        plain.name = op.name;
        plain.color = op.color;
      });
    } catch (error) {
      logStep(`making the clip "${op.name}" (scene ${op.sceneIndex}) again as a plain unwarped one failed`, error);
      errors.push(error);
    }
  }

  if (errors.length > 0) throw errors[0];
}

/** Says on the host's log what went wrong in a step that has a fallback. */
function logStep(what: string, error?: unknown): void {
  console.error(`Song Sections: ${what}`, ...(error === undefined ? [] : [error]));
}

type SlotOp = Extract<SessionOp, { kind: "slotClip" }>;

/** What executeSession reads and sets on a slice it made. */
interface SliceClip {
  name: string;
  color: number;
  warpMode: WarpMode;
  warping: boolean;
  startMarker: number;
  endMarker: number;
  warpMarkers: { beatTime: number; sampleTime: number }[];
}

/** Within this many seconds, a parked slice's unwarped markers are the slice's file seconds. */
const PARKED_SEC = 1e-3;
/** The SDK's shortest loop, in beats (ClipLoopSettings). */
const MIN_LOOP_BEATS = 0.25;

/**
 * fb4, item 3: the slice's file seconds as beats on `grid` (Live's grid for a clip made from the file), for a warped
 * clip with the slice as its markers and its loop region, not looping. null when the grid gives no such region.
 */
export function parkedRegion(file: ClipLoopSettings, grid: readonly WarpPoint[]): ClipLoopSettings | null {
  const a = secToBeat(grid, file.startMarker);
  const b = secToBeat(grid, file.endMarker);
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b - a < MIN_LOOP_BEATS) return null;
  return { startMarker: a, endMarker: b, loopStart: a, loopEnd: b, looping: false };
}

/** Whether a parked slice, now unwarped, has the slice's file seconds as its markers (never throws). */
function parkedOk(clip: SliceClip, file: ClipLoopSettings): boolean {
  try {
    return clip.warping === false && Math.abs(clip.startMarker - file.startMarker) <= PARKED_SEC && Math.abs(clip.endMarker - file.endMarker) <= PARKED_SEC;
  } catch {
    return false;
  }
}

/** Unwarps a parked slice now and says whether it kept the slice's place (never throws). */
function unwarpParked(context: Ctx, clip: SliceClip, file: ClipLoopSettings, info: ClipInfo): boolean {
  try {
    // One transaction, so the two setters are one undo step (fb4 review M2).
    context.withinTransaction(() => {
      if (info.warpMode !== undefined) clip.warpMode = info.warpMode;
      clip.warping = false;
    });
  } catch {
    return false;
  }
  return parkedOk(clip, file);
}

/** Whether Live warped a new slice on the source's own grid over the source's markers (never throws). */
function keepsSourceWarp(clip: { warpMarkers: { beatTime: number; sampleTime: number }[] }, info: ClipInfo): boolean {
  try {
    return sameWarp(info.warpMarkers, clip.warpMarkers, info.startMarker, info.endMarker);
  } catch {
    return false;
  }
}
