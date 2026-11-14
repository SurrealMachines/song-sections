import { rm } from "node:fs/promises";
import { ClipSlot, type AudioClip, type AudioTrack, type ExtensionContext } from "@ableton-extensions/sdk";
import { fromLiveColor } from "../core/colors.js";
import type { Rgb, View } from "../core/types.js";
import { throwIfAborted } from "../core/abort.js";
import { fileSpan, type WarpPoint } from "../core/warpMap.js";

type Ctx = ExtensionContext<"1.0.0">;

export interface ClipInfo {
  view: View;
  clip: AudioClip<"1.0.0">;
  track: AudioTrack<"1.0.0">;
  sceneIndex?: number;
  /** Arrangement beats (0 for session clips). */
  startTime: number;
  lengthBeats: number;
  /** Beats for warped clips, seconds for unwarped ones. */
  startMarker: number;
  endMarker: number;
  warped: boolean;
  /** Source warp mode, read up front (used by Session slices; Arrangement splits keep it natively). Undefined for unwarped clips. */
  warpMode?: AudioClip<"1.0.0">["warpMode"];
  /**
   * The source's warp markers (beat <-> file seconds), read up front like the warp mode; undefined for unwarped clips.
   * fb3: a warped Session clip is rendered and sliced through them (core/warpMap.ts fileSpan).
   */
  warpMarkers?: WarpPoint[];
  filePath: string;
  color: Rgb;
  name: string;
}

export function describeClip(context: Ctx, clip: AudioClip<"1.0.0">): ClipInfo {
  const tempo = context.application.song.tempo;
  const warped = clip.warping;
  const parent = clip.parent;
  const common = {
    clip,
    startMarker: clip.startMarker,
    endMarker: clip.endMarker,
    warped,
    warpMode: warped ? clip.warpMode : undefined,
    warpMarkers: warped ? clip.warpMarkers.map((m) => ({ beatTime: m.beatTime, sampleTime: m.sampleTime })) : undefined,
    filePath: clip.filePath,
    color: fromLiveColor(clip.color),
    name: clip.name,
  };
  if (parent instanceof ClipSlot) {
    const track = parent.parent as AudioTrack<"1.0.0">;
    const markerSpan = clip.endMarker - clip.startMarker;
    return {
      ...common,
      view: "session",
      track,
      sceneIndex: track.clipSlots.indexOf(parent),
      startTime: 0,
      lengthBeats: warped ? markerSpan : (markerSpan * tempo) / 60,
    };
  }
  return {
    ...common,
    view: "arrangement",
    track: parent as AudioTrack<"1.0.0">,
    startTime: clip.startTime,
    lengthBeats: clip.endTime - clip.startTime,
  };
}

/**
 * Renders the clip's audio and returns the path of the rendered file (AIFF in
 * practice, readable by readPcmFile). The path is under the system temp dir,
 * which the extension sandbox allows reading.
 */
export async function acquireAudio(context: Ctx, info: ClipInfo, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (info.view === "arrangement") {
    return context.resources.renderPreFxAudio(info.track, info.startTime, info.startTime + info.lengthBeats);
  }

  const song = context.application.song;
  // fb3, item 1: a warped clip is rendered unwarped, from its markers' file seconds. A clip created from the file
  // cannot be given the source's warp markers, and Live warps it on its own grid (120 BPM where the source was warped
  // at 150), so a warped temp clip played the wrong part of the file, sped up by song tempo / 120.
  const span = fileSpan(info);
  const startMarker = span ? span.startSec : info.startMarker;
  const endMarker = span ? span.endSec : info.endMarker;
  const lengthBeats = span ? ((span.endSec - span.startSec) * song.tempo) / 60 : info.lengthBeats;
  const tempTrack = await song.createAudioTrack();
  try {
    throwIfAborted(signal);
    await tempTrack.createAudioClip({
      filePath: info.filePath,
      startTime: 0,
      isWarped: span ? false : info.warped,
      // No `duration`: Live derives the length from the markers. A duration that differs from the
      // marker span, even by an ulp, makes createAudioClip fail.
      // Always explicit: a warped clip otherwise defaults to a 64-beat loop (R10).
      loopSettings: { startMarker, endMarker, loopStart: startMarker, loopEnd: endMarker, looping: false },
    });
    throwIfAborted(signal);
    const path = await context.resources.renderPreFxAudio(tempTrack, 0, lengthBeats);
    if (signal.aborted) {
      // The caller never sees this path, so clean it up here (best-effort).
      await rm(path, { force: true }).catch(() => undefined);
      throwIfAborted(signal);
    }
    return path;
  } finally {
    await song.deleteTrack(tempTrack);
  }
}
