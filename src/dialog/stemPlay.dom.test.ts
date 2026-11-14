// Feedback round 2 B, stem audition, in jsdom: the built dialog bundle with a payload, real DOM events, and a stubbed
// fetch and AudioContext. A lane cell click plays that section of that stem; a second click, another cell, a band or
// a press elsewhere stops it; without kept stems a click does nothing and the tooltip says how to get them.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pcm16Header } from "../structure/audition.js";
import { STEM_NAMES } from "../structure/contract.js";
import { cannedStructurePayload } from "./fixture.js";
import { injectPayload, type StructurePayload } from "./protocol.js";
import { createStructureState } from "./structureState.js";

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(25);
const STEM_URLS = Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as StructurePayload["stemUrls"];

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

/** A one-second 16-bit stereo slice, as the server sends one. */
function wavBytes(): ArrayBuffer {
  const b = Buffer.concat([pcm16Header(44100), Buffer.alloc(44100 * 4)]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
}

async function mount(payload: StructurePayload) {
  const fetched: string[] = [];
  const sources: Array<{ stopped: boolean; started: boolean }> = [];
  const sent: unknown[] = [];
  const dom = new JSDOM(injectPayload(template, payload), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      (w as unknown as { chrome: unknown }).chrome = { webview: { postMessage: (m: { params: string[] }) => sent.push(JSON.parse(m.params[0])) } };
      w.Element.prototype.setPointerCapture = () => {};
      w.Element.prototype.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
      w.HTMLCanvasElement.prototype.getContext = (() => null) as never;
      (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      };
      (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
        fetched.push(url);
        return { ok: true, status: 200, arrayBuffer: async () => wavBytes() };
      };
      const buffer = (n: number, rate: number) => ({ length: n, sampleRate: rate, duration: n / rate, getChannelData: () => new Float32Array(n) });
      (w as unknown as { AudioContext: unknown }).AudioContext = class {
        currentTime = 0;
        destination = {};
        resume = async () => {};
        close = async () => {};
        createBuffer = (_ch: number, n: number, rate: number) => buffer(n, rate);
        decodeAudioData = async () => buffer(44100 * 180, 44100);
        createBufferSource = () => {
          const s = { stopped: false, started: false, buffer: null, onended: null, connect() {}, start: () => void (s.started = true), stop: () => void (s.stopped = true) };
          sources.push(s);
          return s;
        };
      };
    },
  });
  open.push(dom);
  await flush();
  const w = dom.window;
  const doc = w.document;
  const cells = (stem: string) => [...doc.querySelectorAll<HTMLElement>(`.lane[data-source=${stem}] .cell`)];
  return {
    w,
    doc,
    fetched,
    sources,
    sent,
    cells,
    playingCells: () => [...doc.querySelectorAll(".lanes .cell.playing")].map((c) => `${c.closest(".lane")!.getAttribute("data-source")}:${cells(c.closest(".lane")!.getAttribute("data-source")!).indexOf(c as HTMLElement)}`),
    stemFetches: () => fetched.filter((u) => u.startsWith("stems/")),
    async click(el: Element) {
      el.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await flush();
    },
  };
}

describe("stem audition in the Structure dialog", () => {
  it("a lane cell click fetches only that section of that stem, and shows the cell as playing", async () => {
    const payload = cannedStructurePayload({ stemUrls: STEM_URLS });
    const v = await mount(payload);
    const lane = createStructureState(payload).patternLanes().bass!; // Plan 6: the lanes are the pattern lanes
    await v.click(v.cells("bass")[1]);
    expect(v.stemFetches()).toHaveLength(1);
    const [url] = v.stemFetches();
    expect(url.startsWith("stems/bass.wav?start=")).toBe(true);
    const start = Number(url.match(/start=([^&]+)/)![1]);
    const end = Number(url.match(/end=([^&]+)/)![1]);
    expect(start).toBeCloseTo(lane[1].start, 4);
    expect(lane[1].end - lane[1].start).toBeLessThanOrEqual(120);
    expect(end).toBeCloseTo(lane[1].end, 4); // up to 120 s, the whole section in one request (fb2 ruling)
    expect(v.playingCells()).toEqual(["bass:1"]);
    expect(v.sources.filter((s) => s.started)).toHaveLength(1);
  });

  it("clicking the playing cell again stops it", async () => {
    const v = await mount(cannedStructurePayload({ stemUrls: STEM_URLS }));
    await v.click(v.cells("drums")[0]);
    await v.click(v.cells("drums")[0]);
    expect(v.playingCells()).toEqual([]);
    expect(v.sources.every((s) => s.stopped)).toBe(true);
  });

  it("another cell takes over; a press anywhere else stops it", async () => {
    const v = await mount(cannedStructurePayload({ stemUrls: STEM_URLS }));
    await v.click(v.cells("drums")[0]);
    await v.click(v.cells("vocals")[2]);
    expect(v.playingCells()).toEqual(["vocals:2"]);
    expect(v.stemFetches().at(-1)!.startsWith("stems/vocals.wav?")).toBe(true);
    v.doc.querySelector("header")!.dispatchEvent(new v.w.PointerEvent("pointerdown", { bubbles: true }));
    await flush();
    expect(v.playingCells()).toEqual([]);
  });

  it("one sound at a time: a band stops the stem, and a stem stops the band", async () => {
    const v = await mount(cannedStructurePayload({ stemUrls: STEM_URLS }));
    await v.click(v.cells("other")[1]);
    const band = v.doc.querySelectorAll<HTMLElement>(".band")[0];
    band.click(); // a click alone (no press): the band's own start stops the stem
    await flush();
    expect(v.playingCells()).toEqual([]);
    expect(band.classList.contains("playing")).toBe(true);
    await v.click(v.cells("other")[1]);
    expect(band.classList.contains("playing")).toBe(false);
    expect(v.playingCells()).toEqual(["other:1"]);
  });

  it("without kept stems a click does nothing, and the tooltip says to re-analyse", async () => {
    for (const stemUrls of [null, undefined]) {
      const v = await mount(cannedStructurePayload({ stemUrls }));
      const cell = v.cells("drums")[0];
      expect(cell.title).toMatch(/^drums: .+\nClick Re-analyze to listen to stems$/);
      await v.click(cell);
      expect(v.stemFetches()).toEqual([]);
      expect(v.playingCells()).toEqual([]);
    }
    const ok = await mount(cannedStructurePayload({ stemUrls: STEM_URLS }));
    expect(ok.cells("drums")[0].title).not.toMatch(/Re-analyze/);
  });

  it("without kept stems, Re-analyze sits next to Show stems and sends reanalyse with the dialog's choices (fb2 ruling)", async () => {
    const payload = cannedStructurePayload({ stemUrls: null });
    const v = await mount(payload);
    const wrap = v.doc.querySelector<HTMLElement>(".toggle-row.stems .reanalyse")!;
    expect(wrap).not.toBeNull();
    expect(wrap.title).toBe("Runs the analysis again so stems can be played; edits in this dialog are lost");
    const button = wrap.querySelector("button")!;
    expect(button.textContent!.trim()).toBe("Re-analyze");
    await v.click(button);
    expect(v.sent).toEqual([{ action: "reanalyse", prefs: createStructureState(payload).prefs() }]);

    const ok = await mount(cannedStructurePayload({ stemUrls: STEM_URLS }));
    expect(ok.doc.querySelector(".reanalyse")).toBeNull();
    expect(ok.doc.querySelector(".toggle-row.stems")).not.toBeNull();
  });

  it("Colors and Slice by do not touch the boundaries, so the stem keeps playing (ac431b4)", async () => {
    // The canned payload's own pattern features, made once when fixture.ts loads: built here, inside the test, they
    // took ~1.6 s of its 5 s and timed it out once under a full parallel run.
    const payload = cannedStructurePayload({ stemUrls: STEM_URLS, snap: false });
    expect(payload.patterns).not.toBeNull();
    const v = await mount(payload);
    const tab = (label: string) => [...v.doc.querySelectorAll("[role=tab]")].find((b) => b.textContent!.trim() === label)!;
    await v.click(v.cells("other")[1]);
    expect(v.playingCells()).toEqual(["other:1"]);
    tab("Soft").dispatchEvent(new v.w.MouseEvent("click", { bubbles: true })); // no pointerdown: that alone stops it
    await flush();
    expect(v.playingCells()).toEqual(["other:1"]);
    tab("Drums").dispatchEvent(new v.w.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(tab("Drums").getAttribute("aria-selected")).toBe("true"); // Slice by did change
    expect(v.playingCells()).toEqual(["other:1"]);
  });

  describe("Slice by (Plan 6)", () => {
    /** The canned features with only `sources`, each as `over` changes it. */
    const FEATURES = (sources: string[], over: Record<string, object> = {}) => {
      const f = cannedStructurePayload().patterns!;
      const kept = Object.entries(f.sources).filter(([k]) => sources.includes(k));
      return { ...f, sources: Object.fromEntries(kept.map(([k, v]) => [k, { ...v, ...over[k] }])) } as StructurePayload["patterns"];
    };
    const items = (v: Awaited<ReturnType<typeof mount>>) => {
      const tabs = [...v.doc.querySelectorAll("[role=tab]")].filter((b) => ["Sections", "All", "Mix", "Drums", "Bass", "Vocals", "Other"].includes(b.textContent!.trim()));
      return Object.fromEntries(tabs.map((b) => [b.textContent!.trim(), (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true"]));
    };

    it("offers Sections, Drums, Bass, Vocals and Other: no All (Matt, 4 Nov)", async () => {
      const v = await mount(cannedStructurePayload());
      expect(Object.keys(items(v))).toEqual(["Sections", "Drums", "Bass", "Vocals", "Other"]);
    });

    it("offers Sections always, and a stem only when it has a pattern lane", async () => {
      const none = await mount(cannedStructurePayload({ patterns: null }));
      expect(items(none)).toEqual({ Sections: false, Drums: true, Bass: true, Vocals: true, Other: true });
      const mixOnly = await mount(cannedStructurePayload({ patterns: FEATURES(["mix"]) })); // the mix has no lane of its own
      expect(items(mixOnly)).toEqual({ Sections: false, Drums: true, Bass: true, Vocals: true, Other: true });
      const some = await mount(cannedStructurePayload({ patterns: FEATURES(["drums", "other"]) }));
      expect(items(some)).toEqual({ Sections: false, Drums: false, Bass: true, Vocals: true, Other: false });
    });

    it("disables a source the payload lists but the engine leaves out (its cells do not decode)", async () => {
      const payload = cannedStructurePayload({ patterns: FEATURES(["drums", "vocals"], { vocals: { dims: 1 } }) });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); // the engine says it left vocals out
      try {
        expect(createStructureState(payload).patternSources).toEqual(["drums"]);
        const v = await mount(payload);
        expect(items(v)).toEqual({ Sections: false, Drums: false, Bass: true, Vocals: true, Other: true });
      } finally {
        warn.mockRestore();
      }
    });

    it("disables a source whose lane is all rests: nothing to name or cut", async () => {
      const f = cannedStructurePayload().patterns!;
      const quiet = Buffer.from(new Int8Array(f.sources.vocals!.cells).fill(-100).buffer).toString("base64");
      const payload = cannedStructurePayload({ patterns: FEATURES(["vocals", "other"], { vocals: { loud: quiet } }) });
      const s = createStructureState(payload);
      expect(s.patternSources).toContain("vocals");
      expect(s.patternLanes().vocals!.every((c) => c.rest)).toBe(true);
      const v = await mount(payload);
      expect(items(v)).toEqual({ Sections: false, Drums: true, Bass: true, Vocals: true, Other: false });
    });

    it("with Output Locators on an arrangement clip, only Sections is offered", async () => {
      const v = await mount(cannedStructurePayload({ patterns: FEATURES(["drums", "bass", "vocals", "other"]), output: "locators" }));
      expect(items(v)).toEqual({ Sections: false, Drums: true, Bass: true, Vocals: true, Other: true });
      const session = await mount(cannedStructurePayload({ view: "session", patterns: FEATURES(["drums"]), output: "locators" }));
      expect(items(session)).toMatchObject({ Drums: false, Bass: true });
    });

    it("a remembered Slice by All (\"mix\") opens on Sections", async () => {
      const v = await mount(cannedStructurePayload({ sliceBy: "mix" as never }));
      const selected = [...v.doc.querySelectorAll("[role=tab][aria-selected=true]")].map((b) => b.textContent!.trim());
      expect(selected).toContain("Sections");
      expect(selected).not.toContain("All");
    });

    it("a click selects a source", async () => {
      const v = await mount(cannedStructurePayload({ patterns: FEATURES(["drums"]) }));
      const tab = (label: string) => [...v.doc.querySelectorAll("[role=tab]")].find((b) => b.textContent!.trim() === label)!;
      expect(tab("Sections").getAttribute("aria-selected")).toBe("true");
      await v.click(tab("Drums"));
      expect(tab("Drums").getAttribute("aria-selected")).toBe("true");
      expect(tab("Sections").getAttribute("aria-selected")).toBe("false");
    });
  });

  describe("with hand edits, Re-analyze asks first, inline (fb2 review I2)", () => {
    type View = Awaited<ReturnType<typeof mount>>;
    const labels = (v: View) => [...v.doc.querySelectorAll(".band")].map((b) => b.textContent!.trim());
    const confirm = (v: View) => v.doc.querySelector<HTMLElement>(".confirm[role=alertdialog]");
    const button = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent!.trim() === text)!;
    async function rename(v: View, band: number, text: string) {
      v.doc.querySelectorAll(".band")[band].dispatchEvent(new v.w.MouseEvent("dblclick", { bubbles: true }));
      await flush();
      const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
      input.value = text;
      input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
      input.dispatchEvent(new v.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flush();
    }
    async function move(v: View, i: number, dx: number) {
      const h = v.doc.querySelectorAll("[role=slider]")[i];
      const x = (Number(h.getAttribute("aria-valuenow")) / 180) * 1000;
      for (const [type, at] of [["pointerdown", x], ["pointermove", x + dx], ["pointerup", x + dx]] as const) {
        h.dispatchEvent(new v.w.MouseEvent(type, { bubbles: true, clientX: at, clientY: 40 }));
        await flush();
      }
    }
    const reanalyse = (v: View) => v.click(v.doc.querySelector(".toggle-row.stems .reanalyse button")!);

    it.for([
      ["a rename", (v: View) => rename(v, 3, "Mine")],
      ["a move", (v: View) => move(v, 2, 30)],
    ] as const)("after %s: Keep editing keeps the edits and sends nothing; Re-analyze then sends reanalyse", async ([, edit]) => {
      const payload = cannedStructurePayload({ stemUrls: null, snap: false });
      const v = await mount(payload);
      await edit(v);
      const edited = { labels: labels(v), times: [...v.doc.querySelectorAll("[role=slider]")].map((h) => h.getAttribute("aria-valuenow")) };
      await reanalyse(v);
      expect(v.sent).toEqual([]);
      expect(confirm(v)!.textContent).toContain("Re-analyze discards your edits in this dialog.");
      await v.click(button(confirm(v)!, "Keep editing"));
      expect(confirm(v)).toBeNull();
      expect(v.sent).toEqual([]);
      expect(labels(v)).toEqual(edited.labels);
      expect([...v.doc.querySelectorAll("[role=slider]")].map((h) => h.getAttribute("aria-valuenow"))).toEqual(edited.times);
      await reanalyse(v);
      await v.click(button(confirm(v)!, "Re-analyze"));
      await flush();
      expect(v.sent).toEqual([{ action: "reanalyse", prefs: createStructureState(payload).prefs() }]);
    });

    it("a Sections slider move alone is not a hand edit: one click re-analyses", async () => {
      const payload = cannedStructurePayload({ stemUrls: null, snap: false });
      const s = createStructureState(payload);
      expect(s.handEdited).toBe(false);
      s.setGranularity(0.3);
      expect(s.handEdited).toBe(false);
      s.rename(1, "Mine");
      expect(s.handEdited).toBe(true);
      s.setGranularity(0.31); // the rename survives on its span, or is dropped with it
      expect(s.handEdited).toBe(Object.keys(s.labels).length > 0);
    });
  });
});
