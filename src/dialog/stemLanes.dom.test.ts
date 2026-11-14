// StemLanes' fetch of the stems' samples when zoomed (fb4, item 2), in jsdom with a deferred fetch:
// - fb4 review I1: a view flush with the clip's end is covered by the slice fetched for it, so panning or settling there
//   fetches nothing more and the lanes draw from the samples;
// - fb4 review M1: a fetch loop that is between stems stops when its view is no longer the one wanted (the view
//   changed to one the slices already cover, or Show stems went off), and a stale slice never replaces a good one.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pcm16Header } from "../structure/audition.js";
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import { cannedStructurePayload } from "./fixture.js";
import { createStructureState } from "./structureState.js";

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longer than the lanes' debounce (150 ms). */
const SETTLE = 220;
const RATE = 44100;
const WIDTH = 1000;
const URLS = Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as Record<StemName, string>;

let bundle = "";
beforeAll(async () => {
  const out = await esbuild.build({
    stdin: {
      contents: `import { mount } from "svelte"; import Harness from "./src/test/StemLanesHarness.svelte";
        window.mountLanes = (target, init) => { let set; mount(Harness, { target, props: { init, expose: (f) => (set = f) } }); return (p) => set(p); };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outdir: "build",
    write: false,
    bundle: true,
    format: "iife",
    platform: "browser",
    plugins: [sveltePlugin()],
    conditions: ["svelte", "browser"],
    logLevel: "silent",
  });
  bundle = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
}, 60_000);

const open: JSDOM[] = [];
afterEach(() => {
  while (open.length) open.pop()!.window.close();
});

/** A deferred fetch: each call waits for the test to release it. `frames` is what the route would return for a range. */
function makeFetch(stemFrames: number) {
  const calls: Array<{ url: string; stem: string; start: number; end: number; release: () => void }> = [];
  const fetchBytes = (url: string) =>
    new Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>((resolve) => {
      const m = url.match(/stems\/(\w+)\.wav\?start=([^&]+)&end=(.+)$/)!;
      const [start, end] = [Number(m[2]), Number(m[3])];
      const f0 = Math.min(stemFrames, Math.max(0, Math.round(start * RATE)));
      const f1 = Math.min(stemFrames, Math.max(f0, Math.round(end * RATE)));
      const body = Buffer.concat([pcm16Header(f1 - f0), Buffer.alloc((f1 - f0) * 4)]);
      const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer;
      const call = { url, stem: m[1], start, end, release: () => resolve({ ok: true, status: 200, arrayBuffer: async () => bytes }) };
      calls.push(call);
    });
  return { calls, fetchBytes };
}

async function mount(opts: { duration: number; view: { start: number; span: number }; stemFrames: number; showStems?: boolean }) {
  const payload = cannedStructurePayload({ stemUrls: URLS });
  const lanes = createStructureState(payload).lanes();
  const f = makeFetch(opts.stemFrames);
  const dom = new JSDOM(`<!doctype html><div id="root"></div>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  open.push(dom);
  const w = dom.window as unknown as Window & typeof globalThis & { mountLanes: (t: Element, init: Record<string, unknown>) => (p: Record<string, unknown>) => void };
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => WIDTH, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get: () => 40, configurable: true });
  (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe(target: Element) {
      this.cb([{ target }]);
    }
    disconnect() {}
    unobserve() {}
  };
  const ctx2d = { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
  w.HTMLCanvasElement.prototype.getContext = (() => ctx2d) as never;
  w.eval(bundle);
  const set = w.mountLanes(w.document.getElementById("root")!, {
    lanes,
    duration: opts.duration,
    showStems: opts.showStems ?? true,
    stems: payload.analysis.stems,
    stemUrls: URLS,
    view: opts.view,
    fetchBytes: f.fetchBytes,
  });
  await sleep(10);
  const drawn = () => [...w.document.querySelectorAll<HTMLCanvasElement>("canvas.wave")].map((c) => c.dataset.drawn);
  /** Releases fetches as they arrive, until none comes for SETTLE ms. */
  const drain = async () => {
    for (let released = 0; ; ) {
      await sleep(SETTLE);
      const pending = f.calls.slice(released);
      if (pending.length === 0) return;
      for (const c of pending) c.release();
      released = f.calls.length;
      await sleep(20);
      released = Math.min(released, f.calls.length);
    }
  };
  return { ...f, set, drawn, drain };
}

describe("StemLanes, zoomed past the envelope (fb4)", () => {
  // I1: a view flush with the clip's end, on a 183.337 s clip whose stems are floor(duration x rate) frames long.
  for (const [name, frames] of [
    ["floor", Math.floor(183.337 * RATE)],
    ["round", Math.round(183.337 * RATE)],
    ["a few ms short", Math.round(183.337 * RATE) - 441],
  ] as const) {
    it(`a view at the clip's end is covered by its slice (stems ${name}): one fetch of the four stems, then samples`, async () => {
      const duration = 183.337;
      const m = await mount({ duration, view: { start: duration - 5.6, span: 5.6 }, stemFrames: frames });
      await m.drain();
      expect(m.calls.map((c) => c.stem)).toEqual([...STEM_NAMES]);
      expect(m.drawn()).toEqual(["samples", "samples", "samples", "samples"]);
      // The view settles again a hair along (a pan clamped at the end): nothing is fetched again.
      m.set({ view: { start: duration - 5.6, span: 5.6 } });
      await m.drain();
      expect(m.calls).toHaveLength(4);
      expect(m.drawn()).toEqual(["samples", "samples", "samples", "samples"]);
    });
  }

  // M1
  it("a view change to one the slices already cover stops the loop: the stems not yet fetched are not, and the slices stay", async () => {
    const duration = 120;
    const near = { start: 50, span: 10 };
    const m = await mount({ duration, view: near, stemFrames: duration * RATE });
    await m.drain(); // all four slices for `near`
    expect(m.calls).toHaveLength(4);
    // Zoom in one notch (the slices' bins are now too coarse): a fetch starts and waits on its first stem.
    m.set({ view: { start: 54, span: 2 } });
    await sleep(SETTLE);
    expect(m.calls).toHaveLength(5);
    // Back out to the first view before it finishes: the old slices cover it.
    m.set({ view: near });
    await sleep(30);
    m.calls[4].release();
    await sleep(SETTLE);
    expect(m.calls).toHaveLength(5); // the loop did not go on to the other three stems
    expect(m.drawn()).toEqual(["samples", "samples", "samples", "samples"]); // and the first stem keeps its good slice
  });

  it("Show stems going off stops the loop", async () => {
    const m = await mount({ duration: 120, view: { start: 50, span: 10 }, stemFrames: 120 * RATE });
    await sleep(SETTLE);
    expect(m.calls).toHaveLength(1);
    m.set({ showStems: false });
    await sleep(30);
    m.calls[0].release();
    await sleep(SETTLE);
    expect(m.calls).toHaveLength(1);
  });
});

describe("StemLanes, pattern rows (Plan 6, Task 4)", () => {
  async function mountRows(init: Record<string, unknown>) {
    const payload = cannedStructurePayload();
    const dom = new JSDOM(`<!doctype html><div id="root"></div>`, { runScripts: "outside-only", pretendToBeVisual: true });
    open.push(dom);
    const w = dom.window as unknown as Window & typeof globalThis & { mountLanes: (t: Element, init: Record<string, unknown>) => (p: Record<string, unknown>) => void };
    Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => WIDTH, configurable: true });
    w.HTMLCanvasElement.prototype.getContext = (() => null) as never;
    (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
    w.eval(bundle);
    const played: Array<[string, number]> = [];
    w.mountLanes(w.document.getElementById("root")!, {
      duration: payload.durationSec,
      showStems: false,
      stems: payload.analysis.stems,
      onplay: (source: string, i: number) => played.push([source, i]),
      ...init,
    });
    await sleep(10);
    const doc = w.document;
    return { doc, played, lanes: () => [...doc.querySelectorAll<HTMLElement>(".lane")], cells: (source: string) => [...doc.querySelectorAll<HTMLElement>(`.lane[data-source=${source}] .cell`)] };
  }
  const state = () => createStructureState(cannedStructurePayload());

  it("draws one row per stem, named for it, and no mix row; each lane carries data-source", async () => {
    const s = state();
    const v = await mountRows({ lanes: s.patternLanes(), rows: s.patternSources });
    expect(v.lanes().map((l) => l.dataset.source)).toEqual([...STEM_NAMES]);
    expect(v.lanes()[0].querySelector(".name")!.textContent).toBe("drums");
    for (const src of s.patternSources) expect(v.cells(src)).toHaveLength(s.patternLanes()[src]!.length);
  });

  it("titles each cell <source>: <label>, a rest <source>: rest, and a rest has no label", async () => {
    const s = state();
    const lanes = s.patternLanes();
    const v = await mountRows({ lanes, rows: s.patternSources, playable: true });
    for (const src of s.patternSources) {
      expect(v.cells(src)).toHaveLength(lanes[src]!.length);
      v.cells(src).forEach((c, i) => {
        const cell = lanes[src]![i];
        expect(c.title).toBe(cell.rest ? `${src}: rest` : `${src}: ${cell.label}`);
        if (cell.rest) expect(c.querySelector(".label")).toBeNull();
      });
    }
    expect(lanes.vocals!.some((c) => c.rest)).toBe(true); // the canned vocals have rests to check
  });

  it("a stem cell plays only with kept stems; without them it says to Re-analyze", async () => {
    const s = state();
    const v = await mountRows({ lanes: s.patternLanes(), rows: s.patternSources, playable: false });
    v.cells("bass")[1].click();
    expect(v.played).toEqual([]);
    expect(v.cells("bass")[1].title).toMatch(/Re-analyze/);
    const on = await mountRows({ lanes: s.patternLanes(), rows: s.patternSources, playable: true });
    on.cells("bass")[1].click();
    expect(on.played).toEqual([["bass", 1]]);
  });

  it("Show stems draws a waveform and a tag under every row", async () => {
    const s = state();
    const v = await mountRows({ lanes: s.patternLanes(), rows: s.patternSources, showStems: true });
    expect(v.lanes()).toHaveLength(4);
    for (const lane of v.lanes()) {
      expect(lane.querySelector("canvas.wave")).not.toBeNull();
      expect(lane.querySelector(".tag")).not.toBeNull();
    }
  });

  it("Review Focus 1: with rows [drums], one lane is drawn", async () => {
    const s = state();
    const v = await mountRows({ lanes: { drums: s.patternLanes().drums }, rows: ["drums"] });
    expect(v.lanes().map((l) => l.dataset.source)).toEqual(["drums"]);
  });

  it("Review Focus 2: with rows [], the four v2 letter lanes are drawn from the sections", async () => {
    const s = state();
    const lanes = s.lanes();
    const v = await mountRows({ lanes, rows: [] });
    expect(v.lanes().map((l) => l.dataset.source)).toEqual([...STEM_NAMES]);
    for (const stem of STEM_NAMES) expect(v.cells(stem).map((c) => c.title.split("\n")[0])).toEqual(lanes[stem].map((x) => `${stem}: ${x.label}`));
  });
});
