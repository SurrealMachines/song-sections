import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../test/golden.js";
import { readNpy } from "../../test/npy.js";
import { torchSigmoid } from "./dbn/activations.js";
import { CANDIDATE_MIN_STRENGTH, functionalSegments, functionalStructure, functionProbsPerFrame, sectionProbabilities } from "./functional.js";

const section = readNpy(`${FIXTURES}/flim_logits_section.npy`);
const fn = readNpy(`${FIXTURES}/flim_logits_function.npy`);
const T = section.shape[1];
const post = JSON.parse(readFileSync(`${FIXTURES}/flim_post.json`, "utf8")) as {
  frames: number;
  segments: { start: number; end: number; label: string }[];
};

describe("functionalSegments on the Flim logits", () => {
  const got = functionalSegments(section.data as Float32Array, fn.data as Float32Array, T);

  it("has the fixture shapes", () => {
    expect(section.shape).toEqual([1, T]);
    expect(fn.shape).toEqual([1, 10, T]);
    expect(post.frames).toBe(T);
  });

  it("gives exactly allin1's segments", () => {
    expect(got).toHaveLength(post.segments.length);
    got.forEach((s, i) => {
      expect(s.label).toBe(post.segments[i].label);
      expect(Math.abs(s.start - post.segments[i].start)).toBeLessThan(1e-9);
      expect(Math.abs(s.end - post.segments[i].end)).toBeLessThan(1e-9);
    });
  });

  it("has the known labels and starts, tiling [0, T/100]", () => {
    expect(got.map((s) => s.label)).toEqual(["start", "intro", "intro", "inst", "inst", "inst", "solo", "solo", "outro", "end"]);
    expect(got.slice(0, 3).map((s) => s.start)).toEqual([0, 2.67, 28.62]);
    expect(got[0].start).toBe(0);
    expect(got.at(-1)!.end).toBeCloseTo(T / 100, 9);
    for (let i = 1; i < got.length; i++) expect(got[i].start).toBe(got[i - 1].end);
  });
});

describe("sectionProbabilities", () => {
  it("matches torch.sigmoid's own output (Task 7 fixture dbn_sigmoid.npy) bit for bit (review M10)", () => {
    const { shape, data } = readNpy(`${FIXTURES}/dbn_sigmoid.npy`);
    const n = shape[1];
    const got = sectionProbabilities((data as Float32Array).subarray(0, n));
    const want = (data as Float32Array).subarray(n, 2 * n);
    let bad = 0;
    for (let i = 0; i < n; i++) if (got[i] !== want[i]) bad++;
    expect(bad).toBe(0);
  });

  it("is torch.sigmoid bit for bit (the DBN's torchSigmoid), over the whole vector as allin1 calls it", () => {
    // Plain Math.exp differs from torch's Sleef expf by 1 ulp on ~8% of inputs (Task 7).
    let seed = 1;
    const x = Float32Array.from({ length: 100_003 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return (seed / 2 ** 31) * 40 - 20;
    });
    const want = torchSigmoid(x);
    const got = sectionProbabilities(x);
    expect(got).toBeInstanceOf(Float32Array);
    for (let i = 0; i < x.length; i++) if (got[i] !== want[i]) throw new Error(`differs at ${i}: ${got[i]} vs ${want[i]}`);
  });
});

describe("functionalSegments edge cases", () => {
  it("gives one segment over [0, T/100] when no frame has any section probability", () => {
    // sigmoid(-200) underflows to exactly 0 in float32. allin1 itself raises IndexError here; we return one segment.
    const n = 1000;
    const segs = functionalSegments(new Float32Array(n).fill(-200), new Float32Array(10 * n), n);
    expect(segs).toEqual([{ start: 0, end: n / 100, label: "start" }]);
  });

  it("matches allin1 on all-zero logits: sigmoid is 0.5 everywhere, so every frame is a boundary", () => {
    // Checked against allin1 1.1.0 (T=1000 -> 1000 segments of 0.01 s). Silent audio must be handled before this call (Task 9).
    const n = 1000;
    const segs = functionalSegments(new Float32Array(n), new Float32Array(10 * n), n);
    expect(segs).toHaveLength(n);
    expect(segs[0]).toEqual({ start: 0, end: 0.01, label: "start" });
    expect(segs[n - 1].end).toBe(n / 100);
  });

  it("returns [] for no frames", () => {
    expect(functionalSegments(new Float32Array(0), new Float32Array(0), 0)).toEqual([]);
  });

  it("labels each segment by the argmax of its mean softmax, ties to the lower index", () => {
    // One strong section peak at frame 600 of 1200; function logits favour class 8 (verse) before it and class 9 (chorus) after.
    const n = 1200;
    const sec = new Float32Array(n).fill(-200);
    sec[600] = 5;
    const f = new Float32Array(10 * n);
    for (let t = 0; t < n; t++) f[(t < 600 ? 8 : 9) * n + t] = 4;
    const segs = functionalSegments(sec, f, n);
    expect(segs.map((s) => s.label)).toEqual(["verse", "chorus"]);
    expect(segs[0].end).toBe(6);
  });
});

describe("functionProbsPerFrame", () => {
  it("is the T x 10 softmax over classes, rows summing to 1", () => {
    const n = 4;
    const f = new Float32Array(10 * n);
    for (let t = 0; t < n; t++) for (let c = 0; c < 10; c++) f[c * n + t] = (c === t ? 3 : 0) + c * 0.1;
    const p = functionProbsPerFrame(f, n);
    expect(p).toBeInstanceOf(Float32Array);
    expect(p).toHaveLength(n * 10);
    for (let t = 0; t < n; t++) {
      let sum = 0;
      let best = 0;
      for (let c = 0; c < 10; c++) {
        sum += p[t * 10 + c];
        if (p[t * 10 + c] > p[t * 10 + best]) best = c;
      }
      expect(sum).toBeCloseTo(1, 6);
      expect(best).toBe(t);
    }
    const exp = Array.from({ length: 10 }, (_, c) => Math.exp((c === 0 ? 3 : 0) + c * 0.1));
    expect(p[0]).toBeCloseTo(exp[0] / exp.reduce((a, b) => a + b), 6);
  });
});

/** allin1's local_maxima + peak_picking written the obvious way (O(T x 2401)): the reference for the port's windows. */
function naiveBoundaries(prob: Float32Array): number[] {
  const n = prob.length;
  const lm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let max = -Infinity;
    for (let j = Math.max(0, i - 48); j <= Math.min(n - 1, i + 48); j++) if (prob[j] > max) max = prob[j];
    if (prob[i] === max) lm[i] = prob[i];
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(lm[i] > 0)) continue;
    let isMax = true;
    let past = 0;
    let future = 0;
    for (let j = i - 1200; j <= i + 1200; j++) {
      const v = j >= 0 && j < n ? lm[j] : 0;
      if (v > lm[i]) isMax = false;
      if (j < i) past += v;
      if (j > i) future += v;
    }
    if (isMax && lm[i] - (past / 1200 + future / 1200) / 2 > 0) out.push(i);
  }
  return out;
}

describe("functionalSegments boundaries against a naive allin1 peak picking", () => {
  it("agrees on plateaus, ties and noise", () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const cases: Float32Array[] = [
      Float32Array.from({ length: 9000 }, (_, t) => (t === 1000 || t === 2000 ? 8 : -8)), // long exact plateau
      Float32Array.from({ length: 9000 }, () => Math.round(rand() * 3) - 6), // many ties
      Float32Array.from({ length: 9000 }, (_, t) => -6 + 4 * Math.sin(t / 700) + rand()),
    ];
    for (const sec of cases) {
      const n = sec.length;
      const want = naiveBoundaries(sectionProbabilities(sec)).filter((f) => f > 0);
      const got = functionalSegments(sec, new Float32Array(10 * n), n).slice(1).map((s) => Math.round((s.start * 44100) / 441));
      expect(got).toEqual(want);
    }
  });
});

/** The contract's candidates written the obvious way: naive local maxima >= 0.001 (frame 0 excluded), plus the chosen frames. */
function naiveCandidates(prob: Float32Array): number[] {
  const n = prob.length;
  const chosen = new Set(naiveBoundaries(prob));
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    let max = -Infinity;
    for (let j = Math.max(0, i - 48); j <= Math.min(n - 1, i + 48); j++) if (prob[j] > max) max = prob[j];
    if ((prob[i] === max && prob[i] >= 0.001) || chosen.has(i)) out.push(i);
  }
  return out;
}

describe("functionalStructure boundary candidates", () => {
  const prob = sectionProbabilities((section.data as Float32Array).subarray(0, T));
  const { segments, candidates } = functionalStructure(section.data as Float32Array, fn.data as Float32Array, T);

  it("gives the same segments as functionalSegments", () => {
    expect(segments).toEqual(functionalSegments(section.data as Float32Array, fn.data as Float32Array, T));
  });

  it("on Flim: every local maximum >= 0.001 after frame 0, ascending, at allin1's frame times, 4-decimal strengths", () => {
    expect(CANDIDATE_MIN_STRENGTH).toBe(0.001);
    const frames = naiveCandidates(prob);
    expect(candidates.map((c) => c.time)).toEqual(frames.map((f) => (f * 441) / 44100));
    candidates.forEach((c, i) => expect(c.strength).toBe(Math.round(prob[frames[i]] * 10000) / 10000));
    for (let i = 1; i < candidates.length; i++) expect(candidates[i].time).toBeGreaterThan(candidates[i - 1].time);
    console.log(`Flim: ${candidates.length} candidates for ${segments.length - 1} boundaries`);
    expect(candidates.length).toBeGreaterThan(segments.length);
  });

  it("on Flim: includes every chosen boundary as the same float", () => {
    const times = new Set(candidates.map((c) => c.time));
    for (const s of segments.slice(1)) expect(times.has(s.start)).toBe(true);
    expect(candidates.map((c) => c.time)).toEqual(expect.arrayContaining(post.segments.slice(1).map((s) => s.start)));
  });

  it("agrees with the naive reference on plateaus, ties and noise, and keeps chosen frames below 0.001", () => {
    let seed = 5;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const cases: Float32Array[] = [
      Float32Array.from({ length: 6000 }, (_, t) => (t === 1000 || t === 2000 ? 8 : -8)),
      Float32Array.from({ length: 6000 }, () => Math.round(rand() * 3) - 6),
      Float32Array.from({ length: 6000 }, (_, t) => -6 + 4 * Math.sin(t / 700) + rand()),
      // Every peak far below 0.001: the chosen boundaries are still candidates (the contract's segment-start rule).
      Float32Array.from({ length: 6000 }, (_, t) => -12 + 3 * Math.sin(t / 500)),
    ];
    for (const sec of cases) {
      const n = sec.length;
      const p = sectionProbabilities(sec);
      const got = functionalStructure(sec, new Float32Array(10 * n), n);
      expect(got.candidates.map((c) => Math.round((c.time * 44100) / 441))).toEqual(naiveCandidates(p));
      const times = new Set(got.candidates.map((c) => c.time));
      for (const s of got.segments.slice(1)) expect(times.has(s.start)).toBe(true);
    }
  });

  it("gives no candidates for no frames, and none at frame 0", () => {
    expect(functionalStructure(new Float32Array(0), new Float32Array(0), 0)).toEqual({ segments: [], candidates: [] });
    const sec = new Float32Array(500).fill(-8);
    sec[0] = 8;
    sec[300] = 4;
    const got = functionalStructure(sec, new Float32Array(5000), 500);
    expect(got.candidates.map((c) => c.time)).toEqual([3]);
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("speed", () => {
  it("handles a 20-minute clip (120 000 frames) quickly", () => {
    const n = 120000;
    const sec = new Float32Array(n);
    for (let t = 0; t < n; t++) sec[t] = -6 + 4 * Math.sin(t / 700) + Math.sin(t / 13);
    const t0 = performance.now();
    const segs = functionalSegments(sec, new Float32Array(10 * n), n);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(segs.length).toBeGreaterThan(1);
  });

  it("stays fast on 20 minutes of exactly constant section logits (no O(T x 2401) scan)", () => {
    const n = 120000;
    const sec = new Float32Array(n).fill(-8);
    sec[1000] = 8;
    const t0 = performance.now();
    functionalSegments(sec, new Float32Array(10 * n), n);
    const ms = performance.now() - t0;
    console.log(`plateau, 20 min: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(60);
  });
});
