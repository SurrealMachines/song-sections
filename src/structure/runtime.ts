import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { join } from "node:path";
import { runInThisContext } from "node:vm";

/** Only `InferenceSession`, `Tensor` and `env` are used downstream. */
export type Ort = typeof import("onnxruntime-node");

/** What Plan 4's mode picker shows when the engine cannot run on this machine. */
export const UNSUPPORTED_PLATFORM_MESSAGE = "Structure needs an Apple Silicon Mac (or Windows x64, later)";

/** The same, for an Apple Silicon Mac whose Live is opened using Rosetta (the host then runs as x64). */
export const ROSETTA_MESSAGE =
  'Structure can\'t run while Live is opened using Rosetta. Quit Live, select it in Finder, choose File > Get Info, turn off "Open using Rosetta", then open Live again.';

/**
 * The machine cannot run the structure engine: onnxruntime-node ships no Intel-Mac binary, and Live
 * under Rosetta runs the host as x64. Typed so the UI can show `message` instead of a generic failure;
 * `rosetta` is true when this is an Apple Silicon Mac running Live under Rosetta (fixable by the user).
 */
export class OrtUnsupportedPlatformError extends Error {
  constructor(
    readonly platform: string,
    readonly arch: string,
    readonly rosetta = false,
  ) {
    super(rosetta ? ROSETTA_MESSAGE : UNSUPPORTED_PLATFORM_MESSAGE);
    this.name = "OrtUnsupportedPlatformError";
  }
}

/** Platforms onnxruntime-node 1.31.1 ships a binary for that Live also runs on. */
const SUPPORTED = new Set(["darwin-arm64", "win32-x64", "win32-arm64"]);

export interface Target {
  platform: string;
  arch: string;
  /** `os.cpus()[0].model`; read from the machine when absent. */
  cpuModel?: string;
}

/**
 * True for an x64 process on an Apple Silicon Mac, i.e. Rosetta. Under Rosetta `process.arch` is "x64" but
 * `os.cpus()[0].model` still names the real chip ("Apple M2 Pro", measured with Live's node under
 * `arch -x86_64`); an Intel Mac reports "Intel(R) …". No child process or sysctl needed.
 */
export function runningUnderRosetta(target: Target = process): boolean {
  if (target.platform !== "darwin" || target.arch !== "x64") return false;
  const model = target.cpuModel ?? cpus()[0]?.model ?? "";
  return /^Apple\b/.test(model);
}

export function assertSupportedPlatform(target: Target = process): void {
  if (!SUPPORTED.has(`${target.platform}-${target.arch}`)) {
    throw new OrtUnsupportedPlatformError(target.platform, target.arch, runningUnderRosetta(target));
  }
}

const cache = new Map<string, { ort: Ort; source: string }>();
let lastSource: string | undefined;

/** Directory the last `loadOrt` loaded onnxruntime-node from (for logs and the probe). */
export function ortSource(): string | undefined {
  return lastSource;
}

/** The version build.ts ships and the goldens were made with; ensureRuntimeCopy checks the shipped copy against it. */
export const ORT_VERSION = "1.31.1";

const MANIFEST = ".manifest.json";

function packageVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
}

function listFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? join(base, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

export function runtimeDir(storageDir: string, target: Target = process, version = ORT_VERSION): string {
  return join(storageDir, "runtime", `onnxruntime-${version}-${target.platform}-${target.arch}`);
}

/**
 * True when `dest` holds a finished copy: its manifest (written last) exists and every file listed in it
 * is there with the recorded size. Reads storage only, never the extension root.
 */
export function copyIsComplete(dest: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dest, MANIFEST), "utf8")) as { files: Record<string, number> };
    return Object.entries(manifest.files).every(([rel, size]) => statSync(join(dest, rel)).size === size);
  } catch {
    return false;
  }
}

/**
 * Copies `<nativeDir>` (the `native/` shipped next to `dist/`) into
 * `<storageDir>/runtime/onnxruntime-<version>-<platform>-<arch>/` and returns that directory.
 * Plan constraint: the host only reads storage/temp, native code included, so the shipped copy is read
 * once here and everything after loads from storage. A finished copy is recognised by its manifest
 * (relative path -> size, written last), so later starts do not touch the extension root at all; a missing
 * or short file triggers a repair. Size, not a hash: hashing the 45 MB library on every start is not worth
 * it. Every file is written under a temporary name and renamed, so an interrupted copy never leaves a
 * short file that looks complete. Synchronous: about 47 MB the first time, nothing afterwards. Older
 * version directories are left alone.
 */
export function ensureRuntimeCopy(
  nativeDir: string,
  storageDir: string,
  target: Target = process,
  version = ORT_VERSION,
): string {
  const dest = runtimeDir(storageDir, target, version);
  if (copyIsComplete(dest)) return dest;
  const shipped = packageVersion(join(nativeDir, "node_modules", "onnxruntime-node"));
  if (shipped !== version) throw new Error(`native/ ships onnxruntime-node ${shipped}, expected ${version}`);
  const files: Record<string, number> = {};
  for (const rel of listFiles(nativeDir).filter((f) => forTarget(f, target))) {
    const from = join(nativeDir, rel);
    const to = join(dest, rel);
    const size = statSync(from).size;
    files[rel] = size;
    if (existsSync(to) && statSync(to).size === size) continue;
    mkdirSync(join(to, ".."), { recursive: true });
    writeAtomically(to, (tmp) => copyFileSync(from, tmp));
  }
  writeAtomically(join(dest, MANIFEST), (tmp) => writeFileSync(tmp, JSON.stringify({ version, files })));
  return dest;
}

/**
 * False for a file under another platform's `bin/napi-v6/<platform>/<arch>/`: one package ships the binaries for
 * every supported platform (build.ts), and storage keeps only this machine's.
 */
function forTarget(rel: string, target: Target): boolean {
  const m = /(?:^|[\\/])bin[\\/]napi-v\d+[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]/.exec(rel);
  return !m || (m[1] === target.platform && m[2] === target.arch);
}

function writeAtomically(to: string, write: (tmp: string) => void): void {
  const tmp = `${to}.tmp-${process.pid}`;
  try {
    write(tmp);
    renameSync(tmp, to);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** hasPackage, with a permission error made self-explanatory (it is the Branch A' risk: see findings E2). */
function readableNative(nativeDir: string): boolean {
  try {
    return hasPackage(nativeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw error;
    throw Object.assign(
      new Error(
        `The host does not allow reading ${nativeDir}, which is needed once to copy onnxruntime into the storage directory`,
        { cause: error },
      ),
      { code: "ERR_ACCESS_DENIED" },
    );
  }
}

/** Requires onnxruntime-node from `<dir>/node_modules` by absolute path: no walking up to other node_modules. */
function requireFrom(dir: string): Ort {
  const pkg = join(dir, "node_modules", "onnxruntime-node");
  return createRequire(join(dir, "package.json"))(pkg) as Ort;
}

/** False when absent; a permission error is not "absent" and surfaces. */
function hasPackage(dir: string): boolean {
  try {
    return statSync(join(dir, "node_modules", "onnxruntime-node", "package.json")).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Loads ONNX Runtime. The host does not resolve node_modules at runtime, so build.ts ships it as
 * `<extensionRoot>/native/node_modules`.
 *
 * - With `storageDir` (always, in the host): the shipped copy is first copied to storage
 *   (ensureRuntimeCopy) and loaded from there; once a finished copy exists the extension root is not read.
 * - With `storageDir` undefined (tests and dev scripts only), or when there is no shipped copy (a checkout without
 *   `npm run build`): the shipped copy is loaded in place, else the project's own node_modules.
 *
 * `storageDir` is required (`undefined` must be spelled out) so that no host caller can skip Branch A′ by
 * forgetting it: in the host, pass `context.environment.storageDirectory`.
 *
 * A shipped copy that exists but fails to load (missing `.node`, access denied, dlopen error) throws that
 * error unchanged; only an absent copy falls back. Throws OrtUnsupportedPlatformError on a machine with no
 * binary (Intel Mac, Rosetta). Cached per (root, storageDir); a different root loads again.
 */
export function loadOrt(extensionRoot: string, storageDir: string | undefined, target: Target = process): Ort {
  assertSupportedPlatform(target);
  const key = `${extensionRoot}|${storageDir ?? ""}|${target.platform}-${target.arch}`;
  const hit = cache.get(key);
  if (hit) {
    lastSource = hit.source;
    return hit.ort;
  }
  const nativeDir = join(extensionRoot, "native");
  let source: string;
  let ort: Ort;
  const finished = storageDir && copyIsComplete(runtimeDir(storageDir, target)) ? runtimeDir(storageDir, target) : undefined;
  if (finished || readableNative(nativeDir)) {
    source = finished ?? (storageDir ? ensureRuntimeCopy(nativeDir, storageDir, target) : nativeDir);
    ort = requireFrom(source);
  } else {
    source = join(extensionRoot, "node_modules");
    try {
      ort = createRequire(join(extensionRoot, "package.json"))("onnxruntime-node") as Ort;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      throw new Error(
        `onnxruntime-node not found in ${join(nativeDir, "node_modules")} or ${source} ` +
          `(${target.platform}/${target.arch}); run the build so native/ is created`,
        { cause: error },
      );
    }
  }
  cache.set(key, { ort, source });
  lastSource = source;
  return ort;
}

// ---------------------------------------------------------------------------------------------
// Cross-realm helpers. Live's host runs the extension in its own V8 context while onnxruntime is
// loaded in the host's main realm (findings E1). Three traps follow; downstream code must use these
// helpers, and unit tests in one realm cannot reveal a missing one.
//   1. Tensor inputs: `new ort.Tensor("float32", data, dims)` rejects a Float32Array from our realm
//      ("A float32 tensor's data must be type of function Float32Array()"). Wrap with hostFloat32().
//   2. `InferenceSession.create(bytes)` rejects a Uint8Array from our realm ("Unexpected argument[0]:
//      must be 'path' or 'buffer'"). Pass a file path, or wrap with hostUint8().
//   3. Errors thrown by ORT fail `e instanceof Error` here. Use isError() / errorMessage().
//   Outputs: `tensor.data` is a host-realm typed array, so `instanceof Float32Array` is false in
//   the host. Index it, or take a zero-copy view in our realm with localFloat32().
// ---------------------------------------------------------------------------------------------

type TypedCtor<T> = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T;

let hostF32: Float32ArrayConstructor | undefined;
let hostU8: Uint8ArrayConstructor | undefined;

/** Zero-copy re-wrap of `data` as a Float32Array of the realm onnxruntime lives in (trap 1). */
export function hostFloat32(data: Float32Array): Float32Array {
  const F32 = (hostF32 ??= runInThisContext("Float32Array") as Float32ArrayConstructor);
  if ((data as object) instanceof F32) return data;
  return new (F32 as unknown as TypedCtor<Float32Array>)(data.buffer, data.byteOffset, data.length);
}

/** Zero-copy re-wrap of `data` as a Uint8Array of the realm onnxruntime lives in (trap 2). */
export function hostUint8(data: Uint8Array): Uint8Array {
  const U8 = (hostU8 ??= runInThisContext("Uint8Array") as Uint8ArrayConstructor);
  if ((data as object) instanceof U8) return data;
  return new (U8 as unknown as TypedCtor<Uint8Array>)(data.buffer, data.byteOffset, data.length);
}

/** Zero-copy view of an ORT output (any realm) as a Float32Array of our realm. */
export function localFloat32(data: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number }): Float32Array {
  return new Float32Array(data.buffer, data.byteOffset, data.length);
}

/** `instanceof Error` that also accepts an Error from another realm (trap 3). */
export function isError(value: unknown): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

export function errorMessage(value: unknown): string {
  return isError(value) ? value.message : String(value);
}
