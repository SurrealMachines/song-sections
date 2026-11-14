import { describe, expect, it } from "vitest";
import type { Section } from "../core/types.js";
import type { ClipInfo } from "./acquire.js";
import { arrangementOps, type ArrangementOp } from "./arrangementOps.js";
import { sliceEdges } from "./clamp.js";

const sections: Section[] = [
  { start: 0, end: 10, label: "Cue 1", color: 0xff0000 },
  { start: 10, end: 30, label: "Cue 2", color: 0x00ff00 },
];

const info = (over: Partial<ClipInfo> = {}): ClipInfo =>
  ({
    view: "arrangement",
    clip: {},
    track: {},
    startTime: 32,
    lengthBeats: 60,
    startMarker: 4,
    endMarker: 64,
    warped: true,
    filePath: "/samples/a.wav",
    color: 0,
    name: "x",
    ...over,
  }) as unknown as ClipInfo;

const splitOps: ArrangementOp[] = [
  { kind: "split", time: 52 },
  { kind: "label", name: "Cue 1", color: 0xff0000 },
  { kind: "label", name: "Cue 2", color: 0x00ff00 },
];
const cueOps: ArrangementOp[] = [
  { kind: "cue", time: 32, name: "Cue 1" },
  { kind: "cue", time: 52, name: "Cue 2" },
];

const splits = (ops: ArrangementOp[]) =>
  ops.filter((o): o is Extract<ArrangementOp, { kind: "split" }> => o.kind === "split").map((o) => o.time);
const labels = (ops: ArrangementOp[]) =>
  ops.filter((o): o is Extract<ArrangementOp, { kind: "label" }> => o.kind === "label");

const toSections = (boundariesSec: number[]): Section[] =>
  boundariesSec.slice(0, -1).map((start, i) => ({ start, end: boundariesSec[i + 1], label: `Cue ${i + 1}`, color: 1 }));

describe("arrangementOps", () => {
  it("split: one split per interior boundary (beats), then one label per section", () => {
    expect(arrangementOps(info(), sections, "split", 120)).toEqual(splitOps);
  });

  it("locators: one cue per section start, no splits or labels", () => {
    expect(arrangementOps(info(), sections, "locators", 120)).toEqual(cueOps);
  });

  it("both: splits, then labels, then cues", () => {
    expect(arrangementOps(info(), sections, "both", 120)).toEqual([...splitOps, ...cueOps]);
  });

  it("warped or not, split positions are beats and identical", () => {
    const a = arrangementOps(info({ warped: false, startMarker: 4, endMarker: 34 }), sections, "split", 120);
    expect(a).toEqual(splitOps);
  });

  it("never emits create-style ops or marker data", () => {
    const kinds = new Set(arrangementOps(info(), sections, "both", 120).map((o) => o.kind));
    expect([...kinds].sort()).toEqual(["cue", "label", "split"]);
  });

  it("a single section needs no split, just one label", () => {
    const ops = arrangementOps(info(), [sections[0]], "split", 120);
    expect(ops).toEqual([{ kind: "label", name: "Cue 1", color: 0xff0000 }]);
  });

  it("keeps a cue inside the span", () => {
    const live = info({ startTime: 4, lengthBeats: 64, startMarker: 0, endMarker: 64 });
    const ops = arrangementOps(live, [{ start: 40, end: 50, label: "Z", color: 1 }], "locators", 120);
    expect(ops).toEqual([{ kind: "cue", time: 68, name: "Z" }]);
  });
});

describe("split times are the shared slice edges", () => {
  // Inner City Life boundaries, logged in Live; seconds = beats / 2 at 120 BPM.
  const beats = [
    0, 20, 42.337591552734374, 60.0920654296875, 90, 120, 150, 170, 190, 213.7365509033203, 230.12529602050782, 280,
    316.81265271187146,
  ];
  const i = info({ startTime: 128, lengthBeats: 316.81265271187146, startMarker: 0, endMarker: 316.81265271187146 });
  const secs = toSections(beats.map((b) => b / 2));

  it("equals sliceEdges(...).times[1..n-1] bit for bit", () => {
    const ops = arrangementOps(i, secs, "split", 120);
    expect(splits(ops)).toEqual(sliceEdges(i, secs, 120).times.slice(1, -1));
    expect(splits(ops)).toHaveLength(11);
    expect(splits(ops)[1]).toBe(170.33759155273438);
    expect(labels(ops).map((l) => l.name)).toEqual(secs.map((s) => s.label));
  });

  it("splits ascend strictly and lie strictly inside the clip (seeded random sets)", () => {
    let a = 0xc0ffee;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 14);
      const edges = [0];
      for (let k = 0; k < n; k++) edges.push(edges[k] + 1 + rand() * 40);
      const startTime = rand() * 600;
      const lengthBeats = edges[n] * 2;
      const clip = info({ startTime, lengthBeats });
      const sec = toSections(edges);
      sec[n - 1].end += rand() < 0.3 ? 6.4e-6 : 0;
      const ops = arrangementOps(clip, sec, "split", 120);
      const s = splits(ops);
      expect(labels(ops)).toHaveLength(s.length + 1);
      expect(s).toHaveLength(n - 1);
      for (let k = 0; k < s.length; k++) {
        expect(s[k]).toBeGreaterThan(startTime);
        expect(s[k]).toBeLessThan(startTime + lengthBeats);
        if (k > 0) expect(s[k]).toBeGreaterThan(s[k - 1]);
      }
    }
  });
});

describe("dropped edges (out of span / coincident)", () => {
  // 60-beat clip at 32..92, 120 BPM: second -> 2 beats.
  const mk = (starts: number[]): Section[] => starts.map((start, i) => ({ start, end: start + 1, label: `S${i}`, color: i }));

  it("edges past the end are clamped to the end and dropped; the zero-length trailing sections lose their labels", () => {
    // S2 and S3 start at/after the clip end (30 s = 60 beats).
    const ops = arrangementOps(info(), mk([0, 10, 30, 40]), "split", 120);
    expect(splits(ops)).toEqual([52]);
    expect(labels(ops).map((l) => l.name)).toEqual(["S0", "S1"]);
  });

  it("coincident edges merge: the zero-length section loses its label, the next one covers the piece", () => {
    const ops = arrangementOps(info(), mk([0, 10, 10, 20]), "split", 120);
    expect(splits(ops)).toEqual([52, 72]);
    expect(labels(ops).map((l) => l.name)).toEqual(["S0", "S2", "S3"]);
  });

  it("a second section starting at the clip start (edge == startTime) is dropped", () => {
    const ops = arrangementOps(info(), mk([0, 0, 10]), "split", 120);
    expect(splits(ops)).toEqual([52]);
    expect(labels(ops).map((l) => l.name)).toEqual(["S1", "S2"]);
  });

  it("edges within 1e-9 of the previous one are treated as coincident", () => {
    const ops = arrangementOps(info(), mk([0, 10, 10 + 1e-12]), "split", 120);
    expect(splits(ops)).toHaveLength(1);
    expect(splits(ops)[0]).toBeCloseTo(52, 9);
    expect(labels(ops).map((l) => l.name)).toEqual(["S0", "S2"]);
  });

  it("label count is always split count + 1 for any section set", () => {
    const cases = [[0], [0, 0], [0, 5, 5, 5], [0, 100, 200], [0, 10, 30], [0, 1e-12, 15]];
    for (const c of cases) {
      const ops = arrangementOps(info(), mk(c), "split", 120);
      expect(labels(ops).length).toBe(splits(ops).length + 1);
      const both = arrangementOps(info(), mk(c), "both", 120);
      // one locator per kept section: dropped sections get none
      expect(both.length).toBe(splits(ops).length + 2 * labels(ops).length);
    }
  });

  it("both: no locator for a dropped section", () => {
    const ops = arrangementOps(info(), mk([0, 10, 10, 20, 40]), "both", 120);
    expect(ops.filter((o) => o.kind === "cue")).toEqual([
      { kind: "cue", time: 32, name: "S0" },
      { kind: "cue", time: 52, name: "S2" },
      { kind: "cue", time: 72, name: "S3" },
    ]);
  });

  it("a section shorter than the shared tolerance is dropped", () => {
    // 4e-7 s at 120 BPM = 8e-7 beats, below MIN_PIECE_BEATS (1e-6).
    const ops = arrangementOps(info(), mk([0, 10, 10 + 4e-7, 20]), "split", 120);
    expect(labels(ops).map((l) => l.name)).toEqual(["S0", "S2", "S3"]);
    expect(splits(ops)).toHaveLength(2);
    // a section just over the tolerance survives
    const kept = arrangementOps(info(), mk([0, 10, 10 + 1e-5, 20]), "split", 120);
    expect(labels(kept)).toHaveLength(4);
  });

  it("no sections: no ops", () => {
    expect(arrangementOps(info(), [], "split", 120)).toEqual([]);
  });
});

describe("arrangementOps marker keys (v2)", () => {
  it("names each locator `<label> · <key>`, a null key leaves the label plain, and the pieces stay plain", () => {
    const ops = arrangementOps(info(), sections, "both", 120, ["Dm", null]);
    expect(ops.filter((o) => o.kind === "cue").map((o) => (o as { name: string }).name)).toEqual(["Cue 1 · Dm", "Cue 2"]);
    expect(labels(ops).map((o) => o.name)).toEqual(["Cue 1", "Cue 2"]);
  });
  it("locators alone carry the keys too; no keys means plain names", () => {
    expect(arrangementOps(info(), sections, "locators", 120, ["F#", "Bbm"])).toEqual([
      { kind: "cue", time: 32, name: "Cue 1 · F#" },
      { kind: "cue", time: 52, name: "Cue 2 · Bbm" },
    ]);
    expect(arrangementOps(info(), sections, "locators", 120)).toEqual(cueOps);
  });
});

describe("arrangementOps with pieces (Plan 6: Slice by)", () => {
  const verseChorus: Section[] = [
    { start: 0, end: 10, label: "A - verse", color: 1 },
    { start: 10, end: 20, label: "B - chorus", color: 2 },
    { start: 20, end: 30, label: "A - verse", color: 1 },
  ];
  const pieces: Section[] = [
    { start: 0, end: 4, label: "drums 1", color: 0x110000 },
    { start: 4, end: 10, label: "drums 2", color: 0x220000 },
    { start: 10, end: 16, label: "drums 1", color: 0x110000 },
    { start: 16, end: 20, label: "drums 3", color: 0x330000 },
    { start: 20, end: 30, label: "drums 2′", color: 0x440000 },
  ];

  it("both: splits at the piece starts, labels with the piece names, then the locators at the section starts", () => {
    const ops = arrangementOps(info(), verseChorus, "both", 120, ["Dm", null, "Dm"], pieces);
    expect(ops).toEqual([
      { kind: "split", time: 40 },
      { kind: "split", time: 52 },
      { kind: "split", time: 64 },
      { kind: "split", time: 72 },
      ...pieces.map((p) => ({ kind: "label", name: p.label, color: p.color })),
      { kind: "cue", time: 32, name: "A - verse · Dm" },
      { kind: "cue", time: 52, name: "B - chorus" },
      { kind: "cue", time: 72, name: "A - verse · Dm" },
    ]);
  });

  it("split cuts at the pieces alone; locators ignore the pieces", () => {
    const split = arrangementOps(info(), verseChorus, "split", 120, undefined, pieces);
    expect(split.filter((o) => o.kind === "cue")).toEqual([]);
    expect(splits(split)).toEqual([40, 52, 64, 72]);
    expect(arrangementOps(info(), verseChorus, "locators", 120, undefined, pieces)).toEqual(arrangementOps(info(), verseChorus, "locators", 120));
  });
});
