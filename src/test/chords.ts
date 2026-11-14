// Synthetic harmony for the key detector's tests (v2): chord progressions of harmonic tones over a bass, in known keys.

/** Note name to pitch class ("C" 0 … "B" 11; "#" and "b" accidentals). */
export function pc(name: string): number {
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[name[0] as "C"]!;
  const acc = name.slice(1).split("").reduce((a, c) => a + (c === "#" ? 1 : c === "b" ? -1 : 0), 0);
  return (((base + acc) % 12) + 12) % 12;
}

/** A chord symbol's root and pitch classes: "C", "Am", "E7", "Dm7", "Bb", "F#m", "Gsus4", "Cmaj7". */
export function chordNotes(symbol: string): { root: number; pcs: number[] } {
  const m = /^([A-G][#b]?)(.*)$/.exec(symbol);
  if (!m) throw new Error(`bad chord ${symbol}`);
  const root = pc(m[1]);
  const q = m[2];
  const iv =
    q === "" ? [0, 4, 7]
    : q === "m" ? [0, 3, 7]
    : q === "7" ? [0, 4, 7, 10]
    : q === "m7" ? [0, 3, 7, 10]
    : q === "maj7" ? [0, 4, 7, 11]
    : q === "sus4" ? [0, 5, 7]
    : q === "dim" ? [0, 3, 6]
    : null;
  if (!iv) throw new Error(`bad chord quality ${symbol}`);
  return { root, pcs: iv.map((i) => (root + i) % 12) };
}

export interface ProgressionOptions {
  rate?: number;
  /** Seconds per chord. */
  chordSec?: number;
  /** Times the progression is played. */
  repeats?: number;
  /** White noise level (a crude drum kit's hiss), 0 for none. */
  noise?: number;
  seed?: number;
  /** Tuning in cents from A = 440 Hz (every tone and its harmonics moved by it). */
  cents?: number;
}

/**
 * Mono audio of `chords` played in turn: each chord's tones in the octave from C4 up, plus its root as a bass note
 * in octave 2, every tone with 6 harmonics at 1/h and a gentle decay. Deterministic.
 */
export function progression(chords: string[], o: ProgressionOptions = {}): { x: Float32Array; rate: number } {
  const rate = o.rate ?? 11025;
  const chordSec = o.chordSec ?? 2;
  const repeats = o.repeats ?? 2;
  const n = Math.round(chords.length * repeats * chordSec * rate);
  const x = new Float32Array(n);
  const per = Math.round(chordSec * rate);
  const rand = whiteNoise(o.seed ?? 1);
  for (let c = 0; c < chords.length * repeats; c++) {
    const { root, pcs } = chordNotes(chords[c % chords.length]);
    const tune = 2 ** ((o.cents ?? 0) / 1200);
    const freqs = [...pcs.map((p) => 261.63 * tune * 2 ** (p / 12)), 65.41 * tune * 2 ** (root / 12)];
    const start = c * per;
    for (const [i, f] of freqs.entries()) {
      const amp = i === freqs.length - 1 ? 0.18 : 0.1;
      for (let h = 1; h <= 6; h++) {
        if (f * h > rate / 2 - 100) break;
        const w = (2 * Math.PI * f * h) / rate;
        for (let j = 0; j < per && start + j < n; j++) x[start + j] += (amp / h) * Math.exp(-j / rate / 1.5) * Math.sin(w * j);
      }
    }
  }
  if (o.noise) for (let i = 0; i < n; i++) x[i] += o.noise * rand();
  return { x, rate };
}

/**
 * Deterministic white noise in [-1, 1) (mulberry32). Not a plain LCG: its low bits repeat with short periods, and that
 * noise has tonal peaks the key detector rightly hears.
 */
export function whiteNoise(seed = 1): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * 2 - 1;
  };
}

/** Concatenates signals at the same rate. */
export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
