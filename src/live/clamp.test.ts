import { describe, expect, it } from "vitest";
import type { Section } from "../core/types.js";
import type { ClipInfo } from "./acquire.js";
import { arrangementOps } from "./arrangementOps.js";
import { sliceEdges, sliceGeometry } from "./clamp.js";
import { sessionOps, type SessionOp } from "./sessionOps.js";

const makeInfo = (over: Partial<ClipInfo>): ClipInfo =>
  ({
    view: "arrangement",
    clip: {},
    track: {},
    sceneIndex: 1,
    startTime: 0,
    lengthBeats: 0,
    startMarker: 0,
    endMarker: 0,
    warped: true,
    filePath: "/samples/a.wav",
    color: 0,
    name: "x",
    ...over,
  }) as unknown as ClipInfo;

/** Small deterministic PRNG (mulberry32) so the property tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toSections = (boundariesSec: number[]): Section[] =>
  boundariesSec.slice(0, -1).map((start, i) => ({ start, end: boundariesSec[i + 1], label: `Cue ${i + 1}`, color: 1 }));

describe("shared slice edges (Inner City Life, logged in Live)", () => {
  // Beat boundaries at 120 BPM: seconds = beats / 2, exactly.
  const beats = [
    0, 20, 42.337591552734374, 60.0920654296875, 90, 120, 150, 170, 190, 213.7365509033203, 230.12529602050782, 280,
    316.81265271187146,
  ];
  const info = makeInfo({ startTime: 128, lengthBeats: 316.81265271187146, startMarker: 0, endMarker: 316.81265271187146 });
  const sections = toSections(beats.map((b) => b / 2));
  const edges = sliceEdges(info, sections, 120);

  it("times run from the clip start to the clip end; interior times are non-decreasing", () => {
    expect(edges.times).toHaveLength(13);
    expect(edges.times[0]).toBe(128);
    expect(edges.times[12]).toBe(128 + 316.81265271187146);
    expect(edges.times[2]).toBe(170.33759155273438);
    for (let i = 0; i < 12; i++) expect(edges.times[i + 1]).toBeGreaterThanOrEqual(edges.times[i]);
  });

  it("arrangement splits are exactly the interior shared edge times", () => {
    const splits = arrangementOps(info, sections, "split", 120)
      .filter((o) => o.kind === "split")
      .map((o) => (o as { time: number }).time);
    expect(splits).toEqual(edges.times.slice(1, -1));
  });

  it("markers meet bit for bit and span the source markers", () => {
    expect(edges.markers[0]).toBe(0);
    expect(edges.markers[12]).toBe(316.81265271187146);
    const geo = sliceGeometry(info, sections, 120);
    for (let i = 0; i < geo.length - 1; i++) expect(geo[i].endMarker).toBe(geo[i + 1].startMarker);
  });

  it("clamps edges that overshoot the clip (rendered audio ran a few samples long)", () => {
    const live = makeInfo({ startTime: 4, lengthBeats: 64, startMarker: 0, endMarker: 64 });
    const overshoot = toSections([0, 10, 20, 32.00000645885468]);
    const e = sliceEdges(live, overshoot, 120);
    expect(e.times[3]).toBe(68);
    expect(e.markers[3]).toBe(64);
  });
});

describe("shared-edge invariants over random boundary sets (seeded)", () => {
  const cases: Array<{ name: string; warped: boolean; tempo: number }> = [
    { name: "warped @120", warped: true, tempo: 120 },
    { name: "warped @97.3", warped: true, tempo: 97.3 },
    { name: "unwarped @133.37", warped: false, tempo: 133.37 },
  ];

  for (const { name, warped, tempo } of cases) {
    it(`session: ${name} (slices share marker edges)`, () => {
      const rand = rng(0xbeef);
      for (let trial = 0; trial < 400; trial++) {
        const n = 2 + Math.floor(rand() * 14);
        const edgesSec = [0];
        for (let k = 0; k < n; k++) edgesSec.push(edgesSec[k] + 1 + rand() * 40);
        const startMarker = rand() * 50;
        const markerLen = warped ? (edgesSec[n] * tempo) / 60 : edgesSec[n];
        const info = makeInfo({ view: "session", sceneIndex: 0, startMarker, endMarker: startMarker + markerLen, warped });
        const clips = sessionOps(info, toSections(edgesSec), tempo).filter(
          (o): o is Extract<SessionOp, { kind: "slotClip" }> => o.kind === "slotClip",
        );
        expect(clips).toHaveLength(n);
        for (let i = 0; i < n - 1; i++) expect(clips[i].loop.endMarker).toBe(clips[i + 1].loop.startMarker);
        expect(clips[0].loop.startMarker).toBe(startMarker);
        expect(clips[n - 1].loop.endMarker).toBe(info.endMarker);
      }
    });
  }
});

describe("session marker span", () => {
  const sections: Section[] = toSections([0, 10, 20, 30]);

  it("session slices are unaffected: the last marker is still info.endMarker", () => {
    const info = makeInfo({ view: "session", sceneIndex: 0, startMarker: 4, endMarker: 34, warped: false, lengthBeats: 60 });
    const clips = sessionOps(info, sections, 120).filter((o): o is Extract<SessionOp, { kind: "slotClip" }> => o.kind === "slotClip");
    expect(clips[2].loop.endMarker).toBe(34);
  });
});
