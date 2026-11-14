// Per-section feature vectors from a StructureAnalysis (Plan 4, Task 2). Pure; no Node imports (the dialog bundles this).
import type { GroupBy } from "../dialog/protocol.js";
import { SILENT_DB } from "./letters.js";
import { FEATURE_BANDS, FEATURE_RATE, STEM_NAMES, type StemName, type StructureAnalysis } from "../structure/contract.js";


const MIN_CHROMA_HZ = 55;
const TIMBRE_WEIGHT = 0.5;
const SIGMA_FLOOR = 1e-6;
const CHROMA_WEIGHT: Record<Source, number> = { drums: 0, bass: 1, vocals: 1, other: 1, melody: 1 };
const CHROMA_DIM = 12;

/**
 * Where features come from: one stem, or "melody", the vocals and other stems summed (fb2, Group by Melody): their band
 * energies added per frame (10^band - 1, as the chroma folds them) and their loudness power-summed.
 */
export type Source = StemName | "melody";
/** The stems the melody is taken from. */
export const MELODY_STEMS = ["vocals", "other"] as const satisfies readonly StemName[];

// Running sums over the frames, so a span's sum is two lookups and a subtraction (O(dims), not O(frames x dims)).
// That keeps a boundary drag cheap on a long clip: only the spans that changed cost anything.
interface StemStats {
  cumChroma: Float64Array; // [frames + 1][12]: row f is the sum of the L2-normalised chroma of frames 0..f-1
  cumZ: Float64Array; // [frames + 1][81]: the same for the per-band z-scores over the stem's frames
  cumPower: Float64Array; // [frames + 1]: the same for 10^(loudnessDb / 10)
}

// Memoised per analysis object: the analysis must not be mutated after its first use here.
const cache = new WeakMap<StructureAnalysis, Partial<Record<Source, StemStats>>>();

function l2Normalise(v: Float64Array): Float64Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** The melody's bands and loudness: vocals and other summed per frame. */
function melodyFeatures(a: StructureAnalysis): { bands: number[][]; loudnessDb: number[] } {
  const [v, o] = MELODY_STEMS.map((s) => a.stems[s]);
  const bands = o.bands.map((row, f) => row.map((x, b) => Math.log10(Math.pow(10, x) + Math.pow(10, v.bands[f][b]) - 1)));
  const loudnessDb = o.loudnessDb.map((x, f) => 10 * Math.log10(Math.pow(10, x / 10) + Math.pow(10, v.loudnessDb[f] / 10)));
  return { bands, loudnessDb };
}

function stemStats(a: StructureAnalysis, stem: Source): StemStats {
  let per = cache.get(a);
  if (!per) cache.set(a, (per = {}));
  const hit = per[stem];
  if (hit) return hit;

  const frames = a.frames;
  const src = stem === "melody" ? melodyFeatures(a) : a.stems[stem];
  const bands = src.bands;
  const nb = FEATURE_BANDS;

  const pcOf: number[] = a.bandHz.map((hz) => (hz >= MIN_CHROMA_HZ ? (((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12) : -1));
  const chroma = new Float64Array(frames * CHROMA_DIM);
  for (let f = 0; f < (CHROMA_WEIGHT[stem] === 0 ? 0 : frames); f++) { // drums has chroma weight 0: skip the work
    const row = bands[f];
    const o = f * CHROMA_DIM;
    for (let b = 0; b < nb; b++) {
      const pc = pcOf[b];
      if (pc >= 0) chroma[o + pc] += Math.pow(10, row[b]) - 1;
    }
    let n = 0;
    for (let c = 0; c < CHROMA_DIM; c++) n += chroma[o + c] * chroma[o + c];
    n = Math.sqrt(n);
    if (n > 0) for (let c = 0; c < CHROMA_DIM; c++) chroma[o + c] /= n;
  }

  const z = new Float64Array(frames * nb);
  for (let b = 0; b < nb; b++) {
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += bands[f][b];
    mean = frames > 0 ? mean / frames : 0;
    let varSum = 0;
    for (let f = 0; f < frames; f++) varSum += (bands[f][b] - mean) ** 2;
    const sigma = Math.max(frames > 0 ? Math.sqrt(varSum / frames) : 0, SIGMA_FLOOR);
    for (let f = 0; f < frames; f++) z[f * nb + b] = (bands[f][b] - mean) / sigma;
  }

  const cumChroma = new Float64Array((frames + 1) * CHROMA_DIM);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < CHROMA_DIM; k++) cumChroma[(f + 1) * CHROMA_DIM + k] = cumChroma[f * CHROMA_DIM + k] + chroma[f * CHROMA_DIM + k];
  }
  const cumZ = new Float64Array((frames + 1) * nb);
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < nb; b++) cumZ[(f + 1) * nb + b] = cumZ[f * nb + b] + z[f * nb + b];
  }
  const db = src.loudnessDb;
  const cumPower = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) cumPower[f + 1] = cumPower[f] + Math.pow(10, db[f] / 10);

  return (per[stem] = { cumChroma, cumZ, cumPower });
}

/** Frame range [from, to) covering a span in seconds; at least one frame, clamped to [0, frames]. */
export function sectionFrames(a: StructureAnalysis, start: number, end: number): [from: number, to: number] {
  const from = Math.floor(start * FEATURE_RATE);
  const to = Math.max(from + 1, Math.ceil(end * FEATURE_RATE));
  const clamp = (x: number) => Math.min(Math.max(x, 0), a.frames);
  return [clamp(from), clamp(to)];
}

/** Power mean of the stem's loudness over the span, in dB. -Infinity when the span has no frames. */
export function sectionLoudness(a: StructureAnalysis, stem: Source, start: number, end: number): number {
  const [from, to] = sectionFrames(a, start, end);
  if (to <= from) return -Infinity;
  const { cumPower } = stemStats(a, stem);
  return 10 * Math.log10((cumPower[to] - cumPower[from]) / (to - from));
}

/** True for a stem whose chroma means something (drums has chroma weight 0: its timbre stands in, fb2). */
export const hasChroma = (stem: Source) => CHROMA_WEIGHT[stem] > 0;

/** The melody is silent only when both its stems are (fb2: `no melody`). */
export const melodyAudible = (a: StructureAnalysis, start: number, end: number) =>
  MELODY_STEMS.some((s) => sectionLoudness(a, s, start, end) >= SILENT_DB);

/**
 * The sum, over [t0, t1) seconds, of the stem's per-frame L2-normalised chroma (12 values) or, for `"timbre"`, of
 * its per-band z-scores (81). A frame that only partly overlaps the span counts by the overlap, so spans shorter
 * than a frame, or off the frame grid (downbeats), still get their share. Not normalised. For the repetition
 * scores (fb2): downbeat-synchronous features from the 2 Hz analysis.
 */
export function spanFeature(a: StructureAnalysis, stem: Source, t0: number, t1: number, kind: "chroma" | "timbre"): Float64Array {
  const { cumChroma, cumZ } = stemStats(a, stem);
  const [cum, dim] = kind === "chroma" ? [cumChroma, CHROMA_DIM] : [cumZ, FEATURE_BANDS];
  const out = new Float64Array(dim);
  if (a.frames === 0) return out;
  const at = (t: number, k: number) => {
    const x = Math.min(Math.max(t * FEATURE_RATE, 0), a.frames);
    const f = Math.min(Math.floor(x), a.frames - 1);
    const lo = cum[f * dim + k];
    return lo + (x - f) * (cum[(f + 1) * dim + k] - lo);
  };
  for (let k = 0; k < dim; k++) out[k] = at(t1, k) - at(t0, k);
  return out;
}

function stemVector(a: StructureAnalysis, stem: StemName, from: number, to: number): Float64Array {
  const { cumChroma, cumZ } = stemStats(a, stem);
  const n = Math.max(to - from, 1);
  const v = new Float64Array(CHROMA_DIM + FEATURE_BANDS);

  const c = new Float64Array(CHROMA_DIM);
  for (let k = 0; k < CHROMA_DIM; k++) c[k] = cumChroma[to * CHROMA_DIM + k] - cumChroma[from * CHROMA_DIM + k];
  l2Normalise(c);
  const wc = CHROMA_WEIGHT[stem];
  for (let k = 0; k < CHROMA_DIM; k++) v[k] = wc * c[k];

  const timbreScale = TIMBRE_WEIGHT / (n * Math.sqrt(FEATURE_BANDS));
  for (let b = 0; b < FEATURE_BANDS; b++) v[CHROMA_DIM + b] = (cumZ[to * FEATURE_BANDS + b] - cumZ[from * FEATURE_BANDS + b]) * timbreScale;

  return l2Normalise(v);
}

/** The melody's chroma over frames [from, to), unit length: Group by Melody's vectors (no timbre, fb2). */
function melodyVector(a: StructureAnalysis, from: number, to: number): Float64Array {
  const { cumChroma } = stemStats(a, "melody");
  const c = new Float64Array(CHROMA_DIM);
  for (let k = 0; k < CHROMA_DIM; k++) c[k] = cumChroma[to * CHROMA_DIM + k] - cumChroma[from * CHROMA_DIM + k];
  return l2Normalise(c);
}

/** A stem's mean timbre (per-band z-scores) over frames [from, to), unit length. */
function timbreVector(a: StructureAnalysis, stem: StemName, from: number, to: number): Float64Array {
  const { cumZ } = stemStats(a, stem);
  const v = new Float64Array(FEATURE_BANDS);
  for (let b = 0; b < FEATURE_BANDS; b++) v[b] = cumZ[to * FEATURE_BANDS + b] - cumZ[from * FEATURE_BANDS + b];
  return l2Normalise(v);
}

/**
 * Group by Melody's prime (fb2): the melody's letter comes from its chroma, the prime from the backing. Matt's rule: "the
 * prime means the backing changed" (Flim's strings enter in the second A). The backing is the Other stem's timbre,
 * whichever stem carries the melody: when Vocals carry it, their timbre is the melody itself (controller ruling).
 * True when Other's timbre in `span` is more than MELODY_VARIANT_DIST (cosine distance) from the group's first
 * section's; false when Other is silent in either, since there is no backing to compare.
 *
 * 0.35, from Flim on Matt's second-reference pieces, measured on both analyses of it (177 s and his 141 s clip): his A
 * pieces are 0.07 to 0.15 from the first, his A′ 0.36 to 0.63, his B pieces up to 0.32, and the C piece after the
 * fading sliver 0.56 (the other C pieces 0.06 to 0.36). The closest call is A′'s last piece, 0.36 on the 177 s analysis.
 */
export const MELODY_VARIANT_DIST = 0.35;
export function melodyVariant(a: StructureAnalysis, first: { start: number; end: number }, span: { start: number; end: number }): boolean {
  if (sectionLoudness(a, "other", first.start, first.end) < SILENT_DB || sectionLoudness(a, "other", span.start, span.end) < SILENT_DB) return false;
  const [f0, t0] = sectionFrames(a, first.start, first.end);
  const [f1, t1] = sectionFrames(a, span.start, span.end);
  const x = timbreVector(a, "other", f0, t0);
  const y = timbreVector(a, "other", f1, t1);
  let dot = 0;
  for (let b = 0; b < FEATURE_BANDS; b++) dot += x[b] * y[b];
  return 1 - dot > MELODY_VARIANT_DIST;
}

/**
 * One vector per span, or null when the span is silent in the chosen stem (in every stem, for "all"; in both vocals
 * and other, for "melody").
 */
export function sectionVectors(a: StructureAnalysis, spans: { start: number; end: number }[], groupBy: GroupBy): (Float64Array | null)[] {
  return spans.map(({ start, end }) => {
    const [from, to] = sectionFrames(a, start, end);
    const audible = (s: StemName) => to > from && sectionLoudness(a, s, start, end) >= SILENT_DB;
    if (groupBy === "melody") return to > from && melodyAudible(a, start, end) ? melodyVector(a, from, to) : null;
    if (groupBy !== "all") return audible(groupBy) ? stemVector(a, groupBy, from, to) : null;

    const dim = CHROMA_DIM + FEATURE_BANDS;
    const out = new Float64Array(dim * STEM_NAMES.length);
    let any = false;
    STEM_NAMES.forEach((s, i) => {
      if (!audible(s)) return;
      any = true;
      out.set(stemVector(a, s, from, to), i * dim);
    });
    return any ? l2Normalise(out) : null;
  });
}
