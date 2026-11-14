// Model store (Plan 3, Tasks 5 and 12; fb/hfmodels). The extension ships only the weightless ONNX graphs and a weight
// map (models/ in the package, from tools/hfmodels/build_models.py). With the user's consent, ensureModels downloads
// the authors' checkpoints from Hugging Face (pinned revisions, sha256-checked), builds each graph's `<name>.weights`
// from them (checked against the sha256 recorded at build time) and keeps graphs and weights in
// <storageDir>/models/<MODEL_SET>/. The initializer bytes are those of the v1 single-file models, so analyses match.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { abortError, throwIfAborted } from "../core/abort.js";
import type { EnsureModelsOptions, ModelsPhase } from "./contract.js";
import { extensionRoot } from "./root.js";
import { openCheckpoint, type Checkpoint } from "./weights/checkpoint.js";
import { buildWeights, parseWeightMap, type SourceFile, type WeightMap } from "./weights/weightMap.js";

export type { SourceFile } from "./weights/weightMap.js";

/** v1 was "allin1-htdemucs-onnx-v1" (single-file models from Matt's host); its folder is left alone. */
export const MODEL_SET = "allin1-htdemucs-hf-v1";

const ALLIN1 = { repo: "taejunkim/allinone", revision: "379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19" };
const DEMUCS = { repo: "adefossez/HTDemucs", revision: "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003" };

/**
 * What ensureModels downloads, in order: HT Demucs (Meta, Alexandre Défossez; float16 safetensors) and the 8 allin1
 * folds (Taejun Kim, MIT; torch.save checkpoints). Sizes and sha256 as the Hugging Face API lists them (31 Oct 2026).
 */
export const MODEL_SOURCES: SourceFile[] = [
  { file: "955717e8.safetensors", ...DEMUCS, bytes: 84025440, sha256: "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd" },
  { file: "harmonix-fold0-0vra4ys2.pth", ...ALLIN1, bytes: 1400571, sha256: "0db596dfb0995f41d62f6267d76a9d54c046f1649bd35e1dbeca0c5f9a7b8acd" },
  { file: "harmonix-fold1-3ozjhtsj.pth", ...ALLIN1, bytes: 1400571, sha256: "607b4864eaabccd4f6951410d5ea6676666ad1cfa6ce2e18bc99f3824b77c3b7" },
  { file: "harmonix-fold2-gmgo0nsy.pth", ...ALLIN1, bytes: 1400571, sha256: "67c28ec7ca612d365e5fcb152f6530eb53e34c4303940afb30fd17a295c958a4" },
  { file: "harmonix-fold3-i92b7m8p.pth", ...ALLIN1, bytes: 1400571, sha256: "446d05672b2669cdb7d9b8bbbc228a4f3592484335a7995cca89a744e3950ddc" },
  { file: "harmonix-fold4-1bql5qo0.pth", ...ALLIN1, bytes: 1400571, sha256: "96327222ab9b33c005388b788ba602f529aa03cc4dde1c859c011f1004490493" },
  { file: "harmonix-fold5-x4z5zeef.pth", ...ALLIN1, bytes: 1400571, sha256: "c87f162a1090290bcbb863688746784919cf912c56744fb3d81a1a7dba3b114e" },
  { file: "harmonix-fold6-x7t226rq.pth", ...ALLIN1, bytes: 1400571, sha256: "13e7e639bf30fcd3fa049ad863088773a4e57b06d7c68581385b3ef625c60688" },
  { file: "harmonix-fold7-qwwskhg6.pth", ...ALLIN1, bytes: 1400571, sha256: "b888b7fba95efa3d5a37ca013fe7efe2741621ea9ca335e6b2723e4fd0fade57" },
];

export interface ModelFile {
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * What an installed store holds: for the Demucs core and the 8 allin1 folds (never allin1_harmonix_all, ruling S8),
 * the weightless graph and its `.weights`. The checksums are models/weightmap.json's (a test keeps them equal).
 */
export const MODEL_FILES: ModelFile[] = [
  { name: "htdemucs_core.onnx", bytes: 775905, sha256: "85c2386ccaa8da5a4e88fd372cdb218c82f7d474b91a85ed2b52fe6becb991d7" },
  { name: "htdemucs_core.weights", bytes: 167939968, sha256: "4b802069761a97a16dff32d6669efa99151f904ff5aa91925e12aad111162184" },
  { name: "allin1_harmonix_fold0.onnx", bytes: 1505465, sha256: "59e614590cbce264f859b6e8d7b23798347c70582426b4137d67e9582250f81d" },
  { name: "allin1_harmonix_fold0.weights", bytes: 1211840, sha256: "fd49e246e38ad5c7d8b366eb7d1a6ee28cb88be0adcb05f7b1aa80eeeaa24c4e" },
  { name: "allin1_harmonix_fold1.onnx", bytes: 1505465, sha256: "0ff1bd33a613127ce4e2a41534a101471cfa9429bb986c31562bf623046259e5" },
  { name: "allin1_harmonix_fold1.weights", bytes: 1211840, sha256: "b9ab29d5b1b573a4e4ad1a95c2959a4c36b03496a77cc26ebc808265ab3d8c9c" },
  { name: "allin1_harmonix_fold2.onnx", bytes: 1505465, sha256: "d39b384dd190938c699a2fec63c56ca6cc3e086948e740faa8e5c7d232f578e8" },
  { name: "allin1_harmonix_fold2.weights", bytes: 1211840, sha256: "333c019f792156bb2080e2db1f90a027862eaa91158e771ef01ad7d22568e729" },
  { name: "allin1_harmonix_fold3.onnx", bytes: 1505465, sha256: "502ebd72ea2b4c6a4bad3d71d9f3943d9eb1c08e594be345c98f5b27ce61cdf8" },
  { name: "allin1_harmonix_fold3.weights", bytes: 1211840, sha256: "30544736b35779f5b3722d8583e339b7d41f2e3aea330e3b9a04471fe095f6b6" },
  { name: "allin1_harmonix_fold4.onnx", bytes: 1505465, sha256: "9454a2ae1967bbfd4d1ada84f7b6cf549edcaf3bacaf204b6d2f52fe9057abe3" },
  { name: "allin1_harmonix_fold4.weights", bytes: 1211840, sha256: "b51f7814628f36f3626673dccbfd61aa86c1bd010193721c4e7b51ec03801c4b" },
  { name: "allin1_harmonix_fold5.onnx", bytes: 1505465, sha256: "794fa523846e77c8d8b1f9044870a582b18f3c117284a595d7df0c75e1de8a8e" },
  { name: "allin1_harmonix_fold5.weights", bytes: 1211840, sha256: "892e5a784e2091642578e2b4259ee7c2c6c4a8c7a430f9c5f806a97974183eed" },
  { name: "allin1_harmonix_fold6.onnx", bytes: 1505465, sha256: "5f01438cf74d0e1e1fda77dc392e021c0b799ee393ffa5611da7d19c68497afd" },
  { name: "allin1_harmonix_fold6.weights", bytes: 1211840, sha256: "69d8cc14922cacd17cf631d71cd43618e853f9e29b707eb23a0e3197eff59acb" },
  { name: "allin1_harmonix_fold7.onnx", bytes: 1505465, sha256: "9cbe4b40c1a13ce3a4b5a848eb4d4085239c73a9eb7741ce49417d74ae47acf5" },
  { name: "allin1_harmonix_fold7.weights", bytes: 1211840, sha256: "f92d0cbaab99321af59b1d1e93d21e5a75be5ed12a8123e8019f61da67976936" },
];

const sum = (files: { bytes: number }[]) => files.reduce((s, f) => s + f.bytes, 0);
/** What the consent prompt quotes: about 95 MB downloaded, about 190 MB on disk once built. */
export const MODEL_DOWNLOAD_BYTES = sum(MODEL_SOURCES);
export const MODEL_DISK_BYTES = sum(MODEL_FILES);

/** `https://huggingface.co/<repo>/resolve/<revision>/<file>`: redirects to Hugging Face's CDN (fetch follows it). */
export function sourceUrl(s: SourceFile): string {
  return `https://huggingface.co/${s.repo}/resolve/${s.revision}/${encodeURIComponent(s.file)}`;
}

export class ModelsUnavailableError extends Error {
  override name = "ModelsUnavailableError";
}

export class ModelChecksumError extends Error {
  override name = "ModelChecksumError";
}

/**
 * Review m4: the disk is too full for the download and build (or a write hit ENOSPC). Its message is for the user, as
 * the picker shows it with Retry. `neededBytes`: what the rest of the install still needs, free, at its peak (the
 * downloads are deleted only once the models are built).
 */
export class ModelsDiskSpaceError extends Error {
  override name = "ModelsDiskSpaceError";
  constructor(readonly neededBytes: number) {
    super(
      `There is not enough disk space for the analysis models. They need about ${Math.ceil(neededBytes / 1e6)} MB free. ` +
        "Free some space, then try again.",
    );
  }
}

/** Free bytes for this process on the volume of `path` (or its nearest existing parent); null when unknown. */
async function freeBytes(path: string): Promise<number | null> {
  for (let p = path; ; p = dirname(p)) {
    try {
      const s = await statfs(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT" || dirname(p) === p) return null;
    }
  }
}

const isNoSpace = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOSPC";

/** Errors of a build from verified sources that a fresh download can fix (a source damaged after it was checked). */
const BUILD_DATA_ERRORS = new Set(["WeightsChecksumError", "CheckpointError", "ZipError", "PickleError"]);

export function modelDir(storageDir: string): string {
  return join(storageDir, "models", MODEL_SET);
}

/** Where the download goes before it is built; deleted once the store is installed. */
export function sourcesDir(storageDir: string): string {
  return join(modelDir(storageDir), "sources");
}

/** The shipped graphs and weightmap.json: `<extension root>/models`. */
export function packagedModelsDir(): string {
  return join(extensionRoot(), "models");
}

/** Everything about the store that tests replace; the defaults are the real ones. */
export interface StoreSpec {
  sources?: SourceFile[];
  files?: ModelFile[];
  /** Holds weightmap.json and the graphs. Defaults to packagedModelsDir(). */
  packagedDir?: string;
}

interface Spec {
  sources: SourceFile[];
  files: ModelFile[];
  packagedDir: string;
}

const specOf = (s: StoreSpec = {}): Spec => ({
  sources: s.sources ?? MODEL_SOURCES,
  files: s.files ?? MODEL_FILES,
  packagedDir: s.packagedDir ?? packagedModelsDir(),
});

const INSTALLED = "installed.json";

interface InstalledManifest {
  modelSet: string;
  files: ModelFile[];
}

async function readInstalled(dir: string): Promise<ModelFile[]> {
  try {
    const m = JSON.parse(await readFile(join(dir, INSTALLED), "utf8")) as Partial<InstalledManifest>;
    if (m.modelSet !== MODEL_SET || !Array.isArray(m.files)) return [];
    return m.files.filter((f) => f && typeof f.name === "string" && typeof f.bytes === "number" && typeof f.sha256 === "string");
  } catch {
    return [];
  }
}

async function writeInstalled(dir: string, files: ModelFile[]): Promise<void> {
  const tmp = join(dir, INSTALLED + ".tmp");
  await writeFile(tmp, JSON.stringify({ modelSet: MODEL_SET, files } satisfies InstalledManifest, null, 1));
  await rename(tmp, join(dir, INSTALLED));
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** A listed entry counts only if it matches the manifest (name, bytes, sha256) and the file on disk has that size. */
async function isInstalled(dir: string, listed: ModelFile[], f: ModelFile): Promise<boolean> {
  const entry = listed.find((l) => l.name === f.name);
  return !!entry && entry.bytes === f.bytes && entry.sha256 === f.sha256 && (await sizeOf(join(dir, f.name))) === f.bytes;
}

/** True when installed.json lists every file and each on-disk size matches. Never re-hashes (190 MB). */
export async function modelsInstalled(storageDir: string, files: ModelFile[] = MODEL_FILES): Promise<boolean> {
  const dir = modelDir(storageDir);
  const listed = await readInstalled(dir);
  for (const f of files) if (!(await isInstalled(dir, listed, f))) return false;
  return true;
}

async function hashFile(path: string, hash: ReturnType<typeof createHash> = createHash("sha256")): Promise<string> {
  await pipeline(createReadStream(path), async function* (chunks: AsyncIterable<Buffer>) {
    for await (const c of chunks) hash.update(c);
  });
  return hash.digest("hex");
}

/** Monotone progress reporter, throttled to steps of at least 1 % of the total (the last call is always the total). */
function progressReporter(total: number, onProgress: (done: number, total: number) => void) {
  const step = total / 100;
  let reported = -Infinity;
  return (done: number, force = false) => {
    const d = Math.min(total, done);
    if (d <= reported) return;
    if (force || d === total || d - reported >= step) {
      reported = d;
      onProgress(d, total);
    }
  };
}

/**
 * The packaged weight map, checked against MODEL_SOURCES and MODEL_FILES (the store is described in both places; they
 * must agree). A missing map (a package without models/) is ModelsUnavailableError.
 */
export async function loadWeightMap(spec: StoreSpec = {}): Promise<WeightMap> {
  const s = specOf(spec);
  const path = join(s.packagedDir, "weightmap.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ModelsUnavailableError(`Structure models cannot be built: ${path} is missing`);
  }
  const map = parseWeightMap(text);
  const same = (a: { bytes: number; sha256: string }, b: { bytes: number; sha256: string }) => a.bytes === b.bytes && a.sha256 === b.sha256;
  const sourcesMatch =
    map.sources.length === s.sources.length &&
    map.sources.every((m, i) => m.file === s.sources[i].file && m.repo === s.sources[i].repo && m.revision === s.sources[i].revision && same(m, s.sources[i]));
  const listed = map.models.flatMap((m) => [{ name: m.name, ...m.graph }, { ...m.weights }]);
  const filesMatch = listed.length === s.files.length && listed.every((f, i) => f.name === s.files[i].name && same(f, s.files[i]));
  if (!sourcesMatch || !filesMatch) throw new Error(`The packaged weight map (${path}) does not match this build's model list`);
  return map;
}

/**
 * Builds the store from checkpoints in `srcDir` (already verified): copies each graph (checking its sha256), writes its
 * `.weights` (weights/weightMap.ts buildWeights), and records each pair in installed.json once both are in place.
 * Models already installed are skipped. Progress is bytes of .weights written, over all models.
 */
async function buildStore(
  storageDir: string,
  srcDir: string,
  map: WeightMap,
  spec: Spec,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const dir = modelDir(storageDir);
  await mkdir(dir, { recursive: true });
  let listed = await readInstalled(dir);
  const total = map.models.reduce((s, m) => s + m.weights.bytes, 0);
  const report = progressReporter(total, onProgress);
  const todo = [];
  let base = 0;
  for (const m of map.models) {
    const pair = spec.files.filter((f) => f.name === m.name || f.name === m.weights.name);
    let done = true;
    for (const f of pair) if (!(await isInstalled(dir, listed, f))) done = false;
    if (done) base += m.weights.bytes;
    else todo.push({ m, pair });
  }
  report(base, true);
  if (todo.length === 0) return;

  const needed = [...new Set(todo.flatMap(({ m }) => m.tensors.map((t) => t.source)))];
  const checkpoints = new Map<number, Checkpoint>();
  try {
    for (const i of needed) {
      throwIfAborted(signal);
      checkpoints.set(i, await openCheckpoint(join(srcDir, map.sources[i].file)));
    }
    for (const { m, pair } of todo) {
      throwIfAborted(signal);
      listed = listed.filter((l) => !pair.some((f) => f.name === l.name));
      const graph = join(dir, m.name);
      const part = graph + ".part";
      try {
        await copyFile(join(spec.packagedDir, m.name), part);
        if ((await sizeOf(part)) !== m.graph.bytes || (await hashFile(part)) !== m.graph.sha256) {
          throw new Error(`The packaged graph ${m.name} does not match its sha256`);
        }
        await rename(part, graph);
      } catch (error) {
        await rm(part, { force: true });
        if ((error as { code?: unknown }).code === "ENOENT") {
          throw new ModelsUnavailableError(`Structure models cannot be built: ${m.name} is missing from the package`);
        }
        throw error;
      }
      await buildWeights(m, (i) => checkpoints.get(i)!, join(dir, m.weights.name), signal, (n) => report(base + n));
      base += m.weights.bytes;
      report(base);
      listed.push(...pair);
      await writeInstalled(dir, listed);
    }
  } finally {
    for (const c of checkpoints.values()) await c.close().catch(() => undefined);
  }
  report(total, true);
}

export interface DownloadOptions extends StoreSpec {
  /** Defaults to globalThis.fetch (present in Live's host). */
  fetch?: typeof fetch;
  /** Defaults to sourceUrl (Hugging Face). */
  urlFor?: (s: SourceFile) => string;
  /** Give up (keeping the .part) when no bytes arrive for this long. Default 60 s. */
  idleTimeoutMs?: number;
  /** Free bytes on the storage volume (tests); null skips the check. Defaults to statfs. */
  freeBytes?: (path: string) => Promise<number | null>;
}

const IDLE_TIMEOUT_MS = 60_000;

/** Bytes of a host- or sandbox-realm Uint8Array as a Buffer of this realm, zero-copy. */
function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** Reads one chunk, rejecting after `ms` with no data (the host has no AbortSignal.timeout). */
function readWithin<T>(read: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Model download stalled: ${name}`)), ms);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

type DownloadResult = "ok" | "mismatch";

/**
 * One attempt at one file: GET (with Range when a .part exists; redirects followed), stream to the .part while
 * hashing, then verify size and sha256 and rename. On "mismatch" the .part is deleted. Abort and errors keep the .part
 * for a resume.
 */
async function downloadOnce(
  f: SourceFile,
  dir: string,
  url: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  idleMs: number,
  report: (fileDone: number) => void,
): Promise<DownloadResult> {
  // fb2 review m5: an analysis that must not download aborts at the first progress report; stop here, without relying
  // on the host's fetch to reject an aborted signal, and without finishing a full-size .part's install either.
  throwIfAborted(signal);
  const dest = join(dir, f.file);
  const part = dest + ".part";
  let have = (await sizeOf(part)) ?? 0;
  if (have > f.bytes) {
    await rm(part, { force: true });
    have = 0;
  }
  const hash = createHash("sha256");
  if (have === f.bytes) {
    // aborted after the last byte but before the rename: verify what is there
    if ((await hashFile(part, hash)) !== f.sha256) {
      await rm(part, { force: true });
      return "mismatch";
    }
    await rename(part, dest);
    return "ok";
  }

  throwIfAborted(signal);
  const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {};
  let res: Response;
  try {
    res = await doFetch(url, { headers, signal, redirect: "follow" });
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
  if (res.status === 206 && have > 0) {
    const range = res.headers.get("content-range");
    if (range !== null && !range.startsWith(`bytes ${have}-`)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Model download failed: unexpected Content-Range "${range}" for ${f.file}`);
    }
    await pipeline(createReadStream(part), async function* (chunks: AsyncIterable<Buffer>) {
      for await (const c of chunks) hash.update(c);
    });
  } else if (res.status >= 200 && res.status < 300) {
    have = 0; // 200: the server sent the whole file, start over
  } else {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Model download failed: ${res.status} ${f.file}`);
  }
  if (!res.body) throw new Error(`Model download failed: empty body for ${f.file}`);

  let written = have;
  let tooLong = false;
  report(written);
  const out = await open(part, have > 0 ? "a" : "w");
  const reader = res.body.getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await readWithin(reader.read(), idleMs, f.file);
      if (done) break;
      const buf = asBuffer(value);
      if (written + buf.length > f.bytes) {
        tooLong = true; // more than the file's size: a mismatch, whatever follows
        break;
      }
      hash.update(buf);
      for (let at = 0; at < buf.length; ) {
        const { bytesWritten } = await out.write(buf, at, buf.length - at);
        at += bytesWritten;
      }
      written += buf.length;
      report(written);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    await out.close();
  }
  if (tooLong) await reader.cancel().catch(() => undefined);
  if (tooLong || written !== f.bytes || hash.digest("hex") !== f.sha256 || (await sizeOf(part)) !== f.bytes) {
    await rm(part, { force: true });
    return "mismatch";
  }
  await rename(part, dest);
  return "ok";
}

/**
 * Downloads every source not yet in `dir` (a file under its own name there was verified before it was renamed).
 * Progress is cumulative bytes over all sources. See ensureModels for resume, retry and errors.
 */
async function downloadSources(
  dir: string,
  sources: SourceFile[],
  doFetch: typeof fetch,
  urlFor: (s: SourceFile) => string,
  signal: AbortSignal,
  idleMs: number,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const total = sum(sources);
  const missing: SourceFile[] = [];
  let doneBefore = 0;
  for (const f of sources) {
    if ((await sizeOf(join(dir, f.file))) === f.bytes) doneBefore += f.bytes;
    else {
      missing.push(f);
      doneBefore += Math.min(f.bytes, (await sizeOf(join(dir, f.file + ".part"))) ?? 0);
    }
  }
  const report = progressReporter(total, onProgress);
  report(doneBefore, true);
  let base = total - sum(missing);
  for (const f of missing) {
    const fileReport = (fileDone: number) => report(base + fileDone);
    let result = await downloadOnce(f, dir, urlFor(f), doFetch, signal, idleMs, fileReport);
    if (result === "mismatch") result = await downloadOnce(f, dir, urlFor(f), doFetch, signal, idleMs, fileReport);
    if (result === "mismatch") throw new ModelChecksumError(`${f.file} does not match the expected size or sha256 (downloaded twice)`);
    base += f.bytes;
    report(base);
  }
  report(total, true);
}

/**
 * Makes sure every model is in <storageDir>/models/<MODEL_SET>/ and resolves to that directory. Call it only once the
 * user has agreed to the download (the Structure tab asks). Already installed: resolves at once, after one progress
 * call (total, total). Otherwise:
 *
 * 1. "download": each missing source is fetched from Hugging Face (redirects followed) to sources/<file>.part,
 *    resuming with `Range` when a .part exists (206 appends after hashing the part; 200 restarts), hashed while
 *    streaming, verified (size and sha256) and renamed. A checksum mismatch deletes the .part and retries that file
 *    once from zero, then throws ModelChecksumError. A non-2xx status throws `Model download failed: <status> <file>`.
 * 2. "build": each model's graph is copied from the package and its .weights written from the sources, each checked
 *    against the sha256 recorded at build time, then recorded in installed.json. sources/ is then deleted.
 *
 * Progress is bytes, per phase, in steps of at least 1 %. Abort keeps what is done (and the .part) and rejects with an
 * Error named "AbortError". A package without its weight map or graphs is ModelsUnavailableError.
 *
 * Review fixes: before anything is written, the volume must have room for what the rest needs at its peak (missing
 * downloads plus the files still to build, plus a margin), else ModelsDiskSpaceError, as is an ENOSPC on the way.
 * Before the build every source is re-hashed and a damaged one downloaded again. A reader or checksum error while
 * building deletes the downloads and throws ModelChecksumError, so Retry fetches them again. Failing to delete the
 * downloads after a complete install is only logged.
 */
export async function ensureModels(opts: EnsureModelsOptions & DownloadOptions): Promise<string> {
  const { storageDir, signal, onProgress } = opts;
  const spec = specOf(opts);
  throwIfAborted(signal);
  const dir = modelDir(storageDir);
  if (await modelsInstalled(storageDir, spec.files)) {
    const total = sum(spec.sources);
    onProgress(total, total, "download");
    return dir;
  }
  const map = await loadWeightMap(spec);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const src = sourcesDir(storageDir);
  const phase = (p: ModelsPhase) => (done: number, total: number) => onProgress(done, total, p);
  const download = () =>
    downloadSources(src, spec.sources, doFetch, opts.urlFor ?? sourceUrl, signal, opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS, phase("download"));

  // Review m4: ask for the room the rest needs at its peak (missing downloads plus the files still to build).
  const needed = await stillNeeded(storageDir, spec);
  const free = await (opts.freeBytes ?? freeBytes)(storageDir);
  if (free !== null && free < needed + DISK_MARGIN) throw new ModelsDiskSpaceError(needed + DISK_MARGIN);
  try {
    await download();
    throwIfAborted(signal);
    // Review m5: a source under its own name was verified when it was renamed, but may have been damaged since (a disk
    // fault, a hand copy): re-hash them all (95 MB, a fraction of a second) and download a bad one again.
    const bad = await damagedSources(src, spec.sources);
    if (bad.length > 0) {
      for (const f of bad) await rm(join(src, f.file), { force: true });
      await download();
      const still = await damagedSources(src, spec.sources);
      if (still.length > 0) throw new ModelChecksumError(`${still[0].file} does not match its sha256 after downloading it again`);
    }
    throwIfAborted(signal);
    try {
      await buildStore(storageDir, src, map, spec, signal, phase("build"));
    } catch (error) {
      // Built from verified sources, so a reader or checksum error means a source changed under us: delete the
      // downloads, so Retry fetches them again rather than failing the same way for ever. Nothing was listed as
      // installed for the model that failed (buildStore lists a pair only once both files are in place).
      const name = (error as { name?: unknown } | null)?.name;
      if (typeof name === "string" && BUILD_DATA_ERRORS.has(name)) {
        await rm(src, { recursive: true, force: true });
        throw new ModelChecksumError(`Building the models failed (${(error as Error).message}); the downloads were deleted`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    if (isNoSpace(error)) throw new ModelsDiskSpaceError(await stillNeeded(storageDir, spec).catch(() => needed));
    throw error;
  }
  // Installed: a download folder that cannot be deleted must not fail it (review m5).
  await rm(src, { recursive: true, force: true }).catch((error) => {
    console.error(`Song Sections: could not delete ${src} after installing the models:`, error);
  });
  return dir;
}

/** Headroom on top of the computed need: installed.json, temp files, the volume's own reserve. */
const DISK_MARGIN = 16_000_000;

/** Bytes the rest of an install still writes, at its peak: the downloads not yet complete plus the files not built. */
async function stillNeeded(storageDir: string, spec: Spec): Promise<number> {
  const src = sourcesDir(storageDir);
  let n = 0;
  for (const f of spec.sources) {
    if ((await sizeOf(join(src, f.file))) === f.bytes) continue;
    n += f.bytes - Math.min(f.bytes, (await sizeOf(join(src, f.file + ".part"))) ?? 0);
  }
  const dir = modelDir(storageDir);
  const listed = await readInstalled(dir);
  for (const f of spec.files) if (!(await isInstalled(dir, listed, f))) n += f.bytes;
  return n;
}

/** The downloaded sources whose bytes no longer match their sha256 (a missing one counts as damaged). */
async function damagedSources(dir: string, sources: SourceFile[]): Promise<SourceFile[]> {
  const bad: SourceFile[] = [];
  for (const f of sources) {
    const path = join(dir, f.file);
    if ((await sizeOf(path)) !== f.bytes || (await hashFile(path)) !== f.sha256) bad.push(f);
  }
  return bad;
}

/**
 * Dev (`npm run models:dev`), offline: builds the store from the source checkpoints in `srcDir` (a folder holding the 9
 * files, e.g. a Hugging Face snapshot folder), verifying each one's size and sha256 first. Nothing is downloaded, and
 * `srcDir` is left as it is. Resolves to the model dir.
 */
export async function installFromSources(
  storageDir: string,
  srcDir: string,
  onProgress?: (done: number, total: number) => void,
  spec: StoreSpec = {},
): Promise<string> {
  const s = specOf(spec);
  if (!(await modelsInstalled(storageDir, s.files))) {
    const map = await loadWeightMap(s);
    for (const f of s.sources) {
      const path = join(srcDir, f.file);
      if ((await sizeOf(path)) !== f.bytes || (await hashFile(path)) !== f.sha256) {
        throw new ModelChecksumError(`${f.file} is missing or does not match the expected size or sha256 (source: ${srcDir})`);
      }
    }
    await buildStore(storageDir, srcDir, map, s, new AbortController().signal, (d, t) => onProgress?.(d, t));
  }
  return modelDir(storageDir);
}
