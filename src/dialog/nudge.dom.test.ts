// fb3, items 3-5 in jsdom: the built dialog bundle, a payload, real DOM events, and a stubbed Web Audio and fetch.
// Arrow-key nudges of a selected handle and their audition, the section lengths, and the zoom's wheel and keys.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { injectPayload, type DialogPayload } from "./protocol.js";

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;

const WIDTH = 1000;
const DURATION = 180;
const RATE = 8000; // the stubbed preview's rate
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

/** A silent preview in prepare.ts's format, frames [f0, f1) at RATE. */
function wav(f0: number, f1: number): ArrayBuffer {
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

interface Started {
  duration: number;
  args: number[];
  stopped: boolean;
}

const open: JSDOM[] = [];
afterEach(() => {
  while (open.length) open.pop()!.window.close();
});

async function mount(payload: DialogPayload) {
  const started: Started[] = [];
  const dom = new JSDOM(injectPayload(template, payload), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
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
        const q = url.indexOf("?");
        const get = (k: string) => Number(url.slice(q + 1).split("&").find((p) => p.startsWith(k + "="))!.slice(k.length + 1));
        const body = q < 0 ? wav(0, DURATION * RATE) : wav(Math.round(get("start") * RATE), Math.round(get("end") * RATE));
        return { ok: true, status: 200, arrayBuffer: async () => body };
      };
      (w as unknown as { AudioContext: unknown }).AudioContext = class {
        sampleRate = 48000;
        currentTime = 0;
        destination = {};
        resume = async () => {};
        close = async () => {};
        createBuffer(c: number, n: number, r: number) {
          return { numberOfChannels: c, length: n, sampleRate: r, duration: n / r, getChannelData: () => new Float32Array(n) };
        }
        createBufferSource() {
          const s: Started & { buffer: { duration: number } | null; connect(): void; start(...a: number[]): void; stop(): void; onended: null } = {
            buffer: null,
            duration: 0,
            args: [],
            stopped: false,
            onended: null,
            connect() {},
            start(...a: number[]) {
              s.args = a;
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
  const handles = () => [...doc.querySelectorAll<HTMLElement>("[role=slider]")];
  const v = {
    w,
    doc,
    started,
    handles,
    times: () => handles().map((h) => Number(h.getAttribute("aria-valuenow"))),
    lefts: () => handles().map((h) => parseFloat(h.style.left)),
    selected: () => handles().findIndex((h) => h.classList.contains("selected")),
    playing: () => [...doc.querySelectorAll(".band")].findIndex((b) => b.classList.contains("playing")),
    async select(i: number) {
      const h = handles()[i];
      h.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, clientX: 0 }));
      h.dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, clientX: 0 }));
      await flush();
    },
    async key(key: string, opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}, target: Element = doc.body) {
      const e = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
      target.dispatchEvent(e);
      await flush();
      return e;
    },
    async wheel(x: number, deltaY: number, opts: { deltaX?: number; ctrlKey?: boolean; metaKey?: boolean } = {}, target?: Element) {
      const e = new w.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, deltaY, ...opts });
      (target ?? doc.querySelector(".timeline")!).dispatchEvent(e);
      await flush();
      return e;
    },
  };
  return v;
}

const beats = Array.from({ length: 361 }, (_, i) => i * 0.5); // 120 BPM
const bars = beats.filter((_, i) => i % 4 === 0);
const cue = (over: object = {}) => cannedPayload({ snap: true, beatGrid: beats, barGrid: bars, tempo: 120, ...over });

describe("nudging a selected handle (fb3, item 4)", () => {
  it("Left/Right move it a beat of the grid, Shift a bar line; nothing moves without a selection", async () => {
    const v = await mount(cue());
    const t0 = v.times();
    await v.key("ArrowRight");
    expect(v.times()).toEqual(t0); // nothing selected
    await v.select(2);
    await v.key("ArrowRight");
    expect(v.times()[2]).toBe(t0[2] + 0.5);
    await v.key("ArrowLeft");
    await v.key("ArrowLeft");
    expect(v.times()[2]).toBe(t0[2] - 0.5);
    await v.key("ArrowRight", { shiftKey: true });
    expect(v.times()[2] % 2).toBe(0);
    expect(v.times()[2]).toBeGreaterThan(t0[2] - 0.5);
    expect(v.times()[2]).toBeLessThanOrEqual(t0[2] + 1.5);
    expect(v.times().filter((_, i) => i !== 2)).toEqual(t0.filter((_, i) => i !== 2));
  });

  it("with snap off and no beat grid, a beat at the song tempo from wherever the handle is", async () => {
    const v = await mount(cue({ snap: false, tempo: 150, beatGrid: undefined, barGrid: undefined }));
    await v.select(1);
    const t = v.times()[1];
    await v.key("ArrowRight");
    expect(v.times()[1]).toBeCloseTo(t + 0.4, 9);
    await v.key("ArrowLeft", { shiftKey: true });
    expect(v.times()[1]).toBeCloseTo(t + 0.4 - 1.6, 9);
  });

  it("with snap off and a beat grid, a beat of the clip's own spacing, not the song tempo (fb3 review m3)", async () => {
    // A Session clip warped at 120 in a 150 BPM song is rendered at its own rate: its beats are 0.5 s apart.
    const v = await mount(cue({ snap: false, tempo: 150 }));
    await v.select(1);
    const t = v.times()[1];
    await v.key("ArrowRight");
    expect(v.times()[1]).toBeCloseTo(t + 0.5, 9);
  });

  it("does nothing while the dialog is frozen after Apply (fb3 review m1)", async () => {
    const v = await mount(cue());
    await v.select(2);
    const t = v.times();
    const apply = [...v.doc.querySelectorAll<HTMLButtonElement>(".actions button")].find((b) => b.textContent!.trim() === "Apply")!;
    apply.click();
    await flush();
    expect(v.doc.querySelector(".stack")!.classList.contains("frozen")).toBe(true);
    const n = v.started.length;
    await v.key("ArrowRight");
    await v.key("Delete");
    expect(v.times()).toEqual(t);
    expect(v.started).toHaveLength(n);
  });

  it("each nudge plays 2 s of the section that now starts at the handle, from the handle, and restarts it", async () => {
    const v = await mount(cue());
    await v.select(3);
    await v.key("ArrowRight");
    const b = v.times()[3];
    expect(v.started).toHaveLength(1);
    expect(v.started[0].duration).toBeCloseTo(2, 3);
    expect(v.playing()).toBe(4); // the band after handle 3
    await v.key("ArrowRight");
    expect(v.started).toHaveLength(2);
    expect(v.started[0].stopped).toBe(true);
    expect(v.times()[3]).toBe(b + 0.5);
  });

  it("the arrows never reach the slider or the tabs while a handle is selected, and do when none is", async () => {
    const v = await mount(cannedStructurePayload({ snap: true }));
    const slider = v.doc.querySelector<HTMLInputElement>("input[type=range]")!;
    let reached = 0;
    slider.addEventListener("keydown", () => reached++);
    await v.select(2);
    const t = v.times()[2];
    const e = await v.key("ArrowRight", {}, slider);
    expect(e.defaultPrevented).toBe(true);
    expect(reached).toBe(0);
    expect(v.times()[2]).toBeGreaterThan(t);
    v.doc.querySelector(".waveform canvas")!.dispatchEvent(new v.w.MouseEvent("click", { bubbles: true }));
    await flush();
    const free = await v.key("ArrowRight", {}, slider);
    expect(free.defaultPrevented).toBe(false);
    expect(reached).toBe(1);
  });

  it("Structure under Downbeats steps allin1's beats; under Bars, Live's beats", async () => {
    const p = cannedStructurePayload({ snap: true, snapTarget: "downbeats" });
    const v = await mount(p);
    await v.select(2);
    const t = v.times()[2];
    await v.key("ArrowRight");
    expect(v.times()[2]).toBe(p.analysis.beats.find((b) => b > t + 1e-6));
    const live = Array.from({ length: 721 }, (_, i) => i * 0.25 + 0.1);
    const q = cannedStructurePayload({ snap: true, snapTarget: "bars", barGrid: live.filter((_, i) => i % 4 === 0), beatGrid: live });
    const w = await mount(q);
    await w.select(2);
    const u = w.times()[2];
    await w.key("ArrowRight");
    expect(w.times()[2]).toBe(live.find((b) => b > u + 1e-6));
  });

  it("Delete still removes the selected handle", async () => {
    const v = await mount(cue());
    const n = v.times().length;
    await v.select(1);
    await v.key("Delete");
    expect(v.times()).toHaveLength(n - 1);
  });
});

describe("section lengths (fb3, item 3)", () => {
  // jsdom has no layout, so every band counts as too narrow: the length is the tooltip's second line.
  const lensOf = (v: Awaited<ReturnType<typeof mount>>) => [...v.doc.querySelectorAll<HTMLElement>(".band")].map((b) => b.title.split("\n")[1]);
  const BARS = /^(\d+ bars?|\d+\.\d(\.\d)?)$/;
  const SECONDS = /^(\d+(\.\d)? s|\d+:\d\d)$/;

  it("fb4: Cue in Arrangement: bars and beats with snap on and with it off", async () => {
    const on = lensOf(await mount(cue()));
    expect(on.every((l) => BARS.test(l))).toBe(true);
    // Snap off, the handles stay where Cue put them, here off a song grid at 127.66 BPM (0.47 s a beat).
    const shifted = Array.from({ length: 384 }, (_, i) => i * 0.47);
    const off = lensOf(await mount(cue({ snap: false, beatGrid: shifted, barGrid: shifted.filter((_, i) => i % 4 === 0) })));
    expect(off.every((l) => BARS.test(l))).toBe(true);
    // Ends off the grid: some lengths are not whole beats, and have sixteenths.
    expect(off.some((l) => /^\d+\.\d\.\d$/.test(l))).toBe(true);
  });

  it("fb4: Cue on a warped Session clip: its own grid, snap off too, and a nudge steps it keeping the offset", async () => {
    // A clip warped at 150 in a 120 BPM song, rendered at its own rate: beats 0.4 s apart from 0.13 s.
    const own = Array.from({ length: 450 }, (_, i) => 0.13 + i * 0.4);
    const p = cue({ view: "session", warpNote: true, snap: false, tempo: 120, beatGrid: own, barGrid: own.filter((_, i) => i % 4 === 0) });
    const v = await mount(p);
    expect(lensOf(v).every((l) => BARS.test(l))).toBe(true);
    await v.select(1);
    const t = v.times()[1];
    await v.key("ArrowRight", { shiftKey: true });
    expect(v.times()[1]).toBeCloseTo(t + 1.6, 9); // a bar of the clip's grid, not of the song's
    expect(v.doc.querySelector(".readout .side.left")!.textContent).toMatch(BARS);
  });

  it("fb4: Cue on an unwarped Session clip: seconds, or a cached Structure analysis's bars and beats", async () => {
    const bare = cue({ view: "session", snap: false, beatGrid: null, barGrid: null });
    expect(lensOf(await mount(bare)).every((l) => SECONDS.test(l))).toBe(true);
    const sb = Array.from({ length: 400 }, (_, i) => 0.21 + i * 0.45);
    const v = await mount({ ...bare, structureGrid: { beats: sb, downbeats: sb.filter((_, i) => i % 4 === 0) } } as DialogPayload);
    expect(lensOf(v).every((l) => BARS.test(l))).toBe(true);
    await v.select(1);
    const t = v.times()[1];
    await v.key("ArrowRight");
    expect(v.times()[1]).toBeCloseTo(t + 0.45, 9); // one of allin1's beats
  });

  it("fb4: Structure with snap off: allin1's bars and beats, and a nudge steps allin1's beats", async () => {
    const p = cannedStructurePayload({ snap: false });
    const v = await mount(p);
    const lens = lensOf(v);
    expect(lens.every((l) => BARS.test(l))).toBe(true);
    await v.select(2);
    const t = v.times()[2];
    await v.key("ArrowRight");
    const b = p.analysis.beats;
    const k = b.findIndex((x) => x > t) - 1; // t sits on allin1's beats or between them
    const frac = (t - b[k]) / (b[k + 1] - b[k]);
    expect(v.times()[2]).toBeCloseTo(b[k + 1] + frac * (b[k + 2] - b[k + 1]), 9);
  });

  it("a nudge shows the two neighbours' lengths beside the handle", async () => {
    const v = await mount(cue());
    expect(v.doc.querySelector(".readout")).toBeNull();
    await v.select(2);
    await v.key("ArrowRight");
    const sides = [...v.doc.querySelectorAll(".readout .side")].map((e) => e.textContent);
    const tips = [...v.doc.querySelectorAll<HTMLElement>(".band")].map((b) => b.title.split("\n")[1]);
    expect(sides).toEqual([tips[2], tips[3]]);
  });
});

describe("zoom (fb3, item 5)", () => {
  it("Cmd+scroll zooms around the pointer; Fit and Cmd+0 reset; plain vertical scroll does nothing", async () => {
    const v = await mount(cue());
    const fit = v.lefts();
    expect(v.doc.querySelector(".fit")).toBeNull();
    await v.wheel(500, 100); // vertical, no modifier
    expect(v.lefts()).toEqual(fit);
    const e = await v.wheel(250, -208, { metaKey: true }); // e^2.08 = 8x, around 45 s
    expect(e.defaultPrevented).toBe(true);
    const z = v.lefts();
    const t = v.times();
    // 8x around the 25 % point: a handle at time x is at 25 + (x - 45) / 22.5 * 100 %.
    for (let i = 0; i < t.length; i++) expect(z[i]).toBeCloseTo(25 + ((t[i] - 45) / (DURATION / 8)) * 100, 0);
    expect(v.doc.querySelector(".fit")).not.toBeNull();
    await v.key("0", { metaKey: true });
    expect(v.lefts()).toEqual(fit);
    await v.wheel(250, -208, { ctrlKey: true }); // a pinch
    (v.doc.querySelector(".fit") as HTMLElement).click();
    await flush();
    expect(v.lefts()).toEqual(fit);
  });

  it("horizontal scroll pans a zoomed view, and the stem lanes and bands follow it", async () => {
    const v = await mount(cannedStructurePayload({ snap: true, patternLevel: 0 })); // Patterns at Fewer: a lane cell per section
    await v.wheel(500, -208, { metaKey: true });
    const before = v.lefts();
    await v.wheel(500, 0, { deltaX: 100 }); // a tenth of the view's width
    const after = v.lefts();
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i] - 10, 6);
    // A band and the lane cells of its section start at the same place.
    const band = v.doc.querySelectorAll<HTMLElement>(".band")[3];
    const cell = v.doc.querySelectorAll<HTMLElement>(".lane[data-source=drums] .cell")[3];
    expect(parseFloat(cell.style.left)).toBeCloseTo(parseFloat(band.style.left), 6);
    expect(parseFloat(cell.style.width)).toBeCloseTo(parseFloat(band.style.width), 6);
    // A wheel over the lanes zooms the timeline too (e^-1 out).
    const wide = parseFloat(band.style.width);
    await v.wheel(500, 100, { metaKey: true }, v.doc.querySelector(".lanes")!);
    expect(parseFloat(v.doc.querySelectorAll<HTMLElement>(".band")[3].style.width)).toBeCloseTo(wide / Math.E, 6);
  });
});
