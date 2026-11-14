// v2 sends: sections cut out of an audio file (the clip's render, or a kept Structure stem) as WAV files.
import { createHash, type Hash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { readPcmFile } from "./pcmFile.js";

export interface SliceCut {
  /** Seconds from the file's start. */
  startSec: number;
  endSec: number;
  /** Runs to the file's last frame, whatever `endSec` says (the last section: the render may be a few frames longer). */
  toEnd?: boolean;
  /** Where the WAV is written. */
  path: string;
}

export interface SliceFile {
  path: string;
  /** The first frame of the source in the slice, and how many frames it has. */
  startFrame: number;
  frames: number;
  /** SHA-256 (hex) of the slice's audio data, for names that differ when the audio does. */
  sha256: string;
}

export interface SliceResult {
  sampleRate: number;
  channels: number;
  /** The slices' bit depth: 24 for a source deeper than 16 bits (Live's renders are 24-bit AIFF), else 16. */
  bits: 16 | 24;
  slices: SliceFile[];
}

/** The frame at `sec` in a file of `total` frames at `rate`: the nearest one, inside the file. */
export function frameAt(sec: number, rate: number, total: number): number {
  return Math.min(total, Math.max(0, Math.round(sec * rate)));
}

/** The 44-byte header of a PCM WAV. */
export function wavHeader(rate: number, channels: number, bits: 16 | 24, frames: number): Buffer {
  const block = channels * (bits / 8);
  const data = frames * block;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * block, 28);
  h.writeUInt16LE(block, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data, 40);
  return h;
}

/**
 * Cuts each of `cuts` out of the WAV or AIFF at `srcPath` in one pass, as a PCM WAV at the source's sample rate and
 * channel count. Frames are the source's own: a cut starts at the frame nearest its start and ends before the frame
 * nearest its end, so two cuts that meet share the edge and no frame is lost or doubled. An integer source of 16 or
 * 24 bits is copied exactly; deeper or float sources are written as 24-bit.
 *
 * Throws when a cut has no frames (it starts at or past the file's end) before anything is written.
 */
export async function writeSlices(srcPath: string, cuts: readonly SliceCut[], opts: { chunkFrames?: number } = {}): Promise<SliceResult> {
  let rate = 0;
  let channels = 0;
  let bits: 16 | 24 = 16;
  let ranges: Array<{ cut: SliceCut; start: number; end: number }> = [];
  const open_ = new Map<number, { fh: FileHandle; written: number }>();
  const hashes = new Map<number, Hash>();
  let scratch = Buffer.alloc(0);
  let pos = 0; // the source frame the next chunk starts at

  const close = async (k: number) => {
    const f = open_.get(k);
    open_.delete(k);
    await f?.fh.close();
  };

  try {
    await readPcmFile(
      srcPath,
      async (planes, ch) => {
        const n = planes[0].length;
        const from = pos;
        pos += n;
        for (let k = 0; k < ranges.length; k++) {
          const r = ranges[k];
          const a = Math.max(r.start, from);
          const b = Math.min(r.end, from + n);
          if (a >= b) continue;
          let f = open_.get(k);
          if (!f) {
            const fh = await open(r.cut.path, "w");
            f = { fh, written: 0 };
            open_.set(k, f);
            await writeAll(fh, wavHeader(rate, channels, bits, r.end - r.start), 0);
          }
          const bytes = encode(planes, ch, a - from, b - from, bits);
          if (!hashes.has(k)) hashes.set(k, createHash("sha256"));
          hashes.get(k)!.update(bytes);
          await writeAll(f.fh, bytes, 44 + f.written);
          f.written += bytes.length;
          if (b === r.end) await close(k);
        }
      },
      {
        chunkFrames: opts.chunkFrames,
        onFormat: (b, float) => {
          bits = float || b > 16 ? 24 : 16;
        },
        onHeader: (info) => {
          rate = info.sampleRate;
          channels = info.channels;
          ranges = cuts.map((cut, i) => {
            const start = frameAt(cut.startSec, rate, info.frames);
            const end = cut.toEnd ? info.frames : frameAt(cut.endSec, rate, info.frames);
            if (end <= start) throw new Error(`Slice ${i} (${cut.startSec}..${cut.endSec} s) has no audio in the file (${info.frames} frames at ${rate} Hz)`);
            return { cut, start, end };
          });
        },
      },
    );
  } finally {
    await Promise.all([...open_.keys()].map((k) => close(k).catch(() => undefined)));
  }
  return { sampleRate: rate, channels, bits, slices: ranges.map((r, k) => ({ path: r.cut.path, startFrame: r.start, frames: r.end - r.start, sha256: hashes.get(k)!.digest("hex") })) };

  // Interleaves frames [a, b) of `planes` into `scratch` (reused) at `depth` bits, little-endian.
  function encode(planes: Float32Array[], ch: number, a: number, b: number, depth: 16 | 24): Buffer {
    const width = depth / 8;
    const size = (b - a) * ch * width;
    if (scratch.length < size) scratch = Buffer.alloc(size);
    const full = depth === 16 ? 32768 : 8388608;
    let p = 0;
    for (let i = a; i < b; i++) {
      for (let c = 0; c < ch; c++) {
        const v = planes[c][i];
        // The reader divides by 2^(bits-1), so multiplying back is exact for an integer source; clamp the top.
        let s = Math.round((v !== v ? 0 : v) * full);
        s = s >= full ? full - 1 : s < -full ? -full : s;
        scratch[p] = s & 0xff;
        scratch[p + 1] = (s >> 8) & 0xff;
        if (depth === 24) scratch[p + 2] = (s >> 16) & 0xff;
        p += width;
      }
    }
    return scratch.subarray(0, size);
  }
}

async function writeAll(fh: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let n = 0;
  while (n < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, n, bytes.length - n, position + n);
    n += bytesWritten;
  }
}
