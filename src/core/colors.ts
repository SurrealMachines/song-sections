import type { ColorMode, Rgb } from "./types.js";

const START_HUE = 210;
const END_HUE = 30;
const SATURATION = 0.65;
const LIGHTNESS = 0.55;

/** HSL (hue in degrees, s and l in 0-1) to packed 0xRRGGBB with rounded channels. */
function hslToRgb(hue: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hPrime < 1) [r, g, b] = [c, x, 0];
  else if (hPrime < 2) [r, g, b] = [x, c, 0];
  else if (hPrime < 3) [r, g, b] = [0, c, x];
  else if (hPrime < 4) [r, g, b] = [0, x, c];
  else if (hPrime < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const channel = (v: number) => Math.round((v + m) * 255);
  return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

/** n section colours, hue sweeping linearly from 210 to 30 degrees. */
export function gradientColors(n: number): Rgb[] {
  if (n === 1) return [hslToRgb(START_HUE, SATURATION, LIGHTNESS)];
  return Array.from({ length: n }, (_, i) => {
    const hue = START_HUE + ((END_HUE - START_HUE) * i) / (n - 1);
    return hslToRgb(hue, SATURATION, LIGHTNESS);
  });
}

export function colorsFor(mode: ColorMode, n: number, sourceColor: Rgb): Rgb[] {
  if (mode === "uniform") return Array.from({ length: n }, () => sourceColor);
  return gradientColors(n);
}

/** Live takes packed 0xRRGGBB on set (it snaps to its palette). */
export function toLiveColor(rgb: Rgb): number {
  return rgb;
}

/** Live's clip.color getter returns a bigint; normalise to a packed RGB number. */
export function fromLiveColor(value: number | bigint): Rgb {
  return Number(value);
}
