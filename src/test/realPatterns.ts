// Real songs for the pattern engine's scoring (Plan 5, Task 10). Node only. Tests that read them gate on
// `describe.skipIf(!realStorage())`, so they skip cleanly without SONG_SECTIONS_STORAGE (as modelsDir() in golden.ts).
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { correctedGrid } from "../dialog/gridChoice.js";
import { sanitize } from "../dialog/state.js";
import { CANDIDATE_FLOOR, granularBoundaries } from "../grouping/granularity.js";
import { snapBoundaries } from "../grouping/snap.js";
import { readMono } from "../key/harmony.js";
import { STEM_NAMES, STRUCTURE_ENGINE, type StructureAnalysis } from "../structure/contract.js";
import type { AnswerKey, Baseline, SongLanes } from "../patterns/answerKey.js";
import { PATTERN_LEVELS, PATTERN_SOURCES, type Marker, type PatternFeatures, type PatternSource, type Span } from "../patterns/contract.js";
import { createPatternEngine, sectionSpans } from "../patterns/engine.js";
import { decodeSource } from "../patterns/features.js";
import { createSimilarity, sourceLevelDb } from "../patterns/similarity.js";
import { computePatterns } from "../patterns/host.js";
import { NO_EDITS } from "../patterns/lane.js";

export const FLIM = "f9368f9a";
export const KASHMIR = "fcc36dbd";
/** Flim as Matt analysed it in Live on 2026-11-04 (179.2 s, allin1 at 146 bpm): allin1 makes Instrumental 1 and 2 one section. */
export const FLIM_LIVE = "26b0798f";

const PATTERN_FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures", "patterns");

/** The analysis cache in `storage`: this engine's, or the -4 one (5 changed only what is kept beside it, not the analysis). */
function analysisDir(storage: string): string {
  const current = join(storage, "cache", STRUCTURE_ENGINE);
  return existsSync(current) ? current : join(storage, "cache", "allin1-onnx-4");
}

/** The full hash starting with `hash8` that has both an analysis and kept stems in `storage`, or undefined. */
export function findSong(storage: string, hash8: string): string | undefined {
  const analyses = analysisDir(storage);
  const stems = join(storage, "stems");
  if (!existsSync(analyses) || !existsSync(stems)) return undefined;
  const stemDirs = readdirSync(stems);
  return readdirSync(analyses)
    .filter((f) => f.startsWith(hash8) && f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .find((h) => stemDirs.includes(h));
}

/** SONG_SECTIONS_STORAGE, only when it holds the allin1 cache and stems of both Flim and Kashmir. */
export function realStorage(): string | undefined {
  const d = process.env.SONG_SECTIONS_STORAGE;
  return d && findSong(d, FLIM) && findSong(d, KASHMIR) ? d : undefined;
}

export async function readKey(): Promise<AnswerKey> {
  return JSON.parse(await readFile(join(PATTERN_FIXTURES, "flim-answer-key.json"), "utf8")) as AnswerKey;
}
/** Matt's second Flim key: his phrase-level reading (3-, 5- and 6-bar phrases), on the same song and source. */
export async function readKeyV2(): Promise<AnswerKey> {
  return JSON.parse(await readFile(join(PATTERN_FIXTURES, "flim-answer-key-v2.json"), "utf8")) as AnswerKey;
}
export async function readBaseline(): Promise<Baseline> {
  return JSON.parse(await readFile(join(PATTERN_FIXTURES, "kashmir-spike2.json"), "utf8")) as Baseline;
}

/**
 * A song's lanes as the dialog would open it: patterns computed from its kept stems (and the four stems summed as the mix:
 * the render is not kept, as in scripts/key-report.ts), the default markers (the analysis' segment starts after the first,
 * snapped to the downbeats; with pattern features the dialog's downbeats are their corrected grid's bar starts, final
 * review item 8), and the lane of `source` at every level, with no edits.
 */
export async function loadSong(
  storage: string,
  hash8: string,
  source: PatternSource = "other",
): Promise<SongLanes & { features: PatternFeatures; markers: Marker[] }> {
  const hash = findSong(storage, hash8);
  if (!hash) throw new Error(`no analysis and stems for ${hash8} in ${storage}`);
  const analysis = JSON.parse(await readFile(join(analysisDir(storage), `${hash}.json`), "utf8")) as StructureAnalysis;
  const stemsDir = join(storage, "stems", hash);
  let mix: Float32Array | null = null;
  let rate = 0;
  for (const stem of STEM_NAMES) {
    const m = await readMono(join(stemsDir, `${stem}.wav`));
    rate = m.rate;
    if (!mix) mix = Float32Array.from(m.x);
    else for (let i = 0; i < Math.min(mix.length, m.x.length); i++) mix[i] += m.x[i];
  }
  const features = await computePatterns({ storageDir: storage, hash, analysis, mix: { x: mix!, rate }, stemsDir });
  const duration = analysis.durationSec;
  const starts = analysis.segments.slice(1).map((s) => s.start);
  const downbeats = correctedGrid({ beats: analysis.beats, bars: analysis.downbeats }, features.grid).bars;
  const markers: Marker[] = snapBoundaries(sanitize(starts, duration), downbeats, duration).map((time, i) => ({ id: i + 1, time }));
  const engine = createPatternEngine(features);
  const levels = Array.from({ length: PATTERN_LEVELS + 1 }, (_, l) => engine.lane(source, markers, l, NO_EDITS));
  // the source's scores, as the engine makes its Similarity (rests gated against the loudest source)
  const decoded = PATTERN_SOURCES.flatMap((s) => (features.sources[s] ? [decodeSource(features.sources[s]!)] : []));
  const referenceDb = Math.max(...decoded.map((d) => sourceLevelDb(d, features.grid)));
  const sim = createSimilarity(decodeSource(features.sources[source]!), features.grid, { referenceDb });
  const score = (a: Span, b: Span) => (sim.score ? sim.score(a, b) : (sim.compare(a, b)?.score ?? null));
  return { durationSec: duration, sections: sectionSpans(markers, duration), grid: features.grid, levels, score, features, markers };
}

/** SONG_SECTIONS_STORAGE, only when it holds the allin1 cache and stems of `hash8`. */
export function storageWith(hash8: string): string | undefined {
  const d = process.env.SONG_SECTIONS_STORAGE;
  return d && findSong(d, hash8) ? d : undefined;
}

/**
 * A song's lanes with its sections as the dialog makes them at Sections slider `granularity` (granularBoundaries over
 * allin1's segment starts and boundary candidates, snapped to the corrected grid's bars), not the default markers.
 */
export async function loadSongAt(
  storage: string,
  hash8: string,
  granularity: number,
  source: PatternSource = "other",
): Promise<SongLanes> {
  const song = await loadSong(storage, hash8, source);
  const hash = findSong(storage, hash8)!;
  const analysis = JSON.parse(await readFile(join(analysisDir(storage), `${hash}.json`), "utf8")) as StructureAnalysis;
  const duration = analysis.durationSec;
  const downbeats = correctedGrid({ beats: analysis.beats, bars: analysis.downbeats }, song.features.grid).bars;
  const initial = sanitize(analysis.segments.slice(1).map((s) => s.start), duration);
  const chosen = granularBoundaries(initial, analysis.boundaryCandidates ?? [], granularity, duration, CANDIDATE_FLOOR, downbeats, downbeats);
  const markers: Marker[] = snapBoundaries(chosen, downbeats, duration).map((time, i) => ({ id: i + 1, time }));
  const engine = createPatternEngine(song.features);
  const levels = Array.from({ length: PATTERN_LEVELS + 1 }, (_, l) => engine.lane(source, markers, l, NO_EDITS));
  return { durationSec: duration, sections: sectionSpans(markers, duration), grid: song.features.grid, levels };
}
