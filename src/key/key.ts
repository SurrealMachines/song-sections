// v2, musical key per section (Matt, 31 Oct). Pure; no Node imports: the dialog bundles this file, and the host uses
// the same functions for the names of what it sends, so the two always agree.
//
// The host computes a harmonic chroma time series once per analysis (key/chroma.ts): 12 pitch-class energies per
// HARMONY_RATE frame, from the stems without the drums (Structure with kept stems) or from the mix. A section's key is
// the best of the 24 major and minor key profiles, correlated with the section's summed chroma, so the dialog can
// re-key a section at once whenever it is renamed, nudged, added or removed.
//
// The profiles are Krumhansl–Kessler's (1982), with each degree's overtones added in (Gómez 2006): degree i also
// weighs on i + 12 log2(h) for harmonics h = 2..6, by 0.6^(h-1). Why KK rather than Temperley (2007) or
// Albrecht–Shanahan (2013): those were fitted to note counts of scores and give the tones outside the scale weights
// near zero; audio chroma always has energy there (overtones, leakage, glides), and KK's probe-tone ratings keep a floor
// under every tone. On the synthetic progressions (key.test.ts) plain Temperley was better on minor keys but worse on the
// real songs (it flips D major sections of Kashmir to D minor, and its margins on Flim are half KK's); plain KK puts
// a ii–V–I in E♭ in B♭, as audio chroma's fifths (the 3rd harmonic) pull every key up a fifth. The overtones in the
// profile take that pull out: E♭ then wins, and the minor keys' margins grow by half.
import type { Harmony } from "../dialog/protocol.js";

/** Krumhansl & Kessler (1982) probe-tone profiles, tonic first. */
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
export const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;
const HARMONICS = 6;
const HARMONIC_DECAY = 0.6;

/** `p` with each degree's harmonics 2..HARMONICS added at their pitch classes, by HARMONIC_DECAY^(h-1) (Gómez 2006). */
export function withHarmonics(p: readonly number[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (let i = 0; i < 12; i++) {
    for (let h = 1; h <= HARMONICS; h++) out[(i + Math.round(12 * Math.log2(h))) % 12] += p[i] * HARMONIC_DECAY ** (h - 1);
  }
  return out;
}
const PROFILES = [withHarmonics(KK_MAJOR), withHarmonics(KK_MINOR)];

/**
 * Below this margin (correlation of the best key minus that of the best one that is not its relative), the key is
 * shown with a trailing "?". From the synthetic progressions (key.test.ts) and the cached real analyses
 * (scripts/key-report.ts): every progression that states its key (I–IV–V, i–iv–V, ii–V–I, in eight keys) scores 0.11 to
 * 0.3; a modal vamp, a two-chord loop or a natural-minor loop that two keys share, 0.0 to 0.1, mostly.
 */
export const SURE_MARGIN = 0.1;
/**
 * Below this correlation with its own profile, a key is not sure whatever its margin: nothing fits well, and the best
 * of 24 poor fits can still stand clear of the rest (controller ruling on concern 4). Set from the cached real analyses
 * (scripts/key-report.ts) before the level and tuning fixes (review I2, M1): Flim's last chorus then fitted G minor at
 * 0.43 with a margin of 0.14, and every other section that passed the margin fitted at 0.63 or better. Since those
 * fixes that chorus fits G major at 0.72 but by a margin of 0.02 (unsure either way); the weakest sure section is
 * Flim's 2:11 verse, D minor at 0.68 (0.66 from the mix); the synthetic progressions fit at 0.85 or better.
 */
export const MIN_FIT = 0.6;
/**
 * A span shorter than this (seconds; 8 chroma frames) is never sure, however well it fits (review I1): a bar or two
 * holds a chord, not a key. One F chord of a C–F–G–C loop fits F major at 0.9 with a margin of 0.29; four seconds of
 * the loop (I–IV, two chords) is already unsure on its own, and the whole loop is C major. Its key still shows, with
 * "?", in the dialog; names carry only sure keys.
 */
export const MIN_SURE_SEC = 4;
/**
 * A span whose mean harmonic energy per frame is under this fraction of the clip's has no key (a drum break, a
 * silence, a fade): what little chroma it has is bleed and reverb.
 */
export const QUIET_FRACTION = 0.08;

export interface Key {
  /** Pitch class of the tonic, 0 = C. */
  tonic: number;
  minor: boolean;
}

export interface KeyEstimate extends Key {
  /** Pearson correlation of the span's chroma with this key's profile, -1..1. */
  score: number;
  /** Its margin over the best key that is not its relative (see SURE_MARGIN). */
  margin: number;
  /** The margin is at least SURE_MARGIN and the score at least MIN_FIT: shown without a "?", and put in names. */
  sure: boolean;
}

const MAJOR_LONG = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const MINOR_LONG = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];

/** The tonic's name as keys are usually spelt (D♭ major, C♯ minor, F♯ either way). */
export const tonicName = (k: Key) => (k.minor ? MINOR_LONG : MAJOR_LONG)[((k.tonic % 12) + 12) % 12];

/** The dialog's form: "F♯ minor", "B♭ major", with "?" when not sure. */
export function keyLong(k: Key | KeyEstimate): string {
  return `${tonicName(k)} ${k.minor ? "minor" : "major"}${"sure" in k && !k.sure ? "?" : ""}`;
}

/** The names' form: "C", "Cm", "F#", "Bbm" (ASCII, safe in a file name). Never marked: names carry only sure keys. */
export function keyShort(k: Key): string {
  return tonicName(k).replace("♭", "b").replace("♯", "#") + (k.minor ? "m" : "");
}

function pearson(x: ArrayLike<number>, y: ArrayLike<number>, rot: number): number {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 12; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= 12;
  my /= 12;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + rot) % 12] - mx;
    const b = y[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** The 24 correlations: index tonic for major, 12 + tonic for minor. NaN for a flat vector. */
export function keyScores(chroma: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (const profile of PROFILES) for (let t = 0; t < 12; t++) out.push(pearson(chroma, profile, t));
  return out;
}

const relativeOf = (i: number) => (i < 12 ? 12 + ((i + 9) % 12) : (i - 12 + 3) % 12);

/** The best key of a 12-bin chroma vector, or null when it has no shape (all zero or all equal). */
export function estimateKey(chroma: ArrayLike<number>): KeyEstimate | null {
  const scores = keyScores(chroma);
  let best = -1;
  for (let i = 0; i < 24; i++) if (Number.isFinite(scores[i]) && (best < 0 || scores[i] > scores[best])) best = i;
  if (best < 0) return null;
  const rel = relativeOf(best);
  let second = -Infinity;
  for (let i = 0; i < 24; i++) if (i !== best && i !== rel && scores[i] > second) second = scores[i];
  const margin = scores[best] - second;
  return { tonic: best % 12, minor: best >= 12, score: scores[best], margin, sure: margin >= SURE_MARGIN && scores[best] >= MIN_FIT };
}

// Running sums per harmony object, so a span's chroma is two lookups per bin (a nudge re-keys in O(sections)).
interface HarmonyStats {
  cum: Float64Array; // [(frames + 1) * 12]
  meanEnergy: number; // mean over the clip of a frame's 12-bin sum
}
const stats = new WeakMap<Harmony, HarmonyStats>();

function harmonyStats(h: Harmony): HarmonyStats {
  const hit = stats.get(h);
  if (hit) return hit;
  const frames = h.chroma.length;
  const cum = new Float64Array((frames + 1) * 12);
  for (let f = 0; f < frames; f++) {
    const row = h.chroma[f];
    for (let k = 0; k < 12; k++) cum[(f + 1) * 12 + k] = cum[f * 12 + k] + (Number.isFinite(row[k]) ? row[k] : 0);
  }
  let total = 0;
  for (let k = 0; k < 12; k++) total += cum[frames * 12 + k];
  const s = { cum, meanEnergy: frames > 0 ? total / frames : 0 };
  stats.set(h, s);
  return s;
}

/** The summed chroma over [t0, t1) seconds; a frame partly inside counts by its overlap. */
export function spanChroma(h: Harmony, t0: number, t1: number): Float64Array {
  const { cum } = harmonyStats(h);
  const frames = h.chroma.length;
  const out = new Float64Array(12);
  if (frames === 0) return out;
  const at = (t: number, k: number) => {
    const x = Math.min(Math.max(t * h.rate, 0), frames);
    const f = Math.min(Math.floor(x), frames - 1);
    const lo = cum[f * 12 + k];
    return lo + (x - f) * (cum[(f + 1) * 12 + k] - lo);
  };
  for (let k = 0; k < 12; k++) out[k] = at(t1, k) - at(t0, k);
  return out;
}

/** The key of [start, end) seconds, or null when the span is too quiet in the harmonic source to have one. */
export function spanKey(h: Harmony, start: number, end: number): KeyEstimate | null {
  const { meanEnergy } = harmonyStats(h);
  const frames = (Math.min(end, h.chroma.length / h.rate) - Math.max(start, 0)) * h.rate;
  if (!(frames > 0) || !(meanEnergy > 0)) return null;
  const v = spanChroma(h, start, end);
  let energy = 0;
  for (let k = 0; k < 12; k++) energy += v[k];
  if (energy / frames < QUIET_FRACTION * meanEnergy) return null;
  const k = estimateKey(v);
  return k && k.sure && frames / h.rate < MIN_SURE_SEC ? { ...k, sure: false } : k;
}

/** One key per section (null: none), as the dialog shows them and the sends name them. */
export function sectionKeys(h: Harmony | null | undefined, sections: readonly { start: number; end: number }[]): (KeyEstimate | null)[] {
  return sections.map((s) => (h ? spanKey(h, s.start, s.end) : null));
}

/** The whole clip's key. */
export function clipKey(h: Harmony | null | undefined): KeyEstimate | null {
  return h ? spanKey(h, 0, h.chroma.length / h.rate) : null;
}

/** "D Minor" for the Set's scale (Song.rootNote and scaleName), spelt as a key would be. */
export function setScaleName(root: number, scaleName: string): string {
  return `${tonicName({ tonic: root, minor: /minor|aeolian|dorian|phrygian|locrian/i.test(scaleName) })} ${scaleName}`;
}
