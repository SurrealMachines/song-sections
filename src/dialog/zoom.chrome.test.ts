// fb3, items 3-5 in headless Chrome at the real dialog sizes, with trusted input: at 8x zoom the bands, handles,
// stem lanes and playhead line up with the view; a handle dragged to an edge scrolls it; with a handle selected the
// arrows reach neither the slider nor the tabs; a 30-minute clip redraws smoothly. Also saves the fb3 screenshot.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { CHROME, CHROME_TEST_TIMEOUT, silentWav, useChromeDialog, type ChromePage } from "../test/chromeDialog.js";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE, type DialogPayload } from "./protocol.js";

const chrome = useChromeDialog();
const T = { timeout: CHROME_TEST_TIMEOUT };
const CMD = 4;
const SHIFT = 8;
/** -208 px of Cmd+scroll is e^2.08 = 8x (zoom.ts wheelZoomFactor). */
const ZOOM_8X = -100 * Math.log(8);
/** Where the fb3 screenshot goes (the reports folder of this session); unset, it is not taken. */
const SHOT = process.env.SONG_SECTIONS_FB3_SHOT;

interface Geo {
  tl: { left: number; width: number; y: number };
  handles: { t: number; x: number; visible: boolean }[];
  bands: { left: number; right: number; title: string }[];
  cells: { left: number; right: number }[];
  thumb: { left: number; width: number } | null;
}

const GEO = `(function () {
  var r = function (e) { return e.getBoundingClientRect(); };
  var tl = r(document.querySelector(".timeline"));
  var wf = r(document.querySelector(".waveform"));
  var thumb = document.querySelector(".scroll .thumb");
  return {
    tl: { left: tl.left + 1, width: tl.width - 2, y: wf.top + wf.height / 2 },
    handles: [].map.call(document.querySelectorAll("[role=slider]"), function (h) {
      var b = r(h);
      return { t: Number(h.getAttribute("aria-valuenow")), x: b.left + b.width / 2, visible: getComputedStyle(h).visibility !== "hidden" };
    }),
    bands: [].map.call(document.querySelectorAll(".band"), function (b) { return { left: r(b).left, right: r(b).right, title: b.title }; }),
    cells: [].map.call(document.querySelectorAll(".lane[data-stem=vocals] .cell"), function (c) { return { left: r(c).left, right: r(c).right }; }),
    thumb: thumb && { left: r(thumb).left, width: r(thumb).width }
  };
})()`;

async function open(ctx: TestContext, payload: DialogPayload, audioSec = 4) {
  const page = await chrome.get(ctx).open({ ...payload, audioUrl: silentWav(audioSec) }, ...DIALOG_SIZE[payload.mode]);
  return page;
}

const geo = (page: ChromePage) => page.eval<Geo>(GEO);
/** The view the scrollbar's thumb shows (it spans the timeline's width). */
function viewOf(g: Geo, duration: number) {
  return { start: ((g.thumb!.left - g.tl.left) / g.tl.width) * duration, span: (g.thumb!.width / g.tl.width) * duration };
}

describe.skipIf(!CHROME)("8x zoom (fb3, item 5; headless Chrome)", () => {
  it.for([
    ["Cue", () => cannedPayload({ snap: false })],
    ["Structure", () => cannedStructurePayload({ snap: false, showStems: true })],
  ] as const)("%s: bands, handles and lanes follow the zoom around the pointer", T, async ([, make], ctx) => {
    const p = make();
    const page = await open(ctx, p);
    const fit = await geo(page);
    const x = fit.tl.left + fit.tl.width * 0.3;
    await page.wheel(x, fit.tl.y, 0, ZOOM_8X, CMD);
    await page.settle(100);
    const z = await geo(page);
    const v = viewOf(z, p.durationSec);
    expect(v.span).toBeCloseTo(p.durationSec / 8, 1);
    expect(v.start + 0.3 * v.span).toBeCloseTo(0.3 * p.durationSec, 0); // the time under the pointer stayed there
    for (const h of z.handles) {
      const f = (h.t - v.start) / v.span;
      expect(h.visible).toBe(f >= 0 && f <= 1);
      if (h.visible) expect(h.x).toBeCloseTo(z.tl.left + f * z.tl.width, 0);
    }
    // Every band is 8x as wide as at fit, and starts where its handle is.
    z.bands.forEach((b, i) => expect(b.right - b.left).toBeCloseTo((fit.bands[i].right - fit.bands[i].left) * 8, -1));
    if (p.mode === "structure") z.cells.forEach((c, i) => expect(c.left).toBeCloseTo(z.bands[i].left, 0));
    expect(z.thumb!.width).toBeCloseTo(z.tl.width / 8, -1);
    // Cmd+0 fits again.
    await page.key("0", CMD);
    const back = await geo(page);
    back.handles.forEach((h, i) => expect(h.x).toBeCloseTo(fit.handles[i].x, 1));
    expect(back.thumb).toBeNull();
    await page.close();
  });

  it("the playhead follows the zoom", T, async (ctx) => {
    const page = await open(ctx, cannedPayload({ snap: false }), 180); // audio under every band
    await page.settle(300); // the background load
    await page.wheel(500, (await geo(page)).tl.y, 0, ZOOM_8X, CMD);
    const g = await geo(page);
    const i = g.bands.findIndex((b) => b.left > g.tl.left + 5 && b.left < g.tl.left + g.tl.width - 80);
    expect(i).toBeGreaterThanOrEqual(0);
    await page.click(g.bands[i].left + 10, (await page.centre(".band", i)).y);
    await page.settle(150);
    const head = await page.eval<number | null>(`(function () { var p = document.querySelector(".waveform .playhead"); return p && p.getBoundingClientRect().left; })()`);
    expect(head).not.toBeNull();
    expect(head!).toBeGreaterThanOrEqual(g.bands[i].left - 1);
    expect(head!).toBeLessThan(g.bands[i].left + 60); // a fraction of a second in, at 8x
    await page.close();
  });

  it("horizontal scroll pans; a handle dragged to the right edge scrolls the view", T, async (ctx) => {
    const D = cannedPayload().durationSec;
    const page = await open(ctx, cannedPayload({ snap: false }));
    const y = (await geo(page)).tl.y;
    await page.wheel(300, y, 0, ZOOM_8X, CMD);
    const before = viewOf(await geo(page), D);
    await page.wheel(500, y, 200, 0);
    const panned = viewOf(await geo(page), D);
    expect(panned.start).toBeGreaterThan(before.start);
    const g = await geo(page);
    const k = g.handles.findIndex((h) => h.visible);
    const right = g.tl.left + g.tl.width - 4;
    await page.drag(g.handles[k].x, y, right, y, 12);
    // The drag ended at the edge; it scrolled while it was there (each frame), and the handle went with it.
    const after = await geo(page);
    const v = viewOf(after, D);
    expect(v.start).toBeGreaterThan(panned.start);
    expect(after.handles[k].t).toBeGreaterThan(panned.start + panned.span * 0.95);
    await page.close();
  });
});

describe.skipIf(!CHROME)("nudging with trusted keys (fb3, item 4; headless Chrome)", () => {
  it("with a handle selected, the arrows move it and neither the Sections slider nor the Slice by tabs", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: true });
    const page = await open(ctx, p);
    const g = await geo(page);
    await page.click(g.handles[3].x, g.tl.y);
    const t = g.handles[3].t;
    const slider = () => page.eval<string>(`document.querySelector("input[type=range]").value`);
    const before = await slider();
    await page.eval(`document.querySelector("input[type=range]").focus()`);
    await page.key("ArrowRight");
    expect(await slider()).toBe(before);
    const t1 = (await geo(page)).handles[3].t;
    expect(t1).toBe(p.analysis.beats.find((b) => b > t + 1e-6));
    const tabs = () => page.eval<string>(`[].map.call(document.querySelectorAll("[role=tab]"), function (b) { return b.getAttribute("aria-selected"); }).join()`);
    const tabsBefore = await tabs();
    await page.eval(`(document.querySelector("[role=tab][aria-selected=true]") || document.querySelector("[role=tab]")).focus()`);
    await page.key("ArrowRight", SHIFT);
    expect(await tabs()).toBe(tabsBefore);
    const t2 = (await geo(page)).handles[3].t;
    expect(t2).toBe(p.analysis.downbeats.find((b) => b > t1 + 1e-6));
    await page.close();
  });
});

describe.skipIf(!CHROME)("a 30-minute clip at 8x (fb3, item 5; headless Chrome)", () => {
  it("pans with the waveform and four stem envelopes redrawn every frame", T, async (ctx) => {
    const D = 1800;
    const { min, max } = cannedPayload().waveform;
    const p = cannedStructurePayload({ durationSec: D, analysis: fakeStructureAnalysis(D), showStems: true, snap: false, waveform: { min: [...min, ...min], max: [...max, ...max] } });
    const page = await open(ctx, p);
    await page.wheel(500, (await geo(page)).tl.y, 0, ZOOM_8X, CMD);
    const frames = await page.eval<number[]>(`new Promise(function (resolve) {
      var tl = document.querySelector(".timeline"), times = [], n = 0, last = 0;
      function step(now) {
        if (last) times.push(now - last);
        last = now;
        if (n++ >= 90) return resolve(times);
        tl.dispatchEvent(new WheelEvent("wheel", { deltaX: n < 45 ? 30 : -30, bubbles: true, cancelable: true, clientX: 500 }));
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    })`);
    frames.sort((a, b) => a - b);
    const p95 = frames[Math.floor(frames.length * 0.95)];
    const mean = frames.reduce((s, x) => s + x, 0) / frames.length;
    console.log(`fb3 30-min 8x pan: mean ${mean.toFixed(1)} ms/frame, p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(34); // two frames at 60 Hz, generous for a loaded test machine
    await page.close();
  });
});

describe.skipIf(!CHROME || !SHOT)("the fb3 screenshot (headless Chrome)", () => {
  it("8x, a handle selected and nudged, the lengths showing", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: true, showStems: true });
    const page = await open(ctx, p);
    const fit = await geo(page);
    await page.wheel(fit.tl.left + fit.tl.width * 0.4, fit.tl.y, 0, ZOOM_8X, CMD);
    const g = await geo(page);
    const k = g.handles.findIndex((h) => h.visible);
    await page.click(g.handles[k].x, g.tl.y);
    await page.key("ArrowRight", SHIFT);
    await page.settle(100);
    mkdirSync(dirname(SHOT!), { recursive: true });
    await page.screenshot(SHOT!);
    await page.close();
  });
});
