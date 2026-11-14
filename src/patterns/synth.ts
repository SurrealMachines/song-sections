// Synthetic songs for the pattern engine's tests and its fake (Plan 5, Tasks 2 and 8). Browser-safe: no Node imports.
// Harmonic tones with a short attack and a plucked decay, played slightly detached, and three drums as filtered noise
// bursts. Everything is seeded and deterministic, and a note's samples depend only on the note (never on where it
// falls), so a repeated bar renders to the very same samples.

export interface Note {
  pitch: number; // MIDI
  at: number; // beats from the bar's start
  len: number; // beats
  vel?: number; // 0..1, default 1
}
export interface Hit {
  drum: "kick" | "snare" | "hat";
  at: number; // beats from the bar's start
}
export interface BarScript {
  notes?: Note[];
  hits?: Hit[];
  beats?: number; // default 4 (a longer bar is a pause)
  gainDb?: number;
  swell?: boolean; // notes rise then decay, as a reversed sound does
}
export interface SynthSong {
  bpm: number;
  rate?: number; // default 11025
  bars: BarScript[];
  noiseDb?: number; // a pink-ish noise floor at this RMS dBFS over the whole song
  seed?: number;
}

const DEFAULT_RATE = 11025;
const NOTE_PEAK = 0.25; // a vel-1 note's peak amplitude, before the bar's gain
const PARTIALS = 4; // partial k has amplitude 1/k and decays k times faster
const DECAY_SEC = 0.3; // the fundamental's decay time constant
const ATTACK_SEC = 0.005;
const RELEASE_SEC = 0.02; // a note fades out over this long, then is silent for GAP_SEC
const GAP_SEC = 0.05; // notes are slightly detached: silent for the end of their len, so a bar's start never hears the
// bar before it (a repeated bar then gives the same cells whatever came before)
const SWELL_PEAK = 0.9; // a swelled note rises to its peak at this fraction of its len, then fades out

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiHz = (p: number) => 440 * 2 ** ((p - 69) / 12);

function addNote(out: Float64Array, rate: number, start: number, note: Note, beatSec: number, gain: number, swell: boolean) {
  const f0 = midiHz(note.pitch);
  const full = Math.round(note.len * beatSec * rate);
  const n = full - Math.min(Math.round(GAP_SEC * rate), full >> 1);
  const amp = NOTE_PEAK * (note.vel ?? 1) * gain;
  const release = RELEASE_SEC * rate;
  const partials = Array.from({ length: PARTIALS }, (_, i) => i + 1).filter((k) => k * f0 < 0.45 * rate);
  for (let i = 0; i < n && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const t = i / rate;
    const fade = Math.min(1, (n - i) / release);
    let s = 0;
    if (swell) {
      const u = i / n;
      const env = u <= SWELL_PEAK ? (u / SWELL_PEAK) ** 2 : (1 - u) / (1 - SWELL_PEAK);
      for (const k of partials) s += Math.sin(2 * Math.PI * k * f0 * t) / k;
      s *= env;
    } else {
      const attack = Math.min(1, t / ATTACK_SEC);
      for (const k of partials) s += (Math.sin(2 * Math.PI * k * f0 * t) / k) * Math.exp((-t * k) / DECAY_SEC);
      s *= attack;
    }
    out[start + i] += amp * fade * s;
  }
}

/** One-pole low-pass coefficient for a cutoff in Hz. */
const onePole = (hz: number, rate: number) => 1 - Math.exp((-2 * Math.PI * hz) / rate);

/** The three drums, rendered once per song from the seed, so every hit of a drum is the same sound. */
function drumKit(rate: number, rand: () => number): Record<Hit["drum"], Float64Array> {
  const burst = (sec: number, fn: (t: number, white: number) => number) => {
    const b = new Float64Array(Math.round(sec * rate));
    for (let i = 0; i < b.length; i++) b[i] = fn(i / rate, 2 * rand() - 1);
    const peak = b.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-12);
    return b.map((v) => v / peak);
  };
  // kick: a falling sine plus low-passed noise, below ~150 Hz
  let lp = 0;
  let phase = 0;
  const aK = onePole(120, rate);
  const kick = burst(0.2, (t, w) => {
    lp += aK * (w - lp);
    phase += (2 * Math.PI * (45 + 70 * Math.exp(-t / 0.03))) / rate;
    return (Math.sin(phase) + 2 * lp) * Math.exp(-t / 0.06);
  });
  // snare: band-passed noise, ~200 Hz to 2 kHz
  let lo1 = 0;
  let lo2 = 0;
  const aHi = onePole(2000, rate);
  const aLo = onePole(200, rate);
  const snare = burst(0.15, (t, w) => {
    lo1 += aHi * (w - lo1); // low-pass at 2 kHz
    lo2 += aLo * (lo1 - lo2); // minus its own low-pass at 200 Hz: a band-pass
    return (lo1 - lo2) * Math.exp(-t / 0.05);
  });
  // hat: high-passed noise, above ~3 kHz (two one-pole high-passes)
  let h1 = 0;
  let h2 = 0;
  const aH = onePole(3000, rate);
  const hat = burst(0.06, (t, w) => {
    h1 += aH * (w - h1);
    const x1 = w - h1;
    h2 += aH * (x1 - h2);
    return (x1 - h2) * Math.exp(-t / 0.015);
  });
  return { kick: kick.map((v) => 0.5 * v), snare: snare.map((v) => 0.4 * v), hat: hat.map((v) => 0.2 * v) };
}

/** Pink-ish noise (Paul Kellet's economy filter on white noise), scaled to an exact RMS. */
function pinkNoise(n: number, rmsDb: number, rand: () => number): Float64Array {
  const out = new Float64Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 2 * rand() - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  const rms = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / Math.max(1, n)) || 1;
  const k = 10 ** (rmsDb / 20) / rms;
  return out.map((v) => v * k);
}

/**
 * Renders a song to mono at `rate` (default 11025). downbeats and beats are the TRUE ones, in seconds; tests that need
 * allin1-like mistakes edit them. Notes and drum tails may ring past their bar's end; they are cut at the song's end.
 */
export function renderSong(s: SynthSong): { x: Float32Array; rate: number; downbeats: number[]; beats: number[] } {
  const rate = s.rate ?? DEFAULT_RATE;
  const beatSec = 60 / s.bpm;
  const downbeats: number[] = [];
  const beats: number[] = [];
  let t = 0;
  for (const bar of s.bars) {
    downbeats.push(t);
    const n = bar.beats ?? 4;
    for (let b = 0; b < n; b++) beats.push(t + b * beatSec);
    t += n * beatSec;
  }
  const out = new Float64Array(Math.round(t * rate));
  const rand = rng(s.seed ?? 1);
  const kit = drumKit(rate, rand);
  s.bars.forEach((bar, i) => {
    const gain = 10 ** ((bar.gainDb ?? 0) / 20);
    for (const note of bar.notes ?? []) {
      addNote(out, rate, Math.round((downbeats[i] + note.at * beatSec) * rate), note, beatSec, gain, bar.swell ?? false);
    }
    for (const hit of bar.hits ?? []) {
      const start = Math.round((downbeats[i] + hit.at * beatSec) * rate);
      const b = kit[hit.drum];
      for (let j = 0; j < b.length && start + j < out.length; j++) out[start + j] += gain * b[j];
    }
  });
  if (s.noiseDb !== undefined) {
    const noise = pinkNoise(out.length, s.noiseDb, rand);
    for (let i = 0; i < out.length; i++) out[i] += noise[i];
  }
  return { x: Float32Array.from(out), rate, downbeats, beats };
}
