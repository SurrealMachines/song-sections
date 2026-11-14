import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATTERN_LEVELS, type GridBar, type SliceName } from "./contract.js";
import type { PatternSlice } from "./engine.js";
import { formatScore, scoreBaseline, scoreKey, type AnswerKey, type Baseline, type BaselineScore, type KeyRule, type SongLanes } from "./answerKey.js";

const BAR = 1.6;
const grid: GridBar[] = Array.from({ length: 80 }, (_, i) => ({ start: i * BAR, end: (i + 1) * BAR, unsure: false }));

/** "3" → pattern 3, "3′" → its variant, "." → a rest. */
function nameOf(label: string): SliceName {
  if (label === ".") return { pattern: null, variant: false };
  return { pattern: parseInt(label, 10), variant: label.endsWith("′") };
}
/** A lane from "startBar-endBar:label" words, e.g. "0-4:1 4-8:1′ 8-10:.". */
function lane(spec: string): PatternSlice[] {
  return spec.split(/\s+/).filter(Boolean).map((w, i) => {
    const m = /^(\d+)-(\d+):(.+)$/.exec(w);
    if (!m) throw new Error(`bad slice ${w}`);
    const label = m[3];
    return { start: +m[1] * BAR, end: +m[2] * BAR, name: nameOf(label), label: label === "." ? null : label, cut: i === 0 ? null : { time: +m[1] * BAR, owner: "machine" } };
  });
}
/** A song with sections given in bars and the lanes given per level (the others are empty). */
function song(sectionBars: Array<[number, number]>, lanes: Record<number, string>): SongLanes {
  const levels: PatternSlice[][] = Array.from({ length: PATTERN_LEVELS + 1 }, (_, l) => (lanes[l] ? lane(lanes[l]) : []));
  const sections = sectionBars.map(([a, b]) => ({ start: a * BAR, end: b * BAR }));
  return { durationSec: sectionBars[sectionBars.length - 1][1] * BAR, sections, grid, levels };
}
/** A key whose sections are named a, b, c … at the song's section starts. */
function keyOf(s: SongLanes, rule: KeyRule): AnswerKey {
  const names = "abcdefgh";
  return {
    song: "T", hash: "00000000", source: "other",
    sections: Object.fromEntries(s.sections.map((sp, i) => [names[i], sp.start])),
    rules: [rule],
  };
}
const run = (s: SongLanes, rule: object) => scoreKey(keyOf(s, rule as KeyRule), s)[0];

describe("scoreKey: section lookup", () => {
  it("fails a rule whose section is not within 0.5 s of a song section", () => {
    const s = song([[0, 4], [4, 8]], { 1: "0-4:1 4-8:1" });
    const key: AnswerKey = { song: "T", hash: "x", source: "other", sections: { a: 0, b: 4 * BAR + 0.6 }, rules: [{ id: "r", kind: "oneSlice", section: "b", levels: [1] }] };
    const r = scoreKey(key, s)[0];
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/section b/);
  });
  it("finds a section whose start is 0.4 s off", () => {
    const s = song([[0, 4], [4, 8]], { 1: "0-4:1 4-8:1" });
    const key: AnswerKey = { song: "T", hash: "x", source: "other", sections: { a: 0, b: 4 * BAR + 0.4 }, rules: [{ id: "r", kind: "oneSlice", section: "b", levels: [1] }] };
    expect(scoreKey(key, s)[0].pass).toBe(true);
  });
});

describe("oneSlice", () => {
  const rule = { id: "r", kind: "oneSlice", section: "a", levels: [1, 2] };
  it("passes when each listed level holds one sounding slice", () => {
    const s = song([[0, 8], [8, 16]], { 1: "0-8:1 8-16:2", 2: "0-8:3 8-16:2" });
    expect(run(s, rule).pass).toBe(true);
  });
  it("fails when a level splits the section", () => {
    const s = song([[0, 8], [8, 16]], { 1: "0-8:1 8-16:2", 2: "0-4:1 4-8:1 8-16:2" });
    const r = run(s, rule);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/level 2/);
  });
  it("fails when the one slice is a rest", () => {
    const s = song([[0, 8], [8, 16]], { 1: "0-8:. 8-16:2", 2: "0-8:1 8-16:2" });
    expect(run(s, rule).pass).toBe(false);
  });
});

describe("repeats", () => {
  const rule = { id: "r", kind: "repeats", section: "a", level: 1, count: 4, bars: 4 };
  const sections: Array<[number, number]> = [[0, 16], [16, 24]];
  it("passes on four equal 4-bar slices with one label", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:1 8-12:1 12-16:1 16-24:2" }), rule).pass).toBe(true);
  });
  it("fails on 1 1 1′ 1", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:1 8-12:1′ 12-16:1 16-24:2" }), rule).pass).toBe(false);
  });
  it("fails on five slices", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:1 8-12:1 12-14:1 14-16:1 16-24:2" }), rule).pass).toBe(false);
  });
  it("fails on a slice of the wrong length", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:1 8-11:1 11-16:1 16-24:2" }), rule).pass).toBe(false);
  });
  it("fails on different labels", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:1 8-12:2 12-16:1 16-24:2" }), rule).pass).toBe(false);
  });
  it("fails on rests", () => {
    expect(run(song(sections, { 1: "0-4:. 4-8:. 8-12:. 12-16:. 16-24:2" }), rule).pass).toBe(false);
  });
});

describe("consistentDeeper", () => {
  const rule = { id: "r", kind: "consistentDeeper", section: "a", parts: 2, levels: [2] };
  const sections: Array<[number, number]> = [[0, 8], [8, 12]];
  const l1 = "0-4:1 4-8:1 8-12:2";
  it("passes when every part has the same inner cuts and labels", () => {
    expect(run(song(sections, { 1: l1, 2: "0-2:1 2-4:2 4-6:1 6-8:2 8-12:3" }), rule).pass).toBe(true);
  });
  it("fails when one part's offsets differ", () => {
    const r = run(song(sections, { 1: l1, 2: "0-2:1 2-4:2 4-5:1 5-8:2 8-12:3" }), rule);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/level 2/);
  });
  it("fails when one part's labels differ", () => {
    expect(run(song(sections, { 1: l1, 2: "0-2:1 2-4:2 4-6:1 6-8:3 8-12:3" }), rule).pass).toBe(false);
  });
  it("fails when level 1 does not have the stated number of parts", () => {
    expect(run(song(sections, { 1: "0-8:1 8-12:2", 2: "0-2:1 2-4:2 4-6:1 6-8:2 8-12:3" }), rule).pass).toBe(false);
  });
  it("passes parts that stay whole at the deeper level", () => {
    expect(run(song(sections, { 1: l1, 2: "0-4:1 4-8:1 8-12:3" }), rule).pass).toBe(true);
  });
});

describe("partBars", () => {
  const rule = { id: "r", kind: "partBars", section: "b", level: 1, bars: 2 };
  const sections: Array<[number, number]> = [[0, 4], [4, 11]];
  it("passes on 2-bar slices, the last one shorter", () => {
    expect(run(song(sections, { 1: "0-4:1 4-6:1 6-8:2 8-10:3 10-11:4" }), rule).pass).toBe(true);
  });
  it("fails on a longer slice", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:1 8-10:3 10-11:4" }), rule).pass).toBe(false);
  });
  it("fails on a short slice that is not the last", () => {
    expect(run(song(sections, { 1: "0-4:1 4-5:1 5-8:2 8-11:3" }), rule).pass).toBe(false);
  });
});

describe("firstIsNew", () => {
  const rule = { id: "r", kind: "firstIsNew", section: "b", against: ["a"], level: 1 };
  const sections: Array<[number, number]> = [[0, 8], [8, 12]];
  it("passes when the first slice's base is in no listed section", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:2 8-10:3 10-12:1" }), rule).pass).toBe(true);
  });
  it("fails when the first slice is 3′ and the other section has 3", () => {
    const r = run(song(sections, { 1: "0-4:1 4-8:3 8-10:3′ 10-12:4" }), rule);
    expect(r.pass).toBe(false);
  });
  it("fails when the first slice is a rest", () => {
    expect(run(song(sections, { 1: "0-4:1 4-8:2 8-10:. 10-12:4" }), rule).pass).toBe(false);
  });
});

describe("sameSequence", () => {
  const rule = { id: "r", kind: "sameSequence", a: "a", b: "c", level: 1 };
  const sections: Array<[number, number]> = [[0, 6], [6, 10], [10, 16]];
  it("passes on the same bases in order, variants ignored", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:9 10-12:1′ 12-14:2 14-16:3" }), rule).pass).toBe(true);
  });
  it("passes with rests in the same places", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:. 4-6:3 6-10:9 10-12:1 12-14:. 14-16:3" }), rule).pass).toBe(true);
  });
  it("fails on a different base", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:9 10-12:1 12-14:2 14-16:4" }), rule).pass).toBe(false);
  });
  it("fails on a different number of slices", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:9 10-13:1 13-16:2" }), rule).pass).toBe(false);
  });
  it("fails a rest against a pattern", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:9 10-12:1 12-14:. 14-16:3" }), rule).pass).toBe(false);
  });
});

describe("sliceNotIn", () => {
  const rule = { id: "r", kind: "sliceNotIn", section: "a", slice: -1, against: ["b", "c"], level: 1 };
  const sections: Array<[number, number]> = [[0, 6], [6, 10], [10, 14]];
  it("passes when the last slice's base is in neither section, though an earlier slice's is", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:1 10-14:2" }), rule).pass).toBe(true);
  });
  it("fails when the last slice's base is in a listed section, whatever its variant", () => {
    const r = run(song(sections, { 1: "0-2:1 2-4:2 4-6:3′ 6-8:5 8-10:3 10-14:2" }), rule);
    expect(r.pass).toBe(false);
  });
  it("counts a positive slice index from the start", () => {
    const s = song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:1 10-14:5" });
    expect(run(s, { ...rule, slice: 0 }).pass).toBe(false);
    expect(run(s, { ...rule, slice: 1 }).pass).toBe(true);
  });
  it("ignores rests in the listed sections", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:. 10-14:." }), rule).pass).toBe(true);
  });
  it("fails when there is no such slice", () => {
    expect(run(song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:1 10-14:2" }), { ...rule, slice: 7 }).pass).toBe(false);
  });
});

describe("slicesAlike", () => {
  const sections: Array<[number, number]> = [[0, 16], [16, 26]];
  const rule = { id: "r", kind: "slicesAlike", section: "b", level: 1, count: 2, slices: [0, 1], bars: 5 };
  it("passes on two 5-bar slices of one base, a variant too", () => {
    expect(run(song(sections, { 1: "0-16:1 16-21:2 21-26:2′" }), rule).pass).toBe(true);
  });
  it("fails on another count, another length, another base or a rest", () => {
    expect(run(song(sections, { 1: "0-16:1 16-21:2 21-24:2 24-26:2" }), rule).detail).toMatch(/3 slices, want 2/);
    expect(run(song(sections, { 1: "0-16:1 16-22:2 22-26:2" }), rule).detail).toMatch(/not all 5 bars/);
    expect(run(song(sections, { 1: "0-16:1 16-21:2 21-26:3" }), rule).detail).toMatch(/do not share a base/);
    expect(run(song(sections, { 1: "0-16:1 16-21:. 21-26:2" }), rule).detail).toMatch(/rest/);
  });
  it("counts negative slices from the end, and with `like` wants the base in that section too", () => {
    const ends = { id: "r", kind: "slicesAlike", section: "a", level: 1, slices: [-2, -1], bars: 5, like: "b" };
    expect(run(song(sections, { 1: "0-6:1 6-11:2 11-16:2 16-21:2 21-26:2" }), ends).pass).toBe(true);
    expect(run(song(sections, { 1: "0-6:1 6-11:2 11-16:2′ 16-21:3 21-26:3" }), ends).detail).toMatch(/not b's/);
    expect(run(song(sections, { 1: "0-6:1 6-11:2 11-16:2 16-21:3 21-26:3" }), { ...ends, like: undefined }).pass).toBe(true);
  });
  it("fails when there is no such slice", () => {
    expect(run(song(sections, { 1: "0-16:1 16-26:2" }), { ...rule, count: undefined }).detail).toMatch(/no slice/);
  });
});

describe("basesRelated", () => {
  const sections: Array<[number, number]> = [[0, 8], [8, 16]];
  const rule = { id: "r", kind: "basesRelated", a: "b", b: "a", level: 1, info: true };
  it("passes when a slice of one shares a base with a slice of the other, and reports the best score", () => {
    const s = { ...song(sections, { 1: "0-4:1 4-8:1 8-12:2 12-16:1′" }), score: (x: { start: number }, y: { start: number }) => (x.start + y.start) / 100 };
    const r = run(s, rule);
    expect(r).toMatchObject({ pass: true, info: true });
    expect(r.detail).toMatch(/share base 1/);
    expect(r.detail).toMatch(/best score 0\.\d\d \(b slice 2 against a slice 2\)/);
  });
  it("fails when they share none, and says so when there are no scores", () => {
    const r = run(song(sections, { 1: "0-4:1 4-8:1 8-12:2 12-16:3" }), rule);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/share no base.*no score/);
  });
});

describe("rules about the inside of a section on a section that was not cut", () => {
  const sections: Array<[number, number]> = [[0, 6], [6, 10], [10, 16]];
  const whole = { 1: "0-6:1 6-10:2 10-16:1" }; // every section one slice
  it("fails firstIsNew, sameSequence and sliceNotIn with n/a instead of passing", () => {
    const s = song(sections, whole);
    for (const rule of [
      { id: "r", kind: "firstIsNew", section: "b", against: ["a"], level: 1 },
      { id: "r", kind: "sameSequence", a: "a", b: "c", level: 1 },
      { id: "r", kind: "sliceNotIn", section: "b", slice: -1, against: ["a"], level: 1 },
    ]) {
      const r = run(s, rule);
      expect(r.pass).toBe(false);
      expect(r.detail).toBe("n/a: one slice");
    }
  });
  it("fails sameSequence when only one of the two sections is one slice", () => {
    const s = song(sections, { 1: "0-2:1 2-4:2 4-6:3 6-10:2 10-16:1" });
    expect(run(s, { id: "r", kind: "sameSequence", a: "a", b: "b", level: 1 }).detail).toBe("n/a: one slice");
  });
});

describe("scoreBaseline", () => {
  const bars = (labels: string[]) => labels.map((label, i) => ({ start: i * BAR, end: (i + 1) * BAR, label }));
  const base = (labels: string[]): Baseline => ({ song: "T", hash: "x", source: "other", bars: bars(labels) });
  const lanes = (l: string): SongLanes => song([[0, 6]], { 1: l });
  const ABCABC = ["A", "B", "C", "A", "B", "C"];

  it("keeps all pairs of A B C A B C against one 6-bar slice", () => {
    expect(scoreBaseline(base(ABCABC), lanes("0-6:1"), 1)).toMatchObject({ pairs: 3, kept: 3, broken: [] });
  });
  it("keeps all 3 against two 3-bar slices with one base, by bar offset", () => {
    expect(scoreBaseline(base(ABCABC), lanes("0-3:1 3-6:1"), 1)).toMatchObject({ pairs: 3, kept: 3 });
  });
  it("keeps 2 of 3 against six 1-bar slices 1 2 3 1 2 4", () => {
    const r = scoreBaseline(base(ABCABC), lanes("0-1:1 1-2:2 2-3:3 3-4:1 4-5:2 5-6:4"), 1);
    expect(r.pairs).toBe(3);
    expect(r.kept).toBe(2);
    expect(r.broken).toEqual([[2, 5]]);
  });
  it("keeps a pair whose slices share a base, whatever the offsets", () => {
    const r = scoreBaseline(base(["A", "x", "y", "z", "A", "w"]), lanes("0-3:1 3-6:1′"), 1);
    expect(r).toMatchObject({ pairs: 1, kept: 1 });
  });
  it("does not keep a pair whose slices have different bases", () => {
    const r = scoreBaseline(base(["A", "x", "y", "z", "A", "w"]), lanes("0-3:1 3-6:2"), 1);
    expect(r).toMatchObject({ pairs: 1, kept: 0 });
  });
  it("puts a bar whose midpoint is in no slice in no slice, not in the last one", () => {
    // the lane stops at bar 4: bars 4 and 5 are in none, so A(0) and A(5) are not grouped
    const r = scoreBaseline(base(["A", "x", "y", "z", "w", "A"]), song([[0, 4]], { 1: "0-4:1" }), 1);
    expect(r).toMatchObject({ pairs: 1, kept: 0, broken: [[0, 5]] });
  });
  it("forms no pair from a label with a prime or from a rest", () => {
    const r = scoreBaseline(base(["A′", "B", "A′", "B", ".", "."]), lanes("0-1:1 1-2:2 2-3:3 3-4:4 4-5:5 5-6:6"), 1);
    expect(r.pairs).toBe(1); // only B-B
  });
  it("pairs J+2 only with J+2", () => {
    const r = scoreBaseline(base(["J", "J+2", "J", "J+2"]), song([[0, 4]], { 1: "0-4:1" }), 1);
    expect(r.pairs).toBe(2);
  });
  it("uses the given level, and defaults to level 1", () => {
    const s = song([[0, 6]], { 1: "0-6:1", 2: "0-1:1 1-2:2 2-3:3 3-4:1 4-5:2 5-6:4" });
    expect(scoreBaseline(base(ABCABC), s).kept).toBe(3);
    expect(scoreBaseline(base(ABCABC), s, 2).kept).toBe(2);
  });
});

describe("scoreBaseline: wrong merges", () => {
  const bars = (labels: string[]) => labels.map((label, i) => ({ start: i * BAR, end: (i + 1) * BAR, label }));
  const base = (labels: string[]): Baseline => ({ song: "T", hash: "x", source: "other", bars: bars(labels) });
  it("counts same-offset bars of one base whose spike-2 labels differ", () => {
    // slices [A B] named 1 and [A C] named 1: the second bars at offset 1 are B and C
    const r = scoreBaseline(base(["A", "B", "A", "C"]), song([[0, 4]], { 1: "0-2:1 2-4:1" }), 1);
    expect(r.merges).toEqual({ n: 2, bad: 1 });
  });
  it("counts none for the same labels, a prime or a rest", () => {
    expect(scoreBaseline(base(["A", "B", "A", "B"]), song([[0, 4]], { 1: "0-2:1 2-4:1" }), 1).merges).toEqual({ n: 2, bad: 0 });
    expect(scoreBaseline(base(["A", "B′", "A", "."]), song([[0, 4]], { 1: "0-2:1 2-4:1" }), 1).merges).toEqual({ n: 1, bad: 0 });
  });
  it("fails the gate on a lane of 1-bar slices all named 1, though it keeps every pair", () => {
    const labels = ["A", "B", "C", "A", "B", "C", "D", "D", "D", "D", "B", "C"];
    const b = base(labels);
    const r = scoreBaseline(b, song([[0, 12]], { 1: labels.map((_, i) => `${i}-${i + 1}:1`).join(" ") }), 1);
    expect(r.kept).toBe(r.pairs);
    expect(r.merges.bad / r.merges.n).toBeGreaterThan(0.5);
    expect(formatScore([{ id: "ok", pass: true, detail: "" }], r, b).pass).toBe(false);
  });
});

describe("the real Kashmir fixture: a lane of whole phrases", () => {
  const b = JSON.parse(readFileSync(new URL("../../fixtures/patterns/kashmir-spike2.json", import.meta.url), "utf8")) as Baseline;
  /**
   * A lane of whole phrases, each slice named by its exact spike-2 sequence: `phrases` are tried in order at every bar, the
   * first that matches becomes one slice, and every other bar is its own slice.
   */
  function phraseLane(phrases: string[]): SongLanes {
    const names = new Map<string, number>();
    const slices: string[] = [];
    for (let i = 0; i < b.bars.length; ) {
      const at = (n: number) => b.bars.slice(i, i + n).map((x) => x.label).join(" ");
      const n = phrases.map((p) => p.split(" ").length).find((len, k) => at(len) === phrases[k]) ?? 1;
      const seq = at(n);
      if (!names.has(seq)) names.set(seq, names.size + 1);
      slices.push(`${i}-${i + n}:${seq === "." ? "." : names.get(seq)}`);
      i += n;
    }
    // the lane's own times are the fixture's bar times, not the 1.6 s grid
    const lane = slices.map((w, k) => {
      const m = /^(\d+)-(\d+):(.+)$/.exec(w) as RegExpExecArray;
      const label = m[3];
      return { start: b.bars[+m[1]].start, end: b.bars[+m[2] - 1].end, name: nameOf(label), label: label === "." ? null : label, cut: k === 0 ? null : { time: b.bars[+m[1]].start, owner: "machine" as const } };
    });
    return { durationSec: b.bars[b.bars.length - 1].end, sections: [{ start: 0, end: b.bars[b.bars.length - 1].end }], grid: [], levels: [lane, lane, lane, lane, lane] };
  }
  const gate = (phrases: string[]) => {
    const r = scoreBaseline(b, phraseLane(phrases));
    return { r, ...formatScore([{ id: "ok", pass: true, detail: "" }], r, b) };
  };
  it("passes the gate with A B C and D D D D as phrases (78 % kept), so phrases can reach it", () => {
    const { r, pass, text } = gate(["A B C", "D D D D"]);
    expect(r.kept / r.pairs).toBeCloseTo(0.781, 3);
    expect(r.merges.bad).toBe(0);
    expect(pass, text).toBe(true);
  });
  it("passes the gate with A B C A B C as one 6-bar phrase (72 % kept: its 1-bar leftovers are another base)", () => {
    const { r, pass, text } = gate(["A B C A B C", "D D D D"]);
    expect(r.kept / r.pairs).toBeCloseTo(0.721, 3);
    expect(r.merges.bad).toBe(0);
    expect(pass, text).toBe(true);
  });
});

describe("formatScore", () => {
  const ok = { id: "good", pass: true, detail: "fine" };
  const bad = { id: "bad", pass: false, detail: "broken" };
  const kashmir = (kept: number, pairs: number, broken: Array<[number, number]> = [], merges = { n: 100, bad: 0 }): BaselineScore => ({ pairs, kept, broken, merges });
  it("lists a line per rule, the Flim count, the Kashmir count and the wrong merges", () => {
    const { text, pass } = formatScore([ok, bad], kashmir(95, 100, [], { n: 40, bad: 3 }));
    expect(text).toContain("PASS good — fine");
    expect(text).toContain("FAIL bad — broken");
    expect(text).toContain("Flim: 1/2");
    expect(text).toContain("Kashmir: 95/100 pairs kept");
    expect(text).toContain("Kashmir merges: 3/40 wrong");
    expect(pass).toBe(false);
  });
  it("passes when every rule passes, 70 % of pairs are kept and at most 10 % of merges are wrong", () => {
    expect(formatScore([ok], kashmir(70, 100)).pass).toBe(true);
    expect(formatScore([ok], kashmir(69, 100)).pass).toBe(false);
    expect(formatScore([ok], kashmir(100, 100, [], { n: 50, bad: 5 })).pass).toBe(true);
    expect(formatScore([ok], kashmir(100, 100, [], { n: 50, bad: 6 })).pass).toBe(false);
  });
  it("lists a second key after the first, and passes only when its rules pass too, whatever its info rules say", () => {
    const info = { id: "hint", pass: false, detail: "far", info: true };
    const { text, pass } = formatScore([ok], kashmir(95, 100), undefined, [ok, info]);
    expect(text).toContain("INFO FAIL hint — far");
    expect(text).toContain("Flim v2: 1/1 (and 1 info)");
    expect(text.indexOf("Flim: 1/1")).toBeLessThan(text.indexOf("PASS good — fine", text.indexOf("Flim: 1/1")));
    expect(pass).toBe(true);
    expect(formatScore([ok], kashmir(95, 100), undefined, [bad, info]).pass).toBe(false);
  });
  it("lists the 10 bars in the most broken pairs, as m:ss.s label ×count", () => {
    const labels = Array.from({ length: 80 }, (_, i) => `L${i}`);
    const b: Baseline = { song: "T", hash: "x", source: "other", bars: labels.map((label, i) => ({ start: i * BAR, end: (i + 1) * BAR, label })) };
    // bar 65 is in 3 broken pairs, bar 2 in 2, bars 0 and 1 in 1 each; the 12 others in 1 each
    const broken: Array<[number, number]> = [[2, 65], [2, 66], [30, 65], [31, 65], ...Array.from({ length: 10 }, (_, i): [number, number] => [40 + i, 70 + i])];
    const lines = formatScore([ok], kashmir(0, 14, broken), b).text.split("\n").filter((l) => l.includes("×"));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("  1:44.0 L65 ×3");
    expect(lines[1]).toBe("  0:03.2 L2 ×2");
  });
});
