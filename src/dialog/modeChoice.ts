// What picking a mode in the picker should do, and the picker's note. Pure.
import type { DialogMode, ModeInfo, StructureProgress } from "./protocol.js";

export type ModeChoice =
  | { kind: "none" }
  | { kind: "switch" }
  | { kind: "blocked"; message: string }
  /** The model download failed for a reason a second attempt can fix: show the reason with Retry. */
  | { kind: "retry"; message: string }
  /** Long track: ask before analysing (Analyze switches, Back dismisses). */
  | { kind: "confirm"; message: string }
  /** fb/hfmodels: the models are not installed: ask before downloading them (Download, Not now). */
  | { kind: "download"; message: string };

const FALLBACK = "Structure analysis is not available.";

export function chooseMode(target: DialogMode, current: DialogMode, modes: ModeInfo, durationSec: number): ModeChoice {
  if (target === current) return { kind: "none" };
  if (target === "structure") {
    const s = modes.structure;
    if (!s.available) return { kind: s.retryable ? "retry" : "blocked", message: s.reason ?? FALLBACK };
    if (s.needsDownload) return { kind: "download", message: downloadConsent(s) };
    if (s.warn) {
      return {
        kind: "confirm",
        message: `Structure analysis of this ${Math.round(durationSec / 60)}-minute clip takes about ${Math.ceil(s.estimateSec / 60)} minutes.`,
      };
    }
  }
  return { kind: "switch" };
}

const MB = (bytes: number) => Math.round(bytes / 1e6);

/**
 * fb/hfmodels: what the Structure tab says before the first download (flow.ts asks with the same words when it has
 * to). No links: plain names. `diskBytes` is absent in payloads from before it existed.
 */
export function downloadConsent(s: { downloadBytes: number; diskBytes?: number }): string {
  const disk = s.diskBytes ? ` They take about ${MB(s.diskBytes)} MB on disk.` : "";
  return (
    "Structure needs two analysis models. Song Sections downloads them once from Hugging Face: " +
    "allin1 by Taejun Kim (MIT licence) and HT Demucs by Meta (Alexandre Défossez). " +
    `The download is about ${MB(s.downloadBytes)} MB.${disk}`
  );
}

/** The note under the tabs in the Cue view, or null. */
export function pickerNote(modes: ModeInfo): string | null {
  const s = modes.structure;
  return s.needsDownload ? `First use downloads the analysis models (${MB(s.downloadBytes)} MB).` : null;
}

/** The Structure tab's label: with the background analysis's progress while it runs (fb2), else the plain name. */
export function structureTabLabel(progress: StructureProgress | null): string {
  if (progress && (progress.state === "running" || progress.state === "pending")) return `Structure ${Math.round(progress.percent)}%`;
  return "Structure";
}
