// The Structure engine's public interface (Plan 3, Task 0). No Node imports: the dialog bundles this file.
// The dialog and flow only ever see these types; ORT, Demucs and allin1 stay behind `engine.ts`.
import type { Pace } from "../core/pace.js";

export const STRUCTURE_ENGINE = "allin1-onnx-5"; // 5: 1.0.0 kept no stems under Live's sandboxed Node (fsync denied), so its analyses run again and keep them; 4: retires dev-only -3 caches (placeholder candidates/peaks, 0.01 floor); 3: boundary candidates + stem peaks (feedback round 1); 2: conditional peak normalisation (Task 9 review I1)
export const STEM_NAMES = ["drums", "bass", "vocals", "other"] as const; // dialog lane order (spec)
export type StemName = (typeof STEM_NAMES)[number];
export const FUNCTION_LABELS = ["start", "end", "intro", "outro", "break", "bridge", "inst", "solo", "verse", "chorus"] as const; // allin1 HARMONIX_LABELS index order
export type FunctionLabel = (typeof FUNCTION_LABELS)[number];
export const FEATURE_RATE = 2; // frames per second of every per-frame array below
export const FEATURE_BANDS = 81;
export const PEAK_RATE = 20; // blocks per second of StemFeatures.peak
/**
 * Centre frequency (Hz) of each of the 81 bands: the FFT-bin frequency of the centre bin of madmom 0.16.1's
 * LogarithmicFilterbank as allin1 uses it (frame 2048, 44.1 kHz, 12 bands per octave, 30 Hz to 17 kHz, unique bins).
 * Fixed, because the engine always works at 44.1 kHz. They are NOT a semitone grid: below ~500 Hz there is one
 * band per FFT bin (21.5 Hz apart), so pitch classes there are irregular; the top reaches 15.8 kHz.
 */
export const ALLIN1_BAND_HZ: readonly number[] = [
  43.06640625, 64.599609375, 86.1328125, 107.666015625, 129.19921875, 150.732421875,
  172.265625, 193.798828125, 215.33203125, 236.865234375, 258.3984375, 279.931640625,
  301.46484375, 322.998046875, 344.53125, 366.064453125, 387.59765625, 409.130859375,
  430.6640625, 452.197265625, 495.263671875, 516.796875, 538.330078125, 581.396484375,
  624.462890625, 645.99609375, 689.0625, 732.12890625, 775.1953125, 839.794921875,
  882.861328125, 925.927734375, 990.52734375, 1055.126953125, 1098.193359375, 1184.326171875,
  1248.92578125, 1313.525390625, 1399.658203125, 1485.791015625, 1571.923828125, 1658.056640625,
  1765.72265625, 1873.388671875, 1981.0546875, 2088.720703125, 2217.919921875, 2347.119140625,
  2497.8515625, 2627.05078125, 2799.31640625, 2950.048828125, 3143.84765625, 3316.11328125,
  3509.912109375, 3725.244140625, 3940.576171875, 4177.44140625, 4435.83984375, 4694.23828125,
  4974.169921875, 5275.634765625, 5577.099609375, 5921.630859375, 6266.162109375, 6653.759765625,
  7041.357421875, 7450.48828125, 7902.685546875, 8376.416015625, 8871.6796875, 9388.4765625,
  9948.33984375, 10551.26953125, 11175.732421875, 11843.26171875, 12553.857421875, 13285.986328125,
  14082.71484375, 14922.509765625, 15805.37109375,
];

export interface StructureSegment {
  start: number;
  end: number;
  label: FunctionLabel;
} // seconds from clip audio start

export interface StemFeatures {
  bands: number[][]; // [frames][81]: mean of allin1's log10(1 + filtered |STFT|) over each 0.5 s frame, 3 decimals
  loudnessDb: number[]; // [frames]: RMS of the float stem over both channels, dBFS at the clip's own level (inputGainDb taken back out), floored at -100, 1 decimal
  /**
   * [ceil(durationSec * PEAK_RATE)]: max |sample| over both channels in each 1/PEAK_RATE s block (2205 samples at
   * 44.1 kHz; the last block may be partial), at the clip's own level (inputGainDb taken back out), clamped to
   * [0, 1], 3 decimals. For drawing the stem's waveform.
   */
  peak: number[];
}

/** A frame allin1 could have put a section boundary on. */
export interface BoundaryCandidate {
  time: number; // seconds from clip audio start, the frame time exactly as allin1 converts it (frame * 441 / 44100)
  strength: number; // allin1's section probability (sigmoid) at that frame, 0..1, 4 decimals (so weak candidates still rank)
}

export interface StructureAnalysis {
  engine: typeof STRUCTURE_ENGINE;
  durationSec: number;
  segments: StructureSegment[]; // contiguous; first.start = 0, last.end = durationSec
  beats: number[]; // seconds, ascending; [] when none were found
  downbeats: number[]; // seconds, a subset of beats
  bpm: number | null;
  featureRate: typeof FEATURE_RATE;
  frames: number; // ceil(durationSec * FEATURE_RATE): length of every per-frame array
  functionProbs: number[][]; // [frames][10], FUNCTION_LABELS order; rows sum to 1 within 0.005 (values rounded to 3 decimals, so never test for exactly 1)
  /**
   * Ascending time. Every frame that survives allin1's own 97-frame local-maximum filter with section probability
   * >= 0.001 (the dialog applies its own floor on top), frame 0 excluded, plus allin1's chosen boundary frames
   * whatever their probability: segments[k].start for k >= 1 each appear here as the same float. [] for silent,
   * too-short and flat-logit clips. Long tracks (fold windows) give the same list as a single pass would.
   */
  boundaryCandidates: BoundaryCandidate[];
  bandHz: number[]; // [81] = ALLIN1_BAND_HZ: the centre frequency of each filterbank band, ascending
  stems: Record<StemName, StemFeatures>;
  /**
   * Gain in dB applied to the decoded mix before Demucs and allin1 (Task 9 review I1: allin1 is level-sensitive).
   * 0 when the mix peaks at or above -6 dBFS (left untouched) or is silence; otherwise the gain that brings its peak
   * to -1 dBFS. `bands` and keepStemsDir's WAVs are of the scaled audio; `loudnessDb` is not. Absent in results
   * cached before engine "allin1-onnx-2".
   */
  inputGainDb?: number;
}

/**
 * The four stages `analyseStructure` reports, in order. Decoding and resampling the input report as
 * "separating". The set is frozen: consumers may map it exhaustively.
 */
export type StructureStage = "separating" | "features" | "structure" | "beats";

export interface StructureEnv {
  modelDir: string;
  tempDir: string;
  extensionRoot: string;
  storageDir: string; // non-empty (rejected otherwise); context.environment.storageDirectory: onnxruntime is copied there and loaded from it (Branch A')
  keepStemsDir?: string; // when set, float32 stereo stem WAVs <stem>.wav are left here (v2 export, golden SDR test), at the analysed level (scaled by inputGainDb); written only when the analysis succeeds
  /**
   * When set, the stems for audition (feedback round 2 B): 16-bit 44.1 kHz stereo `<stem>.wav` at the clip's own level
   * (inputGainDb taken back out), streamed while the stems are read and renamed into this folder only when the analysis
   * succeeds (a cancel or failure leaves neither it nor its temp sibling). Failing to write them does not fail the analysis.
   */
  auditionStemsDir?: string;
  /**
   * How the analysis yields to the host (fb2 review I1, I2): core/pace.ts FOREGROUND when absent. A background analysis
   * passes a backgroundPace, which cuts its slices finer, rests after each and stops while the host has foreground work.
   * The results are the same either way.
   */
  pace?: Pace;
}

/**
 * `onProgress(fraction, stage)`: `fraction` is the OVERALL progress, 0..1, non-decreasing across the whole run
 * (it does not reset per stage); `stage` says what is running now.
 */
export type AnalyseStructure = (
  audioPath: string,
  env: StructureEnv,
  signal: AbortSignal,
  onProgress: (fraction: number, stage: StructureStage) => void,
) => Promise<StructureAnalysis>;

/** fb/hfmodels: what ensureModels is doing: downloading the checkpoints, or building the model files from them. */
export type ModelsPhase = "download" | "build";

export interface EnsureModelsOptions {
  storageDir: string;
  signal: AbortSignal;
  /** Bytes done and in all, per phase (each phase starts again from 0). An absent phase means "download". */
  onProgress: (doneBytes: number, totalBytes: number, phase?: ModelsPhase) => void;
}
export type EnsureModels = (opts: EnsureModelsOptions) => Promise<string>; // resolves to the model dir

// Calibrated in Live's dev host (Task 11, findings E10/E11; M2 Pro, Set at 48 kHz, load 6-10). Wall time incl. Live's
// render was 20.1 s at 0.5 min, 65.6 s at 2.95, 108.1 s at 5, 226.1 s at 10, 453.0 s at 20 and 665.1 s at 29.5 min;
// peak RSS stayed at or under 2657 MB up to 29.5 min (fold windows), so the 3 GB rule allows the 30-minute cap.
export const STRUCTURE_WARN_SEC = 476; // the length whose estimate is 3 minutes
export const STRUCTURE_MAX_SEC = 1800;
export function estimateStructureSec(durationSec: number): number {
  return Math.round(1.8 + 0.3745 * durationSec); // least-squares fit of the times above
}
