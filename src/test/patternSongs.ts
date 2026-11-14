// Synthetic songs for the pattern engine's tests (Plan 5). 120 bpm (a bar is 2 s) unless stated. Sections are in seconds.
import { CELL_RATE, LOUD_FLOOR_DB, PATTERN_ENGINE, PATTERN_SOURCES, encodeInt8, sourceKind } from "../patterns/contract.js";
import type { GridBar, PatternFeatures, SourceCells, SourceKind, Span } from "../patterns/contract.js";
import { cellExtractor } from "../patterns/features.js";
import { renderSong, rng, type BarScript, type Note, type SynthSong } from "../patterns/synth.js";

export interface PatternSong {
  song: SynthSong;
  sections: Span[];
}

const BPM = 120;
const BAR_SEC = 2;

// MIDI pitches
const A3 = 57, As3 = 58, B3 = 59, C4 = 60, Cs4 = 61, D4 = 62, Ds4 = 63, E4 = 64, F4 = 65, Fs4 = 66, G4 = 67;
const A4 = 69, As4 = 70, C5 = 72, Cs5 = 73, D5 = 74;

/** One note per entry, each `step` beats long, from beat 0. */
const run = (pitches: number[], step: number): Note[] => pitches.map((pitch, i) => ({ pitch, at: i * step, len: step }));
const bar = (pitches: number[], step: number): BarScript => ({ notes: run(pitches, step) });
const transpose = (b: BarScript, k: number): BarScript => ({ ...b, notes: b.notes?.map((n) => ({ ...n, pitch: n.pitch + k })) });
const repeat = <T>(xs: T[], n: number): T[] => Array.from({ length: n }, () => xs).flat();
/** Consecutive sections of `bars` bars each. */
const sectionsOf = (...bars: number[]): Span[] => {
  let t = 0;
  return bars.map((n) => ({ start: t, end: (t += n * BAR_SEC) }));
};

const X = bar([C4, E4, G4, E4], 1);
const Y = bar([D4, F4, A4, F4], 1);

/** 8 bars, [X, Y] × 4, one section. */
export function twoBarIdea(): PatternSong {
  return { song: { bpm: BPM, bars: repeat([X, Y], 4) }, sections: sectionsOf(8) };
}

/** 16 bars, [a1 a2 a3 a4] × 4, one section; a2..a4 are a1 with one note changed. */
export function fourBarPhrase(): PatternSong {
  const a1 = [A3, C4, E4, C4, A3, C4, E4, C4];
  const change = (i: number, p: number) => a1.map((q, j) => (j === i ? p : q));
  const a = [a1, change(6, D4), change(2, G4), change(7, B3)].map((ps) => bar(ps, 0.5));
  return { song: { bpm: BPM, bars: repeat(a, 4) }, sections: sectionsOf(16) };
}

/**
 * `song` as a player would play it, never twice the same: each note and hit up to `jitter` beats early or late, each
 * note's velocity scaled by 0.3 to 1 (seeded), over a noise floor at −30 dBFS. The default jitter (0.1 beats, 50 ms at
 * 120 bpm) gives a tonal source the repeat fidelity of the real "other" stems (0.86–0.93 against Flim's and Kashmir's
 * 0.88–0.91, see repeatFidelity); drums are more sensitive to timing and need only DRUM_JITTER for theirs (0.85–0.89
 * against 0.85–0.92). So a song played is a test on the stem values of the thresholds.
 */
export function played(song: SynthSong, seed = 7, jitter = 0.1): SynthSong {
  const rand = rng(seed);
  const nudge = (at: number) => Math.max(0, at + (rand() * 2 - 1) * jitter);
  const bars = song.bars.map((b) => ({
    ...b,
    notes: b.notes?.map((n) => ({ ...n, at: nudge(n.at), vel: (n.vel ?? 1) * (0.3 + 0.7 * rand()) })),
    hits: b.hits?.map((h) => ({ ...h, at: nudge(h.at) })),
  }));
  return { ...song, bars, noiseDb: -30, seed: 3 };
}
export const DRUM_JITTER = 0.03;

/**
 * 16 bars, [p1 p2 p3 p4] × 4, one section: a 4-bar phrase of four different arpeggios in eighths, played (above) loosely,
 * 0.2 beats. Its phrases score 0.67 to 0.71 against each other, as Flim's Intro 1 does on its Demucs stem (0.63 to
 * 0.80), where the clean phrases of fourBarPhrase score 1.
 */
export function playedPhrase(): PatternSong {
  const phrase = [[A3, C4, E4, C4, A3, C4, E4, C4], [D4, F4, A4, F4, D4, F4, A4, F4], [E4, G4, B3, G4, E4, G4, B3, G4], [A3, E4, A4, E4, C4, E4, A4, E4]];
  const bars = repeat(phrase.map((ps) => bar(ps, 0.5)), 4);
  return { song: played({ bpm: BPM, bars }, 7, 0.2), sections: sectionsOf(16) };
}

/**
 * Eight bars no two of which are alike: each its own chord, contour and rhythm (eighths, quarters, a dotted figure). For
 * phrases of any length.
 */
const DISTINCT: BarScript[] = [
  bar([A3, C4, E4, C4, A3, C4, E4, C4], 0.5),
  bar([D4, F4, A4, F4], 1),
  { notes: [Cs4, E4, As4].map((pitch, i) => ({ pitch, at: 1.5 * i, len: i === 2 ? 1 : 1.5 })) },
  bar([F4, A4, C5, A4, F4, C5, A4, F4], 0.5),
  bar([G4, B3, D4, G4], 1),
  bar([C4, G4, E4, C5, E4, G4, C4, G4], 0.5),
  { notes: [As3, D4, F4].map((pitch, i) => ({ pitch, at: 1.5 * i, len: i === 2 ? 1 : 1.5 })) },
  bar([Ds4, Fs4, B3, Fs4, Ds4, B3, Fs4, Ds4], 0.5),
];

/** One section of a phrase of `bars` different bars (1 to 8), played `times` times: Flim's 5-bar D, Kashmir's 3-bar A B C. */
export function oddPhrase(bars: number, times: number): PatternSong {
  return { song: { bpm: BPM, bars: repeat(DISTINCT.slice(0, bars), times) }, sections: sectionsOf(bars * times) };
}

/**
 * One section of a phrase spelled in letters, A to H each one of DISTINCT's bars, played `times` times: "AAAAB" is four
 * bars of one idea and a tag bar, "ABABAC" three 2-bar ideas a a b.
 */
export function letteredPhrase(phrase: string, times: number): PatternSong {
  const bars = [...phrase].map((c) => DISTINCT["ABCDEFGH".indexOf(c)]);
  return { song: { bpm: BPM, bars: repeat(bars, times) }, sections: sectionsOf(bars.length * times) };
}

/**
 * 16 bars in one section, as Flim's Instrumental 1 under allin1's markers: 6 bars that end an earlier idea (no two alike,
 * none of them in the phrase), then a 5-bar phrase twice. The 6 are DISTINCT's last three bars and three of them
 * transposed by a tritone.
 */
export function leftoverPhrase(): PatternSong {
  const tail = [...DISTINCT.slice(5), ...DISTINCT.slice(5).map((b) => transpose(b, 6))];
  return { song: { bpm: BPM, bars: [...tail, ...repeat(DISTINCT.slice(0, 5), 2)] }, sections: sectionsOf(16) };
}

/** 2 bars: one A3 held 8 beats, swelling (as a reversed sound does), one section. */
export function heldSound(): PatternSong {
  return { song: { bpm: BPM, bars: [{ notes: [{ pitch: A3, at: 0, len: 8 }], swell: true }, {}] }, sections: sectionsOf(2) };
}

/** [P P] [P+4 P+4] [Q Q]: P a 2-bar idea of eighths on C4–G4, Q dotted quarters on pitch classes neither P nor P+4 uses. */
export function transposedRepeat(): PatternSong {
  const P = [bar([C4, D4, E4, F4, G4, F4, E4, D4], 0.5), bar([E4, G4, F4, D4, C4, E4, D4, C4], 0.5)];
  const dotted = (ps: number[]): BarScript => ({ notes: ps.map((pitch, i) => ({ pitch, at: 1.5 * i, len: i === 2 ? 1 : 1.5 })) });
  const Q = [dotted([Cs4, Ds4, As3]), dotted([As3, Cs4, Ds4])];
  const P4 = P.map((b) => transpose(b, 4));
  return { song: { bpm: BPM, bars: [...P, ...P, ...P4, ...P4, ...Q, ...Q] }, sections: sectionsOf(4, 4, 4) };
}

/**
 * Six 4-bar sections A×4 | G×4 | B×4 | G×4 | A×4 | B B B N. A: C major arpeggio in eighths. B: F♯ major arpeggio in
 * quarters. G: all 12 pitch classes at once, pulsed in eighths (the "generic bar"). N: A's rhythm and contour on D E A,
 * which shares one pitch class (E, where A plays it) with A and is no transposition of A (D E A is no major triad).
 */
export function genericBar(): PatternSong {
  const A = bar([C4, E4, G4, C5, G4, E4, C4, E4], 0.5);
  const B = bar([Fs4, As4, Cs5, As4], 1);
  const cluster = Array.from({ length: 12 }, (_, k) => C4 + k);
  const G: BarScript = { notes: Array.from({ length: 8 }, (_, i) => cluster.map((pitch) => ({ pitch, at: 0.5 * i, len: 0.5, vel: 0.3 }))).flat() };
  const N = bar([D4, E4, A4, D5, A4, E4, D4, E4], 0.5);
  const bars = [...repeat([A], 4), ...repeat([G], 4), ...repeat([B], 4), ...repeat([G], 4), ...repeat([A], 4), B, B, B, N];
  return { song: { bpm: BPM, bars }, sections: sectionsOf(4, 4, 4, 4, 4, 4) };
}

/**
 * 12 bars of a 1-bar riff R; bar 6 is 6 beats, R then its last note decaying through the pause (3 s). `downbeats` are
 * the true ones; `allin1Downbeats` have the 3 bars from 12 s to 19 s as 2 even bars of 3.5 s, the way allin1 goes
 * half-time in Flim at 0:56–1:10.
 */
export function irregularBar(): PatternSong & { downbeats: number[]; allin1Downbeats: number[] } {
  const R = bar([A3, C4, E4, A4, G4, E4, C4, E4], 0.5);
  const pause: BarScript = { beats: 6, notes: R.notes!.map((n, i) => (i === 7 ? { ...n, len: n.len + 2 } : n)) };
  const bars = repeat([R], 12);
  bars[6] = pause;
  const song: SynthSong = { bpm: BPM, bars };
  let t = 0;
  const downbeats = bars.map((b) => (t += ((b.beats ?? 4) * 60) / BPM) - ((b.beats ?? 4) * 60) / BPM);
  const allin1Downbeats = [...downbeats.filter((d) => d < 12 || d >= 19), 12, 15.5].sort((a, b) => a - b);
  return { song, sections: [{ start: 0, end: t }], downbeats, allin1Downbeats };
}

/** RMS dBFS of a rendered song. */
function rmsDb(s: SynthSong): number {
  const { x } = renderSong(s);
  return 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length);
}

/** 16 bars in one section: `loud` is twoBarIdea × 2 at −14 dBFS RMS; `bleed` is pink-ish noise at −45 dBFS RMS. */
export function bleed(): { loud: SynthSong; bleed: SynthSong; sections: Span[] } {
  const plain: SynthSong = { bpm: BPM, bars: repeat([X, Y], 8) };
  const gainDb = -14 - rmsDb(plain);
  return {
    loud: { ...plain, bars: plain.bars.map((b) => ({ ...b, gainDb })) },
    bleed: { bpm: BPM, bars: repeat([{}], 16), noiseDb: -45, seed: 2 },
    sections: sectionsOf(16),
  };
}

const dimsOf = new Map<SourceKind, number>();
function kindDims(kind: SourceKind): number {
  let d = dimsOf.get(kind);
  if (d === undefined) {
    const ex = cellExtractor(kind, 11025);
    ex.push(new Float32Array(1103)); // 0.1 s of silence
    d = ex.finish().dims;
    dimsOf.set(kind, d);
  }
  return d;
}

/**
 * Features for all 5 sources with random Int8 cells (loudness mostly −40..−6 dB, some cells at the floor), a regular grid
 * of 4-beat bars and one section per 16 bars. For perf tests and the size check. `sections` is extra to PatternFeatures.
 */
export function randomFeatures(durationSec: number, bpm: number, seed: number): PatternFeatures & { sections: Span[] } {
  const rand = rng(seed);
  const barSec = (4 * 60) / bpm;
  const grid: GridBar[] = [];
  for (let t = 0; t < durationSec - 1e-9; t += barSec) grid.push({ start: t, end: Math.min(durationSec, t + barSec), unsure: false });
  const sections: Span[] = [];
  for (let i = 0; i < grid.length; i += 16) sections.push({ start: grid[i].start, end: grid[Math.min(grid.length, i + 16) - 1].end });
  const cells = Math.ceil(durationSec * CELL_RATE);
  const sources: PatternFeatures["sources"] = {};
  for (const src of PATTERN_SOURCES) {
    const kind = sourceKind(src);
    const dims = kindDims(kind);
    const data = Int8Array.from({ length: cells * dims }, () => Math.floor(rand() * 256) - 128);
    const loud = Int8Array.from({ length: cells }, () => (rand() < 0.05 ? LOUD_FLOOR_DB : -40 + Math.floor(rand() * 35)));
    const sc: SourceCells = { kind, dims, cells, data: encodeInt8(data), loud: encodeInt8(loud) };
    sources[src] = sc;
  }
  return { engine: PATTERN_ENGINE, rate: CELL_RATE, durationSec, grid, sources, sections };
}
