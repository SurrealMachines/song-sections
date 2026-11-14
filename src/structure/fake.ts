// Deterministic stand-in for the Structure engine, for Plan 4 and tests. No Node imports (the dialog bundles it).
import {
  ALLIN1_BAND_HZ,
  FEATURE_BANDS,
  FEATURE_RATE,
  FUNCTION_LABELS,
  PEAK_RATE,
  STEM_NAMES,
  STRUCTURE_ENGINE,
  type BoundaryCandidate,
  type FunctionLabel,
  type StemFeatures,
  type StemName,
  type StructureAnalysis,
  type StructureSegment,
} from "./contract.js";

const PATTERN: FunctionLabel[] = ["start", "intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro", "end"];
export const PITCH_CLASS: Partial<Record<FunctionLabel, number>> = { intro: 0, verse: 2, chorus: 7, bridge: 5, outro: 0 };
export const VOCAL_SILENT = new Set<FunctionLabel>(["intro", "outro", "start", "end"]);
const EDGE_SEC = 2;
const BPM = 120;
const SHORT_SEC = 12; // below this the ten-section pattern would leave sub-second sections

const ALLIN1_FPS = 100;
// Weak candidate strengths, cycled, like the real engine's at the 0.001 floor: mostly 0.001..0.005 with ties.
const WEAK = [0.0012, 0.0031, 0.0012, 0.0047, 0.0019, 0.0088, 0.0012, 0.0026, 0.0143, 0.0031, 0.0055, 0.0019];
// Chosen boundary strengths, cycled: mostly strong, one as weak as Flim's 129.17 s boundary (0.011).
const CHOSEN = [0.193, 0.062, 0.0331, 0.0322, 0.165, 0.0649, 0.011, 0.104, 0.0446];

const pitchClass = (hz: number) => (((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12);

export function fakeStructureAnalysis(durationSec = 180): StructureAnalysis {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new RangeError("durationSec must be positive");
  // Below SHORT_SEC the ten-section pattern does not fit: return the engine's short-clip shape, one segment over the
  // whole clip, no beats and no tempo.
  const short = durationSec < SHORT_SEC;
  const pattern: FunctionLabel[] = short ? ["verse"] : PATTERN;
  const edges = [0];
  if (short) {
    edges.push(durationSec);
  } else {
    // `start` and `end` are 2 s each; the other eight sections share the rest equally.
    const mid = (durationSec - 2 * EDGE_SEC) / (PATTERN.length - 2);
    edges.push(EDGE_SEC);
    for (let k = 1; k < PATTERN.length - 2; k++) edges.push(EDGE_SEC + k * mid);
    edges.push(durationSec - EDGE_SEC, durationSec);
  }
  const segments: StructureSegment[] = pattern.map((label, i) => ({ start: edges[i], end: edges[i + 1], label }));
  const lastChorus = pattern.lastIndexOf("chorus");

  const bandHz = [...ALLIN1_BAND_HZ];
  const pcs = bandHz.map(pitchClass);

  const frames = Math.ceil(durationSec * FEATURE_RATE);
  const stems = Object.fromEntries(STEM_NAMES.map((s) => [s, { bands: [], loudnessDb: [], peak: [] } as StemFeatures])) as Record<StemName, StemFeatures>;
  const functionProbs: number[][] = [];

  for (let f = 0; f < frames; f++) {
    const t = f / FEATURE_RATE;
    let si = segments.findIndex((s) => t >= s.start && t < s.end);
    if (si < 0) si = segments.length - 1;
    const label = segments[si].label;

    const onehot = new Array<number>(FUNCTION_LABELS.length).fill(0);
    onehot[FUNCTION_LABELS.indexOf(label)] = 1;
    functionProbs.push(onehot);

    const pc = PITCH_CLASS[label];
    const tonal = pcs.map((p) => {
      if (pc !== undefined && p === pc) return 2.0;
      if (si === lastChorus && p === 0) return 1.0;
      return 0.2;
    });
    const drums = bandHz.map((hz) => (label === "chorus" && hz < 200 ? 1.5 : 1.0));
    const silent = VOCAL_SILENT.has(label);

    for (const s of STEM_NAMES) {
      if (s === "drums") stems[s].bands.push(drums);
      else if (s === "vocals" && silent) stems[s].bands.push(new Array<number>(FEATURE_BANDS).fill(0));
      else stems[s].bands.push(tonal.slice());
      stems[s].loudnessDb.push(s === "vocals" && silent ? -90 : -12);
    }
  }

  // Peak envelope: the frame's RMS level (loudnessDb) times a crest factor that pulses on the beat, so the peak is
  // always at or above the RMS, as it is for real audio.
  const blocks = Math.ceil(durationSec * PEAK_RATE);
  for (const s of STEM_NAMES) {
    const db = stems[s].loudnessDb;
    stems[s].peak = Array.from({ length: blocks }, (_, b) => {
      const f = Math.min(db.length - 1, Math.floor(b / (PEAK_RATE / FEATURE_RATE)));
      const crest = b % (PEAK_RATE / 2) === 0 ? 3 : 1.6 + 0.2 * Math.sin(b);
      return Math.round(Math.min(1, 10 ** (db[f] / 20) * crest) * 1000) / 1000;
    });
  }

  // Candidates shaped like the real engine's (Flim, ICL at the 0.001 floor): every segment start after the first
  // (the same float as the segment's start, CHOSEN strengths), plus many weak local maxima (< 0.015, WEAK strengths
  // with ties) on allin1's frame grid: on most downbeats (every 2 s from EDGE_SEC) and on some third beats between
  // them, each at least 1 s from a chosen boundary.
  const candidates: BoundaryCandidate[] = segments.slice(1).map((seg, k) => ({ time: seg.start, strength: CHOSEN[k % CHOSEN.length] }));
  const barSec = (4 * 60) / BPM;
  for (let k = 0, w = 0; !short && EDGE_SEC + k * barSec < durationSec - 1; k++) {
    const bar = EDGE_SEC + k * barSec;
    const at = [...(k % 3 !== 2 ? [bar] : []), ...(k % 4 === 1 ? [bar + barSec / 2] : [])];
    for (const t of at) {
      const time = (Math.round(t * ALLIN1_FPS) * 441) / 44100;
      if (time >= durationSec - 1 || segments.some((seg) => Math.abs(seg.start - time) < 1)) continue;
      candidates.push({ time, strength: WEAK[w++ % WEAK.length] });
    }
  }
  candidates.sort((a, b) => a.time - b.time);

  const beats: number[] = [];
  const downbeats: number[] = [];
  const step = 60 / BPM;
  for (let i = 0; !short && EDGE_SEC + i * step < durationSec; i++) {
    const t = EDGE_SEC + i * step;
    beats.push(t);
    if (i % 4 === 0) downbeats.push(t);
  }

  return {
    engine: STRUCTURE_ENGINE,
    durationSec,
    segments,
    beats,
    downbeats,
    bpm: short ? null : BPM,
    featureRate: FEATURE_RATE,
    frames,
    functionProbs,
    boundaryCandidates: candidates,
    bandHz,
    stems,
  };
}
