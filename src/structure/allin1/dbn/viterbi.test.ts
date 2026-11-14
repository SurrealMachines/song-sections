import { describe, expect, it } from "vitest";
import { activationsOf, pathChecks, sampled, spaces, syntheticCase } from "./fixtures.js";
import { observationModel } from "./observation.js";
import { barStateSpace } from "./stateSpace.js";
import { barTransitionModel, type TransitionModel } from "./transition.js";
import { multiSourceStates, viterbi, viterbiWorkspaceBytes } from "./viterbi.js";

function hmm(beatsPerBar: number) {
  const st = barStateSpace(beatsPerBar, spaces.minInterval, spaces.maxInterval, spaces.numTempi);
  return { st, tm: barTransitionModel(st, spaces.transitionLambda), om: observationModel(st, spaces.observationLambda) };
}

function cropped(name: string) {
  const c = syntheticCase(name);
  const act = activationsOf(c);
  const [first, last] = c.crop!;
  return { c, obs: act.subarray(2 * first, 2 * last), T: last - first };
}

describe("viterbi on madmom's synthetic crops", () => {
  for (const [name, which] of [["120bpm_4_4", 1], ["140bpm_3_4", 0]] as const) {
    for (const [k, bpb] of [[0, 3], [1, 4]] as const) {
      it(`${name}, ${bpb} beats per bar: madmom's path and log probability`, async () => {
        const { c, obs, T } = cropped(name);
        const { tm, om } = hmm(bpb);
        const got = await viterbi(tm, om, om.logDensities(obs, T), T);
        const want = c.hmm![k];
        expect(got.path).toHaveLength(T);
        expect(sampled(got.path, want.pathSamples)).toEqual(want.pathSamples.values);
        expect(pathChecks(got.path)).toEqual({ pathSum: want.pathSum, pathWeightedSum: want.pathWeightedSum });
        expect(Math.abs(got.logProb - want.logProb)).toBeLessThan(1e-9 * Math.abs(want.logProb));
      });
    }
    it(`${name}: the generating bar length has the higher log probability`, () => {
      const h = syntheticCase(name).hmm!;
      expect(h[which].logProb).toBeGreaterThan(h[1 - which].logProb);
    });
  }

  it("sparse backpointers give exactly the dense reference's path and log probability (4/4 and 3/4)", async () => {
    for (const bpb of [3, 4]) {
      const { obs, T } = cropped("120bpm_4_4");
      const { tm, om } = hmm(bpb);
      const dens = om.logDensities(obs, T);
      const want = denseViterbi(tm, om.pointers, dens, T);
      const got = await viterbi(tm, om, dens, T);
      expect(got.logProb).toBe(want.logProb);
      expect(Array.from(got.path)).toEqual(Array.from(want.path));
    }
  });

  it("matches the dense reference on random densities, ties included", async () => {
    const { tm, om } = hmm(3);
    const T = 700;
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    // coarse values make equal scores (ties) common, so the first-source rule is exercised
    const dens = Float64Array.from({ length: 3 * T }, () => Math.log(0.05 + Math.round(rand() * 4) / 4));
    const want = denseViterbi(tm, om.pointers, dens, T);
    const got = await viterbi(tm, om, dens, T);
    expect(got.logProb).toBe(want.logProb);
    expect(Array.from(got.path)).toEqual(Array.from(want.path));
  });
});

// A 3-state toy model: 0 -> {1, 2}, 1 -> 0, 2 -> 0, with hand-chosen densities.
function toy(): { tm: TransitionModel; om: { pointers: Uint8Array } } {
  // CSR by destination: row 0 <- {1, 2}; row 1 <- {0}; row 2 <- {0}
  return {
    tm: { pointers: new Uint32Array([0, 2, 3, 4]), states: new Uint32Array([1, 2, 0, 0]), logProbs: new Float64Array([0, 0, Math.log(0.5), Math.log(0.5)]) },
    om: { pointers: new Uint8Array([0, 1, 2]) },
  };
}

describe("viterbi details", () => {
  it("keeps the lowest source state on a tie (strict >) and the first maximal end state", async () => {
    const { tm, om } = toy();
    // Every density equal: states 1 and 2 tie everywhere, so the decode must prefer state 1.
    const T = 5;
    const dens = new Float64Array(T * 3).fill(Math.log(0.3));
    const { path, logProb } = await viterbi(tm, om, dens, T);
    expect(Number.isFinite(logProb)).toBe(true);
    expect(Array.from(path)).not.toContain(2);
  });

  it("follows the densities", async () => {
    const { tm, om } = toy();
    const L = Math.log;
    // frame: [d(state0), d(state1), d(state2)]
    const dens = new Float64Array([L(0.1), L(0.1), L(0.9), L(0.9), L(0.1), L(0.1), L(0.1), L(0.9), L(0.1)]);
    const { path, logProb } = await viterbi(tm, om, dens, 3);
    expect(Array.from(path)).toEqual([2, 0, 1]);
    // madmom applies a transition into frame 0 as well: uniform start, then 0 -> 2 (0.5), 2 -> 0 (1), 0 -> 1 (0.5)
    expect(logProb).toBeCloseTo(L(1 / 3) + L(0.5) + L(0.9) + L(0.9) + L(0.5) + L(0.9), 12);
  });

  it("returns an empty path and -Infinity when no path has finite probability", async () => {
    const { tm, om } = toy();
    const r = await viterbi(tm, om, new Float64Array(6).fill(-Infinity), 2);
    expect(r.path).toHaveLength(0);
    expect(r.logProb).toBe(-Infinity);
  });

  it("rejects with AbortError when the signal is aborted", async () => {
    const { obs, T } = cropped("120bpm_4_4");
    const { tm, om } = hmm(4);
    const ac = new AbortController();
    ac.abort();
    await expect(viterbi(tm, om, om.logDensities(obs, T), T, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError when aborted mid-decode", async () => {
    const { tm, om } = hmm(4);
    const T = 5000;
    const obs = new Float32Array(2 * T).fill(0.1);
    const ac = new AbortController();
    const p = viterbi(tm, om, om.logDensities(obs, T), T, { signal: ac.signal });
    setTimeout(() => ac.abort(), 0);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("viterbi memory (Review Focus 5)", () => {
  it("stores backpointers only for the multi-source states: a 20-minute 4/4 decode needs under 64 MB", () => {
    const { tm } = hmm(4);
    expect(multiSourceStates(tm)).toBe(240); // the first state of each of the 60 tempi, per beat of the bar
    const T = 20 * 60 * 100;
    expect(viterbiWorkspaceBytes(tm, T)).toBeLessThan(64 * 2 ** 20);
    // full uint16 storage would be T * S * 2 bytes, about 3.3 GB
    expect(T * (tm.pointers.length - 1) * 2).toBeGreaterThan(3e9);
  });
});

/** madmom's viterbi with every backpointer stored (int32), the obvious way: the reference for the sparse decode. */
function denseViterbi(tm: TransitionModel, omPointers: Uint8Array, dens: Float64Array, T: number) {
  const S = tm.pointers.length - 1;
  let prev = new Float64Array(S).fill(Math.log(1 / S));
  let cur = new Float64Array(S);
  const bp = new Int32Array(T * S);
  for (let t = 0; t < T; t++) {
    for (let s = 0; s < S; s++) {
      let best = -Infinity;
      let arg = 0;
      for (let p = tm.pointers[s]; p < tm.pointers[s + 1]; p++) {
        const v = prev[tm.states[p]] + tm.logProbs[p] + dens[3 * t + omPointers[s]];
        if (v > best) {
          best = v;
          arg = tm.states[p];
        }
      }
      cur[s] = best;
      bp[t * S + s] = arg;
    }
    [prev, cur] = [cur, prev];
  }
  let state = 0;
  for (let s = 1; s < S; s++) if (prev[s] > prev[state]) state = s;
  const logProb = prev[state];
  const path = new Uint32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = state;
    state = bp[t * S + state];
  }
  return { path, logProb };
}
