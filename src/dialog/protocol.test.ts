// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_STRUCTURE_PREFS, injectPayload, parseResult, readPayload, SLICE_BYS, structurePrefs, type CuePayload, type StructurePrefs } from "./protocol.js";
import { cannedStructurePayload } from "./fixture.js";
import { GROUP_DIST_MAX, GROUP_DIST_MIN } from "../grouping/letters.js";

const payload: CuePayload = {
  mode: "cue", view: "arrangement", clipName: "</script><b>& ", durationSec: 12,
  audioUrl: "audio.wav", waveform: { min: [-1], max: [1] }, novelty: [0.5],
  blocksPerSec: 10, boundaries: [1, 2], granularity: 0.5, colorMode: "gradient",
  sourceColor: 0xff0000, output: "split", warpNote: false,
  modes: { structure: { available: true, reason: null, cached: false, needsDownload: false, downloadBytes: 1, estimateSec: 66, warn: false } },
  beatGrid: null, snap: false,
};
const html = "<html><body><!--PAYLOAD--></body></html>";

describe("protocol", () => {
  it("round-trips a hostile clip name through injection", () => {
    const out = injectPayload(html, payload);
    expect(out).not.toContain("<!--PAYLOAD-->");
    document.documentElement.innerHTML = out;
    expect(readPayload(document)).toEqual(payload);
    expect(document.body.querySelector("b")).toBeNull();
  });
  it("throws when the marker is missing", () => {
    expect(() => injectPayload("<html></html>", payload)).toThrow();
  });
  it("parseResult maps garbage to cancel", () => {
    expect(parseResult("garbage")).toEqual({ action: "cancel" });
    expect(parseResult('{"action":"apply"}')).toEqual({ action: "cancel" });
    expect(parseResult("null")).toEqual({ action: "cancel" });
  });
  it("parseResult round-trips a valid apply", () => {
    const r = { action: "apply", sections: [{ start: 0, end: 1, label: "A", color: 1 }], output: "both" };
    expect(parseResult(JSON.stringify(r))).toEqual(r);
  });
  it("parseResult keeps an apply's pieces (Plan 6, Slice by) and drops them when they are not sections", () => {
    const r = { action: "apply", sections: [{ start: 0, end: 2, label: "A", color: 1 }], output: "split" };
    const pieces = [
      { start: 0, end: 1, label: "drums 1", color: 2 },
      { start: 1, end: 2, label: "drums 2", color: 3 },
    ];
    expect(parseResult(JSON.stringify({ ...r, pieces }))).toEqual({ ...r, pieces });
    for (const bad of [7, "x", [{ start: 0, end: 1, label: "drums 1" }], null]) {
      expect(parseResult(JSON.stringify({ ...r, pieces: bad }))).toEqual(r);
    }
  });
  it("parseResult accepts a switch to either mode", () => {
    expect(parseResult('{"action":"switch","mode":"structure"}')).toEqual({ action: "switch", mode: "structure" });
    expect(parseResult('{"action":"switch","mode":"cue"}')).toEqual({ action: "switch", mode: "cue" });
    // fb/hfmodels: the download consent travels only as `true`, and only to Structure.
    expect(parseResult('{"action":"switch","mode":"structure","download":true}')).toEqual({ action: "switch", mode: "structure", download: true });
    expect(parseResult('{"action":"switch","mode":"structure","download":"yes"}')).toEqual({ action: "switch", mode: "structure" });
    expect(parseResult('{"action":"switch","mode":"cue","download":true}')).toEqual({ action: "switch", mode: "cue" });
  });
  it("parseResult maps an unknown mode or action to cancel", () => {
    expect(parseResult('{"action":"switch","mode":"x"}')).toEqual({ action: "cancel" });
    expect(parseResult('{"action":"switch"}')).toEqual({ action: "cancel" });
    expect(parseResult('{"action":"bogus"}')).toEqual({ action: "cancel" });
  });
  it("round-trips a structure payload with a hostile clip name, analysis included", () => {
    const p = cannedStructurePayload({ clipName: "</script>" });
    document.documentElement.innerHTML = injectPayload(html, p);
    const back = readPayload(document);
    expect(back).toEqual(p);
    if (back.mode !== "structure") throw new Error("expected structure");
    expect(back.analysis.stems.vocals.bands[0]).toEqual(p.analysis.stems.vocals.bands[0]);
  });

  it("parseResult carries valid Structure choices on apply and switch, and drops broken ones (feedback round 1)", () => {
    const prefs: StructurePrefs = { sliceBy: "other", patternLevel: 2, colorMode: "soft", snap: false, snapTarget: "bars", granularity: -0.4, groupDist: 0.3, showStems: true };
    const apply = { action: "apply", sections: [{ start: 0, end: 1, label: "A", color: 1 }], output: "split", prefs };
    expect(parseResult(JSON.stringify(apply))).toEqual(apply);
    expect(parseResult(JSON.stringify({ action: "switch", mode: "cue", prefs }))).toEqual({ action: "switch", mode: "cue", prefs });
    const broken = { ...apply, prefs: { ...prefs, colorMode: "neon", granularity: "lots" } };
    expect(parseResult(JSON.stringify(broken))).toEqual({ ...apply, prefs: { ...prefs, colorMode: "soft", granularity: -0.14 } });
    expect(parseResult(JSON.stringify({ ...apply, prefs: 7 }))).toEqual({ ...apply, prefs: DEFAULT_STRUCTURE_PREFS });
  });

  it("parseResult accepts reanalyse, with or without the Structure choices, which it checks like the others (fb2)", () => {
    const prefs: StructurePrefs = { sliceBy: "bass", patternLevel: 3, colorMode: "soft", snap: false, snapTarget: "bars", granularity: 0.7, groupDist: 0.3, showStems: true };
    expect(parseResult('{"action":"reanalyse"}')).toEqual({ action: "reanalyse" });
    expect(parseResult(JSON.stringify({ action: "reanalyse", prefs }))).toEqual({ action: "reanalyse", prefs });
    expect(parseResult(JSON.stringify({ action: "reanalyse", prefs: { ...prefs, sliceBy: "kazoo" } }))).toEqual({ action: "reanalyse", prefs: { ...prefs, sliceBy: "sections" } });
    expect(parseResult(JSON.stringify({ action: "reanalyse", sections: [], extra: 1 }))).toEqual({ action: "reanalyse" }); // nothing else rides along
  });

  it("parseResult round-trips a send of every target and source, with and without the Structure choices (v2)", () => {
    const sections = [
      { start: 0, end: 1, label: "A", color: 1 },
      { start: 1, end: 2, label: "B", color: 2 },
    ];
    for (const target of ["simpler", "drumRack", "audioSection", "audioWhole"]) { // allStems has a test of its own
      for (const source of ["mix", "drums", "bass", "vocals", "other"]) {
        const r = { action: "send", target, source, index: 1, sections };
        expect(parseResult(JSON.stringify(r))).toEqual(r);
      }
    }
    const prefs: StructurePrefs = { ...DEFAULT_STRUCTURE_PREFS, sliceBy: "bass", patternLevel: 4 };
    const r = { action: "send", target: "drumRack", source: "bass", index: 0, sections, prefs };
    expect(parseResult(JSON.stringify({ ...r, extra: 1 }))).toEqual(r); // nothing else rides along
  });

  it("parseResult carries a lane send's unit patterns, with gaps in its sections, and drops any other unit (Plan 6, Task 7)", () => {
    const sections = [
      { start: 0, end: 4, label: "drums 1", color: 1 },
      { start: 6, end: 10, label: "drums 2", color: 2 },
    ];
    const r = { action: "send", target: "drumRack", source: "drums", index: 1, sections, unit: "patterns" };
    expect(parseResult(JSON.stringify(r))).toEqual(r);
    for (const unit of ["sections", "slices", 1]) expect(parseResult(JSON.stringify({ ...r, unit }))).not.toHaveProperty("unit");
  });

  it("parseResult carries Send all stems' four stems, and refuses it unless all four are there and valid (Plan 6, Task 8)", () => {
    const sections = [
      { start: 0, end: 10, label: "A - intro", color: 1 },
      { start: 10, end: 16, label: "B - verse", color: 2 },
    ];
    const stems = {
      drums: [{ start: 0, end: 8, label: "drums 1", color: 3 }, { start: 8, end: 16, label: "drums 2", color: 4 }],
      bass: [],
      vocals: [],
      other: [{ start: 0, end: 4, label: "other 1", color: 5 }],
    };
    const r = { action: "send", target: "allStems", source: "mix", index: 0, sections, stems };
    expect(parseResult(JSON.stringify(r))).toEqual(r);
    // Nothing else rides along: no unit, no fifth stem.
    expect(parseResult(JSON.stringify({ ...r, unit: "patterns", stems: { ...stems, piano: [] } }))).toEqual(r);
    const { vocals: _, ...three } = stems;
    for (const bad of [undefined, null, [], three, { ...stems, bass: "all" }, { ...stems, other: [{ start: 0, end: 4, label: 1, color: 5 }] }]) {
      expect(parseResult(JSON.stringify({ ...r, stems: bad }))).toEqual({ action: "cancel" });
    }
    // The other targets carry no stems.
    expect(parseResult(JSON.stringify({ ...r, target: "audioWhole" }))).not.toHaveProperty("stems");
  });

  it("parseResult maps a send with an unknown target or source, a bad index or bad sections to cancel (v2)", () => {
    const sections = [{ start: 0, end: 1, label: "A", color: 1 }];
    const ok = { action: "send", target: "simpler", source: "mix", index: 0, sections };
    for (const bad of [
      { target: "sampler" },
      { source: "piano" },
      { index: 1 },
      { index: -1 },
      { index: 0.5 },
      { index: undefined },
      { sections: [{ start: 0, end: 1, label: 3, color: 1 }] },
      { sections: "all" },
    ]) {
      expect(parseResult(JSON.stringify({ ...ok, ...bad }))).toEqual({ action: "cancel" });
    }
  });
});

describe("parseResult: Key in names (v2)", () => {
  it("carries a boolean keyInNames on every result but cancel, and drops anything else", () => {
    const sections = [{ start: 0, end: 1, label: "A", color: 0 }];
    for (const r of [
      { action: "send", target: "simpler", source: "mix", index: 0, sections },
      { action: "apply", sections, output: "split" },
      { action: "switch", mode: "structure" },
      { action: "reanalyse" },
    ]) {
      expect(parseResult(JSON.stringify({ ...r, keyInNames: false }))).toMatchObject({ action: r.action, keyInNames: false });
      expect(parseResult(JSON.stringify({ ...r, keyInNames: "off" }))).not.toHaveProperty("keyInNames");
      expect(parseResult(JSON.stringify(r))).not.toHaveProperty("keyInNames");
    }
    expect(parseResult(JSON.stringify({ action: "cancel", keyInNames: false }))).toEqual({ action: "cancel" });
  });
});

describe("structurePrefs", () => {
  it("fills every missing or invalid field from the defaults, and clamps the sliders", () => {
    expect(structurePrefs(undefined)).toEqual(DEFAULT_STRUCTURE_PREFS);
    expect(DEFAULT_STRUCTURE_PREFS).toEqual({ sliceBy: "sections", patternLevel: 4, colorMode: "soft", snap: true, snapTarget: "bars", granularity: -0.14, groupDist: 0.22, showStems: true });
    expect(structurePrefs({ sliceBy: "vocals", snap: "yes", granularity: 3, groupDist: 0.001 })).toEqual({
      ...DEFAULT_STRUCTURE_PREFS,
      sliceBy: "vocals",
      granularity: 1,
      groupDist: GROUP_DIST_MIN,
    });
    expect(structurePrefs({ granularity: -9, groupDist: 2 })).toMatchObject({ granularity: -1, groupDist: GROUP_DIST_MAX });
    expect(structurePrefs({ granularity: NaN })).toMatchObject({ granularity: -0.14 });
  });

  it("Slice by and Patterns replace Group by (Plan 6): an old groupBy is ignored, patternLevel is rounded and clamped, an unknown sliceBy is Sections", () => {
    const p = structurePrefs({ groupBy: "melody", patternLevel: 2.6, sliceBy: "drums" });
    expect(p).toEqual({ ...DEFAULT_STRUCTURE_PREFS, sliceBy: "drums", patternLevel: 3 });
    expect(p).not.toHaveProperty("groupBy");
    expect(structurePrefs({ patternLevel: 9 }).patternLevel).toBe(4);
    expect(structurePrefs({ patternLevel: -3 }).patternLevel).toBe(0);
    expect(structurePrefs({ patternLevel: "2" }).patternLevel).toBe(4);
    expect(structurePrefs({ patternLevel: NaN }).patternLevel).toBe(4);
    expect(structurePrefs({ sliceBy: "melody" }).sliceBy).toBe("sections");
    expect(structurePrefs({ sliceBy: "tune" }).sliceBy).toBe("sections");
    for (const s of SLICE_BYS) expect(structurePrefs({ sliceBy: s }).sliceBy).toBe(s);
    expect(SLICE_BYS).toEqual(["sections", "drums", "bass", "vocals", "other"]);
    // Matt, 4 Nov: Slice by All is gone; a remembered or incoming "mix" reads as Sections, never as a crash.
    expect(structurePrefs({ sliceBy: "mix" }).sliceBy).toBe("sections");
    expect(parseResult(JSON.stringify({ action: "reanalyse", prefs: { ...DEFAULT_STRUCTURE_PREFS, sliceBy: "mix" } }))).toEqual({
      action: "reanalyse",
      prefs: DEFAULT_STRUCTURE_PREFS,
    });
  });
});
