import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readNpy } from "./npy.js";
import { FIXTURES, snrDb } from "./golden.js";
import { testSignal } from "./signals.js";
import { extensionRoot } from "../structure/root.js";
import { analyseStructure, makeAnalyseStructure } from "../structure/engine.js";
import type { Ort } from "../structure/runtime.js";
import { MODEL_SET, MODEL_DOWNLOAD_BYTES, ModelsUnavailableError, ensureModels, modelDir, modelsInstalled } from "../structure/models.js";
import { trackDownbeats } from "../structure/allin1/dbn/downbeats.js";

function npy(descr: string, shape: number[], body: Buffer): Buffer {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const total = 10 + header.length + 1;
  header += " ".repeat((64 - (total % 64)) % 64) + "\n";
  const h = Buffer.alloc(10);
  h.write("\x93NUMPY", 0, "latin1");
  h[6] = 1;
  h[7] = 0;
  h.writeUInt16LE(header.length, 8);
  return Buffer.concat([h, Buffer.from(header, "latin1"), body]);
}

describe("readNpy", () => {
  const dir = mkdtempSync(join(tmpdir(), "npy-"));
  it("reads f4, i2, i4 and f8 in C order", () => {
    const f4 = Buffer.alloc(8); f4.writeFloatLE(1.5, 0); f4.writeFloatLE(-2, 4);
    writeFileSync(join(dir, "a.npy"), npy("<f4", [2], f4));
    const a = readNpy(join(dir, "a.npy"));
    expect(a.shape).toEqual([2]);
    expect(a.data).toBeInstanceOf(Float32Array);
    expect(Array.from(a.data)).toEqual([1.5, -2]);

    const i2 = Buffer.alloc(6); [1, -2, 3].forEach((v, i) => i2.writeInt16LE(v, i * 2));
    writeFileSync(join(dir, "b.npy"), npy("<i2", [1, 3], i2));
    const b = readNpy(join(dir, "b.npy"));
    expect(b.shape).toEqual([1, 3]);
    expect(b.data).toBeInstanceOf(Int16Array);
    expect(Array.from(b.data)).toEqual([1, -2, 3]);

    const i4 = Buffer.alloc(4); i4.writeInt32LE(-7, 0);
    writeFileSync(join(dir, "c.npy"), npy("<i4", [1], i4));
    expect(readNpy(join(dir, "c.npy")).data).toBeInstanceOf(Int32Array);

    const f8 = Buffer.alloc(8); f8.writeDoubleLE(Math.PI, 0);
    writeFileSync(join(dir, "d.npy"), npy("<f8", [], f8));
    const d = readNpy(join(dir, "d.npy"));
    expect(d.shape).toEqual([]);
    expect(d.data).toBeInstanceOf(Float64Array);
    expect(d.data[0]).toBe(Math.PI);
  });
  it("rejects a truncated body instead of zero-filling", () => {
    writeFileSync(join(dir, "t.npy"), npy("<f4", [4], Buffer.alloc(8)));
    expect(() => readNpy(join(dir, "t.npy"))).toThrow(/truncated/);
  });
  it("rejects fortran order and unknown dtypes", () => {
    writeFileSync(join(dir, "e.npy"), npy("<f4", [1], Buffer.alloc(4)).toString("latin1").replace("False", "True ") as never, "latin1");
    expect(() => readNpy(join(dir, "e.npy"))).toThrow(/fortran/);
    writeFileSync(join(dir, "f.npy"), npy("<u2", [1], Buffer.alloc(2)));
    expect(() => readNpy(join(dir, "f.npy"))).toThrow(/dtype|descr/);
  });
});

describe("testSignal", () => {
  it("matches the closed-form expression in float32", () => {
    const n = 1000, rate = 44100;
    const [l, r] = testSignal(n, 2, rate);
    expect(l).toBeInstanceOf(Float32Array);
    expect(l).toHaveLength(n);
    const x = (c: number, i: number) =>
      0.5 * Math.sin(2 * Math.PI * 440 * i / rate + c) +
      0.25 * Math.sin(2 * Math.PI * 1234.5 * (i / rate) * (1 + i / n)) +
      0.1 * Math.sin(2 * Math.PI * 3 * i / rate);
    for (const i of [0, 1, 17, 500, 999]) {
      expect(l[i]).toBe(Math.fround(x(0, i)));
      expect(r[i]).toBe(Math.fround(x(1, i)));
    }
  });
});

describe("testSignal vs the Python generator", () => {
  it("is bit-identical to signal_ref.npy", () => {
    const ref = readNpy(join(FIXTURES, "signal_ref.npy"));
    expect(ref.shape).toEqual([2, 1024]);
    const [l, r] = testSignal(1024, 2, 44100);
    expect(Array.from(ref.data.subarray(0, 1024))).toEqual(Array.from(l));
    expect(Array.from(ref.data.subarray(1024))).toEqual(Array.from(r));
  });
});

describe("snrDb", () => {
  it("is large for near-identical signals and 0 dB when error equals signal", () => {
    const [x] = testSignal(2000, 1, 44100);
    const y = Float32Array.from(x, (v) => v * (1 + 1e-6));
    expect(snrDb(x, y)).toBeGreaterThan(100);
    expect(snrDb(x, new Float32Array(x.length))).toBeCloseTo(0, 6);
    expect(snrDb(x, x)).toBe(Infinity);
  });
});

describe("structure stubs", () => {
  it("engine rejects an input it cannot read (Task 9 replaced the stub)", async () => {
    // A stub loadOrt (review M2): the real one would copy 45 MB of onnxruntime into a shared $TMPDIR/runtime.
    expect(typeof analyseStructure).toBe("function");
    const engine = makeAnalyseStructure({
      loadOrt: () => ({}) as Ort,
      openDemucsCore: () => Promise.reject(new Error("not reached")),
      runFolds: () => Promise.reject(new Error("not reached")),
      trackDownbeats,
      flushReleasedMemory: async () => {},
    });
    const temp = mkdtempSync(join(tmpdir(), "ss-plumbing-"));
    try {
      const env = { modelDir: "", tempDir: temp, extensionRoot: process.cwd(), storageDir: temp };
      await expect(engine(join(temp, "no-such-file.wav"), env, new AbortController().signal, () => {})).rejects.toThrow(/ENOENT|no such file/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("models stub", async () => {
    expect(MODEL_SET).toBe("allin1-htdemucs-hf-v1");
    expect(MODEL_DOWNLOAD_BYTES).toBe(95_230_008);
    expect(modelDir("/s")).toBe(join("/s", "models", MODEL_SET));
    expect(await modelsInstalled("/s")).toBe(false);
    // Nothing is fetched once aborted (the real download needs the user's consent: flow.ts).
    const aborted = new AbortController();
    aborted.abort();
    await expect(ensureModels({ storageDir: "/s", signal: aborted.signal, onProgress: () => {} })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("trackDownbeats (Task 7) resolves empty when no activation reaches the threshold", async () => {
    expect(await trackDownbeats(new Float32Array(4).fill(-10), new Float32Array(4).fill(-10))).toEqual({ beats: [], positions: [] });
  });
  it("extensionRoot is the directory holding manifest.json", () => {
    expect(existsSync(join(extensionRoot(), "manifest.json"))).toBe(true);
    expect(existsSync(join(extensionRoot(), "package.json"))).toBe(true);
  });
  it("ModelsUnavailableError names itself", () => {
    expect(new ModelsUnavailableError("x").name).toBe("ModelsUnavailableError");
  });
});
