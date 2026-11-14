import { open, type FileHandle } from "node:fs/promises";

export interface PcmInfo {
  sampleRate: number;
  channels: number;
  frames: number;
}

export interface ReadPcmOptions {
  /** Frames per onChunk call (default 65536). */
  chunkFrames?: number;
  /** Called once after the header is parsed, before any chunk. */
  onHeader?: (info: PcmInfo) => void;
  /** Called with the file's bits per sample (16, 24 or 32) and whether it is float, just before onHeader. */
  onFormat?: (bits: number, float: boolean) => void;
  /** Receives the raw bytes of the audio data region, in file order, as read. Valid only during the call. */
  onBytes?: (raw: Buffer) => void;
}

interface Format {
  kind: "wav" | "aiff";
  sampleRate: number;
  channels: number;
  bits: number;
  float: boolean;
  dataStart: number;
  dataBytes: number;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** Decode an 80-bit big-endian IEEE extended float. */
function readExtended80(b: Buffer): number {
  const exp = b.readUInt16BE(0) & 0x7fff;
  const mantissa = b.readBigUInt64BE(2);
  if (exp === 0 && mantissa === 0n) return 0;
  return Number(mantissa) * Math.pow(2, exp - 16383 - 63);
}

async function parseWav(fh: FileHandle, size: number): Promise<Format> {
  let fmt: Omit<Format, "dataStart" | "dataBytes"> | undefined;
  let pos = 12;
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 8);
    const id = h.toString("ascii", 0, 4);
    let len = h.readUInt32LE(4);
    const body = pos + 8;
    if (id === "fmt ") {
      const b = await readAt(fh, body, Math.min(len, 40));
      let tag = b.readUInt16LE(0);
      const bits = b.readUInt16LE(14);
      if (tag === 0xfffe && b.length >= 26) tag = b.readUInt16LE(24); // sub-format GUID's leading format tag
      if (tag !== 1 && tag !== 3) throw new Error(`Unsupported WAV format tag ${tag}`);
      if (tag === 3 && bits !== 32) throw new Error(`Unsupported WAV float width ${bits}`);
      if (tag === 1 && ![16, 24, 32].includes(bits)) throw new Error(`Unsupported WAV bit depth ${bits}`);
      fmt = { kind: "wav", channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), bits, float: tag === 3 };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      // Streamed/unfinished files may carry 0 or 0xFFFFFFFF; trust the file size then.
      if (len === 0 || len === 0xffffffff || body + len > size) len = size - body;
      return { ...fmt, dataStart: body, dataBytes: len };
    }
    pos = body + len + (len % 2);
  }
  throw new Error("WAV file has no data chunk");
}

async function parseAiff(fh: FileHandle, size: number, isAifc: boolean): Promise<Format> {
  let fmt: Omit<Format, "dataStart" | "dataBytes"> | undefined;
  let pos = 12;
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 8);
    const id = h.toString("ascii", 0, 4);
    const len = h.readUInt32BE(4);
    const body = pos + 8;
    if (id === "COMM") {
      const b = await readAt(fh, body, Math.min(len, 64));
      if (isAifc) {
        const comp = b.length >= 22 ? b.toString("ascii", 18, 22) : "NONE";
        if (comp !== "NONE") throw new Error(`Unsupported compressed AIFF-C (${comp}); only uncompressed PCM is supported`);
      }
      const bits = b.readUInt16BE(6);
      if (![16, 24, 32].includes(bits)) throw new Error(`Unsupported AIFF bit depth ${bits}`);
      fmt = { kind: "aiff", channels: b.readUInt16BE(0), bits, sampleRate: readExtended80(b.subarray(8, 18)), float: false };
    } else if (id === "SSND") {
      if (!fmt) throw new Error("AIFF SSND chunk before COMM chunk");
      const ob = await readAt(fh, body, 8);
      const offset = ob.readUInt32BE(0);
      const dataStart = body + 8 + offset;
      return { ...fmt, dataStart, dataBytes: Math.min(len - 8 - offset, size - dataStart) };
    }
    pos = body + len + (len % 2);
  }
  throw new Error("AIFF file has no SSND chunk");
}

async function parseHeader(fh: FileHandle, size: number): Promise<Format> {
  const h = await readAt(fh, 0, 12);
  if (h.length < 12) throw new Error("File too short to be audio");
  const magic = h.toString("ascii", 0, 4);
  const form = h.toString("ascii", 8, 12);
  let f: Format;
  if (magic === "RIFF" && form === "WAVE") f = await parseWav(fh, size);
  else if (magic === "FORM" && (form === "AIFF" || form === "AIFC")) f = await parseAiff(fh, size, form === "AIFC");
  else throw new Error("Unrecognised audio file (expected WAV or AIFF)");
  if (f.channels < 1) throw new Error("Audio file has no channels");
  if (f.channels > 32) throw new Error(`Unsupported channel count ${f.channels} (max 32)`);
  return f;
}

/**
 * Streams a PCM WAV or AIFF file in chunks of planar float samples (-1..1)
 * without loading the whole file. The arrays passed to onChunk are reused
 * between calls; copy them if you need to keep them. onChunk may be async;
 * the next chunk is read only once it settles.
 */
export async function readPcmFile(
  path: string,
  onChunk: (frames: Float32Array[], channels: number) => void | Promise<void>,
  opts: ReadPcmOptions = {},
): Promise<PcmInfo> {
  const chunkFrames = opts.chunkFrames ?? 65536;
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const f = await parseHeader(fh, size);
    const bytesPer = f.bits / 8;
    const blockAlign = bytesPer * f.channels;
    const totalFrames = Math.floor(f.dataBytes / blockAlign);
    const info: PcmInfo = { sampleRate: f.sampleRate, channels: f.channels, frames: totalFrames };
    opts.onFormat?.(f.bits, f.float);
    opts.onHeader?.(info);

    const be = f.kind === "aiff";
    const raw = Buffer.alloc(chunkFrames * blockAlign);
    const planes = Array.from({ length: f.channels }, () => new Float32Array(chunkFrames));
    let done = 0;
    while (done < totalFrames) {
      const want = Math.min(chunkFrames, totalFrames - done);
      const { bytesRead } = await fh.read(raw, 0, want * blockAlign, f.dataStart + done * blockAlign);
      const got = Math.floor(bytesRead / blockAlign);
      if (got === 0) throw new Error("Unexpected end of audio file");
      opts.onBytes?.(raw.subarray(0, got * blockAlign));
      for (let ch = 0; ch < f.channels; ch++) {
        const plane = planes[ch];
        let p = ch * bytesPer;
        for (let i = 0; i < got; i++, p += blockAlign) {
          if (f.float) plane[i] = raw.readFloatLE(p);
          else if (f.bits === 16) plane[i] = (be ? raw.readInt16BE(p) : raw.readInt16LE(p)) / 32768;
          else if (f.bits === 24) plane[i] = (be ? raw.readIntBE(p, 3) : raw.readIntLE(p, 3)) / 8388608;
          else plane[i] = (be ? raw.readInt32BE(p) : raw.readInt32LE(p)) / 2147483648;
        }
      }
      await onChunk(
        planes.map((pl) => pl.subarray(0, got)),
        f.channels,
      );
      done += got;
    }
    return info;
  } finally {
    await fh.close();
  }
}
