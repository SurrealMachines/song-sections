// End-to-end golden (Plan 3, Task 10): analyseStructure with the real models against the PyTorch baseline
// (`$SPIKE_OUT/baseline/<track>.json` and its float stems). Model-gated, and needs `.dev/golden/` from
// `npm run fixtures` (tools/golden/fixtures_dev.py). Tolerances: the plan's "end to end" rows (R6).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backgroundPace, hostActivity, type Pace } from "../core/pace.js";
import { readPcmFile } from "../audio/pcmFile.js";
import { makeWav } from "../test/makeWav.js";
import { modelsDir, spikeOut } from "../test/golden.js";
import { FUNCTION_LABELS, PEAK_RATE, STEM_NAMES, type FunctionLabel, type StemName, type StructureAnalysis, type StructureEnv, type StructureStage } from "./contract.js";
import { analyseStructure } from "./engine.js";
import { openSessionCount } from "./ort/sessions.js";

const GOLDEN = join(process.cwd(), ".dev", "golden");
const BOUNDARY_TOL_SEC = 0.1;
const BEAT_TOL_SEC = 0.01 + 1e-9; // one 10 ms frame; times are frame/100 in float64, so a 1-frame shift reads 0.010000000000005
const MIN_SDR_DB = 30;

interface Baseline {
  bpm: number;
  beats: number[];
  downbeats: number[];
  segments: { start: number; end: number; label: string }[];
}

const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const baseline = (track: string): Baseline => JSON.parse(readFileSync(join(spikeOut()!, "baseline", `${track}.json`), "utf8")) as Baseline;
const maxAbs = (a: number[], b: number[]) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("structure-"));

async function run(wav: string, keepStemsDir?: string, modelDir = modelsDir()!, pace?: Pace) {
  const storageDir = tmp("ss-golden-storage-");
  const env: StructureEnv = {
    modelDir,
    tempDir: tmp("ss-golden-temp-"),
    extensionRoot: process.cwd(),
    storageDir,
    keepStemsDir,
    // Feedback round 2 B: every golden run also keeps the audition stems, so the exactness below holds with them on.
    auditionStemsDir: join(storageDir, "stems", "golden"),
    ...(pace ? { pace } : {}),
  };
  const stages: StructureStage[] = [];
  const t0 = Date.now();
  const r = await analyseStructure(join(GOLDEN, wav), env, new AbortController().signal, (_, s) => {
    if (stages.at(-1) !== s) stages.push(s);
  });
  return { r, stages, sec: (Date.now() - t0) / 1000, tempDir: env.tempDir, auditionDir: env.auditionStemsDir! };
}

/** Interleaved samples of a whole float WAV (stems are ~62 MB each at 177 s, fine for a test). */
async function readInterleaved(path: string): Promise<{ data: Float32Array; frames: number; channels: number }> {
  let data = new Float32Array(0);
  let at = 0;
  const info = await readPcmFile(
    path,
    (planes, channels) => {
      const n = planes[0].length;
      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) data[at++] = planes[c][i];
    },
    { onHeader: (h) => (data = new Float32Array(h.frames * h.channels)) },
  );
  return { data, frames: info.frames, channels: info.channels };
}

/** The spike's `sdr()` (run_demucs_ort.py): 10·log10(Σref² / Σ(ref−est)²) over all samples, float64 sums. */
async function sdrDb(refPath: string, estPath: string): Promise<{ sdr: number; frames: [number, number] }> {
  const ref = await readInterleaved(refPath);
  const est = await readInterleaved(estPath);
  const n = Math.min(ref.data.length, est.data.length);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += ref.data[i] * ref.data[i];
    const d = ref.data[i] - est.data[i];
    den += d * d;
  }
  return { sdr: den === 0 ? Infinity : 10 * Math.log10(num / den), frames: [ref.frames, est.frames] };
}

function describeVsBaseline(name: string, r: StructureAnalysis, base: Baseline) {
  const sameCount = r.segments.length === base.segments.length;
  const beatsSame = r.beats.length === base.beats.length;
  const s = {
    segments: `${r.segments.length}/${base.segments.length}`,
    labelsIdentical: JSON.stringify(r.segments.map((x) => x.label)) === JSON.stringify(base.segments.map((x) => x.label)),
    maxBoundaryErrSec: sameCount ? maxAbs(r.segments.map((x) => x.start), base.segments.map((x) => x.start)) : NaN,
    beats: `${r.beats.length}/${base.beats.length}`,
    maxBeatErrSec: beatsSame ? maxAbs(r.beats, base.beats) : NaN,
    downbeats: `${r.downbeats.length}/${base.downbeats.length}`,
    maxDownbeatErrSec: r.downbeats.length === base.downbeats.length ? maxAbs(r.downbeats, base.downbeats) : NaN,
    bpm: `${r.bpm}/${base.bpm}`,
    ...(sameCount && JSON.stringify(r.segments.map((x) => x.label)) !== JSON.stringify(base.segments.map((x) => x.label))
      ? { labelDiffs: r.segments.flatMap((x, i) => (x.label === base.segments[i].label ? [] : [`${i}@${x.start}: ${x.label} (baseline ${base.segments[i].label})`])) }
      : {}),
  };
  console.log(`GOLDEN ${name} ${JSON.stringify(s)}`);
  return s;
}

/** Each case's comparison, also kept in `.dev/golden/<case>.golden.json` (vitest hides passing tests' logs). */
function keepSummary(name: string, summary: object) {
  mkdirSync(GOLDEN, { recursive: true });
  writeFileSync(join(GOLDEN, `${name}.golden.json`), JSON.stringify(summary, null, 1));
}

function expectSegmentsMatch(r: StructureAnalysis, base: Baseline) {
  expect(r.segments.map((x) => x.label)).toEqual(base.segments.map((x) => x.label));
  for (let i = 0; i < base.segments.length; i++) {
    expect(Math.abs(r.segments[i].start - base.segments[i].start)).toBeLessThanOrEqual(BOUNDARY_TOL_SEC);
  }
  expect(r.segments[0].start).toBe(0);
  for (let i = 1; i < r.segments.length; i++) expect(r.segments[i].start).toBe(r.segments[i - 1].end);
  expect(r.segments.at(-1)!.end).toBeCloseTo(r.durationSec, 9);
}

/**
 * Contract allin1-onnx-3: every chosen boundary is a candidate as the same float, every baseline boundary is within
 * the end-to-end tolerance of one, candidates ascend from after 0 with 4-decimal strengths, and each stem's peak
 * envelope has the contract length and range.
 */
function expectCandidatesAndPeaks(r: StructureAnalysis, base: Baseline) {
  const c = r.boundaryCandidates;
  const times = new Set(c.map((x) => x.time));
  for (const seg of r.segments.slice(1)) expect(times.has(seg.start)).toBe(true);
  for (const seg of base.segments.slice(1)) expect(Math.min(...c.map((x) => Math.abs(x.time - seg.start)))).toBeLessThanOrEqual(BOUNDARY_TOL_SEC);
  expect(c[0].time).toBeGreaterThan(0);
  for (let i = 1; i < c.length; i++) expect(c[i].time).toBeGreaterThan(c[i - 1].time);
  for (const x of c) {
    expect(x.strength).toBeGreaterThanOrEqual(0);
    expect(x.strength).toBeLessThanOrEqual(1);
    expect(Math.round(x.strength * 10000) / 10000).toBe(x.strength);
  }
  expect(c.length).toBeGreaterThan(r.segments.length);
  for (const stem of STEM_NAMES) {
    const p = r.stems[stem].peak;
    expect(p).toHaveLength(Math.ceil(r.durationSec * PEAK_RATE));
    for (const v of p) expect(v >= 0 && v <= 1).toBe(true);
    // Consistent with loudnessDb: a 0.5 s frame's highest block peak is at or above the frame's RMS (within rounding).
    r.stems[stem].loudnessDb.forEach((db, f) => {
      const top = Math.max(...p.slice(10 * f, 10 * f + 10));
      if (top + 0.0005 < 10 ** (db / 20) * 10 ** (-0.05 / 20)) throw new Error(`${stem} frame ${f}: peak ${top} below RMS ${db} dB`);
    });
  }
  expect(Math.max(...r.stems.drums.peak)).toBeGreaterThan(0.1);
}

/** Plan 4's tuning input: the full result, next to the golden audio (gitignored). */
function keepResult(file: string, r: StructureAnalysis) {
  mkdirSync(GOLDEN, { recursive: true });
  writeFileSync(join(GOLDEN, file), JSON.stringify(r));
}

const TRACKS_44K = [
  { name: "flim", track: "flim", wav: "flim-44k.wav" },
  { name: "icl", track: "inner-city-life", wav: "icl-44k.wav" },
] as const;

for (const t of TRACKS_44K) {
  describe.skipIf(!modelsDir() || !existsSync(join(GOLDEN, t.wav)))(`end to end, 44.1 kHz source: ${t.name}`, () => {
    it("matches the PyTorch baseline: boundaries, labels, beats, bpm, and stems at SDR >= 30 dB", async () => {
      const base = baseline(t.track);
      const stemsDir = tmp(`ss-golden-stems-${t.name}-`);
      const { r, stages, sec, tempDir, auditionDir } = await run(t.wav, stemsDir);
      keepResult(`${t.name}.structure.json`, r);
      const vs = describeVsBaseline(`${t.name}-44k`, r, base);
      const sdr: Partial<Record<StemName, number>> = {};
      for (const stem of STEM_NAMES) {
        const { sdr: db, frames } = await sdrDb(join(spikeOut()!, "baseline", t.track, "float", `${stem}.wav`), join(stemsDir, `${stem}.wav`));
        expect(frames[1]).toBe(frames[0]);
        sdr[stem] = Math.round(db * 10) / 10;
      }
      console.log(`GOLDEN ${t.name}-44k sdrDb ${JSON.stringify(sdr)} wall ${sec.toFixed(1)} s`);
      keepSummary(`${t.name}-44k`, { ...vs, sdrDb: sdr, wallSec: sec });

      expectSegmentsMatch(r, base);
      expectCandidatesAndPeaks(r, base);
      expect(r.beats).toHaveLength(base.beats.length);
      for (let i = 0; i < base.beats.length; i++) expect(Math.abs(r.beats[i] - base.beats[i])).toBeLessThanOrEqual(BEAT_TOL_SEC);
      expect(r.bpm).toBe(base.bpm);
      for (const stem of STEM_NAMES) expect(sdr[stem]!).toBeGreaterThanOrEqual(MIN_SDR_DB);
      // The audition stems: 16-bit copies of the float stems (inputGainDb is 0 here), as long as the track, every
      // sample within half a 16-bit step of the float one clamped to full scale.
      for (const stem of STEM_NAMES) {
        const ref = await readInterleaved(join(stemsDir, `${stem}.wav`));
        const b = readFileSync(join(auditionDir, `${stem}.wav`));
        expect(b.readUInt16LE(34)).toBe(16);
        const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length));
        expect(pcm.length).toBe(ref.data.length);
        let worst = 0;
        for (let i = 0; i < pcm.length; i++) worst = Math.max(worst, Math.abs(Math.min(1, Math.max(-1, ref.data[i])) * 32767 - pcm[i]));
        expect(worst, stem).toBeLessThanOrEqual(0.5 + 1e-6);
      }
      expect(stages).toEqual(["separating", "features", "structure", "beats"]);
      expect(r.inputGainDb).toBe(0); // mastered (peak -0.2 dBFS): not normalised, so the baseline applies bit for bit
      expect(leftovers(tempDir)).toEqual([]);
      expect(openSessionCount()).toBe(0); // review M3
    }, 900_000);
  });
}

// fb2 review I1/I2: a background analysis cuts its work finer and rests after each slice; the result must not change.
describe.skipIf(!modelsDir() || !existsSync(join(GOLDEN, "flim-44k.wav")))("end to end in the background: flim", () => {
  it("gives the foreground's analysis and audition stems byte for byte; logs how much longer it takes", async () => {
    const fg = await run("flim-44k.wav");
    const pace = backgroundPace(hostActivity());
    const bg = await run("flim-44k.wav", undefined, modelsDir()!, pace);
    console.log(`BACKGROUND flim-44k wall ${fg.sec.toFixed(1)} s foreground, ${bg.sec.toFixed(1)} s background (+${((100 * (bg.sec - fg.sec)) / fg.sec).toFixed(0)} %); pace ${JSON.stringify(pace.stats())}`);
    expect(JSON.stringify(bg.r)).toBe(JSON.stringify(fg.r));
    for (const stem of STEM_NAMES) expect(readFileSync(join(bg.auditionDir, `${stem}.wav`)).equals(readFileSync(join(fg.auditionDir, `${stem}.wav`))), stem).toBe(true);
    expect(openSessionCount()).toBe(0);
  }, 900_000);
});

describe.skipIf(!modelsDir() || !existsSync(join(GOLDEN, "flim-48k.wav")))("end to end, 48 kHz render of the same track: flim", () => {
  it("gives the 44.1 kHz baseline's boundaries (<= 100 ms) and labels", async () => {
    const base = baseline("flim");
    const { r, sec } = await run("flim-48k.wav");
    keepResult("flim-48k.structure.json", r);
    const vs = describeVsBaseline("flim-48k", r, base);
    console.log(`GOLDEN flim-48k wall ${sec.toFixed(1)} s`);
    keepSummary("flim-48k", { ...vs, wallSec: sec });
    expectSegmentsMatch(r, base);
    expectCandidatesAndPeaks(r, base);
    expect(r.inputGainDb).toBe(0);
  }, 900_000);
});

// Task 9 review I1: allin1 is level-sensitive. Flim 12 dB down (peak -12.2 dBFS) is normalised to -1 dBFS first,
// and must then give the 44.1 kHz baseline's result within the end-to-end tolerances.
describe.skipIf(!modelsDir() || !existsSync(join(GOLDEN, "flim-44k-m12.wav")))("level: Flim at -12 dB", () => {
  it("is normalised (inputGainDb ~ +11.2) and gives the baseline's boundaries, beats and bpm, and its labels up to near ties", async () => {
    const base = baseline("flim");
    const { r, sec } = await run("flim-44k-m12.wav");
    keepResult("flim-m12.structure.json", r);
    const vs = describeVsBaseline("flim-m12", r, base);
    keepSummary("flim-m12", { ...vs, inputGainDb: r.inputGainDb, wallSec: sec });
    expect(r.inputGainDb).toBeGreaterThan(11);
    expect(r.inputGainDb).toBeLessThan(11.5);
    // Boundaries as the end-to-end rows. Labels: identical except on a near tie. allin1 labels a segment by the
    // argmax of its summed class probabilities, and is level-sensitive (E9), so normalising to -1 dBFS (0.8 dB below
    // Flim's own -0.2 dBFS) may flip a segment whose two best classes are within NEAR_TIE. Measured: one segment,
    // 112.95-129.17 s, solo 0.319 vs inst 0.299 in the baseline-level run, inst 0.310 vs solo 0.300 here (findings E9).
    const NEAR_TIE = 0.05;
    expect(r.segments).toHaveLength(base.segments.length);
    for (let i = 0; i < base.segments.length; i++) {
      expect(Math.abs(r.segments[i].start - base.segments[i].start)).toBeLessThanOrEqual(BOUNDARY_TOL_SEC);
      if (r.segments[i].label === base.segments[i].label) continue;
      const rows = r.functionProbs.slice(Math.floor(r.segments[i].start * 2), Math.floor(r.segments[i].end * 2));
      const mean = (label: string) => rows.reduce((a, row) => a + row[FUNCTION_LABELS.indexOf(label as FunctionLabel)], 0) / rows.length;
      expect(mean(r.segments[i].label) - mean(base.segments[i].label)).toBeLessThan(NEAR_TIE);
    }
    expect(r.beats).toHaveLength(base.beats.length);
    for (let i = 0; i < base.beats.length; i++) expect(Math.abs(r.beats[i] - base.beats[i])).toBeLessThanOrEqual(BEAT_TOL_SEC);
    expect(r.bpm).toBe(base.bpm);
  }, 900_000);
});

// Task 9 review M3 (Task 8 M4): with real ORT, no session stays open after a cancel or an error.
describe.skipIf(!modelsDir() || !existsSync(join(GOLDEN, "flim-44k.wav")))("real ORT exit paths", () => {
  let clip = "";
  const short = async () => {
    if (clip) return clip;
    const planes: number[][] = [[], []];
    const want = 30 * 44100;
    await readPcmFile(join(GOLDEN, "flim-44k.wav"), (p) => {
      for (let c = 0; c < 2; c++) for (const x of p[c]) if (planes[c].length < want) planes[c].push(x);
    });
    clip = join(tmp("ss-golden-clip-"), "flim-30s.wav");
    await makeWav(clip, { sampleRate: 44100, channels: 2, bitDepth: 32, float: true, frames: want, sample: (c, i) => planes[c][i] });
    return clip;
  };
  const env = (modelDir = modelsDir()!): StructureEnv => ({
    modelDir,
    tempDir: tmp("ss-golden-temp-"),
    extensionRoot: process.cwd(),
    storageDir: tmp("ss-golden-storage-"),
  });

  for (const [stage, at] of [["separating", 0.3], ["structure", 0.8]] as const) {
    it(`a cancel during ${stage} rejects AbortError and leaves no session open and no temp dir`, async () => {
      const e = env();
      const c = new AbortController();
      const err = await analyseStructure(await short(), e, c.signal, (f) => f >= at && c.abort()).catch((x: unknown) => x);
      expect((err as Error).name).toBe("AbortError");
      expect(openSessionCount()).toBe(0);
      expect(leftovers(e.tempDir)).toEqual([]);
    }, 300_000);
  }

  it("a fold model that fails to load rejects and leaves no session open and no temp dir", async () => {
    const models = tmp("ss-golden-models-");
    // Every model file but fold 3's graph: graphs, and (fb/hfmodels) their .weights next to them.
    for (const f of readdirSync(modelsDir()!)) {
      if (/\.(onnx|weights)$/.test(f) && f !== "allin1_harmonix_fold3.onnx") symlinkSync(join(modelsDir()!, f), join(models, f));
    }
    const e = env(models);
    await expect(analyseStructure(await short(), e, new AbortController().signal, () => {})).rejects.toThrow(/fold3/);
    expect(openSessionCount()).toBe(0);
    expect(leftovers(e.tempDir)).toEqual([]);
  }, 300_000);
});
