import { describe, expect, it } from "vitest";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { PATTERN_LEVELS, PATTERN_SOURCES, isPatternFeatures, type Marker } from "./contract.js";
import { createPatternEngine } from "./engine.js";
import { fakePatternFeatures } from "./fake.js";
import { NO_EDITS } from "./lane.js";

const a = fakeStructureAnalysis(180);
const markers: Marker[] = a.segments.slice(1).map((s, i) => ({ id: i + 1, time: s.start }));

describe("fakePatternFeatures", () => {
  it("is valid PatternFeatures with all 5 sources, over the analysis' length", () => {
    const f = fakePatternFeatures(a);
    expect(isPatternFeatures(f)).toBe(true);
    expect(Object.keys(f.sources).sort()).toEqual([...PATTERN_SOURCES].sort());
    expect(f.durationSec).toBe(a.durationSec);
  });

  it("is memoised per analysis, and deterministic", () => {
    expect(fakePatternFeatures(a)).toBe(fakePatternFeatures(a));
    const short = fakeStructureAnalysis(30);
    expect(fakePatternFeatures(short)).toEqual(fakePatternFeatures(fakeStructureAnalysis(30)));
  });

  it("names more than 1 and fewer than 8 drum patterns at level 1", () => {
    const lane = createPatternEngine(fakePatternFeatures(a)).lane("drums", markers, 1, NO_EDITS);
    const patterns = new Set(lane.flatMap((s) => (s.name.pattern === null ? [] : [s.name.pattern])));
    expect(patterns.size).toBeGreaterThan(1);
    expect(patterns.size).toBeLessThan(8);
  });

  it("leaves the vocals silent in the intro, at every level", () => {
    const engine = createPatternEngine(fakePatternFeatures(a));
    const intro = a.segments.find((s) => s.label === "intro")!;
    for (let level = 0; level <= PATTERN_LEVELS; level++) {
      const inIntro = engine.lane("vocals", markers, level, NO_EDITS).filter((s) => s.start >= intro.start && s.end <= intro.end);
      expect(inIntro.length).toBeGreaterThan(0);
      for (const s of inIntro) expect(s.label, `level ${level} at ${s.start}`).toBeNull();
    }
  });

  it("works for a clip too short for the fake analysis' ten sections", () => {
    const f = fakePatternFeatures(fakeStructureAnalysis(5));
    expect(isPatternFeatures(f)).toBe(true);
    expect(f.durationSec).toBe(5);
  });
});
