// Deterministic stand-in for a clip's pattern features, made to go with fakeStructureAnalysis (Plan 5, Task 8; Plan 6's
// canned payload and dialog preview). Browser-safe: no Node imports.
//
// It renders a song in 2 s bars (120 bpm, as fakeStructureAnalysis) whose music follows the analysis' segments: drums
// on a 1-bar loop with a fill on each section's last bar; bass and other on a 2-bar idea per section function (the
// chorus a 4-bar phrase), from the section's first bar; vocals a phrase per function, silent where fakeStructureAnalysis
// makes them silent; the mix their sum. Then it extracts the cells as the host does, on the grid patternGrid makes of
// the analysis' downbeats.
import type { FunctionLabel, StemName, StructureAnalysis } from "../structure/contract.js";
import { PITCH_CLASS, VOCAL_SILENT } from "../structure/fake.js";
import { CELL_RATE, PATTERN_ENGINE, sourceKind, type PatternFeatures, type PatternSource } from "./contract.js";
import { cellExtractor, decodeSource } from "./features.js";
import { patternGrid } from "./grid.js";
import { renderSong, type BarScript, type Hit, type Note } from "./synth.js";

const BPM = 120;
const BAR_SEC = (4 * 60) / BPM;
const RATE = 11025;
// each function's key: fakeStructureAnalysis' pitch class where it has one, else one of these, else C (start, end)
const OTHER_KEY: Partial<Record<FunctionLabel, number>> = { break: 9, inst: 4, solo: 11 };
const keyOf = (label: FunctionLabel) => PITCH_CLASS[label] ?? OTHER_KEY[label] ?? 0;

const notes = (base: number, steps: [offset: number, at: number, len: number][]): Note[] =>
  steps.map(([offset, at, len]) => ({ pitch: base + offset, at, len }));
const arpeggio = (base: number, chord: number[], step: number): Note[] =>
  Array.from({ length: 4 / step }, (_, i) => ({ pitch: base + chord[i % chord.length], at: i * step, len: step }));

/** The bars of one function's idea for a tonal stem: 2 bars, the chorus 4. */
function idea(stem: Exclude<StemName, "drums">, label: FunctionLabel): BarScript[] {
  const k = keyOf(label);
  const chorus = label === "chorus";
  if (stem === "bass") {
    const b = 36 + k;
    const bars: Note[][] = [
      notes(b, [[0, 0, 1.5], [0, 1.5, 0.5], [7, 2, 1], [12, 3, 1]]),
      notes(b, [[5, 0, 2], [7, 2, 2]]),
    ];
    if (chorus) bars.push(notes(b, [[9, 0, 1], [9, 1, 1], [4, 2, 1], [4, 3, 1]]), notes(b, [[5, 0, 1], [7, 1, 1], [11, 2, 2]]));
    return bars.map((n) => ({ notes: n }));
  }
  if (stem === "other") {
    const b = 60 + k;
    const step = chorus ? 1 : 0.5;
    const chords = chorus ? [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]] : label === "verse" ? [[0, 3, 7], [5, 8, 12]] : [[0, 4, 7, 12], [5, 9, 12, 17]];
    return chords.map((c) => ({ notes: arpeggio(b, c, step) }));
  }
  const b = 67 + k;
  const bars: Note[][] = [notes(b, [[0, 0, 1], [2, 1, 1], [4, 2, 2]]), notes(b, [[5, 0, 1.5], [4, 1.5, 0.5], [2, 2, 2]])];
  if (chorus) bars.push(notes(b, [[7, 0, 2], [5, 2, 1], [4, 3, 1]]), notes(b, [[2, 0, 1], [0, 1, 3]]));
  return bars.map((n) => ({ notes: n }));
}

const HATS: Hit[] = Array.from({ length: 8 }, (_, i) => ({ drum: "hat", at: 0.5 * i }));
const LOOP: BarScript = { hits: [{ drum: "kick", at: 0 }, { drum: "snare", at: 1 }, { drum: "kick", at: 2 }, { drum: "snare", at: 3 }, ...HATS] };
const FILL: BarScript = {
  hits: [{ drum: "kick", at: 0 }, { drum: "snare", at: 1 }, ...HATS.slice(0, 4), ...[2, 2.5, 3, 3.25, 3.5, 3.75].map((at): Hit => ({ drum: "snare", at }))],
};

/** Each stem's bars: bar i is [i · BAR_SEC, (i + 1) · BAR_SEC), in the segment its start falls in. */
function scripts(a: StructureAnalysis): Record<StemName, BarScript[]> {
  const n = Math.max(1, Math.ceil(a.durationSec / BAR_SEC - 1e-9));
  const segmentOf = (i: number) => {
    const t = i * BAR_SEC;
    const s = a.segments.findIndex((seg) => t >= seg.start && t < seg.end);
    return s < 0 ? a.segments.length - 1 : s;
  };
  const seg = Array.from({ length: n }, (_, i) => segmentOf(i));
  const out: Record<StemName, BarScript[]> = { drums: [], bass: [], vocals: [], other: [] };
  for (let i = 0; i < n; i++) {
    const s = seg[i];
    const label = a.segments[s].label;
    const k = i - seg.indexOf(s); // the bar's place in its section
    out.drums.push(seg[i + 1] === s ? LOOP : FILL);
    for (const stem of ["bass", "other", "vocals"] as const) {
      const bars = idea(stem, label);
      out[stem].push(stem === "vocals" && VOCAL_SILENT.has(label) ? {} : bars[k % bars.length]);
    }
  }
  return out;
}

const memo = new WeakMap<StructureAnalysis, PatternFeatures>();

export function fakePatternFeatures(a: StructureAnalysis): PatternFeatures {
  const hit = memo.get(a);
  if (hit) return hit;
  const samples = Math.round(a.durationSec * RATE);
  const stems = scripts(a);
  const audio = Object.fromEntries(
    (Object.keys(stems) as StemName[]).map((s) => [s, renderSong({ bpm: BPM, rate: RATE, bars: stems[s] }).x.subarray(0, samples)]),
  ) as Record<StemName, Float32Array>;
  const mix = new Float32Array(samples);
  for (const x of Object.values(audio)) for (let i = 0; i < samples; i++) mix[i] += x[i];
  const sources: PatternFeatures["sources"] = {};
  for (const [src, x] of [["mix", mix], ...Object.entries(audio)] as [PatternSource, Float32Array][]) {
    const ex = cellExtractor(sourceKind(src), RATE);
    ex.push(x);
    sources[src] = ex.finish();
  }
  const grid = patternGrid({
    downbeats: a.downbeats,
    beats: a.beats,
    bpm: a.bpm,
    durationSec: a.durationSec,
    evidence: (["other", "drums", "bass"] as const).map((s) => decodeSource(sources[s]!)),
  });
  const f: PatternFeatures = { engine: PATTERN_ENGINE, rate: CELL_RATE, durationSec: a.durationSec, grid, sources };
  memo.set(a, f);
  return f;
}
