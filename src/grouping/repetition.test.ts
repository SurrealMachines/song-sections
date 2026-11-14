import { describe, expect, it } from "vitest";
import { ALLIN1_BAND_HZ, FEATURE_BANDS, FEATURE_RATE, STEM_NAMES, type StemFeatures, type StructureAnalysis } from "../structure/contract.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { cutEntries, periodEntry, periodZ, repeatCuts, repeatPlan, sectionRepeat, TAU_HI, TAU_LO, unitEntry, UNIT_FROM_G } from "./repetition.js";

/** A deterministic generator in [0, 1) (an LCG), so the noisy cases are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** The section-centred cosine similarity matrix of `rows`, as repetition.ts builds it for one stem. */
function simOf(rows: number[][]): Float64Array {
  const n = rows.length;
  const d = rows[0].length;
  const mean = Array.from({ length: d }, (_, k) => rows.reduce((t, r) => t + r[k], 0) / n);
  const x = rows.map((r) => {
    const c = r.map((v, k) => v - mean[k]);
    const norm = Math.hypot(...c);
    return norm > 0 ? c.map((v) => v / norm) : c;
  });
  const sim = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sim[i * n + j] = x[i].reduce((t, v, k) => t + v * x[j][k], 0);
  return sim;
}

/**
 * n downbeat vectors in 12 dimensions repeating `period` patterns, plus noise of size `noise`. The patterns are one
 * pitch class each (0, 3, 6, 9 …), so they are equally far apart; with `random`, random vectors instead.
 */
function periodic(n: number, period: number, noise: number, seed = 1, random = false): number[][] {
  const r = rng(seed);
  const patterns = Array.from({ length: period }, (_, p) => Array.from({ length: 12 }, (_, k) => (random ? r() : k === (3 * p) % 12 ? 1 : 0)));
  return Array.from({ length: n }, (_, i) => patterns[i % period].map((v) => v + noise * (r() - 0.5)));
}

describe("periodZ: how clearly pieces P downbeats apart repeat (fb2)", () => {
  it("finds a melody that repeats every 2 downbeats", () => {
    const sim = simOf(periodic(8, 2, 0.2));
    expect(periodZ(sim, 8, 2)!).toBeGreaterThan(3);
  });

  it("a period of 4 is not a period of 2: the halves of each piece differ", () => {
    const sim = simOf(periodic(16, 4, 0.2));
    expect(periodZ(sim, 16, 4)!).toBeGreaterThan(3);
    expect(periodZ(sim, 16, 2)!).toBeLessThan(TAU_LO);
  });

  it("a period of 2 also repeats at 4, but its own score is the higher", () => {
    const sim = simOf(periodic(16, 2, 0.2));
    expect(periodZ(sim, 16, 2)!).toBeGreaterThan(periodZ(sim, 16, 4)!);
  });

  it("random downbeats rarely pass TAU_LO, and never TAU_HI", () => {
    // TAU_LO is about the 95th percentile of the score on random downbeats (a simulation in the fb2 report).
    let passed = 0;
    let trials = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const sim = simOf(periodic(16, 16, 0, seed, true));
      for (const P of [2, 4, 8]) {
        const z = periodZ(sim, 16, P)!;
        expect(z, `seed ${seed}, P ${P}`).toBeLessThan(TAU_HI);
        trials++;
        if (z >= TAU_LO) passed++;
      }
    }
    expect(passed / trials).toBeLessThan(0.1);
  });

  it("needs two whole pieces, and some spread in the similarities", () => {
    const sim = simOf(periodic(7, 2, 0.2));
    expect(periodZ(sim, 7, 4)).toBeNull();
    expect(periodZ(sim, 7, 2)).not.toBeNull();
    expect(periodZ(new Float64Array(64), 8, 2)).toBeNull(); // every pair alike: nothing to tell apart
  });
});

describe("periodEntry and unitEntry: where on the Sections slider a score starts to split", () => {
  it("falls from just above the middle to the top as the score falls from TAU_HI to TAU_LO", () => {
    expect(periodEntry(TAU_HI)).toBe(0.5);
    expect(periodEntry(TAU_HI + 3)).toBe(0.5);
    expect(periodEntry(TAU_LO)).toBeCloseTo(1, 12);
    expect(periodEntry(TAU_LO - 0.01)).toBe(Infinity);
    const mid = periodEntry((TAU_HI + TAU_LO) / 2);
    expect(mid).toBeCloseTo(0.75, 12);
  });

  it("is lower for a higher score", () => {
    let last = -Infinity;
    for (let z = 6; z >= TAU_LO; z -= 0.25) {
      const e = periodEntry(z);
      expect(e).toBeGreaterThanOrEqual(last);
      last = e;
    }
  });

  it("one-downbeat pieces only at the very top", () => {
    expect(unitEntry(1)).toBe(UNIT_FROM_G);
    expect(unitEntry(0.5)).toBeGreaterThanOrEqual(UNIT_FROM_G);
    expect(unitEntry(0)).toBe(Infinity);
  });
});

describe("cutEntries: each cut's entry, from the periods' entries", () => {
  it("cuts at multiples of the period, the coarser period's cuts first when it scores higher", () => {
    // Period 4 enters at 0.55, period 2 at 0.6: the middle cut at 0.55, the quarter cuts at 0.6, no odd cuts.
    expect(cutEntries(8, { 2: 0.6, 4: 0.55 })).toEqual([Infinity, 0.6, Infinity, 0.55, Infinity, 0.6, Infinity]);
  });

  it("a finer period that enters first brings the coarser cuts with it", () => {
    expect(cutEntries(8, { 2: 0.6, 4: 0.7 })).toEqual([Infinity, 0.6, Infinity, 0.6, Infinity, 0.6, Infinity]);
  });

  it("at every g the cuts in are the multiples of one period from the section's first downbeat", () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(r() * 30);
      const entries = Object.fromEntries([1, 2, 4, 8].filter(() => r() < 0.7).map((P) => [P, 0.5 + r() / 2]));
      const e = cutEntries(n, entries);
      expect(e).toHaveLength(n - 1);
      for (let g = 0.5; g <= 1; g += 0.01) {
        const ks = e.flatMap((x, i) => (x <= g ? [i + 1] : []));
        if (ks.length === 0) continue;
        const P = ks[0];
        expect(ks, `n ${n}, g ${g.toFixed(2)}, ${JSON.stringify(entries)}`).toEqual(Array.from({ length: Math.floor((n - 1) / P) }, (_, m) => (m + 1) * P));
      }
    }
  });

  it("nothing for a one-downbeat section", () => {
    expect(cutEntries(1, { 1: 0.9 })).toEqual([]);
  });
});

// A synthetic clip: 2 s downbeats, two sections [0, 32) and [32, 64). The "other" stem plays a two-downbeat melody in
// the first (pitch class 0 then 7), and a different random pitch class on each downbeat in the second.
const D = 64;
const DB = Array.from({ length: 33 }, (_, i) => 2 * i);
const pcOf = ALLIN1_BAND_HZ.map((hz) => (((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12));

/** Bands playing pitch class pcAt(downbeat index) over a little noise. */
function bandsOf(pcAt: (k: number) => number, seed: number): number[][] {
  const r = rng(seed);
  return Array.from({ length: Math.ceil(D * FEATURE_RATE) }, (_, f) => {
    const pc = pcAt(Math.floor(f / FEATURE_RATE / 2));
    return Array.from({ length: FEATURE_BANDS }, (_, b) => (ALLIN1_BAND_HZ[b] >= 55 && pcOf[b] === pc ? 1 : 0.05 + 0.05 * r()));
  });
}

function synthetic(): StructureAnalysis {
  const base = fakeStructureAnalysis(D);
  const r = rng(3);
  const randomPc = Array.from({ length: 32 }, () => Math.floor(r() * 12));
  const frames = Math.ceil(D * FEATURE_RATE);
  const bands = bandsOf((k) => (k < 16 ? (k % 2 === 0 ? 0 : 7) : randomPc[k]), 4);
  const silent: StemFeatures = { bands: Array.from({ length: frames }, () => new Array<number>(FEATURE_BANDS).fill(0)), loudnessDb: new Array<number>(frames).fill(-100), peak: [] };
  const stems = Object.fromEntries(STEM_NAMES.map((s) => [s, silent])) as StructureAnalysis["stems"];
  stems.other = { bands, loudnessDb: new Array<number>(frames).fill(-12), peak: [] };
  return {
    ...base,
    durationSec: D,
    frames,
    segments: [
      { start: 0, end: 32, label: "intro" },
      { start: 32, end: D, label: "verse" },
    ],
    downbeats: DB,
    beats: DB,
    stems,
  };
}

describe("repeatCuts: repetition splits for the top half of More (fb2)", () => {
  const a = synthetic();

  it("cuts a section with a two-downbeat melody every 2 downbeats from its first, well before the top", () => {
    const cuts = repeatCuts(a, "other", DB, [32], D);
    const inFirst = cuts.filter((c) => c.time < 32);
    const early = inFirst.filter((c) => c.entry <= 0.8).map((c) => c.time);
    expect(early).toEqual([4, 8, 12, 16, 20, 24, 28]);
  });

  it("does not split the section without repetition below the top", () => {
    const cuts = repeatCuts(a, "other", DB, [32], D);
    expect(cuts.filter((c) => c.time > 32 && c.entry < UNIT_FROM_G)).toEqual([]);
  });

  it("Group by All uses the audible stems: here only Other, so the same cuts", () => {
    const early = (by: "all" | "other") => repeatCuts(a, by, DB, [32], D).filter((c) => c.time < 32 && c.entry <= 0.8).map((c) => c.time);
    expect(early("all")).toEqual(early("other"));
  });

  it("Group by All takes, per section, the stem that repeats most clearly (controller ruling, fb2)", () => {
    // Bass, as loud as Other: random notes in the first section, a four-downbeat riff in the second.
    const r = rng(9);
    const random = Array.from({ length: 32 }, () => Math.floor(r() * 12));
    const bass = bandsOf((k) => (k < 16 ? random[k] : [2, 5, 9, 11][k % 4]), 5);
    const both = { ...a, stems: { ...a.stems, bass: { bands: bass, loudnessDb: a.stems.other.loudnessDb, peak: [] } } };
    expect(sectionRepeat(both, "all", DB, 0, 32, D)!.stem).toBe("other");
    expect(sectionRepeat(both, "all", DB, 32, D, D)!.stem).toBe("bass");
    const early = repeatCuts(both, "all", DB, [32], D).filter((c) => c.entry <= 0.8).map((c) => c.time);
    expect(early).toEqual([4, 8, 12, 16, 20, 24, 28, 40, 48, 56]);
  });

  it("one-downbeat pieces only come in once the section splits at two downbeats (controller ruling, fb2)", () => {
    for (const [from, to] of [[0, 32], [32, D]]) {
      const r = sectionRepeat(a, "other", DB, from, to, D)!;
      expect(r.entries[1] ?? Infinity, `${from}`).toBeGreaterThanOrEqual(r.entries[2] ?? Infinity);
    }
    // A held chord in the first section: alike at every downbeat, much more than like the rest of the song, so
    // homogeneous enough for P = 1 on its own; but no two-downbeat repeat, so never cut.
    const r = rng(11);
    const random = Array.from({ length: 32 }, () => Math.floor(r() * 12));
    const held = { ...a, stems: { ...a.stems, other: { ...a.stems.other, bands: bandsOf((k) => (k < 16 ? 4 : random[k]), 6) } } };
    expect(unitEntry(sectionRepeat(held, "other", DB, 0, 32, D)!.z[1]!)).toBeLessThanOrEqual(1);
    expect(repeatCuts(held, "other", DB, [32], D).filter((c) => c.time < 32)).toEqual([]);
  });

  it("Group by All leaves drums out, however clearly they repeat; Group by Drums scores them (controller ruling, fb2)", () => {
    // Drums alone, with a two-downbeat pattern in both sections; Other silent.
    const drums = bandsOf((k) => (k % 2 === 0 ? 0 : 7), 8).map((row, f) => row.map((v, b) => v + (b < 20 && Math.floor(f / 4) % 2 === 0 ? 1 : 0)));
    const loud = a.stems.other.loudnessDb;
    const silentOther = { bands: a.stems.vocals.bands, loudnessDb: a.stems.vocals.loudnessDb, peak: [] };
    const beat = { ...a, stems: { ...a.stems, other: silentOther, drums: { bands: drums, loudnessDb: loud, peak: [] } } };
    expect(repeatCuts(beat, "drums", DB, [32], D).filter((c) => c.entry <= 0.8).length).toBeGreaterThan(0);
    expect(repeatCuts(beat, "all", DB, [32], D)).toEqual([]);
    expect(sectionRepeat(beat, "all", DB, 0, 32, D)).toBeNull();
  });

  it("a silent stem gives no cuts", () => {
    expect(repeatCuts(a, "vocals", DB, [32], D)).toEqual([]);
    expect(repeatCuts(a, "drums", DB, [32], D)).toEqual([]);
  });

  it("no grid, no cuts", () => {
    expect(repeatCuts(a, "other", [], [32], D)).toEqual([]);
  });

  it("counts from the downbeat nearest the section's start, and cuts on downbeats only", () => {
    const cuts = repeatCuts(a, "other", DB, [32.03], D); // allin1's boundary a few ms off its downbeat
    for (const c of cuts) expect(DB).toContain(c.time);
    const early = cuts.filter((c) => c.time < 32 && c.entry <= 0.8).map((c) => c.time);
    expect(early).toEqual([4, 8, 12, 16, 20, 24, 28]);
  });
});

describe("repeatPlan: the base correction (controller ruling, fb2)", () => {
  // Other plays an eight-downbeat melody (eight different notes) over [0, 32), random notes after.
  const a = synthetic();
  const r = rng(13);
  const random = Array.from({ length: 32 }, () => Math.floor(r() * 12));
  const eight = { ...a, stems: { ...a.stems, other: { ...a.stems.other, bands: bandsOf((k) => (k < 16 ? [0, 3, 6, 9, 1, 4, 7, 10][k % 8] : random[k]), 14) } } };

  it("moves a weak boundary inside a repeat onto the merged span's period, from the first step above the middle", () => {
    // allin1's weak boundary at 18 s (downbeat 9) hides the period: neither [0, 18) nor [18, 32) is two of them long.
    const plan = repeatPlan(eight, "other", DB, [18, 32], D, [18]);
    expect(plan.drop).toEqual([18]);
    expect(plan.cuts).toContainEqual({ time: 16, entry: 0.5 }); // one downbeat back, onto the period
    expect(plan.cuts.filter((c) => c.time === 16)).toHaveLength(1);
  });

  it("drops it when the period's nearest cut is more than 2 downbeats away", () => {
    const plan = repeatPlan(eight, "other", DB, [22, 32], D, [22]); // downbeat 11: the nearest cut, 8, is 3 away
    expect(plan.drop).toEqual([22]);
    // What is left in [0, 32) is the merged span's own period cut (16 s), not a moved boundary.
    expect(plan.cuts.filter((c) => c.time < 32).map((c) => c.time)).toEqual([16]);
  });

  it("leaves strong boundaries, and weak ones with no clearer repeat across them, alone", () => {
    expect(repeatPlan(eight, "other", DB, [18, 32], D, []).drop).toEqual([]); // 18 not weak
    expect(repeatPlan(eight, "other", DB, [18, 32], D, [32]).drop).toEqual([]); // 32: random notes on one side
  });

  it("a weak boundary off the phase of a repeat that runs across it moves onto the phase; one on it stays put", () => {
    // The two-downbeat melody over [0, 32): 14 s is downbeat 7, mid-phrase; 16 s is on a phrase start.
    const off = repeatPlan(a, "other", DB, [14, 32], D, [14]);
    expect(off.drop).toEqual([14]);
    expect(off.cuts.filter((c) => c.entry === 0.5).map((c) => c.time)).toContain(12);
    const on = repeatPlan(a, "other", DB, [16, 32], D, [16]);
    expect(on.cuts.filter((c) => c.entry === 0.5).map((c) => c.time)).toContain(16);
  });

  it("a weak boundary between two parts too short to score stays unless the merged span repeats at TAU_HI (review M1)", () => {
    // [0, 12) is six downbeats, cut at 6 s into 3 + 3: neither part can be scored. The merged span half-repeats
    // (2 1 0 9 0 9), which scores about 2.6 at P = 2: within chance, so the boundary stays.
    const pat = [2, 1, 0, 9, 0, 9];
    const r6 = rng(5);
    const rest = Array.from({ length: 32 }, () => Math.floor(r6() * 12));
    const short = { ...a, stems: { ...a.stems, other: { ...a.stems.other, bands: bandsOf((k) => (k < 6 ? pat[k] : rest[k]), 4) } } };
    const merged = sectionRepeat(short, "other", DB, 0, 12, D)!;
    expect(merged.z[2]!).toBeGreaterThan(TAU_LO);
    expect(merged.z[2]!).toBeLessThan(TAU_HI);
    expect(repeatPlan(short, "other", DB, [6, 12, 32], D, [6]).drop).toEqual([]);
  });

  it("without weak boundaries, its cuts are repeatCuts'", () => {
    expect(repeatPlan(a, "other", DB, [32], D)).toEqual({ drop: [], cuts: repeatCuts(a, "other", DB, [32], D) });
  });
});

describe("Group by Melody (controller ruling, fb2)", () => {
  // Vocals carry a two-downbeat melody over [0, 32); Other is silent there.
  const base = synthetic();
  const vocalsLead = {
    ...base,
    stems: {
      ...base.stems,
      vocals: base.stems.other,
      other: { ...base.stems.vocals },
    },
  };

  it("repeats on the vocals and other summed: here the vocals", () => {
    const early = repeatCuts(vocalsLead, "melody", DB, [32], D).filter((c) => c.time < 32 && c.entry <= 0.8).map((c) => c.time);
    expect(early).toEqual([4, 8, 12, 16, 20, 24, 28]);
    expect(sectionRepeat(vocalsLead, "melody", DB, 0, 32, D)!.stem).toBe("melody");
  });

  it("is silent only where both vocals and other are", () => {
    const silent = { ...base, stems: { ...base.stems, other: { ...base.stems.vocals } } };
    expect(sectionRepeat(silent, "melody", DB, 0, 32, D)).toBeNull();
  });
});
