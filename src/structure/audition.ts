// Stems kept for audition (feedback round 2 B): a click on a stem lane cell plays that section of that stem.
// `<storage>/stems/<cache key>/<stem>.wav`, 16-bit 44.1 kHz stereo at the clip's own level (inputGainDb taken back
// out). The engine streams them while it reads the stems in slices (monoAndLoudness), into `<key>.part-<uuid>`, and
// renames that to `<key>` only when the analysis has succeeded, so a cancelled or failed run leaves no folder that a
// later dialog could use. At most AUDITION_LIMIT_BYTES of folders are kept: the least recently used are evicted whole.
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { STEM_NAMES, type StemName } from "./contract.js";

export const AUDITION_RATE = 44100;
/** All stem folders together (42.3 MB per minute of audio: 4 stems × 44100 × 2 channels × 2 bytes × 60). */
export const AUDITION_LIMIT_BYTES = 1.5e9;
const HEADER_BYTES = 44;
const BYTES_PER_FRAME = 4; // 2 channels × int16
/** A `.part-` folder this much older than now was left by a run that never finished (a crash): prune deletes it. */
const STALE_PART_MS = 3600_000;
const PART = ".part-";
const DEL = ".del-";

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/** Codes a Windows rename gives while Defender or the indexer still holds a freshly closed file (fb2 review M4). */
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
/** The waits before each retry: about 1.5 s in all. */
export const RENAME_RETRY_MS = [50, 100, 200, 400, 800];

/** rename, retried over RENAME_RETRY_MS while it fails with a transient code. */
export async function renameRetrying(from: string, to: string, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (let k = 0; ; k++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (k >= RENAME_RETRY_MS.length || !TRANSIENT_RENAME.has(String((error as { code?: unknown }).code))) throw error;
      await wait(RENAME_RETRY_MS[k]);
    }
  }
}

/** `<storage>/stems/<key>`; throws when the key is not a plain name (as the analysis cache does). */
export function auditionDir(storageDir: string, key: string): string {
  if (!SAFE_KEY.test(key) || key === "." || key === "..") throw new Error(`Invalid stem folder key: ${JSON.stringify(key)}`);
  return join(storageDir, "stems", key);
}

/** The 44-byte header of a 16-bit PCM stereo WAV at AUDITION_RATE with `frames` frames. */
export function pcm16Header(frames: number): Buffer {
  const data = frames * BYTES_PER_FRAME;
  const h = Buffer.alloc(HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(AUDITION_RATE, 24);
  h.writeUInt32LE(AUDITION_RATE * BYTES_PER_FRAME, 28);
  h.writeUInt16LE(BYTES_PER_FRAME, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data, 40);
  return h;
}

/**
 * `left`/`right` × `gain`, interleaved into `out` as 16-bit (× 32767, rounded, clamped at full scale; NaN is 0).
 * Returns the filled part of `out`, which must hold 2 × left.length samples.
 */
export function toPcm16(left: Float32Array, right: Float32Array, gain: number, out: Int16Array): Int16Array {
  const n = left.length;
  for (let i = 0; i < n; i++) {
    let l = left[i] * gain;
    let r = right[i] * gain;
    l = l > 1 ? 1 : l < -1 ? -1 : l;
    r = r > 1 ? 1 : r < -1 ? -1 : r;
    out[2 * i] = Math.round(l * 32767);
    out[2 * i + 1] = Math.round(r * 32767);
  }
  return out.subarray(0, 2 * n);
}

export interface AuditionWriter {
  /** Opens `<stem>.wav` in the temp folder for `frames` frames. */
  begin(stem: StemName, frames: number): Promise<void>;
  /** Appends a slice (contiguous, from `offset`) as 16-bit. Never throws: an I/O failure disables the writer. */
  write(stem: StemName, left: Float32Array, right: Float32Array, offset: number): Promise<void>;
  /**
   * When all four stems are complete, replaces the final folder with the temp one by renames and resolves true.
   * Otherwise (a stem missing or short, an I/O failure, after discard) deletes the temp folder and resolves false.
   */
  commit(): Promise<boolean>;
  /** Closes and deletes the temp folder (cancel, error). Safe to call more than once, and after commit. */
  discard(): Promise<void>;
}

/**
 * Writes the four audition stems for `finalDir`, scaled by -`inputGainDb` (the clip's own level). Holds one slice's
 * 16-bit buffer (grown to the largest slice, reused) and four file handles; nothing else.
 */
export function createAuditionWriter(
  finalDir: string,
  inputGainDb: number,
  log: (...args: unknown[]) => void = (...a) => console.error(...a),
): AuditionWriter {
  const gain = 10 ** (-inputGainDb / 20);
  const temp = `${finalDir}${PART}${randomUUID()}`;
  const files = new Map<StemName, { fh: FileHandle; frames: number; written: number }>();
  let scratch = new Int16Array(0);
  let made = false;
  let failed = false;
  let done = false; // committed or discarded

  const fail = (error: unknown) => {
    if (!failed) log("Song Sections: could not keep the stems for listening:", error);
    failed = true;
  };
  const closeAll = async () => {
    const open = [...files.values()];
    files.clear();
    await Promise.all(open.map((f) => f.fh.close().catch(() => undefined)));
  };
  const writeAt = async (fh: FileHandle, bytes: Uint8Array, position: number) => {
    let n = 0;
    while (n < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, n, bytes.length - n, position + n);
      n += bytesWritten;
    }
  };
  const discard = async () => {
    done = true;
    await closeAll();
    if (made) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  };

  return {
    async begin(stem, frames) {
      if (failed || done) return;
      try {
        if (!made) {
          await mkdir(temp, { recursive: true });
          made = true;
        }
        const fh = await open(join(temp, `${stem}.wav`), "w");
        files.set(stem, { fh, frames, written: 0 });
        await writeAt(fh, pcm16Header(frames), 0);
      } catch (error) {
        fail(error);
      }
    },

    async write(stem, left, right, offset) {
      if (failed || done) return;
      const f = files.get(stem);
      try {
        if (!f) throw new Error(`audition stem ${stem}: write before begin`);
        if (offset !== f.written) throw new Error(`audition stem ${stem}: writes must be contiguous (offset ${offset}, expected ${f.written})`);
        if (offset + left.length > f.frames) throw new Error(`audition stem ${stem}: more than ${f.frames} frames`);
        if (scratch.length < 2 * left.length) scratch = new Int16Array(2 * left.length);
        const pcm = toPcm16(left, right, gain, scratch);
        await writeAt(f.fh, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), HEADER_BYTES + offset * BYTES_PER_FRAME);
        f.written += left.length;
      } catch (error) {
        fail(error);
      }
    },

    async commit() {
      if (done) return false;
      const complete = !failed && STEM_NAMES.every((s) => files.has(s) && files.get(s)!.written === files.get(s)!.frames);
      if (!complete) {
        await discard();
        return false;
      }
      const old = `${finalDir}${DEL}${randomUUID()}`;
      let moved = false;
      try {
        // On disk before the folder is renamed in, so a power loss cannot leave a committed folder of truncated
        // files that auditionReady, which checks only the names, would accept (fb2 review M5). Where it is allowed:
        // Live's installed host runs Node with --permission, which denies fsync (1.0.0 demo: no stems were kept).
        await Promise.all([...files.values()].map((f) => syncUnlessDenied(f.fh)));
        await closeAll();
        // An older folder for this key (a re-analysis) is renamed away first, so no reader sees a mix of the two.
        // Both renames retry while Windows holds a just-closed file (fb2 review M4).
        try {
          await renameRetrying(finalDir, old);
          moved = true;
        } catch (error) {
          if ((error as { code?: unknown }).code !== "ENOENT") throw error;
        }
        try {
          await renameRetrying(temp, finalDir);
        } catch (error) {
          // The new stems cannot go in: put the older ones back rather than lose both.
          if (moved) await rename(old, finalDir).catch(() => undefined);
          throw error;
        }
        done = true;
        if (moved) await rm(old, { recursive: true, force: true }).catch(() => undefined);
        await touchAudition(finalDir).catch(() => undefined);
        return true;
      } catch (error) {
        fail(error);
        await discard();
        return false;
      }
    },

    discard,
  };
}

/** fsync, skipped when Node's permission model denies it (ERR_ACCESS_DENIED); any other failure throws. */
async function syncUnlessDenied(fh: FileHandle): Promise<void> {
  try {
    await fh.sync();
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ERR_ACCESS_DENIED") throw error;
  }
}

/** True when `dir` holds all four stems (a committed folder is complete by construction). */
export async function auditionReady(dir: string): Promise<boolean> {
  try {
    const names = new Set(await readdir(dir));
    return STEM_NAMES.every((s) => names.has(`${s}.wav`));
  } catch {
    return false;
  }
}

/** Marks a folder as just used (its mtime is the LRU clock). */
export async function touchAudition(dir: string): Promise<void> {
  const now = new Date();
  await utimes(dir, now, now);
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir)) {
    try {
      total += (await stat(join(dir, name))).size;
    } catch {
      // vanished: counts as nothing
    }
  }
  return total;
}

/** Renames a folder aside, then deletes it: a reader never sees it half-deleted. */
async function evict(path: string): Promise<void> {
  const aside = `${path}${DEL}${randomUUID()}`;
  await rename(path, aside);
  await rm(aside, { recursive: true, force: true });
}

/**
 * Keeps the stem folders under `<storage>/stems/` to at most `limit` bytes, evicting the least recently used (oldest
 * mtime) whole folders first; `keepKey`'s folder (the one in use) is never evicted. Deletion leftovers, and temp
 * folders no write has finished in an hour, are removed. Resolves the evicted keys, oldest first.
 */
export async function pruneAuditions(storageDir: string, keepKey: string, limit = AUDITION_LIMIT_BYTES, now = Date.now()): Promise<string[]> {
  const root = join(storageDir, "stems");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const folders: { name: string; mtime: number; bytes: number }[] = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      const st = await stat(path);
      if (!st.isDirectory()) continue;
      if (name.includes(DEL) || (name.includes(PART) && now - st.mtimeMs > STALE_PART_MS)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (name.includes(PART)) continue; // a write in progress
      folders.push({ name, mtime: st.mtimeMs, bytes: await folderBytes(path) });
    } catch {
      // vanished or unreadable: leave it
    }
  }
  let total = folders.reduce((s, f) => s + f.bytes, 0);
  const evicted: string[] = [];
  for (const f of folders.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= limit) break;
    if (f.name === keepKey) continue;
    try {
      await evict(join(root, f.name));
      total -= f.bytes;
      evicted.push(f.name);
    } catch {
      // in use or gone: try the next one
    }
  }
  return evicted;
}
