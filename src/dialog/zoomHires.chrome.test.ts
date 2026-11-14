// fb4, item 2 ("The resolution of the zoom is quite lo-fi") in headless Chrome against the real dialog server:
// - a zoomed waveform draws from the preview's samples once they are in, and from the overview before (or without);
// - a 30-minute clip pans at frame rate at 8x and at 32x with the waveform drawn from the samples;
// - with the stems kept, zoomed past the 20 Hz envelope, each shown stem's slice of the view is fetched (debounced,
//   once per view and margin) and its lane drawn from it.
// Also saves the fb4 screenshot (32x) when SONG_SECTIONS_FB4_SHOT names a path.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { serveDialog } from "../live/dialogServer.js";
import { pcm16Header } from "../structure/audition.js";
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog, type ChromePage } from "../test/chromeDialog.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE, type StructurePayload } from "./protocol.js";

const chrome = useChromeDialog();
const T = { timeout: CHROME_TEST_TIMEOUT * 3 };
const CMD = 4;
const zoomBy = (factor: number) => -100 * Math.log(factor); // a Cmd+scroll of this many px (zoom.ts wheelZoomFactor)
const SHOT = process.env.SONG_SECTIONS_FB4_SHOT;
const PREVIEW_RATE = 24000;
const STEM_RATE = 44100;

// A made-up song at 120 BPM: kick and hats, a bass line, a gated vocal-ish glide and a pad. Each stem is a function of
// time; the preview is their mono mix, as prepare.ts makes it from the render.
function noise(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 31 - 1);
}
const hat = noise(9);
const STEMS: Record<StemName, (t: number) => number> = {
  drums: (t) => {
    const b = t % 0.5;
    const e = t % 0.25;
    return 0.8 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-b * 30)) * b) * Math.exp(-b * 9) + 0.18 * hat() * Math.exp(-e * 40);
  },
  bass: (t) => 0.45 * Math.sin(2 * Math.PI * (Math.floor(t / 2) % 2 ? 73.4 : 55) * t) * (0.4 + 0.6 * Math.exp(-(t % 0.5) * 4)),
  vocals: (t) => (t % 4 < 3 && Math.floor(t / 16) % 2 === 1 ? 0.35 * Math.sin(2 * Math.PI * 330 * t + 6 * Math.sin(2 * Math.PI * 5 * t)) * Math.sin((Math.PI * (t % 4)) / 3) : 0),
  other: (t) => 0.12 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t)),
};
/** Louder and quieter stretches, so the sections show. */
const level = (t: number) => 0.55 + 0.45 * Math.abs(Math.sin(t / 23));
const mix = (t: number) => level(t) * 0.5 * STEM_NAMES.reduce((s, k) => s + STEMS[k](t), 0);
const i16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

function previewWav(seconds: number, tile = seconds): { wav: Buffer; waveform: { min: number[]; max: number[] } } {
  // A 30-minute preview repeats a tile of the song at a changing level, which is quick to make and as heavy to draw.
  const n = seconds * PREVIEW_RATE;
  const tileN = tile * PREVIEW_RATE;
  const one = new Int16Array(tileN);
  for (let f = 0; f < tileN; f++) one[f] = i16(mix(f / PREVIEW_RATE));
  const out = Buffer.alloc(44 + 2 * n);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + 2 * n, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(PREVIEW_RATE, 24);
  out.writeUInt32LE(2 * PREVIEW_RATE, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(2 * n, 40);
  const BINS = 2000;
  const min = new Array<number>(BINS).fill(0);
  const max = new Array<number>(BINS).fill(0);
  for (let f = 0; f < n; f++) {
    const g = 0.6 + 0.4 * Math.abs(Math.sin(Math.floor(f / tileN) * 1.3));
    const v = Math.round(one[f % tileN] * g);
    out.writeInt16LE(v, 44 + 2 * f);
    const b = Math.floor((f * BINS) / n);
    if (v / 32768 < min[b]) min[b] = v / 32768;
    if (v / 32768 > max[b]) max[b] = v / 32768;
  }
  return { wav: out, waveform: { min, max } };
}

function stemWav(stem: StemName, seconds: number): Buffer {
  const n = seconds * STEM_RATE;
  const body = Buffer.alloc(4 * n);
  for (let f = 0; f < n; f++) {
    const t = f / STEM_RATE;
    const v = level(t) * STEMS[stem](t);
    body.writeInt16LE(i16(v), 4 * f);
    body.writeInt16LE(i16(v * 0.9), 4 * f + 2);
  }
  return Buffer.concat([pcm16Header(n), body]);
}

let dir = "";
let long: { path: string; waveform: { min: number[]; max: number[] } };
let short: { path: string; waveform: { min: number[]; max: number[] }; stemsDir: string };
const LONG = 1800;
const SHORT = 180;

beforeAll(() => {
  if (!CHROME) return;
  dir = mkdtempSync(join(tmpdir(), "fb4-zoom-"));
  const l = previewWav(LONG, 30);
  writeFileSync(join(dir, "long.wav"), l.wav);
  long = { path: join(dir, "long.wav"), waveform: l.waveform };
  const s = previewWav(SHORT);
  writeFileSync(join(dir, "short.wav"), s.wav);
  const stemsDir = join(dir, "stems");
  mkdirSync(stemsDir);
  for (const k of STEM_NAMES) writeFileSync(join(stemsDir, `${k}.wav`), stemWav(k, SHORT));
  short = { path: join(dir, "short.wav"), waveform: s.waveform, stemsDir };
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const STEM_URLS = Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as Record<StemName, string>;

async function served(ctx: TestContext, p: StructurePayload, audioPath: string, stemsDir: string | null = null) {
  const harness = chrome.get(ctx);
  const payload = { ...p, audioUrl: "audio.wav" };
  const server = await serveDialog({ html: harness.html(payload), audioPath, stemsDir });
  const page = await harness.open(payload, ...DIALOG_SIZE[p.mode], { url: server.url });
  return { page, server };
}

const timelineY = (page: ChromePage) =>
  page.eval<{ x: number; y: number; w: number }>(`(function () { var r = document.querySelector(".waveform").getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
const drawn = (page: ChromePage) => page.eval<string | undefined>(`document.querySelector(".waveform canvas").dataset.drawn`);
const laneDrawn = (page: ChromePage) => page.eval<string[]>(`[].map.call(document.querySelectorAll(".lane canvas.wave"), function (c) { return c.dataset.drawn || ""; })`);
const stemFetches = (page: ChromePage) =>
  page.eval<string[]>(`performance.getEntriesByType("resource").map(function (e) { return e.name; }).filter(function (n) { return n.indexOf("/stems/") >= 0 && n.indexOf("start=") >= 0; })`);

/** Waits until `ok` holds, up to `ms`. */
async function until(page: ChromePage, ok: () => Promise<boolean>, ms = 15_000) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await page.settle(50);
  }
}

/** Pans the view by 30 px each animation frame for `n` frames (back again half-way), and returns the frame times. */
async function panFrames(page: ChromePage, n = 120) {
  const times = await page.eval<number[]>(`new Promise(function (resolve) {
    var tl = document.querySelector(".timeline"), times = [], k = 0, last = 0;
    function step(now) {
      if (last) times.push(now - last);
      last = now;
      if (k++ >= ${n}) return resolve(times);
      tl.dispatchEvent(new WheelEvent("wheel", { deltaX: k < ${n / 2} ? 30 : -30, bubbles: true, cancelable: true, clientX: 500 }));
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  })`);
  const sorted = [...times].sort((a, b) => a - b);
  return { mean: times.reduce((s, x) => s + x, 0) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1] };
}

/** How long one redraw of the waveform at the current view takes: the median of 30 forced redraws (a pan each). */
async function drawCost(page: ChromePage) {
  return page.eval<number>(`new Promise(function (resolve) {
    var tl = document.querySelector(".timeline"), c = document.querySelector(".waveform canvas"), out = [], k = 0;
    function step() {
      var t0 = performance.now();
      tl.dispatchEvent(new WheelEvent("wheel", { deltaX: k % 2 ? 3 : -3, bubbles: true, cancelable: true, clientX: 500 }));
      c.getContext("2d").getImageData(0, 0, 1, 1); // the draw has run (Svelte flushes the effect in a microtask)
      Promise.resolve().then(function () {
        c.getContext("2d").getImageData(0, 0, 1, 1);
        out.push(performance.now() - t0);
        if (++k < 30) requestAnimationFrame(step);
        else { out.sort(function (a, b) { return a - b; }); resolve(out[15]); }
      });
    }
    requestAnimationFrame(step);
  })`);
}

describe.skipIf(!CHROME)("the zoomed waveform from the samples (fb4, item 2; headless Chrome)", () => {
  it("a 30-minute clip: the overview at fit, the samples at 8x and 32x, panning at frame rate", T, async (ctx) => {
    const p = cannedStructurePayload({ durationSec: LONG, analysis: fakeStructureAnalysis(LONG), showStems: true, snap: false, waveform: long.waveform });
    const { page, server } = await served(ctx, p, long.path);
    const tl = await timelineY(page);
    await page.settle(200);
    expect(await drawn(page)).toBe("overview");
    await page.wheel(tl.x + tl.w * 0.4, tl.y, 0, zoomBy(8), CMD);
    // 86 MB of preview, then the mipmap in slices: until then, 8x of 30 minutes is too long to scan, so the overview.
    await until(page, async () => (await drawn(page)) === "samples");
    const at8 = await panFrames(page);
    const cost8 = await drawCost(page);
    await page.wheel(tl.x + tl.w * 0.4, tl.y, 0, zoomBy(4), CMD);
    await page.settle(50);
    expect(await drawn(page)).toBe("samples");
    const at32 = await panFrames(page);
    const cost32 = await drawCost(page);
    console.log(
      `fb4 30-min pan, waveform from the samples, 4 stem envelopes: 8x mean ${at8.mean.toFixed(1)} ms/frame, p95 ${at8.p95.toFixed(1)}, max ${at8.max.toFixed(1)}, ` +
        `draw ${cost8.toFixed(2)} ms; 32x mean ${at32.mean.toFixed(1)}, p95 ${at32.p95.toFixed(1)}, max ${at32.max.toFixed(1)}, draw ${cost32.toFixed(2)} ms`,
    );
    expect(at8.p95).toBeLessThan(34); // two frames at 60 Hz, generous for a loaded test machine
    expect(at32.p95).toBeLessThan(34);
    // Deeper still, one second across: the samples, straight.
    await page.wheel(tl.x + tl.w * 0.4, tl.y, 0, zoomBy(1000), CMD);
    await page.settle(50);
    expect(await drawn(page)).toBe("samples");
    // The deepest zoom is a second across (zoom.ts MIN_SPAN_SEC): the thumb is at its 16 px minimum.
    expect(await page.eval<number>(`document.querySelector(".scroll .thumb").getBoundingClientRect().width`)).toBeCloseTo(16, 0);
    await server.close();
    await page.close();
  });

  it("without the audio (a failed preview fetch), the zoomed waveform is the overview", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: false, waveform: short.waveform });
    const { page, server } = await served(ctx, p, join(dir, "missing.wav"));
    const tl = await timelineY(page);
    await page.wheel(tl.x + tl.w / 2, tl.y, 0, zoomBy(32), CMD);
    await page.settle(300);
    expect(await drawn(page)).toBe("overview");
    await server.close();
    await page.close();
  });

  it("stems kept and shown, zoomed past the envelope: each lane draws from its stem's slice, fetched once per view", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: true, showStems: true, waveform: short.waveform, stemUrls: STEM_URLS });
    const { page, server } = await served(ctx, p, short.path, short.stemsDir);
    const tl = await timelineY(page);
    await page.wheel(tl.x + tl.w * 0.4, tl.y, 0, zoomBy(4), CMD); // 45 s: the envelope still resolves it
    await page.settle(400);
    expect(await stemFetches(page)).toEqual([]);
    expect(await laneDrawn(page)).toEqual(["envelope", "envelope", "envelope", "envelope"]);
    await page.wheel(tl.x + tl.w * 0.4, tl.y, 0, zoomBy(8), CMD); // 32x: 5.6 s
    await until(page, async () => (await laneDrawn(page)).every((d) => d === "samples"), 5000);
    const first = await stemFetches(page);
    expect(first).toHaveLength(4);
    expect(first.map((u) => u.match(/stems\/(\w+)\.wav/)![1])).toEqual([...STEM_NAMES]);
    // A small pan stays inside the fetched margin: nothing more is fetched.
    await page.wheel(tl.x + tl.w / 2, tl.y, 100, 0);
    await page.settle(400);
    expect(await stemFetches(page)).toHaveLength(4);
    expect(await laneDrawn(page)).toEqual(["samples", "samples", "samples", "samples"]);
    // A long pan leaves it: the lanes go back to the envelope, then to the new slice.
    await page.wheel(tl.x + tl.w / 2, tl.y, 3000, 0);
    await until(page, async () => (await stemFetches(page)).length === 8 && (await laneDrawn(page)).every((d) => d === "samples"), 5000);
    await server.close();
    await page.close();
  });
});

describe.skipIf(!CHROME || !SHOT)("the fb4 screenshot (headless Chrome)", () => {
  it("32x, the waveform and the stem lanes from the samples, a handle selected", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: true, showStems: true, waveform: short.waveform, stemUrls: STEM_URLS });
    const { page, server } = await served(ctx, p, short.path, short.stemsDir);
    const tl = await timelineY(page);
    await until(page, () => page.eval<boolean>(`document.querySelector(".waveform canvas").dataset.drawn !== undefined`));
    await page.settle(500); // the preview is in
    await page.wheel(tl.x + tl.w * 0.3, tl.y, 0, zoomBy(32), CMD); // around 54 s, where the vocal is in
    await until(page, async () => (await drawn(page)) === "samples" && (await laneDrawn(page)).every((d) => d === "samples"), 8000);
    const h = await page.eval<number | null>(`(function () {
      var hs = [].filter.call(document.querySelectorAll("[role=slider]"), function (h) { return getComputedStyle(h).visibility !== "hidden"; });
      if (!hs.length) return null; var r = hs[0].getBoundingClientRect(); return r.left + r.width / 2; })()`);
    if (h !== null) await page.click(h, tl.y);
    await page.settle(200);
    mkdirSync(dirname(SHOT!), { recursive: true });
    await page.screenshot(SHOT!);
    await server.close();
    await page.close();
  });
});
