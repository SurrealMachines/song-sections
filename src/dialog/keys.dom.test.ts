// v2, key per section, in the built dialog (jsdom): the clip key in the header (with the Set's scale when Scale Mode is
// on), each section's key on its band or in its tooltip and in the stem lanes' tooltips (not the drums'), keys that
// follow an edit at once, and the send menu's "Key in names" toggle, which the results carry.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { clipKey, keyLong, KK_MAJOR, KK_MINOR, withHarmonics } from "../key/key.js";
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import { cannedHarmony, cannedPayload, cannedStructurePayload } from "./fixture.js";
import { sectionKeyTexts } from "./keys.js";
import { injectPayload, type DialogPayload } from "./protocol.js";

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

type Sent = { action: string; sections?: Array<{ start: number; end: number; label: string }>; keyInNames?: boolean; source?: string };

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
    headerKey: () => doc.querySelector("header .key")?.textContent ?? null,
    bands: () => [...doc.querySelectorAll<HTMLElement>(".band")],
    titles: () => v.bands().map((b) => b.title),
    cell: (stem: StemName, i: number) => doc.querySelectorAll<HTMLElement>(`.lane[data-source=${stem}] .cell`)[i],
    toggle: () => doc.querySelector<HTMLButtonElement>(".send-menu [role=menuitemcheckbox]"),
    item: (label: string) => [...doc.querySelectorAll<HTMLButtonElement>(".send-menu [role=menuitem]")].find((b) => b.textContent!.trim() === label),
    button: (label: string) => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === label),
    async rightClick(el: Element) {
      el.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
      await flush();
    },
    async click(el: Element) {
      (el as HTMLElement).click();
      await flush();
    },
    async key(key: string) {
      w.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await flush();
    },
    async select(handle: number) {
      const h = doc.querySelectorAll("[role=slider]")[handle];
      for (const type of ["pointerdown", "pointerup"]) h.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: 100, clientY: 40 }));
      await flush();
    },
    /** The sections the dialog would apply now (Apply in a copy would lose the edits: this one is the dialog itself). */
    async applied() {
      await v.click(v.button("Apply")!);
      return v.sent.at(-1)!.sections!;
    },
  };
  return v;
}

const harmony = cannedHarmony();
/** The tooltip line each band's key gives (jsdom has no layout: every band is too narrow to show it). */
const keyLines = (sections: Array<{ start: number; end: number }>) => sectionKeyTexts(harmony, sections).map((k) => (k ? `Key: ${k}` : null));

describe("keys in the Cue dialog", () => {
  it("shows the clip key in the header, and the Set's scale beside it when Scale Mode is on", async () => {
    const want = `Key: ${keyLong(clipKey(harmony)!)}`;
    expect((await mount(cannedPayload({ harmony }))).headerKey()).toBe(want);
    expect((await mount(cannedPayload({ harmony, setScale: { root: 2, name: "Minor" } }))).headerKey()).toBe(`${want} · Set: D Minor`);
    expect((await mount(cannedPayload())).headerKey()).toBeNull();
    expect((await mount(cannedPayload({ harmony: null, setScale: { root: 2, name: "Minor" } }))).headerKey()).toBeNull();
  });

  it("puts each section's key in its band's tooltip (no room on the band), after the label", async () => {
    const v = await mount(cannedPayload({ harmony }));
    const sections = await v.applied();
    const lines = keyLines(sections);
    expect(lines.slice(0, 3)).toEqual(["Key: D minor", "Key: D minor", "Key: D minor"]);
    expect(lines).toContain("Key: A♭ major");
    v.titles().forEach((t, i) => {
      expect(t.split("\n")[0]).toBe(sections[i].label);
      expect(t.split("\n").at(-1)).toBe(lines[i]);
    });
    // No harmony, no key.
    const n = await mount(cannedPayload());
    expect(n.titles().some((t) => t.includes("Key:"))).toBe(false);
  });

  it("re-keys at once when a boundary is removed: the merged section gets the key of its new span", async () => {
    const v = await mount(cannedPayload({ harmony }));
    const before = v.titles();
    // The handle at 52 s parts D minor from A♭ major: removing it merges the two.
    const at = cannedPayload().boundaries.findIndex((b) => Math.abs(b - 52) < 1);
    expect(at).toBeGreaterThan(0);
    await v.select(at);
    await v.key("Delete");
    const after = await v.applied();
    expect(after).toHaveLength(before.length - 1);
    const lines = keyLines(after);
    expect(v.titles().map((t) => t.split("\n").at(-1))).toEqual(lines);
    expect(lines[at]).not.toBe(before[at + 1].split("\n").at(-1));
    // An even mix of two keys has no key to write down by hand; the test below re-keys against written-out ones.
  });

  it("keeps the keys through a rename", async () => {
    const v = await mount(cannedPayload({ harmony }));
    const before = v.titles().map((t) => t.split("\n").at(-1));
    v.bands()[0].dispatchEvent(new v.doc.defaultView!.MouseEvent("dblclick", { bubbles: true }));
    await flush();
    const input = v.doc.querySelector<HTMLInputElement>(".rename input")!;
    input.value = "Verse";
    input.dispatchEvent(new v.doc.defaultView!.Event("input", { bubbles: true }));
    input.dispatchEvent(new v.doc.defaultView!.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(v.titles()[0].split("\n")[0]).toBe("Verse");
    expect(v.titles().map((t) => t.split("\n").at(-1))).toEqual(before);
  });
});

describe("Key in names, in the send menu", () => {
  it("is on by default, toggles without closing the menu, and every result carries it", async () => {
    const v = await mount(cannedPayload({ harmony }));
    await v.rightClick(v.bands()[1]);
    expect(v.toggle()!.getAttribute("aria-checked")).toBe("true");
    expect(v.toggle()!.textContent).toContain("Key in names");
    await v.click(v.toggle()!);
    expect(v.toggle()!.getAttribute("aria-checked")).toBe("false");
    await v.click(v.item("Send to Simpler")!);
    expect(v.sent).toEqual([expect.objectContaining({ action: "send", source: "mix", keyInNames: false })]);

    const a = await mount(cannedPayload({ harmony }));
    expect((await a.applied()) && a.sent[0].keyInNames).toBe(true);
  });

  it("opens as remembered", async () => {
    const v = await mount(cannedPayload({ harmony, keyInNames: false }));
    await v.rightClick(v.bands()[1]);
    expect(v.toggle()!.getAttribute("aria-checked")).toBe("false");
  });

  it("is not offered without keys", async () => {
    const v = await mount(cannedPayload());
    await v.rightClick(v.bands()[1]);
    expect(v.item("Send to Simpler")).toBeDefined();
    expect(v.toggle()).toBeNull();
  });
});

describe("keys in the Structure dialog", () => {
  const stems = cannedHarmony("stems");
  const structure = (over = {}) => cannedStructurePayload({ harmony: stems, stemUrls: URLS, ...over });

  it("shows the clip key, the bands' keys, and the keys in the lanes' tooltips but the drums'", async () => {
    const v = await mount(structure());
    expect(v.headerKey()).toBe(`Key: ${keyLong(clipKey(stems)!)}`);
    const sections = await v.applied();
    const lines = sectionKeyTexts(stems, sections).map((k) => (k ? `Key: ${k}` : null));
    expect(v.titles().map((t) => (t.includes("Key:") ? t.split("\n").at(-1) : null))).toEqual(lines);
    for (const stem of ["bass", "other", "vocals"] as const) expect(v.cell(stem, 0).title).toContain(lines[0]!);
    expect(v.cell("drums", 0).title).not.toContain("Key:");
  });

  it("offers Key in names for the mix and the stems a key is heard in, not the drums", async () => {
    const v = await mount(structure());
    await v.rightClick(v.cell("drums", 1));
    expect(v.toggle()).toBeNull();
    v.doc.querySelector<HTMLElement>(".send-menu")?.dispatchEvent(new v.doc.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    await v.rightClick(v.cell("bass", 1));
    expect(v.toggle()).not.toBeNull();
    await v.click(v.toggle()!);
    await v.click(v.item("Send all bass to new audio track")!);
    expect(v.sent.at(-1)).toMatchObject({ action: "send", source: "bass", keyInNames: false });
  });
});

// Review M7: the expectations here are written out by hand, not computed by the code under test.
describe("keys in the dialog, against hand-written expectations", () => {
  // D minor for the first 40 s, A♭ major for the remaining 140 s: each frame is its key's profile.
  const frame = (minor: boolean, tonic: number) => {
    const p = withHarmonics(minor ? KK_MINOR : KK_MAJOR);
    return Array.from({ length: 12 }, (_, i) => p[(i - tonic + 12) % 12] / 12);
  };
  const h = { source: "mix" as const, rate: 2, chroma: Array.from({ length: 360 }, (_, f) => (f < 80 ? frame(true, 2) : frame(false, 8))) };
  // Sections 0–12, 12–40, 40–46, 46–100 and 100–180 s.
  const payload = () => cannedPayload({ harmony: h, boundaries: [12, 40, 46, 100] });
  const keyOfBand = (t: string) => t.split("\n").find((l) => l.startsWith("Key: ")) ?? null;

  it("shows D minor, D minor, A♭ major, A♭ major, A♭ major, and A♭ major for the clip", async () => {
    const v = await mount(payload());
    expect(v.headerKey()).toBe("Key: A♭ major");
    expect(v.titles().map(keyOfBand)).toEqual(["Key: D minor", "Key: D minor", "Key: A♭ major", "Key: A♭ major", "Key: A♭ major"]);
  });

  it("removing the boundary at 40 s makes 12–46 s one section: 28 s of D minor and 6 of A♭ is D minor", async () => {
    const v = await mount(payload());
    await v.select(1);
    await v.key("Delete");
    expect(v.titles().map(keyOfBand)).toEqual(["Key: D minor", "Key: D minor", "Key: A♭ major", "Key: A♭ major"]);
    expect((await v.applied()).map((s) => [s.start, s.end])).toEqual([[0, 12], [12, 46], [46, 100], [100, 180]]);
  });

  it("a section under 4 s keeps its key but with a ?", async () => {
    const v = await mount(cannedPayload({ harmony: h, boundaries: [12, 40, 43, 100] }));
    expect(v.titles().map(keyOfBand)).toEqual(["Key: D minor", "Key: D minor", "Key: A♭ major?", "Key: A♭ major", "Key: A♭ major"]);
  });
});
