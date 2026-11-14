import { open } from "node:fs/promises";

export interface SynthOptions {
  sampleRate: number;
  channels: number;
  bitDepth: 16 | 24 | 32;
  frames: number;
  /** Sample value in [-1, 1] for channel `ch` at frame `i`. */
  sample: (ch: number, i: number) => number;
  /** Frames per write block (default 48000). */
  blockFrames?: number;
}
export interface WavOptions extends SynthOptions {
  /** 32-bit IEEE float (bitDepth must be 32). */
  float?: boolean;
  /** Write WAVE_FORMAT_EXTENSIBLE instead of plain PCM/float. */
  extensible?: boolean;
}

function encodeBlock(o: SynthOptions, start: number, n: number, bigEndian: boolean, float: boolean): Buffer {
  const bytes = o.bitDepth / 8;
  const buf = Buffer.alloc(n * o.channels * bytes);
  let p = 0;
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < o.channels; ch++) {
      const v = Math.max(-1, Math.min(1, o.sample(ch, start + i)));
      if (float) {
        buf.writeFloatLE(v, p);
      } else if (o.bitDepth === 16) {
        const s = Math.min(32767, Math.round(v * 32768));
        bigEndian ? buf.writeInt16BE(s, p) : buf.writeInt16LE(s, p);
      } else if (o.bitDepth === 24) {
        const s = Math.min(8388607, Math.round(v * 8388608));
        if (bigEndian) buf.writeIntBE(s, p, 3);
        else buf.writeIntLE(s, p, 3);
      } else {
        const s = Math.min(2147483647, Math.round(v * 2147483648));
        bigEndian ? buf.writeInt32BE(s, p) : buf.writeInt32LE(s, p);
      }
      p += bytes;
    }
  }
  return buf;
}

async function writeBlocks(fh: Awaited<ReturnType<typeof open>>, o: SynthOptions, bigEndian: boolean, float: boolean) {
  const block = o.blockFrames ?? 48000;
  for (let start = 0; start < o.frames; start += block) {
    const n = Math.min(block, o.frames - start);
    await fh.write(encodeBlock(o, start, n, bigEndian, float));
  }
}

export async function makeWav(path: string, o: WavOptions): Promise<void> {
  const float = o.float ?? false;
  const bytes = o.bitDepth / 8;
  const dataSize = o.frames * o.channels * bytes;
  const fmtSize = o.extensible ? 40 : 16;
  const fmt = Buffer.alloc(8 + fmtSize);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(fmtSize, 4);
  fmt.writeUInt16LE(o.extensible ? 0xfffe : float ? 3 : 1, 8);
  fmt.writeUInt16LE(o.channels, 10);
  fmt.writeUInt32LE(o.sampleRate, 12);
  fmt.writeUInt32LE(o.sampleRate * o.channels * bytes, 16);
  fmt.writeUInt16LE(o.channels * bytes, 20);
  fmt.writeUInt16LE(o.bitDepth, 22);
  if (o.extensible) {
    fmt.writeUInt16LE(22, 24); // cbSize
    fmt.writeUInt16LE(o.bitDepth, 26); // valid bits
    fmt.writeUInt32LE(0, 28); // channel mask
    fmt.writeUInt16LE(float ? 3 : 1, 32); // sub-format GUID starts with format tag
    Buffer.from("000000001000800000aa00389b71", "hex").copy(fmt, 34);
  }
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + fmt.length + 8 + dataSize + (dataSize % 2), 4);
  head.write("WAVE", 8, "ascii");
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "ascii");
  dataHead.writeUInt32LE(dataSize, 4);
  const fh = await open(path, "w");
  try {
    await fh.write(Buffer.concat([head, fmt, dataHead]));
    await writeBlocks(fh, o, false, float);
    if (dataSize % 2) await fh.write(Buffer.alloc(1));
  } finally {
    await fh.close();
  }
}

/** 80-bit IEEE extended, big-endian, for positive integer-valued rates. */
function extended80(value: number): Buffer {
  const b = Buffer.alloc(10);
  const exp = Math.floor(Math.log2(value));
  b.writeUInt16BE(exp + 16383, 0);
  const mantissa = BigInt(value) << BigInt(63 - exp);
  b.writeBigUInt64BE(mantissa, 2);
  return b;
}

export async function makeAiff(path: string, o: SynthOptions): Promise<void> {
  const bytes = o.bitDepth / 8;
  const dataSize = o.frames * o.channels * bytes;
  const comm = Buffer.alloc(8 + 18);
  comm.write("COMM", 0, "ascii");
  comm.writeUInt32BE(18, 4);
  comm.writeUInt16BE(o.channels, 8);
  comm.writeUInt32BE(o.frames, 10);
  comm.writeUInt16BE(o.bitDepth, 14);
  extended80(o.sampleRate).copy(comm, 16);
  const ssnd = Buffer.alloc(16);
  ssnd.write("SSND", 0, "ascii");
  ssnd.writeUInt32BE(8 + dataSize, 4);
  ssnd.writeUInt32BE(0, 8); // offset
  ssnd.writeUInt32BE(0, 12); // blockSize
  const head = Buffer.alloc(12);
  head.write("FORM", 0, "ascii");
  head.writeUInt32BE(4 + comm.length + ssnd.length + dataSize + (dataSize % 2), 4);
  head.write("AIFF", 8, "ascii");
  const fh = await open(path, "w");
  try {
    await fh.write(Buffer.concat([head, comm, ssnd]));
    await writeBlocks(fh, o, true, false);
    if (dataSize % 2) await fh.write(Buffer.alloc(1));
  } finally {
    await fh.close();
  }
}
