// Task 12 I1: with a long clip name the mode picker's buttons (the long-track confirm's Analyse/Back, the download
// Retry) must stay inside the 1000 px dialog. jsdom has no layout engine, so this lays the built dialog out in
// headless Chrome at 1000 x 560 and reads the measurements back. It uses a throwaway profile and is skipped when
// Chrome is not installed.
import { describe, expect, it, type TestContext } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog } from "../test/chromeDialog.js";
import { cannedPayload } from "./fixture.js";
import type { ModeInfo } from "./protocol.js";

export const LONG_NAME = "Bass 01 - Long Arrangement Recording Take 3 (final mix bounce)"; // 62 characters, from the review
const WIDTH = 1000;

const chrome = useChromeDialog();

interface Box {
  label: string;
  left: number;
  right: number;
}
interface Measured {
  innerWidth: number;
  scrollWidth: number;
  buttons: Box[];
  h1: { right: number; truncated: boolean };
}

/** Mounts the Cue dialog in headless Chrome, optionally clicks a tab, and measures the picker's buttons. */
function measure(ctx: TestContext, clipName: string, structure: Partial<ModeInfo["structure"]>, click: string | null): Promise<Measured> {
  const modes: ModeInfo = {
    structure: { available: true, reason: null, cached: false, needsDownload: false, downloadBytes: 190048947, estimateSec: 469, warn: false, ...structure },
  };
  const prelude = `var click = ${JSON.stringify(click)};
  if (click) [].slice.call(document.querySelectorAll("button")).forEach(function (b) { if (b.textContent.trim() === click) b.click(); });`;
  const expr = `(function () {
    var box = function (e) { var r = e.getBoundingClientRect(); return { label: e.textContent.trim(), left: r.left, right: r.right }; };
    var h1 = document.querySelector("h1");
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      buttons: [].slice.call(document.querySelectorAll(".picker .confirm button, .picker .retry button")).map(box),
      h1: { right: h1.getBoundingClientRect().right, truncated: h1.scrollWidth > h1.clientWidth }
    };
  })()`;
  return chrome.get(ctx).measure<Measured>(cannedPayload({ clipName, durationSec: 1440, modes }), WIDTH, 560, expr, prelude);
}

describe.skipIf(!CHROME)("mode picker layout in a 1000 px dialog (headless Chrome)", () => {
  it("lays out at 1000 px", async (ctx) => {
    expect((await measure(ctx, "Short", {}, null)).innerWidth).toBe(WIDTH);
  }, CHROME_TEST_TIMEOUT);

  it("keeps the long-track confirm's Analyse and Back inside the dialog with a long clip name", async (ctx) => {
    const m = await measure(ctx, LONG_NAME, { warn: true }, "Structure");
    expect(m.buttons.map((b) => b.label)).toEqual(["Analyze", "Back"]);
    for (const b of m.buttons) expect(b.right, b.label).toBeLessThanOrEqual(WIDTH - 16);
    expect(m.scrollWidth).toBeLessThanOrEqual(WIDTH);
    expect(m.h1.truncated).toBe(true); // the name gives way, with an ellipsis
  }, CHROME_TEST_TIMEOUT);

  it("the download offer leaves the waveform in view, not crushing the hint into a column", async (ctx) => {
    const prelude = `[].slice.call(document.querySelectorAll("button")).forEach(function (b) { if (b.textContent.trim() === "Structure") b.click(); });`;
    const expr = `(function () {
      var hint = document.querySelector(".hint");
      return { header: document.querySelector("header").getBoundingClientRect().height, offer: !!document.querySelector(".consent"), hintWidth: hint && hint.offsetParent ? hint.getBoundingClientRect().width : null };
    })()`;
    const modes: ModeInfo = { structure: { available: true, reason: null, cached: false, needsDownload: true, downloadBytes: 190048947, estimateSec: 469, warn: false } };
    const m = await chrome.get(ctx).measure<{ header: number; offer: boolean; hintWidth: number | null }>(cannedPayload({ clipName: "02 - Flim", durationSec: 240, modes }), WIDTH, 560, expr, prelude);
    expect(m.offer).toBe(true);
    expect(m.header).toBeLessThan(100);
    expect(m.hintWidth === null || m.hintWidth > 150).toBe(true);
  }, CHROME_TEST_TIMEOUT);

  it("keeps Retry inside the dialog with a long clip name and a long reason", async (ctx) => {
    const reason = "Downloading the analysis models failed (Model download failed: 503 allin1_harmonix_fold3.onnx).";
    const m = await measure(ctx, LONG_NAME, { available: false, retryable: true, reason }, null);
    expect(m.buttons.map((b) => b.label)).toEqual(["Retry"]);
    expect(m.buttons[0].right).toBeLessThanOrEqual(WIDTH - 16);
    expect(m.scrollWidth).toBeLessThanOrEqual(WIDTH);
  }, CHROME_TEST_TIMEOUT);

  it("fb2: keeps the widest progress label, Structure 100%, on one line inside the dialog, suggested, with a long clip name", async (ctx) => {
    // The page polls only over http; here the tab is given its widest label directly.
    const prelude = `var t = document.querySelector(".picker .tab"); t.textContent = "Structure 100%";`;
    const expr = `(function () {
      var tabs = [].slice.call(document.querySelectorAll(".picker .tab")).map(function (e) {
        var r = e.getBoundingClientRect();
        return { label: e.textContent.trim(), right: r.right, height: r.height, overflows: e.scrollWidth > e.clientWidth };
      });
      return { scrollWidth: document.documentElement.scrollWidth, suggest: !!document.querySelector(".picker.suggest"), tabs: tabs };
    })()`;
    const modes: ModeInfo = {
      structure: { available: true, reason: null, cached: false, needsDownload: false, downloadBytes: 190048947, estimateSec: 66, warn: false, suggested: true, background: true },
    };
    const m = await chrome.get(ctx).measure<{ scrollWidth: number; suggest: boolean; tabs: Array<{ label: string; right: number; height: number; overflows: boolean }> }>(
      cannedPayload({ clipName: LONG_NAME, modes }), WIDTH, 560, expr, prelude);
    expect(m.suggest).toBe(true);
    expect(m.tabs.map((t) => t.label)).toEqual(["Structure 100%", "Cue points"]);
    for (const t of m.tabs) {
      expect(t.right, t.label).toBeLessThanOrEqual(WIDTH - 16);
      expect(t.overflows, t.label).toBe(false);
    }
    expect(m.tabs[0].height).toBe(m.tabs[1].height); // one line, like Cue points
    expect(m.scrollWidth).toBeLessThanOrEqual(WIDTH);
  }, CHROME_TEST_TIMEOUT);

  it("does not truncate a short name", async (ctx) => {
    expect((await measure(ctx, "Preview Track", { warn: true }, "Structure")).h1.truncated).toBe(false);
  }, CHROME_TEST_TIMEOUT);
});
