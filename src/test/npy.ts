import { readFileSync } from "node:fs";

export type NpyData = Float32Array | Int16Array | Int32Array | Float64Array;

/** Minimal .npy reader (v1/v2/v3): little-endian <f4 <i2 <i4 <f8, C order only. */
export function readNpy(path: string): { shape: number[]; data: NpyData } {
  const buf = readFileSync(path);
  if (buf.toString("latin1", 1, 6) !== "NUMPY") throw new Error(`${path}: not npy`);
  const major = buf[6];
  const hlen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  const start = hstart + hlen;
  const header = buf.toString("latin1", hstart, start);
  if (/'fortran_order':\s*True/.test(header)) throw new Error(`${path}: fortran order is not supported`);
  const descr = header.match(/'descr':\s*'([^']*)'/)?.[1];
  const shape = (header.match(/'shape':\s*\(([^)]*)\)/)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const n = shape.reduce((a, b) => a * b, 1);
  const make = { "<f4": Float32Array, "<i2": Int16Array, "<i4": Int32Array, "<f8": Float64Array }[descr ?? ""];
  if (!make) throw new Error(`${path}: unsupported dtype descr ${descr}`);
  if (buf.length < start + n * make.BYTES_PER_ELEMENT) throw new Error(`${path}: truncated (${buf.length - start} data bytes, need ${n * make.BYTES_PER_ELEMENT})`);
  const data = new make(n);
  new Uint8Array(data.buffer).set(buf.subarray(start, start + n * make.BYTES_PER_ELEMENT));
  return { shape, data };
}
