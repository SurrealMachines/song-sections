import { describe, expect, it } from "vitest";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { labelGroup, letterIndex, letterName, sectionFunction, splitLabel, structureLabel } from "./labels.js";

describe("structureLabel", () => {
  it("marks a variant with a prime", () => {
    expect(structureLabel({ group: 0, variant: true }, "chorus")).toBe("A′ - chorus");
  });
  it("names a plain group", () => {
    expect(structureLabel({ group: 1, variant: false }, "verse")).toBe("B - verse");
  });
  it("uses an en dash for silent sections", () => {
    expect(structureLabel({ group: null, variant: false }, "intro")).toBe("– - intro");
  });
  it("names the silent stem under Group by a stem (Task 13, Live fix 2)", () => {
    expect(structureLabel({ group: null, variant: false }, "solo", "drums")).toBe("no drums - solo");
    expect(structureLabel({ group: null, variant: false }, "intro", "all")).toBe("– - intro");
    expect(structureLabel({ group: 0, variant: true }, "chorus", "bass")).toBe("A′ - chorus");
  });
});

describe("letterName", () => {
  it("runs A..Z then spreadsheet style", () => {
    expect(letterName(0)).toBe("A");
    expect(letterName(25)).toBe("Z");
    expect(letterName(26)).toBe("AA");
    expect(letterName(27)).toBe("AB");
    expect(letterName(51)).toBe("AZ");
    expect(letterName(52)).toBe("BA");
  });
});

describe("sectionFunction", () => {
  const a = fakeStructureAnalysis(180);
  it("finds the chorus in the first chorus span", () => {
    const s = a.segments[3];
    expect(sectionFunction(a, s.start, s.end)).toBe("chorus");
  });
  it("finds each segment's own label on the fake", () => {
    for (const s of a.segments) expect(sectionFunction(a, s.start, s.end)).toBe(s.label);
  });
  it("breaks ties towards the lower index", () => {
    const b = fakeStructureAnalysis(10);
    b.functionProbs = b.functionProbs.map(() => [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5]);
    expect(sectionFunction(b, 0, 5)).toBe("verse");
  });
});

describe("splitLabel (the bands' letter and word, review M2)", () => {
  it("splits the labels structureLabel makes into letter and word", () => {
    expect(splitLabel("A′ - chorus")).toEqual({ letter: "A′", word: " - chorus" });
    expect(splitLabel("AB - verse")).toEqual({ letter: "AB", word: " - verse" });
    expect(splitLabel("– - intro")).toEqual({ letter: "–", word: " - intro" });
    expect(splitLabel("no drums - solo")).toEqual({ letter: "no drums", word: " - solo" });
    expect(splitLabel("C - my own words")).toEqual({ letter: "C", word: " - my own words" });
  });
  it("keeps a rename whose first part is not a letter as one text, so it truncates", () => {
    expect(splitLabel("Breakdown - long")).toEqual({ letter: null, word: "Breakdown - long" });
    expect(splitLabel("Big chorus")).toEqual({ letter: null, word: "Big chorus" });
    expect(splitLabel("a - lower case")).toEqual({ letter: null, word: "a - lower case" });
    expect(splitLabel(" - leading")).toEqual({ letter: null, word: " - leading" });
  });
});

describe("letterIndex and labelGroup (feedback round 2: colour follows the letter)", () => {
  it("letterIndex inverts letterName", () => {
    for (let n = 0; n < 800; n++) expect(letterIndex(letterName(n))).toBe(n);
    expect(letterIndex("A")).toBe(0);
    expect(letterIndex("AA")).toBe(26);
  });

  it("reads the letter part: the whole label, or the part before ' - '", () => {
    expect(labelGroup("B")).toEqual({ group: 1, variant: false });
    expect(labelGroup("C - big chorus")).toEqual({ group: 2, variant: false });
    expect(labelGroup("AB - verse")).toEqual({ group: 27, variant: false });
  });

  it("a variant is a trailing ′, or an ASCII ' or ’ as typed", () => {
    for (const prime of ["′", "'", "’"]) {
      expect(labelGroup(`A${prime}`)).toEqual({ group: 0, variant: true });
      expect(labelGroup(`D${prime} - outro`)).toEqual({ group: 3, variant: true });
    }
  });

  it("any number of primes is a variant, and a dash without the space before it still ends the letter (Matt, 2026-11-12)", () => {
    for (const l of ["A″ - verse", "A'' - verse", "A′′", "A‴ - verse 2"]) expect(labelGroup(l), l).toEqual({ group: 0, variant: true });
    expect(labelGroup("B- outro")).toEqual({ group: 1, variant: false });
  });

  it("no letter part, or one that is not a letter: null", () => {
    for (const l of ["Breakdown", "Breakdown - long", "a - lower case", "A1", "A-B", "– - intro", "no drums - solo", "", " - x", "Big chorus"]) {
      expect(labelGroup(l), l).toBeNull();
    }
  });

  it("splitLabel splits off a letter typed with an ASCII or curly prime too", () => {
    expect(splitLabel("A' - mine")).toEqual({ letter: "A'", word: " - mine" });
    expect(splitLabel("B’ - mine")).toEqual({ letter: "B’", word: " - mine" });
  });
});
