// fb2 review M7: above the middle of the Sections slider, the boundaries come from the repetition plan (repeatPlan, up
// to ~450 ms on a 30-minute clip). The plan is memoised, so moving the slider back and forth reuses it instead of
// recomputing on every step. (Plan 6: Group by is gone, so the plan always reads all stems.)
import { describe, expect, it, vi } from "vitest";
import type * as Repetition from "../grouping/repetition.js";

const calls = vi.hoisted(() => ({ plans: [] as string[] }));
vi.mock("../grouping/repetition.js", async (importOriginal) => {
  const real = await importOriginal<typeof Repetition>();
  return {
    ...real,
    repeatPlan: (...args: Parameters<typeof real.repeatPlan>) => {
      calls.plans.push(args[1]);
      return real.repeatPlan(...args);
    },
  };
});

const { cannedStructurePayload } = await import("./fixture.js");
const { createStructureState } = await import("./structureState.js");
const { applySummary } = await import("./applySummary.js");

describe("the repetition plan memo (fb2 review M7)", () => {
  it("Slice by computes no plan, and moving the slider above the middle reuses the opening one", () => {
    const s = createStructureState(cannedStructurePayload({ snap: false, granularity: 0.8 }));
    expect(s.canGranulate).toBe(true);
    const opened = calls.plans.length;
    expect(opened).toBeGreaterThan(0);
    expect(calls.plans.every((by) => by === "all")).toBe(true); // the repetition splits always read all stems
    for (const sliceBy of ["drums", "bass", "vocals", "sections"] as const) s.setSliceBy(sliceBy);
    for (const g of [0.9, 0.8, 1, 0.85, 0.8]) s.setGranularity(g);
    expect(calls.plans.length).toBe(opened);
  });

  it("the Apply log line opens one Structure state, not two (fb2 review M6)", () => {
    const p = cannedStructurePayload({ snap: false, granularity: 0.8 });
    const before = calls.plans.length;
    const s = createStructureState(p);
    const one = calls.plans.length - before;
    const r = s.result();
    if (r.action !== "apply") throw new Error("expected an apply");
    const mark = calls.plans.length;
    expect(applySummary(p, r)).toMatch(/0 renamed, boundaries 0 new or moved, 0 gone/);
    expect(calls.plans.length - mark).toBe(one);
  });
});
