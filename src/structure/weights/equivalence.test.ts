// fb/hfmodels equivalence: the store built from the authors' checkpoints against the v1 single-file models.
// Gated like the other model tests: SONG_SECTIONS_SOURCES is a folder with the 9 source checkpoints (MODEL_SOURCES'
// names, e.g. the files of both Hugging Face snapshot folders) and SONG_SECTIONS_MODELS the v1 .onnx files. The
// end-to-end part also needs .dev/golden/flim-44k.wav (npm run fixtures).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelsDir } from "../../test/golden.js";
import { readModel } from "../../test/onnxProto.js";
import type { StructureEnv } from "../contract.js";
import { analyseStructure } from "../engine.js";
import { installFromSources, loadWeightMap, modelDir } from "../models.js";
import type { WeightMap } from "./weightMap.js";

const sources = (): string | undefined => {
  const d = process.env.SONG_SECTIONS_SOURCES;
  return d && existsSync(d) ? d : undefined;
};
const FLIM = join(process.cwd(), ".dev", "golden", "flim-44k.wav");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!sources() || !modelsDir())("models rebuilt from the authors' checkpoints vs v1", () => {
  let rebuilt: string;
  let map: WeightMap;
  beforeAll(async () => {
    map = await loadWeightMap();
    const storage = tmp("ss-hf-storage-");
    rebuilt = await installFromSources(storage, sources()!);
    expect(rebuilt).toBe(modelDir(storage));
  }, 120_000);

  it("the v1 files are the ones the weight map was made from", () => {
    for (const m of map.models) expect(sha(readFileSync(join(modelsDir()!, m.name))), m.name).toBe(m.v1.sha256);
  });

  it("every initializer is byte-identical to v1's (name, dims, type, bytes), read through the graph's own external data refs", () => {
    for (const m of map.models) {
      const v1 = readModel(readFileSync(join(modelsDir()!, m.name)));
      const graph = readModel(readFileSync(join(rebuilt, m.name)));
      const weights = readFileSync(join(rebuilt, m.weights.name));
      expect(graph.initializers.length, m.name).toBe(v1.initializers.length);
      v1.initializers.forEach((a, i) => {
        const b = graph.initializers[i];
        expect([b.name, b.dims, b.dataType], m.name).toEqual([a.name, a.dims, a.dataType]);
        expect(b.raw).toBeNull();
        const at = Number(b.external!.offset);
        const bytes = weights.subarray(at, at + Number(b.external!.length));
        if (!Buffer.from(a.raw!).equals(bytes)) throw new Error(`${m.name}: ${a.name} differs from v1`);
      });
    }
  });

  it("everything else in each graph (nodes, constants, inputs, outputs, metadata) is v1's, byte for byte", () => {
    for (const m of map.models) {
      const v1 = readModel(readFileSync(join(modelsDir()!, m.name)));
      const graph = readModel(readFileSync(join(rebuilt, m.name)));
      expect(graph.graphRest.equals(v1.graphRest), m.name).toBe(true);
      expect(graph.modelRest.equals(v1.modelRest), m.name).toBe(true);
    }
  });

  describe.skipIf(!existsSync(FLIM))("Flim end to end", () => {
    const run = async (modelDir: string) => {
      const storageDir = tmp("ss-hf-run-");
      const keepStemsDir = tmp("ss-hf-stems-");
      const env: StructureEnv = { modelDir, tempDir: tmp("ss-hf-temp-"), extensionRoot: process.cwd(), storageDir, keepStemsDir };
      const analysis = await analyseStructure(FLIM, env, new AbortController().signal, () => {});
      const stems = Object.fromEntries(readdirSync(keepStemsDir).sort().map((f) => [f, sha(readFileSync(join(keepStemsDir, f)))]));
      return { analysis, stems };
    };

    it("gives exactly v1's analysis and stems", async () => {
      const a = await run(modelsDir()!);
      const b = await run(rebuilt);
      expect(Object.keys(b.stems)).toEqual(["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
      expect(b.stems).toEqual(a.stems);
      expect(b.analysis).toEqual(a.analysis);
      expect(JSON.stringify(b.analysis)).toBe(JSON.stringify(a.analysis));
    }, 600_000);
  });
});
