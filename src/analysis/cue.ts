import type { PreparedAudio } from "../audio/prepare.js";
import { BLOCK_SEC, blockFeatures } from "./features.js";
import { noveltyCurve } from "./novelty.js";
import { pickPeaks } from "./peaks.js";
import { abortError } from "../core/abort.js";

export interface CueAnalysis {
  novelty: number[];
  blocksPerSec: 2;
  boundaries: number[]; // pickPeaks at DEFAULT_GRANULARITY
  engine: "cue-dsp-1";
}

export const DEFAULT_GRANULARITY = 0.5;
const BLOCKS_PER_SEC = (1 / BLOCK_SEC) as 2;

/** DSP novelty analysis of a prepared clip: novelty curve plus default boundaries. */
export async function analyseCue(
  p: PreparedAudio,
  signal: AbortSignal,
  onProgress: (f: number) => void,
): Promise<CueAnalysis> {
  const blocks = await blockFeatures(p.analysis, p.analysisRate, signal, onProgress);
  if (signal.aborted) throw abortError("Analysis aborted");
  const novelty = Array.from(noveltyCurve(blocks));
  return {
    novelty,
    blocksPerSec: BLOCKS_PER_SEC,
    boundaries: pickPeaks(novelty, BLOCKS_PER_SEC, DEFAULT_GRANULARITY),
    engine: "cue-dsp-1",
  };
}
