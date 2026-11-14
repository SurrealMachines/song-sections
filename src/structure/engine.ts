// The structure engine (Plan 3 Task 9): decode -> Demucs -> allin1 features -> 8 folds -> post-processing,
// behind the contract's AnalyseStructure. Everything ORT-, Demucs- or allin1-specific stays below this file.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { throwIfAborted } from "../core/abort.js";
import { FOREGROUND, type Pace } from "../core/pace.js";
import { trackDownbeats } from "./allin1/dbn/downbeats.js";
import { HOP, MODEL_STEM_ORDER, quantiseStem, stackSpec, stemSpectrogramSliced } from "./allin1/features.js";
import { functionProbsPerFrame, functionalStructure, sectionProbabilities } from "./allin1/functional.js";
import { estimateTempo } from "./allin1/tempo.js";
import {
  ALLIN1_BAND_HZ,
  FEATURE_BANDS,
  FEATURE_RATE,
  FUNCTION_LABELS,
  PEAK_RATE,
  STRUCTURE_ENGINE,
  type AnalyseStructure,
  type BoundaryCandidate,
  type FunctionLabel,
  type StemFeatures,
  type StemName,
  type StructureAnalysis,
  type StructureSegment,
  type StructureStage,
} from "./contract.js";
import { DEMUCS_SOURCES, SAMPLE_RATE } from "./demucs/dsp.js";
import { separate } from "./demucs/separate.js";
import { decodeForDemucs } from "./dsp/decode.js";
import { openDemucsCore } from "./ort/demucsCore.js";
import { flushReleasedMemory, runFolds } from "./ort/folds.js";
import { loadOrt } from "./runtime.js";
import { createAuditionWriter, type AuditionWriter } from "./audition.js";
import { createStemStore } from "./stems.js";
import { PEAK_BLOCK, bandsAt2Hz, functionProbsAt2Hz, loudnessAt2Hz, peakAtClipLevel, peakBlocks } from "./summary.js";

export interface EngineDeps {
  openDemucsCore: typeof openDemucsCore;
  runFolds: typeof runFolds;
  loadOrt: typeof loadOrt;
  trackDownbeats: typeof trackDownbeats;
  flushReleasedMemory: typeof flushReleasedMemory;
}

/** Below this many allin1 frames (< 0.05 s) the model is not run (Review Focus 3). */
export const MIN_MODEL_FRAMES = 5;

/**
 * A mix whose RMS over the whole clip and both channels is below this is treated as silence: one segment, no beats,
 * and allin1 is not run. Why: on silent input allin1's section logits are flat, and its peak picking then makes
 * every frame a boundary (Task 6, ruling "zero logits -> match allin1"). -60 dBFS RMS is ~35 dB below the
 * quietest commercially mastered music and above dither/noise-floor renders (-90 dBFS and lower).
 */
export const SILENCE_RMS_DB = -60;

/**
 * Second guard, for non-silent input that still gives no boundary information: when the section probability
 * (sigmoid of the 8-fold mean logit) varies by less than this over the whole clip, there are no real peaks and
 * allin1's peak picking would only find artefacts of its zero padding (all-zero logits: every frame). One segment
 * is returned instead. Real music is far above it: the PyTorch baseline's section probability spans
 * 1.6e-6..0.193 on Flim and 5.4e-7..0.313 on Inner City Life (out/baseline/*.activ.npz), ~190x this value.
 */
export const FLAT_SECTION_RANGE = 1e-3;

/**
 * Conditional peak normalisation (Task 9 review I1, ruling): allin1 is level-sensitive (Flim at -12 dB changes
 * labels and moves boundaries by up to 26 s), and Live renders pre-FX, so raw takes arrive quiet. A decoded mix
 * peaking below NORMALISE_BELOW_DB is scaled so it peaks at NORMALISE_TO_DB; anything louder (mastered material,
 * the Flim/ICL goldens at -0.2 dBFS) is left bit-exact. Silence (SILENCE_RMS_DB) is never amplified.
 */
export const NORMALISE_BELOW_DB = -6;
export const NORMALISE_TO_DB = -1;

const START: FunctionLabel = "start";
const FRAMES_PER_FEATURE = 50; // allin1 frames per 0.5 s

// Overall progress per stage (brief): decode 0–0.02, separate 0.02–0.70, features 0.70–0.76, folds 0.76–0.94, beats 0.94–1.
const P = { decoded: 0.02, separated: 0.7, features: 0.76, folds: 0.94 } as const;

/**
 * Runs `fn(a, b)` over [0, n) in slices of `step`, yielding to the host between slices (Global Constraints: yield
 * at least every ~100 ms of work; Task 9 review M9). The slices run in order, so a sum over them is the same sum.
 * The abort signal is checked after each yield (an abort rejects with an Error named "AbortError").
 */
export async function sliced(n: number, step: number, fn: (a: number, b: number) => void, signal: AbortSignal, pace: Pace = FOREGROUND): Promise<void> {
  for (let a = 0, b = 0; a < n; a = b) {
    b = Math.min(n, a + pace.slice(step));
    fn(a, b);
    if (b < n) {
      await pace.yield(signal);
      throwIfAborted(signal); // Task 11 review M2: a cancel lands at the next slice, not after the whole pass
    }
  }
}

/** Samples per slice of a whole-track pass (~5–10 ms of work). */
const SAMPLE_SLICE = 1 << 22;
/**
 * Stem frames per read slice: whole 22050-sample blocks of loudnessAt2Hz (a slice boundary is a block boundary, and
 * so also a boundary of peakBlocks' 2205-sample blocks), 100 of them in the foreground.
 */
const STEM_BLOCK_FRAMES = 22050;
const STEM_SLICE_BLOCKS = 100;
/** 50-frame blocks (bandsAt2Hz) per slice. */
const BANDS_SLICE_BLOCKS = 200;

async function rmsDb(left: Float32Array, right: Float32Array, signal: AbortSignal, pace: Pace): Promise<number> {
  let sq = 0;
  await sliced(left.length, SAMPLE_SLICE, (a, b) => {
    for (let i = a; i < b; i++) sq += left[i] * left[i] + right[i] * right[i];
  }, signal, pace);
  return 10 * Math.log10(sq / (2 * left.length)); // -Infinity for digital silence, NaN for no samples
}

async function peakOf(left: Float32Array, right: Float32Array, signal: AbortSignal, pace: Pace): Promise<number> {
  let p = 0;
  await sliced(left.length, SAMPLE_SLICE, (lo, hi) => {
    for (let i = lo; i < hi; i++) {
      const a = Math.abs(left[i]);
      const b = Math.abs(right[i]);
      if (a > p) p = a;
      if (b > p) p = b;
    }
  }, signal, pace);
  return p;
}

/** Scales the mix in place when it is quiet (see NORMALISE_BELOW_DB); returns the gain applied in dB (0 if none). */
async function normalisePeak(mix: { left: Float32Array; right: Float32Array }, silent: boolean, signal: AbortSignal, pace: Pace): Promise<number> {
  const peak = await peakOf(mix.left, mix.right, signal, pace);
  if (silent || !(peak > 0) || 20 * Math.log10(peak) >= NORMALISE_BELOW_DB) return 0;
  const gain = 10 ** (NORMALISE_TO_DB / 20) / peak;
  await sliced(mix.left.length, SAMPLE_SLICE, (a, b) => {
    for (let i = a; i < b; i++) {
      mix.left[i] *= gain;
      mix.right[i] *= gain;
    }
  }, signal, pace);
  return 20 * Math.log10(gain);
}

/**
 * One stem's int16 mono (quantiseStem), float loudness (loudnessAt2Hz) and float peak blocks (peakBlocks), read from
 * the store a slice at a time, so the float stem is never in memory whole (Task 11, findings E10). All are per sample
 * or per block, and a slice is a whole number of blocks, so the results are the same as over the whole stem. The
 * peaks are one float32 per 2205 samples (144 KB for 30 minutes). `onSlice` gets each float slice too, before the yield
 * (the audition stems are written from it, so the stem is read once).
 */
export async function monoAndLoudness(
  store: ReturnType<typeof createStemStore>,
  source: number,
  signal: AbortSignal,
  onSlice?: (left: Float32Array, right: Float32Array, offset: number) => Promise<void>,
  pace: Pace = FOREGROUND,
): Promise<{ mono: Int16Array; loudnessDb: number[]; peaks: Float32Array }> {
  const frames = store.frames(source);
  const mono = new Int16Array(frames);
  const loudnessDb: number[] = [];
  const peaks = new Float32Array(Math.ceil(frames / PEAK_BLOCK));
  const peak = store.peak(source);
  await store.readSlices(source, STEM_BLOCK_FRAMES * pace.slice(STEM_SLICE_BLOCKS), async (left, right, offset) => {
    mono.set(quantiseStem(left, right, peak), offset);
    for (const v of loudnessAt2Hz(left, right)) loudnessDb.push(v);
    peaks.set(peakBlocks(left, right), offset / PEAK_BLOCK);
    if (onSlice) await onSlice(left, right, offset);
    await pace.yield(signal);
    throwIfAborted(signal);
  });
  return { mono, loudnessDb, peaks };
}

async function bandsAt2HzSliced(spec: Float32Array, T: number, signal: AbortSignal, pace: Pace): Promise<number[][]> {
  const out: number[][] = [];
  const step = FRAMES_PER_FEATURE * pace.slice(BANDS_SLICE_BLOCKS);
  await sliced(T, step, (a, b) => out.push(...bandsAt2Hz(spec.subarray(a * FEATURE_BANDS, b * FEATURE_BANDS), b - a)), signal, {
    yield: (s) => pace.yield(s),
    slice: () => step, // whole 50-frame blocks: cut once, above
  });
  return out;
}

/** loudnessAt2Hz of the scaled stem, back at the clip's own level, keeping its floor and rounding. */
function atClipLevel(loudnessDb: number[], gainDb: number): number[] {
  if (gainDb === 0) return loudnessDb;
  return loudnessDb.map((v) => Math.max(-100, Math.round((v - gainDb) * 10) / 10));
}

function oneHotRows(frames: number, label: FunctionLabel): number[][] {
  const k = FUNCTION_LABELS.indexOf(label);
  return Array.from({ length: frames }, () => FUNCTION_LABELS.map((_, c) => (c === k ? 1 : 0)));
}

/** allin1's labelling rule (argmax of the summed softmax) for a single segment over all T frames. */
function wholeClipLabel(probs: Float32Array, T: number): FunctionLabel {
  const C = FUNCTION_LABELS.length;
  const sums = new Float64Array(C);
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) sums[c] += probs[t * C + c];
  let best = 0;
  for (let c = 1; c < C; c++) if (sums[c] > sums[best]) best = c;
  return FUNCTION_LABELS[best];
}

function flatSection(section: Float32Array): boolean {
  const p = sectionProbabilities(section);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of p) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return !(hi - lo >= FLAT_SECTION_RANGE);
}

export function makeAnalyseStructure(deps: EngineDeps): AnalyseStructure {
  return async (audioPath, env, signal, onProgress) => {
    let done = 0;
    const report = (fraction: number, stage: StructureStage) => {
      done = Math.max(done, Math.min(1, fraction)); // overall progress never goes back
      onProgress(done, stage);
    };
    throwIfAborted(signal);
    const pace = env.pace ?? FOREGROUND;
    // Review M5: an empty storageDir would quietly load the addon from <extensionRoot>/native (Branch A' forbids it).
    if (!env.storageDir) throw new Error("analyseStructure: env.storageDir must be the extension's storage directory");
    report(0, "separating");

    const store = createStemStore(join(env.tempDir, `structure-${randomUUID()}`));
    // Feedback round 2 B: the audition stems, written while the stems are read for features, committed on success.
    let audition: AuditionWriter | null = null;
    try {
      const ort = deps.loadOrt(env.extensionRoot, env.storageDir);

      // 1. Decode and resample to 44.1 kHz stereo (reported as "separating", per the contract).
      let mix: { left: Float32Array; right: Float32Array } | null = await decodeForDemucs(audioPath, signal, (f) =>
        report(P.decoded * f, "separating"),
      );
      const n = mix.left.length;
      if (n === 0) throw new Error(`analyseStructure: ${audioPath} has no audio (0 samples)`); // review M7
      const durationSec = n / SAMPLE_RATE;
      const T = Math.ceil(n / HOP); // allin1 frames
      const frames = Math.ceil(T / FRAMES_PER_FEATURE); // = ceil(durationSec * FEATURE_RATE)
      const peakLength = Math.ceil(durationSec * PEAK_RATE); // the contract's StemFeatures.peak length
      const silent = !((await rmsDb(mix.left, mix.right, signal, pace)) >= SILENCE_RMS_DB);
      const inputGainDb = await normalisePeak(mix, silent, signal, pace);
      if (env.auditionStemsDir) audition = createAuditionWriter(env.auditionStemsDir, inputGainDb);
      report(P.decoded, "separating");

      // 2. Demucs, streamed into the stem store. The session is released before anything else runs.
      await pace.yield(signal); // creating a session blocks the host for ~1 s
      throwIfAborted(signal);
      const { core, release } = await deps.openDemucsCore(ort, env.modelDir);
      let separateFailed = false;
      try {
        await separate(mix.left, mix.right, core, store, signal, (f) => report(P.decoded + (P.separated - P.decoded) * f, "separating"), pace);
      } catch (error) {
        separateFailed = true;
        throw error;
      } finally {
        try {
          await release();
        } catch (releaseError) {
          // Review M4: a failing release must not hide why separate() failed (like folds.ts).
          if (!separateFailed) throw releaseError;
          console.error("Song Sections: releasing the Demucs session failed after an error:", releaseError);
        }
      }
      mix = null; // the decoded track is not needed any more
      await pace.yield(signal);
      throwIfAborted(signal);
      // Findings E10: on macOS the released Demucs session's ~1 GB stays resident until a fold session's release pushes
      // it out of libmalloc's cache, so without this the first fold's memory lands on top of it (5 min: 2229 -> 1604 MB).
      await deps.flushReleasedMemory(ort, env.modelDir);

      // 3. allin1 features per stem (allin1's int16 round trip), plus the float stem's loudness and peak envelope.
      let specs: Partial<Record<StemName, Float32Array>> = {};
      const stems = {} as Record<StemName, StemFeatures>;
      for (const [i, name] of MODEL_STEM_ORDER.entries()) {
        throwIfAborted(signal);
        const source = DEMUCS_SOURCES.indexOf(name);
        const kept = audition;
        await kept?.begin(name, store.frames(source));
        const { mono, loudnessDb, peaks } = await monoAndLoudness(store, source, signal, kept ? (l, r, at) => kept.write(name, l, r, at) : undefined, pace);
        const spec = await stemSpectrogramSliced(mono, signal, undefined, pace);
        specs[name] = spec;
        stems[name] = {
          bands: await bandsAt2HzSliced(spec, T, signal, pace),
          loudnessDb: atClipLevel(loudnessDb, inputGainDb),
          peak: peakAtClipLevel(peaks, inputGainDb, peakLength),
        };
        report(P.separated + ((P.features - P.separated) * (i + 1)) / MODEL_STEM_ORDER.length, "features");
      }

      const result = (
        segments: StructureSegment[],
        boundaryCandidates: BoundaryCandidate[],
        functionProbs: number[][],
        beats: number[],
        downbeats: number[],
      ): StructureAnalysis => ({
        engine: STRUCTURE_ENGINE,
        durationSec,
        segments,
        beats,
        downbeats,
        bpm: estimateTempo(beats),
        featureRate: FEATURE_RATE,
        frames,
        functionProbs,
        boundaryCandidates,
        bandHz: [...ALLIN1_BAND_HZ],
        stems,
        inputGainDb: Math.round(inputGainDb * 100) / 100,
      });
      // Review M6: the stem WAVs are written only once the analysis has succeeded, so a cancel or failure leaves none.
      // The audition folder is renamed into place here too; a failure to keep it only logs (the analysis stands).
      const keepStems = async () => {
        if (env.keepStemsDir) await store.writeWavs(env.keepStemsDir);
        await audition?.commit();
      };

      if (silent || T < MIN_MODEL_FRAMES) {
        const r = result([{ start: 0, end: durationSec, label: START }], [], oneHotRows(frames, START), [], []);
        await keepStems();
        report(1, "beats");
        return r;
      }

      // 4. The 8 allin1 folds, one session at a time.
      const input = stackSpec(specs as Record<StemName, Float32Array>, T);
      specs = {};
      await pace.yield(signal);
      throwIfAborted(signal);
      const logits = await deps.runFolds(
        ort,
        env.modelDir,
        input,
        T,
        signal,
        (k) => report(P.features + ((P.folds - P.features) * (k + 1)) / 8, "structure"),
        { pace },
      );
      throwIfAborted(signal);

      // 5. Segments, beats, tempo.
      report(P.folds, "beats");
      const probs = functionProbsPerFrame(logits.fn, T);
      await pace.yield(signal);
      const flat = flatSection(logits.section);
      await pace.yield(signal);
      // Flat logits carry no boundary information, so they give no candidates either (their local maxima are noise).
      const { segments, candidates } = flat
        ? { segments: [{ start: 0, end: durationSec, label: wholeClipLabel(probs, T) }], candidates: [] }
        : functionalStructure(logits.section, logits.fn, T, probs);
      await pace.yield(signal);
      segments[segments.length - 1].end = durationSec; // allin1 ends at T/100, up to 10 ms past the audio
      report(P.folds + (1 - P.folds) / 2, "beats");
      const { beats, positions } = await deps.trackDownbeats(logits.beat, logits.downbeat, { signal, pace });
      const downbeats = beats.filter((_, i) => positions[i] === 1);
      throwIfAborted(signal);
      await pace.yield(signal);
      const r = result(segments, candidates, functionProbsAt2Hz(probs, T), beats, downbeats);
      await keepStems();
      report(1, "beats");
      return r;
    } finally {
      try {
        await store.dispose();
      } finally {
        await audition?.discard(); // a no-op after a commit
      }
    }
  };
}

export const analyseStructure: AnalyseStructure = makeAnalyseStructure({ openDemucsCore, runFolds, loadOrt, trackDownbeats, flushReleasedMemory });
