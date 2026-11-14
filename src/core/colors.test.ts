import { describe, expect, test } from "vitest";
import { colorsFor, fromLiveColor, gradientColors, toLiveColor } from "./colors.js";
import type { Rgb } from "./types.js";

/** Hue in degrees (0-360) of a packed 0xRRGGBB colour. */
function hueOf(rgb: Rgb): number {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("gradientColors", () => {
  test("hue runs from 210 to 30 degrees across the sections", () => {
    const colors = gradientColors(3);
    expect(colors).toHaveLength(3);
    expect(Math.abs(hueOf(colors[0]!) - 210)).toBeLessThanOrEqual(1);
    expect(Math.abs(hueOf(colors[2]!) - 30)).toBeLessThanOrEqual(1);
    expect(new Set(colors).size).toBe(3);
  });

  test("a single section gets the start hue", () => {
    const colors = gradientColors(1);
    expect(colors).toHaveLength(1);
    expect(Math.abs(hueOf(colors[0]!) - 210)).toBeLessThanOrEqual(1);
  });

  test("every colour is a valid 0xRRGGBB integer", () => {
    for (const c of gradientColors(7)) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffffff);
    }
  });
});

describe("colorsFor", () => {
  test("uniform repeats the source colour", () => {
    expect(colorsFor("uniform", 4, 0x123456)).toEqual([0x123456, 0x123456, 0x123456, 0x123456]);
  });

  test("gradient ignores the source colour", () => {
    expect(colorsFor("gradient", 3, 0x123456)).toEqual(gradientColors(3));
  });
});

describe("Live colour conversion", () => {
  test("toLiveColor(fromLiveColor(x)) round-trips packed RGB", () => {
    for (const x of [0x000000, 0xff3636, 0x1aff2f, 0x3c3c3c, 0xffffff]) {
      expect(toLiveColor(fromLiveColor(x))).toBe(x);
    }
  });

  test("fromLiveColor converts the bigint returned by the Live getter", () => {
    expect(fromLiveColor(0xff3636n)).toBe(0xff3636);
    expect(toLiveColor(fromLiveColor(0xff3636n))).toBe(0xff3636);
  });
});
