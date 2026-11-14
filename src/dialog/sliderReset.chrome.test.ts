// Matt (Live, 4 Nov): a double-click on a slider resets it. The jsdom test (sliderReset.dom.test.ts) sends the event; this
// one double-clicks the built dialog in headless Chrome with trusted mouse input, so the press on the track, dragOnly
// and the browser's own range-input behaviour are all in play. Skipped when Chrome is not installed.
import { describe, expect, it } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog } from "../test/chromeDialog.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE } from "./protocol.js";
import { createStructureState } from "./structureState.js";

const chrome = useChromeDialog();

describe.skipIf(!CHROME)("double-click a slider (headless Chrome)", () => {
  it("resets Sections, Letters and Patterns by a real double-click on the track, and adds no boundary", async (ctx) => {
    const payload = cannedStructurePayload();
    const page = await chrome.get(ctx).open(payload, ...DIALOG_SIZE.structure);
    try {
      const value = (label: string) => page.eval<string>(`document.querySelector('input[type=range][aria-label="${label}"]').value`);
      const handles = () => page.eval<number>(`document.querySelectorAll("[role=slider]").length`);
      const centre = (label: string) => page.centre(`input[type=range][aria-label="${label}"]`);
      expect([await value("Sections"), await value("Letters"), await value("Patterns")]).toEqual(["0", "0.15", "1"]);
      for (const label of ["Sections", "Letters", "Patterns"]) {
        const c = await centre(label);
        await page.dblclick(c.x, c.y);
        await page.settle(100);
      }
      expect([await value("Sections"), await value("Letters"), await value("Patterns")]).toEqual(["-0.14", "0.22", "2"]);
      // Matt (Live, 12 Nov): the value reset but the thumb stayed put. Patchbay draws the thumb from the input's value
      // into --slider-value on its [data-slider]: it must be the reset value's place on the track.
      for (const label of ["Sections", "Letters", "Patterns"]) {
        const drawn = await page.eval<{ ratio: number; want: number }>(`(function () {
          var input = document.querySelector('input[type=range][aria-label="${label}"]');
          var root = input.closest("[data-slider]");
          var min = Number(input.min), max = Number(input.max), v = Number(input.value);
          return { ratio: Number(root.style.getPropertyValue("--slider-value")), want: (v - min) / (max - min) };
        })()`);
        expect(drawn.ratio, label).toBeCloseTo(drawn.want, 6);
      }
      // The boundaries are those of Sections at -0.14: no double-click added a handle.
      expect(await handles()).toBe(createStructureState({ ...payload, granularity: -0.14 }).boundaries.length);
    } finally {
      await page.close();
    }
  }, CHROME_TEST_TIMEOUT);
});
