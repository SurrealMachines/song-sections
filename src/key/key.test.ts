import { describe, expect, it } from "vitest";
import type { Harmony } from "../dialog/protocol.js";
import { concat, progression, whiteNoise } from "../test/chords.js";
import { estimateTuning, fineChroma, harmonicChroma, HARMONY_RATE } from "./chroma.js";
import { mixHarmony } from "./harmony.js";
import {
  clipKey,
  estimateKey,
  KK_MAJOR,
  KK_MINOR,
  keyLong,
  keyShort,
  MIN_FIT,
  MIN_SURE_SEC,
  sectionKeys,
  setScaleName,
  spanKey,
  SURE_MARGIN,
  withHarmonics,
  type KeyEstimate,
} from "./key.js";

const plain = (k: KeyEstimate | null) => (k ? keyLong({ tonic: k.tonic, minor: k.minor }) : null);

async function keyOf(chords: string[], noise = 0.03): Promise<KeyEstimate> {
  const { x, rate } = progression(chords, { noise });
  return clipKey(await mixHarmony(x, rate))!;
}

describe("key names", () => {
  it("spells the 24 keys by convention, long with ♭ ♯ and short in ASCII", () => {
    const major = Array.from({ length: 12 }, (_, t) => keyLong({ tonic: t, minor: false }));
    const minor = Array.from({ length: 12 }, (_, t) => keyLong({ tonic: t, minor: true }));
    expect(major).toEqual(["C major", "D♭ major", "D major", "E♭ major", "E major", "F major", "F♯ major", "G major", "A♭ major", "A major", "B♭ major", "B major"]);
    expect(minor).toEqual(["C minor", "C♯ minor", "D minor", "E♭ minor", "E minor", "F minor", "F♯ minor", "G minor", "G♯ minor", "A minor", "B♭ minor", "B minor"]);
    expect(Array.from({ length: 12 }, (_, t) => keyShort({ tonic: t, minor: false }))).toEqual(["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]);
    expect(Array.from({ length: 12 }, (_, t) => keyShort({ tonic: t, minor: true }))).toEqual(["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]);
  });

  it("marks a key it is not sure of in the dialog's form only", () => {
    const unsure: KeyEstimate = { tonic: 2, minor: true, score: 0.7, margin: 0.01, sure: false };
    const sure: KeyEstimate = { ...unsure, margin: 0.3, sure: true };
    expect(keyLong(unsure)).toBe("D minor?");
    expect(keyLong(sure)).toBe("D minor");
    expect(keyShort(unsure)).toBe("Dm");
  });

  it("names the Set's scale with the key's spelling", () => {
    expect(setScaleName(2, "Minor")).toBe("D Minor");
    expect(setScaleName(10, "Major")).toBe("B♭ Major");
    expect(setScaleName(6, "Dorian")).toBe("F♯ Dorian");
    expect(setScaleName(1, "Minor")).toBe("C♯ Minor");
  });
});

describe("estimateKey", () => {
  it("finds every key from its own profile, sure of it", () => {
    for (const minor of [false, true]) {
      for (let t = 0; t < 12; t++) {
        const p = withHarmonics(minor ? KK_MINOR : KK_MAJOR);
        const v = Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
        const k = estimateKey(v)!;
        expect([k.tonic, k.minor]).toEqual([t, minor]);
        expect(k.score).toBeCloseTo(1, 9);
        expect(k.sure).toBe(true);
      }
    }
  });

  it("is not sure of a key that fits poorly, however clear its margin (MIN_FIT)", () => {
    // G minor with a loud C♯ (outside the key) on top: still G minor, well clear of the rest, but a weak fit.
    const p = withHarmonics(KK_MINOR);
    const v = Array.from({ length: 12 }, (_, i) => p[(i - 7 + 12) % 12] + (i === 1 ? 10 : 0));
    const k = estimateKey(v)!;
    expect(plain(k)).toBe("G minor");
    expect(k.margin).toBeGreaterThanOrEqual(SURE_MARGIN);
    expect(k.score).toBeLessThan(MIN_FIT);
    expect(k.sure).toBe(false);
    expect(keyLong(k)).toBe("G minor?");
  });

  it("has no key for a vector with no shape", () => {
    expect(estimateKey(new Array(12).fill(0))).toBeNull();
    expect(estimateKey(new Array(12).fill(3))).toBeNull();
  });

  it("does not count the relative key against the margin", () => {
    // C major's and A minor's notes are the same; a chroma of just the white keys scores both well.
    const white = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
    const k = estimateKey(white)!;
    expect(["C major", "A minor"]).toContain(plain(k));
    expect(k.sure).toBe(true);
  });
});

describe("keys of synthetic progressions", () => {
  it.each([
    ["C major", ["C", "F", "G", "C"]],
    ["C major", ["C", "Am", "F", "G"]],
    ["E major", ["E", "B", "C#m", "A"]],
    ["B♭ major", ["Bb", "Eb", "F7", "Bb"]],
    ["E♭ major", ["Fm7", "Bb7", "Ebmaj7", "Ebmaj7"]],
    ["A major", ["A7", "D7", "A7", "E7"]],
    ["A minor", ["Am", "Dm", "E", "Am"]],
    ["A minor", ["Am", "Dm", "Em", "Am"]],
    ["F♯ minor", ["F#m", "Bm", "C#7", "F#m"]],
    ["G minor", ["Gm", "Cm", "D7", "Gm"]],
  ])("%s from %j, sure", async (want, chords) => {
    const k = await keyOf(chords as string[]);
    expect(plain(k)).toBe(want);
    expect(k.margin).toBeGreaterThanOrEqual(SURE_MARGIN);
    expect(k.score).toBeGreaterThanOrEqual(MIN_FIT);
    expect(k.sure).toBe(true);
  });

  it("the relative-key case (vi–IV–I–V) gives C major or A minor, sure, as the relative is not a rival", async () => {
    const k = await keyOf(["Am", "F", "C", "G"]);
    expect(["C major", "A minor"]).toContain(plain(k));
    expect(k.sure).toBe(true);
  });

  it("a mixolydian vamp (D–C–G–D) is D or G, and not sure", async () => {
    const k = await keyOf(["D", "C", "G", "D"]);
    expect(["D major", "G major"]).toContain(plain(k));
    expect(k.sure).toBe(false);
    expect(keyLong(k)).toMatch(/\?$/);
  });

  it("a dorian vamp (Dm7–G) gives its parent scale, G major, or D minor", async () => {
    expect(["G major", "D minor"]).toContain(plain(await keyOf(["Dm7", "G"])));
  });

  it("a natural-minor loop that a major key shares (Am–G–F–G) is not sure", async () => {
    expect((await keyOf(["Am", "G", "F", "G"])).sure).toBe(false);
  });

  it("noise holds the key with it", async () => {
    expect(plain(await keyOf(["Bb", "Eb", "F7", "Bb"], 0.1))).toBe("B♭ major");
  });
});

describe("spanKey and sectionKeys", () => {
  // 16 s of C major (I–IV–V–I twice), then 16 s of E♭ major, then 8 s of silence.
  const c = progression(["C", "F", "G", "C"]);
  const eb = progression(["Eb", "Ab", "Bb7", "Eb"]);
  let harmony: Harmony;
  const ready = (async () => {
    harmony = await mixHarmony(concat(c.x, eb.x, new Float32Array(8 * c.rate)), c.rate);
  })();

  it("keys each section from its own span, and a moved boundary moves the key", async () => {
    await ready;
    expect(harmony.chroma).toHaveLength(40 * HARMONY_RATE);
    const ks = sectionKeys(harmony, [
      { start: 0, end: 16 },
      { start: 16, end: 32 },
      { start: 32, end: 40 },
    ]);
    expect(ks.map(plain)).toEqual(["C major", "E♭ major", null]);
    // Most of a section in E♭ is E♭, wherever its edges fall between frames.
    expect(plain(spanKey(harmony, 13.25, 31.75))).toBe("E♭ major");
    expect(plain(spanKey(harmony, 0.25, 18.75))).toBe("C major");
  });

  it("review I1: a span under MIN_SURE_SEC is a chord, not a key: shown, never sure", async () => {
    // C–F–G–C, 2 s a chord, twice.
    const { x, rate } = progression(["C", "F", "G", "C"]);
    const h = await mixHarmony(x, rate);
    const f = spanKey(h, 2, 4)!; // the F chord alone
    expect(plain(f)).toBe("F major");
    expect(f.margin).toBeGreaterThanOrEqual(SURE_MARGIN);
    expect(f.score).toBeGreaterThanOrEqual(MIN_FIT);
    expect(f.sure).toBe(false);
    expect(keyLong(f)).toBe("F major?");
    expect(spanKey(h, 0, 0.5)!.sure).toBe(false); // one frame
    expect(spanKey(h, 0, MIN_SURE_SEC - 0.25)!.sure).toBe(false);
    const whole = spanKey(h, 0, 16)!;
    expect([plain(whole), whole.sure]).toEqual(["C major", true]);
  });

  it("has no key for a span of silence or none at all, nor without a harmony", async () => {
    await ready;
    expect(spanKey(harmony, 33, 39)).toBeNull();
    expect(spanKey(harmony, 10, 10)).toBeNull();
    expect(spanKey(harmony, 50, 60)).toBeNull();
    expect(sectionKeys(null, [{ start: 0, end: 1 }])).toEqual([null]);
    expect(clipKey(undefined)).toBeNull();
  });

  it("has no key in a clip of noise alone, loud or quiet", async () => {
    for (const level of [0.5, 0.1, 0.001]) {
      const rand = whiteNoise(7);
      const x = Float32Array.from({ length: 11025 * 10 }, () => level * rand());
      expect(clipKey(await mixHarmony(x, 11025))).toBeNull();
    }
  });

  it("review I2: a quiet clip keys as a loud one (its level is brought to REF_RMS before compression)", async () => {
    const { x, rate } = progression(["C", "F", "G", "C"]);
    const loud = await mixHarmony(x, rate);
    for (const db of [-40, -60, 12]) {
      const g = 10 ** (db / 20);
      const quiet = await mixHarmony(x.map((v) => v * g), rate);
      const k = clipKey(quiet)!;
      expect([plain(k), k.sure]).toEqual(["C major", true]);
      // The same chroma, but for float rounding (at -60 dB the gain is held at its +60 dB bound, so near it only).
      quiet.chroma.forEach((row, f) => row.forEach((v, i) => expect(v).toBeCloseTo(loud.chroma[f][i], db === -60 ? 1 : 3)));
    }
  });
});

describe("tuning (review M1)", () => {
  it("finds the clip's tuning and keys detuned material as in tune: -40 cents, +30, A = 432 Hz", async () => {
    for (const cents of [-40, 30, 1200 * Math.log2(432 / 440), 0]) {
      for (const [chords, want] of [
        [["C", "F", "G", "C"], "C major"],
        [["Am", "Dm", "E", "Am"], "A minor"],
      ] as const) {
        const { x, rate } = progression([...chords], { cents, noise: 0.03 });
        const h = await mixHarmony(x, rate);
        expect(Math.abs(h.tuningCents! - cents)).toBeLessThanOrEqual(6);
        const k = clipKey(h)!;
        expect([plain(k), k.sure]).toEqual([want, true]);
      }
    }
  });

  it("is 0 for nothing, and stays within half a semitone", async () => {
    expect(estimateTuning(new Float64Array(120))).toBe(0);
    const { x, rate } = progression(["C", "G"], { cents: 49 });
    const t = estimateTuning(await fineChroma(x, rate));
    expect(t).toBeGreaterThanOrEqual(-0.5);
    expect(t).toBeLessThan(0.5);
  });
});

describe("harmonicChroma", () => {
  it("puts a tone's energy on its pitch class, in the frames it sounds in", async () => {
    const rate = 11025;
    const x = new Float32Array(rate * 4);
    for (let i = rate; i < 3 * rate; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate); // A4 from 1 s to 3 s
    const c = await harmonicChroma(x, rate);
    expect(c.length).toBe(4 * HARMONY_RATE * 12);
    const frame = (f: number) => Array.from(c.subarray(f * 12, f * 12 + 12));
    const mid = frame(4);
    expect(mid.indexOf(Math.max(...mid))).toBe(9); // A
    expect(mid[9]).toBeGreaterThan(10 * Math.max(...mid.filter((_, i) => i !== 9)));
    expect(Math.max(...frame(0))).toBe(0);
    expect(Math.max(...frame(7))).toBe(0);
  });

  it("gives nothing for nothing", async () => {
    expect((await harmonicChroma(new Float32Array(0), 11025)).length).toBe(0);
  });
});
