// The weight map (fb/hfmodels): how each model's `<name>.weights` is built from the authors' checkpoints. Written by
// tools/hfmodels/build_models.py next to the weightless graphs in models/, and shipped in the package.
import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { abortError, throwIfAborted } from "../../core/abort.js";
import { itemSize, materialize, type Checkpoint } from "./checkpoint.js";

export interface FileSum {
  bytes: number;
  sha256: string;
}

export interface SourceFile extends FileSum {
  /** The file name in the repo, also its name on disk while it is downloaded. */
  file: string;
  /** Hugging Face repo id, e.g. "taejunkim/allinone". */
  repo: string;
  /** Pinned commit. */
  revision: string;
}

export interface TensorEntry {
  /** The initializer's name in the graph. */
  name: string;
  dims: number[];
  /** Byte offset and length in `<name>.weights` (float32, C order). */
  offset: number;
  length: number;
  /** Index into WeightMap.sources. */
  source: number;
  /** Tensor key in the checkpoint (the state dict's key for a .pth). */
  key: string;
  /** The source tensor's dtype and shape as stored. */
  dtype: string;
  shape: number[];
  /** Output axis i is source axis perm[i]; absent: no permutation (dims may still reshape it). */
  perm?: number[];
}

export interface ModelEntry {
  /** The graph's file name, e.g. "htdemucs_core.onnx". */
  name: string;
  /** The v1 single-file model this one reproduces (for reference and tests). */
  v1: FileSum;
  graph: FileSum;
  weights: FileSum & { name: string };
  tensors: TensorEntry[];
}

export interface WeightMap {
  modelSet: string;
  align: number;
  sources: SourceFile[];
  models: ModelEntry[];
}

export class WeightMapError extends Error {
  override name = "WeightMapError";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isDims = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);
/** A plain file name: no directory parts, so nothing is written outside the model directory. */
const isFileName = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9._-]+$/.test(v) && v !== "." && v !== "..";

/** Parses and checks the shape of a weight map; throws WeightMapError on anything malformed. */
export function parseWeightMap(text: string): WeightMap {
  const fail = (why: string): never => {
    throw new WeightMapError(`Bad weight map: ${why}`);
  };
  let w: WeightMap;
  try {
    w = JSON.parse(text) as WeightMap;
  } catch {
    return fail("not JSON");
  }
  if (!w || !isStr(w.modelSet) || !isNum(w.align) || !Array.isArray(w.sources) || !Array.isArray(w.models)) fail("missing fields");
  for (const s of w.sources) {
    if (!isFileName(s?.file) || !isStr(s.repo) || !isStr(s.revision) || !isNum(s.bytes) || !isSha(s.sha256)) fail("bad source");
  }
  for (const m of w.models) {
    if (!isFileName(m?.name) || !isFileName(m.weights?.name) || m.name === m.weights.name) fail("bad model name");
    for (const f of [m.v1, m.graph, m.weights]) if (!isNum(f?.bytes) || !isSha(f.sha256)) fail(`bad checksum for ${m.name}`);
    if (!Array.isArray(m.tensors)) fail(`no tensors for ${m.name}`);
    let end = 0;
    for (const t of m.tensors) {
      if (!isStr(t?.name) || !isDims(t.dims) || !isNum(t.offset) || !isNum(t.length) || !isNum(t.source) || !isStr(t.key)) {
        fail(`bad tensor in ${m.name}`);
      }
      if (t.source >= w.sources.length || !isStr(t.dtype) || !isDims(t.shape)) fail(`bad source of ${t.name}`);
      if (t.dims.reduce((a, b) => a * b, 1) * 4 !== t.length) fail(`${t.name}: length does not match its dims`);
      if (t.offset < end) fail(`${t.name}: offsets must increase`);
      if (t.perm !== undefined && (!isDims(t.perm) || t.perm.length !== t.shape.length)) fail(`${t.name}: bad perm`);
      end = t.offset + t.length;
    }
    if (end > m.weights.bytes) fail(`${m.name}: tensors run past the weights file`);
  }
  return w;
}

export class WeightsChecksumError extends Error {
  override name = "WeightsChecksumError";
}

/**
 * Writes `<dest>.part` from the checkpoints, tensor by tensor in offset order (zero padding between), hashing as it
 * goes; checks its size and sha256 against the map, then renames it to `dest`. On any failure the .part is deleted.
 * `onBytes(n)` reports bytes written so far. Abort rejects with an Error named "AbortError".
 */
export async function buildWeights(
  model: ModelEntry,
  checkpoints: (sourceIndex: number) => Checkpoint,
  dest: string,
  signal: AbortSignal,
  onBytes: (written: number) => void = () => {},
): Promise<void> {
  const part = dest + ".part";
  const hash = createHash("sha256");
  const out = await open(part, "w");
  let written = 0;
  const write = async (buf: Buffer) => {
    hash.update(buf);
    let at = 0;
    while (at < buf.length) {
      const { bytesWritten } = await out.write(buf, at, buf.length - at, written + at);
      at += bytesWritten;
    }
    written += buf.length;
    onBytes(written);
  };
  try {
    try {
      for (const t of model.tensors) {
        if (signal.aborted) throw abortError();
        const src = checkpoints(t.source).tensors.get(t.key);
        if (!src) throw new WeightsChecksumError(`${model.name}: ${t.name}'s source tensor ${t.key} is missing`);
        if (src.dtype !== t.dtype || src.shape.length !== t.shape.length || src.shape.some((d, i) => d !== t.shape[i])) {
          throw new WeightsChecksumError(`${model.name}: ${t.key} is ${src.dtype} [${src.shape}], expected ${t.dtype} [${t.shape}]`);
        }
        itemSize(src.dtype);
        if (t.offset > written) await write(Buffer.alloc(t.offset - written));
        const data = await materialize(src, t.perm);
        if (data.length !== t.length) throw new WeightsChecksumError(`${model.name}: ${t.name} has ${data.length} bytes, expected ${t.length}`);
        await write(data);
      }
      if (model.weights.bytes > written) await write(Buffer.alloc(model.weights.bytes - written));
    } finally {
      await out.close();
    }
    throwIfAborted(signal);
    if (written !== model.weights.bytes || hash.digest("hex") !== model.weights.sha256) {
      throw new WeightsChecksumError(`${model.weights.name} does not match the expected size or sha256 after building`);
    }
    await rename(part, dest);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}
