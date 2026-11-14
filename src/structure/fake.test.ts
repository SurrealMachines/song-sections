import { describe, expect, it } from "vitest";
import {
  ALLIN1_BAND_HZ,
  FEATURE_BANDS,
  FEATURE_RATE,
  FUNCTION_LABELS,
  PEAK_RATE,
  STEM_NAMES,
  STRUCTURE_ENGINE,
  estimateStructureSec,
  STRUCTURE_MAX_SEC,
  STRUCTURE_WARN_SEC,
} from "./contract.js";
import { fakeStructureAnalysis } from "./fake.js";

describe("fakeStructureAnalysis", () => {
  const a = fakeStructureAnalysis(180);

  it("has contiguous segments over [0, duration]", () => {
    expect(a.engine).toBe(STRUCTURE_ENGINE);
    expect(a.durationSec).toBe(180);
    expect(a.segments[0].start).toBe(0);
    expect(a.segments.at(-1)!.end).toBe(180);
    for (let i = 1; i < a.segments.length; i++) expect(a.segments[i].start).toBe(a.segments[i - 1].end);
    expect(a.segments.map((s) => s.label)).toEqual([
      "start", "intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro", "end",
    ]);
    expect(a.segments[0].end - a.segments[0].start).toBe(2);
    expect(a.segments.at(-1)!.end - a.segments.at(-1)!.start).toBe(2);
    const mid = a.segments.slice(1, -1).map((s) => s.end - s.start);
    for (const m of mid) expect(m).toBeCloseTo(mid[0], 9);
  });

  it("has every per-frame array at frames = ceil(duration * rate)", () => {
    expect(a.featureRate).toBe(FEATURE_RATE);
    expect(a.frames).toBe(360);
    expect(a.functionProbs).toHaveLength(360);
    expect(a.bandHz).toHaveLength(FEATURE_BANDS);
    for (const s of STEM_NAMES) {
      expect(a.stems[s].bands).toHaveLength(360);
      expect(a.stems[s].loudnessDb).toHaveLength(360);
      for (const row of a.stems[s].bands) expect(row).toHaveLength(81);
    }
  });

  it("has one-hot functionProbs that sum to 1", () => {
    for (let f = 0; f < a.frames; f++) {
      const row = a.functionProbs[f];
      expect(row).toHaveLength(FUNCTION_LABELS.length);
      expect(row.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      const seg = a.segments.find((s) => f / 2 >= s.start && f / 2 < s.end)!;
      expect(row[FUNCTION_LABELS.indexOf(seg.label)]).toBe(1);
    }
  });

  it("has 120 bpm beats from 2 s, every 4th a downbeat", () => {
    expect(a.bpm).toBe(120);
    expect(a.beats[0]).toBe(2);
    expect(a.beats[1]).toBeCloseTo(2.5, 9);
    expect(a.downbeats[0]).toBe(2);
    expect(a.downbeats[1]).toBeCloseTo(4, 9);
    expect(a.downbeats.length).toBe(Math.ceil(a.beats.length / 4));
    const set = new Set(a.beats);
    for (const d of a.downbeats) expect(set.has(d)).toBe(true);
    for (let i = 1; i < a.beats.length; i++) expect(a.beats[i]).toBeGreaterThan(a.beats[i - 1]);
    expect(a.beats.at(-1)!).toBeLessThan(180);
  });

  it("uses the real allin1 band centres (not a semitone grid)", () => {
    expect(ALLIN1_BAND_HZ).toHaveLength(81);
    expect(a.bandHz).toEqual([...ALLIN1_BAND_HZ]);
    expect(a.bandHz[0]).toBeCloseTo(43.066, 3); // one band per FFT bin at the bottom
    expect(a.bandHz[1] - a.bandHz[0]).toBeCloseTo(21.533, 3);
    expect(a.bandHz.at(-1)!).toBeCloseTo(15805.37, 2);
    for (let i = 1; i < 81; i++) expect(a.bandHz[i]).toBeGreaterThan(a.bandHz[i - 1]);
  });

  it("silences vocals in intro/outro/start/end and keeps other stems at -12 dB", () => {
    const at = (label: string, nth = 0) => a.segments.filter((s) => s.label === label)[nth];
    const frame = (s: { start: number; end: number }) => Math.floor(((s.start + s.end) / 2) * 2);
    for (const l of ["start", "intro", "outro", "end"]) {
      const f = frame(at(l));
      expect(a.stems.vocals.loudnessDb[f]).toBe(-90);
      expect(a.stems.vocals.bands[f].every((v) => v === 0)).toBe(true);
      expect(a.stems.bass.loudnessDb[f]).toBe(-12);
    }
    const fv = frame(at("verse"));
    expect(a.stems.vocals.loudnessDb[fv]).toBe(-12);
    expect(a.stems.drums.loudnessDb[fv]).toBe(-12);
  });

  it("builds pitch-class templates per function, with drums low-end only in choruses", () => {
    const seg = (l: string, n = 0) => a.segments.filter((s) => s.label === l)[n];
    const frameOf = (s: { start: number; end: number }) => Math.floor(((s.start + s.end) / 2) * 2);
    const pc = (i: number) => (((Math.round(12 * Math.log2(a.bandHz[i] / 440)) % 12) + 12) % 12);
    const verse = a.stems.other.bands[frameOf(seg("verse"))];
    a.bandHz.forEach((_, i) => expect(verse[i]).toBe(pc(i) === 2 ? 2 : 0.2));
    const chorus0 = a.stems.bass.bands[frameOf(seg("chorus", 0))];
    a.bandHz.forEach((_, i) => expect(chorus0[i]).toBe(pc(i) === 7 ? 2 : 0.2));
    // The last chorus has extra energy (1.0) at pitch class 0.
    const chorus2 = a.stems.vocals.bands[frameOf(seg("chorus", 2))];
    a.bandHz.forEach((_, i) => expect(chorus2[i]).toBe(pc(i) === 7 ? 2 : pc(i) === 0 ? 1 : 0.2));
    const dChorus = a.stems.drums.bands[frameOf(seg("chorus"))];
    const dVerse = a.stems.drums.bands[frameOf(seg("verse"))];
    a.bandHz.forEach((hz, i) => {
      expect(dVerse[i]).toBe(1);
      expect(dChorus[i]).toBe(hz < 200 ? 1.5 : 1);
    });
  });

  it("is deterministic, scales with duration and survives JSON", () => {
    expect(fakeStructureAnalysis(180)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    const b = fakeStructureAnalysis(60.3);
    expect(b.frames).toBe(Math.ceil(60.3 * 2));
    expect(b.segments.at(-1)!.end).toBe(60.3);
    expect(b.stems.drums.bands).toHaveLength(b.frames);
  });

  it("returns the short-clip shape below 12 s and rejects non-positive durations", () => {
    for (const d of [0.5, 3, 11.9]) {
      const b = fakeStructureAnalysis(d);
      expect(b.segments).toEqual([{ start: 0, end: d, label: "verse" }]);
      expect(b.beats).toEqual([]);
      expect(b.downbeats).toEqual([]);
      expect(b.bpm).toBeNull();
      expect(b.frames).toBe(Math.ceil(d * 2));
      expect(b.functionProbs).toHaveLength(b.frames);
      expect(b.stems.bass.bands).toHaveLength(b.frames);
    }
    expect(fakeStructureAnalysis(12).segments).toHaveLength(10);
    for (const d of [0, -1, NaN, Infinity]) expect(() => fakeStructureAnalysis(d)).toThrow(RangeError);
  });

  it("has boundary candidates: ascending, every segment start after the first as the same float, strengths 0..1", () => {
    const c = a.boundaryCandidates;
    expect(c.length).toBeGreaterThan(a.segments.length);
    for (let i = 1; i < c.length; i++) expect(c[i].time).toBeGreaterThan(c[i - 1].time);
    const times = new Set(c.map((x) => x.time));
    for (const seg of a.segments.slice(1)) expect(times.has(seg.start)).toBe(true);
    expect(c[0].time).toBeGreaterThan(0);
    expect(c.at(-1)!.time).toBeLessThan(180);
    for (const x of c) {
      expect(x.strength).toBeGreaterThanOrEqual(0.001);
      expect(x.strength).toBeLessThanOrEqual(1);
      expect(Math.round(x.strength * 10000) / 10000).toBe(x.strength);
    }
    // Shaped like the real engine's: many weak candidates (< 0.015) with tied strengths, some on downbeats and some
    // between them; one chosen boundary is weaker than some non-chosen ones (as Flim's 129.17 s one is).
    const chosen = new Set(a.segments.slice(1).map((s) => s.start));
    const weak = c.filter((x) => !chosen.has(x.time));
    expect(weak.length).toBeGreaterThan(3 * chosen.size);
    for (const x of weak) expect(x.strength).toBeLessThan(0.015);
    expect(new Set(weak.map((x) => x.strength)).size).toBeLessThan(weak.length);
    const onDownbeat = weak.filter((x) => a.downbeats.includes(x.time)).length;
    expect(onDownbeat).toBeGreaterThan(0);
    expect(onDownbeat).toBeLessThan(weak.length);
    const minChosen = Math.min(...c.filter((x) => chosen.has(x.time)).map((x) => x.strength));
    expect(minChosen).toBeLessThan(Math.max(...weak.map((x) => x.strength)));
    for (const x of weak) for (const t of chosen) expect(Math.abs(x.time - t)).toBeGreaterThanOrEqual(1);
    expect(fakeStructureAnalysis(7.3).boundaryCandidates).toEqual([]);
  });

  it("has a peak envelope per stem at PEAK_RATE, at or above the frame's RMS level, in [0, 1]", () => {
    for (const d of [180, 7.3]) {
      const x = fakeStructureAnalysis(d);
      for (const s of STEM_NAMES) {
        const p = x.stems[s].peak;
        expect(p).toHaveLength(Math.ceil(d * PEAK_RATE));
        p.forEach((v, b) => {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
          const rms = 10 ** (x.stems[s].loudnessDb[Math.floor(b / 10)] / 20);
          expect(v).toBeGreaterThanOrEqual(Math.floor(rms * 1000) / 1000);
        });
      }
    }
    expect(Math.max(...a.stems.vocals.peak.slice(0, 2 * PEAK_RATE))).toBe(0); // silent start
    expect(Math.max(...a.stems.drums.peak)).toBeGreaterThan(0.5);
  });

  it("defaults to 180 s", () => {
    expect(fakeStructureAnalysis().durationSec).toBe(180);
  });
});

describe("estimateStructureSec", () => {
  it("is the least-squares fit of Live-host wall times at 0.5-29.5 min (findings E11)", () => {
    expect(estimateStructureSec(0)).toBe(2);
    expect(estimateStructureSec(300)).toBe(114); // measured 108.1 s
    expect(estimateStructureSec(1200)).toBe(451); // measured 453.0 s
  });

  it("STRUCTURE_WARN_SEC is the length whose estimate is 3 minutes; STRUCTURE_MAX_SEC is 30 minutes (E10: peak <= 2.7 GB)", () => {
    expect(estimateStructureSec(STRUCTURE_WARN_SEC)).toBe(180);
    expect(estimateStructureSec(STRUCTURE_WARN_SEC + 3)).toBeGreaterThan(180);
    expect(STRUCTURE_MAX_SEC).toBe(1800);
  });
});
