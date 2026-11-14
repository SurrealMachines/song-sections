// Weight map application against the miniature store of tools/hfmodels/make_fixtures.py, whose .weights sha256s numpy
// computed (permutes, float16 widening, a reshape, strided and offset views, alignment padding).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openCheckpoint, type Checkpoint } from "./checkpoint.js";
import { buildWeights, parseWeightMap, WeightMapError, WeightsChecksumError, type ModelEntry, type WeightMap } from "./weightMap.js";

const STORE = join(__dirname, "..", "..", "..", "fixtures", "hfmodels", "store");
const text = readFileSync(join(STORE, "weightmap.json"), "utf8");
const map: WeightMap = parseWeightMap(text);

let checkpoints: Checkpoint[];
beforeAll(async () => {
  checkpoints = await Promise.all(map.sources.map((s) => openCheckpoint(join(STORE, s.file))));
});
afterAll(async () => {
  for (const c of checkpoints) await c.close();
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "weights-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const never = new AbortController().signal;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const clone = (m: ModelEntry): ModelEntry => JSON.parse(JSON.stringify(m)) as ModelEntry;

describe("buildWeights", () => {
  it.each(map.models.map((m) => [m.name, m] as const))("builds %s byte for byte", async (_, m) => {
    const seen: number[] = [];
    await buildWeights(m, (i) => checkpoints[i], join(dir, m.weights.name), never, (n) => seen.push(n));
    expect(sha(join(dir, m.weights.name))).toBe(m.weights.sha256);
    expect(seen.at(-1)).toBe(m.weights.bytes);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(readdirSync(dir)).toEqual([m.weights.name]);
  });

  it("refuses a source whose shape or dtype differs from the map, leaving nothing behind", async () => {
    const m = clone(map.models[0]);
    m.tensors[0].shape = [3, 2];
    await expect(buildWeights(m, (i) => checkpoints[i], join(dir, "x.weights"), never)).rejects.toBeInstanceOf(WeightsChecksumError);
    const n = clone(map.models[0]);
    n.tensors[0].dtype = "float32";
    await expect(buildWeights(n, (i) => checkpoints[i], join(dir, "x.weights"), never)).rejects.toThrow(/expected float32/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a missing key", async () => {
    const m = clone(map.models[0]);
    m.tensors[1].key = "nope";
    await expect(buildWeights(m, (i) => checkpoints[i], join(dir, "x.weights"), never)).rejects.toThrow(/nope is missing/);
  });

  it("checks the result against the recorded sha256 and keeps no file on a mismatch", async () => {
    const m = clone(map.models[1]);
    m.weights.sha256 = "0".repeat(64);
    await expect(buildWeights(m, (i) => checkpoints[i], join(dir, m.weights.name), never)).rejects.toBeInstanceOf(WeightsChecksumError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops on abort with an AbortError and deletes the .part", async () => {
    const ac = new AbortController();
    const m = map.models[0];
    const p = buildWeights(m, (i) => checkpoints[i], join(dir, m.weights.name), ac.signal, () => ac.abort());
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(dir, m.weights.name))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("parseWeightMap", () => {
  const bad = (edit: (w: WeightMap) => void) => {
    const w = JSON.parse(text) as WeightMap;
    edit(w);
    return () => parseWeightMap(JSON.stringify(w));
  };
  it("accepts the fixture map", () => {
    expect(map.models.map((m) => m.name)).toEqual(["alpha.onnx", "beta.onnx"]);
  });
  it("rejects names that are not plain file names", () => {
    expect(bad((w) => (w.models[0].weights.name = "../escape.weights"))).toThrow(WeightMapError);
    expect(bad((w) => (w.models[0].name = "sub/alpha.onnx"))).toThrow(WeightMapError);
    expect(bad((w) => (w.sources[0].file = ".."))).toThrow(WeightMapError);
  });
  it("rejects lengths that do not match the dims, decreasing offsets, and tensors past the end", () => {
    expect(bad((w) => (w.models[0].tensors[0].length += 4))).toThrow(/length does not match/);
    expect(bad((w) => (w.models[0].tensors[1].offset = 0))).toThrow(/offsets must increase/);
    expect(bad((w) => (w.models[0].weights.bytes = 8))).toThrow(/past the weights file/);
    expect(bad((w) => (w.models[0].tensors[0].source = 9))).toThrow(/bad source/);
    expect(bad((w) => (w.models[0].graph.sha256 = "x"))).toThrow(/bad checksum/);
  });
  it("rejects anything that is not JSON", () => {
    expect(() => parseWeightMap("{")).toThrow(/not JSON/);
  });
});
