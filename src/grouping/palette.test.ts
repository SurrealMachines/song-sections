import { describe, expect, it } from "vitest";
import { GROUP_COLUMNS, LIVE_PALETTE, OTHER_COLORS, SILENT_COLOR, SOFT_COLUMNS, dim, groupColor, groupShades } from "./palette.js";

const lum = (c: number) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f((c >> 16) & 255) + 0.7152 * f((c >> 8) & 255) + 0.0722 * f(c & 255);
};

describe("LIVE_PALETTE", () => {
  it("is 5 rows of 14", () => {
    expect(LIVE_PALETTE).toHaveLength(5);
    for (const r of LIVE_PALETTE) expect(r).toHaveLength(14);
  });
  it("has the silent grey at row 3, column 13", () => {
    expect(LIVE_PALETTE[3][13]).toBe(SILENT_COLOR);
    expect(SILENT_COLOR).toBe(0x7b7b7b);
  });
});

describe("groupColor", () => {
  it("uses row 1 for a base and row 0 for a variant", () => {
    expect(groupColor(0, false)).toBe(0xff3636);
    expect(groupColor(0, true)).toBe(0xff94a6);
  });
  it("wraps after 12 groups", () => {
    expect(groupColor(12, false)).toBe(groupColor(0, false));
  });
  it("gives silent sections the grey", () => {
    expect(groupColor(null, false)).toBe(0x7b7b7b);
    expect(groupColor(null, true)).toBe(0x7b7b7b);
  });
  it("makes the variant lighter than the base in every group column", () => {
    expect(GROUP_COLUMNS).toHaveLength(12);
    for (const c of GROUP_COLUMNS) expect(lum(LIVE_PALETTE[0][c])).toBeGreaterThan(lum(LIVE_PALETTE[1][c]));
  });
  it("has 12 distinct base colours", () => {
    expect(new Set(Array.from({ length: 12 }, (_, g) => groupColor(g, false))).size).toBe(12);
  });
});

/** Hue in degrees, 0..360. */
const hue = (c: number) => {
  const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const saturation = (c: number) => {
  const ch = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const max = Math.max(...ch);
  return max === 0 ? 0 : (max - Math.min(...ch)) / max;
};

describe("groupColor, Soft (feedback round 1)", () => {
  it("is Live's own muted rows: row 3 for a base, the lighter row 2 for a variant", () => {
    for (let g = 0; g < SOFT_COLUMNS.length; g++) {
      expect(groupColor(g, false, "soft")).toBe(LIVE_PALETTE[3][SOFT_COLUMNS[g]]);
      expect(groupColor(g, true, "soft")).toBe(LIVE_PALETTE[2][SOFT_COLUMNS[g]]);
      expect(lum(groupColor(g, true, "soft"))).toBeGreaterThan(lum(groupColor(g, false, "soft")));
    }
  });
  it("keeps silent sections grey", () => {
    expect(groupColor(null, false, "soft")).toBe(SILENT_COLOR);
    expect(groupColor(null, true, "soft")).toBe(SILENT_COLOR);
  });
  it("leaves out the grey column and the one saturated colour in the muted row", () => {
    expect(SOFT_COLUMNS).not.toContain(13);
    for (const c of SOFT_COLUMNS) expect(saturation(LIVE_PALETTE[3][c]), `column ${c}`).toBeLessThan(0.7);
  });
  it("walks once round the colour wheel: each next letter is the next hue, a small step on", () => {
    const bases = SOFT_COLUMNS.map((_, g) => groupColor(g, false, "soft"));
    expect(new Set(bases).size).toBe(SOFT_COLUMNS.length);
    let turned = 0;
    for (let g = 0; g < bases.length; g++) {
      const step = (hue(bases[(g + 1) % bases.length]) - hue(bases[g]) + 360) % 360;
      expect(step, `step after group ${g}`).toBeGreaterThan(10); // not the same hue twice
      expect(step, `step after group ${g}`).toBeLessThanOrEqual(90); // a neighbour, not a contrast
      turned += step;
    }
    expect(turned).toBeCloseTo(360, 6); // exactly one turn, all in one direction
  });
  it("wraps after the last column", () => {
    expect(groupColor(SOFT_COLUMNS.length, false, "soft")).toBe(groupColor(0, false, "soft"));
  });
  it("defaults to Vivid", () => {
    expect(groupColor(3, true)).toBe(groupColor(3, true, "vivid"));
  });
});

describe("dim", () => {
  it("is identity at 1 and 0x141414 at 0", () => {
    for (const x of [0xff3636, 0x7b7b7b, 0x000000, 0xffffff]) {
      expect(dim(x, 1)).toBe(x);
      expect(dim(x, 0)).toBe(0x141414);
    }
  });
  it("clamps brightness and scales towards 0x14", () => {
    expect(dim(0xffffff, 2)).toBe(0xffffff);
    expect(dim(0xffffff, -1)).toBe(0x141414);
    expect(dim(0xffffff, 0.5)).toBe(0x8a8a8a); // 0x14 + 0xEB * 0.5 = 137.5 -> 138
  });
});

describe("groupShades and OTHER_COLORS (the swatches, Matt 2026-11-12)", () => {
  for (const palette of ["soft", "vivid"] as const) {
    it(`${palette}: a letter's whole Live column, lightest first, its base among them`, () => {
      for (let g = 0; g < 12; g++) {
        const shades = groupShades(g, palette);
        const columns = palette === "soft" ? SOFT_COLUMNS : GROUP_COLUMNS;
        expect(new Set(shades)).toEqual(new Set(LIVE_PALETTE.map((row) => row[columns[g % columns.length]])));
        for (let i = 1; i < shades.length; i++) expect(lum(shades[i - 1])).toBeGreaterThanOrEqual(lum(shades[i]));
        expect(shades).toContain(groupColor(g, false, palette));
        expect(shades).toContain(groupColor(g, true, palette));
      }
    });
  }

  it("one colour of every hue but the grey, from the palette's base row", () => {
    expect(OTHER_COLORS.soft).toEqual(LIVE_PALETTE[3].slice(0, 13));
    expect(OTHER_COLORS.vivid).toEqual(LIVE_PALETTE[1].slice(0, 13));
  });
});
