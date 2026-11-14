import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../test/golden.js";
import { readNpy } from "../../../test/npy.js";
import { exact, sha256Of } from "./fixtures.js";
import { downbeatActivations, sleefExpf, torchSigmoid } from "./activations.js";

describe("torchSigmoid (torch 2.5.1 CPU float32)", () => {
  const { shape, data } = readNpy(`${FIXTURES}/dbn_sigmoid.npy`);
  const n = shape[1];
  const x = (data as Float32Array).subarray(0, n);
  const want = (data as Float32Array).subarray(n, 2 * n);

  it("matches torch.sigmoid bit for bit, including the scalar tail", () => {
    expect(n % 16).not.toBe(0);
    const got = torchSigmoid(x);
    let bad = 0;
    for (let i = 0; i < n; i++) if (got[i] !== want[i]) bad++;
    expect(bad).toBe(0);
  });

  it("Sleef expf saturates like Sleef", () => {
    expect(sleefExpf(0)).toBe(1);
    expect(sleefExpf(-105)).toBe(0);
    expect(sleefExpf(101)).toBe(Infinity);
  });
});

describe("downbeatActivations (allin1 postprocess_metrical_structure)", () => {
  it("builds the normalised [beat-not-downbeat, downbeat] columns in float32", () => {
    const a = downbeatActivations(new Float32Array([0, 3]), new Float32Array([0, -2]));
    expect(a).toHaveLength(4);
    // logit 0 -> sigmoid 0.5 for both: xbeat = 1e-8, no = 0.5, sum rounds to 1 in float32
    expect(a[0]).toBe(Math.fround(1e-8));
    expect(a[1]).toBe(0.5);
    for (const v of a) expect(Math.fround(v)).toBe(v);
  });

  it("matches allin1's Flim activations_combined[:, :2] bit for bit", () => {
    const beat = readNpy(`${FIXTURES}/flim_logits_beat.npy`).data as Float32Array;
    const downbeat = readNpy(`${FIXTURES}/flim_logits_downbeat.npy`).data as Float32Array;
    const got = downbeatActivations(beat, downbeat);
    const want = exact.activations;
    expect(got).toHaveLength(want.count);
    expect(want.count).toBe(2 * exact.frames);
    // the 64 samples localise a mismatch; the hash is the exact check over all 35,422 values
    expect(want.indices.map((i) => got[i])).toEqual(want.values);
    expect(sha256Of(got)).toBe(want.sha256);
  });
});
