import { describe, expect, it } from "vitest";
import type { Marker, SliceName, Span } from "./contract.js";
import { NO_EDITS, deleteCut, insertCut, laneCuts, moveCut, patternHues, patternLabels, renamePattern } from "./lane.js";

const markers: Marker[] = [
  { id: 1, time: 10 },
  { id: 2, time: 20 },
];
const machine = [5, 15, 25];
const D = 30;
const times = (cs: { time: number }[]) => cs.map((c) => c.time);
const idx = (cs: { time: number }[], t: number) => cs.findIndex((c) => c.time === t);

describe("laneCuts", () => {
  it("merges markers and machine cuts in time order, markers carrying their ids", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    expect(times(cuts)).toEqual([5, 10, 15, 20, 25]);
    expect(cuts.map((c) => c.owner)).toEqual(["machine", "marker", "machine", "marker", "machine"]);
    expect(cuts.filter((c) => c.owner === "marker").map((c) => c.markerId)).toEqual([1, 2]);
  });

  it("follows a moved marker", () => {
    expect(times(laneCuts([{ id: 1, time: 11 }, markers[1]], machine, NO_EDITS, D))).toEqual([5, 11, 15, 20, 25]);
  });

  it("keeps only cuts strictly inside the clip", () => {
    const edits = { ...NO_EDITS, added: [0, 30, 31, -2] };
    expect(times(laneCuts(markers, machine, edits, D))).toEqual([5, 10, 15, 20, 25]);
  });

  it("keeps one of two cuts closer than a second: marker over user over machine, the earlier at equal priority", () => {
    expect(times(laneCuts([], [10, 10.5, 12], { ...NO_EDITS, added: [10.4] }, D))).toEqual([10.4, 12]);
    expect(laneCuts([], [10, 10.5], NO_EDITS, D).map((c) => c.time)).toEqual([10]);
    expect(times(laneCuts([{ id: 1, time: 10.8 }], [10], NO_EDITS, D))).toEqual([10.8]);
  });

  it("keeps cuts exactly a second apart", () => {
    expect(times(laneCuts([], [10, 11], NO_EDITS, D))).toEqual([10, 11]);
  });

  it("shows the marker cut over a user cut next to it, which stays in added", () => {
    const edits = { ...NO_EDITS, added: [16] };
    const cuts = laneCuts([{ id: 1, time: 16.4 }], [], edits, D);
    expect(cuts).toEqual([{ time: 16.4, owner: "marker", markerId: 1 }]);
    expect(edits.added).toEqual([16]);
  });
});

describe("moving cuts", () => {
  it("detaches a marker cut for this lane only and makes the new place his", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    const edits = moveCut(NO_EDITS, cuts, idx(cuts, 10), 12, D);
    expect(edits.detached).toEqual([1]);
    expect(edits.added).toEqual([12]);
    expect(NO_EDITS).toEqual({ detached: [], removed: [], added: [], renames: [] });
    const moved = [{ id: 1, time: 9 }, markers[1]];
    expect(times(laneCuts(moved, machine, edits, D))).toEqual([5, 12, 15, 20, 25]);
    expect(times(laneCuts(moved, machine, NO_EDITS, D))).toEqual([5, 9, 15, 20, 25]);
  });

  it("removes a moved machine cut and adds his own", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    const edits = moveCut(NO_EDITS, cuts, idx(cuts, 15), 16, D);
    expect(edits.removed).toEqual([15]);
    expect(edits.added).toEqual([16]);
    expect(times(laneCuts(markers, machine, edits, D))).toEqual([5, 10, 16, 20, 25]);
  });

  it("moves a user cut by changing its own added entry", () => {
    const first = { ...NO_EDITS, added: [7, 16] };
    const cuts = laneCuts(markers, [], first, D);
    const edits = moveCut(first, cuts, idx(cuts, 16), 17, D);
    expect(edits.added).toEqual([7, 17]);
    expect(edits.removed).toEqual([]);
    expect(edits.detached).toEqual([]);
  });

  it("clamps a move a second inside its neighbours, as moveBoundary does", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    expect(moveCut(NO_EDITS, cuts, idx(cuts, 15), 99, D).added).toEqual([19]);
    expect(moveCut(NO_EDITS, cuts, idx(cuts, 15), -5, D).added).toEqual([11]);
    expect(moveCut(NO_EDITS, cuts, idx(cuts, 5), -5, D).added).toEqual([1]);
    expect(moveCut(NO_EDITS, cuts, idx(cuts, 25), 99, D).added).toEqual([29]);
  });

  it("changes nothing when the clamped place is where the cut already is", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    expect(moveCut(NO_EDITS, cuts, idx(cuts, 10), 10, D)).toBe(NO_EDITS);
  });
});

describe("deleting cuts", () => {
  it("detaches a marker cut", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    expect(deleteCut(NO_EDITS, cuts, idx(cuts, 20)).detached).toEqual([2]);
  });

  it("removes a machine cut for good: it stays gone when the slider moves", () => {
    const cuts = laneCuts(markers, machine, NO_EDITS, D);
    const edits = deleteCut(NO_EDITS, cuts, idx(cuts, 25));
    expect(edits.removed).toEqual([25]);
    expect(times(laneCuts(markers, [5, 15.03, 25, 27], { ...edits, removed: [15, 25] }, D))).toEqual([5, 10, 20, 27]);
  });

  it("drops a user cut from added", () => {
    const first = { ...NO_EDITS, added: [7, 16] };
    const cuts = laneCuts(markers, [], first, D);
    expect(deleteCut(first, cuts, idx(cuts, 7)).added).toEqual([16]);
  });
});

describe("the slider never wipes edits", () => {
  it("keeps his cut and the detachment when the machine has no cuts", () => {
    const edits = { ...NO_EDITS, detached: [1], added: [16], removed: [15] };
    const cuts = laneCuts([{ id: 1, time: 9 }, markers[1]], [], edits, D);
    expect(cuts.map((c) => [c.time, c.owner])).toEqual([[16, "user"], [20, "marker"]]);
  });
});

describe("NO_EDITS", () => {
  it("is frozen, arrays and all, so no lane can change the edits every lane starts from", () => {
    expect(Object.isFrozen(NO_EDITS)).toBe(true);
    for (const list of Object.values(NO_EDITS)) expect(Object.isFrozen(list)).toBe(true);
    expect(() => NO_EDITS.added.push(3)).toThrow(TypeError);
    expect(insertCut(NO_EDITS, [], 5, 20).added).toEqual([5]);
    expect(NO_EDITS).toEqual({ detached: [], removed: [], added: [], renames: [] });
  });
});

describe("insertCut", () => {
  const cuts = laneCuts(markers, machine, NO_EDITS, D);
  it("changes nothing within a second of a cut or an end", () => {
    expect(insertCut(NO_EDITS, cuts, 10.5, D)).toBe(NO_EDITS);
    expect(insertCut(NO_EDITS, cuts, 0.5, D)).toBe(NO_EDITS);
    expect(insertCut(NO_EDITS, cuts, 29.5, D)).toBe(NO_EDITS);
  });
  it("adds his own cut elsewhere", () => {
    expect(insertCut(NO_EDITS, cuts, 7, D).added).toEqual([7]);
  });
});

describe("patternLabels", () => {
  const slices: Span[] = [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
    { start: 10, end: 15 },
    { start: 15, end: 20 },
  ];
  const n = (pattern: number | null, variant = false): SliceName => ({ pattern, variant });
  const riffMembers: Span[] = [slices[0], slices[2]];

  it("falls back to the computed text", () => {
    expect(patternLabels(slices, [n(1), n(2), n(1), n(1, true)], [])).toEqual(["1", "2", "1", "1′"]);
  });

  it("labels a renamed pattern, its variants with a prime, others untouched", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    expect(patternLabels(slices, [n(1), n(2), n(1), n(1, true)], edits.renames)).toEqual(["Riff", "2", "Riff", "Riff′"]);
  });

  it("keeps the rename on the same slices when the numbering shifts", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    expect(patternLabels(slices, [n(2), n(1), n(2), n(2, true)], edits.renames)).toEqual(["Riff", "1", "Riff", "Riff′"]);
  });

  it("clears the rename when renamed back to the computed text, or to nothing", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    expect(renamePattern(edits, riffMembers, "1", "1").renames).toEqual([]);
    expect(renamePattern(edits, riffMembers, "", "1").renames).toEqual([]);
    expect(patternLabels(slices, [n(1), n(2), n(1), n(1, true)], renamePattern(edits, riffMembers, "1", "1").renames)).toEqual([
      "1",
      "2",
      "1",
      "1′",
    ]);
  });

  it("clears a rename whose pattern gained a slice", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    expect(renamePattern(edits, [slices[0], slices[2], slices[3]], "1", "1").renames).toEqual([]);
  });

  it("lets a later rename beat an earlier one for the same pattern", () => {
    let edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    edits = renamePattern(edits, riffMembers, "Hook", "1");
    expect(patternLabels(slices, [n(1), n(2), n(1), n(1, true)], edits.renames)).toEqual(["Hook", "2", "Hook", "Hook′"]);
  });

  it("leaves a rename dormant until a pattern matches again", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    // Only a quarter of the members' length is still covered by one pattern: no claim.
    const other: Span[] = [{ start: 20, end: 40 }];
    expect(patternLabels(other, [n(1)], edits.renames)).toEqual(["1"]);
    expect(patternLabels(slices, [n(1), n(2), n(1), n(1, true)], edits.renames)[0]).toBe("Riff");
  });

  it("needs at least half the members' length to claim", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1"); // members total 10 s
    expect(patternLabels(slices, [n(1), n(2), n(2), n(2)], edits.renames)[0]).toBe("Riff"); // 5 s of 10 s
    expect(patternLabels(slices, [n(2), n(2), n(1), n(2)], edits.renames)[2]).toBe("Riff");
    const wide = renamePattern(NO_EDITS, [{ start: 0, end: 20 }], "All", "1");
    expect(patternLabels(slices, [n(1), n(2), n(3), n(4)], wide.renames)).toEqual(["1", "2", "3", "4"]); // 5 s of 20 s
  });

  it("claims the pattern overlapping most", () => {
    const edits = renamePattern(NO_EDITS, [slices[0], slices[1], slices[2]], "Mix", "1");
    expect(patternLabels(slices, [n(1), n(2), n(2), n(1)], edits.renames)).toEqual(["1", "Mix", "Mix", "1"]);
  });

  it("never labels a rest", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    expect(patternLabels(slices, [n(1), n(null), n(1), n(null)], edits.renames)).toEqual(["Riff", null, "Riff", null]);
  });

  it("never mutates its input", () => {
    const edits = renamePattern(NO_EDITS, riffMembers, "Riff", "1");
    const before = JSON.stringify(edits);
    renamePattern(edits, riffMembers, "Hook", "1");
    renamePattern(edits, riffMembers, "1", "1");
    expect(JSON.stringify(edits)).toBe(before);
    expect(NO_EDITS.renames).toEqual([]);
  });
});

describe("patternHues", () => {
  const base = (pattern: number | null) => ({ pattern, variant: false });
  const prime = (pattern: number) => ({ pattern, variant: true });

  it("gives every slice its own pattern, and a rest none, until a name says otherwise", () => {
    expect(patternHues([base(1), base(null), base(2), prime(2)], ["1", null, "2", "2′"])).toEqual([1, null, 2, 2]);
    expect(patternHues([base(1), base(2)], ["1", "Riff"])).toEqual([1, 2]);
  });

  it("takes the colour of the pattern a number names, its variants too, even when that pattern has another name", () => {
    expect(patternHues([base(1), base(3), prime(3)], ["1", "1", "1′"])).toEqual([1, 1, 1]);
    expect(patternHues([base(1), base(3)], ["Riff", "1"])).toEqual([1, 1]);
    expect(patternHues([base(1), base(2)], ["1", "7"])).toEqual([1, 7]);
    expect(patternHues([base(1), base(2)], ["1", "1 - hook"])).toEqual([1, 1]);
  });

  it("gives patterns sharing a name the lowest one's colour, in whichever order they were named", () => {
    expect(patternHues([base(2), base(5), prime(5), base(7)], ["Riff", "Riff", "Riff′", "Riff"])).toEqual([2, 2, 2, 2]);
    expect(patternHues([base(7), base(5)], ["Riff", "Riff"])).toEqual([5, 5]);
  });

  it("does not read a name that only looks like a number", () => {
    expect(patternHues([base(1), base(2), base(3)], ["1", "0", "1a"])).toEqual([1, 2, 3]);
  });
});
