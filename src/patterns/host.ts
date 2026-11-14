// The pattern engine's host side (Plan 5, Task 9): the feature cells of each source and the corrected bar grid,
// computed once per clip and cached beside the analyses, in their own entry: `cache/patterns-1/<audio hash>-stems-<STRUCTURE_ENGINE>.json`
// from the kept stems (with the mix), `<audio hash>-mix-<STRUCTURE_ENGINE>.json` from the mix alone. Both carry the
// Structure engine, as the grid is built on its downbeats. The only file of src/patterns that imports from Node.
//
// Memory: a clip can be 30 minutes long, so the stems are read one at a time and streamed through the extractor: only
// one stem is ever in memory beside the mix (which the flow holds anyway).
import { join } from "node:path";
import { loadCached, saveCached } from "../analysis/cache.js";
import { abortError } from "../core/abort.js";
import { FOREGROUND, type Pace } from "../core/pace.js";
import { readMono } from "../key/harmony.js";
import { STEM_NAMES, STRUCTURE_ENGINE, type StructureAnalysis } from "../structure/contract.js";
import {
  CELL_RATE,
  PATTERN_ENGINE,
  isPatternFeatures,
  sourceKind,
  type PatternFeatures,
  type PatternSource,
  type SourceCells,
} from "./contract.js";
import { FEATURE_LAYOUT, cellExtractor, decodeSource } from "./features.js";
import { patternGrid } from "./grid.js";

export interface PatternsRequest {
  storageDir: string;
  hash: string;
  analysis: StructureAnalysis;
  mix: { x: Float32Array; rate: number }; // the prepared analysis signal (PreparedAudio.analysis / analysisRate)
  stemsDir: string | null; // kept stems (<stem>.wav); null: mix only
  pace?: Pace;
}

/** The stems the grid's bar starts are found from, when they are kept (else the mix). */
const GRID_EVIDENCE = ["other", "drums", "bass"] as const;
/** Cells extracted between two yields in the foreground: about 45 ms of work at 11 kHz (the background cuts it finer). */
const SLICE_CELLS = 512;

/** Cells of a clip `durationSec` long: what every source of it has. */
const cellCount = (durationSec: number) => Math.ceil(durationSec * CELL_RATE);

/** The sample count at `rate` that the extractor turns into exactly `cells` cells (its finish: ceil(n · CELL_RATE / rate)). */
function samplesFor(cells: number, rate: number): number {
  const cellsOf = (n: number) => Math.ceil((n * CELL_RATE) / rate);
  let n = Math.floor((cells * rate) / CELL_RATE);
  while (n > 0 && cellsOf(n) > cells) n--;
  while (cellsOf(n) < cells) n++;
  return n;
}

/**
 * The cells of `x`, cut or padded with silence to the clip's length, so every source has the same count. Pushed in
 * slices, yielding between them.
 */
async function extract(
  source: PatternSource,
  x: Float32Array,
  rate: number,
  cells: number,
  pace: Pace,
  signal: AbortSignal | undefined,
): Promise<SourceCells> {
  const ex = cellExtractor(sourceKind(source), rate);
  const n = samplesFor(cells, rate);
  const slice = Math.max(1, Math.round((pace.slice(SLICE_CELLS) * rate) / CELL_RATE));
  for (let at = 0; at < n; at += slice) {
    await pace.yield(signal);
    if (signal?.aborted) throw abortError("Analysis aborted");
    const end = Math.min(n, at + slice);
    if (end <= x.length) ex.push(x.subarray(at, end));
    else {
      const chunk = new Float32Array(end - at);
      if (at < x.length) chunk.set(x.subarray(at));
      ex.push(chunk);
    }
  }
  return ex.finish();
}

/** The feature cells of the mix (and of each kept stem) and the corrected bar grid of this clip. */
export async function computePatterns(req: PatternsRequest, signal?: AbortSignal): Promise<PatternFeatures> {
  const pace = req.pace ?? FOREGROUND;
  if (signal?.aborted) throw abortError("Analysis aborted");
  const { analysis } = req;
  const durationSec = analysis.durationSec;
  const cells = cellCount(durationSec);
  const sources: PatternFeatures["sources"] = {};
  sources.mix = await extract("mix", req.mix.x, req.mix.rate, cells, pace, signal);
  if (req.stemsDir) {
    for (const stem of STEM_NAMES) {
      const { x, rate } = await readMono(join(req.stemsDir, `${stem}.wav`), signal, pace);
      sources[stem] = await extract(stem, x, rate, cells, pace, signal);
    }
  }
  await pace.yield(signal);
  if (signal?.aborted) throw abortError("Analysis aborted");
  const evidence = (req.stemsDir ? GRID_EVIDENCE : (["mix"] as const)).map((s) => decodeSource(sources[s]!));
  const grid = patternGrid({ downbeats: analysis.downbeats, beats: analysis.beats, bpm: analysis.bpm, durationSec, evidence });
  return { engine: PATTERN_ENGINE, rate: CELL_RATE, durationSec, grid, sources };
}

/** The cache entry's name: from the stems or the mix, and tied to the Structure engine whose downbeats the grid follows. */
export const patternsCacheKey = (hash: string, withStems: boolean) => `${hash}-${withStems ? "stems" : "mix"}-${STRUCTURE_ENGINE}`;

/**
 * A cached entry is used only when it is whole and of this request: its clip's length, and every source it asks for,
 * each with the clip's cell count and its kind's dims (FEATURE_LAYOUT), so the engine can decode it. Anything else is
 * recomputed, never shipped.
 */
function fits(v: unknown, req: PatternsRequest): v is PatternFeatures {
  if (!isPatternFeatures(v) || v.durationSec !== req.analysis.durationSec) return false;
  const want: PatternSource[] = req.stemsDir ? ["mix", ...STEM_NAMES] : ["mix"];
  const cells = cellCount(v.durationSec);
  const have = Object.keys(v.sources);
  const whole = (s: PatternSource) => v.sources[s]?.cells === cells && v.sources[s]?.dims === FEATURE_LAYOUT[sourceKind(s)].dims;
  return have.length === want.length && want.every(whole);
}

/** Cached under PATTERN_ENGINE, or computed and cached. null (logged) when computing fails; an abort is rethrown. */
export async function cachedPatterns(
  deps: { loadCached: typeof loadCached; saveCached: typeof saveCached; logError(...a: unknown[]): void },
  req: PatternsRequest,
  compute: (r: PatternsRequest, s?: AbortSignal) => Promise<PatternFeatures> = computePatterns,
  signal?: AbortSignal,
): Promise<PatternFeatures | null> {
  const withStems = req.stemsDir !== null;
  const key = patternsCacheKey(req.hash, withStems);
  try {
    const hit = await deps.loadCached<PatternFeatures>(req.storageDir, key, PATTERN_ENGINE);
    if (fits(hit, req)) return hit;
  } catch {
    // compute them
  }
  let f: PatternFeatures;
  try {
    f = await compute(req, signal);
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "AbortError") throw error;
    deps.logError(`Song Sections: could not find the patterns (${withStems ? "stems" : "mix"}):`, error);
    return null;
  }
  await deps.saveCached(req.storageDir, key, PATTERN_ENGINE, f).catch((error) => {
    deps.logError("Song Sections: could not save the patterns cache:", error);
  });
  return f;
}
