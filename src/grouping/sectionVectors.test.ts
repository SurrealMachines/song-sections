import { describe, expect, it } from "vitest";
import { FEATURE_BANDS, STEM_NAMES, type StemName, type StructureAnalysis } from "../structure/contract.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { SILENT_DB, groupSections } from "./letters.js";
import { melodyVariant, sectionFrames, sectionLoudness, sectionVectors } from "./sectionVectors.js";

const cos = (a: Float64Array, b: Float64Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("sectionFrames", () => {
  const a = fakeStructureAnalysis(180);
  it("floors the start and ceils the end", () => {
    expect(sectionFrames(a, 1.2, 3.1)).toEqual([2, 7]);
  });
  it("covers at least one frame for a 0.6 s span", () => {
    const [f, t] = sectionFrames(a, 10.1, 10.7);
    expect(t - f).toBeGreaterThanOrEqual(1);
  });
  it("covers one frame for an empty or sub-frame span (the max(from + 1, ...) rule)", () => {
    expect(sectionFrames(a, 10, 10)).toEqual([20, 21]);
    expect(sectionFrames(a, 10.1, 10.2)).toEqual([20, 21]);
  });
  it("clamps to [0, frames]", () => {
    expect(sectionFrames(a, -5, 1000)).toEqual([0, a.frames]);
  });
});

describe("sectionLoudness", () => {
  it("is the power mean in dB", () => {
    const a = fakeStructureAnalysis(10);
    a.stems.bass.loudnessDb.fill(-100);
    a.stems.bass.loudnessDb[2] = 0;
    a.stems.bass.loudnessDb[3] = -100;
    // frames 2 and 3: mean power 0.5 -> -3.0103 dB
    expect(sectionLoudness(a, "bass", 1, 2)).toBeCloseTo(10 * Math.log10(0.5), 6);
  });
});

// A StructureAnalysis with chosen band centres and band values, built on the fake's shape. All frames are -12 dB.
function custom(frames: number, bandHz: number[], bands: (stem: StemName, f: number) => number[]): StructureAnalysis {
  const a = fakeStructureAnalysis(frames / 2);
  a.bandHz = bandHz;
  for (const s of STEM_NAMES) {
    a.stems[s] = { bands: Array.from({ length: frames }, (_, f) => bands(s, f)), loudnessDb: new Array<number>(frames).fill(-12), peak: a.stems[s].peak };
  }
  return a;
}
const bandsWith = (v: Record<number, number>) => Array.from({ length: FEATURE_BANDS }, (_, b) => v[b] ?? 0);
// Band 0 sits at 50 Hz (below the chroma floor), band 1 at 440 Hz (pitch class 0), band 2 a fifth up (pitch class 7).
const HZ = Array.from({ length: FEATURE_BANDS }, (_, b) => [50, 440, 440 * 2 ** (7 / 12)][b] ?? 20);
const WHOLE = [{ start: 0, end: 100 }];

describe("sectionVectors formulas, pinned on hand-built analyses", () => {
  it("uses 10^band - 1 for chroma energy (not the raw log value)", () => {
    const a = custom(4, HZ, () => bandsWith({ 1: 1, 2: 2 }));
    const v = sectionVectors(a, WHOLE, "other")[0]!;
    expect(v[7] / v[0]).toBeCloseTo(99 / 9, 9);
  });

  it("ignores bands below 55 Hz and counts 440 Hz", () => {
    const a = custom(4, HZ, () => bandsWith({ 0: 3, 1: 1 }));
    const v = sectionVectors(a, WHOLE, "other")[0]!;
    expect(v[10]).toBe(0); // 50 Hz would land in pitch class 10
    expect(v[0]).toBeGreaterThan(0);
  });

  it("L2-normalises chroma per frame before averaging", () => {
    // Frame 0 has energy 9 in pc 0, frame 1 has 99 in pc 7. Per-frame L2 makes both unit, so the mean is balanced.
    const a = custom(2, HZ, (_, f) => bandsWith(f === 0 ? { 1: 1 } : { 2: 2 }));
    const v = sectionVectors(a, WHOLE, "other")[0]!;
    expect(v[0] / v[7]).toBeCloseTo(1, 9);
  });

  it("scales timbre by 0.5 / sqrt(81) of the population z-score", () => {
    // Band 1 (440 Hz) is 1 in frame 0 and 0 in frame 1: mean 0.5, population sigma 0.5, so z = +1 in frame 0.
    // Section = frame 0 only: chroma is [1 at pc 0]; timbre at band 1 is 0.5 * 1 / 9.
    const a = custom(2, HZ, (_, f) => bandsWith(f === 0 ? { 1: 1 } : {}));
    const v = sectionVectors(a, [{ start: 0, end: 0.5 }], "other")[0]!;
    expect(v[12 + 1] / v[0]).toBeCloseTo(0.5 / 9, 9);
  });

  it("has zero chroma for drums and a unit vector from timbre alone", () => {
    const a = custom(2, HZ, (_, f) => bandsWith(f === 0 ? { 1: 1 } : {}));
    const v = sectionVectors(a, [{ start: 0, end: 0.5 }], "drums")[0]!;
    expect([...v.slice(0, 12)].every((x) => x === 0)).toBe(true);
    expect(Math.hypot(...v)).toBeCloseTo(1, 9);
  });
});

describe('"all" gives silent stems zeros', () => {
  // Two spans identical in drums, bass and other. In span 2 the vocals are silent (-90 dB) but their bands differ from span 1's.
  const frames = 40;
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pattern = Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => Array.from({ length: FEATURE_BANDS }, () => 3 * rand())));
  const noise = Array.from({ length: frames }, () => Array.from({ length: FEATURE_BANDS }, () => 3 * rand()));
  const first = (f: number) => (f >= 4 && f < 12 ? f - 4 : -1); // span 1: seconds 2-6
  const second = (f: number) => (f >= 16 && f < 24 ? f - 16 : -1); // span 2: seconds 8-12
  const a = custom(frames, Array.from({ length: FEATURE_BANDS }, (_, b) => 65 * 2 ** (b / 12)), (s, f) => {
    const k = STEM_NAMES.indexOf(s);
    const i = first(f) >= 0 ? first(f) : second(f);
    if (i < 0) return noise[f];
    if (s === "vocals" && second(f) >= 0) return pattern[(k + 1) % 4][(i + 3) % 8];
    return pattern[k][i];
  });
  for (let f = 16; f < 24; f++) a.stems.vocals.loudnessDb[f] = -90;
  const spans = [{ start: 2, end: 6 }, { start: 8, end: 12 }];

  it("gives identical spans cosine 1 in every stem the two share", () => {
    for (const s of ["drums", "bass", "other"] as const) {
      const [x, y] = sectionVectors(a, spans, s);
      expect(x!.reduce((t, v, i) => t + v * y![i], 0)).toBeCloseTo(1, 9);
    }
  });

  it("is null for the silent vocals in span 2 only", () => {
    const [x, y] = sectionVectors(a, spans, "vocals");
    expect(x).not.toBeNull();
    expect(y).toBeNull();
  });

  it("gives cosine sqrt(3)/2: three shared unit blocks of four against three of three, silent stem contributing zeros", () => {
    const [x, y] = sectionVectors(a, spans, "all");
    expect(x!.reduce((t, v, i) => t + v * y![i], 0)).toBeCloseTo(Math.sqrt(3) / 2, 9);
  });
});

describe("SILENT_DB", () => {
  const at = (db: number) => {
    const a = custom(4, HZ, () => bandsWith({ 1: 1 }));
    for (const s of STEM_NAMES) a.stems[s].loudnessDb.fill(db);
    return a;
  };
  it("keeps a section just above SILENT_DB and drops one just below (single stem and all)", () => {
    for (const g of ["other", "all"] as const) {
      expect(sectionVectors(at(SILENT_DB + 0.5), WHOLE, g)[0]).not.toBeNull();
      expect(sectionVectors(at(SILENT_DB - 0.5), WHOLE, g)[0]).toBeNull();
    }
  });
});

describe("sectionVectors on the fake analysis", () => {
  const a = fakeStructureAnalysis(180);
  const spans = a.segments;

  it("is null for vocals where the vocals are silent", () => {
    const v = sectionVectors(a, spans, "vocals");
    for (const i of [0, 1, 8, 9]) expect(v[i]).toBeNull();
    for (const i of [2, 3, 4, 5, 6, 7]) expect(v[i]).not.toBeNull();
  });

  it('has no nulls for "all"', () => {
    expect(sectionVectors(a, spans, "all").every((v) => v !== null)).toBe(true);
  });

  it("gives identical verses cosine 1 for other", () => {
    const v = sectionVectors(a, spans, "other");
    expect(cos(v[2]!, v[4]!)).toBeCloseTo(1, 9);
  });

  it("returns unit vectors without NaNs, including drums (no chroma)", () => {
    for (const g of ["all", ...STEM_NAMES] as const) {
      for (const v of sectionVectors(a, spans, g)) {
        if (!v) continue;
        expect(v.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...v)).toBeCloseTo(1, 9);
      }
    }
  });

  it("separates the letters in drums-only grouping too (choruses have more bass energy)", () => {
    const g = groupSections(sectionVectors(a, spans, "drums"));
    expect(g[3].group).toBe(g[5].group);
    expect(g[2].group).not.toBe(g[3].group);
  });

  it("gives an out-of-range span a null vector instead of throwing", () => {
    expect(sectionVectors(a, [{ start: 500, end: 510 }], "all")).toEqual([null]);
  });
});

describe("running sums", () => {
  it("give the same loudness and vectors as summing the frames directly, on a long clip", () => {
    const a = fakeStructureAnalysis(1200);
    const spans = [
      { start: 0, end: 2 },
      { start: 2, end: 333.3 },
      { start: 333.3, end: 334 },
      { start: 700, end: 1200 },
    ];
    for (const stem of STEM_NAMES) {
      for (const { start, end } of spans) {
        const [from, to] = sectionFrames(a, start, end);
        let sum = 0;
        for (let f = from; f < to; f++) sum += Math.pow(10, a.stems[stem].loudnessDb[f] / 10);
        expect(sectionLoudness(a, stem, start, end)).toBeCloseTo(10 * Math.log10(sum / (to - from)), 9);
      }
    }
    // Vectors are unit length (or null) and do not depend on the order spans are asked for in.
    const forward = sectionVectors(a, spans, "all");
    const backward = sectionVectors(a, [...spans].reverse(), "all").reverse();
    forward.forEach((v, i) => {
      if (!v) return expect(backward[i]).toBeNull();
      expect(Math.hypot(...v)).toBeCloseTo(1, 9);
      v.forEach((x, k) => expect(x).toBeCloseTo(backward[i]![k], 12));
    });
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("speed", () => {
  it("groups 60 sections of a 10-minute analysis in under 50 ms", () => {
    const spans = Array.from({ length: 60 }, (_, i) => ({ start: i * 10, end: (i + 1) * 10 }));
    // Each run uses a fresh analysis (cold cache). Best of 3 so a busy box does not flake the test; runs 2 and 3 are JIT-warm,
    // which is fine because the measured time is far below the limit.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const base = fakeStructureAnalysis(600);
      const t0 = performance.now();
      const letters = groupSections(sectionVectors(base, spans, "all"));
      best = Math.min(best, performance.now() - t0);
      expect(letters).toHaveLength(60);
    }
    expect(best).toBeLessThan(50);
  });
});

describe("melodyVariant: Group by Melody's prime is the backing, Other's timbre (controller ruling, fb2)", () => {
  // Thirds [0, 20), [20, 40), [40, 60) of a 60 s clip; `vox` and `oth` give each third's band level (timbre is taken
  // against the stem's mean over the clip, so the last third is a different filler); loudness -12 dB unless silent.
  function clip(vox: number[], oth: number[], otherSilentIn: number[] = []): StructureAnalysis {
    const a = fakeStructureAnalysis(60);
    const third = (f: number) => Math.min(2, Math.floor(f / 40));
    const bands = (lv: number[]) => Array.from({ length: a.frames }, (_, f) => Array.from({ length: FEATURE_BANDS }, (_, b) => (b < 40 ? lv[third(f)] : 1 - lv[third(f)])));
    const loud = (silent: number[]) => Array.from({ length: a.frames }, (_, f) => (silent.includes(third(f)) ? -100 : -12));
    return { ...a, stems: { ...a.stems, vocals: { bands: bands(vox), loudnessDb: loud([]), peak: [] }, other: { bands: bands(oth), loudnessDb: loud(otherSilentIn), peak: [] } } };
  }
  const A = { start: 0, end: 20 };
  const B = { start: 20, end: 40 };

  it("is a variant when the backing (Other's timbre) changes", () => {
    expect(melodyVariant(clip([0.5, 0.5, 0.2], [0.9, 0.1, 0.5]), A, B)).toBe(true);
    expect(melodyVariant(clip([0.5, 0.5, 0.2], [0.9, 0.9, 0.1]), A, B)).toBe(false);
  });

  it("ignores the vocals' timbre, even where they carry the melody", () => {
    const a = clip([0.9, 0.1, 0.5], [0.9, 0.9, 0.1]);
    expect(melodyVariant(a, A, B)).toBe(false);
  });

  it("has no prime where Other is silent: no backing to compare", () => {
    expect(melodyVariant(clip([0.5, 0.5, 0.2], [0.9, 0.1, 0.5], [1]), A, B)).toBe(false);
    expect(melodyVariant(clip([0.5, 0.5, 0.2], [0.9, 0.1, 0.5], [0]), A, B)).toBe(false);
  });
});
