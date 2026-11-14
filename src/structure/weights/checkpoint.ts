// Checkpoint readers (fb/hfmodels): the tensors of a torch.save `.pth` (zip + pickle) or a `.safetensors` file, as
// descriptors whose bytes are read on demand. Nothing in a checkpoint is ever executed (unpickle.ts).
import { open, type FileHandle } from "node:fs/promises";
import { PickleCall, TensorRef, unpickle } from "./unpickle.js";
import { readAt, ZipReader, type ZipEntry } from "./zip.js";

export type SourceDType = "float32" | "float16";

export interface SourceTensor {
  /** "float32" or "float16"; any other storage type is reported by name and refused when used. */
  dtype: SourceDType | string;
  shape: number[];
  /** In elements, as torch reports them. */
  stride: number[];
  /**
   * The bytes holding every element of the view, and the element index (within those bytes) of element [0, …, 0].
   * Strides index from there.
   */
  read(): Promise<{ bytes: Buffer; base: number }>;
}

export interface Checkpoint {
  tensors: Map<string, SourceTensor>;
  close(): Promise<void>;
}

export class CheckpointError extends Error {
  override name = "CheckpointError";
}

const ITEM: Record<string, number> = { float32: 4, float16: 2 };

export function itemSize(dtype: string): number {
  const n = ITEM[dtype];
  if (!n) throw new CheckpointError(`unsupported tensor dtype ${dtype}`);
  return n;
}

const numel = (shape: number[]) => shape.reduce((a, b) => a * b, 1);

/** Review m1: the most elements one tensor may expand to (1 GiB of float32); the largest weight here is about 1M. */
export const MAX_ELEMENTS = 1 << 28;
const MAX_RANK = 16;

function contiguousStride(shape: number[]): number[] {
  const s = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= shape[i];
  }
  return s;
}

/** Elements spanned by a strided view (0 for an empty one). */
function span(shape: number[], stride: number[]): number {
  if (shape.some((d) => d === 0)) return 0;
  let last = 0;
  for (let i = 0; i < shape.length; i++) {
    if (stride[i] < 0) throw new CheckpointError("negative strides are not supported");
    last += (shape[i] - 1) * stride[i];
  }
  return last + 1;
}

const STORAGE_DTYPE: Record<string, string> = { FloatStorage: "float32", HalfStorage: "float16" };

/** A torch.save zip checkpoint. A Lightning-style {"state_dict": {...}} gives the state dict's tensors. */
export async function openPth(path: string): Promise<Checkpoint> {
  const fh = await open(path, "r");
  try {
    const zip = await ZipReader.open(fh);
    const pkl = [...zip.entries.values()].find((e) => /^[^/]+\/data\.pkl$/.test(e.name));
    if (!pkl) throw new CheckpointError(`${path}: no data.pkl (not a torch.save zip checkpoint)`);
    const prefix = pkl.name.slice(0, -"data.pkl".length);
    const order = zip.entries.get(prefix + "byteorder");
    if (order && (await zip.read(order)).toString("latin1") !== "little") throw new CheckpointError(`${path}: big-endian checkpoint`);
    const root = unpickle(await zip.read(pkl));
    const dict = root instanceof Map && root.get("state_dict") instanceof Map ? (root.get("state_dict") as Map<unknown, unknown>) : root;
    if (!(dict instanceof Map)) throw new CheckpointError(`${path}: the checkpoint is not a dict`);
    const tensors = new Map<string, SourceTensor>();
    for (const [key, value] of dict) {
      const t = value instanceof PickleCall ? null : value;
      if (typeof key !== "string" || !(t instanceof TensorRef)) continue;
      const entry: ZipEntry | undefined = zip.entries.get(`${prefix}data/${t.storage.key}`);
      if (!entry) throw new CheckpointError(`${path}: storage ${t.storage.key} of ${key} is missing`);
      const dtype = STORAGE_DTYPE[t.storage.storageType] ?? t.storage.storageType;
      const size = ITEM[dtype];
      tensors.set(key, {
        dtype,
        shape: t.shape,
        stride: t.stride,
        async read() {
          if (!size) throw new CheckpointError(`${key}: unsupported storage ${t.storage.storageType}`);
          if (entry.size !== t.storage.numel * size) throw new CheckpointError(`${key}: storage ${t.storage.key} has the wrong size`);
          const n = span(t.shape, t.stride);
          if (t.storageOffset + n > t.storage.numel) throw new CheckpointError(`${key}: view out of its storage`);
          const bytes =
            entry.method === 0
              ? await zip.readStored(entry, t.storageOffset * size, n * size)
              : (await zip.read(entry)).subarray(t.storageOffset * size, (t.storageOffset + n) * size);
          return { bytes, base: 0 };
        },
      });
    }
    return { tensors, close: () => fh.close() };
  } catch (error) {
    await fh.close();
    throw error;
  }
}

const SAFETENSORS_DTYPE: Record<string, string> = { F32: "float32", F16: "float16" };
const MAX_HEADER = 100_000_000;

/** A safetensors file: an 8-byte little-endian header length, the JSON header, then the raw data. */
export async function openSafetensors(path: string): Promise<Checkpoint> {
  const fh: FileHandle = await open(path, "r");
  try {
    const fileSize = (await fh.stat()).size;
    const len = (await readAt(fh, 0, 8)).readBigUInt64LE(0);
    if (len > BigInt(Math.min(MAX_HEADER, fileSize - 8))) throw new CheckpointError(`${path}: bad safetensors header length`);
    const headerLen = Number(len);
    const header = JSON.parse((await readAt(fh, 8, headerLen)).toString("utf8")) as Record<string, unknown>;
    const dataStart = 8 + headerLen;
    const tensors = new Map<string, SourceTensor>();
    for (const [key, info] of Object.entries(header)) {
      if (key === "__metadata__") continue;
      const { dtype: raw, shape, data_offsets: offsets } = info as { dtype: string; shape: number[]; data_offsets: [number, number] };
      const okInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
      if (!Array.isArray(shape) || !Array.isArray(offsets) || offsets.length !== 2) throw new CheckpointError(`${path}: bad entry ${key}`);
      if (shape.length > MAX_RANK || !shape.every(okInt) || !offsets.every(okInt)) throw new CheckpointError(`${path}: bad entry ${key}`);
      const dtype = SAFETENSORS_DTYPE[raw] ?? raw;
      const [begin, end] = offsets;
      if (!(begin >= 0 && end >= begin && dataStart + end <= fileSize)) throw new CheckpointError(`${path}: ${key} out of range`);
      tensors.set(key, {
        dtype,
        shape,
        stride: contiguousStride(shape),
        async read() {
          if (end - begin !== numel(shape) * itemSize(dtype)) throw new CheckpointError(`${key}: data size does not match its shape`);
          return { bytes: await readAt(fh, dataStart + begin, end - begin), base: 0 };
        },
      });
    }
    return { tensors, close: () => fh.close() };
  } catch (error) {
    await fh.close();
    throw error;
  }
}

export function openCheckpoint(path: string): Promise<Checkpoint> {
  if (path.endsWith(".pth")) return openPth(path);
  if (path.endsWith(".safetensors")) return openSafetensors(path);
  throw new CheckpointError(`unknown checkpoint format: ${path}`);
}

const F16_TO_F32 = (() => {
  // Exact half -> single widening for all 65536 bit patterns (subnormals normalised, Inf and NaN payloads kept).
  const t = new Uint32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = (h & 0x8000) << 16;
    const exp = (h >> 10) & 0x1f;
    let mant = h & 0x3ff;
    if (exp === 0) {
      if (mant === 0) t[h] = sign;
      else {
        let e = 113; // 127 - 15 + 1
        while ((mant & 0x400) === 0) {
          mant <<= 1;
          e--;
        }
        t[h] = sign | (e << 23) | ((mant & 0x3ff) << 13);
      }
    } else if (exp === 0x1f) t[h] = sign | 0x7f800000 | (mant << 13);
    else t[h] = sign | ((exp + 112) << 23) | (mant << 13);
  }
  return t;
})();

/** The float32 bit pattern of a float16 bit pattern (exact; tests compare it with Float16Array). */
export function f16ToF32Bits(h: number): number {
  return F16_TO_F32[h & 0xffff];
}

/**
 * The tensor as float32 bytes in C order, after permuting its axes by `perm` (output axis i is source axis perm[i]),
 * as numpy's `src.astype(float32).transpose(perm)`.
 */
export async function materialize(t: SourceTensor, perm?: readonly number[]): Promise<Buffer> {
  const size = itemSize(t.dtype);
  const rank = t.shape.length;
  const axes = perm ?? [...Array(rank).keys()];
  if (axes.length !== rank || [...axes].sort((a, b) => a - b).some((a, i) => a !== i)) throw new CheckpointError("bad permutation");
  const shape = axes.map((a) => t.shape[a]);
  const stride = axes.map((a) => t.stride[a]);
  const n = numel(shape);
  if (rank > MAX_RANK || !(n <= MAX_ELEMENTS)) throw new CheckpointError(`tensor too large: [${t.shape}]`);
  const { bytes, base } = await t.read();
  if (bytes.length < (base + span(t.shape, t.stride)) * size) throw new CheckpointError(`tensor data shorter than its view: [${t.shape}]`);
  const out = Buffer.alloc(n * 4);
  const contiguous = stride.every((s, i) => shape[i] === 1 || s === contiguousStride(shape)[i]);
  if (contiguous && size === 4 && base === 0) {
    bytes.copy(out, 0, 0, n * 4);
    return out;
  }
  const dst = new Uint32Array(out.buffer, out.byteOffset, n);
  const src =
    size === 4
      ? new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      : new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (n === 0) return out;
  // Odometer over the output's C order; `at` is the source element index.
  const idx = new Array<number>(rank).fill(0);
  let at = base;
  const inner = rank === 0 ? 1 : shape[rank - 1];
  const innerStride = rank === 0 ? 0 : stride[rank - 1];
  for (let o = 0; o < n; o += inner) {
    if (size === 4) for (let j = 0, s = at; j < inner; j++, s += innerStride) dst[o + j] = src[s];
    else for (let j = 0, s = at; j < inner; j++, s += innerStride) dst[o + j] = F16_TO_F32[src[s]];
    for (let d = rank - 2; d >= 0; d--) {
      at += stride[d];
      if (++idx[d] < shape[d]) break;
      at -= stride[d] * shape[d];
      idx[d] = 0;
    }
  }
  return out;
}
