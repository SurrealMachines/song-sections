import { describe, expect, it } from "vitest";
import { closeGaps, insertKey, isBareKey, letterKey, numberKey } from "./renumber.js";

describe("letterKey", () => {
  it("reads the letter before LABEL_SEP, or a whole label that is a letter, keeping the prime's spelling", () => {
    expect(letterKey("C - solo")?.key).toBe(2);
    expect(letterKey("B′ - inst")?.key).toBe(1);
    expect(letterKey("C")?.key).toBe(2);
    expect(letterKey("AA - coda")?.key).toBe(26);
    expect(letterKey("B' - x")?.with(3)).toBe("D' - x");
    expect(letterKey("B’")?.with(0)).toBe("A’");
  });

  it("is null for a label with no letter: the en dash, `no drums`, a free word", () => {
    for (const l of ["– - intro", "no drums - solo", "Breakdown - long", "Breakdown", ""]) expect(letterKey(l)).toBeNull();
  });
});

describe("numberKey", () => {
  it("reads a pattern number (whole name or before LABEL_SEP), zero-based", () => {
    expect(numberKey("3")?.key).toBe(2);
    expect(numberKey("12 - fill")?.key).toBe(11);
    expect(numberKey("2′")?.with(3)).toBe("4′");
    expect(numberKey("Groove")).toBeNull();
    expect(numberKey("0")).toBeNull();
  });
});

describe("isBareKey", () => {
  it("is true only for the letter or number alone", () => {
    expect(isBareKey("C", letterKey)).toBe(true);
    expect(isBareKey(" C ", letterKey)).toBe(true);
    expect(isBareKey("C′", letterKey)).toBe(false);
    expect(isBareKey("C - solo", letterKey)).toBe(false);
    expect(isBareKey("3", numberKey)).toBe(true);
    expect(isBareKey("3 - fill", numberKey)).toBe(false);
  });
});

describe("closeGaps (Matt: no gaps, ever)", () => {
  it("moves later letters down over a letter nothing uses, keeping words and primes", () => {
    expect(closeGaps(["A - intro", "B - verse", "B′ - verse", "D - end", "E′ - out"], letterKey)).toEqual([
      "A - intro",
      "B - verse",
      "B′ - verse",
      "C - end",
      "D′ - out",
    ]);
  });

  it("closes a gap at the start, and leaves labels with no letter alone", () => {
    expect(closeGaps(["B - a", "– - silent", "Breakdown", "C - b"], letterKey)).toEqual(["A - a", "– - silent", "Breakdown", "B - b"]);
  });

  it("returns the same array when there is no gap", () => {
    const labels = ["A", "B - x", "A′"];
    expect(closeGaps(labels, letterKey)).toBe(labels);
  });

  it("works on pattern numbers", () => {
    expect(closeGaps(["1", "2", "4", "4 - fill", "5"], numberKey)).toEqual(["1", "2", "3", "3 - fill", "4"]);
  });
});

describe("insertKey (the + in the rename list)", () => {
  it("moves the typed letter and every later one up, so the typed one is free", () => {
    expect(insertKey(["A - intro", "B - verse", "C - solo", "D - end"], letterKey, 2)).toEqual(["A - intro", "B - verse", "D - solo", "E - end"]);
  });

  it("works on pattern numbers, variants included", () => {
    expect(insertKey(["1", "2", "2′", "3"], numberKey, 1)).toEqual(["1", "3", "3′", "4"]);
  });
});
