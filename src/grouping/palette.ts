// Live's clip colour palette and the per-group colour scheme (Plan 4, Task 3). Pure; no Node imports.
import type { Rgb } from "../core/types.js";

const rows = [
  "FF94A6 FFA529 CC9927 F7F47C BFFB00 1AFF2F 25FFA8 5CFFE8 8BC5FF 5480E4 92A7FF D86CE4 E553A0 FFFFFF",
  "FF3636 F66C03 99724B FFF034 87FF67 3DC300 00BFAF 19E9FF 10A4EE 007DC0 886CE4 B677C6 FF39D4 D0D0D0",
  "E2675A FFA374 D3AD71 EDFFAE D2E498 BAD074 9BC48D D4FDE1 CDF1F8 B9C1E3 CDBBE4 AE98E5 E5DCE1 A9A9A9",
  "C6928B B78256 99836A BFBA69 A6BE00 7DB04D 88C2BA 9BB3C4 85A5C2 8393CC A595B5 BF9FBE BC7196 7B7B7B",
  "AF3333 A95131 724F41 DBC300 85961F 539F31 0A9C8E 236384 1A2F96 2F52A2 624BAD A34BAD CC2E6E 3C3C3C",
];

/** Live's clip colours: 5 rows x 14 columns. To verify in Live (Plan 4, Task 13). */
export const LIVE_PALETTE: Rgb[][] = rows.map((r) => r.split(" ").map((h) => parseInt(h, 16)));

/** Hue columns in a contrasting order. Column 12 is out (row 0 is darker than row 1), column 13 is grey. */
export const GROUP_COLUMNS = [0, 9, 3, 5, 11, 1, 7, 4, 8, 2, 6, 10];

/**
 * Soft (feedback round 1: Vivid is "quite brutal"): Live's muted row 3 for a base, the lighter row 2 for a variant,
 * so Live keeps the exact colour. The columns run once round the colour wheel from blue (row 3 hues 226, 270, 330, 27,
 * 56, 90, 171, 208 degrees), so neighbouring letters get neighbouring hues; 8 groups, then it wraps. Left out: columns 0 and
 * 11 (their row 2 is darker than row 3, so a variant would not read as lighter), column 2 (4 degrees from column 1,
 * and greyish), column 4 (a fully saturated lime, the one loud colour in row 3), column 7 (4 degrees from column 8)
 * and the grey column 13.
 */
export const SOFT_COLUMNS = [9, 10, 12, 1, 3, 5, 6, 8];

export type Palette = "vivid" | "soft";

export const SILENT_COLOR: Rgb = 0x7b7b7b; // row 3, column 13

/**
 * One palette column per group. Vivid: a variant is the lighter row 0, a base is row 1. Soft: row 2 and row 3 over
 * SOFT_COLUMNS. Silent (null) is grey in both.
 */
export function groupColor(group: number | null, variant: boolean, palette: Palette = "vivid"): Rgb {
  if (group === null) return SILENT_COLOR;
  if (palette === "soft") return LIVE_PALETTE[variant ? 2 : 3][SOFT_COLUMNS[group % SOFT_COLUMNS.length]];
  return LIVE_PALETTE[variant ? 0 : 1][GROUP_COLUMNS[group % GROUP_COLUMNS.length]];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(rgb: Rgb): number {
  const f = (shift: number) => {
    const s = ((rgb >> shift) & 0xff) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(16) + 0.7152 * f(8) + 0.0722 * f(0);
}

/**
 * The menu's shades of a letter (Matt, 2026-11-12): the five rows of its palette column, lightest first. Live snaps a
 * clip's color to its palette, so these are every shade of the letter's hue that Apply can keep.
 */
export function groupShades(group: number, palette: Palette = "vivid"): Rgb[] {
  const column = palette === "soft" ? SOFT_COLUMNS[group % SOFT_COLUMNS.length] : GROUP_COLUMNS[group % GROUP_COLUMNS.length];
  return LIVE_PALETTE.map((row) => row[column]).sort((a, b) => luminance(b) - luminance(a));
}

/** The menu's other colors: one of every hue but the grey, from the row groupColor uses for a base. */
export const OTHER_COLORS: Record<Palette, Rgb[]> = { soft: LIVE_PALETTE[3].slice(0, 13), vivid: LIVE_PALETTE[1].slice(0, 13) };

/** Scale each channel towards 0x14: round(0x14 + (c - 0x14) * clamp(brightness, 0, 1)). */
export function dim(rgb: Rgb, brightness: number): Rgb {
  const k = Math.min(Math.max(brightness, 0), 1);
  const ch = (shift: number) => Math.round(0x14 + (((rgb >> shift) & 0xff) - 0x14) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
