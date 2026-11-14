import { describe, expect, it } from "vitest";
import { secondsToBeats, secondsToMarkerDelta } from "./time.js";

describe("time", () => {
  it("secondsToBeats(30, 120) === 60", () => {
    expect(secondsToBeats(30, 120)).toBe(60);
  });
  it("warped markers are in beats", () => {
    expect(secondsToMarkerDelta(30, true, 120)).toBe(60);
  });
  it("unwarped markers are in seconds", () => {
    expect(secondsToMarkerDelta(30, false, 120)).toBe(30);
  });
});
