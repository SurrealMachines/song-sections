import { describe, expect, it } from "vitest";
import { MIN_SECTION_SEC } from "../core/sections.js";
import type { BoundaryCandidate } from "../structure/contract.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { CANDIDATE_FLOOR, granularBoundaries, repeatOrder, type RepeatCut } from "./granularity.js";
import { snapBoundaries } from "./snap.js";

// allin1 chose 20, 40, 60 (strengths 0.9, 0.5, 0.7); the other candidates are weaker.
const CHOSEN = [20, 40, 60];
const CANDS: BoundaryCandidate[] = [
  { time: 10, strength: 0.3 },
  { time: 20, strength: 0.9 },
  { time: 30, strength: 0.05 },
  { time: 40, strength: 0.5 },
  { time: 50, strength: 0.2 },
  { time: 60, strength: 0.7 },
  { time: 70, strength: 0.4 },
  { time: 75, strength: 0.01 },
];
const D = 80;
const run = (g: number, floor = 0.1) => granularBoundaries(CHOSEN, CANDS, g, D, floor);

describe("granularBoundaries (the Sections slider, feedback round 1)", () => {
  it("is allin1's own boundaries at 0", () => {
    expect(run(0)).toEqual(CHOSEN);
  });

  it("Fewer drops allin1's boundaries weakest first, round(|g| × count) of them", () => {
    expect(run(-0.1)).toEqual(CHOSEN); // round(0.3) = 0
    expect(run(-0.34)).toEqual([20, 60]); // 1: the 0.5 one
    expect(run(-0.5)).toEqual([20]); // round(1.5) = 2: then the 0.7 one
    expect(run(-0.9)).toEqual([]);
  });

  it("at -1 the clip is one section", () => {
    expect(run(-1)).toEqual([]);
  });

  it("More's bottom half adds the strongest other candidates above the floor, round(2g × eligible) of them", () => {
    // Eligible (>= 0.1, not chosen): 70 (0.4), 10 (0.3), 50 (0.2). 30 (0.05) and 75 (0.01) are under the floor.
    expect(run(0.05)).toEqual(CHOSEN); // round(0.3) = 0
    expect(run(0.17)).toEqual([20, 40, 60, 70]); // round(1.02) = 1
    expect(run(0.25)).toEqual([10, 20, 40, 60, 70]); // round(1.5) = 2
    expect(run(0.5)).toEqual([10, 20, 40, 50, 60, 70]); // all of them
  });

  it("the top half adds no candidates: the weak ones (under the floor) are not used (feedback round 2)", () => {
    expect(run(0.75)).toEqual(run(0.5));
    expect(run(1)).toEqual([10, 20, 40, 50, 60, 70]);
  });

  it("a lower floor makes more candidates eligible", () => {
    expect(run(1, 0)).toEqual([10, 20, 30, 40, 50, 60, 70, 75]);
  });

  it("adds through addBoundary, so no section is shorter than MIN_SECTION_SEC", () => {
    const close: BoundaryCandidate[] = [...CANDS, { time: 20.5, strength: 0.8 }, { time: 79.6, strength: 0.8 }];
    const out = granularBoundaries(CHOSEN, close, 1, D, 0.1);
    expect(out).not.toContain(20.5);
    expect(out).not.toContain(79.6);
    const edges = [0, ...out, D];
    for (let i = 1; i < edges.length; i++) expect(edges[i] - edges[i - 1]).toBeGreaterThanOrEqual(MIN_SECTION_SEC);
  });

  it("a chosen boundary without a candidate counts as the weakest", () => {
    expect(granularBoundaries([20, 33, 60], CANDS, -0.34, D, 0.1)).toEqual([20, 60]);
  });

  it("is ascending and leaves the inputs alone", () => {
    const chosen = [...CHOSEN];
    const cands = CANDS.map((c) => ({ ...c }));
    for (const g of [-1, -0.5, 0, 0.5, 1]) {
      const out = granularBoundaries(chosen, cands, g, D, 0.1);
      expect([...out].sort((a, b) => a - b)).toEqual(out);
    }
    expect(chosen).toEqual(CHOSEN);
    expect(cands).toEqual(CANDS);
  });

  it("grows monotonically with g on the fake analysis", () => {
    const a = fakeStructureAnalysis(180);
    const chosen = a.segments.slice(1).map((s) => s.start);
    let last = -1;
    for (let g = -1; g <= 1.0001; g += 0.05) {
      const n = granularBoundaries(chosen, a.boundaryCandidates, g, a.durationSec, CANDIDATE_FLOOR).length;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    // The fake's other candidates are all under the floor, so only a repetition source adds anything.
    const halves = (b: number[]) => [0, ...b].map((t, i) => ({ time: (t + ([...b, a.durationSec][i])) / 2, entry: 0.7 }));
    expect(granularBoundaries(chosen, a.boundaryCandidates, 1, a.durationSec, CANDIDATE_FLOOR, [], [], (b) => ({ drop: [], cuts: halves(b) })).length).toBeGreaterThan(chosen.length);
  });
});

// A bar every 2 s (120 bpm 4/4), from 0.
const BARS = Array.from({ length: 101 }, (_, i) => 2 * i);
const bars = (n: number) => 2 * n;

describe("granularBoundaries with repetition splits (feedback round 2)", () => {
  // allin1 chose one boundary at 8 bars in a 40-bar clip; no other candidates. The repetition source cuts [8, 40] at
  // 4 bars from 0.6 and at 2 bars from 0.8, and [0, 8] at 4 bars from 0.9.
  const chosen = [bars(8)];
  const cands: BoundaryCandidate[] = [{ time: bars(8), strength: 0.5 }];
  const CUTS: RepeatCut[] = [
    ...[12, 16, 20, 24, 28, 32, 36].map((b) => ({ time: bars(b), entry: 0.6 })),
    ...[10, 14, 18, 22, 26, 30, 34, 38].map((b) => ({ time: bars(b), entry: 0.8 })),
    { time: bars(4), entry: 0.9 },
  ];
  let seen: number[][] = [];
  const repeat = (base: number[]) => (seen.push(base), { drop: [], cuts: CUTS });
  const at = (g: number) => granularBoundaries(chosen, cands, g, bars(40), 0, BARS, [], repeat);

  it("adds nothing up to g = 0.5, then each cut from its entry", () => {
    expect(at(0.5)).toEqual(chosen);
    expect(at(0.59)).toEqual(chosen);
    expect(at(0.6)).toEqual([8, 12, 16, 20, 24, 28, 32, 36].map(bars));
    expect(at(0.85)).toEqual([8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38].map(bars));
    expect(at(1)).toContain(bars(4));
  });

  it("asks for the cuts of the g = 0.5 boundaries", () => {
    seen = [];
    granularBoundaries([20], [{ time: 20, strength: 0.5 }, { time: 50, strength: 0.3 }], 0.7, 80, 0.1, BARS, [], repeat);
    expect(seen).toEqual([[20, 50]]);
  });

  it("without a repetition source the top half adds nothing", () => {
    expect(granularBoundaries(chosen, cands, 1, bars(40), 0, BARS)).toEqual(chosen);
  });

  it("passes allin1's boundaries under the floor as weak, and drops what the plan drops, from the first step above 0.5", () => {
    // allin1 chose 8 bars (strong) and 20 bars (0.005, weak); the plan drops 20 bars and moves it to 22 (entry 0.5).
    const own = [bars(8), bars(20)];
    const cs: BoundaryCandidate[] = [{ time: bars(8), strength: 0.5 }, { time: bars(20), strength: 0.005 }];
    const weakSeen: number[][] = [];
    const plan = (_: number[], weak: number[]) => (weakSeen.push(weak), { drop: [bars(20)], cuts: [{ time: bars(22), entry: 0.5 }, { time: bars(30), entry: 0.8 }] });
    const at = (g: number) => granularBoundaries(own, cs, g, bars(40), 0.015, BARS, [], plan);
    expect(at(0.5)).toEqual(own);
    expect(at(0.51)).toEqual([bars(8), bars(22)]);
    expect(at(0.8)).toEqual([bars(8), bars(22), bars(30)]);
    expect(weakSeen.every((w) => w.length === 1 && w[0] === bars(20))).toBe(true);
    // The one exception to "only adds" is the step across the middle: above it, each step keeps the last.
    let prev = at(0.51);
    for (let g = 0.52; g <= 1.0001; g += 0.01) {
      const out = at(g);
      for (const t of prev) expect(out).toContain(t);
      prev = out;
    }
  });

  it("repeatOrder takes the cuts in by entry, then time: a prefix of one order", () => {
    const cuts: RepeatCut[] = [
      { time: 30, entry: 0.7 },
      { time: 10, entry: 0.7 },
      { time: 20, entry: 0.55 },
      { time: 5, entry: 0.95 },
    ];
    expect(repeatOrder(cuts, 0.5)).toEqual([]);
    expect(repeatOrder(cuts, 0.7)).toEqual([20, 10, 30]);
    expect(repeatOrder(cuts, 1)).toEqual([20, 10, 30, 5]);
    for (let g = 0.5; g < 1; g += 0.01) expect(repeatOrder(cuts, 1).slice(0, repeatOrder(cuts, g).length)).toEqual(repeatOrder(cuts, g));
  });

  it("never removes a boundary as g grows: each step's result contains the previous one, snapped or not", () => {
    // Cuts that crowd each other and the candidates: 0.3 and 0.4 s off bar lines, two 0.9 s apart, one on the edge.
    const crowd: RepeatCut[] = [
      { time: bars(30) + 0.3, entry: 0.6 },
      { time: bars(12) + 0.4, entry: 0.62 },
      { time: bars(25) + 0.2, entry: 0.7 },
      { time: bars(25) + 1.1, entry: 0.71 },
      { time: bars(8) + 0.5, entry: 0.8 },
      ...CUTS,
    ];
    for (const snapGrid of [BARS, []]) {
      let prev: number[] = [];
      for (let g = 0; g <= 1.0001; g += 0.01) {
        const out = granularBoundaries(chosen, cands, g, bars(40), 0.015, BARS, snapGrid, () => ({ drop: [], cuts: crowd }));
        for (const t of prev) expect(out, `snap ${snapGrid.length > 0}, g ${g.toFixed(2)} keeps ${t}`).toContain(t);
        prev = out;
      }
      expect(prev.length).toBeGreaterThan(8);
      // No added boundary leaves a section under a bar (2 s), measured where snapping puts it.
      const img = snapBoundaries(prev, snapGrid, bars(40));
      expect(img).toHaveLength(prev.length);
      const edges = [0, ...img, bars(40)];
      for (let i = 1; i < edges.length; i++) expect(edges[i] - edges[i - 1]).toBeGreaterThanOrEqual(2 - 1e-9);
    }
  });

  it("skips an addition that would leave a section under one bar after snapping (controller ruling: no slivers)", () => {
    const c = (time: number): BoundaryCandidate[] => [{ time: bars(8), strength: 0.5 }, { time, strength: 0.3 }];
    const add = (time: number, snapGrid: number[] = BARS) => granularBoundaries([bars(8)], c(time), 0.5, bars(40), 0.015, BARS, snapGrid);
    expect(add(bars(8) + 0.9)).toEqual([bars(8)]); // snaps onto the chosen boundary's bar line
    expect(add(bars(8) + 1.2)).toEqual([bars(8), bars(8) + 1.2]); // snaps one bar on: a whole bar, kept
    expect(add(bars(40) - 0.8)).toEqual([bars(8)]); // snaps onto the clip end
    // Snap off: the raw time against the bar length.
    expect(add(bars(8) + 1.5, [])).toEqual([bars(8)]);
    expect(add(bars(8) + 2.5, [])).toEqual([bars(8), bars(8) + 2.5]);
    // The same for a repetition cut.
    const cut = (time: number) => granularBoundaries([bars(8)], c(bars(8)), 1, bars(40), 0.015, BARS, BARS, () => ({ drop: [], cuts: [{ time, entry: 0.6 }] }));
    expect(cut(bars(8) + 0.9)).toEqual([bars(8)]);
    expect(cut(bars(10))).toEqual([bars(8), bars(10)]);
  });

  it("with no grid at all the limit is 2 s", () => {
    const c: BoundaryCandidate[] = [{ time: 10, strength: 0.5 }, { time: 11.5, strength: 0.3 }, { time: 14.5, strength: 0.2 }];
    expect(granularBoundaries([10], c, 0.5, 40, 0.015, [], [])).toEqual([10, 14.5]);
  });

  it("leaves allin1's own boundaries alone, however close (g <= 0)", () => {
    const own = [10, 10.5, 30];
    expect(granularBoundaries(own, [], 0, 40, 0.015, BARS, BARS)).toEqual(own);
    expect(granularBoundaries(own, [], 0.5, 40, 0.015, BARS, BARS)).toEqual(own);
  });
});
