import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readModel } from "../test/onnxProto.js";
import {
  MODEL_DISK_BYTES,
  MODEL_DOWNLOAD_BYTES,
  MODEL_FILES,
  MODEL_SET,
  MODEL_SOURCES,
  ModelChecksumError,
  installFromSources,
  loadWeightMap,
  modelDir,
  modelsInstalled,
  packagedModelsDir,
  sourceUrl,
  type ModelFile,
  type StoreSpec,
} from "./models.js";
import { parseWeightMap } from "./weights/weightMap.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("the shipped model list", () => {
  it("is the demucs core and the 8 folds, each a graph and its weights", () => {
    const models = ["htdemucs_core", ...Array.from({ length: 8 }, (_, i) => `allin1_harmonix_fold${i}`)];
    expect(MODEL_FILES.map((f) => f.name)).toEqual(models.flatMap((m) => [`${m}.onnx`, `${m}.weights`]));
    expect(MODEL_FILES.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(MODEL_DISK_BYTES).toBe(190_454_313);
    expect(MODEL_DOWNLOAD_BYTES).toBe(95_230_008);
  });

  it("downloads the pinned revisions from the authors' Hugging Face repos", () => {
    expect(MODEL_SOURCES.map(sourceUrl)).toEqual([
      "https://huggingface.co/adefossez/HTDemucs/resolve/cbc8a9b1a87023b7fd74e7b3412e6321c0eab003/955717e8.safetensors",
      ...[
        "harmonix-fold0-0vra4ys2.pth",
        "harmonix-fold1-3ozjhtsj.pth",
        "harmonix-fold2-gmgo0nsy.pth",
        "harmonix-fold3-i92b7m8p.pth",
        "harmonix-fold4-1bql5qo0.pth",
        "harmonix-fold5-x4z5zeef.pth",
        "harmonix-fold6-x7t226rq.pth",
        "harmonix-fold7-qwwskhg6.pth",
      ].map((f) => `https://huggingface.co/taejunkim/allinone/resolve/379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19/${f}`),
    ]);
  });

  it("agrees with models/weightmap.json, whose graphs are in the package", async () => {
    const map = await loadWeightMap(); // throws when the map and MODEL_SOURCES / MODEL_FILES disagree
    expect(map.modelSet).toBe(MODEL_SET);
    for (const m of map.models) {
      const graph = readFileSync(join(packagedModelsDir(), m.name));
      expect(graph.length, m.name).toBe(m.graph.bytes);
      expect(sha(graph), m.name).toBe(m.graph.sha256);
    }
  });

  it("ships graphs with no weight bytes: every initializer is external, in its own .weights, as the map says", async () => {
    const map = await loadWeightMap();
    for (const m of map.models) {
      const { initializers } = readModel(readFileSync(join(packagedModelsDir(), m.name)));
      expect(initializers.map((t) => t.name), m.name).toEqual(m.tensors.map((t) => t.name));
      initializers.forEach((t, i) => {
        expect(t.raw, t.name).toBeNull();
        expect(t.external, t.name).toEqual({ location: m.weights.name, offset: String(m.tensors[i].offset), length: String(m.tensors[i].length) });
        expect(t.dims).toEqual(m.tensors[i].dims);
        expect(t.dataType).toBe(1); // float32
      });
    }
  });
});

// The miniature store of tools/hfmodels/make_fixtures.py (its .weights sha256s computed by numpy).
const STORE = join(__dirname, "..", "..", "fixtures", "hfmodels", "store");

let root: string;
let src: string;
let storage: string;
let spec: StoreSpec;
let files: ModelFile[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "models-test-"));
  src = join(root, "src");
  storage = join(root, "storage");
  cpSync(STORE, src, { recursive: true });
  const map = parseWeightMap(readFileSync(join(STORE, "weightmap.json"), "utf8"));
  files = map.models.flatMap((m) => [{ name: m.name, ...m.graph }, { ...m.weights }]);
  spec = { sources: map.sources, files, packagedDir: STORE };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("installFromSources", () => {
  it("builds the store from local checkpoints, and then modelsInstalled is true", async () => {
    expect(await modelsInstalled(storage, files)).toBe(false);
    const dir = await installFromSources(storage, src, undefined, spec);
    expect(dir).toBe(modelDir(storage));
    expect(readdirSync(dir).sort()).toEqual(["alpha.onnx", "alpha.weights", "beta.onnx", "beta.weights", "installed.json"]);
    for (const f of files) expect(sha(readFileSync(join(dir, f.name))), f.name).toBe(f.sha256);
    expect(await modelsInstalled(storage, files)).toBe(true);
    expect(readdirSync(src).sort()).toEqual(readdirSync(STORE).sort()); // the source folder is left as it was
  });

  it("reports build progress up to the weights' total", async () => {
    const seen: [number, number][] = [];
    await installFromSources(storage, src, (d, t) => seen.push([d, t]), spec);
    const total = files.filter((f) => f.name.endsWith(".weights")).reduce((s, f) => s + f.bytes, 0);
    expect(seen.every(([d, t]) => t === total && d <= total)).toBe(true);
    expect(seen.map(([d]) => d)).toEqual([...seen.map(([d]) => d)].sort((a, b) => a - b));
    expect(seen.at(-1)![0]).toBe(total);
  });

  it("builds nothing on a second install", async () => {
    await installFromSources(storage, src, undefined, spec);
    const before = files.map((f) => statSync(join(modelDir(storage), f.name)).mtimeMs);
    writeFileSync(join(src, "lightning.pth"), "corrupt"); // a second install that read it would throw
    await installFromSources(storage, src, undefined, spec);
    expect(files.map((f) => statSync(join(modelDir(storage), f.name)).mtimeMs)).toEqual(before);
  });

  it("throws ModelChecksumError for a changed byte or a missing source, building nothing", async () => {
    const bytes = readFileSync(join(src, "tiny.safetensors"));
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(join(src, "tiny.safetensors"), bytes);
    await expect(installFromSources(storage, src, undefined, spec)).rejects.toBeInstanceOf(ModelChecksumError);
    cpSync(join(STORE, "tiny.safetensors"), join(src, "tiny.safetensors"));
    rmSync(join(src, "lightning.pth"));
    await expect(installFromSources(storage, src, undefined, spec)).rejects.toThrow(/lightning.pth is missing/);
    expect(await modelsInstalled(storage, files)).toBe(false);
  });
});

describe("modelsInstalled", () => {
  it("is false after an installed file is truncated, and a reinstall repairs it", async () => {
    await installFromSources(storage, src, undefined, spec);
    truncateSync(join(modelDir(storage), "beta.weights"), 10);
    expect(await modelsInstalled(storage, files)).toBe(false);
    await installFromSources(storage, src, undefined, spec);
    expect(await modelsInstalled(storage, files)).toBe(true);
    expect(sha(readFileSync(join(modelDir(storage), "beta.weights")))).toBe(files[3].sha256);
  });
  it("is false when installed.json is corrupt", async () => {
    await installFromSources(storage, src, undefined, spec);
    writeFileSync(join(modelDir(storage), "installed.json"), "{not json");
    expect(await modelsInstalled(storage, files)).toBe(false);
  });
  it("is false for a missing directory", async () => {
    expect(await modelsInstalled(join(root, "nope"), files)).toBe(false);
  });
});
