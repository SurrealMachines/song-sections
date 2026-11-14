// Matt, 4 Nov: "Arrows on sliders when selected are hard to see (black on black)." Patchbay fills a focused or dragged
// slider's thumb with --indicator-active-color, black by default. The dialog sets it to the selected tab's colour, Live's
// ChosenDefault (liveTheme.css). Read back in headless Chrome (light scheme), where the pseudo-element is real.
import { describe, expect, it } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog } from "../test/chromeDialog.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE } from "./protocol.js";

const chrome = useChromeDialog();

/** Per slider (Sections, Letters, Patterns): its thumb's fill, whether it is focused, and its opacity. */
const PROBE = `(function () {
  return [].map.call(document.querySelectorAll(".range .slider"), function (s) {
    var thumb = s.querySelector(".slider__thumb");
    return {
      label: s.querySelector("input").getAttribute("aria-label"),
      focused: s.dataset.focused === "true",
      fill: getComputedStyle(thumb, "::before").backgroundColor,
      opacity: getComputedStyle(s).opacity
    };
  });
})()`;

type Thumb = { label: string; focused: boolean; fill: string; opacity: string };
const INK = "rgb(18, 18, 18)"; // --indicator-color, Live's ControlForeground: the thumb at rest
const YELLOW = "rgb(255, 185, 1)"; // the selected tab's ChosenDefault, #ffb901
const [W, H] = DIALOG_SIZE.structure;

describe.skipIf(!CHROME)("slider thumbs (headless Chrome)", () => {
  it("at rest the text colour; focused or dragged the selected tab's yellow", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const payload = cannedStructurePayload();
    const rest = await chrome.get(ctx).measure<Thumb[]>(payload, W, H, PROBE);
    expect(rest.map((t) => t.label)).toEqual(["Sections", "Letters", "Patterns"]);
    for (const t of rest) expect(t).toMatchObject({ focused: false, fill: INK });

    for (const label of ["Sections", "Letters", "Patterns"]) {
      const on = await chrome.get(ctx).measure<Thumb[]>(payload, W, H, PROBE, `document.querySelector('input[aria-label="${label}"]').focus()`);
      for (const t of on) expect(t).toMatchObject({ focused: t.label === label, fill: t.label === label ? YELLOW : INK });
    }
  });

  it("a disabled slider keeps its thumb colour, dimmed", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const payload = cannedStructurePayload({ patterns: null });
    const rest = await chrome.get(ctx).measure<Thumb[]>(payload, W, H, PROBE);
    const patterns = rest.find((t) => t.label === "Patterns")!;
    expect(patterns).toMatchObject({ fill: INK, opacity: "0.5" });
  });
});
