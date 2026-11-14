import { describe, expect, it } from "vitest";
import { GROUP_DIST, GROUP_DIST_MAX, GROUP_DIST_MIN, SILENT_DB, VARIANT_DIST, groupSections } from "./letters.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { sectionVectors } from "./sectionVectors.js";

const unit = (...c: number[]) => {
  const n = Math.hypot(...c);
  return Float64Array.from(c.map((x) => x / n));
};
const e1 = unit(1, 0, 0);
const e2 = unit(0, 1, 0);

describe("groupSections", () => {
  it("groups repeats and flags a variant", () => {
    const g = groupSections([e1, e2, e1, e2, unit(0.9, 0, 0.436)]);
    expect(g.map((x) => x.group)).toEqual([0, 1, 0, 1, 0]);
    expect(g.map((x) => x.variant)).toEqual([false, false, false, false, true]);
  });

  it("gives orthogonal vectors distinct groups", () => {
    const g = groupSections([e1, e2, unit(0, 0, 1)]);
    expect(g.map((x) => x.group)).toEqual([0, 1, 2]);
  });

  it("maps null vectors to no group", () => {
    expect(groupSections([null, e1])).toEqual([
      { group: null, variant: false },
      { group: 0, variant: false },
    ]);
  });

  it("handles empty input and all-null input", () => {
    expect(groupSections([])).toEqual([]);
    expect(groupSections([null, null])).toEqual([
      { group: null, variant: false },
      { group: null, variant: false },
    ]);
  });

  it("numbers groups by first appearance, not cluster size", () => {
    const g = groupSections([e2, e1, e1, e1]);
    expect(g.map((x) => x.group)).toEqual([0, 1, 1, 1]);
  });

  it("never marks the first section of a group as a variant", () => {
    const v = unit(0.9, 0, 0.436);
    const g = groupSections([v, e1]);
    expect(g.map((x) => x.group)).toEqual([0, 0]);
    expect(g[0].variant).toBe(false);
    expect(g[1].variant).toBe(true);
  });

  it("groups the fake analysis: verses together, choruses together, apart from each other", () => {
    const a = fakeStructureAnalysis(180);
    const g = groupSections(sectionVectors(a, a.segments, "all"));
    const at = (i: number) => g[i].group;
    expect(at(2)).toBe(at(4)); // verses
    expect(at(3)).toBe(at(5)); // choruses
    expect(at(2)).not.toBe(at(3));
    expect(g.every((x) => x.group !== null)).toBe(true);
  });
});

// Unit vector at angle `theta` on the e1-e2 circle: cosine distance to e1 is 1 - cos(theta).
const angle = (theta: number) => Float64Array.from([Math.cos(theta), Math.sin(theta), 0]);
// The angle whose cosine distance to e1 is d.
const atDist = (d: number) => Math.acos(1 - d);

describe("rules behind the constants (written relative to them, so Task 13 can retune)", () => {
  it("has the initial values (Task 13: update this one line when retuning)", () => {
    expect([GROUP_DIST, SILENT_DB]).toEqual([0.15, -45]);
    expect(VARIANT_DIST).toBeCloseTo(0.05, 12); // GROUP_DIST / 3
    expect(VARIANT_DIST).toBeLessThan(GROUP_DIST);
  });

  it("merges a pair just inside GROUP_DIST and not one just outside", () => {
    expect(groupSections([e1, angle(atDist(GROUP_DIST - 1e-3))]).map((x) => x.group)).toEqual([0, 0]);
    expect(groupSections([e1, angle(atDist(GROUP_DIST + 1e-3))]).map((x) => x.group)).toEqual([0, 1]);
  });

  it("flags a variant just beyond VARIANT_DIST and not one just inside", () => {
    expect(groupSections([e1, angle(atDist(VARIANT_DIST - 1e-3))]).map((x) => x.variant)).toEqual([false, false]);
    expect(groupSections([e1, angle(atDist(VARIANT_DIST + 1e-3))]).map((x) => x.variant)).toEqual([false, true]);
  });

  it("measures a variant against the group's FIRST section, not the previous member", () => {
    // b is 0.8 V from a, c is 0.8 V-ish from b but 1.4 V from a.
    const a = angle(0);
    const b = angle(atDist(0.8 * VARIANT_DIST));
    const c = angle(atDist(1.4 * VARIANT_DIST));
    const g = groupSections([a, b, c]);
    expect(g.map((x) => x.group)).toEqual([0, 0, 0]);
    expect(g.map((x) => x.variant)).toEqual([false, false, true]);
  });

  it("breaks linkage ties towards the lowest pair", () => {
    // Angles -x, 0, +x: d(0,1) == d(1,2) < GROUP_DIST, but d(0,2) is about 4x as large.
    // Merging (0,1) first leaves the average to section 2 above GROUP_DIST; merging (1,2) first would group [0,1,1].
    const x = atDist(0.7 * GROUP_DIST);
    const g = groupSections([angle(-x), angle(0), angle(x)]);
    expect(g.map((v) => v.group)).toEqual([0, 0, 1]);
  });

  it("treats two identical all-zero vectors as the same group, not as distinct", () => {
    // An audible stem whose features never vary can give zero vectors; identical sections must still share a letter.
    const zero = new Float64Array(3);
    expect(groupSections([zero, e1, zero]).map((v) => v.group)).toEqual([0, 1, 0]);
  });
});

describe("groupSections thresholds (the Letters slider, feedback round 1)", () => {
  // Pairwise distances 1 - cos: a-b 0.100, a-c 0.300, b-c 0.059.
  const a = unit(1, 0, 0);
  const b = unit(0.9, 0.436, 0);
  const c = unit(0.7, 0.714, 0);

  it("defaults to GROUP_DIST, with VARIANT_DIST a third of it", () => {
    expect(VARIANT_DIST).toBeCloseTo(GROUP_DIST / 3, 10);
    expect(groupSections([a, b, c])).toEqual(groupSections([a, b, c], GROUP_DIST));
  });

  it("Strict splits what Loose joins", () => {
    expect(groupSections([a, b, c], GROUP_DIST_MIN).map((x) => x.group)).toEqual([0, 1, 2]);
    expect(groupSections([a, b, c], GROUP_DIST_MAX).map((x) => x.group)).toEqual([0, 0, 0]);
  });

  it("never gives more letters as the distance grows", () => {
    const an = fakeStructureAnalysis(180);
    const v = sectionVectors(an, an.segments, "all");
    let last = Infinity;
    for (let d = GROUP_DIST_MIN; d <= GROUP_DIST_MAX + 1e-9; d += 0.01) {
      const n = new Set(groupSections(v, d).map((x) => x.group)).size;
      expect(n).toBeLessThanOrEqual(last);
      last = n;
    }
  });

  it("scales the variant threshold with the group distance (a third of it)", () => {
    // b is 0.10 from a: a variant when the variant threshold is under 0.10, plain when over.
    expect(groupSections([a, b], 0.2)[1]).toEqual({ group: 0, variant: true }); // 0.067
    expect(groupSections([a, b], 0.36)[1]).toEqual({ group: 0, variant: false }); // 0.12
  });

  it("takes an explicit variant threshold", () => {
    expect(groupSections([a, b], 0.36, 0.01)[1]).toEqual({ group: 0, variant: true });
  });
});


/** The O(n³) clustering as it was before the cached-nearest rewrite (fix round, review I3): the reference. */
function referenceGroupSections(vectors: (Float64Array | null)[], groupDist: number, variantDist = groupDist / 3) {
  const isZero = (v: Float64Array) => v.every((x) => x === 0);
  const dist = (a: Float64Array, b: Float64Array, bothZero: boolean) => {
    if (bothZero) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - dot;
  };
  const idx: number[] = [];
  vectors.forEach((v, i) => v && idx.push(i));
  const n = idx.length;
  const sum = Array.from({ length: n }, () => new Float64Array(n));
  const zero = idx.map((k) => isZero(vectors[k]!));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sum[i][j] = sum[j][i] = dist(vectors[idx[i]]!, vectors[idx[j]]!, zero[i] && zero[j]);
  const members: (number[] | null)[] = Array.from({ length: n }, (_, i) => [i]);
  for (;;) {
    let bi = -1;
    let bj = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!members[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!members[j]) continue;
        const d = sum[i][j] / (members[i]!.length * members[j]!.length);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || best > groupDist) break;
    for (let k = 0; k < n; k++) {
      sum[bi][k] += sum[bj][k];
      sum[k][bi] = sum[bi][k];
    }
    members[bi] = members[bi]!.concat(members[bj]!).sort((x, y) => x - y);
    members[bj] = null;
  }
  const out = vectors.map(() => ({ group: null as number | null, variant: false }));
  const clusters = members.filter((m): m is number[] => m !== null).sort((x, y) => x[0] - y[0]);
  clusters.forEach((m, g) => {
    const first = vectors[idx[m[0]]]!;
    for (const k of m) out[idx[k]] = { group: g, variant: k !== m[0] && dist(first, vectors[idx[k]]!, zero[m[0]] && zero[k]) > variantDist };
  });
  return out;
}

describe("groupSections is the reference clustering, only faster (fix round, review I3)", () => {
  // A small deterministic PRNG, so a failure reproduces.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  it("gives identical results on random inputs: clusters, exact ties, nulls and zero vectors", () => {
    for (let trial = 0; trial < 600; trial++) {
      const r = rng(trial + 1);
      const n = 1 + Math.floor(r() * 60);
      // Every third trial is tiny and coarse: few directions in 2 or 3 dimensions, so distinct pairs tie exactly too.
      const coarse = trial % 3 === 1;
      const dim = coarse ? 2 + (trial % 2) : 2 + Math.floor(r() * 6);
      const centres = Array.from({ length: 1 + Math.floor(r() * 8) }, () => Array.from({ length: dim }, () => r() - 0.5));
      // Coarse quantisation in some trials makes many vectors identical, so linkage ties are common.
      const q = trial % 3 === 0 ? 4 : coarse ? 1 : 0;
      const vectors = Array.from({ length: n }, () => {
        const u = r();
        if (u < 0.08) return null;
        if (u < 0.12) return new Float64Array(dim);
        const c = centres[Math.floor(r() * centres.length)];
        const v = c.map((x) => x + (r() - 0.5) * 0.4);
        const w = q ? v.map((x) => Math.round(x * q) / q) : v;
        const len = Math.hypot(...w) || 1;
        return Float64Array.from(w.map((x) => x / len));
      });
      for (const d of [0.02, 0.1, 0.15, 0.25, 0.4, 0.8]) {
        expect(groupSections(vectors, d), `trial ${trial}, d ${d}`).toEqual(referenceGroupSections(vectors, d));
      }
    }
  });

  it("gives identical results when distinct pairs tie exactly (vectors from eight fixed directions)", () => {
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map((v) => unit(...v));
    const at = (...k: number[]) => k.map((i) => dirs[i]);
    // A tie a careless cache update gets wrong: after (1, 2) merge, row 0 sees 1 and 3 at one distance and must keep 1.
    expect(groupSections(at(1, 0, 0, 2, 2), 1)).toEqual(referenceGroupSections(at(1, 0, 0, 2, 2), 1));
    const r = rng(99);
    for (let trial = 0; trial < 3000; trial++) {
      const k = 2 + Math.floor(r() * 7);
      const v = Array.from({ length: 3 + Math.floor(r() * 10) }, () => dirs[Math.floor(r() * k)]);
      for (const d of [0.1, 0.3, 0.5, 0.8, 1, 1.2]) expect(groupSections(v, d), `trial ${trial}, d ${d}`).toEqual(referenceGroupSections(v, d));
    }
  });

  it("gives identical results on the fake analysis at every Letters step and Group by", () => {
    const an = fakeStructureAnalysis(1800);
    // Sections every 4 s, as a high Sections slider gives on a long mix.
    const spans = Array.from({ length: 450 }, (_, i) => ({ start: i * 4, end: (i + 1) * 4 }));
    for (const by of ["all", "drums", "other"] as const) {
      const v = sectionVectors(an, spans, by);
      for (const d of [GROUP_DIST_MIN, GROUP_DIST, GROUP_DIST_MAX]) expect(groupSections(v, d), `${by} ${d}`).toEqual(referenceGroupSections(v, d));
    }
  });
});
