// Test-only readers for the Task 7 fixtures (tools/golden/fixtures_dbn.py).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FIXTURES } from "../../../test/golden.js";

export interface Summary {
  length: number;
  sum: number;
  indices: number[];
  values: number[];
}

export interface BarFixture {
  beatsPerBar: number;
  numStates: number;
  nnz: number;
  firstStates: number[][];
  lastStates: number[][];
  statePositions: Summary;
  stateIntervals: Summary;
  pointers: Summary;
  states: Summary;
  logProbs: Summary;
  obsPointers: Summary;
  obsPointerCounts: number[];
}

export interface SpacesFixture {
  minInterval: number;
  maxInterval: number;
  numTempi: number;
  transitionLambda: number;
  observationLambda: number;
  bars: BarFixture[];
}

export interface SyntheticCase {
  name: string;
  frames: number;
  activations: number[];
  beats: number[];
  positions: number[];
  crop?: [number, number];
  hmm?: { logProb: number; pathSum: number; pathWeightedSum: number; pathSamples: Summary }[];
}

/** dbn_exact.json: SHA-256 and 64 samples of allin1's Flim activations and madmom's log densities on them. */
export interface ExactSummary {
  count: number;
  sha256: string;
  indices: number[];
  values: number[];
}
export const exact = JSON.parse(readFileSync(`${FIXTURES}/dbn_exact.json`, "utf8")) as {
  frames: number;
  activations: ExactSummary;
  logDensities: ExactSummary;
};

/** SHA-256 (hex) of the little-endian bytes of a Float32Array / Float64Array. */
export function sha256Of(a: Float32Array | Float64Array): string {
  return createHash("sha256").update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest("hex");
}

export const spaces = JSON.parse(readFileSync(`${FIXTURES}/dbn_spaces.json`, "utf8")) as SpacesFixture;
export const synthetic = JSON.parse(readFileSync(`${FIXTURES}/dbn_synthetic.json`, "utf8")) as { threshold: number; fps: number; cases: SyntheticCase[] };

export function syntheticCase(name: string): SyntheticCase {
  const c = synthetic.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no synthetic case ${name}`);
  return c;
}

/** The case's activations as float32, as the generator built them. */
export function activationsOf(c: SyntheticCase): Float32Array {
  return Float32Array.from(c.activations);
}

/** Sum and the values at the fixture's sample indices. */
export function sampled(a: ArrayLike<number>, s: Summary): number[] {
  return s.indices.map((i) => a[i]);
}

/** Path checksums as the generator computes them. */
export function pathChecks(path: Uint32Array): { pathSum: number; pathWeightedSum: number } {
  let sum = 0;
  let w = 0n;
  for (let t = 0; t < path.length; t++) {
    sum += path[t];
    w += BigInt(path[t]) * BigInt(t);
  }
  return { pathSum: sum, pathWeightedSum: Number(w % 1000000007n) };
}
