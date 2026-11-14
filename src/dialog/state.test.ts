import { describe, expect, it } from "vitest";
import { gradientColors } from "../core/colors.js";
import { cannedPayload } from "./fixture.js";
import { createDialogState } from "./state.js";

describe("dialog state", () => {
  it("starts from the payload's boundaries and settings", () => {
    const p = cannedPayload();
    const s = createDialogState(p);
    expect(s.boundaries).toEqual(p.boundaries);
    expect(s.granularity).toBe(p.granularity);
    expect(s.colorMode).toBe("gradient");
    expect(s.output).toBe("split");
    expect(s.selected).toBeNull();
  });

  it("finer granularity gives at least as many boundaries", () => {
    const s = createDialogState(cannedPayload());
    s.setGranularity(0);
    const coarse = s.boundaries.length;
    s.setGranularity(1);
    expect(s.boundaries.length).toBeGreaterThanOrEqual(coarse);
    expect(s.boundaries.length).toBeGreaterThan(0);
  });

  it("keeps a renamed label when a boundary moves", () => {
    const s = createDialogState(cannedPayload());
    s.rename(1, "Riff");
    s.move(0, s.boundaries[0] + 2);
    expect(s.sections()[1].label).toBe("Riff");
  });

  it("resets labels to Cue N when granularity changes", () => {
    const s = createDialogState(cannedPayload());
    s.rename(0, "Intro");
    s.rename(1, "Riff");
    s.setGranularity(0.8);
    s.sections().forEach((sec, i) => expect(sec.label).toBe(`Cue ${i + 1}`));
  });

  it("result() covers [0, duration] contiguously with gradient colors by default", () => {
    const p = cannedPayload();
    const s = createDialogState(p);
    const r = s.result();
    if (r.action !== "apply") throw new Error("expected apply");
    expect(r.output).toBe("split");
    expect(r.sections[0].start).toBe(0);
    expect(r.sections.at(-1)!.end).toBe(p.durationSec);
    for (let i = 1; i < r.sections.length; i++) {
      expect(r.sections[i].start).toBe(r.sections[i - 1].end);
    }
    expect(r.sections.map((x) => x.color)).toEqual(gradientColors(r.sections.length));
  });

  it("result() with uniform colors uses sourceColor everywhere", () => {
    const p = cannedPayload();
    const s = createDialogState(p);
    s.colorMode = "uniform";
    const r = s.result();
    if (r.action !== "apply") throw new Error("expected apply");
    expect(r.sections.every((x) => x.color === p.sourceColor)).toBe(true);
  });

  it("add() splits a section and shifts later labels; remove() merges back", () => {
    const s = createDialogState(cannedPayload());
    const n = s.sections().length;
    s.rename(1, "Riff");
    s.rename(2, "Drop");
    const t = (s.boundaries[0] + s.boundaries[1]) / 2; // inside section 1
    s.add(t);
    expect(s.sections().length).toBe(n + 1);
    expect(s.sections()[1].label).toBe("Riff");
    expect(s.sections()[3].label).toBe("Drop");
    s.remove(1); // the boundary just added
    expect(s.sections().length).toBe(n);
    expect(s.sections()[1].label).toBe("Riff");
    expect(s.sections()[2].label).toBe("Drop");
  });

  it("remove() clears the selection", () => {
    const s = createDialogState(cannedPayload());
    s.selected = 0;
    s.remove(0);
    expect(s.selected).toBeNull();
  });

  it("setGranularity() drops peaks that would make sections shorter than the minimum", () => {
    // pickPeaks finds peaks at 0, 3 and 5.5 s; only 3 s leaves both neighbours >= 1 s.
    const p = cannedPayload({ novelty: [5, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 5], durationSec: 6 });
    const s = createDialogState(p);
    s.setGranularity(1);
    expect(s.boundaries).toEqual([3]);
  });

  it("renaming to the default Cue N label stores no override, so labels stay sequential", () => {
    const s = createDialogState(cannedPayload());
    s.rename(2, "Cue 3");
    s.add(s.boundaries[0] / 2); // split section 0, before section 2
    s.sections().forEach((sec, i) => expect(sec.label).toBe(`Cue ${i + 1}`));
  });

  it("cancel() result", () => {
    const s = createDialogState(cannedPayload());
    expect(s.cancel()).toEqual({ action: "cancel" });
  });
});

describe("dialog state: snapping to the beat grid", () => {
  const grid = Array.from({ length: 360 }, (_, i) => i * 0.5);
  const withGrid = (over = {}) => cannedPayload({ beatGrid: grid, snap: true, ...over });

  it("has no snapping without a beat grid", () => {
    const p = cannedPayload({ beatGrid: null, snap: true });
    const s = createDialogState(p);
    expect(s.canSnap).toBe(false);
    expect(s.boundaries).toEqual(p.boundaries);
    s.move(0, s.boundaries[0] + 0.3);
    expect(s.boundaries[0]).toBeCloseTo(p.boundaries[0] + 0.3);
  });

  it("snaps the initial boundaries, moves and adds to the grid", () => {
    const s = createDialogState(withGrid());
    expect(s.canSnap).toBe(true);
    for (const b of s.boundaries) expect(grid).toContain(b);
    s.move(1, s.boundaries[1] + 3.3);
    expect(grid).toContain(s.boundaries[1]);
    s.add(100.2);
    expect(s.boundaries).toContain(100);
  });

  it("does not snap a move with snap off, and setSnap(true) re-snaps", () => {
    const s = createDialogState(withGrid({ snap: false }));
    expect(s.snap).toBe(false);
    s.move(1, s.boundaries[1] + 3.3);
    s.setSnap(true);
    for (const b of s.boundaries) expect(grid).toContain(b);
    s.setSnap(false);
    const kept = [...s.boundaries];
    s.setSnap(false);
    expect(s.boundaries).toEqual(kept);
  });

  it("snaps the boundaries a granularity change picks", () => {
    const s = createDialogState(withGrid());
    s.setGranularity(0.9);
    for (const b of s.boundaries) expect(grid).toContain(b);
  });

  it("re-snapping keeps the surviving section's rename, not the collapsed sliver's", () => {
    const g = Array.from({ length: 100 }, (_, i) => i * 2);
    const s = createDialogState(cannedPayload({ beatGrid: g, snap: false }));
    s.boundaries = [10.2, 10.9, 30];
    s.labels = { 0: "Zero", 1: "One", 2: "Two", 3: "Three" };
    s.setSnap(true);
    expect(s.boundaries).toEqual([10, 30]);
    expect(s.snapMerged).toBe(1);
    expect(s.labels).toEqual({ 0: "Zero", 1: "Two", 2: "Three" });
  });

  it("keeps a rename on the section after a boundary that snaps onto the clip start", () => {
    const g = Array.from({ length: 100 }, (_, i) => i * 2);
    const s = createDialogState(cannedPayload({ beatGrid: g, snap: false }));
    s.boundaries = [1, 30];
    s.rename(1, "Intro!"); // [1, 30]
    s.setSnap(true); // 1 is as near 0 as 2: ties go to the earlier point
    expect(s.boundaries).toEqual([30]);
    expect(s.sections()[0].label).toBe("Intro!");
  });
});

describe("Cue: move and add with snapping skipped for one edit (feedback round 2: Cmd/Ctrl)", () => {
  const grid = Array.from({ length: 361 }, (_, i) => i * 0.5);
  const onGrid = (t: number) => Math.abs(t / 0.5 - Math.round(t / 0.5)) < 1e-9;

  it("free leaves the time as given with snap on; snap stays on", () => {
    const s = createDialogState(cannedPayload({ beatGrid: grid, snap: true }));
    s.move(2, s.boundaries[2] + 1.13, true);
    expect(onGrid(s.boundaries[2])).toBe(false);
    s.move(2, s.boundaries[2] + 1.13);
    expect(onGrid(s.boundaries[2])).toBe(true);
    s.add(1.37, true);
    expect(s.boundaries).toContain(1.37);
    expect(s.snap).toBe(true);
  });
});
