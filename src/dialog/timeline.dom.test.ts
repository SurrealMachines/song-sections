// Drives the shared Timeline through both views in jsdom: the built dialog bundle, a payload, and real DOM events.
// Guards the Cue gestures that shipped (double-click remove, Delete/Backspace and their guards, the drag threshold,
// rename) and Task 9's snapping, since Tasks 9 and 11 both edit Timeline.svelte.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { createStructureState } from "./structureState.js";
import { groupColor } from "../grouping/palette.js";
import { fakeStructureAnalysis } from "../structure/fake.js";
import { injectPayload, type DialogPayload } from "./protocol.js";

// esbuild-svelte is CommonJS: under nodenext the default import is the module object, under vitest it is the function.
const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;

const WIDTH = 1000; // px: the stubbed timeline and canvas are this wide, starting at x = 0
const DURATION = 180; // fixture duration
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(25);

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

async function mount(payload: DialogPayload) {
  const sent: unknown[] = [];
  const dom = new JSDOM(injectPayload(template, payload), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      // Record what the page sends to the host (bridge.ts closeWith).
      (w as unknown as { chrome: unknown }).chrome = { webview: { postMessage: (m: { params: string[] }) => sent.push(JSON.parse(m.params[0])) } };
      // jsdom has no layout, pointer capture, ResizeObserver or canvas.
      w.Element.prototype.setPointerCapture = () => {};
      w.Element.prototype.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: WIDTH, bottom: 100, width: WIDTH, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
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
  const handles = () => [...doc.querySelectorAll<HTMLElement>("[role=slider]")];
  const view = {
    w,
    doc,
    sent,
    handles,
    count: () => handles().length,
    times: () => handles().map((h) => Number(h.getAttribute("aria-valuenow"))),
    selected: () => handles().findIndex((h) => h.classList.contains("selected")),
    labels: () => [...doc.querySelectorAll(".band")].map((b) => b.textContent!.trim()),
    snapBox: () => doc.querySelector<HTMLInputElement>(".snap input"),
    async pointer(el: Element, type: "pointerdown" | "pointermove" | "pointerup", x: number, ctrlKey = false) {
      el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: 40, ctrlKey }));
      await flush();
    },
    /** Press on handle i, move through the given x positions, release. */
    async drag(i: number, ...xs: number[]) {
      const h = handles()[i];
      await view.pointer(h, "pointerdown", (view.times()[i] / DURATION) * WIDTH);
      for (const x of xs) await view.pointer(h, "pointermove", x);
      await view.pointer(h, "pointerup", xs.at(-1) ?? 0);
    },
    async key(key: string, target: Element = doc.body) {
      target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await flush();
    },
    async dblclick(el: Element, x = 0, ctrlKey = false) {
      el.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true, clientX: x, ctrlKey }));
      await flush();
    },
    async rename(band: number, text: string, how: "Enter" | "Escape" | "blur") {
      await view.dblclick(doc.querySelectorAll(".band")[band]);
      const input = doc.querySelector<HTMLInputElement>(".rename input")!;
      input.value = text;
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      if (how === "blur") input.dispatchEvent(new w.FocusEvent("focusout", { bubbles: true }));
      else await view.key(how, input);
      await flush();
    },
    async toggleSnap() {
      view.snapBox()!.click();
      await flush();
    },
  };
  return view;
}

const grid = Array.from({ length: 361 }, (_, i) => i * 0.5);
const cases = {
  cue: () => cannedPayload({ snap: false, beatGrid: grid }),
  structure: () => cannedStructurePayload({ snap: false }),
};

describe.each(Object.entries(cases))("Timeline in the %s view", (name, make) => {
  it("removes a boundary on double-click, and merges the bands", async () => {
    const v = await mount(make());
    const n = v.count();
    const before = v.times();
    await v.dblclick(v.handles()[2]);
    expect(v.count()).toBe(n - 1);
    expect(v.labels()).toHaveLength(n);
    expect(v.times()).toEqual(before.filter((_, j) => j !== 2)); // Task 7 I2: the boundary that was double-clicked
    const after = v.times();
    await v.dblclick(v.handles()[n - 2]); // the last one, too
    expect(v.times()).toEqual(after.filter((_, j) => j !== n - 2));
  });

  it("selects on pointer-down, removes on Delete or Backspace and clears the selection", async () => {
    const v = await mount(make());
    const n = v.count();
    expect(v.selected()).toBe(-1);
    await v.pointer(v.handles()[1], "pointerdown", 100);
    await v.pointer(v.handles()[1], "pointerup", 100);
    expect(v.selected()).toBe(1);
    const before = v.times();
    await v.key("Delete");
    expect(v.count()).toBe(n - 1);
    expect(v.times()).toEqual(before.filter((_, j) => j !== 1)); // Task 7 I2: the selected boundary
    expect(v.selected()).toBe(-1);
    const mid = v.times();
    const k = mid.length - 1;
    await v.pointer(v.handles()[k], "pointerdown", (mid[k] / DURATION) * WIDTH);
    await v.pointer(v.handles()[k], "pointerup", (mid[k] / DURATION) * WIDTH);
    await v.key("Backspace");
    expect(v.count()).toBe(n - 2);
    expect(v.times()).toEqual(mid.filter((_, j) => j !== k));
  });

  it("a click on the waveform background deselects, so Delete then removes nothing", async () => {
    const v = await mount(make());
    const n = v.count();
    await v.pointer(v.handles()[1], "pointerdown", 100);
    await v.pointer(v.handles()[1], "pointerup", 100);
    expect(v.selected()).toBe(1);
    v.doc.querySelector(".waveform canvas")!.dispatchEvent(new v.w.MouseEvent("click", { bubbles: true, clientX: 500 }));
    await flush();
    expect(v.selected()).toBe(-1);
    await v.key("Delete");
    expect(v.count()).toBe(n);
  });

  it("ignores Delete and Backspace with nothing selected, and other keys", async () => {
    const v = await mount(make());
    const n = v.count();
    await v.key("Delete");
    await v.key("Backspace");
    await v.pointer(v.handles()[1], "pointerdown", 100);
    await v.key("a");
    await v.key("Enter");
    expect(v.count()).toBe(n);
  });

  it("keeps Delete and Backspace for the rename field", async () => {
    const v = await mount(make());
    const n = v.count();
    await v.pointer(v.handles()[1], "pointerdown", 100); // a boundary is selected...
    await v.dblclick(v.doc.querySelectorAll(".band")[3]); // ...and a band is being renamed
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    expect(input).not.toBeNull();
    await v.key("Backspace", input);
    await v.key("Delete", input);
    expect(v.count()).toBe(n);
    expect(v.selected()).toBe(1);
  });

  it("leaves Delete to any other text field, but not to a range input", async () => {
    const v = await mount(make());
    const n = v.count();
    const text = v.doc.createElement("input");
    v.doc.body.append(text);
    await v.pointer(v.handles()[1], "pointerdown", 100);
    await v.key("Delete", text);
    expect(v.count()).toBe(n);
    const range = v.doc.createElement("input");
    range.type = "range"; // the Cue granularity slider
    v.doc.body.append(range);
    await v.key("Delete", range);
    expect(v.count()).toBe(n - 1);
  });

  it("does not nudge a boundary within the 3 px drag threshold, but drags beyond it", async () => {
    const v = await mount(make());
    const before = v.times();
    const x = (before[3] / DURATION) * WIDTH;
    await v.drag(3, x + 2, x + 3);
    expect(v.times()).toEqual(before);
    expect(v.selected()).toBe(3); // a click still selects
    await v.drag(3, x + 20, x + 40);
    expect(v.times()[3]).toBeCloseTo(((x + 40) / WIDTH) * DURATION, 5);
    expect(v.times().filter((_, i) => i !== 3)).toEqual(before.filter((_, i) => i !== 3));
  });

  it("stops following the pointer after pointer-up", async () => {
    const v = await mount(make());
    const x = (v.times()[3] / DURATION) * WIDTH;
    await v.drag(3, x + 30);
    const moved = v.times();
    await v.pointer(v.handles()[3], "pointermove", x + 90);
    expect(v.times()).toEqual(moved);
  });

  it("renames a band on Enter or blur, and cancels on Escape", async () => {
    const v = await mount(make());
    const original = v.labels()[2];
    await v.rename(2, "Hook", "Enter");
    expect(v.labels()[2]).toBe("Hook");
    await v.rename(3, "Riff", "blur");
    expect(v.labels()[3]).toBe("Riff");
    await v.rename(4, "Nope", "Escape");
    expect(v.labels()[4]).not.toBe("Nope");
    expect(v.doc.querySelector(".rename input")).toBeNull();
    expect(v.labels()[2]).toBe("Hook");
    expect(original).not.toBe("Hook");
  });

  it("adds a boundary on a double-click of the waveform", async () => {
    const v = await mount(make());
    const n = v.count();
    // Between two existing boundaries, far from both.
    const t = v.times();
    const gap = t.findIndex((b, i) => i > 0 && b - t[i - 1] > 12);
    const mid = (t[gap - 1] + t[gap]) / 2;
    await v.dblclick(v.doc.querySelector("canvas")!, (mid / DURATION) * WIDTH);
    expect(v.count()).toBe(n + 1);
    expect(v.selected()).toBeGreaterThanOrEqual(0);
  });

  describe("snapping", () => {
    it(`snaps a drag to the ${name === "cue" ? "beat" : "downbeat"} grid when on, leaves it raw when off, and re-snaps when turned on`, async () => {
      const v = await mount(make());
      const box = v.snapBox();
      // The Structure preview defaults to snap on; the payload here turns it off, so turn it on first.
      expect(box).not.toBeNull();
      expect(box!.checked).toBe(false);
      const x = (v.times()[3] / DURATION) * WIDTH;
      const target = x + 37.3; // not a grid time
      await v.drag(3, target);
      const raw = v.times()[3];
      expect(raw).toBeCloseTo((target / WIDTH) * DURATION, 5);
      await v.toggleSnap();
      expect(box!.checked).toBe(true);
      const snapped = v.times()[3];
      expect(snapped).not.toBeCloseTo(raw, 3);
      await v.drag(5, (v.times()[5] / DURATION) * WIDTH + 41.7);
      const t5 = v.times()[5];
      // On the grid: a multiple of 0.5 s (Cue beats) or of 2 s (the fake's downbeats).
      const step = name === "cue" ? 0.5 : 2;
      expect(Math.abs(t5 / step - Math.round(t5 / step))).toBeLessThan(1e-6);
      expect(Math.abs(snapped / step - Math.round(snapped / step))).toBeLessThan(1e-6);
      await v.toggleSnap();
      const x1 = (v.times()[5] / DURATION) * WIDTH;
      await v.drag(5, x1 + 11.3);
      const off = v.times()[5];
      expect(Math.abs(off / step - Math.round(off / step))).toBeGreaterThan(1e-3);
    });

    it("snaps an add to the grid", async () => {
      const v = await mount({ ...make(), snap: true } as DialogPayload);
      const t = v.times();
      const gap = t.findIndex((b, i) => i > 0 && b - t[i - 1] > 12);
      const mid = (t[gap - 1] + t[gap]) / 2 + 0.31;
      const before = v.count();
      await v.dblclick(v.doc.querySelector("canvas")!, (mid / DURATION) * WIDTH);
      expect(v.count()).toBe(before + 1);
      const step = name === "cue" ? 0.5 : 2;
      const added = v.times().find((b) => !t.includes(b))!;
      expect(Math.abs(added / step - Math.round(added / step))).toBeLessThan(1e-6);
    });
  });
});

describe("the snap-bypass key (feedback round 2)", () => {
  // jsdom's navigator.platform is empty, so this is the Windows key, Ctrl; Chrome covers Cmd on the Mac.
  it.each(Object.entries(cases))("%s: Ctrl held skips snapping for that drag or add only", async (name, make) => {
    const v = await mount({ ...make(), snap: true } as DialogPayload);
    const step = name === "cue" ? 0.5 : 2;
    const onGrid = (t: number) => Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const h = v.handles()[3];
    const x = (v.times()[3] / DURATION) * WIDTH;
    await v.pointer(h, "pointerdown", x);
    await v.pointer(h, "pointermove", x + 37.3, true);
    expect(onGrid(v.times()[3])).toBe(false);
    await v.pointer(h, "pointermove", x + 41.7); // let go of the key mid-drag: it snaps again
    expect(onGrid(v.times()[3])).toBe(true);
    await v.pointer(h, "pointerup", x + 41.7);
    const t = v.times();
    const gap = t.findIndex((b, i) => i > 0 && b - t[i - 1] > 12);
    const mid = (t[gap - 1] + t[gap]) / 2 + 0.31;
    await v.dblclick(v.doc.querySelector("canvas")!, (mid / DURATION) * WIDTH, true);
    const added = v.times().find((b) => !t.includes(b))!;
    expect(added).toBeCloseTo(mid, 1);
    expect(onGrid(added)).toBe(false);
    expect(v.snapBox()!.checked).toBe(true);
  });
});

describe("the snap toggle", () => {
  it("is hidden without a beat grid in Cue, and without downbeats in Structure", async () => {
    expect((await mount(cannedPayload({ beatGrid: null, snap: true }))).snapBox()).toBeNull();
    const base = cannedStructurePayload();
    const none = cannedStructurePayload({ analysis: { ...base.analysis, beats: [], downbeats: [], bpm: null } });
    expect((await mount(none)).snapBox()).toBeNull();
  });

  it("is checked and shows on-grid boundaries when the payload has snap on", async () => {
    const v = await mount(cannedStructurePayload());
    expect(v.snapBox()!.checked).toBe(true);
  });
});

describe("the snap target (feedback round 1)", () => {
  const BARS = Array.from({ length: 90 }, (_, i) => 1 + 2 * i); // off the fake's downbeats (2, 4, 6, ...)
  const tab = (doc: Document, label: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>(".snap [role=tab]")].find((b) => b.textContent!.trim() === label)!;

  it("re-snaps the boundaries to Live's bars and back to the downbeats", async () => {
    const v = await mount(cannedStructurePayload({ barGrid: BARS }));
    expect(tab(v.doc, "Downbeats").getAttribute("aria-selected")).toBe("true");
    tab(v.doc, "Bars").click();
    await flush();
    expect(tab(v.doc, "Bars").getAttribute("aria-selected")).toBe("true");
    for (const t of v.times()) expect(BARS).toContain(t);
    tab(v.doc, "Downbeats").click();
    await flush();
    for (const t of v.times()) expect(t % 2).toBe(0);
  });

  it("disables Bars without a bar grid (an unwarped Session clip)", async () => {
    const v = await mount(cannedStructurePayload({ view: "session", barGrid: null }));
    expect(tab(v.doc, "Bars").disabled).toBe(true);
    expect(tab(v.doc, "Downbeats").disabled).toBe(false);
  });

  it("shows the target choice without downbeats when there are bars", async () => {
    const base = cannedStructurePayload();
    const v = await mount(cannedStructurePayload({ analysis: { ...base.analysis, beats: [], downbeats: [], bpm: null }, barGrid: BARS }));
    expect(v.snapBox()).not.toBeNull();
    expect(tab(v.doc, "Downbeats").disabled).toBe(true);
    expect(tab(v.doc, "Bars").getAttribute("aria-selected")).toBe("true");
  });
});

describe("Show stems (feedback round 1)", () => {
  it("toggles the waveform lanes; the letters stay in the lanes", async () => {
    const v = await mount(cannedStructurePayload());
    const box = v.doc.querySelector<HTMLInputElement>(".stems input")!;
    expect(box.checked).toBe(false);
    expect(v.doc.querySelector(".lanes.stems")).toBeNull();
    expect(v.doc.querySelectorAll("canvas.wave")).toHaveLength(0);
    box.click();
    await flush();
    expect(v.doc.querySelector(".lanes.stems")).not.toBeNull();
    expect(v.doc.querySelectorAll("canvas.wave")).toHaveLength(4);
    box.click();
    await flush();
    expect(v.doc.querySelectorAll("canvas.wave")).toHaveLength(0);
  });

  it("opens with the lanes shown when the payload says so", async () => {
    const v = await mount(cannedStructurePayload({ showStems: true }));
    expect(v.doc.querySelector<HTMLInputElement>(".stems input")!.checked).toBe(true);
    expect(v.doc.querySelectorAll("canvas.wave")).toHaveLength(4);
  });
});

describe("the Sections and Letters sliders (feedback round 1)", () => {
  const slider = (doc: Document, label: string) => doc.querySelector<HTMLInputElement>(`input[type=range][aria-label="${label}"]`)!;
  async function set(v: Awaited<ReturnType<typeof mount>>, label: string, value: number) {
    const input = slider(v.doc, label);
    input.value = String(value);
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    await flush();
  }

  it("Sections: Fewer down to one section, More adds boundaries, 0 is allin1's", async () => {
    // The fake's own sections do not repeat inside (fb2), so give More a strong candidate to add.
    const base = cannedStructurePayload();
    const seg = base.analysis.segments[3];
    const extra = { time: (seg.start + seg.end) / 2, strength: 0.5 };
    const cands = [...base.analysis.boundaryCandidates, extra].sort((x, y) => x.time - y.time);
    const v = await mount(cannedStructurePayload({ analysis: { ...base.analysis, boundaryCandidates: cands } }));
    expect(slider(v.doc, "Sections").value).toBe("0");
    const own = v.times();
    await set(v, "Sections", -1);
    expect(v.count()).toBe(0);
    expect(v.labels()).toHaveLength(1);
    await set(v, "Sections", 1);
    expect(v.count()).toBeGreaterThan(own.length);
    await set(v, "Sections", 0);
    expect(v.times()).toEqual(own);
  });

  it("a press on the Sections track that does not drag leaves the slider, the boundaries and the renames alone (dev-H)", async () => {
    const v = await mount(cannedStructurePayload());
    await v.rename(3, "Mine", "Enter");
    const input = slider(v.doc, "Sections");
    const before = v.times();
    const press = async (type: string, x: number) => {
      input.dispatchEvent(new v.w.MouseEvent(type, { bubbles: true, clientX: x, clientY: 5 }));
      await flush();
    };
    // The browser jumps a range input to the pressed point and fires input; a press 2 px off the thumb, no drag.
    await press("pointerdown", 52);
    input.value = "0.04";
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    await flush();
    await press("pointermove", 53); // 1 px of jitter: still a click
    await press("pointerup", 53);
    expect(input.value).toBe("0");
    expect(v.times()).toEqual(before);
    expect(v.labels()[3]).toBe("Mine");
    // A drag moves it.
    await press("pointerdown", 50);
    await press("pointermove", 80);
    input.value = "-1";
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    await flush();
    await press("pointerup", 80);
    expect(v.count()).toBe(0);
    // So do the arrow keys (an input event with no press).
    await set(v, "Sections", 0);
    expect(v.times()).toEqual(before);
  });

  it("on a long mix the handles follow the thumb at once and the letters catch up by release (fix round, review I3)", async () => {
    const D = 1800;
    const p = cannedStructurePayload({ durationSec: D, analysis: fakeStructureAnalysis(D) });
    const v = await mount(p);
    const expected = (g: number) => {
      const s = createStructureState(p);
      s.setGranularity(g);
      return s.sections().map((x) => x.label);
    };
    for (const g of [1, 0.95, 0.9]) {
      const input = slider(v.doc, "Sections");
      input.value = String(g);
      input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
      await flush();
      // The edges are the new ones whether or not the letters have been recomputed yet (that waits for release here).
      expect(v.labels()).toHaveLength(expected(g).length);
      expect(v.count()).toBe(expected(g).length - 1);
      input.dispatchEvent(new v.w.Event("change", { bubbles: true }));
      await flush();
      expect(v.labels()).toEqual(expected(g));
    }
  }, 30_000);

  it("Sections is disabled without boundary candidates", async () => {
    const base = cannedStructurePayload();
    const v = await mount(cannedStructurePayload({ analysis: { ...base.analysis, boundaryCandidates: [] } }));
    expect(slider(v.doc, "Sections").disabled).toBe(true);
  });

  it("Letters: moving it re-letters the bands and keeps the boundaries", async () => {
    const v = await mount(cannedStructurePayload());
    expect(Number(slider(v.doc, "Letters").value)).toBeCloseTo(0.15, 6);
    const before = v.times();
    await set(v, "Letters", 0.05); // Strict: the last chorus (0.034 from the others) becomes a variant
    expect(v.times()).toEqual(before);
    expect(v.labels().some((l) => /^[A-Z]′ - chorus/.test(l))).toBe(true);
  });
});

describe("Apply with a rename still being typed (feedback round 2, item 1)", () => {
  // jsdom moves no focus on click(), like WebKit, where clicking a button does not focus it: Apply must commit the
  // open field itself rather than rely on its blur.
  it.each(Object.entries(cases))("%s: the rename is in the result", async (_, make) => {
    const v = await mount(make());
    await v.dblclick(v.doc.querySelectorAll(".band")[2]);
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    input.value = "Typed, not committed";
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    const apply = [...v.doc.querySelectorAll<HTMLButtonElement>(".actions button")].find((b) => b.textContent!.trim() === "Apply")!;
    apply.click();
    await flush();
    expect(v.sent).toHaveLength(1);
    const r = v.sent[0] as { action: string; sections: { label: string }[] };
    expect(r.action).toBe("apply");
    expect(r.sections[2].label).toBe("Typed, not committed");
  });
});

describe("colour follows the letter of a renamed band (feedback round 2, item 2)", () => {
  it("a band renamed to another band's letter, primed with an ASCII ', takes that letter's variant colour", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const bands = () => [...v.doc.querySelectorAll<HTMLElement>(".band")];
    const chorus = v.labels().findIndex((l) => l.endsWith("chorus"));
    const letter = v.labels()[chorus].split(" - ")[0];
    const other = v.labels().findIndex((l) => !l.startsWith(letter) && l.endsWith("verse"));
    expect(bands()[other].style.background).not.toBe(bands()[chorus].style.background);
    await v.rename(other, letter, "Enter");
    expect(bands()[other].style.background).toBe(bands()[chorus].style.background);
    await v.rename(other, `${letter}' - lift`, "Enter");
    expect(v.labels()[other]).toBe(`${letter}' - lift`);
    const hex = "#" + groupColor(letter.charCodeAt(0) - 65, true, "vivid").toString(16).padStart(6, "0");
    const rgb = (h: string) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    expect(bands()[other].style.background).toBe(rgb(hex));
  });
});

describe("the rename popover (feedback round 2, item 3)", () => {
  const field = (v: Awaited<ReturnType<typeof mount>>) => v.doc.querySelector<HTMLInputElement>(".rename input");
  const rows = (v: Awaited<ReturnType<typeof mount>>) => [...v.doc.querySelectorAll<HTMLButtonElement>(".rename [role=option]")];
  async function open(v: Awaited<ReturnType<typeof mount>>, band: number) {
    await v.dblclick(v.doc.querySelectorAll(".band")[band]);
    return field(v)!;
  }
  async function type(v: Awaited<ReturnType<typeof mount>>, text: string) {
    const input = field(v)!;
    input.value = text;
    input.dispatchEvent(new v.w.Event("input", { bubbles: true }));
    await flush();
  }

  it("opens prefilled and selected, over the distinct labels in use, sorted by letter (Matt, 2026-11-11), names with none last", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await v.rename(6, "Bridge mine", "Enter");
    const input = await open(v, 3);
    expect(input.value).toBe(v.labels()[3]);
    expect(v.doc.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    const lettered = [...new Set(v.labels())].filter((l) => /^[A-Z]['’′]? - /.test(l)).sort();
    expect(rows(v).map((r) => r.textContent!.trim())).toEqual([...lettered, "Bridge mine"]);
    expect(rows(v).map((r) => r.textContent!.trim())).toContain("Bridge mine");
    // The band's own label is marked, as the Patchbay Menu marks its value.
    expect(rows(v).filter((r) => r.classList.contains("is-selected")).map((r) => r.textContent!.trim())).toEqual([v.labels()[3]]);
  });

  it("a click on a label in the list commits it", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const target = v.labels()[8];
    await open(v, 2);
    rows(v).find((r) => r.textContent!.trim() === target)!.click();
    await flush();
    expect(field(v)).toBeNull();
    expect(v.labels()[2]).toBe(target);
  });

  it("typing filters the list; Down/Up move through it and Enter commits the highlighted label", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const labels = v.labels();
    await open(v, 2);
    await type(v, "CHOR");
    const choruses = [...new Set(labels.filter((l) => l.toLowerCase().includes("chor")))];
    expect(rows(v).map((r) => r.textContent!.trim())).toEqual(choruses);
    expect(rows(v).some((r) => r.classList.contains("is-active"))).toBe(false);
    expect(choruses.length).toBeGreaterThan(0);
    await v.key("ArrowDown", field(v)!);
    expect(rows(v).findIndex((r) => r.classList.contains("is-active"))).toBe(0);
    await v.key("ArrowUp", field(v)!); // back to the field
    expect(rows(v).some((r) => r.classList.contains("is-active"))).toBe(false);
    for (let k = 0; k < choruses.length + 2; k++) await v.key("ArrowDown", field(v)!); // stops at the last row
    expect(rows(v).findIndex((r) => r.classList.contains("is-active"))).toBe(choruses.length - 1);
    for (let k = 1; k < choruses.length; k++) await v.key("ArrowUp", field(v)!);
    expect(rows(v).findIndex((r) => r.classList.contains("is-active"))).toBe(0);
    expect(field(v)!.getAttribute("aria-activedescendant")).toBe(rows(v)[0].id);
    await v.key("Enter", field(v)!);
    expect(v.labels()[2]).toBe(choruses[0]);
  });

  it("Enter with no row highlighted commits the text as typed; a filter that matches nothing hides the list", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await open(v, 4);
    await type(v, "Zzz new");
    expect(rows(v)).toHaveLength(0);
    await v.key("Enter", field(v)!);
    expect(v.labels()[4]).toBe("Zzz new");
  });

  it("Escape cancels, after typing and after moving into the list", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const before = v.labels();
    await open(v, 3);
    await type(v, "Nope");
    await v.key("Escape", field(v)!);
    await open(v, 3);
    await v.key("ArrowDown", field(v)!);
    await v.key("Escape", field(v)!);
    expect(field(v)).toBeNull();
    expect(v.labels()).toEqual(before);
  });

  it("hovering a row only highlights it: Enter and focus leaving take the typed text (review I1)", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const hover = (k: number) => {
      const row = rows(v)[k];
      expect(row, "a row to hover").toBeDefined();
      row.dispatchEvent(new v.w.MouseEvent("mouseover", { bubbles: true }));
      row.dispatchEvent(new v.w.MouseEvent("mouseenter"));
    };
    // "chorus" lists every chorus label without being one of them.
    await open(v, 2);
    await type(v, "chorus");
    expect(rows(v).length).toBeGreaterThan(0);
    hover(0);
    await flush();
    expect(rows(v).some((r) => r.getAttribute("aria-selected") === "true")).toBe(false);
    await v.key("Enter", field(v)!);
    expect(v.labels()[2]).toBe("chorus");
    await open(v, 3);
    await type(v, "verse");
    hover(rows(v).length - 1);
    await flush();
    field(v)!.dispatchEvent(new v.w.FocusEvent("focusout", { bubbles: true, relatedTarget: v.doc.body }));
    await flush();
    expect(v.labels()[3]).toBe("verse");
  });

  it("Down then focus leaving commits the typed text, not the row the keys moved to (review I1)", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await open(v, 5);
    const typed = field(v)!.value;
    await v.key("ArrowDown", field(v)!);
    expect(rows(v).findIndex((r) => r.classList.contains("is-active"))).toBe(0);
    field(v)!.dispatchEvent(new v.w.FocusEvent("focusout", { bubbles: true, relatedTarget: v.doc.body }));
    await flush();
    expect(field(v)).toBeNull();
    expect(v.labels()[5]).toBe(typed);
  });

  it("focus leaving the popover commits", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await open(v, 5);
    await type(v, "Clicked away");
    field(v)!.dispatchEvent(new v.w.FocusEvent("focusout", { bubbles: true, relatedTarget: v.doc.body }));
    await flush();
    expect(field(v)).toBeNull();
    expect(v.labels()[5]).toBe("Clicked away");
  });
});
