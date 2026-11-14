// v2: the send menu in the built dialog (jsdom): a right-click on a band (the mix) or a stem lane cell (that stem)
// opens it; a choice closes the dialog with a send result carrying the dialog's sections as edited; Esc, or a click
// elsewhere, closes it with nothing sent; its keys never reach the timeline behind it.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { injectPayload, type DialogPayload } from "./protocol.js";
import { createStructureState } from "./structureState.js";

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;
const flush = () => new Promise((r) => setTimeout(r, 25));
const URLS = Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as Record<StemName, string>;

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

type Sent = {
  action: string;
  target?: string;
  source?: string;
  index?: number;
  sections?: Array<{ label: string; start: number }>;
  unit?: string;
  prefs?: unknown;
  stems?: Record<StemName, Array<{ label: string; start: number }>>;
};

async function mount(payload: DialogPayload) {
  const sent: Sent[] = [];
  const dom = new JSDOM(injectPayload(template, payload), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.setPointerCapture = () => {};
      w.HTMLCanvasElement.prototype.getContext = (() => null) as never;
      (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      };
      (w as unknown as { webkit: unknown }).webkit = {
        messageHandlers: { live: { postMessage: (m: { params: string[] }) => sent.push(JSON.parse(m.params[0])) } },
      };
    },
  });
  open.push(dom);
  await flush();
  const w = dom.window;
  const doc = w.document;
  const v = {
    doc,
    sent,
    menu: () => doc.querySelector<HTMLElement>(".send-menu"),
    items: () => [...doc.querySelectorAll<HTMLButtonElement>(".send-menu [role=menuitem]")],
    item: (label: string) => v.items().find((b) => b.textContent!.trim() === label),
    handles: () => doc.querySelectorAll("[role=slider]").length,
    /** Right-clicks `el`; returns whether the page kept the browser's own menu from opening. */
    async rightClick(el: Element) {
      const e = new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 });
      el.dispatchEvent(e);
      await flush();
      return e.defaultPrevented;
    },
    async click(el: Element) {
      (el as HTMLElement).click();
      await flush();
    },
    async key(key: string, target: Element) {
      target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await flush();
    },
    async pointerdown(el: Element) {
      el.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      await flush();
    },
    band: (i: number) => doc.querySelectorAll(".band")[i],
    cell: (stem: StemName | "mix", i: number) => doc.querySelectorAll(`.lane[data-source=${stem}] .cell`)[i],
  };
  return v;
}

const ITEMS = (source: string) => ["Send to Simpler", "Send to new audio track", `Send all ${source} sections to Drum Rack`, `Send all ${source} to new audio track`];
/** Plan 6, Task 7: a pattern lane's cell sends the lane's slices. */
const LANE_ITEMS = (source: string) => ["Send to Simpler", "Send to new audio track", `Send all ${source} patterns to Drum Rack`, `Send all ${source} to new audio track`];
/** Plan 6, Task 8: with kept stems, every menu ends with this. */
const ALL_STEMS = "Send all stems to new tracks";

describe("send menu, Cue", () => {
  it("a right-click on a band opens the mix menu instead of the browser's, at the section, with the first item focused", async () => {
    const v = await mount(cannedPayload());
    expect(await v.rightClick(v.band(2))).toBe(true);
    expect(v.items().map((b) => b.textContent!.trim())).toEqual(ITEMS("mix"));
    expect(v.menu()!.querySelector(".title")!.textContent).toContain("(mix)");
    expect(v.doc.activeElement).toBe(v.items()[0]);
    expect(v.sent).toEqual([]);
  });

  it.each([
    ["Send to Simpler", "simpler"],
    ["Send to new audio track", "audioSection"],
    ["Send all mix sections to Drum Rack", "drumRack"],
    ["Send all mix to new audio track", "audioWhole"],
  ])("%s closes the dialog with that send, carrying the sections Apply would send", async (label, target) => {
    const v = await mount(cannedPayload());
    await v.rightClick(v.band(1));
    await v.click(v.item(label)!);
    expect(v.menu()).toBeNull();
    // Apply from the same dialog state, in a fresh dialog.
    const a = await mount(cannedPayload());
    await a.click([...a.doc.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Apply")!);
    expect(v.sent).toEqual([{ action: "send", target, source: "mix", index: 1, sections: a.sent[0].sections }]);
  });

  it("sends the dialog's edits: a rename still being typed is in the result", async () => {
    const v = await mount(cannedPayload());
    v.band(0).dispatchEvent(new v.doc.defaultView!.MouseEvent("dblclick", { bubbles: true }));
    await flush();
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    input.value = "Verse";
    input.dispatchEvent(new v.doc.defaultView!.Event("input", { bubbles: true }));
    await v.rightClick(v.band(0));
    expect(v.menu()!.querySelector(".title")!.textContent).toContain("Verse");
    await v.click(v.item("Send to Simpler")!);
    expect(v.sent[0].sections![0].label).toBe("Verse");
  });

  it("Esc closes it with nothing sent; its keys never reach the timeline (no Delete of a boundary)", async () => {
    const v = await mount(cannedPayload());
    const n = v.handles();
    // A boundary is selected, so a Delete that reached the timeline would remove it.
    const h = v.doc.querySelectorAll("[role=slider]")[1];
    for (const type of ["pointerdown", "pointerup"]) h.dispatchEvent(new v.doc.defaultView!.MouseEvent(type, { bubbles: true, clientX: 100, clientY: 40 }));
    await flush();
    expect(h.classList.contains("selected")).toBe(true);
    await v.rightClick(v.band(1));
    await v.key("ArrowDown", v.items()[0]);
    expect(v.doc.activeElement).toBe(v.items()[1]);
    await v.key("ArrowUp", v.items()[1]);
    await v.key("ArrowUp", v.items()[0]); // wraps to the last
    expect(v.doc.activeElement).toBe(v.items()[3]);
    await v.key("Delete", v.items()[3]);
    await v.key("Escape", v.items()[3]);
    expect(v.menu()).toBeNull();
    expect(v.handles()).toBe(n);
    expect(v.sent).toEqual([]);
  });

  it("a click elsewhere closes it with nothing sent", async () => {
    const v = await mount(cannedPayload());
    await v.rightClick(v.band(1));
    await v.pointerdown(v.doc.querySelector("header")!);
    expect(v.menu()).toBeNull();
    expect(v.sent).toEqual([]);
  });

  it("review M4: the press that dismisses it does nothing else: no handle is grabbed, no band hears the click", async () => {
    const v = await mount(cannedPayload());
    const w = v.doc.defaultView!;
    await v.rightClick(v.band(1));
    const h = v.doc.querySelectorAll("[role=slider]")[1];
    h.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, clientY: 40 }));
    await flush();
    expect(v.menu()).toBeNull();
    expect(h.classList.contains("selected")).toBe(false);

    await v.rightClick(v.band(1));
    let clicks = 0;
    v.band(2).addEventListener("click", () => clicks++);
    v.band(2).dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    v.band(2).dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(v.menu()).toBeNull();
    expect(clicks).toBe(0);
    v.band(2).dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); // the next click is the user's
    expect(clicks).toBe(1);
    expect(v.sent).toEqual([]);
  });

  it("re-review N2: a fast double-click to dismiss opens no rename; its second click is the user's", async () => {
    const v = await mount(cannedPayload());
    const w = v.doc.defaultView!;
    await v.rightClick(v.band(1));
    let clicks = 0;
    const band = v.band(2);
    band.addEventListener("click", () => clicks++);
    const fire = (type: string) => band.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    for (const type of ["pointerdown", "pointerup", "click", "pointerdown", "pointerup", "click", "dblclick"]) fire(type);
    await flush();
    expect(v.menu()).toBeNull();
    expect(v.doc.querySelector(".rename")).toBeNull();
    expect(clicks).toBe(1);
  });

  it("re-review N2: a middle press, or a press that is cancelled, never eats a later click", async () => {
    for (const how of ["middle", "cancel"]) {
      const v = await mount(cannedPayload());
      const w = v.doc.defaultView!;
      await v.rightClick(v.band(1));
      let clicks = 0;
      const band = v.band(2);
      band.addEventListener("click", () => clicks++);
      band.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: how === "middle" ? 1 : 0 }));
      if (how === "cancel") band.dispatchEvent(new w.MouseEvent("pointercancel", { bubbles: true }));
      await flush();
      expect(v.menu()).toBeNull();
      band.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(clicks).toBe(1);
    }
  });

  it("review M4: a right-click elsewhere moves the menu there", async () => {
    const v = await mount(cannedPayload());
    await v.rightClick(v.band(1));
    v.band(3).dispatchEvent(new v.doc.defaultView!.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }));
    await v.rightClick(v.band(3));
    expect(v.menu()).not.toBeNull();
    expect(v.menu()!.querySelector(".title")!.textContent).toContain(v.band(3).getAttribute("title")!.split("\n")[0]);
  });

  it("review M5: Esc gives the focus back to what had it", async () => {
    const v = await mount(cannedPayload());
    const band = v.band(1) as HTMLElement;
    band.focus();
    await v.rightClick(band);
    expect(v.doc.activeElement).toBe(v.items()[0]);
    await v.key("Escape", v.items()[0]);
    expect(v.menu()).toBeNull();
    expect(v.doc.activeElement).toBe(band);
  });

  it("has no stem lanes, so only the mix can be sent", async () => {
    const v = await mount(cannedPayload());
    expect(v.doc.querySelector(".lane")).toBeNull();
    await v.rightClick(v.band(0));
    expect(v.item("Send all stems to new tracks")).toBeUndefined(); // Plan 6, Task 8: Cue keeps no stems
  });
});

describe("send menu, Structure", () => {
  it("a stem lane cell sends that stem's slices, with the Structure choices", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS, patternLevel: 0 }); // Patterns at Fewer: a cell per section
    const v = await mount(payload);
    expect(await v.rightClick(v.cell("bass", 2))).toBe(true);
    expect(v.items().map((b) => b.textContent!.trim())).toEqual([...LANE_ITEMS("bass"), ALL_STEMS]); // its title renames (Matt, 2026-11-11)
    expect(v.items().some((b) => b.disabled)).toBe(false);
    await v.click(v.item("Send all bass patterns to Drum Rack")!);
    expect(v.sent).toHaveLength(1);
    expect(v.sent[0]).toMatchObject({ action: "send", target: "drumRack", source: "bass", unit: "patterns", index: 2 });
    expect(v.sent[0].prefs).toBeDefined();
    expect(v.sent[0].sections).toEqual(createStructureState(payload).laneSlices("bass"));
  });

  it("Plan 6, Task 7: a pattern lane cell sends its lane's slices, rests left out; its index is its place among them", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const s = createStructureState(payload);
    const lane = s.patternLanes().vocals!;
    const k = lane.findIndex((c, i) => !c.rest && lane.slice(0, i).some((x) => x.rest) && lane.slice(0, i).some((x) => !x.rest));
    const place = lane.slice(0, k).filter((c) => !c.rest).length;
    expect(place).toBeLessThan(k); // a rest comes before it
    const v = await mount(payload);
    await v.rightClick(v.cell("vocals", k));
    expect(v.menu()!.querySelector(".title")!.textContent).toBe(`${lane[k].label} (vocals)`);
    await v.click(v.item("Send to Simpler")!);
    const slices = s.laneSlices("vocals");
    expect(v.sent[0]).toMatchObject({ action: "send", target: "simpler", source: "vocals", unit: "patterns", index: place, sections: slices });
    expect(slices[place]).toMatchObject({ start: lane[k].start, label: `vocals ${lane[k].label}` });
    expect(slices.length).toBe(lane.filter((c) => !c.rest).length);
  });

  it("Plan 6, Task 7: a rest cell's one-slice items are disabled; its all-items send the lane", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const lane = createStructureState(payload).patternLanes().vocals!;
    const rest = lane.findIndex((c) => c.rest);
    const v = await mount(payload);
    await v.rightClick(v.cell("vocals", rest));
    expect(v.items().map((b) => b.textContent!.trim())).toEqual([...LANE_ITEMS("vocals"), ALL_STEMS]);
    expect(v.items().map((b) => b.disabled)).toEqual([true, true, false, false, false]);
    expect(v.menu()!.querySelector(".title")!.textContent).toBe("rest (vocals)");
    expect(v.doc.activeElement).toBe(v.item("Send all vocals patterns to Drum Rack"));
    await v.click(v.item("Send to Simpler")!);
    expect(v.sent).toEqual([]);
    await v.click(v.item("Send all vocals to new audio track")!);
    expect(v.sent[0]).toMatchObject({ action: "send", target: "audioWhole", source: "vocals", unit: "patterns", sections: createStructureState(payload).laneSlices("vocals") });
  });

  it("Plan 6, Task 7: an all-rest lane sends nothing, and says why", async () => {
    const base = cannedStructurePayload().patterns!;
    const vocals = base.sources.vocals!;
    const quiet = Buffer.from(new Int8Array(vocals.cells).fill(-100).buffer).toString("base64");
    const payload = cannedStructurePayload({ stemUrls: URLS, patterns: { ...base, sources: { ...base.sources, vocals: { ...vocals, loud: quiet } } } });
    expect(createStructureState(payload).patternLanes().vocals!.every((c) => c.rest)).toBe(true);
    const v = await mount(payload);
    await v.rightClick(v.cell("vocals", 0));
    // Task 8: Send all stems still sends the other stems.
    expect(v.items().map((b) => b.disabled)).toEqual([true, true, true, true, false]);
    expect(v.menu()!.textContent).toContain("This lane is all rests, so there is nothing to send");
    await v.click(v.item(ALL_STEMS)!);
    expect(v.sent[0]).toMatchObject({ action: "send", target: "allStems", stems: { vocals: [] } });
  });

  it("a band sends the mix's sections, as before", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const v = await mount(payload);
    await v.rightClick(v.band(0));
    expect(v.items().map((b) => b.textContent!.trim())).toEqual([...ITEMS("mix"), ALL_STEMS]);
    expect(v.items().some((b) => b.disabled)).toBe(false);
    await v.click(v.item("Send to new audio track")!);
    expect(v.sent[0]).toMatchObject({ action: "send", target: "audioSection", source: "mix", index: 0, sections: createStructureState(payload).sections() });
    expect(v.sent[0]).not.toHaveProperty("unit");
  });

  it("without kept stems, a stem's items are disabled and say why; the mix still sends", async () => {
    const v = await mount(cannedStructurePayload({ stemUrls: null }));
    await v.rightClick(v.cell("vocals", 0));
    expect(v.items().every((b) => b.disabled)).toBe(true);
    expect(v.menu()!.textContent).toContain("Click Re-analyze to send stems");
    await v.click(v.items()[0]);
    expect(v.sent).toEqual([]);
    await v.key("Escape", v.menu()!);
    await v.rightClick(v.band(0));
    expect(v.items().some((b) => b.disabled)).toBe(false);
    // Review Focus 1: with no kept stems, Send all stems is absent, from a band and from a lane.
    expect(v.item(ALL_STEMS)).toBeUndefined();
    await v.key("Escape", v.menu()!);
    await v.rightClick(v.cell("vocals", 0));
    expect(v.item(ALL_STEMS)).toBeUndefined();
  });

  it("Plan 6, Task 8: Send all stems, from a band or a lane cell, sends every stem's lane slices and the dialog's sections", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const s = createStructureState(payload);
    const stems = Object.fromEntries(STEM_NAMES.map((stem) => [stem, s.laneSlices(stem)]));
    expect(Object.values(stems).every((x) => x.length > 0)).toBe(true);
    for (const at of [(v: Awaited<ReturnType<typeof mount>>) => v.band(1), (v: Awaited<ReturnType<typeof mount>>) => v.cell("bass", 2)]) {
      const v = await mount(payload);
      await v.rightClick(at(v));
      await v.click(v.item(ALL_STEMS)!);
      expect(v.sent).toHaveLength(1);
      expect(v.sent[0]).toMatchObject({ action: "send", target: "allStems", source: "mix", index: 0, sections: s.sections(), stems });
      expect(v.sent[0]).not.toHaveProperty("unit");
      expect(v.sent[0].prefs).toBeDefined();
    }
  });

  // Matt (Live, Flim): a lane cell's menu was titled with its section's letter, not the letter on the cell.
  it("without pattern lanes, a lane cell's menu is titled with the letter drawn on that cell, not its section's", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS, patterns: null });
    const s = createStructureState(payload);
    const lanes = s.lanes();
    const sections = s.sections();
    const v = await mount(payload);
    let differs = 0;
    for (const stem of STEM_NAMES) {
      for (let i = 0; i < lanes[stem].length; i++) {
        await v.rightClick(v.cell(stem, i));
        expect(v.cell(stem, i).getAttribute("title")!.split("\n")[0]).toBe(`${stem}: ${lanes[stem][i].label}`);
        expect(v.menu()!.querySelector(".title")!.textContent).toBe(`${lanes[stem][i].label} (${stem})`);
        if (!sections[i].label.startsWith(lanes[stem][i].label + " ")) differs++;
        await v.key("Escape", v.menu()!);
      }
    }
    expect(differs).toBeGreaterThan(0); // the fixture has cells whose letter is not their section's
  });

  it("with pattern lanes, every lane cell's menu is titled with its own label as drawn, or rest", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const lanes = createStructureState(payload).patternLanes();
    const v = await mount(payload);
    let rests = 0;
    for (const src of STEM_NAMES) {
      const lane = lanes[src]!;
      // Each lane's first rest and a few of its named cells (every cell takes too long in jsdom).
      const named = lane.flatMap((c, i) => (c.rest ? [] : [i]));
      const picks = [lane.findIndex((c) => c.rest), ...named.slice(0, 2), ...named.slice(-1)].filter((i) => i >= 0);
      for (const i of new Set(picks)) {
        await v.rightClick(v.cell(src, i));
        if (lane[i].rest) rests++;
        expect(v.menu()!.querySelector(".title")!.textContent).toBe(`${lane[i].rest ? "rest" : lane[i].label} (${src})`);
        await v.key("Escape", v.menu()!);
      }
    }
    expect(rests).toBeGreaterThan(0);
  });

  it("Send all stems sends a kept stem the engine left out (no lane) at the dialog's sections, not as an empty track", async () => {
    const base = cannedStructurePayload().patterns!;
    const payload = cannedStructurePayload({ stemUrls: URLS, patterns: { ...base, sources: { ...base.sources, vocals: { ...base.sources.vocals!, dims: 1 } } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); // the engine says it left vocals out
    try {
      const s = createStructureState(payload);
      expect(s.patternSources).not.toContain("vocals");
      const sections = s.sections();
      const v = await mount(payload);
      await v.rightClick(v.band(1));
      await v.click(v.item(ALL_STEMS)!);
      expect(v.sent[0]).toMatchObject({ target: "allStems", sections, stems: { drums: s.laneSlices("drums"), bass: s.laneSlices("bass"), vocals: sections, other: s.laneSlices("other") } });
    } finally {
      warn.mockRestore();
    }
  });

  it("Plan 6, Task 8: without pattern lanes, each stem is sent at the dialog's sections", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS, patterns: null });
    const sections = createStructureState(payload).sections();
    const v = await mount(payload);
    await v.rightClick(v.band(0));
    await v.click(v.item(ALL_STEMS)!);
    expect(v.sent[0]).toMatchObject({ target: "allStems", sections, stems: Object.fromEntries(STEM_NAMES.map((stem) => [stem, sections])) });
  });
});

// Matt (Live, 3 Nov): "Send All To New Tracks [as] a button equal to Apply". It does what the menu item does.
describe("Send to new tracks, the footer button", () => {
  const SEND_TO_NEW = "Send to new tracks";
  const footer = (v: Awaited<ReturnType<typeof mount>>) => [...v.doc.querySelectorAll<HTMLButtonElement>(".footer .actions button")];
  const button = (v: Awaited<ReturnType<typeof mount>>) => footer(v).find((b) => b.textContent!.trim() === SEND_TO_NEW);

  it("sits between Cancel and Apply, as Apply does, when stems are kept", async () => {
    const v = await mount(cannedStructurePayload({ stemUrls: URLS }));
    expect(footer(v).map((b) => b.textContent!.trim())).toEqual(["Cancel", SEND_TO_NEW, "Apply"]);
    const apply = footer(v).find((b) => b.textContent!.trim() === "Apply")!;
    expect(button(v)!.dataset.appearance).toBe(apply.dataset.appearance);
    expect(button(v)!.disabled).toBe(false);
  });

  it("is absent without kept stems, and in Cue", async () => {
    for (const payload of [cannedStructurePayload({ stemUrls: null }), cannedStructurePayload({ stemUrls: undefined }), cannedPayload()]) {
      const v = await mount(payload);
      expect(footer(v).map((b) => b.textContent!.trim())).toContain("Apply");
      expect(button(v)).toBeUndefined();
    }
  });

  it("closes the dialog with the menu item's allStems result: every stem's lane slices and the dialog's sections, once", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const s = createStructureState(payload);
    const stems = Object.fromEntries(STEM_NAMES.map((stem) => [stem, s.laneSlices(stem)]));
    const v = await mount(payload);
    await v.click(button(v)!);
    expect(v.sent).toHaveLength(1);
    expect(v.sent[0]).toMatchObject({ action: "send", target: "allStems", source: "mix", index: 0, sections: s.sections(), stems });
    expect(v.sent[0].prefs).toBeDefined();
    expect(v.sent[0]).not.toHaveProperty("output"); // Output does not change what is sent
    // The result is on its way: the dialog is frozen, and a second click sends nothing.
    expect(button(v)!.disabled).toBe(true);
    await v.click(button(v)!);
    expect(v.sent).toHaveLength(1);
    // The same as the menu's item.
    const m = await mount(payload);
    await m.rightClick(m.band(1));
    await m.click(m.item(ALL_STEMS)!);
    expect(m.sent).toEqual(v.sent);
  });

  it("commits a band rename still being typed, as Apply does", async () => {
    const v = await mount(cannedStructurePayload({ stemUrls: URLS }));
    v.band(1).dispatchEvent(new v.doc.defaultView!.MouseEvent("dblclick", { bubbles: true }));
    await flush();
    const input = v.doc.querySelector<HTMLInputElement>(".rename input");
    expect(input).not.toBeNull();
    input!.value = "Hook";
    input!.dispatchEvent(new v.doc.defaultView!.Event("input", { bubbles: true }));
    await flush();
    await v.click(button(v)!);
    expect(v.sent[0].sections![1].label).toBe("Hook");
  });
});

describe("the menu's title renames; the rename list's + inserts a letter or number (Matt, 2026-11-11)", () => {
  type V = Awaited<ReturnType<typeof mount>>;
  const title = (v: V) => v.doc.querySelector<HTMLButtonElement>(".send-menu button.title");
  const bandLabels = (v: V) => [...v.doc.querySelectorAll(".band")].map((b) => b.getAttribute("title")!.split("\n")[0]);
  const rows = (v: V) => [...v.doc.querySelectorAll(".rename [role=option]")].map((o) => o.textContent!.trim());
  const pluses = (v: V) => [...v.doc.querySelectorAll<HTMLButtonElement>(".rename button.add")];
  async function type(v: V, input: HTMLInputElement, text: string) {
    input.value = text;
    input.dispatchEvent(new v.doc.defaultView!.Event("input", { bubbles: true }));
    await v.key("Enter", input);
  }

  it("Cue: the title opens the band's rename with its label; Cue names have no letters, so no +", async () => {
    const v = await mount(cannedPayload());
    const label = bandLabels(v)[1];
    await v.rightClick(v.band(1));
    expect(title(v)!.textContent).toContain(label);
    await v.click(title(v)!);
    expect(v.menu()).toBeNull();
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    expect(input.value).toBe(label);
    expect(pluses(v)).toHaveLength(0);
    await type(v, input, "Verse");
    expect(bandLabels(v)[1]).toBe("Verse");
  });

  it("Structure: a band's rename list is sorted by letter with a + on each letter's last row; + then a letter in use moves the later ones up", async () => {
    const payload = cannedStructurePayload({ snap: false, stemUrls: URLS });
    const v = await mount(payload);
    await v.rightClick(v.band(6)); // E - bridge
    await v.click(title(v)!);
    const letters = rows(v).map((r) => r.split(" - ")[0]);
    expect(letters).toEqual([...letters].sort());
    expect(pluses(v)).toHaveLength(new Set(letters).size);
    const afterB = pluses(v).find((b) => b.getAttribute("aria-label")!.startsWith("Add after B"))!;
    await v.click(afterB);
    const field = v.doc.querySelector<HTMLInputElement>(".rename input.add-field")!;
    expect(field).not.toBeNull();
    expect(v.doc.activeElement).toBe(field);
    await type(v, field, "C");
    expect(v.doc.querySelector(".rename")).toBeNull();
    const want = createStructureState(payload);
    want.rename(6, "C", true);
    expect(bandLabels(v)).toEqual(want.sections().map((s) => s.label));
    expect(bandLabels(v)[2]).toBe("D - verse");
  });

  it("Structure: Escape in the + field closes only the field; the rename stays open", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    const before = bandLabels(v);
    await v.rightClick(v.band(6));
    await v.click(title(v)!);
    await v.click(pluses(v)[0]);
    await v.key("Escape", v.doc.querySelector(".rename input.add-field")!);
    expect(v.doc.querySelector(".rename input.add-field")).toBeNull();
    expect(v.doc.querySelector(".rename")).not.toBeNull();
    expect(bandLabels(v)).toEqual(before);
  });

  it("Structure: a pattern cell's title opens its rename; + then a number in use moves the later ones up", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const lane = createStructureState(payload).patternLanes().bass!;
    const five = lane.findIndex((c) => c.label === "5");
    const v = await mount(payload);
    await v.rightClick(v.cell("bass", five));
    await v.click(title(v)!);
    const two = pluses(v).find((b) => b.getAttribute("aria-label") === "Add after 2′")!;
    expect(two).toBeDefined();
    await v.click(two);
    await type(v, v.doc.querySelector<HTMLInputElement>(".rename input.add-field")!, "2");
    const want = createStructureState(payload);
    want.renamePattern("bass", five, "2", true);
    const shown = [...v.doc.querySelectorAll(".lane[data-source=bass] .cell")].map((c) => c.getAttribute("title")!.split("\n")[0]);
    expect(shown).toEqual(want.patternLanes().bass!.map((c) => `bass: ${c.rest ? "rest" : c.label}`));
  });
});

describe("the menu's color swatches (Matt, 2026-11-12)", () => {
  const rgb = (c: number) => `rgb(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255})`;
  const swatches = (v: Awaited<ReturnType<typeof mount>>) => [...v.doc.querySelectorAll<HTMLButtonElement>(".send-menu .swatch")];
  /** A band whose name another band shares, and the indices of every band with that name. */
  function twins(payload: ReturnType<typeof cannedStructurePayload>) {
    const labels = createStructureState(payload).sections().map((x) => x.label);
    const i = labels.findIndex((l, k) => labels.indexOf(l) !== k);
    const same = labels.flatMap((l, k) => (l === labels[i] ? [k] : []));
    return { i: same[0], same, labels };
  }

  it("a band's menu offers its letter's five shades and 13 other colors; picking one colors every band of that name and closes the menu", async () => {
    const payload = cannedStructurePayload({ snap: false, colorMode: "soft" });
    const { i, same, labels } = twins(payload);
    expect(same.length).toBeGreaterThan(1);
    const v = await mount(payload);
    const before = [...v.doc.querySelectorAll<HTMLElement>(".band")].map((b) => b.style.background);
    await v.rightClick(v.band(i));
    expect(v.menu()!.querySelectorAll(".shades .swatch")).toHaveLength(5);
    expect(v.menu()!.querySelectorAll(".others .swatch")).toHaveLength(13);
    expect(v.menu()!.textContent).toContain("Other colors");
    const pick = v.menu()!.querySelectorAll<HTMLButtonElement>(".others .swatch")[6];
    const color = pick.style.background;
    await v.click(pick);
    expect(v.menu()).toBeNull(); // Matt, 2026-11-12: a pick closes the menu
    const bands = [...v.doc.querySelectorAll<HTMLElement>(".band")];
    for (const k of same) expect(bands[k].style.background, labels[k]).toBe(color);
    bands.forEach((b, k) => same.includes(k) || expect(b.style.background, labels[k]).toBe(before[k]));
    await v.rightClick(v.band(i));
    expect(v.menu()!.querySelectorAll(".others .swatch")[6].getAttribute("aria-pressed")).toBe("true");
    await v.click(v.menu()!.querySelector<HTMLButtonElement>(".auto")!);
    expect(v.menu()).toBeNull();
    expect(v.band(i)).toHaveProperty("style.background", before[i]);
    expect(v.sent).toEqual([]);
  });

  it("the swatches are not in the Up/Down order, which still runs through the send items", async () => {
    const v = await mount(cannedStructurePayload({ snap: false }));
    await v.rightClick(v.band(1));
    expect(v.doc.activeElement).toBe(v.items()[0]);
    await v.key("ArrowUp", v.doc.activeElement!);
    expect(v.doc.activeElement!.classList.contains("swatch")).toBe(false);
  });

  it("a pattern cell's menu offers its number's shades; a pick colors every cell of that pattern in that lane only", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const s = createStructureState(payload);
    const src = s.patternSources.find((x) => {
      const c = s.patternLanes()[x]!;
      return c.some((a, i) => !a.rest && c.findIndex((b) => !b.rest && b.label === a.label) !== i);
    })!;
    const cells = s.patternLanes()[src]!;
    const k = cells.findIndex((a, i) => !a.rest && cells.some((b, j) => j !== i && !b.rest && b.label === a.label));
    const same = cells.flatMap((c, i) => (!c.rest && c.label === cells[k].label ? [i] : []));
    const v = await mount(payload);
    const bg = (x: StemName) => [...v.doc.querySelectorAll<HTMLElement>(`.lane[data-source=${x}] .cell`)].map((c) => c.style.background);
    const before = Object.fromEntries(s.patternSources.map((x) => [x, bg(x)]));
    await v.rightClick(v.cell(src, k));
    expect(v.menu()!.querySelector(".swatch-heading")!.textContent).toBe(`Shades of ${cells[k].label.match(/^\d+/)![0]}`);
    expect(v.menu()!.textContent).toContain(`in ${src}`);
    const pick = v.menu()!.querySelectorAll<HTMLButtonElement>(".others .swatch")[3];
    await v.click(pick);
    const after = bg(src);
    after.forEach((b, i) => expect(b, `${src} ${i}`).toBe(same.includes(i) ? pick.style.background : before[src][i]));
    for (const x of s.patternSources) if (x !== src) expect(bg(x), x).toEqual(before[x]);
  });

  it("no swatches on a rest, under Clip color, or in Cue", async () => {
    const payload = cannedStructurePayload({ stemUrls: URLS });
    const s = createStructureState(payload);
    const [src, r] = s.patternSources.flatMap((x) => s.patternLanes()[x]!.flatMap((c, i) => (c.rest ? [[x, i] as const] : [])))[0];
    const lane = await mount(payload);
    await lane.rightClick(lane.cell(src, r));
    expect(swatches(lane)).toEqual([]);
    const clip = await mount(cannedStructurePayload({ colorMode: "uniform" }));
    await clip.rightClick(clip.band(1));
    expect(swatches(clip)).toEqual([]);
    const cue = await mount(cannedPayload());
    await cue.rightClick(cue.band(1));
    expect(swatches(cue)).toEqual([]);
  });

  it("the picked color is what Apply sends", async () => {
    const payload = cannedStructurePayload({ snap: false });
    const { i, same } = twins(payload);
    const v = await mount(payload);
    await v.rightClick(v.band(i));
    const pick = v.menu()!.querySelectorAll<HTMLButtonElement>(".others .swatch")[2];
    await v.click(pick);
    await v.click([...v.doc.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Apply")!);
    const sent = v.sent[0].sections as unknown as { color: number }[];
    for (const k of same) expect(rgb(sent[k].color)).toBe(pick.style.background);
  });
});
