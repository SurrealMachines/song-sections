import { describe, expect, it } from "vitest";
import { applyCounts, applySummary } from "./applySummary.js";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import type { DialogResult } from "./protocol.js";
import { createDialogState } from "./state.js";
import { createStructureState } from "./structureState.js";

type Apply = Extract<DialogResult, { action: "apply" }>;

describe("applyCounts (feedback round 2: one host-log line per Apply)", () => {
  it("Structure with no edits: nothing renamed or moved", () => {
    const p = cannedStructurePayload({ barGrid: [1, 3, 5] });
    const r = createStructureState(p).result() as Apply;
    expect(applyCounts(p, r)).toEqual({ sections: r.sections.length, renamed: 0, newBoundaries: 0, goneBoundaries: 0 });
    expect(applySummary(p, r)).toBe(`Song Sections: Apply structure (split): ${r.sections.length} sections, 0 renamed, boundaries 0 new or moved, 0 gone vs the opening`);
  });

  it("Structure: counts renames against the defaults for the applied boundaries, and boundary changes against the opening", () => {
    const p = cannedStructurePayload({ snap: false });
    const s = createStructureState(p);
    const n = s.boundaries.length;
    s.move(3, s.boundaries[3] + 3.3); // 1 new, 1 gone
    s.remove(6); // 1 gone
    s.add(100.5); // 1 new
    s.setSliceBy("drums"); // changes no label
    s.setGroupDist(0.05);
    s.rename(1, "Mine");
    s.rename(4, "Also mine");
    const r = s.result() as Apply;
    expect(r.sections).toHaveLength(n + 1);
    expect(applyCounts(p, r)).toEqual({ sections: n + 1, renamed: 2, newBoundaries: 2, goneBoundaries: 2 });
  });

  it("Structure: a rename to the default label is not counted (the dialog does not keep it as one)", () => {
    const p = cannedStructurePayload();
    const s = createStructureState(p);
    s.rename(2, s.sections()[2].label);
    expect(applyCounts(p, s.result() as Apply).renamed).toBe(0);
  });

  it("Cue: the defaults are Cue N", () => {
    const p = cannedPayload();
    const s = createDialogState(p);
    s.rename(0, "Intro");
    s.remove(0);
    const r = s.result() as Apply;
    expect(applyCounts(p, r)).toMatchObject({ renamed: 1, newBoundaries: 0, goneBoundaries: 1 });
    expect(applySummary({ ...p, view: "session" }, r)).toContain("Apply cue (session)");
  });

  it("Slice by: names the pieces' source and counts them (Plan 6, Task 6)", () => {
    const p = cannedStructurePayload({ sliceBy: "drums" });
    const r = createStructureState(p).result() as Apply;
    const n = r.pieces!.length;
    expect(applySummary(p, r)).toBe(
      `Song Sections: Apply structure (split): ${r.sections.length} sections, 0 renamed, boundaries 0 new or moved, 0 gone vs the opening, cut into ${n} drums pieces`,
    );
    const bass = createStructureState(cannedStructurePayload({ sliceBy: "bass", view: "session" })).result() as Apply;
    expect(applySummary(p, bass)).toMatch(/, cut into \d+ bass pieces$/);
  });

  it("never throws: a summary it cannot compute still names the mode and the count", () => {
    const p = cannedStructurePayload();
    const broken = { ...p, analysis: null } as unknown as typeof p;
    const r: Apply = { action: "apply", sections: [{ start: 0, end: 180, label: "A", color: 0 }], output: "split" };
    expect(applySummary(broken, r)).toMatch(/^Song Sections: Apply structure: 1 sections \(could not compare/);
  });
});
