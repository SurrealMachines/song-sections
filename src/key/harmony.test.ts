import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCached, saveCached } from "../analysis/cache.js";
import { yieldToHost } from "../core/abort.js";
import { backgroundPace, hostActivity } from "../core/pace.js";
import type { Harmony } from "../dialog/protocol.js";
import { progression } from "../test/chords.js";
import { makeWav } from "../test/makeWav.js";
import { STRUCTURE_ENGINE } from "../structure/contract.js";
import { cachedHarmony, cacheKey, HARMONY_ENGINE, isHarmony, mixHarmony, readMono, stemsHarmony } from "./harmony.js";
import { clipKey, keyLong } from "./key.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "harmony-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A stereo 44.1 kHz 16-bit WAV of `x` (at 11025 Hz), each sample held for 4 frames: what the kept stems look like. */
async function stemWav(path: string, x: Float32Array) {
  await makeWav(path, { sampleRate: 44100, channels: 2, bitDepth: 16, frames: x.length * 4, sample: (_ch, i) => x[Math.floor(i / 4)] });
}

const H: Harmony = { source: "mix", rate: 2, chroma: [new Array(12).fill(0.5)] };

describe("isHarmony", () => {
  it("takes only a whole harmony", () => {
    expect(isHarmony(H)).toBe(true);
    expect(isHarmony({ ...H, source: "drums" })).toBe(false);
    expect(isHarmony({ ...H, rate: 4 })).toBe(false);
    expect(isHarmony({ ...H, chroma: [[1, 2, 3]] })).toBe(false);
    expect(isHarmony({ ...H, chroma: [new Array(12).fill(null)] })).toBe(false);
    expect(isHarmony(null)).toBe(false);
  });
});

describe("readMono and stemsHarmony", () => {
  it("reads a stem as mono at about 11 kHz", async () => {
    const x = progression(["C"], { repeats: 1 }).x;
    await stemWav(join(root, "one.wav"), x);
    const m = await readMono(join(root, "one.wav"));
    expect(m.rate).toBe(11025);
    expect(m.x.length).toBe(x.length);
    expect(m.x[1000]).toBeCloseTo(x[1000], 4);
  });

  it("review I2: one gain for the three stems from their levels together: a quiet set keys as a loud one", async () => {
    const dir = join(root, "quiet-stems");
    await mkdir(dir);
    const g = 10 ** (-40 / 20);
    const other = progression(["Eb", "Ab", "Bb7", "Eb"]).x;
    const bass = progression(["Eb", "Ab", "Bb7", "Eb"], { chordSec: 2 }).x;
    // 24-bit, so the -40 dB set is not mostly quantisation.
    const wav24 = (path: string, x: Float32Array) =>
      makeWav(path, { sampleRate: 44100, channels: 2, bitDepth: 24, frames: x.length * 4, sample: (_ch, i) => x[Math.floor(i / 4)] });
    await wav24(join(dir, "other.wav"), other.map((v) => v * g));
    await wav24(join(dir, "bass.wav"), bass.map((v) => v * g * 0.5));
    await wav24(join(dir, "vocals.wav"), new Float32Array(other.length));
    await wav24(join(dir, "drums.wav"), new Float32Array(other.length));
    const k = clipKey(await stemsHarmony(dir))!;
    expect(keyLong(k)).toBe("E♭ major");
  });

  it("keys from bass, other and vocals summed, and never the drums", async () => {
    const dir = join(root, "stems");
    await mkdir(dir);
    const silence = new Float32Array(progression(["C"], { repeats: 8 }).x.length);
    // Other carries E♭ major; the drums stem holds an A major progression that must not count.
    await stemWav(join(dir, "other.wav"), progression(["Eb", "Ab", "Bb7", "Eb"]).x);
    await stemWav(join(dir, "bass.wav"), silence);
    await stemWav(join(dir, "vocals.wav"), silence);
    await stemWav(join(dir, "drums.wav"), progression(["A", "D", "E7", "A"]).x);
    const h = await stemsHarmony(dir);
    expect(h.source).toBe("stems");
    expect(h.chroma).toHaveLength(32);
    expect(keyLong(clipKey(h)!)).toBe("E♭ major");
  });
});

// Concern 5 (controller ruling): in a background Structure run the stems' chroma shares the host as the run does.
describe("stemsHarmony in the background", () => {
  const fastPace = (activity = hostActivity({ quietMs: 20 })) => backgroundPace(activity, { sleep: () => yieldToHost(), pollMs: 5 });
  let dir: string;
  beforeAll(async () => {
    dir = join(root, "bg-stems");
    await mkdir(dir);
    const { x } = progression(["Bb", "Eb", "F7", "Bb"], { repeats: 2 });
    for (const stem of ["bass", "other", "vocals", "drums"]) await stemWav(join(dir, `${stem}.wav`), x);
  });

  it("gives the same harmony in finer slices, resting after each", async () => {
    const fg = await stemsHarmony(dir);
    const pace = fastPace();
    const bg = await stemsHarmony(dir, undefined, pace);
    expect(bg).toEqual(fg);
    expect(pace.stats().slices).toBeGreaterThan(50);
    expect(pace.stats().restMs).toBeGreaterThanOrEqual(0);
  });

  it("stops at its next yield while the host has foreground work, and goes on once it is quiet", async () => {
    const activity = hostActivity({ quietMs: 20 });
    const pace = fastPace(activity);
    const end = activity.begin();
    let done = false;
    const run = stemsHarmony(dir, undefined, pace).then((h) => ((done = true), h));
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    expect(pace.stats().slices).toBe(1); // stopped at the first yield
    end();
    expect(await run).toEqual(await stemsHarmony(dir));
    expect(pace.stats().pausedMs).toBeGreaterThanOrEqual(100);
  });

  it("an abort ends the wait at once", async () => {
    const activity = hostActivity({ quietMs: 20 });
    activity.begin();
    const ac = new AbortController();
    const run = stemsHarmony(dir, ac.signal, fastPace(activity));
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("cachedHarmony", () => {
  const deps = () => ({ loadCached: vi.fn(loadCached) as typeof loadCached, saveCached: vi.fn(saveCached), logError: vi.fn() });

  it("computes once and caches beside the analyses, in an entry of its own per source", async () => {
    const storage = await mkdtemp(join(root, "storage-"));
    const d = deps();
    const { x, rate } = progression(["C", "F", "G", "C"]);
    const compute = vi.fn(() => mixHarmony(x, rate));
    const first = await cachedHarmony(d, storage, "abc", "mix", compute);
    const again = await cachedHarmony(d, storage, "abc", "mix", compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
    expect(await readdir(join(storage, "cache", HARMONY_ENGINE))).toEqual(["abc-mix.json"]);
    // The stems' entry is another one.
    const stems = vi.fn(async (): Promise<Harmony> => ({ ...H, source: "stems" }));
    expect(await cachedHarmony(d, storage, "abc", "stems", stems)).toEqual({ ...H, source: "stems" });
    expect(stems).toHaveBeenCalledTimes(1);
    // Review M5: the stems' entry names the engine that separated them, so a new engine's stems are computed afresh.
    expect((await readdir(join(storage, "cache", HARMONY_ENGINE))).sort()).toEqual(["abc-mix.json", `abc-stems-${STRUCTURE_ENGINE}.json`]);
    expect(cacheKey("abc", "stems")).toBe(`abc-stems-${STRUCTURE_ENGINE}`);
    await saveCached(storage, "abc-stems-allin1-onnx-3", HARMONY_ENGINE, { ...H, source: "stems", chroma: [new Array(12).fill(0.25)] });
    await rm(join(storage, "cache", HARMONY_ENGINE, `abc-stems-${STRUCTURE_ENGINE}.json`));
    expect(await cachedHarmony(d, storage, "abc", "stems", stems)).toEqual({ ...H, source: "stems" });
    expect(stems).toHaveBeenCalledTimes(2); // an older engine's entry is not used
  });

  it("computes again over a damaged entry", async () => {
    const storage = await mkdtemp(join(root, "storage-"));
    await saveCached(storage, "abc-mix", HARMONY_ENGINE, { source: "mix", rate: 2, chroma: "garbage" });
    expect(await cachedHarmony(deps(), storage, "abc", "mix", async () => H)).toEqual(H);
    expect(await loadCached(storage, "abc-mix", HARMONY_ENGINE)).toEqual(H);
  });

  it("a failure gives null (logged); an abort is thrown; a cache that cannot be written still gives the harmony", async () => {
    const storage = await mkdtemp(join(root, "storage-"));
    const d = deps();
    expect(await cachedHarmony(d, storage, "abc", "mix", async () => Promise.reject(new Error("bad wav")))).toBeNull();
    expect(d.logError).toHaveBeenCalledWith(expect.stringContaining("could not find the key"), expect.any(Error));
    await expect(cachedHarmony(d, storage, "abc", "mix", async () => Promise.reject(new DOMException("stop", "AbortError")))).rejects.toThrow("stop");
    d.saveCached.mockRejectedValueOnce(new Error("disk full"));
    expect(await cachedHarmony(d, storage, "abc", "mix", async () => H)).toEqual(H);
  });
});
