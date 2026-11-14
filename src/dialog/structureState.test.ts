import * as fs from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MIN_SECTION_SEC } from "../core/sections.js";
import { sectionFunction } from "../grouping/labels.js";
import { GROUP_DIST_MAX, GROUP_DIST_MIN, groupSections } from "../grouping/letters.js";
import { sectionVectors } from "../grouping/sectionVectors.js";
import { CANDIDATE_FLOOR } from "../grouping/granularity.js";
import { snapBoundaries } from "../grouping/snap.js";
import { OTHER_COLORS, dim, groupColor, groupShades } from "../grouping/palette.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { PATTERN_LEVELS, type PatternFeatures } from "../patterns/contract.js";
import { createPatternEngine, sectionSpans } from "../patterns/engine.js";
import { fakePatternFeatures } from "../patterns/fake.js";
import { laneCuts, NO_EDITS } from "../patterns/lane.js";
import { FEATURE_RATE, STEM_NAMES, type StemName, type StructureAnalysis } from "../structure/contract.js";
import { cannedStructurePayload } from "./fixture.js";
import { correctedGrid } from "./gridChoice.js";
import { formatLength } from "./lengths.js";
import { createStructureState, respan, sectionAt, stepIndex, type LaneCell } from "./structureState.js";

/** Calls of any pattern engine's lane() (the state's own included), so a test can tell a lookup from a recompute. */
const engineCalls = vi.hoisted(() => ({ n: 0, mixLevels: null as null | ((levels: number[][]) => number[][]) }));
vi.mock("../patterns/engine.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../patterns/engine.js")>();
  return {
    ...m,
    createPatternEngine: (...args: Parameters<typeof m.createPatternEngine>) => {
      const e = m.createPatternEngine(...args);
      return {
        ...e,
        sources: e.sources,
        lane: (...a: Parameters<typeof e.lane>) => (engineCalls.n++, e.lane(...a)),
        // A test may change what the mix says about its levels, to show the dialog does not ask.
        machineLevels: (...a: Parameters<typeof e.machineLevels>) => {
          const levels = e.machineLevels(...a);
          return a[0] === "mix" && engineCalls.mixLevels ? engineCalls.mixLevels(levels) : levels;
        },
      };
    },
  };
});

const LABEL = /^([A-Z]+′?|–) - (start|end|intro|outro|break|bridge|inst|solo|verse|chorus)$/;
const letterOf = (label: string) => label.split(" - ")[0].replace("′", "");

// The fake's pattern: start intro verse chorus verse chorus bridge chorus outro end.
const VERSE_1 = 2;
const CHORUS_1 = 3;
const VERSE_2 = 4;
const CHORUS_2 = 5;

/**
 * The fake at 196 s (eight 24 s sections of 12 downbeats each, a downbeat every 2 s from 2 s), with Other playing a
 * two-downbeat melody in each: the section's pitch class on even downbeats, a tritone up on odd ones.
 */
function repeatingFake(): StructureAnalysis {
  const a = fakeStructureAnalysis(196);
  const pcs = a.bandHz.map((hz) => (((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12));
  const bands = a.stems.other.bands.map((row, f) => {
    const t = f / FEATURE_RATE;
    const k = Math.floor((t - 2) / 2);
    const top = row.indexOf(2);
    if (t < 2 || t >= 194 || k % 2 === 0 || top < 0) return row;
    const pc = (pcs[top] + 6) % 12;
    return row.map((v, b) => (v === 2 ? 0.2 : b >= 1 && pcs[b] === pc ? 2 : v));
  });
  return { ...a, stems: { ...a.stems, other: { ...a.stems.other, bands } } };
}

function fresh(over: Parameters<typeof cannedStructurePayload>[0] = {}) {
  const p = cannedStructurePayload(over);
  return { p, s: createStructureState(p) };
}

describe("structure dialog state", () => {
  it("starts from the interior segment starts and the payload's settings", () => {
    const { p, s } = fresh();
    expect(s.boundaries).toEqual(p.analysis.segments.slice(1).map((g) => g.start));
    expect(s.boundaries).toHaveLength(9);
    expect(s.sliceBy).toBe("sections");
    expect(s.patternLevel).toBe(1);
    expect(s.colorMode).toBe("groups");
    expect(s.output).toBe("split");
    expect(s.selected).toBeNull();
  });

  it("labels every section as letter - function", () => {
    const { s } = fresh();
    const secs = s.sections();
    expect(secs).toHaveLength(10);
    for (const sec of secs) expect(sec.label).toMatch(LABEL);
  });

  it("gives both verses one letter, the choruses another, and the two letters differ", () => {
    const secs = fresh().s.sections();
    expect(letterOf(secs[VERSE_1].label)).toBe(letterOf(secs[VERSE_2].label));
    expect(letterOf(secs[CHORUS_1].label)).toBe(letterOf(secs[CHORUS_2].label));
    expect(letterOf(secs[VERSE_1].label)).not.toBe(letterOf(secs[CHORUS_1].label));
  });

  it("colours equal non-variant groups equally", () => {
    const { s } = fresh();
    const gs = s.groups();
    const secs = s.sections();
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        if (gs[i].group === gs[j].group && gs[i].variant === gs[j].variant) expect(secs[i].color).toBe(secs[j].color);
      }
    }
    expect(new Set(secs.map((x) => x.color)).size).toBeGreaterThan(1);
  });

  it("memoises groups() on boundaries and groupDist", () => {
    const { s } = fresh({ snap: false });
    const a = s.groups();
    expect(s.groups()).toBe(a);
    s.move(CHORUS_1, s.boundaries[CHORUS_1] + 1);
    const b = s.groups();
    expect(b).not.toBe(a);
    expect(s.groups()).toBe(b);
    s.setGroupDist(0.4);
    expect(s.groups()).not.toBe(b);
    const c = s.groups();
    s.setSliceBy("vocals"); // Slice by does not letter
    expect(s.groups()).toBe(c);
  });

  describe("editing boundaries (Review Focus 2)", () => {
    it("recomputes the hint from the new span when a boundary moves", () => {
      const { p, s } = fresh({ snap: false });
      const a = p.analysis;
      // Boundary i sits between sections i and i+1: this one is between verse 1 and chorus 1.
      const chorus = a.segments[CHORUS_1];
      const mid = (chorus.start + chorus.end) / 2;
      s.move(VERSE_1, mid);
      const secs = s.sections();
      const moved = secs[VERSE_1];
      expect(moved.end).toBeCloseTo(mid);
      const fn = sectionFunction(a, moved.start, moved.end);
      expect(moved.label.endsWith(` - ${fn}`)).toBe(true);
      // The shortened chorus is now judged on its own half.
      const after = secs[CHORUS_1];
      expect(after.start).toBeCloseTo(mid);
      expect(after.label.endsWith(` - ${sectionFunction(a, after.start, after.end)}`)).toBe(true);
    });

    it("keeps a rename through move, colour toggles and slice by", () => {
      const { s } = fresh();
      s.rename(2, "Hook");
      s.move(2, s.boundaries[2] + 1);
      expect(s.sections()[2].label).toBe("Hook");
      s.setColorMode("uniform");
      expect(s.sections()[2].label).toBe("Hook");
      s.setColorMode("groups");
      expect(s.sections()[2].label).toBe("Hook");
      s.setSliceBy("drums");
      expect(s.sections()[2].label).toBe("Hook");
    });

    it("renaming to the default label clears the override", () => {
      const { s } = fresh();
      const def = s.sections()[2].label;
      s.rename(2, "Hook");
      expect(s.labels[2]).toBe("Hook");
      s.rename(2, def);
      expect(s.labels[2]).toBeUndefined();
      // Cleared means it follows the span again: move to a place where the default changes.
      s.rename(2, "  ");
      expect(s.labels[2]).toBeUndefined();
    });

    it("add and remove shift overrides as in Cue mode", () => {
      const { p, s } = fresh();
      s.rename(0, "Zero");
      s.rename(2, "Two");
      s.rename(3, "Three");
      const chorus = p.analysis.segments[CHORUS_1];
      s.add((chorus.start + chorus.end) / 2); // splits section 3
      expect(s.boundaries).toHaveLength(10);
      expect(s.selected).toBe(CHORUS_1);
      expect(s.sections()[0].label).toBe("Zero");
      expect(s.sections()[2].label).toBe("Two");
      expect(s.sections()[3].label).toBe("Three");
      expect(s.labels[4]).toBeUndefined();
      s.remove(2); // merges sections 2 and 3, keeping section 2's label
      expect(s.selected).toBeNull();
      expect(s.sections()[2].label).toBe("Two");
      expect(s.boundaries).toHaveLength(9);
    });

    it("ignores an add that would leave a section too short", () => {
      const { s } = fresh();
      const before = s.boundaries;
      s.add(before[0] + MIN_SECTION_SEC / 2);
      expect(s.boundaries).toEqual(before);
    });
  });

  it("gives every section the source colour under uniform", () => {
    const { p, s } = fresh();
    s.setColorMode("uniform");
    for (const sec of s.sections()) expect(sec.color).toBe(p.sourceColor);
  });

  it("Soft colours the bands from the soft palette, same groups and variants as Vivid (feedback round 1)", () => {
    const { s } = fresh();
    const gs = s.groups();
    s.setColorMode("soft");
    s.sections().forEach((sec, i) => expect(sec.color).toBe(groupColor(gs[i].group, gs[i].variant, "soft")));
    s.setColorMode("groups");
    s.sections().forEach((sec, i) => expect(sec.color).toBe(groupColor(gs[i].group, gs[i].variant, "vivid")));
  });

  it("the stem lanes follow the palette: Soft lanes are dimmed soft colours, Vivid and Clip color lanes vivid", () => {
    const { s } = fresh({ snap: false });
    const vivid = s.lanes();
    s.setColorMode("soft");
    const soft = s.lanes();
    expect(soft).not.toBe(vivid);
    for (const stem of STEM_NAMES) {
      soft[stem].forEach((x, i) => {
        expect(x.label).toBe(vivid[stem][i].label);
        if (x.label === "–") expect(x.color).toBe(vivid[stem][i].color);
      });
    }
    expect(soft.vocals.map((x) => x.color)).not.toEqual(vivid.vocals.map((x) => x.color));
    s.setColorMode("uniform");
    expect(s.lanes().vocals.map((x) => x.color)).toEqual(vivid.vocals.map((x) => x.color));
  });

  it("result() is contiguous over [0, duration] and carries the output", () => {
    const { p, s } = fresh();
    s.output = "both";
    s.move(4, s.boundaries[4] + 1);
    const r = s.result();
    expect(r.action).toBe("apply");
    if (r.action !== "apply") return;
    expect(r.output).toBe("both");
    expect(r.sections[0].start).toBe(0);
    expect(r.sections.at(-1)!.end).toBe(p.durationSec);
    for (let i = 1; i < r.sections.length; i++) expect(r.sections[i].start).toBe(r.sections[i - 1].end);
  });

  it("result() and prefs() carry the dialog's choices, for the flow to remember (feedback round 1)", () => {
    const { s } = fresh({ barGrid: [10, 20, 30], showStems: true, granularity: 0, groupDist: 0.15 });
    s.setSliceBy("bass");
    s.setPatternLevel(2);
    s.setColorMode("soft");
    s.setSnap(false);
    s.setSnapTarget("bars");
    const want = { sliceBy: "bass", patternLevel: 2, colorMode: "soft", snap: false, snapTarget: "bars", granularity: 0, groupDist: 0.15, showStems: true };
    expect(s.prefs()).toEqual(want);
    expect(s.result()).toMatchObject({ action: "apply", prefs: want });
  });

  it("cancel() cancels", () => {
    expect(fresh().s.cancel()).toEqual({ action: "cancel" });
  });

  describe("the model's word (Task 13, Live fix 1)", () => {
    // allin1's own segment label can disagree with the argmax of the mean functionProbs over the span (Flim's final
    // "outro" read as "solo"). Unedited spans keep the model's word; only edited spans re-derive it.
    const OUTRO = 8;
    const disagreeing = (over: Partial<ReturnType<typeof cannedStructurePayload>> = {}, dt = 0) => {
      const base = cannedStructurePayload();
      const analysis = {
        ...base.analysis,
        segments: base.analysis.segments.map((g, i) => ({
          ...g,
          start: i === 0 ? 0 : g.start + dt,
          label: i === OUTRO ? ("solo" as const) : g.label,
        })),
      };
      return cannedStructurePayload({ analysis, ...over });
    };
    const word = (label: string) => label.split(" - ")[1];

    it("keeps allin1's segment label for an unedited span, even where the probabilities disagree", () => {
      const p = disagreeing({ snap: false });
      const seg = p.analysis.segments[OUTRO];
      expect(sectionFunction(p.analysis, seg.start, seg.end)).toBe("outro"); // the probabilities say outro
      const secs = createStructureState(p).sections();
      expect(word(secs[OUTRO].label)).toBe("solo");
      p.analysis.segments.forEach((g, i) => expect(word(secs[i].label)).toBe(g.label));
    });

    it("keeps the model's word when the initial boundaries snap to downbeats", () => {
      const p = disagreeing({}, 0.4);
      const s = createStructureState(p);
      expect(s.boundaries[OUTRO - 1]).not.toBe(p.analysis.segments[OUTRO].start); // snapped
      expect(word(s.sections()[OUTRO].label)).toBe("solo");
    });

    it("keeps the model's word through slice by and colour toggles", () => {
      const s = createStructureState(disagreeing());
      s.setSliceBy("drums");
      s.setColorMode("uniform");
      expect(word(s.sections()[OUTRO].label)).toBe("solo");
    });

    it("re-derives the word for both sections next to a moved boundary, and only those", () => {
      const p = disagreeing({ snap: false });
      const s = createStructureState(p);
      s.move(OUTRO, s.boundaries[OUTRO] - 1); // between the outro and end: both spans change
      const secs = s.sections();
      expect(word(secs[OUTRO].label)).toBe(sectionFunction(p.analysis, secs[OUTRO].start, secs[OUTRO].end));
      expect(word(secs[OUTRO].label)).toBe("outro");
      for (let i = 0; i < OUTRO; i++) expect(word(secs[i].label)).toBe(p.analysis.segments[i].label);
    });

    it("a move that lands where it was changes nothing", () => {
      const p = disagreeing();
      const s = createStructureState(p);
      s.move(OUTRO - 1, s.boundaries[OUTRO - 1]);
      expect(word(s.sections()[OUTRO].label)).toBe("solo");
    });

    it("re-derives the halves of a split; merging them back restores the model's word (review M1)", () => {
      const p = disagreeing({ snap: false });
      const s = createStructureState(p);
      const seg = p.analysis.segments[OUTRO];
      s.add(seg.start + 2); // splits the outro into OUTRO and OUTRO+1
      let secs = s.sections();
      for (const i of [OUTRO, OUTRO + 1]) expect(word(secs[i].label)).toBe(sectionFunction(p.analysis, secs[i].start, secs[i].end));
      expect(word(secs[OUTRO + 2].label)).toBe("end");
      s.remove(OUTRO); // merges them back: the span is the engine's outro again
      secs = s.sections();
      expect([secs[OUTRO].start, secs[OUTRO].end]).toEqual([seg.start, seg.end]);
      expect(word(secs[OUTRO].label)).toBe("solo");
      expect(word(secs[OUTRO - 1].label)).toBe(p.analysis.segments[OUTRO - 1].label);
    });

    it("dragging a boundary away and back restores the model's word, with snap on and off (review M1)", () => {
      for (const snap of [true, false]) {
        const p = disagreeing({ snap }, snap ? 0.4 : 0);
        const s = createStructureState(p);
        const home = s.boundaries[OUTRO - 1]; // the outro's start, snapped or raw
        s.move(OUTRO - 1, home - 6);
        expect(word(s.sections()[OUTRO].label), `snap ${snap}`).toBe("outro"); // edited: re-derived
        s.move(OUTRO - 1, home + (snap ? 0.3 : 0)); // snaps back onto the same downbeat, or exactly back
        expect(s.boundaries[OUTRO - 1]).toBe(home);
        expect(word(s.sections()[OUTRO].label), `snap ${snap}`).toBe("solo");
      }
    });

    it("keeps the model's word on snapped spans after snap is turned off, and after re-snapping edited ones", () => {
      const p = disagreeing({}, 0.4);
      const s = createStructureState(p);
      s.setSnap(false);
      expect(word(s.sections()[OUTRO].label)).toBe("solo");
      s.move(OUTRO - 1, s.boundaries[OUTRO - 1] + 0.3); // off the grid
      expect(word(s.sections()[OUTRO].label)).toBe("outro");
      s.setSnap(true); // back onto the downbeat: the engine's outro, snapped
      expect(word(s.sections()[OUTRO].label)).toBe("solo");
    });

    it("re-derives both spans that a snap merge widened, as for a sanitize merge (review M2)", () => {
      // A 1.8 s "break" sliver whose edges (155.1, 156.9) both snap to the 156 s downbeat: snapping drops it, and
      // the chorus before and the outro after each take half of it. Neither is an engine segment any more.
      const base = cannedStructurePayload();
      const segs = base.analysis.segments.map((g) => ({ ...g }));
      const CHORUS_3 = OUTRO - 1;
      segs[CHORUS_3] = { ...segs[CHORUS_3], end: 155.1, label: "verse" }; // the model disagrees with the probs here…
      segs[OUTRO] = { ...segs[OUTRO], start: 156.9, label: "solo" }; // …and here
      segs.splice(OUTRO, 0, { start: 155.1, end: 156.9, label: "break" });
      const analysis = { ...base.analysis, segments: segs };

      const snapped = createStructureState(cannedStructurePayload({ analysis }));
      expect(snapped.snapMerged).toBe(1);
      let secs = snapped.sections();
      expect([secs[CHORUS_3].end, secs[OUTRO].start]).toEqual([156, 156]);
      expect(word(secs[CHORUS_3].label)).toBe("chorus"); // re-derived, not the model's "verse"
      expect(word(secs[OUTRO].label)).toBe("outro"); // re-derived, not the model's "solo"
      expect(word(secs[CHORUS_3 - 1].label)).toBe(segs[CHORUS_3 - 1].label); // untouched neighbours keep theirs
      expect(word(secs[OUTRO + 1].label)).toBe("end");

      // With snap off nothing merges, and every raw span keeps the model's word.
      const raw = createStructureState(cannedStructurePayload({ analysis, snap: false }));
      secs = raw.sections();
      segs.forEach((g, i) => expect(word(secs[i].label)).toBe(g.label));
    });

    it("re-derives a span that sanitising merged (a segment shorter than MIN_SECTION_SEC)", () => {
      const base = disagreeing({ snap: false });
      const segs = base.analysis.segments.map((g) => ({ ...g }));
      // Make segment 2 a sliver: its start moves to within MIN_SECTION_SEC of segment 3's.
      segs[2].start = segs[3].start - MIN_SECTION_SEC / 2;
      segs[1].end = segs[2].start;
      const p = cannedStructurePayload({ snap: false, analysis: { ...base.analysis, segments: segs } });
      const s = createStructureState(p);
      expect(s.boundaries).toHaveLength(8);
      const secs = s.sections();
      // Segment 3's start is dropped, so section 2 runs from segment 2's start to segment 4's: not a model segment.
      expect(secs[2].end).toBe(segs[4].start);
      expect(word(secs[2].label)).toBe(sectionFunction(p.analysis, secs[2].start, secs[2].end));
      expect(word(secs[1].label)).toBe(segs[1].label);
      expect(word(secs[OUTRO - 1].label)).toBe("solo"); // shifted down by one, still unedited
    });
  });

  describe("the Sections slider (feedback round 1)", () => {
    it("0 is allin1's boundaries; -1 is one section; 1 adds boundaries, snapped when snap is on", () => {
      const { p, s } = fresh({ analysis: repeatingFake(), durationSec: 196 }); // under All, Other's repeat splits
      expect(s.canGranulate).toBe(true);
      const own = [...s.boundaries];
      s.setGranularity(-1);
      expect(s.granularity).toBe(-1);
      expect(s.boundaries).toEqual([]);
      expect(s.sections()).toHaveLength(1);
      s.setGranularity(1);
      expect(s.boundaries.length).toBeGreaterThan(own.length);
      for (const b of s.boundaries) expect(p.analysis.downbeats).toContain(b);
      s.setGranularity(0);
      expect(s.boundaries).toEqual(own);
    });

    it("with snap off the added boundaries are the candidates' own times, and the repetition splits allin1's downbeats", () => {
      const { p, s } = fresh({ snap: false });
      const times = new Set(p.analysis.boundaryCandidates.map((c) => c.time));
      s.setGranularity(0.5); // the bottom half adds candidates only
      for (const b of s.boundaries) expect(times.has(b), `${b}`).toBe(true);
      s.setGranularity(1);
      for (const b of s.boundaries) expect(times.has(b) || p.analysis.downbeats.includes(b), `${b}`).toBe(true);
    });

    it("the top half cuts each section where its melody repeats: every 2 downbeats here, from its first (fb2)", () => {
      const analysis = repeatingFake();
      const s = createStructureState(cannedStructurePayload({ analysis, durationSec: 196 }));
      s.setGranularity(0.5);
      expect(s.boundaries).toEqual(analysis.segments.slice(1).map((x) => x.start)); // no strong candidates to add
      s.setGranularity(0.9);
      expect(s.boundaries).toEqual(Array.from({ length: 49 }, (_, j) => 2 + 4 * j));
      expect(s.snapMerged).toBe(0);
      // The pieces of one section are one letter: the melody repeats.
      const letters = s.sections().slice(1, 7).map((x) => letterOf(x.label));
      expect(new Set(letters).size).toBe(1);
    });

    it("Slice by never moves a boundary or a rename, in the top half too (Plan 6: the repetition splits always read all stems)", () => {
      const analysis = repeatingFake();
      const s = createStructureState(cannedStructurePayload({ analysis, durationSec: 196, granularity: 0.9 }));
      expect(s.boundaries).toHaveLength(49);
      s.rename(2, "Mine");
      const kept = [...s.boundaries];
      const labels = s.sections().map((x) => x.label);
      for (const by of ["drums", "bass", "vocals", "other", "sections"] as const) {
        s.setSliceBy(by);
        expect(s.sliceBy).toBe(by);
        expect(s.boundaries, by).toEqual(kept);
        expect(s.sections().map((x) => x.label), by).toEqual(labels);
      }
    });

    it("on the repeating fake too, never removes a boundary as the slider goes up, nor leaves a piece under a bar", () => {
      for (const snap of [true, false]) {
        const s = createStructureState(cannedStructurePayload({ analysis: repeatingFake(), durationSec: 196, snap }));
        let prev: number[] = [];
        for (let g = 0; g <= 1.0001; g += 0.01) {
          s.setGranularity(g);
          for (const t of prev) expect(s.boundaries, `snap ${snap}, g ${g.toFixed(2)} keeps ${t}`).toContain(t);
          prev = [...s.boundaries];
          if (snap) expect(s.snapMerged, `g ${g.toFixed(2)}`).toBe(0);
        }
        const e = [0, ...s.boundaries, 196];
        for (let i = 1; i < e.length; i++) expect(e[i] - e[i - 1], `snap ${snap}`).toBeGreaterThanOrEqual(2 - 0.05);
      }
    });

    it("never removes a boundary as the slider goes up, snapped or not (each step contains the last)", () => {
      for (const snap of [true, false]) {
        const s = createStructureState(cannedStructurePayload({ snap }));
        let prev: number[] = [];
        for (let g = 0; g <= 1.0001; g += 0.02) {
          s.setGranularity(g);
          for (const t of prev) expect(s.boundaries, `snap ${snap}, g ${g.toFixed(2)} keeps ${t}`).toContain(t);
          prev = [...s.boundaries];
          if (snap) expect(s.snapMerged, `g ${g.toFixed(2)}`).toBe(0); // the slider's own additions never collide
        }
        // No section the slider made is under a bar (2 s); the fake's own 2 s start and end are exactly one.
        const e = [0, ...s.boundaries, 180];
        for (let i = 1; i < e.length; i++) expect(e[i] - e[i - 1], `snap ${snap}`).toBeGreaterThanOrEqual(2 - 0.05);
      }
    });

    it("the splits follow the chosen grid: Live's bars with Bars, allin1's downbeats with snap off", () => {
      const BARS = Array.from({ length: 99 }, (_, i) => 1 + 2 * i);
      const rep = { analysis: repeatingFake(), durationSec: 196 };
      const s = createStructureState(cannedStructurePayload({ ...rep, barGrid: BARS, snapTarget: "bars", granularity: 1 }));
      expect(s.boundaries.length).toBeGreaterThan(40);
      for (const b of s.boundaries) expect(BARS).toContain(b);
      const raw = createStructureState(cannedStructurePayload({ ...rep, barGrid: BARS, snap: false, granularity: 1 }));
      for (const b of raw.boundaries) expect(rep.analysis.downbeats).toContain(b);
      const off = createStructureState(cannedStructurePayload({ barGrid: BARS, snap: false, granularity: 1 }));
      const own = new Set([...off.boundaries].filter((b) => !cannedStructurePayload().analysis.downbeats.includes(b)));
      const cands = new Set(cannedStructurePayload().analysis.boundaryCandidates.map((c) => c.time));
      for (const b of own) expect(cands.has(b), `${b} is a candidate`).toBe(true); // the rest are downbeats
    });

    it("replaces the boundaries: hand edits, renames and the selection go", () => {
      const { s } = fresh();
      s.move(3, s.boundaries[3] + 4);
      s.rename(2, "Mine");
      s.selected = 4;
      s.setGranularity(-0.5);
      expect(s.labels).toEqual({});
      expect(s.selected).toBeNull();
      expect(s.sections().map((x) => x.label)).not.toContain("Mine");
    });

    it("opens at the payload's value", () => {
      const at = (g: number) => createStructureState(cannedStructurePayload({ analysis: repeatingFake(), durationSec: 196, granularity: g })).boundaries.length;
      expect(at(-1)).toBe(0);
      expect(at(1)).toBeGreaterThan(at(0));
    });

    it("is disabled without boundary candidates, and then leaves allin1's boundaries alone", () => {
      const base = cannedStructurePayload({ granularity: 0.7 });
      const s = createStructureState({ ...base, analysis: { ...base.analysis, boundaryCandidates: [] } });
      expect(s.canGranulate).toBe(false);
      const own = [...s.boundaries];
      expect(own).toHaveLength(9);
      s.setGranularity(1);
      expect(s.boundaries).toEqual(own);
      expect(s.granularity).toBe(0);
      expect(s.prefs().granularity).toBe(0.7); // the remembered value is kept for the next clip (review M4)
    });
  });

  describe("repetition splits on Flim (fb2: Matt's hand-made sections)", () => {
    // Flim's allin1 boundaries, function probabilities and Other stem (fixtures/structure/fb2_flim_other.json, from
    // dev-E's fb1 analysis); the other stems are silent here.
    type Flim = Pick<StructureAnalysis, "engine" | "durationSec" | "bpm" | "frames" | "segments" | "downbeats" | "boundaryCandidates" | "functionProbs"> & {
      stems: { other: Pick<StructureAnalysis["stems"]["other"], "bands" | "loudnessDb"> };
    };
    const flim = JSON.parse(fs.readFileSync("fixtures/structure/fb2_flim_other.json", "utf8")) as Flim;
    const D = flim.durationSec;
    const silent = { bands: Array.from({ length: flim.frames }, () => new Array<number>(81).fill(0)), loudnessDb: new Array<number>(flim.frames).fill(-100), peak: [] };
    const analysis: StructureAnalysis = {
      ...fakeStructureAnalysis(D),
      ...flim,
      beats: flim.downbeats,
      stems: { drums: silent, bass: silent, vocals: silent, other: { ...flim.stems.other, peak: [] } },
    };
    const at = (g: number) => createStructureState(cannedStructurePayload({ analysis, durationSec: D, granularity: g }));
    /** Matt's cuts, every ~6.5 s: every 2nd downbeat in the intro (allin1's downbeats are 3.24 s apart there), every 4th in the other. */
    const SECTIONS = [
      { from: 2.67, to: 28.62, cuts: [9.16, 15.66, 22.13] },
      { from: 86.98, to: 112.95, cuts: [93.47, 99.96, 106.45] },
    ];
    /** Whether, at this state, the section is cut at Matt's cuts (within one of its downbeats) and nowhere else, all one letter. */
    const matches = (s: ReturnType<typeof at>, { from, to, cuts }: (typeof SECTIONS)[number]) => {
      const inside = s.boundaries.filter((t) => t > from + 0.1 && t < to - 0.1);
      const beat = (from === 2.67 ? 3.24 : 1.62) + 0.01;
      if (inside.length !== cuts.length || inside.some((t, i) => Math.abs(t - cuts[i]) > beat)) return false;
      const letters = s.sections().filter((x) => x.start > from - 0.1 && x.end < to + 0.1).map((x) => x.label.split(" - ")[0]);
      return letters.length === cuts.length + 1 && new Set(letters).size === 1;
    };

    it("at some g up to 0.8 both sections are cut where Matt cut them, into pieces of one letter, and stay so to 0.8", () => {
      let first: number | null = null;
      for (let k = 51; k <= 80; k++) {
        const s = at(k / 100);
        const ok = SECTIONS.every((x) => matches(s, x));
        if (first === null && ok) first = k;
        if (first !== null) expect(ok, `g ${k / 100} (first ${first / 100})`).toBe(true);
      }
      expect(first, "no g up to 0.8 passes").not.toBeNull();
      expect(first! / 100).toBeLessThanOrEqual(0.8);
    });

    it("a Sections move keeps each rename whose section survives with the same start and end, and drops the rest (dev-H)", () => {
      const s = at(0.5);
      const idxAt = (t: number) => s.sections().findIndex((x) => x.start <= t && x.end > t);
      s.rename(idxAt(50), "Kept"); // 44.84 to 61.65: no repetition split there
      s.rename(idxAt(10), "Split"); // the intro: the slider cuts it in four at 0.75
      const k = idxAt(80) - 1;
      s.move(k, s.boundaries[k] + 1.2); // a hand-moved boundary (snapped to the next downbeat) still goes
      const movedTo = s.boundaries[k];
      expect(movedTo).toBe(80.5);
      s.setGranularity(0.75);
      const labels = s.sections().map((x) => x.label);
      expect(labels.filter((x) => x === "Kept")).toHaveLength(1);
      expect(s.sections()[idxAt(50)].label).toBe("Kept");
      expect(labels).not.toContain("Split");
      expect(s.boundaries).not.toContain(movedTo);
      // And back down: the rename rides along again, while the span is the same.
      s.setGranularity(0.5);
      expect(s.sections()[idxAt(50)].label).toBe("Kept");
      // A snap change that rebuilds keeps it too, re-keyed to the unsnapped span only if that span is unchanged.
      s.setSnap(false);
      expect(s.sections().some((x) => x.label === "Kept")).toBe(false); // 44.83 to 62.66 raw: not the same span
    });

    it("cuts exactly on Flim's downbeats there at g = 0.75, the intro B B B B and the other section B′ B′ B′ B′", () => {
      const s = at(0.75);
      expect(s.boundaries.filter((t) => t > 2.8 && t < 28.5)).toEqual([9.16, 15.66, 22.13]);
      expect(s.boundaries.filter((t) => t > 87.1 && t < 112.9)).toEqual([93.47, 99.96, 106.45]);
      const letter = (t: number) => s.sections().find((x) => x.start <= t && x.end > t)!.label.split(" - ")[0];
      expect([5, 12, 18, 25].map(letter)).toEqual(["B", "B", "B", "B"]);
      expect([90, 96, 103, 110].map(letter)).toEqual(["B′", "B′", "B′", "B′"]);
    });

    it("below the very top adds only those cuts, and moves allin1's weak 129.17 onto the repeat across it (base correction)", () => {
      // 112.95 to 147.02 repeats every 8 downbeats (13 s), which neither part shows: allin1's weak boundary at 129.17
      // (strength 0.011, under the floor) moves 2 downbeats back onto that period, to 125.94, and the period's next
      // cut, 138.91, follows: Matt's pairs after 112.95 (both his references).
      const half = at(0.5).boundaries;
      const top = at(0.9).boundaries;
      expect(top.filter((t) => !half.includes(t))).toEqual([9.16, 15.66, 22.13, 93.47, 99.96, 106.45, 125.94, 138.91]);
      expect(half.filter((t) => !top.includes(t))).toEqual([129.18]);
      expect(at(0.51).boundaries).toContain(125.94);
    });

    it("never removes a boundary going up from 0 to 1, snapped or not, but for the base correction across the middle", () => {
      for (const snap of [true, false]) {
        const s = createStructureState(cannedStructurePayload({ analysis, durationSec: D, snap }));
        let prev: number[] = [];
        for (let k = 0; k <= 100; k++) {
          s.setGranularity(k / 100);
          const lost = prev.filter((t) => !s.boundaries.includes(t));
          // The one exception (controller ruling, fb2): the step from 0.5 to 0.51 moves allin1's weak 129.17.
          expect(lost, `snap ${snap}, g ${k / 100}`).toEqual(k === 51 ? [snap ? 129.18 : 129.17] : []);
          prev = [...s.boundaries];
        }
      }
    });
  });

  describe("the Sections slider after a snap or target change (review I1)", () => {
    // Allin1's boundary data of the two real songs (from dev-E's fb1 analyses: segments, downbeats, candidates).
    type Real = Pick<StructureAnalysis, "engine" | "durationSec" | "bpm" | "segments" | "downbeats" | "boundaryCandidates">;
    const real = JSON.parse(fs.readFileSync("fixtures/structure/fb1_boundaries.json", "utf8")) as Record<"flim" | "icl", Real>;
    /** A payload on `r`'s boundary data (the rest from the fake) with a 4/4 bar grid at its tempo, from its first downbeat. */
    const payloadOf = (r: Real | null, over: Parameters<typeof cannedStructurePayload>[0] = {}) => {
      if (!r) return cannedStructurePayload({ barGrid: Array.from({ length: 90 }, (_, i) => 1 + 2 * i), ...over });
      const bar = (4 * 60) / (r.bpm ?? 120);
      const first = r.downbeats[0] - Math.floor(r.downbeats[0] / bar) * bar;
      const barGrid = Array.from({ length: Math.floor((r.durationSec - first) / bar) + 1 }, (_, k) => first + k * bar);
      const analysis = { ...fakeStructureAnalysis(r.durationSec), ...r };
      return cannedStructurePayload({ analysis, durationSec: r.durationSec, barGrid, ...over });
    };
    const cases: [string, Real | null][] = [["the fake", null], ["Flim", real.flim], ["Inner City Life", real.icl]];
    const G = [0.25, 0.5, 0.6, 0.75, 0.9, 0.99];

    /** After `change`, one step up keeps every boundary the change left. */
    function stepUpKeeps(name: string, r: Real | null, start: Parameters<typeof cannedStructurePayload>[0], change: (s: ReturnType<typeof createStructureState>) => void) {
      for (const g of G) {
        const s = createStructureState(payloadOf(r, start));
        s.setGranularity(g);
        change(s);
        const before = [...s.boundaries];
        s.setGranularity(g + 0.01);
        const lost = before.filter((t) => !s.boundaries.includes(t));
        expect(lost, `${name}, g ${g}: ${before.length + 1} -> ${s.boundaries.length + 1} sections`).toEqual([]);
      }
    }

    for (const [name, r] of cases) {
      it(`${name}: snap off, then a step up, only adds`, () => stepUpKeeps(name, r, { snap: true }, (s) => s.setSnap(false)));
      it(`${name}: snap on, then a step up, only adds`, () => stepUpKeeps(name, r, { snap: false }, (s) => s.setSnap(true)));
      it(`${name}: Downbeats to Bars, then a step up, only adds`, () => stepUpKeeps(name, r, { snap: true }, (s) => s.setSnapTarget("bars")));
      it(`${name}: Bars to Downbeats, then a step up, only adds`, () =>
        stepUpKeeps(name, r, { snap: true, snapTarget: "bars" }, (s) => s.setSnapTarget("downbeats")));
    }

    it("the change rebuilds what the slider would give on the new basis", () => {
      const p = payloadOf(real.flim);
      const s = createStructureState(p);
      s.setGranularity(0.75);
      s.setSnap(false);
      expect(s.boundaries).toEqual(createStructureState({ ...p, snap: false, granularity: 0.75 }).boundaries);
      s.setSnap(true);
      s.setSnapTarget("bars");
      expect(s.boundaries).toEqual(createStructureState({ ...p, snapTarget: "bars", granularity: 0.75 }).boundaries);
    });

    it("so does opening at a slider value", () => {
      const p = payloadOf(real.icl, { granularity: 0.75 });
      const s = createStructureState(p);
      s.setSnapTarget("bars");
      expect(s.boundaries).toEqual(createStructureState({ ...p, snapTarget: "bars" }).boundaries);
    });

    it("after a hand edit since the slider moved, the change re-snaps and keeps the edits", () => {
      for (const edit of ["move", "add", "remove", "rename"] as const) {
        const s = createStructureState(payloadOf(real.flim, { snap: false }));
        s.setGranularity(0.75);
        if (edit === "move") s.move(2, s.boundaries[2] + 0.7);
        if (edit === "add") {
          const n = s.boundaries.length;
          const e = [0, ...s.boundaries, real.flim.durationSec];
          const k = e.slice(1).reduce((best, t, i) => (t - e[i] > e[best + 1] - e[best] ? i : best), 0);
          s.add((e[k] + e[k + 1]) / 2 + 0.3); // inside the longest section, off the grid
          expect(s.boundaries).toHaveLength(n + 1);
        }
        if (edit === "remove") s.remove(3);
        if (edit === "rename") s.rename(1, "Mine");
        const kept = [...s.boundaries];
        s.setSnap(false); // already off: the boundaries stay as edited
        expect(s.boundaries, edit).toEqual(kept);
        s.setSnap(true);
        const grid = real.flim.downbeats;
        expect(s.boundaries, edit).toEqual(snapBoundaries(kept, grid, real.flim.durationSec)); // the edited ones, snapped
        if (edit === "rename") expect(s.sections()[1].label).toBe("Mine");
      }
    });

    it("at 0 the change re-snaps allin1's boundaries as before", () => {
      const s = createStructureState(payloadOf(real.flim));
      const snapped = [...s.boundaries];
      s.setSnap(false);
      expect(s.boundaries).toEqual(snapped); // off leaves them where they are
    });
  });

  describe("the Letters slider (feedback round 1)", () => {
    const letters = (s: ReturnType<typeof createStructureState>) => new Set(s.sections().map((x) => letterOf(x.label))).size;
    // The fake's sections are far apart (the nearest different pair is 0.43), so 0.6 shows a change on it.
    const LOOSER = 0.6;

    it("a larger distance joins letters, in the bands and the lanes; boundaries and renames stay", () => {
      const { s } = fresh();
      const own = [...s.boundaries];
      s.rename(4, "Mine");
      const normal = letters(s);
      const g0 = s.groups();
      const l0 = s.lanes();
      s.setGroupDist(LOOSER);
      expect(s.groupDist).toBe(LOOSER);
      expect(s.groups()).not.toBe(g0);
      expect(letters(s)).toBeLessThan(normal);
      const sp = s.sections();
      for (const stem of STEM_NAMES) {
        const want = groupSections(sectionVectors(cannedStructurePayload().analysis, sp, stem), LOOSER).map((g) => g.group);
        expect(s.lanes()[stem].map((x) => (x.label === "–" ? null : x.label.charCodeAt(0) - 65)), stem).toEqual(want);
      }
      expect(s.lanes()).not.toBe(l0);
      expect(s.boundaries).toEqual(own);
      expect(s.sections()[4].label).toBe("Mine");
    });

    it("a stricter distance marks near repeats as variants that the default keeps plain", () => {
      // The last chorus is 0.034 from the others: plain under the default (variant threshold 0.05), a variant at 0.05.
      const { s } = fresh();
      const plain = s.groups()[CHORUS_2 + 2];
      s.setGroupDist(0.05);
      const strict = s.groups()[CHORUS_2 + 2];
      expect(plain).toMatchObject({ variant: false });
      expect(strict).toMatchObject({ group: plain.group, variant: true });
    });

    it("opens at the payload's value", () => {
      const s = createStructureState(cannedStructurePayload({ groupDist: LOOSER }));
      expect(s.groupDist).toBe(LOOSER);
      expect(letters(s)).toBeLessThan(letters(fresh().s));
    });

    it("the default stays today's GROUP_DIST, inside the slider's range", () => {
      expect(fresh().s.groupDist).toBe(0.15);
      expect(GROUP_DIST_MIN).toBeLessThan(0.15);
      expect(GROUP_DIST_MAX).toBeGreaterThan(0.15);
    });
  });

  it("Show stems is a remembered choice that changes nothing else (feedback round 1)", () => {
    const { s } = fresh();
    expect(s.showStems).toBe(false);
    const before = { b: [...s.boundaries], lanes: s.lanes(), secs: s.sections() };
    s.setShowStems(true);
    expect(s.showStems).toBe(true);
    expect(s.prefs().showStems).toBe(true);
    expect(s.boundaries).toEqual(before.b);
    expect(s.lanes()).toBe(before.lanes);
    expect(s.sections()).toEqual(before.secs);
    expect(createStructureState(cannedStructurePayload({ showStems: true })).showStems).toBe(true);
  });

  describe("snap target: Downbeats or Bars (feedback round 1)", () => {
    // Live's bars, deliberately off the fake's downbeats (2, 4, 6, ...): one every 2 s from 1 s.
    const BARS = Array.from({ length: 90 }, (_, i) => 1 + 2 * i);
    const DOWNBEATS = cannedStructurePayload().analysis.downbeats;
    const onBars = (over: Partial<ReturnType<typeof cannedStructurePayload>> = {}) =>
      createStructureState(cannedStructurePayload({ barGrid: BARS, ...over }));

    it("opens snapped to the bars when the payload says Bars", () => {
      const s = onBars({ snapTarget: "bars" });
      expect(s.snapTarget).toBe("bars");
      expect(s.canSnapBars).toBe(true);
      expect(s.boundaries.length).toBeGreaterThan(5);
      for (const b of s.boundaries) expect(BARS).toContain(b);
    });

    it("switching the target re-snaps the current boundaries, as toggling snap does", () => {
      const s = onBars({ snapTarget: "downbeats" });
      for (const b of s.boundaries) expect(DOWNBEATS).toContain(b);
      s.selected = 2;
      s.setSnapTarget("bars");
      expect(s.snapTarget).toBe("bars");
      for (const b of s.boundaries) expect(BARS).toContain(b);
      expect(s.selected).toBeNull();
      s.setSnapTarget("downbeats");
      for (const b of s.boundaries) expect(DOWNBEATS).toContain(b);
    });

    it("snaps moves and adds to the chosen grid", () => {
      const s = onBars({ snapTarget: "bars" });
      s.move(3, s.boundaries[3] + 2.3);
      expect(BARS).toContain(s.boundaries[3]);
      const t = (s.boundaries[4] + s.boundaries[5]) / 2 + 0.2;
      s.add(t);
      expect(s.boundaries.some((b) => Math.abs(b - t) < 1.01 && BARS.includes(b))).toBe(true);
    });

    it("with snap off, switching the target only records the choice", () => {
      const s = onBars({ snap: false, snapTarget: "downbeats" });
      const before = [...s.boundaries];
      s.setSnapTarget("bars");
      expect(s.snapTarget).toBe("bars");
      expect(s.boundaries).toEqual(before);
      s.setSnap(true);
      for (const b of s.boundaries) expect(BARS).toContain(b);
    });

    it("without a bar grid (an unwarped Session clip) Bars is unavailable and Downbeats is used", () => {
      const s = createStructureState(cannedStructurePayload({ barGrid: null, snapTarget: "bars" }));
      expect(s.canSnapBars).toBe(false);
      expect(s.canSnap).toBe(true);
      expect(s.snapTarget).toBe("downbeats");
      for (const b of s.boundaries) expect(DOWNBEATS).toContain(b);
      s.setSnapTarget("bars"); // ignored
      expect(s.snapTarget).toBe("downbeats");
      expect(s.prefs().snapTarget).toBe("bars"); // but the user's choice is remembered for the next clip
    });

    it("without downbeats Bars still snaps, and Downbeats is unavailable", () => {
      const base = cannedStructurePayload();
      const s = createStructureState({ ...base, analysis: { ...base.analysis, beats: [], downbeats: [] }, barGrid: BARS, snapTarget: "downbeats" });
      expect(s.canSnap).toBe(true);
      expect(s.canSnapDownbeats).toBe(false);
      expect(s.snapTarget).toBe("bars");
      for (const b of s.boundaries) expect(BARS).toContain(b);
    });

    it("keeps the model's words on spans snapped to the bars", () => {
      const s = onBars({ snapTarget: "bars" });
      const words = createStructureState(cannedStructurePayload({ snap: false })).sections().map((x) => x.label.split(" - ")[1]);
      expect(s.sections().map((x) => x.label.split(" - ")[1])).toEqual(words);
    });
  });

  describe("snapping to downbeats", () => {
    const shifted = (dt: number, over: Partial<ReturnType<typeof cannedStructurePayload>> = {}) => {
      const base = cannedStructurePayload();
      const analysis = {
        ...base.analysis,
        segments: base.analysis.segments.map((g, i) => ({ ...g, start: i === 0 ? 0 : g.start + dt })),
      };
      return cannedStructurePayload({ analysis, ...over });
    };

    it("lands shifted initial boundaries exactly on downbeats", () => {
      const p = shifted(0.4);
      const s = createStructureState(p);
      expect(s.canSnap).toBe(true);
      expect(s.boundaries).toHaveLength(9);
      for (const b of s.boundaries) expect(p.analysis.downbeats).toContain(b);
      expect(s.boundaries).toEqual(createStructureState(cannedStructurePayload()).boundaries);
    });

    it("leaves shifted boundaries raw when the payload has snap off", () => {
      const s = createStructureState(shifted(0.4, { snap: false }));
      expect(s.snap).toBe(false);
      expect(s.boundaries[0]).toBeCloseTo(2.4);
    });

    it("snaps a move to the downbeat, and does not with snap off", () => {
      const { p, s } = fresh();
      const target = p.analysis.downbeats.find((d) => d > s.boundaries[3] + 6)!;
      s.move(3, target + 0.3);
      expect(s.boundaries[3]).toBe(target);
      s.setSnap(false);
      s.move(3, target + 0.3);
      expect(s.boundaries[3]).toBeCloseTo(target + 0.3);
    });

    it("snaps an add", () => {
      const { p, s } = fresh();
      const d = p.analysis.downbeats.find((x) => x > s.boundaries[2] + 4 && x < s.boundaries[3] - 4)!;
      s.add(d + 0.3);
      expect(s.boundaries).toContain(d);
      expect(s.selected).toBe(s.boundaries.indexOf(d));
    });

    it("setSnap(true) re-snaps, setSnap(false) leaves boundaries where they are", () => {
      const p = shifted(0.4, { snap: false });
      const s = createStructureState(p);
      const raw = [...s.boundaries];
      s.setSnap(true);
      for (const b of s.boundaries) expect(p.analysis.downbeats).toContain(b);
      s.setSnap(false);
      expect(s.boundaries).toHaveLength(9);
      s.move(0, s.boundaries[0] + 0.3);
      const moved = [...s.boundaries];
      s.setSnap(false);
      expect(s.boundaries).toEqual(moved);
      expect(raw).not.toEqual(moved);
    });

    it("re-snapping keeps the big surviving section's rename, not the collapsed sliver's", () => {
      const p = cannedStructurePayload({ snap: false });
      const s = createStructureState(p);
      // The first two boundaries both snap to the downbeat at 10 s, so the second is dropped. Section 1 is the
      // 0.7 s sliver between them; section 2 (10.9 to 30) is the one that survives, as [10, 30].
      s.boundaries = [10.2, 10.9, 30];
      s.labels = { 0: "Zero", 1: "One", 2: "Two", 3: "Three" };
      s.setSnap(true);
      expect(s.boundaries).toEqual([10, 30]);
      expect(s.snapMerged).toBe(1);
      expect(s.labels).toEqual({ 0: "Zero", 1: "Two", 2: "Three" });
    });

    it("keeps 'Big chorus' when a pickup next to it snaps onto the neighbouring boundary (user path)", () => {
      const s = createStructureState(cannedStructurePayload({ snap: false }));
      s.move(2, 46.95);
      s.move(1, 45.05); // both are nearest the downbeat at 46
      s.rename(3, "Big chorus"); // [46.95, 68]
      expect(s.sections()[3].label).toBe("Big chorus");
      s.setSnap(true);
      expect(s.snapMerged).toBe(1);
      expect(s.boundaries.slice(0, 3)).toEqual([2, 46, 68]);
      expect(s.sections()[2]).toMatchObject({ start: 46, end: 68, label: "Big chorus" });
      expect(Object.values(s.labels)).toEqual(["Big chorus"]);
    });

    it("keeps a rename on the section after a boundary that snaps onto the clip start", () => {
      const p = cannedStructurePayload({ snap: false });
      p.analysis = { ...p.analysis, downbeats: [0, ...p.analysis.downbeats] };
      const s = createStructureState(p);
      s.move(0, 1.0);
      s.rename(1, "Intro!"); // [1, 24]
      s.setSnap(true); // 1.0 is as near 0 as 2, and ties go to the earlier point
      expect(s.boundaries[0]).toBe(24);
      expect(s.sections()[0]).toMatchObject({ start: 0, end: 24, label: "Intro!" });
      expect(s.snapMerged).toBe(1);
    });

    it("keeps the large section's rename when the last boundary snaps onto the clip end", () => {
      const p = cannedStructurePayload({ snap: false });
      p.analysis = { ...p.analysis, downbeats: [...p.analysis.downbeats, 179.6] };
      const s = createStructureState(p);
      s.move(8, 179); // the last boundary, as close to the end as allowed
      s.rename(8, "Outro!"); // [156, 179]
      s.rename(9, "Tail"); // [179, 180]
      s.setSnap(true); // 179 snaps to 179.6, 0.4 s from the end
      expect(s.boundaries).toHaveLength(8);
      expect(s.sections().at(-1)).toMatchObject({ end: 180, label: "Outro!" });
      expect(Object.values(s.labels)).not.toContain("Tail");
    });

    it("merges two boundaries that snap to one downbeat, never leaving a short section", () => {
      const s = createStructureState(cannedStructurePayload({ snap: false }));
      s.boundaries = [10.1, 10.9, 40];
      s.setSnap(true);
      expect(s.boundaries).toEqual([10, 40]);
      const secs = s.sections();
      for (const x of secs) expect(x.end - x.start).toBeGreaterThanOrEqual(MIN_SECTION_SEC);
    });

    it("drops a boundary that snaps onto the clip start and says so", () => {
      const s = createStructureState(cannedStructurePayload({ snap: false }));
      s.boundaries = [1.5, 40];
      s.setSnap(true); // downbeats start at 2 s, so 1.5 snaps to 2 (kept); make a grid that starts at 0
      expect(s.boundaries).toEqual([2, 40]);
      const p = cannedStructurePayload({ snap: false });
      p.analysis = { ...p.analysis, downbeats: [0, ...p.analysis.downbeats] };
      const t = createStructureState(p);
      t.boundaries = [0.6, 40];
      t.setSnap(true);
      expect(t.boundaries).toEqual([40]);
      expect(t.snapMerged).toBe(1);
      t.move(0, 41);
      expect(t.snapMerged).toBe(0);
    });

    it("has no snapping without downbeats and keeps the raw segment starts (Review Focus 3)", () => {
      const base = cannedStructurePayload();
      const p = cannedStructurePayload({ analysis: { ...base.analysis, beats: [], downbeats: [], bpm: null } });
      const s = createStructureState(p);
      expect(s.canSnap).toBe(false);
      expect(s.boundaries).toEqual(p.analysis.segments.slice(1).map((g) => g.start));
      const before = s.boundaries[3];
      s.move(3, before + 0.3);
      expect(s.boundaries[3]).toBeCloseTo(before + 0.3);
      s.setSnap(true);
      expect(s.boundaries[3]).toBeCloseTo(before + 0.3);
    });
  });

  describe("stem lanes", () => {
    const channelSum = (c: number) => ((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff);

    it("shows the fake's vocals as silent dashes on the dark colour where there are no vocals (Review Focus 1)", () => {
      const { p, s } = fresh();
      const vocals = s.lanes().vocals;
      const segs = p.analysis.segments;
      segs.forEach((g, i) => {
        if (["start", "intro", "outro", "end"].includes(g.label)) {
          expect(vocals[i].label).toBe("–");
          expect(vocals[i].color).toBe(0x141414);
        } else {
          expect(vocals[i].label).toMatch(/^[A-Z]+′?$/);
          expect(vocals[i].color).not.toBe(0x141414);
        }
      });
      for (const l of Object.values(s.lanes()).flat()) expect(Number.isFinite(l.color)).toBe(true);
    });

    it("has one lane per stem, in order, cut at exactly the section edges", () => {
      const { s } = fresh();
      s.move(3, s.boundaries[3] + 4);
      s.add((s.boundaries[0] + s.boundaries[1]) / 2);
      const secs = s.sections();
      const lanes = s.lanes();
      expect(Object.keys(lanes)).toEqual(["drums", "bass", "vocals", "other"]);
      for (const lane of Object.values(lanes)) {
        expect(lane.map((x) => [x.start, x.end])).toEqual(secs.map((x) => [x.start, x.end]));
      }
    });

    it("raising a section's loudness raises its brightness", () => {
      const quiet = (db: number) => {
        const base = cannedStructurePayload({ snap: false });
        const a = base.analysis;
        const drums = { ...a.stems.drums, loudnessDb: a.stems.drums.loudnessDb.map(() => -40) };
        const seg = a.segments[VERSE_1];
        for (let f = Math.floor(seg.start * 2); f < Math.ceil(seg.end * 2); f++) drums.loudnessDb[f] = db;
        return createStructureState({ ...base, analysis: { ...a, stems: { ...a.stems, drums } } });
      };
      const low = quiet(-40).lanes().drums;
      const high = quiet(-30).lanes().drums;
      expect(channelSum(high[VERSE_1].color)).toBeGreaterThan(channelSum(low[VERSE_1].color));
      expect(high[VERSE_1].label).toBe(low[VERSE_1].label);
      expect(high[CHORUS_1].color).toBe(low[CHORUS_1].color);
    });

    // Task 10 I1: pin the brightness mapping, (dB + 60) / 48 clamped, and which stem's loudness drives each lane.
    const near = (got: number, want: number) =>
      [16, 8, 0].every((sh) => Math.abs(((got >> sh) & 0xff) - ((want >> sh) & 0xff)) <= 1); // ±1 per channel: float dB
    const groupOf = (label: string) => ({ group: label.charCodeAt(0) - 65, variant: label.endsWith("′") });
    /** The canned analysis with `stem`'s loudness set to `db` on the audible frames of `where` (all audible frames if omitted). */
    const withLoudness = (stem: StemName, db: number, where?: { start: number; end: number }) => {
      const base = cannedStructurePayload({ snap: false });
      const a: StructureAnalysis = base.analysis;
      const loudnessDb = a.stems[stem].loudnessDb.map((v, f) => {
        const t = f / 2;
        const inside = !where || (t >= where.start && t < where.end);
        return inside && v > -45 ? db : v; // leave silent frames silent, so the grouping does not change
      });
      return createStructureState({ ...base, analysis: { ...a, stems: { ...a.stems, [stem]: { ...a.stems[stem], loudnessDb } } } });
    };

    it("maps loudness to brightness: -36 dB is half way to the dark colour, -12 dB is the full group colour, variants included", () => {
      const half = withLoudness("vocals", -36).lanes().vocals;
      const full = withLoudness("vocals", -12).lanes().vocals;
      expect(full.map((x) => x.label)).toEqual(["–", "–", "A", "B", "A", "B", "C", "B′", "–", "–"]);
      full.forEach((x, i) => {
        if (x.label === "–") return;
        const { group, variant } = groupOf(x.label);
        expect(near(x.color, groupColor(group, variant)), `full ${i} ${x.label}`).toBe(true);
        expect(near(half[i].color, dim(groupColor(group, variant), 0.5)), `half ${i} ${x.label}`).toBe(true);
        expect(half[i].label).toBe(x.label);
      });
      // The variant uses the lighter row of the same column.
      expect(groupColor(1, true)).not.toBe(groupColor(1, false));
      expect(near(full[7].color, groupColor(1, true))).toBe(true);
    });

    it("brightness follows each lane's own stem: changing one stem's loudness changes only that lane", () => {
      const baseline = withLoudness("drums", -12).lanes();
      for (const stem of STEM_NAMES) {
        const changed = withLoudness(stem, -36, baseline[stem][VERSE_1]).lanes();
        for (const other of STEM_NAMES) {
          const before = baseline[other][VERSE_1].color;
          const after = changed[other][VERSE_1].color;
          if (other === stem) expect(after, `${stem} lane`).not.toBe(before);
          else expect(after, `${other} lane when ${stem} changed`).toBe(before);
        }
        expect(changed[stem][CHORUS_1].color, `${stem} chorus untouched`).toBe(baseline[stem][CHORUS_1].color);
      }
    });

    it("memoises lanes() on the boundaries", () => {
      const { s } = fresh({ snap: false });
      const a = s.lanes();
      expect(s.lanes()).toBe(a);
      s.setSliceBy("vocals");
      expect(s.lanes()).toBe(a); // the lanes group per stem whatever Slice by says
      s.move(CHORUS_1, s.boundaries[CHORUS_1] + 1);
      expect(s.lanes()).not.toBe(a);
    });
  });

  describe("section markers with stable ids (Plan 6, Task 2)", () => {
    const ids = (s: ReturnType<typeof createStructureState>) => s.markers().map((m) => m.id);
    const idAt = (s: ReturnType<typeof createStructureState>, t: number) => s.markers().find((m) => Math.abs(m.time - t) <= 1e-6)?.id;

    it("opens with ids 1..n, at the boundaries' times", () => {
      const { s } = fresh();
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(s.markers().map((m) => m.time)).toEqual(s.boundaries);
    });

    it("move keeps the id", () => {
      const { s } = fresh({ snap: false });
      const t = s.boundaries[3] + 1;
      s.move(3, t);
      expect(s.markers()[3]).toEqual({ id: 4, time: t });
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("add gives max + 1, remove drops the id, and an id is never reused", () => {
      const { s } = fresh({ snap: false });
      const t = (s.boundaries[4] + s.boundaries[5]) / 2;
      s.add(t);
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 10, 6, 7, 8, 9]);
      expect(idAt(s, t)).toBe(10);
      s.remove(5);
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      s.add(t);
      expect(idAt(s, t)).toBe(11);
      s.remove(0);
      expect(ids(s)).toEqual([2, 3, 4, 5, 11, 6, 7, 8, 9]);
    });

    it("an add that is refused takes no id", () => {
      const { s } = fresh({ snap: false });
      s.add(s.boundaries[0] + MIN_SECTION_SEC / 2);
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const t = (s.boundaries[4] + s.boundaries[5]) / 2;
      s.add(t);
      expect(idAt(s, t)).toBe(10);
    });

    it("Snap off then on keeps every id whose boundary survives", () => {
      const { s } = fresh({ snap: false });
      s.move(2, s.boundaries[2] + 0.4);
      s.setSnap(true);
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      s.setSnap(false);
      s.setSnap(true);
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("a re-snap keeps the id of the boundary it came from, and drops the id of a merged one", () => {
      const { p, s } = fresh({ snap: false });
      const d = p.analysis.downbeats;
      const lo = s.boundaries[0];
      const on = d.find((x) => x > lo + 1)!;
      s.move(0, on - 0.3); // two boundaries 0.3 s either side of... the first sits just before a downbeat
      s.move(1, on + 0.3); // ... the second just after it: both snap to `on`
      expect(s.boundaries[1] - s.boundaries[0]).toBeGreaterThanOrEqual(MIN_SECTION_SEC);
      s.setSnap(true);
      expect(s.snapMerged).toBe(1);
      const m = s.markers();
      expect(m).toHaveLength(8);
      expect(m.find((x) => x.time === on)?.id).toBe(1); // the earlier one survives, the later one (id 2) is gone
      expect(m.map((x) => x.id)).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
    });

    // Every boundary of `before` that is still in `after` keeps its id; the others are new, above every earlier id.
    const expectIdsFollow = (before: { id: number; time: number }[], after: { id: number; time: number }[]) => {
      const old = new Map(before.map((m) => [m.time, m.id]));
      const top = Math.max(...before.map((m) => m.id));
      const added: number[] = [];
      for (const m of after) {
        const id = old.get(m.time);
        if (id === undefined) added.push(m.id);
        else expect(m.id).toBe(id);
      }
      for (const id of added) expect(id).toBeGreaterThan(top);
      expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
      return added.length;
    };

    it("setGranularity(0.6) keeps the ids of the boundaries that are still there", () => {
      const { s } = fresh();
      const before = s.markers();
      s.setGranularity(0.6);
      expectIdsFollow(before, s.markers());
      expect(before.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("the Sections slider's added boundaries get fresh ids, and the allin1 ones keep theirs", () => {
      const { s } = fresh({ analysis: repeatingFake(), durationSec: 196 });
      const before = s.markers();
      s.setGranularity(1);
      const added = expectIdsFollow(before, s.markers());
      expect(added).toBeGreaterThan(0);
      expect(s.markers().filter((m) => m.id <= before.length)).toHaveLength(before.length);
      s.setGranularity(-1);
      expect(s.markers()).toEqual([]);
      s.setGranularity(0);
      const back = s.markers();
      expect(back.map((m) => m.time)).toEqual(before.map((m) => m.time));
      expect(Math.min(...back.map((m) => m.id))).toBeGreaterThan(Math.max(...before.map((m) => m.id))); // all dropped at -1: new ids
    });

    it("moving the Sections slider back keeps the first ids, and the ids stay unique", () => {
      const { s } = fresh();
      s.setGranularity(0.6);
      s.setGranularity(0);
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      s.setGranularity(0.6);
      expect(new Set(ids(s)).size).toBe(s.boundaries.length);
    });

    it("snap and target changes under the Sections slider keep the ids of boundaries that survive", () => {
      const BARS = Array.from({ length: 90 }, (_, i) => 1 + 2 * i);
      const s = createStructureState(cannedStructurePayload({ barGrid: BARS, granularity: 0.6 }));
      const first = ids(s);
      s.setSnap(false);
      expect(ids(s)).toEqual(first);
      s.setSnap(true);
      expect(ids(s)).toEqual(first);
      s.setSnapTarget("bars");
      const onBars = s.markers();
      expect(new Set(onBars.map((m) => m.id)).size).toBe(onBars.length);
      expect(onBars.filter((m) => m.id <= first.length).length).toBeGreaterThan(0);
    });

    it("a target switch keeps the id of each boundary it re-snaps", () => {
      const BARS = Array.from({ length: 90 }, (_, i) => 1 + 2 * i);
      const s = createStructureState(cannedStructurePayload({ barGrid: BARS, snapTarget: "downbeats" }));
      const first = ids(s);
      s.setSnapTarget("bars");
      expect(ids(s)).toEqual(first.slice(0, s.boundaries.length));
      expect(s.boundaries.length + s.snapMerged).toBe(first.length);
    });
  });

  describe("slice by (Plan 6: letters always come from all stems)", () => {
    it("is stored, and changes no label, colour or boundary", () => {
      const { s } = fresh();
      const before = { sections: s.sections(), boundaries: [...s.boundaries] };
      for (const by of ["drums", "bass", "vocals", "other", "sections"] as const) {
        s.setSliceBy(by);
        expect(s.sliceBy).toBe(by);
        expect(s.prefs().sliceBy).toBe(by);
        expect(s.sections()).toEqual(before.sections);
        expect(s.boundaries).toEqual(before.boundaries);
      }
    });

    it("never says `no <stem>`, whatever the Slice by or however silent a stem is", () => {
      const base = cannedStructurePayload();
      const quiet = base.analysis.stems.drums.loudnessDb.map(() => -100);
      const silentDrums = { ...base.analysis, stems: { ...base.analysis.stems, drums: { ...base.analysis.stems.drums, loudnessDb: quiet } } };
      for (const analysis of [base.analysis, silentDrums]) {
        const s = createStructureState(cannedStructurePayload({ analysis }));
        for (const by of ["sections", "drums", "bass", "vocals", "other"] as const) {
          s.setSliceBy(by);
          for (const sec of s.sections()) expect(sec.label.startsWith("no "), `${by}: ${sec.label}`).toBe(false);
        }
      }
    });

    it("keeps a rename through setSliceBy", () => {
      const { s } = fresh();
      const initial = s.sections().map((x) => x.label);
      s.rename(2, "Hook");
      s.setSliceBy("bass");
      expect(s.sections()[2].label).toBe("Hook");
      s.setSliceBy("sections");
      expect(s.sections()[2].label).toBe("Hook");
      s.rename(2, initial[2]);
      expect(s.sections().map((x) => x.label)).toEqual(initial);
    });

    it("uniform colour still wins", () => {
      const { p, s } = fresh();
      s.setSliceBy("vocals");
      s.setColorMode("uniform");
      for (const sec of s.sections()) expect(sec.color).toBe(p.sourceColor);
    });

    it("round-trips Slice by and the Patterns level through the payload and prefs()", () => {
      const s = createStructureState(cannedStructurePayload({ sliceBy: "bass", patternLevel: 2 }));
      expect(s.sliceBy).toBe("bass");
      expect(s.patternLevel).toBe(2);
      expect(s.prefs()).toMatchObject({ sliceBy: "bass", patternLevel: 2 });
      expect(s.result()).toMatchObject({ action: "apply", prefs: { sliceBy: "bass", patternLevel: 2 } });
    });

    it("does not touch the lanes, which always group per stem", () => {
      const { s } = fresh();
      const lanes = s.lanes();
      s.setSliceBy("vocals");
      expect(s.lanes()).toBe(lanes);
    });
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe("move and add with snapping skipped for one edit (feedback round 2: Cmd/Ctrl)", () => {
  const onGrid = (t: number) => Math.abs(t / 2 - Math.round(t / 2)) < 1e-9; // the fake's downbeats are every 2 s

  it("free leaves the time as given with snap on; the next edit snaps again; snap stays on", () => {
    const { s } = fresh({ snap: true });
    s.move(3, s.boundaries[3] + 3.3, true);
    expect(onGrid(s.boundaries[3])).toBe(false);
    s.move(5, s.boundaries[5] + 3.3);
    expect(onGrid(s.boundaries[5])).toBe(true);
    s.add(100.7, true);
    expect(s.boundaries).toContain(100.7);
    s.add(120.7);
    expect(s.boundaries).toContain(120);
    expect(s.snap).toBe(true);
    expect(s.prefs().snap).toBe(true);
  });
});

describe("colour follows the letter of a renamed label (feedback round 2, item 2)", () => {
  const colors = (s: ReturnType<typeof createStructureState>) => s.sections().map((x) => x.color);

  it("an added section renamed to a letter in use takes that letter's colour, a primed one its variant colour", () => {
    const { s } = fresh({ snap: false });
    const chorus = s.sections()[CHORUS_1];
    const letter = letterOf(chorus.label);
    s.add((s.boundaries[0] + s.boundaries[1]) / 2); // splits the intro
    const k = 1; // the added half keeps index 1, the new section is 2
    expect(s.sections()[k + 1].color).toBe(s.sections()[k].color);
    s.rename(k + 1, `${letter} - new`);
    expect(s.sections()[k + 1].label).toBe(`${letter} - new`);
    expect(s.sections()[k + 1].color).toBe(groupColor(letterOf(letter).charCodeAt(0) - 65, false, "vivid"));
    expect(s.sections()[k + 1].color).toBe(s.sections()[CHORUS_1 + 1].color);
    for (const prime of ["'", "’", "′"]) {
      s.rename(k + 1, `${letter}${prime}`);
      expect(s.sections()[k + 1].label).toBe(`${letter}${prime}`); // kept as typed
      expect(s.sections()[k + 1].color).toBe(groupColor(letter.charCodeAt(0) - 65, true, "vivid"));
    }
  });

  it("uses the active palette: Soft colours a renamed letter from the Soft rows", () => {
    const { s } = fresh({ snap: false, colorMode: "soft" });
    s.rename(VERSE_1, "E' - mine");
    expect(s.sections()[VERSE_1].color).toBe(groupColor(4, true, "soft"));
    s.setColorMode("groups");
    expect(s.sections()[VERSE_1].color).toBe(groupColor(4, true, "vivid"));
  });

  it("a label with no letter part keeps the computed colour; Clip color colours everything with the clip's", () => {
    const { p, s } = fresh({ snap: false });
    const before = colors(s);
    // Each leaves its letter in use elsewhere, or is the last letter, so no gap closes (that recolours: see below).
    s.rename(VERSE_1, "Breakdown");
    s.rename(6, "a - lower case");
    s.rename(CHORUS_2, "– - quiet");
    expect(colors(s)).toEqual(before);
    s.rename(CHORUS_1, "A");
    s.setColorMode("uniform");
    expect(new Set(colors(s))).toEqual(new Set([p.sourceColor]));
  });

  it("the result carries the colours the bands show, so the clips get them", () => {
    const { s } = fresh({ snap: false });
    s.rename(VERSE_2, "Z'"); // no gaps: the letter after E
    const r = s.result();
    expect(r.action === "apply" && r.sections[VERSE_2].label).toBe("F'");
    expect(r.action === "apply" && r.sections[VERSE_2].color).toBe(groupColor(5, true, "vivid"));
  });
});

describe.skipIf(!process.env.SONG_SECTIONS_PERF)("drag speed on a 20-minute clip", () => {
  it("recomputes letters, hints, colours and lanes for a boundary move in a few ms", () => {
    const p = cannedStructurePayload({ snap: false, durationSec: 1200, analysis: fakeStructureAnalysis(1200) });
    const s = createStructureState(p);
    const step = (k: number) => {
      s.move(4, s.boundaries[4] + (k % 2 ? 0.37 : -0.37));
      s.sections();
      s.lanes();
    };
    step(0); // warm the per-analysis caches, as the first render does
    const per = [0, 1, 2].map(() => {
      const t0 = performance.now();
      for (let k = 0; k < 100; k++) step(k);
      return (performance.now() - t0) / 100;
    });
    const best = Math.min(...per);
    process.stderr.write(`drag step on 1200 s: ${best.toFixed(2)} ms\n`);
    expect(best).toBeLessThan(3);
  });
});

describe("respan: the bands' preview while the letters wait (fix round, review I3)", () => {
  const prev = [
    { start: 0, end: 10, label: "A" },
    { start: 10, end: 30, label: "B" },
    { start: 30, end: 40, label: "C" },
  ];
  it("cuts at the new boundaries and takes each span's label from the old section under its midpoint", () => {
    expect(respan([5, 10, 22, 34], 40, prev)).toEqual([
      { start: 0, end: 5, label: "A" },
      { start: 5, end: 10, label: "A" },
      { start: 10, end: 22, label: "B" },
      { start: 22, end: 34, label: "B" }, // midpoint 28
      { start: 34, end: 40, label: "C" },
    ]);
  });
  it("gives one span for no boundaries, and nothing without a previous section", () => {
    expect(respan([], 40, prev)).toEqual([{ start: 0, end: 40, label: "B" }]);
    expect(respan([10], 40, [])).toEqual([]);
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("slider speed on a 30-minute mix (fix round, review I3)", () => {
  // Over 600 sections, about one per bar: far denser than real music (Flim and Inner City Life have about 45 in 3 to 4
  // minutes), so these are upper bounds. Since 26baf95 the fake's candidates are all under CANDIDATE_FLOOR, so its
  // Sections slider gives 10 sections (final review item 6: these tests had gone stale). The Letters step goes from
  // markers added by hand; a Sections step replaces hand edits, so the Sections tests lift the fake's candidates over
  // the floor instead, and the slider itself reaches the same density.
  const D = 1800;
  const best = (f: (k: number) => void) => {
    f(0); // warm up
    return Math.min(...[0, 1, 2].map(() => {
      const t0 = performance.now();
      for (let k = 1; k <= 3; k++) f(k);
      return (performance.now() - t0) / 3;
    }));
  };
  const strongCandidates = () => {
    const a = fakeStructureAnalysis(D);
    return { ...a, boundaryCandidates: a.boundaryCandidates!.map((c) => ({ ...c, strength: c.strength + CANDIDATE_FLOOR })) };
  };
  /** The fake with a marker added on three downbeats of every four. */
  const handMade = () => {
    const analysis = fakeStructureAnalysis(D);
    const s = createStructureState(cannedStructurePayload({ durationSec: D, analysis }));
    for (const t of analysis.downbeats.filter((_, i) => i % 4 !== 0)) s.add(t);
    return s;
  };
  it("moves the Sections slider's boundaries (what follows the thumb live) in a few ms", () => {
    const s = createStructureState(cannedStructurePayload({ durationSec: D, analysis: strongCandidates() }));
    const sizes = new Set<number>();
    const ms = best((k) => {
      s.setGranularity(0.46 + (k % 2) * 0.04);
      sizes.add(s.boundaries.length);
    });
    expect(Math.max(...sizes)).toBeGreaterThan(600);
    expect(sizes.size).toBe(2); // each step changes the boundaries
    process.stderr.write(`Sections step (boundaries) on ${D} s, about ${Math.max(...sizes) + 1} sections: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(25);
  });
  it("re-letters a Letters step at over 600 sections in a few ms: the linkage is cut, not recomputed", () => {
    const s = handMade();
    expect(s.boundaries.length).toBeGreaterThan(600);
    s.sections();
    s.lanes();
    const ms = best((k) => {
      s.setGroupDist(0.1 + 0.01 * k);
      s.sections();
      s.lanes();
    });
    process.stderr.write(`Letters step on ${s.boundaries.length + 1} sections: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(16);
  });
  it("recomputes letters and lanes for a Sections step at over 600 sections in well under a second", () => {
    const s = createStructureState(cannedStructurePayload({ durationSec: D, analysis: strongCandidates(), granularity: 0.5 }));
    const sizes = new Set<number>();
    const ms = best((k) => {
      s.setGranularity(k % 2 ? 0.5 : 0.46);
      sizes.add(s.boundaries.length);
      s.sections();
      s.lanes();
    });
    expect(Math.min(...sizes)).toBeGreaterThan(600);
    expect(sizes.size).toBe(2);
    process.stderr.write(`Sections step (letters and lanes) on ${D} s, ${s.boundaries.length + 1} sections: ${ms.toFixed(1)} ms\n`);
    // About 3 s before the cached-nearest linkage. Over a frame either way, so the dialog recomputes it on release.
    expect(ms).toBeLessThan(800);
  });
});

// Final review item 8 (Matt, Flim): where allin1's beat tracker goes half-time, snapping to its downbeats left a boundary
// a fraction of a bar off the corrected grid the lengths count on ("5.2.2"). With pattern features the downbeats are the
// corrected grid's bar starts.
describe("snapping on the patterns' corrected grid (final review item 8)", () => {
  /** The canned clip (120 BPM, a bar every 2 s from 2 s) with allin1 half-time from 30 s to 36 s: no downbeat at 32 s. */
  function halfTime(patterns: "canned" | null) {
    const base = cannedStructurePayload();
    const a = base.analysis;
    const inStretch = (t: number) => t > 30 && t < 36;
    const analysis = {
      ...a,
      beats: [...a.beats.filter((t) => !inStretch(t)), 31, 32, 33, 34, 35].sort((x, y) => x - y),
      downbeats: a.downbeats.filter((t) => !inStretch(t) || t === 34),
    };
    const p = cannedStructurePayload({ analysis, patterns: patterns ? base.patterns : null, snap: true, snapTarget: "downbeats" });
    const grid = correctedGrid({ beats: analysis.beats, bars: analysis.downbeats }, base.patterns!.grid);
    return { p, s: createStructureState(p), analysis, grid };
  }

  it("the fixture: allin1 has no downbeat at 32 s, the corrected grid has a bar start there", () => {
    const { analysis, grid } = halfTime("canned");
    expect(analysis.downbeats.filter((t) => t >= 28 && t <= 36)).toEqual([28, 30, 34, 36]);
    expect(grid.bars.filter((t) => t >= 28 && t <= 36)).toEqual([28, 30, 32, 34, 36]);
  });

  // The lengths count on the corrected grid with pattern features (structureLengthGrid, gridChoice.test.ts).
  it("an added boundary snaps to a corrected bar start, and the bands either side read whole bars", () => {
    const { s, grid } = halfTime("canned");
    s.add(32.3);
    expect(s.boundaries).toContain(32);
    const k = s.boundaries.indexOf(32);
    const around = s.sections().slice(k, k + 2);
    expect(around.map((x) => formatLength(x.start, x.end, grid))).toEqual(around.map((x) => expect.stringMatching(/^\d+ bars?$/)));
  });

  it("a move, a lane cut and a re-snap land on it too", () => {
    const { s } = halfTime("canned");
    const i = s.boundaries.findIndex((t) => t > 36);
    s.move(i, 31.8);
    expect(s.boundaries[i]).toBe(32);
    s.insertLaneCut("drums", 37.9);
    expect(s.patternLanes().drums!.some((c) => c.start === 38 && c.owner === "user")).toBe(true);
    const r = halfTime("canned").s;
    r.setSnap(false);
    r.add(32.3);
    r.setSnap(true);
    expect(r.boundaries).toContain(32);
  });

  it("without pattern features, snapping is to allin1's downbeats as before", () => {
    const { s, analysis } = halfTime(null);
    s.add(32.3);
    expect(s.boundaries).toContain(34);
    expect(s.boundaries).not.toContain(32);
    expect(s.boundaries.every((t) => analysis.downbeats.includes(t))).toBe(true);
  });
});

describe("pattern lanes (Plan 6, Task 3)", () => {
  type State = ReturnType<typeof createStructureState>;
  const cutsOf = (lane: LaneCell[]) => lane.slice(1).map((c) => ({ time: c.start, owner: c.owner }));
  const laneOf = (s: State, src: StemName) => s.patternLanes()[src]!;
  /** What the lane's machine cuts must be: the engine's own, through laneCuts with the given added cuts. */
  const machineWanted = (p: ReturnType<typeof cannedStructurePayload>, s: State, src: StemName, added: number[] = []) => {
    const engine = createPatternEngine(p.patterns!);
    const markers = s.markers();
    const machine = engine.machineCuts(src, sectionSpans(markers, p.durationSec), s.patternLevel);
    return laneCuts(markers, machine, { ...NO_EDITS, added }, p.durationSec)
      .filter((c) => c.owner === "machine")
      .map((c) => c.time);
  };
  const machineIn = (lane: LaneCell[]) => cutsOf(lane).filter((c) => c.owner === "machine").map((c) => c.time);

  afterEach(() => vi.restoreAllMocks());

  it("has a lane for each of the 4 stems, in order, and none for the mix (Matt, 4 Nov)", () => {
    const { s } = fresh();
    expect(s.patternSources).toEqual(["drums", "bass", "vocals", "other"]);
    expect(Object.keys(s.patternLanes())).toEqual(s.patternSources);
  });

  it("a clip with only the mix's features has no pattern lanes: the letter lanes, one level, nothing to slice by", () => {
    const f = cannedStructurePayload().patterns!;
    const s = createStructureState(cannedStructurePayload({ patterns: { ...f, sources: { mix: f.sources.mix! } }, sliceBy: "drums" }));
    expect(s.patternSources).toEqual([]);
    expect(s.patternLanes()).toEqual({});
    expect(s.patternSteps()).toEqual([0]);
    expect(s.effectiveSliceBy).toBe("sections");
    expect(s.applyPieces()).toBeNull();
  });

  it("tiles [0, durationSec] in every lane; at level 0 every lane is cut at the section edges only", () => {
    const { p, s } = fresh();
    for (let level = 0; level <= PATTERN_LEVELS; level++) {
      s.setPatternLevel(level);
      for (const [src, lane] of Object.entries(s.patternLanes())) {
        expect(lane[0].start, src).toBe(0);
        expect(lane.at(-1)!.end, src).toBe(p.durationSec);
        for (let i = 1; i < lane.length; i++) expect(lane[i].start, `${src} ${i}`).toBe(lane[i - 1].end);
        expect(lane[0].owner).toBeNull();
      }
    }
    s.setPatternLevel(0);
    const edges = s.sections().map((x) => [x.start, x.end]);
    for (const lane of Object.values(s.patternLanes())) expect(lane.map((c) => [c.start, c.end])).toEqual(edges);
  });

  it("gives equal labels equal colours, a pattern its groupColor, and a rest no label on the dark colour", () => {
    const { s } = fresh();
    for (const level of s.patternSteps()) {
      s.setPatternLevel(level);
      for (const [src, lane] of Object.entries(s.patternLanes())) {
        const byLabel = new Map<string, number>();
        for (const c of lane) {
          if (c.rest) {
            expect(c.label, src).toBe("");
            expect(c.color, src).toBe(0x141414);
            continue;
          }
          const m = /^(\d+)(′?)$/.exec(c.label)!;
          expect(m, `${src} ${c.label}`).not.toBeNull();
          expect(c.color).toBe(groupColor(+m[1] - 1, m[2] === "′", "vivid"));
          const seen = byLabel.get(c.label);
          if (seen === undefined) byLabel.set(c.label, c.color);
          else expect(c.color, `${src} ${c.label}`).toBe(seen);
        }
      }
    }
    expect(laneOf(s, "vocals").some((c) => c.rest)).toBe(true); // the fake's vocals are silent at the ends
  });

  it("colours the lanes Soft under Soft, Vivid otherwise", () => {
    const { s } = fresh();
    s.setColorMode("soft");
    const c = laneOf(s, "drums").find((x) => x.label === "2")!;
    expect(c.color).toBe(groupColor(1, false, "soft"));
    s.setColorMode("uniform");
    expect(laneOf(s, "drums").find((x) => x.label === "2")!.color).toBe(groupColor(1, false, "vivid"));
  });

  it("never wipes his edits when the Patterns slider moves", () => {
    const { s } = fresh();
    const first = s.boundaries[0];
    const second = s.boundaries[1];
    s.insertLaneCut("drums", 7, true);
    s.deleteLaneCut("other", 0); // the marker cut at the first boundary
    const k = cutsOf(laneOf(s, "bass")).findIndex((c) => c.owner === "marker" && c.time === second);
    expect(k).toBeGreaterThan(0);
    s.moveLaneCut("bass", k, second + 1, true);
    const check = (when: string) => {
      expect(cutsOf(laneOf(s, "drums")), when).toContainEqual({ time: 7, owner: "user" });
      expect(cutsOf(laneOf(s, "other")).some((c) => c.time === first), when).toBe(false);
      const bass = cutsOf(laneOf(s, "bass"));
      expect(bass, when).toContainEqual({ time: second + 1, owner: "user" });
      expect(bass.some((c) => c.time === second), when).toBe(false);
    };
    check("before");
    const before = s.patternLanes();
    for (const level of [4, 0, 1]) {
      s.setPatternLevel(level);
      check(`level ${level}`);
    }
    expect(s.patternLanes()).toEqual(before);
  });

  it("moves a marker's cut in every lane that follows it; where he moved it, his time stays", () => {
    const { s } = fresh();
    const m = s.boundaries[2];
    const k = cutsOf(laneOf(s, "bass")).findIndex((c) => c.owner === "marker" && c.time === m);
    s.moveLaneCut("bass", k, m + 1, true);
    s.move(2, m + 2);
    const t = s.boundaries[2];
    expect(t).not.toBe(m);
    for (const src of s.patternSources) {
      const cuts = cutsOf(laneOf(s, src));
      if (src === "bass") {
        expect(cuts).toContainEqual({ time: m + 1, owner: "user" });
        expect(cuts.some((c) => c.owner === "marker" && c.time === t)).toBe(false);
      } else {
        expect(cuts, src).toContainEqual({ time: t, owner: "marker" });
        // the marker's cut is gone from m; a machine cut may land there (the drums: the longer section before t ends
        // in the old section's fill bar and one loop bar, and the bar after the fill is cut off as a leftover)
        expect(cuts.some((c) => c.owner !== "machine" && c.time === m), src).toBe(false);
      }
    }
  });

  it("recomputes the machine cuts when the Sections slider moves, and keeps his cut", () => {
    const { p, s } = fresh();
    s.insertLaneCut("drums", 7, true);
    const seen: number[][] = [];
    for (const g of [0.6, -1]) {
      s.setGranularity(g);
      const lane = laneOf(s, "drums");
      expect(cutsOf(lane), `g ${g}`).toContainEqual({ time: 7, owner: "user" });
      expect(machineIn(lane), `g ${g}`).toEqual(machineWanted(p, s, "drums", [7]));
      seen.push(machineIn(lane));
    }
    expect(seen[1]).not.toEqual(seen[0]); // one section over the whole clip splits differently
  });

  it("snaps his lane move as a marker move is snapped, unless free", () => {
    const { p, s } = fresh(); // snap on, to the downbeats
    const downbeat = 12;
    expect(p.analysis.downbeats).toContain(downbeat);
    const k = cutsOf(laneOf(s, "drums")).findIndex((c) => c.time === 10);
    expect(k).toBeGreaterThan(0);
    s.moveLaneCut("drums", k, downbeat + 0.3);
    expect(cutsOf(laneOf(s, "drums"))[k]).toEqual({ time: downbeat, owner: "user" });
    s.moveLaneCut("drums", k, downbeat + 0.3, true);
    expect(cutsOf(laneOf(s, "drums"))[k]).toEqual({ time: downbeat + 0.3, owner: "user" });
    s.insertLaneCut("drums", 16.6);
    expect(cutsOf(laneOf(s, "drums"))).toContainEqual({ time: 16, owner: "user" }); // 16 is a downbeat
  });

  it("shows exactly the engine's machine cuts, unsnapped", () => {
    // Snap to Bars on a grid of odd seconds: snapping would move every machine cut (all on even seconds) off its place.
    const barGrid = Array.from({ length: 90 }, (_, i) => 2 * i + 1);
    const { p, s } = fresh({ barGrid, snapTarget: "bars" });
    expect(s.snapTarget).toBe("bars");
    for (const level of s.patternSteps()) {
      s.setPatternLevel(level);
      for (const src of s.patternSources) {
        const got = machineIn(laneOf(s, src));
        expect(got, `${src} at ${level}`).toEqual(machineWanted(p, s, src));
        if (level > 0) expect(got.some((t) => !barGrid.includes(t)), src).toBe(true);
      }
    }
  });

  it("keeps a lane cut moved onto the next one at least MIN_SECTION_SEC from it (Review Focus 4)", () => {
    for (const free of [false, true]) {
      const { s } = fresh();
      const cuts = cutsOf(laneOf(s, "drums"));
      const k = 3;
      s.moveLaneCut("drums", k, cuts[k + 1].time, free);
      const after = cutsOf(laneOf(s, "drums"));
      expect(after).toHaveLength(cuts.length);
      for (let i = 1; i < after.length; i++) expect(after[i].time - after[i - 1].time).toBeGreaterThanOrEqual(MIN_SECTION_SEC - 1e-9);
      expect(after[k + 1].time - after[k].time).toBeCloseTo(MIN_SECTION_SEC, 9);
    }
  });

  describe("selection", () => {
    it("selecting a lane cut clears the selected boundary, and selecting a boundary clears it", () => {
      const { s } = fresh();
      s.selected = 2;
      s.selectLaneCut({ source: "drums", index: 1 });
      expect(s.selected).toBeNull();
      expect(s.selectedCut).toEqual({ source: "drums", index: 1 });
      s.selected = 0;
      expect(s.selectedCut).toBeNull();
      s.selectLaneCut({ source: "bass", index: 0 });
      s.move(2, s.boundaries[2] + 2);
      expect(s.selectedCut).toBeNull();
      s.selectLaneCut({ source: "bass", index: 0 });
      s.add((s.boundaries[0] + s.boundaries[1]) / 2);
      expect(s.selected).not.toBeNull();
      expect(s.selectedCut).toBeNull();
      s.selectLaneCut({ source: "bass", index: 0 });
      s.selectLaneCut(null);
      expect(s.selectedCut).toBeNull();
      s.selected = 1;
      s.selectedCut = { source: "other", index: 2 }; // a write, as a view would, clears the boundary too
      expect(s.selected).toBeNull();
      expect(s.selectedCut).toEqual({ source: "other", index: 2 });
      s.selected = 1;
      s.selectedCut = null; // clearing the lane cut leaves the boundary selected
      expect(s.selected).toBe(1);
    });

    it("selects his inserted cut, drops a deleted one, and drops it when the level changes the cuts", () => {
      const { s } = fresh();
      s.insertLaneCut("drums", 7, true);
      const k = cutsOf(laneOf(s, "drums")).findIndex((c) => c.time === 7);
      expect(s.selectedCut).toEqual({ source: "drums", index: k });
      s.deleteLaneCut("drums", k);
      expect(s.selectedCut).toBeNull();
      s.selectLaneCut({ source: "drums", index: 2 });
      s.setPatternLevel(1); // already there: nothing moves
      expect(s.selectedCut).toEqual({ source: "drums", index: 2 });
      s.setPatternLevel(2);
      expect(s.selectedCut).toBeNull();
    });

    it("Task 5: a selected cut stays selected when a machine cut it hid comes back as it moves away", () => {
      const { s } = fresh();
      s.setPatternLevel(2);
      const level2 = cutsOf(laneOf(s, "drums"));
      s.setPatternLevel(1);
      const level1 = cutsOf(laneOf(s, "drums"));
      // A level-2 machine cut m in a 4 s level-1 cell, 2 s from both ends; his own cut, made at level 1, half a second after it.
      const m = level2.find((c) => c.owner === "machine" && level1.some((a) => a.time === c.time - 2) && level1.some((b) => b.time === c.time + 2))!.time;
      expect(m).toBeDefined();
      s.insertLaneCut("drums", m + 0.5, true);
      s.setPatternLevel(2); // m comes in closer than MIN_SECTION_SEC to his cut: his wins, m is hidden
      const k = cutsOf(laneOf(s, "drums")).findIndex((c) => c.owner === "user");
      expect(cutsOf(laneOf(s, "drums")).some((c) => c.time === m)).toBe(false);
      s.selectLaneCut({ source: "drums", index: k });
      s.moveLaneCut("drums", k, m + 1, true); // a second from m: m is back, before his cut
      const after = cutsOf(laneOf(s, "drums"));
      expect(after[k]).toEqual({ time: m, owner: "machine" });
      expect(after[k + 1]).toEqual({ time: m + 1, owner: "user" });
      expect(s.selectedCut).toEqual({ source: "drums", index: k + 1 });
      s.moveLaneCut("drums", s.selectedCut!.index, m + 0.5, true); // the next drag frame goes to his cut (held a second from m), not to m
      expect(cutsOf(laneOf(s, "drums")).slice(k, k + 2)).toEqual([{ time: m, owner: "machine" }, { time: m + 1, owner: "user" }]);
    });
  });

  it("renames every cell of a pattern (its variants with a prime); the rename survives the slider; + with its number puts it back", () => {
    const { s } = fresh();
    const labels = () => laneOf(s, "other").map((c) => c.label);
    const before = labels();
    const i = before.indexOf("2");
    expect(before).toContain("2′");
    const down = { "3": "2", "4": "3", "5": "4", "6": "5", "7": "6" } as Record<string, string>; // no gaps: 2 is free
    const named = (name: string) => before.map((l) => (l === "2" ? name : l === "2′" ? `${name}′` : (down[l] ?? l)));
    s.renamePattern("other", i, "Riff");
    expect(labels()).toEqual(named("Riff"));
    s.setPatternLevel(2);
    s.setPatternLevel(1);
    expect(labels()).toEqual(named("Riff"));
    s.renamePattern("other", before.indexOf("2′"), "Hook′"); // from a variant: the prime is the variant's, not the name's
    expect(labels()).toEqual(named("Hook"));
    s.renamePattern("other", i, "Lick′"); // a prime typed on the base cell is dropped too, so no variant shows ″
    expect(labels()).toEqual(named("Lick"));
    s.renamePattern("other", i, "2", true); // + with 2: the patterns now numbered 2 and up move up, and this one is 2 again
    expect(labels()).toEqual(before);
    expect(laneOf(s, "drums").map((c) => c.label)).toEqual(fresh().s.patternLanes().drums!.map((c) => c.label)); // edits are per lane
  });

  it("colours a pattern named after another like that one, as a section named after a letter is", () => {
    const { s } = fresh();
    const lane = () => laneOf(s, "other");
    const colourOf = (label: string) => lane().find((c) => c.label === label)!.color;
    const before = lane().map((c) => c.label);
    const shades = lane().map((c) => c.color);
    const one = colourOf("1");
    const three = colourOf("3");
    const two = before.indexOf("2");
    expect(colourOf("2")).not.toBe(one);
    s.renamePattern("other", two, "1"); // a number in use: just this cell moves to 1, and takes 1's colour (Matt, 2026-11-12)
    expect(lane()[two].label).toBe("1");
    expect(lane()[two].color).toBe(one);
    expect(lane()[before.indexOf("2′")].color).not.toBe(one); // the rest of 2 stays 2
    expect(lane()[before.indexOf("3")].color).toBe(three);
    s.renamePattern("other", two, "2"); // its own name back
    expect(lane().map((c) => c.color)).toEqual(shades);
    s.renamePattern("other", before.indexOf("1"), "Riff");
    s.renamePattern("other", two, "Riff");
    expect(lane()[two].color).toBe(one); // a name two patterns share wears the lower one's colour
    expect(lane().map((c) => c.label)).toContain("Riff′");
  });

  it("counts lane edits as hand edits, so Re-analyze asks first", () => {
    const { s } = fresh();
    expect(s.handEdited).toBe(false);
    s.insertLaneCut("drums", 7, true);
    expect(s.handEdited).toBe(true);
    s.deleteLaneCut("drums", cutsOf(laneOf(s, "drums")).findIndex((c) => c.time === 7));
    expect(s.handEdited).toBe(false);
    s.renamePattern("other", 1, "Riff");
    expect(s.handEdited).toBe(true);
  });

  it("memoises patternLanes() on the markers' contents, the level, the edits and the palette", () => {
    const { s } = fresh();
    const a = s.patternLanes();
    expect(s.markers()).not.toBe(s.markers());
    expect(s.patternLanes()).toBe(a);
    s.setSliceBy("bass");
    s.setPatternLevel(1);
    expect(s.patternLanes()).toBe(a);
    s.insertLaneCut("drums", 7, true);
    const b = s.patternLanes();
    expect(b).not.toBe(a);
    expect(b.bass).toBe(a.bass); // an edit recomputes its own lane only
    s.setColorMode("soft");
    expect(s.patternLanes()).not.toBe(b);
    s.setPatternLevel(2);
    const c = s.patternLanes();
    expect(c).not.toBe(b);
    s.move(4, s.boundaries[4] + 2);
    expect(s.patternLanes()).not.toBe(c);
  });

  describe("patternSteps: only the levels that change something (Matt)", () => {
    const withoutDrums = (): PatternFeatures => {
      const f = cannedStructurePayload().patterns!;
      const { drums: _, ...sources } = f.sources;
      return { ...f, sources };
    };

    it("on the canned clip: level 2 splits the drums further, and nothing changes above it", () => {
      const { s } = fresh();
      expect(s.patternSteps()).toEqual([0, 1, 2]);
    });

    it("gives [0, 1] when every lane's levels 2 to 4 equal its level 1", () => {
      const s = createStructureState(cannedStructurePayload({ patterns: withoutDrums() }));
      expect(s.patternSources).not.toContain("drums");
      expect(s.patternSteps()).toEqual([0, 1]);
    });

    it("counts the stems only: a level that changes only the mix is no step (Matt, 4 Nov)", () => {
      const f = withoutDrums();
      const s0 = createStructureState(cannedStructurePayload({ patterns: f }));
      expect(s0.patternSteps()).toEqual([0, 1]);
      engineCalls.mixLevels = (levels) => levels.map((cuts, l) => (l >= 2 ? [...cuts, 1.5 * l] : cuts));
      try {
        const s = createStructureState(cannedStructurePayload({ patterns: f }));
        expect(s.patternSteps()).toEqual([0, 1]);
        s.setPatternLevel(4);
        expect(s.patternLevel).toBe(1);
      } finally {
        engineCalls.mixLevels = null;
      }
    });

    it("snaps a remembered level to the nearest step at or below it", () => {
      const s = createStructureState(cannedStructurePayload({ patternLevel: 4 }));
      expect(s.patternLevel).toBe(2);
      expect(createStructureState(cannedStructurePayload({ patternLevel: 3, patterns: withoutDrums() })).patternLevel).toBe(1);
    });

    it("remembers the level it was given until the slider moves, so a clip with fewer steps does not lower it (final review I1)", () => {
      const s = createStructureState(cannedStructurePayload({ patternLevel: 4 }));
      expect(s.patternSteps()).toEqual([0, 1, 2]);
      expect(s.patternLevel).toBe(2); // shown, and the lanes, on this clip's top step
      expect(s.prefs().patternLevel).toBe(4);
      s.add(100); // a marker edit is not a slider move
      s.setGranularity(0.5);
      expect(s.prefs().patternLevel).toBe(4);
      expect(s.result()).toMatchObject({ prefs: { patternLevel: 4 } });
      s.setPatternLevel(1);
      expect(s.patternLevel).toBe(1);
      expect(s.prefs().patternLevel).toBe(1);
      s.setPatternLevel(2);
      expect(s.prefs().patternLevel).toBe(2);
    });

    it("setPatternLevel takes an engine level: rounded, clamped and snapped", () => {
      const { s } = fresh();
      for (const [asked, got] of [
        [3.6, 2],
        [1.4, 1],
        [-1, 0],
        [9, 2],
        [2, 2],
        [0.5, 1],
      ]) {
        s.setPatternLevel(asked);
        expect(s.patternLevel, `asked ${asked}`).toBe(got);
      }
    });

    it("ignores his edits", () => {
      const { s } = fresh();
      s.insertLaneCut("drums", 7, true);
      s.deleteLaneCut("bass", 3);
      expect(s.patternSteps()).toEqual([0, 1, 2]);
    });

    it("follows the markers", () => {
      const { s } = fresh();
      const steps = s.patternSteps();
      expect(s.patternSteps()).toBe(steps); // memoised
      s.setGranularity(-1); // one section over the whole clip
      expect(s.patternSteps()).not.toBe(steps);
      expect(s.patternSteps()[0]).toBe(0);
    });
  });

  describe("previewLanes: the lanes on a marker drag frame (final review item 7)", () => {
    const tiles = (lane: LaneCell[], end: number) => lane[0].start === 0 && lane.at(-1)!.end === end && lane.every((c, i) => i === 0 || c.start === lane[i - 1].end);

    it("is patternLanes() itself until a marker moves", () => {
      const { s } = fresh({ snap: false });
      const lanes = s.patternLanes();
      expect(s.previewLanes()).toBe(lanes);
    });

    it("moves each lane's cut at the dragged marker with it, hides the cuts it passes, and asks the engine nothing", () => {
      const { p, s } = fresh({ snap: false, patternLevel: 2 });
      const before = s.patternLanes();
      const k = 4;
      const from = s.boundaries[k];
      const to = from + 5.3; // past at least one machine cut in some lane
      const passed = Object.values(before).some((lane) => lane!.some((c) => c.owner === "machine" && c.start > from && c.start < to));
      expect(passed).toBe(true);
      s.move(k, to);
      const asked = engineCalls.n;
      const preview = s.previewLanes();
      expect(engineCalls.n).toBe(asked);
      for (const src of s.patternSources) {
        const cells = preview[src]!;
        expect(tiles(cells, p.patterns!.durationSec), src).toBe(true);
        expect(cells.some((c) => c.start === from), src).toBe(false);
        expect(cells.find((c) => c.start === to)?.owner, src).toBe("marker");
        expect(cells.some((c) => c.start > from && c.start < to), src).toBe(false);
        expect(cells.every((c) => c.start === to || Math.abs(c.start - to) >= MIN_SECTION_SEC || c.owner === "marker"), src).toBe(true);
        // A cell away from the marker is as it was.
        const far = before[src]!.filter((c) => c.end < from - 1);
        expect(cells.slice(0, far.length), src).toEqual(far);
      }
    });

    it("after the drop, patternLanes() is exact: as if the marker had been moved with no preview", () => {
      const { s } = fresh({ snap: false, patternLevel: 2 });
      const { s: plain } = fresh({ snap: false, patternLevel: 2 });
      s.patternLanes();
      for (const d of [3, 1.3, 1.8]) {
        s.move(4, s.boundaries[4] + d); // three drag frames
        s.previewLanes();
      }
      plain.move(4, s.boundaries[4]);
      expect(s.boundaries).toEqual(plain.boundaries);
      expect(s.patternLanes()).toEqual(plain.patternLanes());
    });

    it("a lane whose cut at the marker he detached does not follow it", () => {
      const { s } = fresh({ snap: false });
      const k = 4;
      const from = s.boundaries[k];
      const cuts = s.patternLanes().bass!.slice(1);
      const j = cuts.findIndex((c) => c.start === from && c.owner === "marker");
      expect(j).toBeGreaterThanOrEqual(0);
      s.moveLaneCut("bass", j, from - 1, true); // the bass cut is his now, at from - 1
      s.patternLanes();
      s.move(k, from + 2);
      const bass = s.previewLanes().bass!;
      expect(bass.some((c) => c.start === from - 1 && c.owner === "user")).toBe(true);
      expect(bass.some((c) => c.start === from + 2)).toBe(false);
      expect(s.previewLanes().drums!.some((c) => c.start === from + 2 && c.owner === "marker")).toBe(true);
    });

    it("falls back to patternLanes() once a marker was added or removed", () => {
      const { s } = fresh({ snap: false });
      s.patternLanes();
      s.add(100);
      expect(s.previewLanes()).toBe(s.patternLanes());
    });
  });

  it("a Patterns step back to a level visited at the same markers and edits asks the engine nothing (final review item 7)", () => {
    const { p, s } = fresh();
    const engine = createPatternEngine(p.patterns!);
    for (const l of [0, 1, 2]) {
      s.setPatternLevel(l);
      s.patternLanes();
    }
    const lanes = s.patternLanes();
    const asked = engineCalls.n;
    s.setPatternLevel(0);
    const at0 = s.patternLanes();
    s.setPatternLevel(2);
    expect(s.patternLanes()).toEqual(lanes);
    expect(engineCalls.n).toBe(asked);
    expect(at0).not.toEqual(lanes);
    for (const src of s.patternSources) expect(at0[src]!.map((c) => c.start)).toEqual(engine.lane(src, s.markers(), 0, NO_EDITS).map((x) => x.start));
    const before = engineCalls.n; // the lane() calls just above were the test's own engine's
    s.renamePattern("drums", 1, "Beat"); // an edit: that lane is named again, the others are not
    s.setPatternLevel(0);
    s.patternLanes();
    expect(engineCalls.n).toBe(before + 1);
  });

  describe("no pattern features (Review Focus 2)", () => {
    it("with patterns: null there are no pattern lanes, and the v2 lanes are as they were", () => {
      const p = cannedStructurePayload();
      const s = createStructureState({ ...p, patterns: null, patternLevel: 3 });
      expect(s.patternSources).toEqual([]);
      expect(s.patternLanes()).toEqual({});
      expect(s.lanes()).toEqual(createStructureState(p).lanes());
      expect(s.patternSteps()).toEqual([0]);
      expect(s.patternLevel).toBe(3); // remembered for the next clip, as the Sections slider's is (review M4)
      s.insertLaneCut("drums", 7);
      s.moveLaneCut("drums", 0, 9);
      s.deleteLaneCut("drums", 0);
      s.renamePattern("drums", 0, "Riff");
      expect(s.patternLanes()).toEqual({});
      expect(s.handEdited).toBe(false);
    });

    it("with patterns absent, the same", () => {
      const { patterns: _, ...p } = cannedStructurePayload();
      const s = createStructureState(p);
      expect(s.patternSources).toEqual([]);
      expect(s.patternLanes()).toEqual({});
    });

    it("an engine that throws on the features behaves as patterns: null, with a warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const p = cannedStructurePayload();
      const broken = { ...p.patterns!, sources: null } as unknown as PatternFeatures;
      const s = createStructureState({ ...p, patterns: broken, sliceBy: "drums" });
      expect(s.patternSources).toEqual([]);
      expect(s.patternLanes()).toEqual({});
      expect(s.lanes()).toEqual(createStructureState(p).lanes());
      expect(s.effectiveSliceBy).toBe("sections");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/pattern/i);
    });

    it("warns once when the features' duration is off the clip's by more than a cell", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = cannedStructurePayload().patterns!;
      const close = createStructureState(cannedStructurePayload({ patterns: { ...f, durationSec: 180.04 } }));
      close.patternLanes();
      expect(warn).not.toHaveBeenCalled();
      const off = createStructureState(cannedStructurePayload({ patterns: { ...f, durationSec: 181 } }));
      off.patternLanes();
      off.patternSteps();
      off.setPatternLevel(2);
      off.patternLanes();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/181 s long, the clip 180 s/);
    });

    it("a source whose cells do not decode is left out, with the engine's warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = cannedStructurePayload().patterns!;
      const bad = { ...f, sources: { ...f.sources, bass: { ...f.sources.bass!, dims: f.sources.bass!.dims + 1 } } };
      const s = createStructureState(cannedStructurePayload({ patterns: bad }));
      expect(s.patternSources).toEqual(["drums", "vocals", "other"]);
      expect(Object.keys(s.patternLanes())).toEqual(["drums", "vocals", "other"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("bass");
    });
  });

  describe("effective Slice by", () => {
    it("is the remembered Slice by when its source is there", () => {
      for (const by of ["sections", "drums", "bass", "vocals", "other"] as const) {
        const s = createStructureState(cannedStructurePayload({ sliceBy: by }));
        expect(s.effectiveSliceBy).toBe(by);
      }
    });

    it("is Sections for a payload that still says \"mix\" (the removed All), and prefs() then remembers Sections", () => {
      const s = createStructureState(cannedStructurePayload({ sliceBy: "mix" as never }));
      expect(s.sliceBy).toBe("sections");
      expect(s.effectiveSliceBy).toBe("sections");
      expect(s.prefs().sliceBy).toBe("sections");
      expect(s.applyPieces()).toBeNull();
    });

    it("is Sections when the remembered source is missing, while prefs() keeps what was remembered", () => {
      const f = cannedStructurePayload().patterns!;
      const { vocals: _, ...sources } = f.sources;
      const s = createStructureState(cannedStructurePayload({ sliceBy: "vocals", patterns: { ...f, sources } }));
      expect(s.sliceBy).toBe("vocals");
      expect(s.effectiveSliceBy).toBe("sections");
      expect(s.prefs().sliceBy).toBe("vocals");
      s.setSliceBy("bass");
      expect(s.effectiveSliceBy).toBe("bass");
      const none = createStructureState(cannedStructurePayload({ sliceBy: "mix" as never, patterns: null }));
      expect(none.effectiveSliceBy).toBe("sections");
    });

    it("is Sections under Arrangement with Output = Locators, which cuts nothing", () => {
      const s = createStructureState(cannedStructurePayload({ sliceBy: "drums", output: "locators" }));
      expect(s.effectiveSliceBy).toBe("sections");
      s.output = "both";
      expect(s.effectiveSliceBy).toBe("drums");
      const session = createStructureState(cannedStructurePayload({ sliceBy: "drums", output: "locators", view: "session" }));
      expect(session.effectiveSliceBy).toBe("drums");
    });
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("Patterns slider speed on a 10-minute clip (Plan 6, Task 3)", () => {
  const D = 600;
  /** The slowest warm step: every level visited once first, then each step taken again, setPatternLevel plus patternLanes(). */
  const slowestStep = (s: State) => {
    const steps = s.patternSteps();
    const walk = [...steps, ...[...steps].reverse(), ...steps];
    for (const l of walk) {
      s.setPatternLevel(l);
      s.patternLanes();
    }
    return Math.max(
      ...walk.map((l) => {
        const t0 = performance.now();
        s.setPatternLevel(l);
        s.patternLanes();
        return performance.now() - t0;
      }),
    );
  };
  type State = ReturnType<typeof createStructureState>;

  let repetitive: { analysis: StructureAnalysis; patterns: PatternFeatures };
  beforeAll(() => {
    const analysis = fakeStructureAnalysis(D);
    repetitive = { analysis, patterns: fakePatternFeatures(analysis) };
  }, 60_000);

  it("on a repetitive song (fakePatternFeatures(fakeStructureAnalysis(600))), under 80 ms", () => {
    const s = createStructureState(cannedStructurePayload({ durationSec: D, ...repetitive }));
    expect(s.patternSteps().length).toBeGreaterThan(1);
    const ms = slowestStep(s);
    process.stderr.write(`Patterns step on repetitive ${D} s (steps ${s.patternSteps().join(",")}): ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(80);
  });
  // More sections than the engine keeps (KEPT_SECTIONS = 64): a marker every 8 s on the repetitive song (review, Important 1).
  it("on a repetitive song cut into over 64 sections: a marker move under 250 ms, a Patterns step under 80 ms", () => {
    const s = createStructureState(cannedStructurePayload({ durationSec: D, ...repetitive }));
    for (let t = 8; t < D - 4; t += 8) s.add(t);
    expect(s.boundaries.length + 1).toBeGreaterThan(64);
    s.patternSteps();
    s.patternLanes();
    const moves = [2, -2, 2].map((d) => {
      const k = Math.floor(s.boundaries.length / 2);
      const t0 = performance.now();
      s.move(k, s.boundaries[k] + d);
      s.patternSteps();
      s.patternLanes();
      return performance.now() - t0;
    });
    const move = Math.max(...moves);
    const step = slowestStep(s);
    expect(s.patternSteps().length).toBeGreaterThan(1);
    const sections = s.boundaries.length + 1;
    process.stderr.write(`Patterns on ${sections} sections of ${D} s (steps ${s.patternSteps().join(",")}): marker move ${move.toFixed(1)} ms, step ${step.toFixed(1)} ms\n`);
    expect(move).toBeLessThan(250);
    expect(step).toBeLessThan(80);
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("pattern lanes on a 30-minute clip (final review items 6 and 7)", () => {
  const D = 1800;
  let long: { analysis: StructureAnalysis; patterns: PatternFeatures };
  beforeAll(() => {
    const analysis = fakeStructureAnalysis(D);
    long = { analysis, patterns: fakePatternFeatures(analysis) };
  }, 180_000);
  /** The fake's sections with a marker added every 7.7 s: about 240 (the review measured 140 ms of lanes a drag frame at 234). */
  const cut = () => {
    const s = createStructureState(cannedStructurePayload({ durationSec: D, ...long, snap: false }));
    for (let t = 7.7; t < D - 4; t += 7.7) s.add(t);
    expect(s.boundaries.length + 1).toBeGreaterThan(230);
    s.patternSteps();
    s.patternLanes();
    s.sections();
    return s;
  };

  it("a marker drag frame (the move, the letters, the previewed lanes) under 50 ms; the drop makes the lanes exact", () => {
    const s = cut();
    const k = Math.floor(s.boundaries.length / 2);
    const from = s.boundaries[k];
    const frames = Array.from({ length: 21 }, (_, f) => {
      const t0 = performance.now();
      s.move(k, from + 0.25 * (f + 1), true);
      s.sections();
      s.previewLanes();
      return performance.now() - t0;
    }).sort((x, y) => x - y);
    const median = frames[frames.length >> 1];
    const t0 = performance.now();
    const lanes = s.patternLanes();
    s.patternSteps();
    const drop = performance.now() - t0;
    process.stderr.write(`marker drag on ${s.boundaries.length + 1} sections of ${D} s: frame ${median.toFixed(1)} ms (slowest ${frames.at(-1)!.toFixed(1)}), drop ${drop.toFixed(0)} ms\n`);
    expect(median).toBeLessThan(50); // the median: a frame now and then also takes a garbage collection
    for (const src of s.patternSources) expect(lanes[src]!.some((c) => c.start === s.boundaries[k] && c.owner === "marker"), src).toBe(true);
  });

  it("a warm Patterns step under 150 ms", () => {
    const s = cut();
    const steps = s.patternSteps();
    expect(steps.length).toBeGreaterThan(1);
    const walk = [...steps, ...[...steps].reverse(), ...steps];
    for (const l of walk) {
      s.setPatternLevel(l);
      s.patternLanes();
    }
    const ms = Math.max(
      ...walk.map((l) => {
        const t0 = performance.now();
        s.setPatternLevel(l);
        s.patternLanes();
        return performance.now() - t0;
      }),
    );
    process.stderr.write(`Patterns step on ${s.boundaries.length + 1} sections of ${D} s (steps ${steps.join(",")}): ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(150);
  });
});

describe("the Patterns slider's position and a cell's section (Plan 6, Task 4)", () => {
  it("stepIndex: the index of the last step at or below the level, never -1", () => {
    expect(stepIndex([0, 1, 2], 1)).toBe(1);
    expect(stepIndex([0, 2, 4], 3)).toBe(1); // a level a marker edit left between steps shows as the step below
    expect(stepIndex([0, 2, 4], 4)).toBe(2);
    expect(stepIndex([0, 2], 4)).toBe(1);
    expect(stepIndex([0], 3)).toBe(0);
    expect(stepIndex([0, 1], 0)).toBe(0);
  });

  it("sectionAt: the section around a time, clamped to the first and last", () => {
    const spans = [
      { start: 0, end: 10 },
      { start: 10, end: 25 },
      { start: 25, end: 40 },
    ];
    expect(sectionAt(spans, 5)).toBe(0);
    expect(sectionAt(spans, 10)).toBe(1); // an edge belongs to the section it starts
    expect(sectionAt(spans, 24.9)).toBe(1);
    expect(sectionAt(spans, 39)).toBe(2);
    expect(sectionAt(spans, 40)).toBe(2);
    expect(sectionAt(spans, -1)).toBe(0);
    expect(sectionAt([], 3)).toBe(0);
  });
});

describe("applyPieces: what Apply cuts the clip at under Slice by (Plan 6, Task 6)", () => {
  afterEach(() => vi.restoreAllMocks());
  const cell = (start: number, end: number, label: string, color = 0x101010): LaneCell => ({ start, end, label, color, rest: label === "", owner: null });
  /** A state whose drums lane is `cells` (the rest of the state as the canned payload's). */
  const withDrums = (over: Parameters<typeof cannedStructurePayload>[0], cells: (d: number) => LaneCell[]) => {
    const { p, s } = fresh({ sliceBy: "drums", ...over });
    vi.spyOn(s, "patternLanes").mockReturnValue({ ...s.patternLanes(), drums: cells(p.durationSec) });
    return { p, s };
  };

  it("is the Slice by lane's cells, each named `<source> <pattern>` (or its rename) and coloured by its pattern", () => {
    const { p, s } = fresh({ sliceBy: "drums" });
    const lane = s.patternLanes().drums!;
    const k = lane.findIndex((c) => !c.rest);
    s.renamePattern("drums", k, "Groove");
    const pieces = s.applyPieces()!;
    expect(pieces.length).toBeGreaterThan(1);
    for (const x of pieces) expect(x.label).toMatch(/^drums (\d+′?|Groove′?)$/);
    expect(pieces.map((x) => x.label)).toContain("drums Groove");
    const named = s.patternLanes().drums!.filter((c) => !c.rest);
    expect(pieces.map((x) => x.color)).toEqual(expect.arrayContaining(named.map((c) => c.color)));
    expect(pieces[0].start).toBe(0);
    expect(pieces.at(-1)!.end).toBe(p.durationSec);
    expect(s.result()).toMatchObject({ action: "apply", pieces });
    s.setSliceBy("bass");
    expect(s.applyPieces()!.every((x) => /^bass \d+′?$/.test(x.label))).toBe(true);
  });

  it("is null for Slice by Sections, and result() then has no pieces", () => {
    const { s } = fresh();
    expect(s.applyPieces()).toBeNull();
    expect(s.result()).not.toHaveProperty("pieces");
  });

  it("Review Focus 3: is null in Arrangement with Output = Locators, which cuts nothing", () => {
    const { s } = fresh({ sliceBy: "drums", output: "locators" });
    expect(s.applyPieces()).toBeNull();
    expect(s.result()).not.toHaveProperty("pieces");
    expect(s.result()).toMatchObject({ output: "locators" });
  });

  it("Arrangement: a lane `1 . 2` gives two pieces, the first covering the rest", () => {
    const { s } = withDrums({}, (d) => [cell(0, 10, "1", 0x11), cell(10, 14, "", 0x141414), cell(14, d, "2", 0x22)]);
    const d = s.sections().at(-1)!.end;
    expect(s.applyPieces()).toEqual([
      { start: 0, end: 14, label: "drums 1", color: 0x11 },
      { start: 14, end: d, label: "drums 2", color: 0x22 },
    ]);
  });

  it("Arrangement: a leading rest joins the piece after", () => {
    const { s } = withDrums({}, (d) => [cell(0, 5, ""), cell(5, 10, "1", 0x11), cell(10, d, "2", 0x22)]);
    const d = s.sections().at(-1)!.end;
    expect(s.applyPieces()).toEqual([
      { start: 0, end: 10, label: "drums 1", color: 0x11 },
      { start: 10, end: d, label: "drums 2", color: 0x22 },
    ]);
  });

  it("Session: a lane `1 . 2` gives two pieces with a gap", () => {
    const { s } = withDrums({ view: "session" }, (d) => [cell(0, 10, "1", 0x11), cell(10, 14, ""), cell(14, d, "2", 0x22)]);
    const d = s.sections().at(-1)!.end;
    expect(s.applyPieces()).toEqual([
      { start: 0, end: 10, label: "drums 1", color: 0x11 },
      { start: 14, end: d, label: "drums 2", color: 0x22 },
    ]);
  });

  it("under Clip color every piece takes the source clip's colour", () => {
    const { p, s } = withDrums({ colorMode: "uniform" }, (d) => [cell(0, 10, "1", 0x11), cell(10, d, "2", 0x22)]);
    expect(s.applyPieces()!.map((x) => x.color)).toEqual([p.sourceColor, p.sourceColor]);
  });

  it("an all-rest lane gives effectiveSliceBy Sections (nothing to name) and applyPieces null", () => {
    const { s } = withDrums({}, (d) => [cell(0, 10, ""), cell(10, d, "")]);
    expect(s.sliceBy).toBe("drums");
    expect(s.effectiveSliceBy).toBe("sections");
    expect(s.applyPieces()).toBeNull();
    expect(s.result()).not.toHaveProperty("pieces");
  });

  it("Plan 6, Task 7: laneSlices is any lane's cells as a send takes them, rests left out, in either view", () => {
    for (const view of ["arrangement", "session"] as const) {
      const { s } = withDrums({ view }, (d) => [cell(0, 5, ""), cell(5, 10, "1", 0x11), cell(10, 14, ""), cell(14, d, "2", 0x22)]);
      const d = s.sections().at(-1)!.end;
      expect(s.laneSlices("drums")).toEqual([
        { start: 5, end: 10, label: "drums 1", color: 0x11 },
        { start: 14, end: d, label: "drums 2", color: 0x22 },
      ]);
    }
    const { p, s } = withDrums({ colorMode: "uniform", sliceBy: "sections" }, (d) => [cell(0, 10, "1", 0x11), cell(10, d, "")]);
    expect(s.laneSlices("drums")).toEqual([{ start: 0, end: 10, label: "drums 1", color: p.sourceColor }]);
    const rests = withDrums({}, (d) => [cell(0, 10, ""), cell(10, d, "")]);
    expect(rests.s.laneSlices("drums")).toEqual([]);
  });

  describe("features slightly longer than the clip: a last piece the clip's end leaves under MIN_SECTION_SEC", () => {
    const longer = () => {
      const f = cannedStructurePayload().patterns!;
      return { patterns: { ...f, durationSec: f.durationSec + 0.04 } };
    };
    /** The lane runs 0.04 s past the clip; its last cell is 1 s long there, 0.96 s inside the clip. */
    const tail = (d: number, gap: number) => [cell(0, 10, "1", 0x11), cell(10, d - 0.96 - gap, "2", 0x22), ...(gap ? [cell(d - 0.96 - gap, d - 0.96, "")] : []), cell(d - 0.96, d + 0.04, "3", 0x33)];

    it("Arrangement: joins the piece before it", () => {
      const { p, s } = withDrums(longer(), (d) => tail(d, 0));
      const d = p.durationSec;
      expect(s.applyPieces()).toEqual([
        { start: 0, end: 10, label: "drums 1", color: 0x11 },
        { start: 10, end: d, label: "drums 2", color: 0x22 },
      ]);
      const r = s.result() as Extract<ReturnType<typeof s.result>, { action: "apply" }>;
      expect(r.pieces!.every((x) => x.end - x.start >= MIN_SECTION_SEC)).toBe(true);
    });

    it("Session: joins the piece before it when they meet; with a rest between them it is left out", () => {
      const joined = withDrums({ ...longer(), view: "session" }, (d) => tail(d, 0));
      const d = joined.p.durationSec;
      expect(joined.s.applyPieces()).toEqual([
        { start: 0, end: 10, label: "drums 1", color: 0x11 },
        { start: 10, end: d, label: "drums 2", color: 0x22 },
      ]);
      const gapped = withDrums({ ...longer(), view: "session" }, (dd) => tail(dd, 3));
      expect(gapped.s.applyPieces()).toEqual([
        { start: 0, end: 10, label: "drums 1", color: 0x11 },
        { start: 10, end: d - 3.96, label: "drums 2", color: 0x22 },
      ]);
    });
  });
});

describe("letters and pattern numbers never leave a gap; + inserts one (Matt, 2026-11-11)", () => {
  // The fixture: A - start, B - intro, C - verse, D - chorus, C - verse, D - chorus, E - bridge, D - chorus, B - outro, A - end.
  const labels = (s: ReturnType<typeof createStructureState>) => s.sections().map((x) => x.label);
  const BRIDGE = 6;

  it("a letter nothing uses any more closes up: the later letters move down and take their new letter's colour", () => {
    const { s } = fresh({ snap: false });
    const chorusColour = s.sections()[CHORUS_1].color;
    const bridgeColour = s.sections()[BRIDGE].color;
    s.rename(VERSE_1, "B - verse");
    expect(labels(s)[VERSE_2]).toBe("C - verse"); // one C is left
    s.rename(VERSE_2, "B - verse");
    expect(labels(s)).toEqual(["A - start", "B - intro", "B - verse", "C - chorus", "B - verse", "C - chorus", "D - bridge", "C - chorus", "B - outro", "A - end"]);
    expect(s.sections()[CHORUS_1].color).not.toBe(chorusColour);
    expect(s.sections()[CHORUS_1].color).toBe(groupColor(2, false, "vivid"));
    expect(s.sections()[BRIDGE].color).not.toBe(bridgeColour);
  });

  it("a letter past the last one in use becomes the next one", () => {
    const { s } = fresh({ snap: false });
    s.rename(VERSE_2, "Z' - late");
    expect(labels(s)[VERSE_2]).toBe("F' - late");
    s.rename(BRIDGE, "Z - outro"); // E is free once the bridge leaves it: F′ moves down to E′, and Z is then the next
    expect(labels(s)[VERSE_2]).toBe("E' - late");
    expect(labels(s)[BRIDGE]).toBe("F - outro");
  });

  it("with insert, a letter alone that is in use moves it and every later letter up", () => {
    const { s } = fresh({ snap: false });
    const verseColour = s.sections()[VERSE_1].color;
    s.rename(BRIDGE, "C", true);
    expect(labels(s)).toEqual(["A - start", "B - intro", "D - verse", "E - chorus", "D - verse", "E - chorus", "C", "E - chorus", "B - outro", "A - end"]);
    expect(s.sections()[BRIDGE].color).toBe(verseColour);
    expect(s.sections()[VERSE_1].color).toBe(groupColor(3, false, "vivid"));
  });

  it("with insert, anything other than a letter alone just renames: a variant, a word, or a letter nobody uses", () => {
    for (const typed of ["C′ - solo", "C - solo", "C'"]) {
      const { s } = fresh({ snap: false });
      s.rename(BRIDGE, typed, true);
      expect(labels(s)).toEqual(["A - start", "B - intro", "C - verse", "D - chorus", "C - verse", "D - chorus", typed, "D - chorus", "B - outro", "A - end"]);
    }
    const { s } = fresh({ snap: false });
    s.rename(BRIDGE, "F", true); // nobody uses F: no shift, and the gap E left closes
    expect(labels(s)[BRIDGE]).toBe("E");
  });

  it("without insert, a letter alone that is in use joins it", () => {
    const { s } = fresh({ snap: false });
    s.rename(BRIDGE, "C");
    expect(labels(s)).toEqual(["A - start", "B - intro", "C - verse", "D - chorus", "C - verse", "D - chorus", "C", "D - chorus", "B - outro", "A - end"]);
  });

  it("clearing a renamed section gives it its computed label back; labels with no letter take no part", () => {
    const { s } = fresh({ snap: false });
    const before = labels(s);
    s.rename(BRIDGE, "Breakdown");
    expect(labels(s)[BRIDGE]).toBe("Breakdown");
    s.rename(BRIDGE, "");
    expect(labels(s)).toEqual(before);
  });

  describe("pattern numbers", () => {
    const lane = (s: ReturnType<typeof createStructureState>, src: StemName) => s.patternLanes()[src]!.map((c) => c.label);
    const map = (ls: string[], m: Record<string, string>) => ls.map((l) => m[l] ?? l);

    it("a number nothing uses any more closes up, variants included", () => {
      const { s } = fresh();
      const before = lane(s, "other");
      s.renamePattern("other", before.indexOf("4"), "Fill"); // a new name: the whole pattern 4, and 5, 6, 7 move down
      expect(lane(s, "other")).toEqual(map(before, { "4": "Fill", "5": "4", "6": "5", "7": "6" }));
    });

    it("with insert, a number alone that is in use moves it and every later number up", () => {
      const { s } = fresh();
      const before = lane(s, "bass"); // 1, 2, 2′, 1′, 3, 4, 5, 3′
      s.renamePattern("bass", before.indexOf("5"), "2", true);
      expect(lane(s, "bass")).toEqual(map(before, { "2": "3", "2′": "3′", "3": "4", "3′": "4′", "4": "5", "5": "2" }));
    });

    it("with insert, a variant or a name just renames", () => {
      const { s } = fresh();
      const before = lane(s, "other");
      s.renamePattern("other", before.indexOf("7"), "3 - fill", true);
      expect(lane(s, "other")).toEqual(map(before, { "7": "3 - fill" }));
    });

    it("the pattern colours follow the numbers", () => {
      const { s } = fresh();
      const before = s.patternLanes().other!;
      const colourOf = (label: string) => before.find((c) => c.label === label)!.color;
      s.renamePattern("other", before.findIndex((c) => c.label === "7"), "3", true);
      const after = s.patternLanes().other!;
      expect(after.find((c) => c.label === "4")!.color).toBe(colourOf("4"));
      expect(after.filter((c) => c.label === "3").every((c) => c.color === colourOf("3"))).toBe(true);
    });
  });
});

describe("a name's color, from the menu's swatches (Matt, 2026-11-12)", () => {
  it("colors every section with that name, and only those", () => {
    const { s } = fresh({ snap: false });
    s.rename(VERSE_1, "A - verse");
    s.rename(VERSE_2, "A - verse");
    s.rename(CHORUS_1, "B - chorus");
    const before = s.sections().map((x) => x.color);
    s.setNameColor(VERSE_1, 0x5480e4);
    const after = s.sections();
    expect(after[VERSE_1].color).toBe(0x5480e4);
    expect(after[VERSE_2].color).toBe(0x5480e4);
    after.forEach((x, i) => i !== VERSE_1 && i !== VERSE_2 && expect(x.color, `${i} ${x.label}`).toBe(before[i]));
    expect(s.handEdited).toBe(true);
  });

  it("belongs to the name: a section renamed to it takes it, renamed away loses it; case, spacing and prime spelling aside", () => {
    const { s } = fresh({ snap: false });
    s.rename(VERSE_1, "A′ - verse");
    s.setNameColor(VERSE_1, 0x007dc0);
    s.rename(CHORUS_1, "A' -  Verse");
    expect(s.sections()[CHORUS_1].color).toBe(0x007dc0);
    s.rename(VERSE_1, "C - other");
    expect(s.sections()[VERSE_1].color).not.toBe(0x007dc0);
    expect(s.sections()[CHORUS_1].color).toBe(0x007dc0);
  });

  it("null gives the name its automatic color back", () => {
    const { s } = fresh({ snap: false });
    const auto = s.sections()[VERSE_1].color;
    s.setNameColor(VERSE_1, 0xff3636);
    s.setNameColor(VERSE_1, null);
    expect(s.sections()[VERSE_1].color).toBe(auto);
  });

  it("stays as picked under Soft and Vivid; Clip color still colors everything the clip's", () => {
    const { p, s } = fresh({ snap: false, colorMode: "soft" });
    s.setNameColor(VERSE_1, 0x5480e4);
    s.setColorMode("groups");
    expect(s.sections()[VERSE_1].color).toBe(0x5480e4);
    s.setColorMode("uniform");
    for (const x of s.sections()) expect(x.color).toBe(p.sourceColor);
  });

  it("offers the letter's five Live shades and one of every hue, marking the section's color", () => {
    const { s } = fresh({ snap: false, colorMode: "soft" });
    s.rename(VERSE_1, "B - verse");
    const w = s.swatches(VERSE_1);
    expect(w.shades).toEqual(groupShades(1, "soft"));
    expect(w.others).toEqual(OTHER_COLORS.soft);
    expect(w.current).toBe(s.sections()[VERSE_1].color);
    expect(w.picked).toBe(false);
    s.setNameColor(VERSE_1, w.others[4]);
    expect(s.swatches(VERSE_1)).toMatchObject({ current: w.others[4], picked: true });
    s.rename(VERSE_1, "Breakdown");
    expect(s.swatches(VERSE_1).shades).toEqual([]); // no letter, no shades of one
  });
});

describe("a pattern's color, from a lane cell's swatches (Matt, 2026-11-12)", () => {
  type State = ReturnType<typeof createStructureState>;
  const lane = (s: State, src: StemName) => s.patternLanes()[src]!;
  /** A non-rest cell of `src` whose label another cell of that lane shares, and every cell with that label. */
  function twins(s: State, src: StemName) {
    const cells = lane(s, src);
    const k = cells.findIndex((c, i) => !c.rest && cells.findIndex((d) => !d.rest && d.label === c.label) !== i);
    const label = cells[k].label;
    return { k: cells.findIndex((c) => !c.rest && c.label === label), label, same: cells.flatMap((c, i) => (!c.rest && c.label === label ? [i] : [])) };
  }

  it("colors every cell of that pattern in that lane, and nothing else: another stem's same number keeps its color", () => {
    const { s } = fresh({ snap: false });
    const src = s.patternSources.find((x) => twins(s, x).same.length > 1)!;
    const { k, label, same } = twins(s, src);
    const before = Object.fromEntries(s.patternSources.map((x) => [x, lane(s, x).map((c) => c.color)]));
    s.setPatternColor(src, k, 0x5480e4);
    lane(s, src).forEach((c, i) => expect(c.color, `${src} ${i} ${c.label}`).toBe(same.includes(i) ? 0x5480e4 : before[src][i]));
    for (const x of s.patternSources) if (x !== src) expect(lane(s, x).map((c) => c.color), x).toEqual(before[x]);
    expect(s.laneSlices(src).filter((x) => x.label === `${src} ${label}`).every((x) => x.color === 0x5480e4)).toBe(true);
    expect(s.handEdited).toBe(true);
  });

  it("belongs to the pattern's name: a cell renamed to it takes it; null gives the automatic color back", () => {
    const { s } = fresh({ snap: false });
    const src = s.patternSources.find((x) => twins(s, x).same.length > 1)!;
    const { k, label } = twins(s, src);
    const auto = lane(s, src)[k].color;
    s.setPatternColor(src, k, 0x007dc0);
    s.setPatternColor(src, k, null);
    expect(lane(s, src)[k].color).toBe(auto);
    s.setPatternColor(src, k, 0x007dc0);
    const other = lane(s, src).findIndex((c) => !c.rest && c.label !== label);
    s.renamePattern(src, other, label); // may renumber the lane (no gaps), which moves other numbers' hues, not this name's color
    expect(lane(s, src).filter((c) => c.label === label).every((c) => c.color === 0x007dc0)).toBe(true);
  });

  it("offers its number's five Live shades and one of every hue; a rest is not colored", () => {
    const { s } = fresh({ snap: false, colorMode: "soft" });
    const src = s.patternSources[0];
    const cells = lane(s, src);
    const k = cells.findIndex((c) => !c.rest);
    const w = s.patternSwatches(src, k);
    expect(w.shades).toHaveLength(5);
    expect(w.shades).toContain(cells[k].color);
    expect(w.others).toEqual(OTHER_COLORS.soft);
    expect(w).toMatchObject({ current: cells[k].color, picked: false });
    const rest = s.patternSources.flatMap((x) => lane(s, x).flatMap((c, i) => (c.rest ? [[x, i] as const] : [])))[0];
    if (rest) {
      const before = lane(s, rest[0]).map((c) => c.color);
      s.setPatternColor(rest[0], rest[1], 0x5480e4);
      expect(lane(s, rest[0]).map((c) => c.color)).toEqual(before);
    }
  });

  it("Clip color sends every slice in the clip's color", () => {
    const { p, s } = fresh({ snap: false });
    const src = s.patternSources[0];
    s.setPatternColor(src, lane(s, src).findIndex((c) => !c.rest), 0x5480e4);
    s.setColorMode("uniform");
    for (const x of s.laneSlices(src)) expect(x.color).toBe(p.sourceColor);
  });
});

describe("a picked color follows its name when a rename renumbers it (no gaps; Matt, 2026-11-12)", () => {
  it("sections: C's color goes with C when the only B is renamed away and C becomes B", () => {
    const { s } = fresh({ snap: false });
    const n = s.sections().length;
    for (let i = 0; i < n; i++) s.rename(i, i === 1 ? "B - only" : i === 2 ? "C - verse" : "A - rest");
    expect(s.sections()[2].label).toBe("C - verse");
    s.setNameColor(2, 0x5480e4);
    s.rename(1, "A - rest");
    expect(s.sections()[2].label).toBe("B - verse");
    expect(s.sections()[2].color).toBe(0x5480e4);
    expect(s.sections()[1].color).not.toBe(0x5480e4);
  });

  it("patterns: a number's color goes with it when a rename closes a gap below it", () => {
    const { s } = fresh({ snap: false });
    const src = s.patternSources.find((x) => new Set(s.patternLanes()[x]!.filter((c) => !c.rest).map((c) => c.label.replace(/′+$/u, ""))).size >= 3)!;
    const cells = () => s.patternLanes()[src]!;
    const base = (l: string) => l.replace(/′+$/u, "");
    const top = String(Math.max(...cells().filter((c) => !c.rest).map((c) => Number(base(c.label)))));
    const k = cells().findIndex((c) => !c.rest && c.label === top);
    s.setPatternColor(src, k, 0x5480e4);
    const two = cells().findIndex((c) => !c.rest && base(c.label) === "2");
    s.renamePattern(src, two, "Riff"); // a new name: the whole pattern 2, so 2 is free and the numbers above move down
    const moved = String(Number(top) - 1);
    expect(cells()[k].label).toBe(moved);
    expect(cells()[k].color).toBe(0x5480e4);
  });
});

describe("reassigning one pattern cell to a name in use (Matt, 2026-11-12)", () => {
  type State = ReturnType<typeof createStructureState>;
  const labels = (s: State, src: StemName = "other") => s.patternLanes()[src]!.map((c) => (c.rest ? "." : c.label));
  // other, canned: 1 2 2 2 2 2 1 3 3 3 3 3 4 5 6 5 6 5 7 3 … 2′ 2′ 2′ 2′ 2′ 1′ 5 6 5 6 5 7 2 2 2 2 2 1 1

  it("a 2 typed as 2′ makes just that cell 2′, in that pattern's color family; the ASCII and curly primes too", () => {
    for (const typed of ["2′", "2'", "2’"]) {
      const { s } = fresh();
      const before = labels(s);
      const k = before.indexOf("2");
      s.renamePattern("other", k, typed);
      expect(labels(s), typed).toEqual(before.map((l, i) => (i === k ? "2′" : l)));
      const twoPrime = s.patternLanes().other!.find((c, i) => i !== k && c.label === "2′")!;
      expect(s.patternLanes().other![k].color).toBe(twoPrime.color);
    }
  });

  it("a cell typed as another pattern's name moves just that cell; the rest of its pattern stays", () => {
    const { s } = fresh();
    const before = labels(s);
    const k = before.indexOf("3");
    s.renamePattern("other", k, "2");
    expect(labels(s)).toEqual(before.map((l, i) => (i === k ? "2" : l)));
    const two = s.patternLanes().other!.find((c, i) => i !== k && c.label === "2")!;
    expect(s.patternLanes().other![k].color).toBe(two.color);
    expect(s.laneSlices("other").some((x) => x.label === "other 2" && x.start === s.patternLanes().other![k].start)).toBe(true);
  });

  it("works with a renamed pattern's name, and a variant's name, as typed in any case", () => {
    const { s } = fresh();
    const before = labels(s);
    s.renamePattern("other", before.indexOf("2"), "Riff"); // the whole pattern: 2 → Riff, 2′ → Riff′, later numbers move down
    const named = labels(s);
    const k = named.indexOf("2"); // was 3
    s.renamePattern("other", k, "riff′");
    expect(labels(s)).toEqual(named.map((l, i) => (i === k ? "Riff′" : l)));
  });

  it("typing the cell's own name back undoes it", () => {
    const { s } = fresh();
    const before = labels(s);
    const k = before.indexOf("2");
    s.renamePattern("other", k, "2′");
    s.renamePattern("other", k, "2");
    expect(labels(s)).toEqual(before);
    expect(s.handEdited).toBe(false);
  });

  it("no gaps: moving a pattern's last cell away moves the later numbers down", () => {
    const { s } = fresh();
    const before = labels(s);
    const fours = before.flatMap((l, i) => (l === "4" ? [i] : []));
    expect(fours.length).toBeGreaterThan(1);
    s.renamePattern("other", fours[0], "3");
    expect(labels(s)).toEqual(before.map((l, i) => (i === fours[0] ? "3" : l))); // 4 is still in use
    for (const k of fours.slice(1)) s.renamePattern("other", k, "3");
    const down: Record<string, string> = { "4": "3", "5": "4", "6": "5", "7": "6" };
    expect(labels(s)).toEqual(before.map((l) => down[l] ?? l));
  });

  it("survives the Patterns slider, and is per lane", () => {
    const { s } = fresh();
    const before = labels(s);
    const k = before.indexOf("2");
    s.renamePattern("other", k, "2′");
    const level = s.patternLevel;
    const other = s.patternSteps().find((l) => l !== level)!;
    s.setPatternLevel(other);
    s.setPatternLevel(level);
    expect(labels(s)[k]).toBe("2′");
    expect(labels(s, "drums")).toEqual(labels(fresh().s, "drums"));
  });

  it("a name nobody uses still renames the whole pattern, and a typed prime on one is dropped, any spelling", () => {
    const { s } = fresh();
    const before = labels(s);
    s.renamePattern("other", before.indexOf("2"), "Groove'");
    const after = labels(s);
    expect(after.filter((l) => l === "Groove")).toHaveLength(before.filter((l) => l === "2").length);
    expect(after.filter((l) => l === "Groove′")).toHaveLength(before.filter((l) => l === "2′").length);
    expect(after.some((l) => l.includes("'"))).toBe(false);
  });
});

describe("a blank name gives back the automatic one (Matt, 2026-11-12)", () => {
  it("sections: renaming a letter's every section away and then blanking them restores every label", () => {
    const { s } = fresh({ snap: false });
    const labels = () => s.sections().map((x) => x.label);
    const before = labels();
    const cs = before.flatMap((l, i) => (l.startsWith("C ") ? [i] : []));
    expect(cs.length).toBeGreaterThan(1);
    for (const i of cs) s.rename(i, "Mine");
    expect(labels().some((l) => l.startsWith("C ") && !before.some((b, j) => b === l && cs.includes(j)))).toBe(true); // D moved down to C
    for (const i of cs) s.rename(i, "");
    expect(labels()).toEqual(before);
  });

  it("a reassigned pattern cell goes back to its own pattern", () => {
    const { s } = fresh();
    const lane = () => s.patternLanes().other!.map((c) => (c.rest ? "." : c.label));
    const before = lane();
    const k = before.indexOf("3");
    s.renamePattern("other", k, "2′");
    s.renamePattern("other", k, "");
    expect(lane()).toEqual(before);
  });

  it("a pattern renamed to a word, which closed its number's gap, gets its number back and the others move back up", () => {
    const { s } = fresh();
    const lane = () => s.patternLanes().other!.map((c) => (c.rest ? "." : c.label));
    const before = lane();
    const k = before.indexOf("3");
    s.renamePattern("other", k, "Riff");
    expect(lane()).not.toEqual(before);
    s.renamePattern("other", k, "");
    expect(lane()).toEqual(before);
  });
});
