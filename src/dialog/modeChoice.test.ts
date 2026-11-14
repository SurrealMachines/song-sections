import { describe, expect, it } from "vitest";
import { chooseMode, downloadConsent, pickerNote, structureTabLabel } from "./modeChoice.js";
import type { ModeInfo } from "./protocol.js";

const info = (over: Partial<ModeInfo["structure"]> = {}): ModeInfo => ({
  structure: { available: true, reason: null, cached: false, needsDownload: false, downloadBytes: 1, estimateSec: 66, warn: false, ...over },
});

describe("chooseMode", () => {
  it("does nothing when the target is the current mode", () => {
    expect(chooseMode("cue", "cue", info(), 180)).toEqual({ kind: "none" });
    expect(chooseMode("structure", "structure", info(), 180)).toEqual({ kind: "none" });
  });
  it("does nothing for the current mode even when Structure is unavailable", () => {
    expect(chooseMode("structure", "structure", info({ available: false, reason: "R" }), 180)).toEqual({ kind: "none" });
  });
  it("blocks Structure with the reason when it is unavailable", () => {
    expect(chooseMode("structure", "cue", info({ available: false, reason: "R" }), 180)).toEqual({ kind: "blocked", message: "R" });
  });
  it("gives a generic message when Structure is unavailable without a reason", () => {
    const r = chooseMode("structure", "cue", info({ available: false, reason: null }), 180);
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.message.length).toBeGreaterThan(0);
  });
  it("switches to an available Structure", () => {
    expect(chooseMode("structure", "cue", info(), 180)).toEqual({ kind: "switch" });
  });
  it("always lets you go back to Cue points", () => {
    expect(chooseMode("cue", "structure", info({ available: false, reason: "R" }), 180)).toEqual({ kind: "switch" });
  });
});

describe("chooseMode on a long track (Task 12)", () => {
  it("asks for confirmation with the duration and estimate", () => {
    expect(chooseMode("structure", "cue", info({ warn: true, estimateSec: 469 }), 1440)).toEqual({
      kind: "confirm",
      message: "Structure analysis of this 24-minute clip takes about 8 minutes.",
    });
  });
  it("rounds the duration and rounds the estimate up", () => {
    const r = chooseMode("structure", "cue", info({ warn: true, estimateSec: 61 }), 629);
    expect(r).toEqual({ kind: "confirm", message: "Structure analysis of this 10-minute clip takes about 2 minutes." });
  });
  it("blocks rather than confirms when Structure is unavailable", () => {
    expect(chooseMode("structure", "cue", info({ warn: true, available: false, reason: "R" }), 1440)).toEqual({ kind: "blocked", message: "R" });
  });
  it("switches without asking when not warned, and never asks to go back to Cue points", () => {
    expect(chooseMode("structure", "cue", info({ warn: false, estimateSec: 469 }), 1440)).toEqual({ kind: "switch" });
    expect(chooseMode("cue", "structure", info({ warn: true }), 1440)).toEqual({ kind: "switch" });
    expect(chooseMode("structure", "structure", info({ warn: true }), 1440)).toEqual({ kind: "none" });
  });
});

describe("chooseMode when the models are not installed (fb/hfmodels)", () => {
  it("asks for consent with what, from whom and the sizes, before the long-track confirm", () => {
    const r = chooseMode("structure", "cue", info({ needsDownload: true, downloadBytes: 95_230_008, diskBytes: 190_454_313, warn: true }), 1440);
    expect(r).toEqual({
      kind: "download",
      message:
        "Structure needs two analysis models. Song Sections downloads them once from Hugging Face: allin1 by Taejun Kim (MIT licence) " +
        "and HT Demucs by Meta (Alexandre Défossez). The download is about 95 MB. They take about 190 MB on disk.",
    });
  });
  it("leaves out the disk size when an older payload has none, and blocks an unavailable Structure first", () => {
    expect(downloadConsent({ downloadBytes: 95_230_008 })).toMatch(/about 95 MB\.$/);
    expect(chooseMode("structure", "cue", info({ needsDownload: true, available: false, reason: "R" }), 180)).toEqual({ kind: "blocked", message: "R" });
  });
});

describe("pickerNote", () => {
  it("notes the first-use download with its size in MB", () => {
    expect(pickerNote(info({ needsDownload: true, downloadBytes: 190048947 }))).toBe("First use downloads the analysis models (190 MB).");
  });
  it("is null when nothing needs downloading", () => {
    expect(pickerNote(info({ needsDownload: false, downloadBytes: 190048947 }))).toBeNull();
  });
});

describe("chooseMode after a failed model download", () => {
  it("offers a retry with the reason when Structure is unavailable but retryable", () => {
    expect(chooseMode("structure", "cue", info({ available: false, reason: "R", retryable: true }), 180)).toEqual({
      kind: "retry",
      message: "R",
    });
  });
  it("still blocks a permanent reason", () => {
    expect(chooseMode("structure", "cue", info({ available: false, reason: "R", retryable: false }), 180).kind).toBe("blocked");
  });
});

describe("structureTabLabel (fb2)", () => {
  it("shows the background analysis's percentage while it runs or is about to start", () => {
    expect(structureTabLabel({ state: "running", percent: 37 })).toBe("Structure 37%");
    expect(structureTabLabel({ state: "pending", percent: 0 })).toBe("Structure 0%");
  });
  it("is the plain name otherwise: done, failed (shown only on a switch), none, or no answer yet", () => {
    for (const state of ["done", "failed", "none"] as const) expect(structureTabLabel({ state, percent: 100 })).toBe("Structure");
    expect(structureTabLabel(null)).toBe("Structure");
  });
});
