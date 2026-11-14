import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPcmFile } from "../audio/pcmFile.js";
import { createStemStore } from "./stems.js";

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ss-stems-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const ramp = (n: number, scale: number, from = 0) => Float32Array.from({ length: n }, (_, i) => scale * Math.sin((from + i) / 7));

async function fill(dir: string, n: number, chunk: number) {
  const store = createStemStore(dir);
  for (let off = 0; off < n; off += chunk) {
    const len = Math.min(chunk, n - off);
    for (let s = 0; s < 4; s++) await store.write(s, ramp(len, 0.1 * (s + 1), off), ramp(len, -0.2 * (s + 1), off), off);
  }
  return store;
}

describe("createStemStore", () => {
  it("stores each source on disk under dir and reads it back exactly", async () => {
    const dir = join(tmp(), "structure-x");
    const store = await fill(dir, 1000, 300);
    expect(readdirSync(dir).length).toBeGreaterThanOrEqual(4);
    for (let s = 0; s < 4; s++) {
      const { left, right } = await store.read(s);
      expect(left).toEqual(ramp(1000, 0.1 * (s + 1)));
      expect(right).toEqual(ramp(1000, -0.2 * (s + 1)));
    }
    await store.dispose();
  });

  it("reads back a stem longer than one 1 MB read chunk", async () => {
    const n = 300_001; // 2.4 MB interleaved: three chunks, the last partial
    const store = await fill(join(tmp(), "big"), n, 65_536);
    const { left, right } = await store.read(2);
    expect(left).toEqual(ramp(n, 0.3));
    expect(right).toEqual(ramp(n, -0.6));
    await store.dispose();
  });

  it("readSlices hands over the source in order, framesPerSlice frames at a time (the last partial), equal to read()", async () => {
    const n = 300_001;
    const store = await fill(join(tmp(), "slices"), n, 65_536);
    expect(store.frames(1)).toBe(n);
    const whole = await store.read(1);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const sizes: number[] = [];
    await store.readSlices(1, 100_000, async (l, r, offset) => {
      expect(offset).toBe(sizes.reduce((a, b) => a + b, 0));
      sizes.push(l.length);
      left.set(l, offset);
      right.set(r, offset);
    });
    expect(sizes).toEqual([100_000, 100_000, 100_000, 1]);
    expect(left).toEqual(whole.left);
    expect(right).toEqual(whole.right);
    await store.dispose();
  });

  it("tracks the peak |x| over both channels of the whole source", async () => {
    const store = await fill(join(tmp(), "s"), 1000, 300);
    for (let s = 0; s < 4; s++) {
      const r = ramp(1000, -0.2 * (s + 1));
      expect(store.peak(s)).toBe(Math.max(...Array.from(r, Math.abs)));
    }
    await store.dispose(); // review M8: an undisposed store leaves file handles to the GC (DEP0137)
    const empty = createStemStore(join(tmp(), "empty"));
    expect(empty.peak(0)).toBe(0);
    await empty.dispose();
  });

  it("refuses writes that are not contiguous and ascending", async () => {
    const store = createStemStore(join(tmp(), "s"));
    await store.write(0, new Float32Array(10), new Float32Array(10), 0);
    await expect(store.write(0, new Float32Array(10), new Float32Array(10), 20)).rejects.toThrow(/contiguous/);
    await expect(store.write(1, new Float32Array(3), new Float32Array(2), 0)).rejects.toThrow(/length/);
    await store.dispose();
  });

  it("writeWavs leaves <stem>.wav files, 32-bit float stereo 44.1 kHz, named in Demucs order", async () => {
    const store = await fill(join(tmp(), "s"), 5000, 1234);
    const dest = join(tmp(), "keep");
    await store.writeWavs(dest);
    expect(readdirSync(dest).sort()).toEqual(["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
    for (const [s, name] of ["drums", "bass", "other", "vocals"].entries()) {
      const got: Float32Array[] = [new Float32Array(5000), new Float32Array(5000)];
      let at = 0;
      const info = await readPcmFile(join(dest, `${name}.wav`), (frames) => {
        got[0].set(frames[0], at);
        got[1].set(frames[1], at);
        at += frames[0].length;
      });
      expect(info).toEqual({ sampleRate: 44100, channels: 2, frames: 5000 });
      expect(got[0]).toEqual(ramp(5000, 0.1 * (s + 1)));
      expect(got[1]).toEqual(ramp(5000, -0.2 * (s + 1)));
    }
    await store.dispose();
    expect(existsSync(join(dest, "drums.wav"))).toBe(true); // kept: only the store's own dir is deleted
  });

  it("dispose deletes dir (idempotent), also when nothing was written", async () => {
    const dir = join(tmp(), "structure-y");
    const store = await fill(dir, 100, 100);
    await store.dispose();
    expect(existsSync(dir)).toBe(false);
    await store.dispose();
    const empty = createStemStore(join(tmp(), "structure-z"));
    await empty.dispose();
    expect(existsSync(join(tmp(), "structure-z"))).toBe(false);
  });
});
