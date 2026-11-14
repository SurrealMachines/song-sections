// Separated stems on disk (Review Focus 5): separate() streams finished samples here, so a long track never
// holds four stereo stems in memory. One file per source, raw interleaved float32 (little-endian, as every
// target platform is), in `dir`, which dispose() deletes.
import { mkdirSync } from "node:fs";
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { DEMUCS_SOURCES, SAMPLE_RATE } from "./demucs/dsp.js";
import type { StemSink } from "./demucs/separate.js";

export interface StemStore extends StemSink {
  /** max |x| over both channels of everything written to `source` (0 before any write). */
  peak(source: number): number;
  read(source: number): Promise<{ left: Float32Array; right: Float32Array }>;
  /** Frames written to `source`. */
  frames(source: number): number;
  /**
   * Calls `fn(left, right, offset)` for consecutive slices of `framesPerSlice` frames (the last may be shorter), in
   * order, awaiting each call. The arrays are reused between calls: copy what you keep. Unlike read(), the stem never
   * exists whole in memory (20 min: 423 MB per stem).
   */
  readSlices(source: number, framesPerSlice: number, fn: (left: Float32Array, right: Float32Array, offset: number) => void | Promise<void>): Promise<void>;
  /** `<destDir>/<stem>.wav` for each source: 32-bit float stereo at 44.1 kHz. */
  writeWavs(destDir: string): Promise<void>;
  /** Closes the files and deletes `dir`. Safe to call more than once. */
  dispose(): Promise<void>;
}

const SOURCES = DEMUCS_SOURCES.length;
const BYTES_PER_FRAME = 8; // 2 channels × float32
const READ_CHUNK_BYTES = 1 << 20;

function wavHeader(frames: number): Buffer {
  const data = frames * BYTES_PER_FRAME;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // WAVE_FORMAT_IEEE_FLOAT
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  h.writeUInt16LE(BYTES_PER_FRAME, 32);
  h.writeUInt16LE(32, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data, 40);
  return h;
}

export function createStemStore(dir: string): StemStore {
  mkdirSync(dir, { recursive: true });
  const path = (s: number) => join(dir, `${DEMUCS_SOURCES[s]}.f32`);
  const handles: (FileHandle | undefined)[] = new Array(SOURCES);
  const frames = new Array<number>(SOURCES).fill(0);
  const peaks = new Array<number>(SOURCES).fill(0);
  let disposed = false;

  const closeAll = async () => {
    await Promise.all(handles.map((h) => h?.close()));
    handles.fill(undefined);
  };

  return {
    async write(source, left, right, offset) {
      if (disposed) throw new Error("stem store was disposed");
      if (left.length !== right.length) throw new Error(`channel length ${left.length} vs ${right.length}`);
      if (offset !== frames[source]) throw new Error(`stem ${source}: writes must be contiguous (offset ${offset}, expected ${frames[source]})`);
      const n = left.length;
      const buf = new Float32Array(2 * n);
      let peak = peaks[source];
      for (let i = 0; i < n; i++) {
        const l = left[i];
        const r = right[i];
        buf[2 * i] = l;
        buf[2 * i + 1] = r;
        const a = Math.max(Math.abs(l), Math.abs(r));
        if (a > peak) peak = a;
      }
      handles[source] ??= await open(path(source), "w");
      const bytes = new Uint8Array(buf.buffer);
      let done = 0;
      while (done < bytes.length) {
        const { bytesWritten } = await handles[source]!.write(bytes, done, bytes.length - done, offset * BYTES_PER_FRAME + done);
        done += bytesWritten;
      }
      peaks[source] = peak;
      frames[source] += n;
    },

    peak: (source) => peaks[source],

    frames: (source) => frames[source],

    async readSlices(source, framesPerSlice, fn) {
      const n = frames[source];
      if (n === 0) return;
      const buf = new Float32Array(2 * framesPerSlice);
      const bytes = new Uint8Array(buf.buffer);
      const left = new Float32Array(framesPerSlice);
      const right = new Float32Array(framesPerSlice);
      const fh = await open(path(source), "r");
      try {
        for (let f0 = 0; f0 < n; f0 += framesPerSlice) {
          const count = Math.min(framesPerSlice, n - f0);
          const want = count * BYTES_PER_FRAME;
          let done = 0;
          while (done < want) {
            const { bytesRead } = await fh.read(bytes, done, want - done, f0 * BYTES_PER_FRAME + done);
            if (bytesRead === 0) throw new Error(`stem ${source}: file is short (frame ${f0 + done / BYTES_PER_FRAME} of ${n})`);
            done += bytesRead;
          }
          for (let i = 0; i < count; i++) {
            left[i] = buf[2 * i];
            right[i] = buf[2 * i + 1];
          }
          await fn(left.subarray(0, count), right.subarray(0, count), f0);
        }
      } finally {
        await fh.close();
      }
    },

    async read(source) {
      // Deinterleaved 1 MB at a time: a 5-minute stem never exists twice (interleaved and split) in memory.
      const n = frames[source];
      const left = new Float32Array(n);
      const right = new Float32Array(n);
      if (n === 0) return { left, right };
      const chunkFrames = READ_CHUNK_BYTES / BYTES_PER_FRAME;
      const buf = new Float32Array(2 * chunkFrames);
      const bytes = new Uint8Array(buf.buffer);
      const fh = await open(path(source), "r");
      try {
        for (let f0 = 0; f0 < n; f0 += chunkFrames) {
          const count = Math.min(chunkFrames, n - f0);
          const want = count * BYTES_PER_FRAME;
          let done = 0;
          while (done < want) {
            const { bytesRead } = await fh.read(bytes, done, want - done, f0 * BYTES_PER_FRAME + done);
            if (bytesRead === 0) throw new Error(`stem ${source}: file is short (frame ${f0 + done / BYTES_PER_FRAME} of ${n})`);
            done += bytesRead;
          }
          for (let i = 0; i < count; i++) {
            left[f0 + i] = buf[2 * i];
            right[f0 + i] = buf[2 * i + 1];
          }
        }
      } finally {
        await fh.close();
      }
      return { left, right };
    },

    async writeWavs(destDir) {
      await mkdir(destDir, { recursive: true });
      for (let s = 0; s < SOURCES; s++) {
        const dest = join(destDir, `${DEMUCS_SOURCES[s]}.wav`);
        const out = await open(dest, "w");
        try {
          await out.write(wavHeader(frames[s]));
        } finally {
          await out.close();
        }
        if (frames[s] > 0 && (await stat(path(s))).size > 0) {
          await pipeline(createReadStream(path(s)), createWriteStream(dest, { flags: "a" }));
        }
      }
    },

    async dispose() {
      disposed = true;
      try {
        await closeAll();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
