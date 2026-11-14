// Plan 6, Task 5: editing the pattern lanes' cuts by ear, as the section handles are edited, in jsdom with the built
// dialog bundle, real DOM events, and a stubbed fetch and Web Audio. A press on a lane cut selects it, a drag moves it
// (snapped unless Cmd is held), the arrows nudge it and play that lane's source from it, Delete or a double-click on it
// removes it, a double-click in a cell adds one, and a right-click on a named cell renames its pattern.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pcm16Header } from "../structure/audition.js";
import { STEM_NAMES } from "../structure/contract.js";
import type { PatternSource } from "../patterns/contract.js";
import { cannedStructurePayload } from "./fixture.js";
import { injectPayload, type StructurePayload } from "./protocol.js";
import { createStructureState, type LaneCell } from "./structureState.js";

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;

const WIDTH = 1000; // px: the stubbed lanes and timeline are this wide, starting at x = 0
const DURATION = 180; // the canned clip
const RATE = 8000; // the stubbed preview's rate
const STEM_RATE = 44100;
const flush = () => new Promise((r) => setTimeout(r, 25));
const STEM_URLS = Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as StructurePayload["stemUrls"];
const xOf = (t: number) => (t / DURATION) * WIDTH;
const tOf = (x: number) => (x / WIDTH) * DURATION;

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

/** A silent mono preview in prepare.ts's format, frames [f0, f1) at RATE. */
function clipWav(f0: number, f1: number): ArrayBuffer {
  const n = Math.max(0, f1 - f0);
  const b = Buffer.alloc(44 + 2 * n);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + 2 * n, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(2 * RATE, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(2 * n, 40);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
}

/** A silent stem slice as the server cuts one: 16-bit stereo at 44.1 kHz. */
function stemWav(seconds: number): ArrayBuffer {
  const n = Math.max(0, Math.round(seconds * STEM_RATE));
  const b = Buffer.concat([pcm16Header(n), Buffer.alloc(n * 4)]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
}

const query = (url: string, k: string) => Number(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get(k));

async function mount(payload: StructurePayload) {
  const fetched: string[] = [];
  const started: Array<{ duration: number; stopped: boolean }> = [];
  /** Every AudioContext made: the stem player asks for 44.1 kHz (stemContext), the clip player for the default. */
  const contexts: Array<{ stems: boolean; resumes: number }> = [];
  const dom = new JSDOM(injectPayload(template, payload), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      // The Mac: Cmd is the snap-bypass key (modifier.ts reads the platform when the bundle loads).
      Object.defineProperty(w.navigator, "platform", { value: "MacIntel", configurable: true });
      (w as unknown as { chrome: unknown }).chrome = { webview: { postMessage: () => {} } };
      w.Element.prototype.setPointerCapture = () => {};
      w.Element.prototype.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: WIDTH, bottom: 100, width: WIDTH, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
      w.HTMLCanvasElement.prototype.getContext = (() => null) as never;
      (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      };
      (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
        fetched.push(url);
        const body = url.startsWith("stems/")
          ? stemWav(query(url, "end") - query(url, "start"))
          : url.includes("?")
            ? clipWav(Math.round(query(url, "start") * RATE), Math.round(query(url, "end") * RATE))
            : clipWav(0, DURATION * RATE);
        return { ok: true, status: 200, arrayBuffer: async () => body };
      };
      (w as unknown as { AudioContext: unknown }).AudioContext = class {
        sampleRate = 48000;
        currentTime = 0;
        destination = {};
        log: { stems: boolean; resumes: number };
        constructor(options?: { sampleRate?: number }) {
          this.log = { stems: options?.sampleRate === STEM_RATE, resumes: 0 };
          contexts.push(this.log);
        }
        resume = async () => void this.log.resumes++;
        close = async () => {};
        createBuffer(c: number, n: number, r: number) {
          return { numberOfChannels: c, length: n, sampleRate: r, duration: n / r, getChannelData: () => new Float32Array(n) };
        }
        createBufferSource() {
          const s = {
            buffer: null as { duration: number } | null,
            duration: 0,
            stopped: false,
            onended: null,
            connect() {},
            start() {
              s.duration = s.buffer!.duration;
              started.push(s);
            },
            stop() {
              s.stopped = true;
            },
          };
          return s;
        }
      };
    },
  });
  open.push(dom);
  await flush();
  const w = dom.window;
  const doc = w.document;
  const cutEls = (src: PatternSource) => [...doc.querySelectorAll<HTMLElement>(`.lane[data-source=${src}] .cut`)];
  const cellEls = (src: PatternSource) => [...doc.querySelectorAll<HTMLElement>(`.lane[data-source=${src}] .cell`)];
  const v = {
    w,
    doc,
    fetched,
    started,
    contexts,
    /** Resumes so far of the stem player's context, or of the clip player's. */
    resumes: (stems: boolean) => contexts.filter((c) => c.stems === stems).reduce((n, c) => n + c.resumes, 0),
    /** Dispatches a key press and returns at once, before anything it awaits has run. */
    keyNow(key: string) {
      doc.body.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    cutEls,
    cellEls,
    cuts: (src: PatternSource) => cutEls(src).map((c) => Number(c.getAttribute("aria-valuenow"))),
    selectedCut: (src: PatternSource) => cutEls(src).findIndex((c) => c.classList.contains("selected")),
    boundaries: () => [...doc.querySelectorAll<HTMLElement>(".timeline [role=slider]")].map((h) => Number(h.getAttribute("aria-valuenow"))),
    titles: (src: PatternSource) => cellEls(src).map((c) => c.title.split("\n")[0]),
    playingCells: () => [...doc.querySelectorAll<HTMLElement>(".lanes .cell.playing")].map((c) => `${c.closest<HTMLElement>(".lane")!.dataset.source}:${cellEls(c.closest<HTMLElement>(".lane")!.dataset.source as PatternSource).indexOf(c)}`),
    async pointer(el: Element, type: "pointerdown" | "pointermove" | "pointerup", x: number, metaKey = false) {
      el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, metaKey }));
      await flush();
    },
    /** A press and release on cut k of `src`, without moving. */
    async select(src: PatternSource, k: number) {
      const el = cutEls(src)[k];
      const x = xOf(v.cuts(src)[k]);
      await v.pointer(el, "pointerdown", x);
      await v.pointer(el, "pointerup", x);
    },
    /** Presses on cut k of `src`, moves it to x, and lets go. */
    async drag(src: PatternSource, k: number, x: number, metaKey = false) {
      const el = cutEls(src)[k];
      await v.pointer(el, "pointerdown", xOf(v.cuts(src)[k]));
      await v.pointer(el, "pointermove", x, metaKey);
      await v.pointer(el, "pointerup", x, metaKey);
    },
    async key(key: string, opts: { shiftKey?: boolean } = {}, target: Element = doc.body) {
      const e = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
      target.dispatchEvent(e);
      await flush();
      return e;
    },
    async dblclick(el: Element, x: number, metaKey = false) {
      el.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: 10, metaKey }));
      await flush();
    },
    async rightClick(el: Element) {
      const e = new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 });
      el.dispatchEvent(e);
      await flush();
      return e.defaultPrevented;
    },
    menuItems: () => [...doc.querySelectorAll<HTMLButtonElement>(".send-menu [role=menuitem]")].map((b) => b.textContent!.trim()),
    /** The menu's title, a button when what it names can be renamed (Matt, 2026-11-11); null otherwise. */
    renameTitle: () => doc.querySelector<HTMLButtonElement>(".send-menu button.title"),
    async clickTitle() {
      doc.querySelector<HTMLButtonElement>(".send-menu button.title")!.click();
      await flush();
    },
    async chooseItem(label: string) {
      [...doc.querySelectorAll<HTMLButtonElement>(".send-menu [role=menuitem]")].find((b) => b.textContent!.trim() === label)!.click();
      await flush();
    },
  };
  return v;
}

/** The index of a cut of `lane` with at least `room` seconds of cell on both sides, so a move is not clamped. */
function roomyCut(lane: LaneCell[], room = 3.5): number {
  const k = lane.slice(1).findIndex((c, j) => c.end - c.start >= room && lane[j].end - lane[j].start >= room);
  expect(k).toBeGreaterThanOrEqual(0);
  return k;
}

const onGrid = (t: number, step: number) => Math.abs(t / step - Math.round(t / step)) < 1e-6;

describe("lane cuts, edited as the section handles are (Plan 6, Task 5)", () => {
  it("draws a handle the full height of its lane at each lane cut, none before the first cell", async () => {
    const payload = cannedStructurePayload();
    const lanes = createStructureState(payload).patternLanes();
    const v = await mount(payload);
    for (const src of STEM_NAMES) expect(v.cuts(src)).toEqual(lanes[src]!.slice(1).map((c) => c.start));
  });

  it("a press on a drums handle selects it; ArrowRight moves it one beat and plays the drums from there", async () => {
    const payload = cannedStructurePayload({ stemUrls: STEM_URLS, snap: true });
    const lane = createStructureState(payload).patternLanes().drums!;
    const k = roomyCut(lane);
    const v = await mount(payload);
    await v.select("drums", k);
    expect(v.selectedCut("drums")).toBe(k);
    const t = v.cuts("drums")[k];
    const before = v.fetched.length;
    await v.key("ArrowRight");
    const next = payload.analysis.beats.find((b) => b > t + 1e-6)!;
    expect(v.cuts("drums")[k]).toBe(next);
    expect(v.selectedCut("drums")).toBe(k);
    const stems = v.fetched.slice(before).filter((u) => u.startsWith("stems/"));
    expect(stems).toHaveLength(1);
    expect(stems[0].startsWith("stems/drums.wav?")).toBe(true);
    expect(query(stems[0], "start")).toBeCloseTo(next, 4);
    expect(query(stems[0], "end")).toBeCloseTo(Math.min(lane[k + 1].end, next + 2), 4); // AUDITION_SEC of the cell from the cut
    expect(v.playingCells()).toEqual([`drums:${k + 1}`]);
    await v.key("ArrowLeft", { shiftKey: true }); // back to the bar line
    expect(v.cuts("drums")[k]).toBe(payload.analysis.downbeats.filter((b) => b < next - 1e-6).at(-1));
  });

  it("review: a nudge opens the lane's audio inside the key press, before its await (WebKit plays only from a gesture)", async () => {
    const payload = cannedStructurePayload({ stemUrls: STEM_URLS, snap: true });
    const lanes = createStructureState(payload).patternLanes();
    const v = await mount(payload);
    await v.select("drums", roomyCut(lanes.drums!));
    const stems = v.resumes(true);
    v.keyNow("ArrowRight");
    expect(v.resumes(true)).toBe(stems + 1); // the stem player's context, synchronously
    await flush();
  });

  it("a drag with snap on lands on a downbeat; the same drag with Cmd held lands at the pointer", async () => {
    const payload = cannedStructurePayload({ snap: true });
    const lane = createStructureState(payload).patternLanes().drums!;
    const k = roomyCut(lane);
    const target = xOf(lane[k + 1].start) + 7.3; // about 1.3 s on, not a grid time
    const snapped = await mount(payload);
    await snapped.drag("drums", k, target);
    expect(onGrid(snapped.cuts("drums")[k], 2)).toBe(true); // the fake's downbeats are every 2 s
    expect(snapped.selectedCut("drums")).toBe(k);
    const free = await mount(payload);
    await free.drag("drums", k, target, true);
    expect(free.cuts("drums")[k]).toBeCloseTo(tOf(target), 5);
  });

  it("review: a cut dragged to the right edge of a zoomed view scrolls it, and keeps following the pointer", async () => {
    const payload = cannedStructurePayload({ snap: false, patternLevel: 0 }); // drums cut at the markers: 68, 90, 112
    const v = await mount(payload);
    v.doc.querySelector(".timeline")!.dispatchEvent(new v.w.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 500, deltaY: -208, metaKey: true }));
    await flush(); // 8x around 90 s: [78.75, 101.25]
    const k = v.cuts("drums").indexOf(90);
    expect(k).toBeGreaterThanOrEqual(0);
    const cellLeft = () => parseFloat(v.cellEls("drums")[k].style.left); // the cell before the cut: it starts at 68 s and stays
    const left = cellLeft();
    const el = v.cutEls("drums")[k];
    await v.pointer(el, "pointerdown", 500);
    await v.pointer(el, "pointermove", 990); // inside EDGE_PX of the right edge
    const first = v.cuts("drums")[k];
    expect(first).toBeGreaterThanOrEqual(78.75 + 0.99 * 22.5 - 1e-6); // at the pointer, or past it once a frame has scrolled
    await new Promise((r) => setTimeout(r, 300));
    expect(cellLeft()).toBeLessThan(left); // the view moved right, so the cells moved left
    const later = v.cuts("drums")[k];
    expect(later).toBeGreaterThan(first + 0.5); // the cut went with it
    expect(later).toBeLessThanOrEqual(111);
    await v.pointer(el, "pointerup", 990);
    const dropped = cellLeft();
    await new Promise((r) => setTimeout(r, 100));
    expect(cellLeft()).toBe(dropped); // and stops on release
  });

  it("final review item 7: while a marker is dragged its lane cuts follow it; on the drop the lanes are exact", async () => {
    const payload = cannedStructurePayload({ snap: false, patternLevel: 2 });
    const v = await mount(payload);
    const from = v.boundaries()[4];
    const handle = v.doc.querySelectorAll<HTMLElement>(".timeline [role=slider]")[4];
    await v.pointer(handle, "pointerdown", xOf(from));
    await v.pointer(handle, "pointermove", xOf(from) + 40);
    const to = v.boundaries()[4];
    expect(to).toBeGreaterThan(from + 3);
    for (const src of ["drums", "bass", "other"] as const) {
      expect(v.cuts(src), src).toContain(to);
      expect(v.cuts(src), src).not.toContain(from);
    }
    await v.pointer(handle, "pointerup", xOf(from) + 40);
    const exact = createStructureState(payload);
    exact.move(4, to);
    const lanes = exact.patternLanes();
    for (const src of exact.patternSources) expect(v.cuts(src), src).toEqual(lanes[src]!.slice(1).map((c) => c.start));
  });

  it("a press without a drag past 3 px moves nothing", async () => {
    const payload = cannedStructurePayload({ snap: false });
    const v = await mount(payload);
    const t = v.cuts("bass");
    const el = v.cutEls("bass")[1];
    await v.pointer(el, "pointerdown", xOf(t[1]));
    await v.pointer(el, "pointermove", xOf(t[1]) + 2);
    await v.pointer(el, "pointerup", xOf(t[1]) + 2);
    expect(v.cuts("bass")).toEqual(t);
    expect(v.selectedCut("bass")).toBe(1);
  });

  it("Delete removes the selected cut; a double-click on a handle removes it too", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const t = v.cuts("drums");
    await v.select("drums", 2);
    await v.key("Delete");
    expect(v.cuts("drums")).toEqual(t.filter((_, j) => j !== 2));
    expect(v.selectedCut("drums")).toBe(-1);
    const u = v.cuts("drums");
    await v.dblclick(v.cutEls("drums")[0], xOf(u[0]));
    expect(v.cuts("drums")).toEqual(u.slice(1));
    expect(v.boundaries()).toHaveLength(createStructureState(cannedStructurePayload({ snap: false })).boundaries.length);
  });

  it("a double-click in an other cell adds a cut there and selects it; with snap on, on the grid unless Cmd is held", async () => {
    const payload = cannedStructurePayload({ snap: true });
    const lane = createStructureState(payload).patternLanes().other!;
    const i = lane.reduce((best, c, j) => (c.end - c.start > lane[best].end - lane[best].start ? j : best), 0);
    expect(lane[i].end - lane[i].start).toBeGreaterThanOrEqual(4);
    const at = lane[i].start + (lane[i].end - lane[i].start) / 2 + 0.37;
    const v = await mount(payload);
    const n = v.cellEls("other").length;
    await v.dblclick(v.cellEls("other")[i], xOf(at), true);
    expect(v.cellEls("other")).toHaveLength(n + 1);
    const added = v.cuts("other").findIndex((c) => Math.abs(c - at) < 1e-6);
    expect(added).toBe(i);
    expect(v.selectedCut("other")).toBe(i);
    const w = await mount(payload);
    await w.dblclick(w.cellEls("other")[i], xOf(at));
    const snapped = w.cuts("other")[i];
    expect(onGrid(snapped, 2)).toBe(true); // the downbeats
    expect(Math.abs(snapped - at)).toBeLessThan(1.01);
  });

  it("while a lane cut is selected, the arrows and Delete leave the section boundaries alone", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await v.select("other", 1);
    const b = v.boundaries();
    const t = v.cuts("other")[1];
    await v.key("ArrowRight");
    expect(v.boundaries()).toEqual(b);
    expect(v.cuts("other")[1]).toBeGreaterThan(t);
    await v.key("Backspace");
    expect(v.boundaries()).toEqual(b);
  });

  it("selecting a section handle unselects the lane cut, and then the arrows move only the boundary", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await v.select("bass", 1);
    const handle = v.doc.querySelectorAll<HTMLElement>(".timeline [role=slider]")[2];
    await v.pointer(handle, "pointerdown", xOf(v.boundaries()[2]));
    await v.pointer(handle, "pointerup", xOf(v.boundaries()[2]));
    expect(v.selectedCut("bass")).toBe(-1);
    const cuts = v.cuts("bass");
    const b = v.boundaries()[2];
    await v.key("ArrowRight");
    expect(v.boundaries()[2]).toBeGreaterThan(b);
    expect(v.cuts("bass").length).toBe(cuts.length);
  });

  it("a click on the waveform background unselects the lane cut, so Delete then removes nothing", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await v.select("vocals", 1);
    v.doc.querySelector(".waveform canvas")!.dispatchEvent(new v.w.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(v.selectedCut("vocals")).toBe(-1);
    const t = v.cuts("vocals");
    await v.key("Delete");
    expect(v.cuts("vocals")).toEqual(t);
  });
});

describe("renaming a pattern from a lane cell's menu (Plan 6, Task 5)", () => {
  it("the menu's title renames; the list is sorted by number; typing Riff and Enter relabels every cell of that pattern", async () => {
    const payload = cannedStructurePayload({ stemUrls: STEM_URLS });
    const lane = createStructureState(payload).patternLanes().bass!;
    const i = lane.findIndex((c, j) => !c.rest && lane.some((d, m) => m !== j && d.label.replace(/′+$/, "") === c.label.replace(/′+$/, "")));
    expect(i).toBeGreaterThanOrEqual(0); // a pattern heard more than once
    const v = await mount(payload);
    expect(await v.rightClick(v.cellEls("bass")[i])).toBe(true);
    expect(v.menuItems()).toEqual(["Send to Simpler", "Send to new audio track", "Send all bass patterns to Drum Rack", "Send all bass to new audio track", "Send all stems to new tracks"]); // Task 7: a lane sends its patterns; Task 8: and all stems
    await v.clickTitle();
    expect(v.doc.querySelector(".send-menu")).toBeNull();
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe(lane[i].label);
    const names = [...v.doc.querySelectorAll(".rename [role=option]")].map((o) => o.textContent!.trim());
    const num = (l: string) => parseInt(l, 10);
    const primed = (l: string) => Number(l.includes("′"));
    expect(names).toEqual([...new Set(lane.filter((c) => !c.rest).map((c) => c.label))].sort((a, b) => num(a) - num(b) || primed(a) - primed(b)));
    input.value = "Riff";
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    await v.key("Enter", {}, input);
    expect(v.doc.querySelector(".rename")).toBeNull();
    const want = createStructureState(payload);
    want.renamePattern("bass", i, "Riff");
    expect(v.titles("bass")).toEqual(want.patternLanes().bass!.map((c) => `bass: ${c.rest ? "rest" : c.label}`));
    expect(v.titles("bass").filter((t) => t.startsWith("bass: Riff")).length).toBeGreaterThan(1);
    expect(v.titles("drums")).toEqual(want.patternLanes().drums!.map((c) => `drums: ${c.rest ? "rest" : c.label}`)); // per lane
  });

  it("Escape in the rename field changes nothing", async () => {
    const payload = cannedStructurePayload();
    const v = await mount(payload);
    const before = v.titles("other");
    await v.rightClick(v.cellEls("other")[1]);
    await v.clickTitle();
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    input.value = "Nope";
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    await v.key("Escape", {}, input);
    expect(v.titles("other")).toEqual(before);
  });

  it("a rest cell's title does not rename; without kept stems a named cell's title still does", async () => {
    const payload = cannedStructurePayload({ stemUrls: null });
    const lane = createStructureState(payload).patternLanes().vocals!;
    const rest = lane.findIndex((c) => c.rest);
    const named = lane.findIndex((c) => !c.rest);
    expect(rest).toBeGreaterThanOrEqual(0);
    const v = await mount(payload);
    await v.rightClick(v.cellEls("vocals")[rest]);
    expect(v.renameTitle()).toBeNull();
    await v.key("Escape", {}, v.doc.querySelector(".send-menu")!);
    await v.rightClick(v.cellEls("vocals")[named]);
    expect(v.renameTitle()).not.toBeNull();
    expect(v.renameTitle()!.disabled).toBe(false);
  });
});
