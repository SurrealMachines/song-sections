import { describe, expect, it } from "vitest";
import { shiftForAdd, shiftForRemove } from "./labelShift.js";

describe("labelShift", () => {
  const labels = { 0: "a", 1: "b", 3: "d" };

  it("an add at boundary k keeps section k's label and moves later ones up", () => {
    expect(shiftForAdd(labels, 1)).toEqual({ 0: "a", 1: "b", 4: "d" });
    expect(shiftForAdd(labels, 0)).toEqual({ 0: "a", 2: "b", 4: "d" });
  });

  it("a remove of boundary i keeps section i's label, drops i+1's and moves later ones down", () => {
    expect(shiftForRemove(labels, 0)).toEqual({ 0: "a", 2: "d" });
    expect(shiftForRemove(labels, 2)).toEqual({ 0: "a", 1: "b" });
    expect(shiftForRemove(labels, 1)).toEqual({ 0: "a", 1: "b", 2: "d" });
  });

  it("does not mutate its input", () => {
    const copy = { ...labels };
    shiftForAdd(labels, 0);
    shiftForRemove(labels, 0);
    expect(labels).toEqual(copy);
  });
});
