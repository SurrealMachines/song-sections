// The dialog in Live's theme colours, read back in headless Chrome in both schemes (jsdom has no cascade or canvas).
import { describe, expect, it } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog } from "../test/chromeDialog.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE } from "./protocol.js";

const chrome = useChromeDialog();
const [W, H] = DIALOG_SIZE.structure;

/** [r, g, b] in 0..1 from a computed colour: rgb(...) or, after color-mix, color(srgb ...). */
function channels(css: string): number[] {
  const srgb = css.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map(Number);
  return css.match(/[\d.]+/g)!.slice(0, 3).map((v) => Number(v) / 255);
}
const luminance = (css: string) => {
  const [r, g, b] = channels(css).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe.skipIf(!CHROME)("Live's theme (headless Chrome)", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: captions read at 4.5:1 on the panel`, { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
      const page = await chrome.get(ctx).open(cannedStructurePayload(), W, H);
      try {
        await page.scheme(scheme);
        const { panel, captions } = await page.eval<{ panel: string; captions: string[] }>(`({
          panel: getComputedStyle(document.body).backgroundColor,
          captions: [].map.call(document.querySelectorAll(".caption"), function (e) { return getComputedStyle(e).color; })
        })`);
        expect(captions.length).toBeGreaterThan(0);
        for (const c of captions) expect(contrast(c, panel)).toBeGreaterThanOrEqual(4.5);
      } finally {
        await page.close();
      }
    });

    it(`${scheme}: a rest shows the lane, not a colour of its own`, { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
      const page = await chrome.get(ctx).open(cannedStructurePayload(), W, H);
      try {
        await page.scheme(scheme);
        const rests = await page.eval<string[]>(`[].filter.call(document.querySelectorAll(".lane .cell"), function (c) {
          return / rest/.test(c.title);
        }).map(function (c) { return getComputedStyle(c).backgroundColor; })`);
        expect(rests.length).toBeGreaterThan(0);
        for (const r of rests) expect(r).toBe("rgba(0, 0, 0, 0)");
      } finally {
        await page.close();
      }
    });
  }

  it("the waveform redraws when the system switches scheme", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const page = await chrome.get(ctx).open(cannedStructurePayload(), W, H);
    const pixels = `(function () {
      var c = document.querySelector("canvas");
      return Array.from(c.getContext("2d").getImageData(0, c.height >> 1, c.width, 1).data).join();
    })()`;
    try {
      await page.scheme("light");
      const light = await page.eval<string>(pixels);
      await page.scheme("dark");
      expect(await page.eval<string>(pixels)).not.toBe(light);
    } finally {
      await page.close();
    }
  });
});
