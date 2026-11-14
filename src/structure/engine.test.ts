import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readPcmFile } from "../audio/pcmFile.js";
import { abortError, yieldToHost } from "../core/abort.js";
import { backgroundPace, hostActivity } from "../core/pace.js";
import { modelsDir, spikeOut } from "../test/golden.js";
import { makeWav } from "../test/makeWav.js";
import { trackDownbeats } from "./allin1/dbn/downbeats.js";
import { ALLIN1_BAND_HZ, FUNCTION_LABELS, PEAK_RATE, STEM_NAMES, STRUCTURE_ENGINE, type StructureEnv, type StructureStage } from "./contract.js";
import { SEGMENT_LENGTH } from "./demucs/dsp.js";
import type { DemucsCore } from "./demucs/separate.js";
import { analyseStructure, makeAnalyseStructure, NORMALISE_BELOW_DB, NORMALISE_TO_DB, SILENCE_RMS_DB, type EngineDeps } from "./engine.js";
import type { runFolds as RunFolds } from "./ort/folds.js";
import type { Ort } from "./runtime.js";

const temps: string[] = [];
const tmp = (prefix = "ss-engine-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Task 3's fake core (separate.test.ts, = fake_core in tools/golden/fixtures_demucs.py).
const G = [0.5, 0.25, 0, 1];
const H = [0, 0.5, 1, 0.25];
const L = SEGMENT_LENGTH;
const fakeCore: DemucsCore = async ({ mix, spec }) => {
  const specOut = new Float32Array(4 * spec.length);
  const waveOut = new Float32Array(4 * 2 * L);
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < spec.length; i++) specOut[s * spec.length + i] = G[s] * spec[i];
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < L; i++) waveOut[(s * 2 + c) * L + i] = H[s] * mix[c * L + i] * (i / L);
    }
  }
  return { specOut, waveOut };
};

const VERSE = FUNCTION_LABELS.indexOf("verse");
const CHORUS = FUNCTION_LABELS.indexOf("chorus");

/**
 * Section logits +8 at frames 1000 and 2000 (-8 elsewhere); function logits one-hot verse before frame 1000 and
 * chorus from it; beat logits bump every 50 frames (120 bpm), downbeat logits on every 4th beat, -4 elsewhere.
 */
function foldLogits(T: number, { flat = false } = {}) {
  const beat = new Float32Array(T).fill(-4);
  const downbeat = new Float32Array(T).fill(-4);
  const section = new Float32Array(T).fill(flat ? 0 : -8);
  const fn = new Float32Array(10 * T);
  // A 5-frame bump per beat (like tools/golden/fixtures_dbn.py's beat_track): single-frame impulses read as 60 bpm 3/4.
  const bump = [[-2, -2], [-1, 0], [0, 3], [1, 0.5], [2, -2]] as const;
  for (let k = 0; 50 * k + 13 < T; k++) {
    for (const [dt, v] of bump) {
      const t = 50 * k + 13 + dt;
      if (t >= T) continue;
      beat[t] = Math.max(beat[t], v);
      if (k % 4 === 0) downbeat[t] = Math.max(downbeat[t], v);
    }
  }
  if (!flat) for (let t = 0; t < T; t++) fn[(t < 1000 ? VERSE : CHORUS) * T + t] = 10;
  if (!flat) for (const t of [1000, 2000]) if (t < T) section[t] = 8;
  return { beat, downbeat, section, fn };
}

interface Harness {
  deps: EngineDeps;
  release: ReturnType<typeof vi.fn>;
  core: ReturnType<typeof vi.fn>;
  runFolds: ReturnType<typeof vi.fn>;
  loadOrt: ReturnType<typeof vi.fn>;
  openDemucsCore: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

function harness(opts: { onCore?: (call: number) => void; onFold?: (k: number) => void; failCore?: boolean; flat?: boolean } = {}): Harness {
  const ort = { fake: true } as unknown as Ort;
  let calls = 0;
  const core = vi.fn<DemucsCore>(async (inputs) => {
    calls++;
    if (opts.failCore) throw new Error("core exploded");
    const r = await fakeCore(inputs);
    opts.onCore?.(calls);
    return r;
  });
  const release = vi.fn(async () => {});
  const openDemucsCore = vi.fn(async () => ({ core, release }));
  const runFolds = vi.fn<typeof RunFolds>(async (_ort, _dir, spec, T, signal, onFold) => {
    expect(spec.length).toBe(4 * T * 81);
    for (let k = 0; k < 8; k++) {
      if (signal.aborted) throw abortError();
      await yieldToHost();
      onFold(k);
      opts.onFold?.(k);
    }
    return foldLogits(T, { flat: opts.flat });
  });
  const loadOrt = vi.fn(() => ort);
  const flush = vi.fn(async () => {});
  const deps = { openDemucsCore, runFolds, loadOrt, trackDownbeats, flushReleasedMemory: flush } as unknown as EngineDeps;
  return { deps, release, core, runFolds, loadOrt, openDemucsCore, flush };
}

function env(extra: Partial<StructureEnv> = {}): StructureEnv {
  return { modelDir: "/models/x", tempDir: tmp("ss-temp-"), extensionRoot: "/ext", storageDir: "/storage", ...extra };
}

const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("structure-"));

async function wav(name: string, seconds: number, rate: number, channels: number, sample: (ch: number, i: number) => number) {
  const path = join(tmp(), name);
  await makeWav(path, { sampleRate: rate, channels, bitDepth: 32, float: true, frames: Math.round(seconds * rate), sample });
  return path;
}

const tone = (rate: number) => (ch: number, i: number) => 0.3 * Math.sin((2 * Math.PI * (220 + 110 * ch) * i) / rate) + 0.1 * Math.sin((2 * Math.PI * 3 * i) / rate);

/** Every number reachable in `value` is finite. */
function allFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (value && typeof value === "object") return Object.values(value).every(allFinite);
  return true;
}

function expectContiguous(segments: { start: number; end: number }[], duration: number) {
  expect(segments[0].start).toBe(0);
  expect(segments.at(-1)!.end).toBeCloseTo(duration, 9);
  for (let i = 1; i < segments.length; i++) expect(segments[i].start).toBe(segments[i - 1].end);
  for (const s of segments) expect(s.end).toBeGreaterThan(s.start);
}

describe("analyseStructure with fake models", () => {
  it("30 s of 48 kHz stereo: sections at 10 and 20 s, 60 frames everywhere, beats, progress, no temp left", async () => {
    const h = harness();
    const e = env();
    const progress: [number, StructureStage][] = [];
    const path = await wav("tone48.wav", 30, 48000, 2, tone(48000));
    const r = await makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, (f, s) => progress.push([f, s]));

    expect(r.engine).toBe(STRUCTURE_ENGINE);
    expect(r.durationSec).toBe(30);
    expect(r.segments.map((s) => s.label)).toEqual(["verse", "chorus", "chorus"]);
    expect(r.segments.map((s) => s.start)).toEqual([0, 10, 20]);
    expectContiguous(r.segments, 30);
    expect(r.frames).toBe(60);
    expect(r.featureRate).toBe(2);
    expect(r.functionProbs).toHaveLength(60);
    for (const row of r.functionProbs) {
      expect(row).toHaveLength(10);
      expect(Math.abs(row.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(0.005);
    }
    expect(r.functionProbs[0][VERSE]).toBeGreaterThan(0.99);
    expect(r.functionProbs[59][CHORUS]).toBeGreaterThan(0.99);
    expect(r.bandHz).toEqual([...ALLIN1_BAND_HZ]);
    expect(Object.keys(r.stems).sort()).toEqual([...STEM_NAMES].sort());
    for (const s of STEM_NAMES) {
      expect(r.stems[s].bands).toHaveLength(60);
      for (const row of r.stems[s].bands) expect(row).toHaveLength(81);
      expect(r.stems[s].loudnessDb).toHaveLength(60);
    }
    // The fake core's "other" (G=0, H=1) carries the tone; "drums" (H=0) is the spectral branch only.
    expect(Math.max(...r.stems.other.loudnessDb)).toBeGreaterThan(-40);
    for (const s of STEM_NAMES) {
      expect(r.stems[s].peak).toHaveLength(30 * PEAK_RATE);
      for (const v of r.stems[s].peak) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Math.round(v * 1000) / 1000).toBe(v);
      }
      // The highest peak of a 0.5 s frame's ten blocks is never below the frame's RMS (loudnessDb), within rounding.
      r.stems[s].loudnessDb.forEach((db, f) => {
        const top = Math.max(...r.stems[s].peak.slice(10 * f, 10 * f + 10));
        expect(top + 0.0005).toBeGreaterThanOrEqual(10 ** (db / 20) * 10 ** (-0.05 / 20));
      });
    }
    // The tone (0.3 + 0.1 amplitude) under the fake core's i / L ramp: peaks between 0 and 0.4.
    expect(Math.max(...r.stems.other.peak)).toBeGreaterThan(0.1);
    expect(Math.max(...r.stems.other.peak)).toBeLessThanOrEqual(0.4);

    // Candidates: the fake section logits peak at frames 1000 and 2000 only, and both are chosen.
    expect(r.boundaryCandidates.map((c) => c.time)).toEqual([10, 20]);
    for (const c of r.boundaryCandidates) expect(c.strength).toBe(0.9997); // sigmoid(8), 4 decimals

    expect(r.beats.length).toBeGreaterThan(50);
    expect(r.bpm).toBe(120);
    expect(r.downbeats.length).toBeGreaterThan(10);
    for (const d of r.downbeats) expect(r.beats).toContain(d);
    for (let i = 1; i < r.beats.length; i++) expect(r.beats[i]).toBeGreaterThan(r.beats[i - 1]);
    expect(allFinite(r)).toBe(true);

    const fractions = progress.map(([f]) => f);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
    expect(fractions[0]).toBeGreaterThanOrEqual(0);
    const stages = progress.map(([, s]) => s).filter((s, i, a) => s !== a[i - 1]);
    expect(stages).toEqual(["separating", "features", "structure", "beats"]);

    expect(h.loadOrt).toHaveBeenCalledWith("/ext", "/storage");
    expect(h.openDemucsCore).toHaveBeenCalledWith(h.loadOrt.mock.results[0].value, "/models/x");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.runFolds).toHaveBeenCalledTimes(1);
    expect(h.runFolds.mock.calls[0][1]).toBe("/models/x");
    expect(h.runFolds.mock.calls[0][3]).toBe(3000);
    // Demucs is released before the first fold (never two sessions at once).
    expect(h.release.mock.invocationCallOrder[0]).toBeLessThan(h.runFolds.mock.invocationCallOrder[0]);
    // The released Demucs session's memory is returned before the folds allocate theirs (E10).
    const order = (m: ReturnType<typeof vi.fn>) => m.mock.invocationCallOrder[0];
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledWith(h.loadOrt.mock.results[0].value, "/models/x");
    expect(order(h.release)).toBeLessThan(order(h.flush));
    expect(order(h.flush)).toBeLessThan(order(h.runFolds));
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 120_000);

  it("a mono 44.1 kHz WAV is analysed normally (Review Focus 2)", async () => {
    const h = harness();
    const e = env();
    const path = await wav("mono.wav", 25, 44100, 1, (_, i) => tone(44100)(0, i));
    const r = await makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, () => {});
    expect(r.durationSec).toBe(25);
    expect(r.frames).toBe(50);
    expect(r.segments.map((s) => s.start)).toEqual([0, 10, 20]);
    expectContiguous(r.segments, 25);
    for (const s of STEM_NAMES) expect(r.stems[s].loudnessDb).toHaveLength(50);
    expect(r.bpm).toBe(120);
    expect(h.runFolds).toHaveBeenCalledTimes(1);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 120_000);

  it("3 s of silence: one segment over the clip, no beats, bpm null, every number finite (Review Focus 3)", async () => {
    const h = harness();
    const e = env();
    const progress: number[] = [];
    const path = await wav("silence.wav", 3, 44100, 2, () => 0);
    const r = await makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, (f) => progress.push(f));
    expect(r.segments).toEqual([{ start: 0, end: 3, label: "start" }]);
    expect(r.beats).toEqual([]);
    expect(r.downbeats).toEqual([]);
    expect(r.bpm).toBeNull();
    expect(r.frames).toBe(6);
    expect(r.functionProbs).toHaveLength(6);
    for (const s of STEM_NAMES) expect(r.stems[s].loudnessDb).toEqual(new Array(6).fill(-100));
    for (const s of STEM_NAMES) expect(r.stems[s].peak).toEqual(new Array(3 * PEAK_RATE).fill(0));
    expect(r.boundaryCandidates).toEqual([]);
    expect(allFinite(r)).toBe(true);
    expect(h.runFolds).not.toHaveBeenCalled(); // silence never reaches allin1, whose zero logits give per-frame segments
    expect(progress.at(-1)).toBe(1);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  it("near-silence below SILENCE_RMS_DB counts as silence; a quiet but real signal does not", async () => {
    expect(SILENCE_RMS_DB).toBe(-60);
    const quiet = (db: number) => (ch: number, i: number) => 10 ** (db / 20) * Math.SQRT2 * Math.sin((2 * Math.PI * 440 * i) / 44100 + ch);
    const below = harness();
    const r1 = await makeAnalyseStructure(below.deps)(await wav("m65.wav", 12, 44100, 2, quiet(-65)), env(), new AbortController().signal, () => {});
    expect(below.runFolds).not.toHaveBeenCalled();
    expect(r1.segments).toHaveLength(1);
    const above = harness();
    await makeAnalyseStructure(above.deps)(await wav("m50.wav", 12, 44100, 2, quiet(-50)), env(), new AbortController().signal, () => {});
    expect(above.runFolds).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("flat section logits (no boundary information) give one segment, not allin1's per-frame segments", async () => {
    const h = harness({ flat: true });
    const path = await wav("flat.wav", 12, 44100, 2, tone(44100));
    const r = await makeAnalyseStructure(h.deps)(path, env(), new AbortController().signal, () => {});
    expect(h.runFolds).toHaveBeenCalledTimes(1);
    expect(r.segments).toHaveLength(1);
    expectContiguous(r.segments, 12);
    expect(r.boundaryCandidates).toEqual([]); // flat logits: every frame is a local maximum, none means anything
  }, 60_000);

  it("under 5 allin1 frames: one start segment, no beats, the model is skipped", async () => {
    const h = harness();
    const path = await wav("short.wav", 0.02, 44100, 2, tone(44100));
    const r = await makeAnalyseStructure(h.deps)(path, env(), new AbortController().signal, () => {});
    expect(r.durationSec).toBeCloseTo(0.02, 9);
    expect(r.segments).toEqual([{ start: 0, end: r.durationSec, label: "start" }]);
    expect(r.beats).toEqual([]);
    expect(r.bpm).toBeNull();
    expect(r.frames).toBe(1);
    expect(r.functionProbs).toHaveLength(1);
    expect(r.boundaryCandidates).toEqual([]);
    for (const s of STEM_NAMES) expect(r.stems[s].peak).toHaveLength(1); // 0.02 s: one partial 1/20 s block
    expect(h.runFolds).not.toHaveBeenCalled();
    expect(allFinite(r)).toBe(true);
  }, 60_000);

  it("cancel in the first core call: AbortError, Demucs released once, no temp dir (Review Focus 4)", async () => {
    const c = new AbortController();
    const h = harness({ onCore: (n) => n === 1 && c.abort() });
    const e = env();
    const path = await wav("c1.wav", 30, 44100, 2, tone(44100));
    const err = await makeAnalyseStructure(h.deps)(path, e, c.signal, () => {}).catch((x: unknown) => x);
    expect((err as Error).name).toBe("AbortError");
    expect(h.core).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.runFolds).not.toHaveBeenCalled();
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  it("cancel during runFolds: AbortError, Demucs released once, no temp dir", async () => {
    const c = new AbortController();
    const h = harness({ onFold: (k) => k === 2 && c.abort() });
    const e = env();
    const path = await wav("c2.wav", 30, 44100, 2, tone(44100));
    const err = await makeAnalyseStructure(h.deps)(path, e, c.signal, () => {}).catch((x: unknown) => x);
    expect((err as Error).name).toBe("AbortError");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.runFolds).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  it("an already-aborted signal rejects before any model is opened", async () => {
    const h = harness();
    const c = new AbortController();
    c.abort();
    const e = env();
    const path = await wav("c0.wav", 1, 44100, 2, tone(44100));
    await expect(makeAnalyseStructure(h.deps)(path, e, c.signal, () => {})).rejects.toMatchObject({ name: "AbortError" });
    expect(h.openDemucsCore).not.toHaveBeenCalled();
    expect(leftovers(e.tempDir)).toEqual([]);
  });

  it("a failing core rejects with its error, still releases Demucs once and deletes the temp dir", async () => {
    const h = harness({ failCore: true });
    const e = env();
    const path = await wav("fail.wav", 5, 44100, 2, tone(44100));
    await expect(makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, () => {})).rejects.toThrow("core exploded");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  // Fix round 1 of the Task 9 review.
  const sine = (peakDb: number) => (ch: number, i: number) => 10 ** (peakDb / 20) * Math.sin((2 * Math.PI * (220 + 110 * ch) * i) / 44100);
  /** Peak of the "other" stem (the fake core's H = 1 branch, linear in the mix) written to keepStemsDir. */
  const analysedPeak = async (peakDb: number) => {
    const keep = join(tmp(), "stems");
    const r = await makeAnalyseStructure(harness().deps)(await wav(`p${-peakDb}.wav`, 12, 44100, 2, sine(peakDb)), env({ keepStemsDir: keep }), new AbortController().signal, () => {});
    let peak = 0;
    await readPcmFile(join(keep, "other.wav"), (planes) => {
      for (const p of planes) for (const x of p) peak = Math.max(peak, Math.abs(x));
    });
    return { r, peak };
  };

  it("I1: a mix peaking below -6 dBFS is scaled to peak at -1 dBFS before Demucs; inputGainDb records it", async () => {
    expect(NORMALISE_BELOW_DB).toBe(-6);
    expect(NORMALISE_TO_DB).toBe(-1);
    const ref = await analysedPeak(-1); // already at the target: untouched
    expect(ref.r.inputGainDb).toBe(0);
    const quiet = await analysedPeak(-20);
    expect(quiet.r.inputGainDb).toBeCloseTo(19, 2);
    expect(20 * Math.log10(quiet.peak / ref.peak)).toBeCloseTo(0, 3); // analysed at the same level as the -1 dBFS mix
  }, 60_000);

  it("I1: a mix peaking at or above -6 dBFS is left untouched (inputGainDb 0)", async () => {
    const ref = await analysedPeak(-1);
    const edge = await analysedPeak(-5.9);
    expect(edge.r.inputGainDb).toBe(0);
    expect(20 * Math.log10(edge.peak / ref.peak)).toBeCloseTo(-4.9, 3);
  }, 60_000);

  it("I1: silence is not amplified, and stem loudness stays at the clip's own level", async () => {
    const silent = harness();
    const r0 = await makeAnalyseStructure(silent.deps)(await wav("s.wav", 3, 44100, 2, () => 0), env(), new AbortController().signal, () => {});
    expect(r0.inputGainDb).toBe(0);
    const near = harness();
    const r1 = await makeAnalyseStructure(near.deps)(await wav("m70.wav", 3, 44100, 2, sine(-67)), env(), new AbortController().signal, () => {});
    expect(r1.inputGainDb).toBe(0); // below SILENCE_RMS_DB: one segment, no gain
    const loud = await makeAnalyseStructure(harness().deps)(await wav("l.wav", 12, 44100, 2, sine(-3)), env(), new AbortController().signal, () => {});
    const quiet = await makeAnalyseStructure(harness().deps)(await wav("q.wav", 12, 44100, 2, sine(-23)), env(), new AbortController().signal, () => {});
    expect(quiet.inputGainDb).toBeCloseTo(22, 2);
    const mid = (a: number[]) => a[Math.floor(a.length / 2)];
    expect(mid(quiet.stems.other.loudnessDb)).toBeCloseTo(mid(loud.stems.other.loudnessDb) - 20, 0);
    // The peak envelope too is at the clip's own level: 20 dB down is a tenth.
    expect(mid(quiet.stems.other.peak)).toBeCloseTo(mid(loud.stems.other.peak) / 10, 2);
  }, 120_000);

  it("M5: an empty storageDir is rejected before onnxruntime is loaded", async () => {
    const h = harness();
    const path = await wav("e.wav", 1, 44100, 2, tone(44100));
    await expect(makeAnalyseStructure(h.deps)(path, env({ storageDir: "" }), new AbortController().signal, () => {})).rejects.toThrow(/storageDir/);
    expect(h.loadOrt).not.toHaveBeenCalled();
  });

  it("M4: a release that fails after a failing core does not hide the core's error", async () => {
    const h = harness({ failCore: true });
    h.release.mockRejectedValueOnce(new Error("release failed"));
    const e = env();
    const path = await wav("f2.wav", 5, 44100, 2, tone(44100));
    await expect(makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, () => {})).rejects.toThrow("core exploded");
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  it("M4: a release that fails after a good separation still rejects", async () => {
    const h = harness();
    h.release.mockRejectedValueOnce(new Error("release failed"));
    const path = await wav("f3.wav", 5, 44100, 2, tone(44100));
    await expect(makeAnalyseStructure(h.deps)(path, env(), new AbortController().signal, () => {})).rejects.toThrow("release failed");
  }, 60_000);

  it("M6: a cancel during the folds leaves no stem WAVs in keepStemsDir", async () => {
    const c = new AbortController();
    const h = harness({ onFold: (k) => k === 2 && c.abort() });
    const keep = join(tmp(), "stems");
    const e = env({ keepStemsDir: keep });
    const err = await makeAnalyseStructure(h.deps)(await wav("c3.wav", 12, 44100, 2, tone(44100)), e, c.signal, () => {}).catch((x: unknown) => x);
    expect((err as Error).name).toBe("AbortError");
    expect(existsSync(keep) ? readdirSync(keep) : []).toEqual([]);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  it("M7: an input with no samples is rejected with a clear error", async () => {
    const h = harness();
    const e = env();
    const path = await wav("empty.wav", 0, 44100, 2, () => 0);
    await expect(makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, () => {})).rejects.toThrow(/no audio/i);
    expect(h.openDemucsCore).not.toHaveBeenCalled();
    expect(leftovers(e.tempDir)).toEqual([]);
  });

  it("keepStemsDir leaves four float WAVs as long as the input at 44.1 kHz", async () => {
    const h = harness();
    const keep = join(tmp(), "stems");
    const e = env({ keepStemsDir: keep });
    const path = await wav("keep.wav", 6, 48000, 2, tone(48000));
    await makeAnalyseStructure(h.deps)(path, e, new AbortController().signal, () => {});
    expect(readdirSync(keep).sort()).toEqual(["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
    for (const f of readdirSync(keep)) {
      const info = await readPcmFile(join(keep, f), () => {});
      expect(info).toEqual({ sampleRate: 44100, channels: 2, frames: 6 * 44100 });
    }
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);
});

// fb2 review I1/I2: a background analysis shares the host's thread with Live and the Cue dialog.
describe("analyseStructure in the background", () => {
  const fastPace = (activity = hostActivity({ quietMs: 20 })) =>
    backgroundPace(activity, { sleep: () => yieldToHost(), pollMs: 5 });

  it("gives the same analysis and the same audition stems, byte for byte, in finer slices", async () => {
    const path = await wav("bg48.wav", 30, 48000, 2, tone(48000));
    const runOnce = async (pace?: ReturnType<typeof fastPace>) => {
      const root = tmp();
      const e = env({ auditionStemsDir: join(root, "stems", "k"), ...(pace ? { pace } : {}) });
      const r = await makeAnalyseStructure(harness().deps)(path, e, new AbortController().signal, () => {});
      const stems = Object.fromEntries(STEM_NAMES.map((s) => [s, readFileSync(join(root, "stems", "k", `${s}.wav`)).toString("base64")]));
      return { json: JSON.stringify(r), stems };
    };
    const fg = await runOnce();
    const pace = fastPace();
    const bg = await runOnce(pace);
    expect(bg.json).toBe(fg.json);
    expect(bg.stems).toEqual(fg.stems);
    expect(pace.stats().slices).toBeGreaterThan(100);
  }, 60_000);

  it("stops at its next yield while the host has foreground work, and goes on once it is quiet", async () => {
    const activity = hostActivity({ quietMs: 20 });
    const h = harness();
    const path = await wav("bg-busy.wav", 6, 44100, 2, tone(44100));
    let fraction = 0;
    const end = activity.begin();
    const done = makeAnalyseStructure(h.deps)(path, env({ pace: fastPace(activity) }), new AbortController().signal, (f) => (fraction = f));
    await new Promise((r) => setTimeout(r, 150));
    expect(h.core).not.toHaveBeenCalled();
    expect(fraction).toBeLessThanOrEqual(0.02); // decoded, then stopped at the first yield
    end();
    const r = await done;
    expect(r.durationSec).toBe(6);
    expect(h.core).toHaveBeenCalled();
  }, 60_000);

  it("an abort while it is stopped rejects at once", async () => {
    const activity = hostActivity();
    activity.begin(); // never ends
    const h = harness();
    const path = await wav("bg-abort.wav", 6, 44100, 2, tone(44100));
    const ac = new AbortController();
    const done = makeAnalyseStructure(h.deps)(path, env({ pace: fastPace(activity) }), ac.signal, () => {});
    await new Promise((r) => setTimeout(r, 50));
    const t = performance.now();
    ac.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - t).toBeLessThan(100);
    expect(h.core).not.toHaveBeenCalled();
  }, 60_000);
});

// Feedback round 2 B: the stems kept for audition.
describe("analyseStructure: audition stems", () => {
  const audition = (root: string) => join(root, "stems", "key1");
  const siblings = (root: string) => (existsSync(join(root, "stems")) ? readdirSync(join(root, "stems")) : []);
  const absPeak16 = (path: string) => {
    const b = readFileSync(path);
    const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length));
    let p = 0;
    for (const v of pcm) p = Math.max(p, Math.abs(v));
    return p / 32767;
  };

  it("on success: four 16-bit 44.1 kHz stereo WAVs as long as the input in the folder, and nothing else", async () => {
    const root = tmp();
    const e = env({ auditionStemsDir: audition(root) });
    await makeAnalyseStructure(harness().deps)(await wav("a48.wav", 6, 48000, 2, tone(48000)), e, new AbortController().signal, () => {});
    expect(siblings(root)).toEqual(["key1"]);
    expect(readdirSync(audition(root)).sort()).toEqual(["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
    for (const f of readdirSync(audition(root))) {
      const path = join(audition(root), f);
      expect(readFileSync(path).readUInt16LE(34)).toBe(16);
      expect(await readPcmFile(path, () => {})).toEqual({ sampleRate: 44100, channels: 2, frames: 6 * 44100 });
    }
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 60_000);

  it("silent and too-short clips keep their stems too (the early return commits as well)", async () => {
    const root = tmp();
    await makeAnalyseStructure(harness().deps)(await wav("sil.wav", 3, 44100, 2, () => 0), env({ auditionStemsDir: audition(root) }), new AbortController().signal, () => {});
    expect(readdirSync(audition(root)).length).toBe(4);
  }, 60_000);

  it("at the clip's own level: a quiet mix is analysed 19 dB up, and its audition stems are not", async () => {
    const sine = (ch: number, i: number) => 0.1 * Math.sin((2 * Math.PI * (220 + 110 * ch) * i) / 44100); // -20 dBFS
    const root = tmp();
    const keep = join(root, "float");
    const r = await makeAnalyseStructure(harness().deps)(await wav("q20.wav", 12, 44100, 2, sine), env({ keepStemsDir: keep, auditionStemsDir: audition(root) }), new AbortController().signal, () => {});
    expect(r.inputGainDb).toBeCloseTo(19, 2);
    let analysed = 0;
    await readPcmFile(join(keep, "other.wav"), (planes) => {
      for (const p of planes) for (const x of p) analysed = Math.max(analysed, Math.abs(x));
    });
    const kept = absPeak16(join(audition(root), "other.wav"));
    expect(kept).toBeCloseTo(analysed * 10 ** (-19 / 20), 3);
    expect(kept).toBeLessThan(0.11); // the fake core's "other" is the mix itself, ramped: at most the mix's 0.1 peak
  }, 60_000);

  it("a cancel during the folds leaves no stem folder and no temp folder", async () => {
    const c = new AbortController();
    const root = tmp();
    const h = harness({ onFold: (k) => k === 2 && c.abort() });
    const err = await makeAnalyseStructure(h.deps)(await wav("ac.wav", 12, 44100, 2, tone(44100)), env({ auditionStemsDir: audition(root) }), c.signal, () => {}).catch((x: unknown) => x);
    expect((err as Error).name).toBe("AbortError");
    expect(siblings(root)).toEqual([]);
  }, 60_000);

  it("a cancel while the stems are being written leaves nothing either", async () => {
    const c = new AbortController();
    const root = tmp();
    let stage = 0;
    const err = await makeAnalyseStructure(harness().deps)(await wav("aw.wav", 12, 44100, 2, tone(44100)), env({ auditionStemsDir: audition(root) }), c.signal, (_f, s) => {
      if (s === "features" && ++stage === 1) c.abort(); // after the first stem's features
    }).catch((x: unknown) => x);
    expect((err as Error).name).toBe("AbortError");
    expect(siblings(root)).toEqual([]);
  }, 60_000);

  it("an error after the stems were written leaves no stem folder and no temp folder", async () => {
    const root = tmp();
    const h = harness();
    h.runFolds.mockRejectedValueOnce(new Error("fold exploded"));
    await expect(makeAnalyseStructure(h.deps)(await wav("ae.wav", 12, 44100, 2, tone(44100)), env({ auditionStemsDir: audition(root) }), new AbortController().signal, () => {})).rejects.toThrow("fold exploded");
    expect(siblings(root)).toEqual([]);
  }, 60_000);

  it("a folder that cannot be written does not fail the analysis", async () => {
    const root = tmp();
    writeFileSync(join(root, "stems"), "not a folder");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await makeAnalyseStructure(harness().deps)(await wav("af.wav", 6, 44100, 2, tone(44100)), env({ auditionStemsDir: audition(root) }), new AbortController().signal, () => {});
      expect(r.segments.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(root)).toEqual(["stems"]);
  }, 60_000);
});

// Real models end to end (Flim, Inner City Life, Flim at 48 kHz): engine.golden.test.ts.

const FIVE_MIN = join(process.cwd(), ".dev", "golden", "five-min.wav");

// Global Constraints: peak RSS <= 2.5 GB on a 5-minute track. Wall clock and RSS run only under `npm run test:perf`.
// five-min.wav = Flim + the first 122.9 s of Inner City Life, float32 44.1 kHz (ffmpeg concat; see the Task 9 report).
describe.skipIf(!process.env.SONG_SECTIONS_PERF || !modelsDir() || !existsSync(FIVE_MIN))("analyseStructure on 5 minutes (perf)", () => {
  it("peaks at or under 2.5 GB RSS and runs faster than real time", async () => {
    const e: StructureEnv = { modelDir: modelsDir()!, tempDir: tmp("ss-temp-"), extensionRoot: process.cwd(), storageDir: tmp("ss-storage-") };
    const t0 = Date.now();
    const r = await analyseStructure(FIVE_MIN, e, new AbortController().signal, () => {});
    const sec = (Date.now() - t0) / 1000;
    const peakMB = (process.resourceUsage().maxRSS * 1024) / 1e6;
    console.log(`5 min: ${sec.toFixed(1)} s, peak RSS ${Math.round(peakMB)} MB, ${r.segments.length} segments, ${r.beats.length} beats, bpm ${r.bpm}`);
    expect(r.durationSec).toBe(300);
    expect(peakMB).toBeLessThanOrEqual(2500);
    expect(sec).toBeLessThan(300);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 900_000);
});


// Task 9 review M9 / Task 11: every JS stage yields to the host at least every ~100 ms of work (Global Constraints),
// measured on a 5-minute 48 kHz render with an instant fake core and fake folds, so only our own code is timed. The
// ORT runs themselves (a Demucs chunk ~1.1 s, a fold run: a cancel lands within one fold window, ~4–6 s, worst case not timed) block the host and cannot be split; they are
// not in this measurement.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("host responsiveness on a 5-minute input (Global Constraints: yield every ~100 ms)", () => {
  it("no JS stage blocks the event loop for more than 100 ms", async () => {
    const h = harness();
    const zeroCore = vi.fn<DemucsCore>(async ({ spec }) => ({ specOut: new Float32Array(4 * spec.length), waveOut: new Float32Array(4 * 2 * L) }));
    h.openDemucsCore.mockImplementation(async () => ({ core: zeroCore, release: h.release }));
    const seconds = 60 * Number(process.env.SONG_SECTIONS_STALL_MINUTES ?? 5); // 20 for the findings' long-track row
    const path = await wav("five.wav", seconds, 48000, 2, tone(48000));
    const logits = foldLogits(seconds * 100); // built up front: the fake's own work is not ours to measure
    h.runFolds.mockImplementation(async (_ort, _dir, _spec, _T, _signal, onFold) => {
      for (let k = 0; k < 8; k++) {
        await yieldToHost();
        onFold(k);
      }
      return logits;
    });
    let stage = "start";
    let fraction = 0;
    const worst: Record<string, number> = {};
    const worstAt: Record<string, number> = {};
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      if (now - last > (worst[stage] ?? 0)) {
        worst[stage] = now - last;
        worstAt[stage] = Math.round(fraction * 1000) / 1000;
      }
      last = now;
      if (running) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    // With the audition stems on, as the flow always runs it (feedback round 2 B: 16-bit writes in the feature slices).
    // SONG_SECTIONS_STALL_PACE=background: as a background analysis runs it (fb2 review I1), with nothing else going on.
    const pace = process.env.SONG_SECTIONS_STALL_PACE === "background" ? backgroundPace(hostActivity()) : undefined;
    const r = await makeAnalyseStructure(h.deps)(path, env({ auditionStemsDir: join(tmp(), "stems", "k"), ...(pace ? { pace } : {}) }), new AbortController().signal, (f, s) => {
      stage = s;
      fraction = f;
    });
    running = false;
    console.log(`longest stall per stage (ms): ${JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, Math.round(v)])))} at progress ${JSON.stringify(worstAt)}`);
    expect(r.durationSec).toBe(seconds);
    for (const [s, ms] of Object.entries(worst)) expect(ms, s).toBeLessThan(100);
  }, 600_000);
});
