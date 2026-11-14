import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../test/golden.js";
import { estimateTempo } from "./tempo.js";

const post = JSON.parse(readFileSync(`${FIXTURES}/flim_post.json`, "utf8")) as { beats: number[]; bpm: number };

describe("estimateTempo", () => {
  it("matches allin1 on the Flim beats", () => {
    expect(post.bpm).toBe(150);
    expect(estimateTempo(post.beats)).toBe(150);
  });
  it("is null with fewer than 2 beats", () => {
    expect(estimateTempo([1])).toBeNull();
    expect(estimateTempo([])).toBeNull();
  });
  it("takes the mode of the rounded per-interval bpm", () => {
    expect(estimateTempo([0, 0.5, 1, 1.5, 1.9])).toBe(120); // 120, 120, 120, 150
  });
  it("breaks ties toward the larger bpm", () => {
    expect(estimateTempo([0, 0.5, 1, 1.4, 1.8])).toBe(150); // 120 x2, 150 x2
  });
  it("ignores non-positive intervals and gives null when none remain", () => {
    expect(estimateTempo([0, 0.5, 0.5, 1])).toBe(120);
    expect(estimateTempo([1, 1, 1])).toBeNull();
  });
});
