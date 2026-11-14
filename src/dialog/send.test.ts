import { describe, expect, it } from "vitest";
import { laneCellTarget, sendItems } from "./send.js";

describe("laneCellTarget (Plan 6)", () => {
  const slices = [
    { start: 0, end: 4, label: "bass 1", color: 1 },
    { start: 6, end: 10, label: "bass 2", color: 2 },
  ];
  const cell = (start: number, end: number, label: string) => ({ start, end, label });

  it("a cell is the slice that holds its middle, titled by its own label", () => {
    expect(laneCellTarget(cell(6, 10, "2"), slices)).toEqual({ index: 1, label: "2", rest: false });
  });

  it("a rest (no cell) is no slice", () => {
    expect(laneCellTarget(undefined, slices)).toEqual({ index: 0, label: "rest", rest: true });
  });

  it("Task 7 review: a short last cell that laneSlices dropped is a rest too, titled rest", () => {
    expect(laneCellTarget(cell(10.5, 11, "3"), slices)).toEqual({ index: 0, label: "rest", rest: true });
  });
});

describe("sendItems: Send all stems (Plan 6, Task 8)", () => {
  it("ends every menu when stems are kept, and is absent otherwise", () => {
    expect(sendItems("mix", "sections", { stems: true }).all.map((i) => i.target)).toEqual(["drumRack", "audioWhole", "allStems"]);
    expect(sendItems("bass", "patterns", { rest: true, stems: true }).all.at(-1)).toEqual({ target: "allStems", label: "Send all stems to new tracks" });
    expect(sendItems("mix").all.map((i) => i.target)).toEqual(["drumRack", "audioWhole"]);
  });
});
