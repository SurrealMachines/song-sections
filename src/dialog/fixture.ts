// Canned 3-minute payload for state tests and the dev-only dialog preview.
// Not imported by main.ts, so it stays out of the dialog bundle.
import { pickPeaks } from "../analysis/peaks.js";
import type { PatternFeatures } from "../patterns/contract.js";
import { fakePatternFeatures } from "../patterns/fake.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { KK_MAJOR, KK_MINOR, withHarmonics } from "../key/key.js";
import type { CuePayload, Harmony, ModeInfo, StructurePayload, StructurePrefs } from "./protocol.js";

const DURATION = 180;
/**
 * The canned payload's Structure prefs: a neutral starting point, apart from the shipped defaults (DEFAULT_STRUCTURE_PREFS,
 * Matt's own settings), so the state tests do not move whenever those are retuned.
 */
export const FIXTURE_PREFS: StructurePrefs = {
  sliceBy: "sections",
  patternLevel: 1,
  colorMode: "groups",
  snap: true,
  snapTarget: "downbeats",
  granularity: 0,
  groupDist: 0.15,
  showStems: false,
};
const DEFAULT_MODES: ModeInfo = {
  structure: { available: true, reason: null, cached: false, needsDownload: false, downloadBytes: 95230008, diskBytes: 190454313, estimateSec: 66, warn: false },
};
const BLOCKS_PER_SEC = 2;
const STRONG = [12, 30, 52, 75, 96, 118, 140, 162];
const STRONG_HEIGHT = [1, 0.8, 1.15, 0.9, 1.2, 0.85, 1.05, 0.95];
// Weak peaks 4 s after each strong one: hidden at the default granularity, shown near 1.
const WEAK = STRONG.map((t) => t + 4);
const WAVE_POINTS = 1200;

/** Deterministic pseudo-random in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function cannedPayload(overrides: Partial<CuePayload> = {}): CuePayload {
  const rand = rng(7);
  // Gaussian bumps (sigma 0.5 s) on a zero baseline, like a smoothed novelty curve.
  const bump = (t: number, centre: number, height: number) => height * Math.exp(-((t - centre) ** 2) / 0.5);
  const novelty = Array.from({ length: DURATION * BLOCKS_PER_SEC }, (_, i) => {
    const t = i / BLOCKS_PER_SEC;
    let v = 0;
    STRONG.forEach((c, k) => (v += bump(t, c, STRONG_HEIGHT[k])));
    for (const c of WEAK) v += bump(t, c, 0.45);
    return v;
  });

  const min: number[] = [];
  const max: number[] = [];
  for (let i = 0; i < WAVE_POINTS; i++) {
    const t = (i / WAVE_POINTS) * DURATION;
    const section = STRONG.filter((b) => b <= t).length;
    const level = 0.3 + 0.6 * (((section * 37) % 10) / 10);
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 2));
    const a = level * beat * (0.7 + 0.3 * rand());
    max.push(a);
    min.push(-a * (0.8 + 0.2 * rand()));
  }

  const granularity = 0.5;
  return {
    mode: "cue",
    view: "arrangement",
    clipName: "Preview Track",
    durationSec: DURATION,
    audioUrl: "audio.wav",
    waveform: { min, max },
    novelty,
    blocksPerSec: BLOCKS_PER_SEC,
    boundaries: pickPeaks(novelty, BLOCKS_PER_SEC, granularity),
    granularity,
    colorMode: "gradient",
    sourceColor: 0x8a6fd1,
    output: "split",
    warpNote: false,
    modes: DEFAULT_MODES,
    beatGrid: null,
    snap: false,
    ...overrides,
  };
}

/**
 * The canned clip's pattern features. Slow to make (about 1.6 s), so made once per module, when it loads: then the cost
 * falls in the test file's collection, not inside whichever test first builds a payload, where it pushed slow DOM tests
 * past their timeout under a full parallel run.
 */
const CANNED_PATTERNS: PatternFeatures = fakePatternFeatures(fakeStructureAnalysis(DURATION));

/**
 * The canned Structure payload, with the canned pattern features unless `overrides` names `patterns` itself or another
 * duration (the canned features are 180 s long, so they would not fit; that payload has none).
 */
export function cannedStructurePayload(overrides: Partial<StructurePayload> = {}): StructurePayload {
  const { min, max } = cannedPayload().waveform;
  const fits = !("patterns" in overrides) && (overrides.durationSec ?? DURATION) === DURATION;
  return {
    mode: "structure",
    view: "arrangement",
    clipName: "Preview Track",
    durationSec: DURATION,
    audioUrl: "audio.wav",
    waveform: { min, max },
    sourceColor: 0x8a6fd1,
    output: "split",
    warpNote: false,
    modes: DEFAULT_MODES,
    analysis: fakeStructureAnalysis(DURATION),
    ...FIXTURE_PREFS,
    snap: true,
    barGrid: null,
    patterns: fits ? CANNED_PATTERNS : null,
    ...overrides,
  };
}

/**
 * v2: a canned harmony for the keys: D minor to 52 s, A♭ major to 96 s, A minor to 140 s, then D minor again (each
 * frame its key's profile, so every span inside one region keys to it surely).
 */
export const CANNED_KEYS: Array<{ until: number; tonic: number; minor: boolean }> = [
  { until: 52, tonic: 2, minor: true },
  { until: 96, tonic: 8, minor: false },
  { until: 140, tonic: 9, minor: true },
  { until: Infinity, tonic: 2, minor: true },
];
export function cannedHarmony(source: Harmony["source"] = "mix", duration = DURATION): Harmony {
  const chroma = Array.from({ length: duration * 2 }, (_, f) => {
    const k = CANNED_KEYS.find((r) => f / 2 < r.until)!;
    const p = withHarmonics(k.minor ? KK_MINOR : KK_MAJOR);
    return Array.from({ length: 12 }, (_, i) => Math.round((p[(i - k.tonic + 12) % 12] / 12) * 1e4) / 1e4);
  });
  return { source, rate: 2, chroma };
}
