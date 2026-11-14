import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext, runInThisContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { modelsDir } from "../test/golden.js";
import { isShippedNativeFile } from "./nativeFiles.js";
import {
  OrtUnsupportedPlatformError,
  ROSETTA_MESSAGE,
  UNSUPPORTED_PLATFORM_MESSAGE,
  assertSupportedPlatform,
  ORT_VERSION,
  copyIsComplete,
  ensureRuntimeCopy,
  errorMessage,
  hostFloat32,
  hostUint8,
  isError,
  loadOrt,
  localFloat32,
  ortSource,
} from "./runtime.js";

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ss-runtime-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch (error) {
      if (process.platform !== "win32") throw error; // Windows will not delete a DLL this process has loaded
    }
  }
});

const supportedHere = (() => {
  try {
    assertSupportedPlatform();
    return true;
  } catch {
    return false;
  }
})();

/** A `native/` like build.ts writes (current platform only), or one missing its binding. */
function makeNative(root: string, { withBinary = true } = {}): string {
  const native = join(root, "native");
  const modules = join(process.cwd(), "node_modules");
  for (const pkg of ["onnxruntime-node", "onnxruntime-common"]) {
    cpSync(join(modules, pkg, "package.json"), join(native, "node_modules", pkg, "package.json"));
    cpSync(join(modules, pkg, "dist"), join(native, "node_modules", pkg, "dist"), { recursive: true });
  }
  if (withBinary) {
    const bin = join("bin", "napi-v6", process.platform, process.arch);
    cpSync(join(modules, "onnxruntime-node", bin), join(native, "node_modules", "onnxruntime-node", bin), {
      recursive: true,
      filter: isShippedNativeFile,
    });
  }
  writeFileSync(join(native, "package.json"), '{"private":true}\n');
  return native;
}

describe("loadOrt", () => {
  it("returns onnxruntime with InferenceSession, Tensor and env", () => {
    const ort = loadOrt(process.cwd(), undefined);
    expect(typeof ort.InferenceSession).toBe("function");
    expect(typeof ort.Tensor).toBe("function");
    expect(ort.env).toBeDefined();
  });

  it("takes storageDir as a required argument, so no caller skips the storage copy by accident", () => {
    // @ts-expect-error storageDir must be passed (a string in the host, undefined only in tests)
    const forgot = () => loadOrt(process.cwd());
    expect(typeof forgot).toBe("function"); // checked by tsc, not run
  });

  it("caches the module per root", () => {
    expect(loadOrt(process.cwd(), undefined)).toBe(loadOrt(process.cwd(), undefined));
  });

  it("falls back to the project's node_modules when there is no native copy", () => {
    const root = tmp();
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{"private":true}');
    expect(typeof loadOrt(root, undefined).InferenceSession).toBe("function");
    expect(ortSource()).toBe(join(root, "node_modules"));
  });

  it("names both locations and the platform when nothing is installed", () => {
    const root = tmp();
    const run = () => loadOrt(root, undefined);
    expect(run).toThrow(/onnxruntime-node not found in .*native.*node_modules or .*node_modules .*\(\w+\/\w+\)/);
  });

  it.skipIf(!supportedHere)("surfaces the real error when the shipped binding is missing (no fallback)", () => {
    const root = tmp();
    makeNative(root, { withBinary: false });
    let message = "";
    try {
      loadOrt(root, undefined);
    } catch (e) {
      message = errorMessage(e);
    }
    expect(message).toContain("onnxruntime_binding.node");
    expect(message).not.toContain("Cannot find module 'onnxruntime-node'");
  });

  it.skipIf(!supportedHere)("surfaces the real error for a half-copied native through storage too", () => {
    const root = tmp();
    makeNative(root, { withBinary: false });
    expect(() => loadOrt(root, tmp())).toThrow(/onnxruntime_binding\.node/);
  });

  it.skipIf(!supportedHere)("with a storage dir copies native/ there once and loads from the copy", () => {
    const root = tmp();
    const storage = tmp();
    makeNative(root);
    const ort = loadOrt(root, storage);
    const dest = join(storage, "runtime", `onnxruntime-1.31.1-${process.platform}-${process.arch}`);
    expect(ortSource()).toBe(dest);
    expect(typeof ort.InferenceSession).toBe("function");
    expect(new ort.Tensor("float32", new Float32Array(3), [3]).dims).toEqual([3]);
    // the loaded .node comes from storage, not from the extension root
    expect(existsSync(join(dest, "node_modules", "onnxruntime-node", "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node"))).toBe(true);
    // once copied, a start never reads the extension root again
    const elsewhere = tmp(); // a root with no native/ and no node_modules
    const again = loadOrt(elsewhere, storage);
    expect(ortSource()).toBe(dest);
    expect(typeof again.InferenceSession).toBe("function");
  });
});

describe("ensureRuntimeCopy", () => {
  const fakeNative = () => {
    const native = tmp();
    mkdirSync(join(native, "node_modules", "onnxruntime-node", "dist"), { recursive: true });
    writeFileSync(join(native, "node_modules", "onnxruntime-node", "package.json"), '{"version":"9.9.9"}');
    writeFileSync(join(native, "node_modules", "onnxruntime-node", "dist", "a.js"), "aaaa");
    writeFileSync(join(native, "package.json"), '{"private":true}');
    return native;
  };
  const target = { platform: "darwin", arch: "arm64" };

  it("names the directory <version>-<platform>-<arch> under runtime/", () => {
    const storage = tmp();
    const dest = ensureRuntimeCopy(fakeNative(), storage, target, "9.9.9");
    expect(dest).toBe(join(storage, "runtime", "onnxruntime-9.9.9-darwin-arm64"));
    expect(statSync(join(dest, "node_modules", "onnxruntime-node", "dist", "a.js")).size).toBe(4);
  });

  it("skips files whose size matches and repairs files whose size differs", () => {
    const native = fakeNative();
    const storage = tmp();
    const dest = ensureRuntimeCopy(native, storage, target, "9.9.9");
    const a = join(dest, "node_modules", "onnxruntime-node", "dist", "a.js");
    const before = statSync(a).mtimeMs;
    ensureRuntimeCopy(native, storage, target, "9.9.9");
    expect(statSync(a).mtimeMs).toBe(before);
    truncateSync(a, 2); // a short file from an interrupted copy
    ensureRuntimeCopy(native, storage, target, "9.9.9");
    expect(statSync(a).size).toBe(4);
  });

  it("refuses a native/ whose version differs from the expected one", () => {
    expect(() => ensureRuntimeCopy(fakeNative(), tmp(), target, "1.0.0")).toThrow(/ships onnxruntime-node 9\.9\.9, expected 1\.0\.0/);
  });

  it("recognises a finished copy by manifest and sizes only, and never reads native/ for it", () => {
    const native = fakeNative();
    const storage = tmp();
    const dest = ensureRuntimeCopy(native, storage, target, "9.9.9");
    expect(copyIsComplete(dest)).toBe(true);
    rmSync(native, { recursive: true, force: true });
    expect(ensureRuntimeCopy(native, storage, target, "9.9.9")).toBe(dest);
    rmSync(join(dest, "package.json"));
    expect(copyIsComplete(dest)).toBe(false);
  });

  it("the expected version is the one installed", () => {
    expect(ORT_VERSION).toBe(JSON.parse(readFileSync(join(process.cwd(), "node_modules/onnxruntime-node/package.json"), "utf8")).version);
  });

  it("copies only the binary directory of the machine it runs on, from a native/ that ships several", () => {
    const native = fakeNative();
    const bin = (p: string, a: string) => join(native, "node_modules", "onnxruntime-node", "bin", "napi-v6", p, a);
    for (const [p, a] of [["darwin", "arm64"], ["win32", "x64"]]) {
      mkdirSync(bin(p, a), { recursive: true });
      writeFileSync(join(bin(p, a), "onnxruntime_binding.node"), `${p}-${a}`);
    }
    const storage = tmp();
    const dest = ensureRuntimeCopy(native, storage, { platform: "win32", arch: "x64" }, "9.9.9");
    const copied = join(dest, "node_modules", "onnxruntime-node", "bin", "napi-v6");
    expect(readFileSync(join(copied, "win32", "x64", "onnxruntime_binding.node"), "utf8")).toBe("win32-x64");
    expect(existsSync(join(copied, "darwin"))).toBe(false);
    expect(existsSync(join(dest, "node_modules", "onnxruntime-node", "dist", "a.js"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dest, ".manifest.json"), "utf8")) as { files: Record<string, number> };
    expect(Object.keys(manifest.files).some((f) => f.includes("darwin"))).toBe(false);
    expect(copyIsComplete(dest)).toBe(true);
  });

  it("leaves no temporary files behind", () => {
    const dest = ensureRuntimeCopy(fakeNative(), tmp(), target, "9.9.9");
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(existsSync(join(dest, `package.json.tmp-${process.pid}`))).toBe(false);
  });
});

describe("platform support", () => {
  it("supports Apple Silicon and Windows", () => {
    expect(() => assertSupportedPlatform({ platform: "darwin", arch: "arm64" })).not.toThrow();
    expect(() => assertSupportedPlatform({ platform: "win32", arch: "x64" })).not.toThrow();
  });

  it("throws one typed error with the user-facing message on an Intel Mac or Linux", () => {
    for (const target of [
      { platform: "darwin", arch: "x64", cpuModel: "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz" },
      { platform: "linux", arch: "x64", cpuModel: "AMD EPYC 7B13" },
    ]) {
      let error: unknown;
      try {
        loadOrt(process.cwd(), undefined, target);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OrtUnsupportedPlatformError);
      expect((error as OrtUnsupportedPlatformError).message).toBe(UNSUPPORTED_PLATFORM_MESSAGE);
      expect((error as OrtUnsupportedPlatformError).message).toBe("Structure needs an Apple Silicon Mac (or Windows x64, later)");
      expect((error as OrtUnsupportedPlatformError).arch).toBe(target.arch);
      expect((error as OrtUnsupportedPlatformError).rosetta).toBe(false);
    }
  });

  it("tells an Apple Silicon user whose Live runs under Rosetta to turn Rosetta off", () => {
    // Measured with Live's node under `arch -x86_64`: process.arch "x64", os.cpus()[0].model "Apple M2 Pro".
    let error: unknown;
    try {
      assertSupportedPlatform({ platform: "darwin", arch: "x64", cpuModel: "Apple M2 Pro" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrtUnsupportedPlatformError);
    expect((error as OrtUnsupportedPlatformError).rosetta).toBe(true);
    expect((error as OrtUnsupportedPlatformError).message).toBe(ROSETTA_MESSAGE);
    expect(ROSETTA_MESSAGE).toMatch(/Open using Rosetta/);
    expect(ROSETTA_MESSAGE).not.toMatch(/needs an Apple Silicon Mac/);
  });

  it("reads the CPU model from the machine when the target does not give one", () => {
    // On this (Apple Silicon) machine a faked darwin/x64 target looks exactly like Rosetta.
    const here = assertSupportedPlatformError({ platform: "darwin", arch: "x64" });
    const model = cpus()[0]?.model ?? "";
    expect(here?.rosetta).toBe(/^Apple\b/.test(model));
  });
});

function assertSupportedPlatformError(target: { platform: string; arch: string }): OrtUnsupportedPlatformError | undefined {
  try {
    assertSupportedPlatform(target);
  } catch (e) {
    return e as OrtUnsupportedPlatformError;
  }
  return undefined;
}

describe("native file filter", () => {
  it("drops DirectML and every other non-CPU provider, and the duplicate dylib", () => {
    for (const p of [
      "bin/napi-v6/win32/x64/DirectML.dll",
      "bin/napi-v6/win32/x64/dxcompiler.dll",
      "bin/napi-v6/win32/x64/dxil.dll",
      "bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so",
      "bin/napi-v6/win32/x64/onnxruntime_providers_shared.dll",
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.31.1.dylib",
    ]) {
      expect(isShippedNativeFile(p), p).toBe(false);
    }
  });

  it("keeps the CPU runtime and the binding", () => {
    for (const p of [
      "bin/napi-v6/win32/x64/onnxruntime.dll",
      "bin/napi-v6/win32/x64/onnxruntime_binding.node",
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "dist/index.js",
    ]) {
      expect(isShippedNativeFile(p), p).toBe(true);
    }
  });
});

describe("cross-realm helpers (a vm context stands in for the host's sandbox)", () => {
  const ort = () => loadOrt(process.cwd(), undefined);
  const foreignF32 = () => runInNewContext("new Float32Array([1,2,3,4])") as Float32Array;

  it("a Float32Array from another realm is rejected by Tensor, hostFloat32 fixes it and shares memory", () => {
    const foreign = foreignF32();
    expect(foreign instanceof Float32Array).toBe(false);
    expect(() => new (ort().Tensor)("float32", foreign.subarray(1), [3])).toThrow(/float32 tensor's data must be type of/);

    const wrapped = hostFloat32(foreign.subarray(1));
    expect(wrapped instanceof (runInThisContext("Float32Array") as typeof Float32Array)).toBe(true);
    const tensor = new (ort().Tensor)("float32", wrapped, [3]);
    expect([...(tensor.data as Float32Array)]).toEqual([2, 3, 4]);
    expect(wrapped.byteOffset).toBe(4);
    wrapped[0] = 9;
    expect(foreign[1]).toBe(9); // zero-copy, offset kept
  });

  it("uses the same Float32Array constructor as ORT's own tensors", () => {
    const ortCtor = new (ort().Tensor)("float32", [0], [1]).data.constructor;
    expect(hostFloat32(foreignF32()).constructor).toBe(ortCtor);
  });

  it("passes a same-realm array through unchanged", () => {
    const a = new Float32Array(4);
    expect(hostFloat32(a)).toBe(a);
  });

  it("InferenceSession.create rejects a foreign Uint8Array; hostUint8 gets it past argument checking", async () => {
    const foreign = runInNewContext("new Uint8Array([1,2,3,4])") as Uint8Array;
    await expect(ort().InferenceSession.create(foreign)).rejects.toThrow(/Unexpected argument\[0\]/);
    let message = "";
    try {
      await ort().InferenceSession.create(hostUint8(foreign));
    } catch (e) {
      message = errorMessage(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toMatch(/Unexpected argument\[0\]/); // now it is a model-parse error
  });

  it("isError / errorMessage accept an Error from another realm", () => {
    const foreign = runInNewContext("new Error('boom')") as Error;
    expect(foreign instanceof Error).toBe(false);
    expect(isError(foreign)).toBe(true);
    expect(errorMessage(foreign)).toBe("boom");
    expect(isError({ message: "no" })).toBe(false);
    expect(errorMessage("text")).toBe("text");
  });

  it("localFloat32 gives a zero-copy view in our realm of a foreign array", () => {
    const foreign = foreignF32();
    const view = localFloat32(foreign.subarray(2));
    expect(view instanceof Float32Array).toBe(true);
    expect([...view]).toEqual([3, 4]);
    view[0] = 7;
    expect(foreign[2]).toBe(7);
  });
});

describe.skipIf(!modelsDir())("allin1 fold 0 on zeros", () => {
  it("runs and returns the expected finite output shapes", async () => {
    const ort = loadOrt(process.cwd(), undefined);
    const session = await ort.InferenceSession.create(join(modelsDir()!, "allin1_harmonix_fold0.onnx"));
    try {
      const spec = new ort.Tensor("float32", hostFloat32(new Float32Array(1 * 4 * 600 * 81)), [1, 4, 600, 81]);
      const out = await session.run({ spec });
      const dims = (k: string) => [...out[k].dims];
      expect(dims("logits_beat")).toEqual([1, 600]);
      expect(dims("logits_downbeat")).toEqual([1, 600]);
      expect(dims("logits_section")).toEqual([1, 600]);
      expect(dims("logits_function")).toEqual([1, 10, 600]);
      for (const k of ["logits_beat", "logits_downbeat", "logits_section", "logits_function"]) {
        expect((out[k].data as Float32Array).every(Number.isFinite)).toBe(true);
      }
    } finally {
      await session.release();
    }
  });
});
