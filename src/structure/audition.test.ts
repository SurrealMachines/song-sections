import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readPcmFile } from "../audio/pcmFile.js";
import {
  AUDITION_LIMIT_BYTES,
  AUDITION_RATE,
  auditionDir,
  auditionReady,
  createAuditionWriter,
  pcm16Header,
  pruneAuditions,
  toPcm16,
  touchAudition,
} from "./audition.js";
import { STEM_NAMES } from "./contract.js";

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ss-audition-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const wave = (n: number, scale: number, from = 0) => Float32Array.from({ length: n }, (_, i) => scale * Math.sin((from + i) / 5));

/** The interleaved 16-bit samples of a WAV this module wrote (its header is always 44 bytes). */
function samples(path: string): Int16Array {
  const b = readFileSync(path);
  return new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length));
}

describe("pcm16Header", () => {
  it("is a 44-byte PCM WAVE header: 16-bit, stereo, 44.1 kHz, data size frames × 4", () => {
    const h = pcm16Header(1000);
    expect(h.length).toBe(44);
    expect(h.toString("ascii", 0, 4)).toBe("RIFF");
    expect(h.readUInt32LE(4)).toBe(36 + 4000);
    expect(h.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(h.readUInt32LE(16)).toBe(16);
    expect(h.readUInt16LE(20)).toBe(1); // PCM
    expect(h.readUInt16LE(22)).toBe(2);
    expect(h.readUInt32LE(24)).toBe(44100);
    expect(h.readUInt32LE(28)).toBe(44100 * 4);
    expect(h.readUInt16LE(32)).toBe(4);
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.toString("ascii", 36, 40)).toBe("data");
    expect(h.readUInt32LE(40)).toBe(4000);
    expect(AUDITION_RATE).toBe(44100);
  });
});

describe("toPcm16", () => {
  it("interleaves, applies the gain, rounds to 16 bits and clamps at full scale", () => {
    const out = new Int16Array(16);
    const got = toPcm16(Float32Array.of(0.5, -0.5, 1.5, -2, 0), Float32Array.of(0.25, 1, -1, 0.001, NaN), 1, out);
    expect(got.length).toBe(10);
    expect(Array.from(got)).toEqual([16384, 8192, -16383, 32767, 32767, -32767, -32767, 33, 0, 0]);
    // The clip's own level: gain 0.1 is the scaled stem taken back down by 20 dB.
    expect(Array.from(toPcm16(Float32Array.of(0.5), Float32Array.of(-1), 0.1, out))).toEqual([1638, -3277]);
  });

  it("reuses the caller's buffer (no allocation per slice)", () => {
    const out = new Int16Array(8);
    expect(toPcm16(new Float32Array(4), new Float32Array(4), 1, out).buffer).toBe(out.buffer);
  });
});

describe("auditionDir", () => {
  it("is <storage>/stems/<key>, and rejects a key that could leave it", () => {
    expect(auditionDir("/s", "abc_1.2-x")).toBe(join("/s", "stems", "abc_1.2-x"));
    for (const bad of ["", ".", "..", "a/b", "../x", "a\\b"]) expect(() => auditionDir("/s", bad)).toThrow(/key/);
  });
});

describe("createAuditionWriter", () => {
  const N = 1000;

  async function writeAll(final: string, slice: number, gainDb = 0) {
    const w = createAuditionWriter(final, gainDb);
    for (const [s, stem] of STEM_NAMES.entries()) {
      await w.begin(stem, N);
      for (let off = 0; off < N; off += slice) {
        const n = Math.min(slice, N - off);
        await w.write(stem, wave(n, 0.1 * (s + 1), off), wave(n, -0.2 * (s + 1), off), off);
      }
    }
    return w;
  }

  it("commits four 16-bit 44.1 kHz stereo WAVs into the final folder, and nothing else is left", async () => {
    const root = tmp();
    const final = join(root, "stems", "k1");
    const w = await writeAll(final, 300);
    expect(existsSync(final)).toBe(false); // nothing visible before the commit
    expect(await w.commit()).toBe(true);
    expect(readdirSync(join(root, "stems"))).toEqual(["k1"]);
    expect(readdirSync(final).sort()).toEqual(["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
    for (const [s, stem] of STEM_NAMES.entries()) {
      const info = await readPcmFile(join(final, `${stem}.wav`), () => {});
      expect(info).toEqual({ sampleRate: 44100, channels: 2, frames: N });
      const pcm = samples(join(final, `${stem}.wav`));
      const ref = toPcm16(wave(N, 0.1 * (s + 1)), wave(N, -0.2 * (s + 1)), 1, new Int16Array(2 * N));
      expect(pcm).toEqual(ref);
    }
    expect(await auditionReady(final)).toBe(true);
  });

  it("streams: the same bytes whatever the slice size, and each slice is on disk once its write resolves", async () => {
    const a = join(tmp(), "a");
    const b = join(tmp(), "b");
    await (await writeAll(a, 1000)).commit();
    await (await writeAll(b, 7)).commit();
    for (const stem of STEM_NAMES) expect(readFileSync(join(b, `${stem}.wav`))).toEqual(readFileSync(join(a, `${stem}.wav`)));

    const root = tmp();
    const w = createAuditionWriter(join(root, "k"), 0);
    await w.begin("drums", N);
    await w.write("drums", wave(100, 0.1), wave(100, 0.1), 0);
    const part = readdirSync(root).find((f) => f.includes(".part-"))!;
    expect(statSync(join(root, part, "drums.wav")).size).toBeGreaterThanOrEqual(44 + 100 * 4);
    await w.discard();
  });

  it("writes at the clip's own level: inputGainDb is taken back out", async () => {
    const final = join(tmp(), "g");
    const w = createAuditionWriter(final, 20);
    for (const stem of STEM_NAMES) {
      await w.begin(stem, 2);
      await w.write(stem, Float32Array.of(0.5, 1), Float32Array.of(-0.5, 2), 0);
    }
    await w.commit();
    expect(Array.from(samples(join(final, "drums.wav")))).toEqual([1638, -1638, 3277, 6553]);
  });

  it("discard (cancel or error) removes the temp folder and leaves no final folder", async () => {
    const root = tmp();
    const final = join(root, "k");
    const w = createAuditionWriter(final, 0);
    await w.begin("drums", N);
    await w.write("drums", wave(10, 0.1), wave(10, 0.1), 0);
    await w.discard();
    await w.discard(); // idempotent
    expect(readdirSync(root)).toEqual([]);
    expect(await w.commit()).toBe(false); // a discarded writer never commits
    expect(existsSync(final)).toBe(false);
  });

  it("an incomplete write is not committed: a stem missing, or short of its frames", async () => {
    const root = tmp();
    const w = createAuditionWriter(join(root, "k"), 0);
    for (const stem of STEM_NAMES.slice(0, 3)) {
      await w.begin(stem, 10);
      await w.write(stem, new Float32Array(10), new Float32Array(10), 0);
    }
    expect(await w.commit()).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    const w2 = createAuditionWriter(join(root, "k"), 0);
    for (const stem of STEM_NAMES) {
      await w2.begin(stem, 10);
      await w2.write(stem, new Float32Array(stem === "bass" ? 9 : 10), new Float32Array(stem === "bass" ? 9 : 10), 0);
    }
    expect(await w2.commit()).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("an I/O failure never throws: the writer logs once, stops, and commits nothing", async () => {
    const root = tmp();
    writeFileSync(join(root, "stems"), "a file where the folder should be");
    const log = vi.fn();
    const w = createAuditionWriter(join(root, "stems", "k"), 0, log);
    for (const stem of STEM_NAMES) {
      await w.begin(stem, 4);
      await w.write(stem, new Float32Array(4), new Float32Array(4), 0);
    }
    expect(await w.commit()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readdirSync(root)).toEqual(["stems"]);
  });

  // 1.0.0 demo: Live's installed host runs Node with --permission, which disables fsync and fdatasync. The commit
  // threw on fh.sync(), so no stems were ever kept: no lane audition, and the stem sends greyed out.
  it("commits under Live's Node permission model, where fsync is denied", async () => {
    const probe = await open(join(tmp(), "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const denied = vi.spyOn(proto, "sync").mockRejectedValue(
      Object.assign(new Error("fsync API is disabled when Permission Model is enabled."), { code: "ERR_ACCESS_DENIED" }),
    );
    try {
      const root = tmp();
      const final = join(root, "stems", "k1");
      const log = vi.fn();
      const w = createAuditionWriter(final, 0, log);
      for (const stem of STEM_NAMES) {
        await w.begin(stem, N);
        await w.write(stem, wave(N, 0.1), wave(N, 0.1), 0);
      }
      expect(await w.commit()).toBe(true);
      expect(denied).toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(await auditionReady(final)).toBe(true);
    } finally {
      denied.mockRestore();
    }
  });

  it("replaces an existing folder for the same key whole", async () => {
    const final = join(tmp(), "k");
    mkdirSync(final);
    writeFileSync(join(final, "drums.wav"), "old");
    writeFileSync(join(final, "stale.txt"), "old");
    expect(await (await writeAll(final, 500)).commit()).toBe(true);
    expect(readdirSync(final).sort()).toEqual(["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
    expect(readdirSync(join(final, ".."))).toEqual(["k"]);
  });
});

describe("auditionReady", () => {
  it("is true only when all four stems are there", async () => {
    const d = join(tmp(), "k");
    expect(await auditionReady(d)).toBe(false);
    mkdirSync(d);
    for (const s of STEM_NAMES.slice(0, 3)) writeFileSync(join(d, `${s}.wav`), pcm16Header(0));
    expect(await auditionReady(d)).toBe(false);
    writeFileSync(join(d, "other.wav"), pcm16Header(0));
    expect(await auditionReady(d)).toBe(true);
  });
});

describe("pruneAuditions (LRU over whole folders)", () => {
  const HOUR = 3600_000;
  /** A stem folder of `bytes` (in one file) last used `ageH` hours before `now`. */
  function folder(storage: string, name: string, bytes: number, ageH: number, now: number) {
    const d = join(storage, "stems", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "drums.wav"), Buffer.alloc(bytes));
    const t = (now - ageH * HOUR) / 1000;
    utimesSync(d, t, t);
  }
  const names = (storage: string) => readdirSync(join(storage, "stems")).sort();

  it("keeps at most the limit, evicting the least recently used whole folders first", async () => {
    const s = tmp();
    const now = Date.now();
    folder(s, "a", 400, 5, now);
    folder(s, "b", 400, 1, now);
    folder(s, "c", 400, 3, now);
    folder(s, "d", 400, 2, now);
    const evicted = await pruneAuditions(s, "b", 1000, now);
    expect(evicted).toEqual(["a", "c"]);
    expect(names(s)).toEqual(["b", "d"]);
  });

  it("never evicts the folder in use, even when it alone is over the limit", async () => {
    const s = tmp();
    const now = Date.now();
    folder(s, "big", 2000, 9, now);
    folder(s, "x", 10, 0, now);
    expect(await pruneAuditions(s, "big", 1000, now)).toEqual(["x"]);
    expect(names(s)).toEqual(["big"]);
  });

  it("a touch makes a folder the most recently used", async () => {
    const s = tmp();
    const now = Date.now();
    folder(s, "old", 400, 10, now);
    folder(s, "new", 400, 1, now);
    folder(s, "cur", 400, 0, now);
    await touchAudition(join(s, "stems", "old"));
    expect(await pruneAuditions(s, "cur", 900, now + 1000)).toEqual(["new"]);
    expect(names(s)).toEqual(["cur", "old"]);
  });

  it("removes deletion leftovers and temp folders older than an hour, but not a write in progress", async () => {
    const s = tmp();
    const now = Date.now();
    folder(s, "k.part-1", 10, 2, now);
    folder(s, "k.part-2", 10, 0, now);
    folder(s, "j.del-3", 10, 0, now);
    folder(s, "k", 10, 0, now);
    await pruneAuditions(s, "k", AUDITION_LIMIT_BYTES, now);
    expect(names(s)).toEqual(["k", "k.part-2"]);
  });

  it("is a no-op when there is no stems folder yet", async () => {
    expect(await pruneAuditions(tmp(), "k")).toEqual([]);
  });

  it("the limit is 1.5 GB", () => {
    expect(AUDITION_LIMIT_BYTES).toBe(1.5e9);
  });
});
