import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCached, saveCached } from "../analysis/cache.js";
import { abortError } from "../core/abort.js";
import type { Pace } from "../core/pace.js";
import { STEM_NAMES, type StemName, type StructureAnalysis } from "../structure/contract.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { makeWav } from "../test/makeWav.js";
import { CELL_RATE, PATTERN_ENGINE, encodeInt8, isPatternFeatures, sourceKind, type PatternFeatures } from "./contract.js";
import { cellExtractor, decodeSource } from "./features.js";
import { patternGrid } from "./grid.js";
import { cachedPatterns, computePatterns, patternsCacheKey, type PatternsRequest } from "./host.js";
import { renderSong, type BarScript } from "./synth.js";

const RATE = 11025;
const BARS = 8; // 120 bpm: 16 s

/** Four stems of a little song: a drum loop, a bass line, a two-bar idea in other, and vocals in the second half. */
function stems(): Record<StemName, Float32Array> {
  const loop: BarScript = { hits: [{ drum: "kick", at: 0 }, { drum: "hat", at: 1 }, { drum: "snare", at: 2 }, { drum: "hat", at: 3 }] };
  const bass: BarScript[] = [{ notes: [{ pitch: 36, at: 0, len: 2 }, { pitch: 43, at: 2, len: 2 }] }, { notes: [{ pitch: 38, at: 0, len: 4 }] }];
  const other: BarScript[] = [
    { notes: [60, 64, 67, 64].map((pitch, i) => ({ pitch, at: i, len: 1 })) },
    { notes: [62, 65, 69, 65].map((pitch, i) => ({ pitch, at: i, len: 1 })) },
  ];
  const vocals: BarScript[] = Array.from({ length: BARS }, (_, i) => (i < BARS / 2 ? {} : { notes: [{ pitch: 72, at: 0, len: 3 }] }));
  const song = (bars: BarScript[]) => renderSong({ bpm: 120, rate: RATE, bars }).x;
  return {
    drums: song(Array.from({ length: BARS }, () => loop)),
    bass: song(Array.from({ length: BARS }, (_, i) => bass[i % 2])),
    other: song(Array.from({ length: BARS }, (_, i) => other[i % 2])),
    vocals: song(vocals),
  };
}

const truth = renderSong({ bpm: 120, rate: RATE, bars: Array.from({ length: BARS }, () => ({})) });
const audio = stems();
const samples = audio.drums.length;
const mixX = new Float32Array(samples);
for (const x of Object.values(audio)) for (let i = 0; i < samples; i++) mixX[i] += x[i];

/** The clip's analysis: allin1's beats are the true ones. */
const analysisOf = (durationSec: number): StructureAnalysis => ({
  ...fakeStructureAnalysis(durationSec),
  downbeats: truth.downbeats,
  beats: truth.beats,
  bpm: 120,
});

let root: string;
let stemsDir: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "patterns-host-"));
  stemsDir = join(root, "stems");
  await mkdir(stemsDir);
  // As the kept stems are: float stereo; at 22050 Hz, each sample held twice, so readMono gives back exactly x at 11025.
  for (const s of STEM_NAMES) {
    const x = audio[s];
    await makeWav(join(stemsDir, `${s}.wav`), { sampleRate: 2 * RATE, channels: 2, bitDepth: 32, float: true, frames: 2 * x.length, sample: (_ch, i) => x[i >> 1] });
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = (over: Partial<PatternsRequest> = {}): PatternsRequest => ({
  storageDir: join(root, "storage"),
  hash: "abc123",
  analysis: analysisOf(samples / RATE),
  mix: { x: mixX, rate: RATE },
  stemsDir,
  ...over,
});

/** The cells of x, extracted in one go. */
function cellsOf(kind: Parameters<typeof cellExtractor>[0], x: Float32Array) {
  const ex = cellExtractor(kind, RATE);
  ex.push(x);
  return ex.finish();
}

describe("computePatterns", () => {
  it("with kept stems gives all five sources, each the cells of its own audio, and a grid from other, drums and bass", async () => {
    const req = request();
    const f = await computePatterns(req);
    expect(isPatternFeatures(f)).toBe(true);
    expect(f).toMatchObject({ engine: PATTERN_ENGINE, rate: CELL_RATE, durationSec: 16 });
    expect(Object.keys(f.sources).sort()).toEqual(["bass", "drums", "mix", "other", "vocals"]);
    for (const s of STEM_NAMES) expect(f.sources[s], s).toEqual(cellsOf(sourceKind(s), audio[s]));
    expect(f.sources.mix).toEqual(cellsOf("mix", mixX));

    const evidence = (["other", "drums", "bass"] as const).map((s) => decodeSource(f.sources[s]!));
    const a = req.analysis;
    expect(f.grid).toEqual(patternGrid({ downbeats: a.downbeats, beats: a.beats, bpm: a.bpm, durationSec: 16, evidence }));
    expect(f.grid.map((b) => b.start)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it("with no stems gives only the mix, and a grid from it", async () => {
    const req = request({ stemsDir: null });
    const f = await computePatterns(req);
    expect(isPatternFeatures(f)).toBe(true);
    expect(Object.keys(f.sources)).toEqual(["mix"]);
    const a = req.analysis;
    const evidence = [decodeSource(f.sources.mix!)];
    expect(f.grid).toEqual(patternGrid({ downbeats: a.downbeats, beats: a.beats, bpm: a.bpm, durationSec: 16, evidence }));
  });

  it("gives every source exactly ceil(durationSec · CELL_RATE) cells, whether its audio is longer or shorter than the clip", async () => {
    for (const durationSec of [15.987, 16.04, 16.0001]) {
      const f = await computePatterns(request({ analysis: analysisOf(durationSec) }));
      expect(isPatternFeatures(f)).toBe(true);
      expect(f.durationSec).toBe(durationSec);
      for (const [s, src] of Object.entries(f.sources)) expect(src!.cells, `${s} at ${durationSec} s`).toBe(Math.ceil(durationSec * CELL_RATE));
    }
  });

  it("yields through its pace, and stops at an abort", async () => {
    let yields = 0;
    const counting: Pace = { yield: async () => void yields++, slice: (n) => n };
    await computePatterns(request({ pace: counting }));
    expect(yields).toBeGreaterThan(5); // the stem reads and the extraction, in slices

    const controller = new AbortController();
    const aborting: Pace = { yield: async () => controller.abort(), slice: (n) => n };
    await expect(computePatterns(request({ pace: aborting }), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("cachedPatterns", () => {
  /** A small, whole PatternFeatures for the request's clip, mix only. */
  const features = (req: PatternsRequest): PatternFeatures => {
    const cells = Math.ceil(req.analysis.durationSec * CELL_RATE);
    return {
      engine: PATTERN_ENGINE,
      rate: CELL_RATE,
      durationSec: req.analysis.durationSec,
      grid: [{ start: 0, end: req.analysis.durationSec, unsure: true }],
      sources: { mix: { kind: "mix", dims: 20, cells, data: encodeInt8(new Int8Array(cells * 20)), loud: encodeInt8(new Int8Array(cells)) } },
    };
  };
  const deps = () => ({ loadCached, saveCached, logError: vi.fn() });

  it("caches under its own engine, keyed on the stems and the Structure engine, and hits the cache the second time", async () => {
    const req = request({ storageDir: join(root, "cache-hit"), stemsDir: null });
    const compute = vi.fn(async (r: PatternsRequest) => features(r));
    const d = deps();
    const first = await cachedPatterns(d, req, compute);
    const second = await cachedPatterns(d, req, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(await loadCached(req.storageDir, patternsCacheKey("abc123", false), PATTERN_ENGINE)).toEqual(first);
    expect(patternsCacheKey("abc123", true)).toMatch(/^abc123-stems-allin1-onnx-\d+$/);
    expect(patternsCacheKey("abc123", false)).toMatch(/^abc123-mix-allin1-onnx-\d+$/);
    expect(d.logError).not.toHaveBeenCalled();
  });

  it("recomputes over a corrupt entry, or one that is not of this clip", async () => {
    const req = request({ storageDir: join(root, "cache-corrupt"), stemsDir: null });
    const dir = join(req.storageDir, "cache", PATTERN_ENGINE);
    await mkdir(dir, { recursive: true });
    const entry = join(dir, `${patternsCacheKey("abc123", false)}.json`);
    const compute = vi.fn(async (r: PatternsRequest) => features(r));
    const cells = Math.ceil(req.analysis.durationSec * CELL_RATE);
    // whole as PatternFeatures go, but not what this engine decodes: 3 dims a mix cell, or a cell short of the clip
    const mix = (n: number, dims: number) => ({
      kind: "mix",
      dims,
      cells: n,
      data: encodeInt8(new Int8Array(n * dims)),
      loud: encodeInt8(new Int8Array(n)),
    });
    const stale = [{ ...features(req), sources: { mix: mix(cells, 3) } }, { ...features(req), sources: { mix: mix(cells - 1, 20) } }];
    for (const f of stale) expect(isPatternFeatures(f)).toBe(true);
    for (const bad of [
      "{not json",
      JSON.stringify({ ...features(req), engine: "patterns-0" }),
      JSON.stringify({ ...features(req), durationSec: 12 }),
      ...stale.map((f) => JSON.stringify(f)),
    ]) {
      await writeFile(entry, bad, "utf8");
      compute.mockClear();
      expect(await cachedPatterns(deps(), req, compute)).toEqual(features(req));
      expect(compute).toHaveBeenCalledTimes(1);
    }
    // A mix-only entry under the stems' key (sources missing) is recomputed too.
    const withStems = request({ storageDir: req.storageDir });
    await saveCached(req.storageDir, patternsCacheKey("abc123", true), PATTERN_ENGINE, features(req));
    compute.mockClear();
    await cachedPatterns(deps(), withStems, compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("is null, and logs, when computing fails; an abort is rethrown", async () => {
    const req = request({ storageDir: join(root, "cache-fail"), stemsDir: null });
    const d = deps();
    expect(await cachedPatterns(d, req, async () => Promise.reject(new Error("bad wav")))).toBeNull();
    expect(d.logError).toHaveBeenCalledWith(expect.stringContaining("could not find the patterns"), expect.any(Error));
    await expect(cachedPatterns(d, req, async () => Promise.reject(abortError()))).rejects.toMatchObject({ name: "AbortError" });
    expect(await loadCached(req.storageDir, patternsCacheKey("abc123", false), PATTERN_ENGINE)).toBeNull();
  });

  it("still answers when the cache cannot be written (logged)", async () => {
    const req = request({ stemsDir: null });
    const d = { ...deps(), saveCached: vi.fn(async () => Promise.reject(new Error("disk full"))) };
    expect(await cachedPatterns(d, req, async (r) => features(r))).toEqual(features(req));
    expect(d.logError).toHaveBeenCalledWith(expect.stringContaining("could not save the patterns cache"), expect.any(Error));
  });

  it("computes with computePatterns by default, passing the signal", async () => {
    const req = request({ storageDir: join(root, "cache-default"), stemsDir: null });
    const f = await cachedPatterns(deps(), req);
    expect(f && Object.keys(f.sources)).toEqual(["mix"]);
    const controller = new AbortController();
    controller.abort();
    await expect(cachedPatterns(deps(), { ...req, storageDir: join(root, "cache-aborted") }, undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
