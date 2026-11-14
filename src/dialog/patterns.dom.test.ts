// Plan 6, Task 4: the Patterns slider in the Structure dialog, in jsdom with the built dialog bundle. It moves the
// pattern lanes through the engine's real levels ("only real levels", Matt) and never touches the sections.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cannedStructurePayload } from "./fixture.js";
import { injectPayload, type StructurePayload } from "./protocol.js";
import { createStructureState } from "./structureState.js";

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;
const flush = () => new Promise((r) => setTimeout(r, 25));

let template = "";
beforeAll(async () => {
  const out = await esbuild.build({
    entryPoints: ["src/dialog/main.ts"],
    outdir: "build",
    write: false,
    bundle: true,
    format: "iife",
    platform: "browser",
    plugins: [sveltePlugin()],
    conditions: ["svelte", "browser"],
    logLevel: "silent",
  });
  const js = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css = out.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  template = fs
    .readFileSync("src/dialog/index.html", "utf8")
    .replace("<!--STYLE-->", () => css)
    .replace("<!--BUNDLE-->", () => js.replace(/<\/script/gi, "<\\/script"));
}, 60_000);

const open: JSDOM[] = [];
afterEach(() => {
  while (open.length) open.pop()!.window.close();
});

async function mount(payload: StructurePayload) {
  const sent: Array<{ action: string; prefs?: { patternLevel: number } }> = [];
  const dom = new JSDOM(injectPayload(template, payload), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      (w as unknown as { chrome: unknown }).chrome = { webview: { postMessage: (m: { params: string[] }) => sent.push(JSON.parse(m.params[0])) } };
      w.Element.prototype.setPointerCapture = () => {};
      w.HTMLCanvasElement.prototype.getContext = (() => null) as never;
      (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      };
    },
  });
  open.push(dom);
  await flush();
  const w = dom.window;
  const doc = w.document;
  const slider = () => doc.querySelector<HTMLInputElement>(`input[type=range][aria-label="Patterns"]`)!;
  return {
    doc,
    sent,
    slider,
    cells: (source: string) => doc.querySelectorAll(`.lane[data-source="${source}"] .cell`).length,
    bands: () => doc.querySelectorAll(".band").length,
    rows: () => [...doc.querySelectorAll<HTMLElement>(".lane")].map((l) => l.dataset.source),
    async set(value: number) {
      const input = slider();
      input.value = String(value);
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
      await flush();
    },
  };
}

describe("the Patterns slider (Plan 6, Task 4)", () => {
  it("steps through the real levels: More adds cells to the lanes, the bands stay, and back the count returns", async () => {
    const payload = cannedStructurePayload();
    const steps = createStructureState(payload).patternSteps();
    expect(steps).toEqual([0, 1, 2]); // the canned clip's real levels
    const v = await mount(payload);
    expect(v.rows()).toEqual(["drums", "bass", "vocals", "other"]); // no mix row (Matt, 4 Nov)
    const s = v.slider();
    expect([s.min, s.max, s.step, s.value, s.disabled]).toEqual(["0", "2", "1", "1", false]); // the payload's level 1
    const bands = v.bands();
    await v.set(0);
    expect(v.cells("other")).toBe(bands); // Fewer: one cell per section
    await v.set(3); // past the top: the range input holds it at the last real level
    expect(v.slider().value).toBe("2");
    expect(v.cells("other")).toBeGreaterThan(bands);
    expect(v.cells("drums")).toBeGreaterThan(v.cells("bass")); // level 2 splits only the drums further
    expect(v.bands()).toBe(bands);
    await v.set(0);
    expect(v.cells("other")).toBe(bands);
    expect(v.bands()).toBe(bands);
  });

  it("the slider's value is the last real level at or below the payload's", async () => {
    // A remembered level 4 on a clip whose top real level is 2 shows at the top.
    const v = await mount(cannedStructurePayload({ patternLevel: 4 }));
    expect(v.slider().value).toBe("2");
  });

  it("Apply remembers the engine level the slider is on", async () => {
    const v = await mount(cannedStructurePayload());
    await v.set(2);
    [...v.doc.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Apply")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(v.sent.at(-1)?.prefs?.patternLevel).toBe(2);
  });

  it("is disabled without pattern features, and the four letter lanes are drawn", async () => {
    const v = await mount(cannedStructurePayload({ patterns: null }));
    expect(v.slider().disabled).toBe(true);
    expect(v.rows()).toEqual(["drums", "bass", "vocals", "other"]);
  });
});

describe("the Patterns slider's positions are the real levels, not the engine levels (Task 4 review)", () => {
  // The canned clip's real levels are 0, 1 and 2, where position and level agree; steps with a gap, as a clip whose
  // level 1 changes nothing would have, show the controls hand on the level of the position, never the position.
  let bundle = "";
  beforeAll(async () => {
    const out = await esbuild.build({
      stdin: {
        contents: `import { mount } from "svelte"; import StructureControls from "./src/dialog/StructureControls.svelte";
          window.mountControls = (target, props) => mount(StructureControls, { target, props });`,
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

  async function controls(patternSteps: number[], patternLevel: number) {
    const dom = new JSDOM(`<!doctype html><div id="root"></div>`, { runScripts: "outside-only", pretendToBeVisual: true });
    open.push(dom);
    const w = dom.window as unknown as Window & typeof globalThis & { mountControls: (t: Element, p: Record<string, unknown>) => void };
    w.eval(bundle);
    const levels: number[] = [];
    const none = () => {};
    w.mountControls(w.document.getElementById("root")!, {
      ...{ granularity: 0, canGranulate: true, ongranularity: none, groupDist: 0.5, ongroupdist: none, onrelease: none },
      ...{ sliceBy: "sections", sliceable: [], onslice: none, colorMode: "groups", output: "split", view: "arrangement", count: 4 },
      ...{ snap: false, canSnap: true, snapTarget: "downbeats", canSnapDownbeats: true, canSnapBars: false, snapMerged: 0 },
      ...{ onsnap: none, onsnaptarget: none, showStems: false, onshowstems: none, oncolormode: none, onoutput: none, oncancel: none, onapply: none },
      patternSteps,
      patternLevel,
      canPattern: true,
      onpatterns: (level: number) => levels.push(level),
    });
    await flush();
    const slider = w.document.querySelector<HTMLInputElement>(`input[type=range][aria-label="Patterns"]`)!;
    return {
      slider,
      levels,
      async set(i: number) {
        slider.value = String(i);
        slider.dispatchEvent(new w.Event("input", { bubbles: true }));
        await flush();
      },
    };
  }

  it("steps [0, 2, 4]: position 1 is level 2, position 2 level 4; level 3 shows at position 1", async () => {
    const c = await controls([0, 2, 4], 3);
    expect([c.slider.min, c.slider.max, c.slider.value]).toEqual(["0", "2", "1"]);
    await c.set(2);
    await c.set(0);
    await c.set(1);
    expect(c.levels).toEqual([4, 0, 2]);
  });
});

// Matt (Live, Flim): where allin1's beat tracker goes half-time, a section that sounds 5 bars read "3.1.1". With
// pattern features, the bands count bars on their corrected grid.
describe("section lengths on the patterns' corrected bar grid (Matt, Flim)", () => {
  /** The canned clip (120 BPM, a bar every 2 s from 2 s) with allin1 half-time from 30 s to 36 s. */
  function halfTime(patterns: StructurePayload["patterns"]): StructurePayload {
    const base = cannedStructurePayload();
    const a = base.analysis;
    const inStretch = (t: number) => t > 30 && t < 36;
    const analysis = {
      ...a,
      beats: [...a.beats.filter((t) => !inStretch(t)), 31, 32, 33, 34, 35].sort((x, y) => x - y),
      downbeats: a.downbeats.filter((t) => !inStretch(t) || t === 34),
    };
    return cannedStructurePayload({ analysis, patterns, snap: false });
  }
  const lengthOf = (doc: Document, start: number) => {
    const s = createStructureState(halfTime(null)).sections();
    const band = doc.querySelectorAll<HTMLElement>(".band")[s.findIndex((x) => x.start === start)];
    return band.title.split("\n")[1] ?? band.textContent;
  };

  it("a section across the half-time stretch reads whole bars on the corrected grid, and did not on allin1's", async () => {
    const patterns = cannedStructurePayload().patterns!;
    expect(patterns.grid.filter((b) => b.start >= 24 && b.start < 46).map((b) => b.start)).toEqual([24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44]);
    const sections = createStructureState(halfTime(patterns)).sections();
    expect(sections.find((x) => x.start === 24)!.end).toBe(46); // the canned verse, 11 bars
    const fixed = await mount(halfTime(patterns));
    expect(lengthOf(fixed.doc, 24)).toBe("11 bars");
    const before = await mount(halfTime(null));
    expect(lengthOf(before.doc, 24)).toBe("9.2"); // allin1's grid: the 3 bars from 30 s count as 1.2
  });
});
