// Matt (Live, 4 Nov): "Double clicking slider resets them." A double-click on the Sections, Letters and Patterns sliders
// (Structure) and the Granularity slider (Cue) sets each to its default through the same handler a drag uses. jsdom with
// the built dialog bundle and real DOM events.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pickPeaks } from "../analysis/peaks.js";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { DEFAULT_STRUCTURE_PREFS, injectPayload, type DialogPayload, type DialogResult } from "./protocol.js";
import { createDialogState } from "./state.js";
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

async function mount(payload: DialogPayload) {
  const sent: DialogResult[] = [];
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
  const slider = (label: string) => doc.querySelector<HTMLInputElement>(`input[type=range][aria-label="${label}"]`)!;
  return {
    w,
    doc,
    sent,
    slider,
    handles: () => [...doc.querySelectorAll("[role=slider]")].map((h) => Number(h.getAttribute("aria-valuenow"))),
    /** Moves a slider the way a drag does: an input event while it moves, a change event on release. */
    async drag(label: string, value: number) {
      const input = slider(label);
      input.value = String(value);
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
      await flush();
    },
    async dblclick(el: Element) {
      el.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await flush();
    },
    async apply() {
      [...doc.querySelectorAll<HTMLButtonElement>(".actions button")].find((b) => b.textContent!.trim() === "Apply")!.click();
      await new Promise((r) => setTimeout(r, 200));
      return sent.at(-1) as Extract<DialogResult, { action: "apply" }>;
    },
  };
}

describe("double-click a Structure slider to reset it", () => {
  // The fixture opens on neutral prefs (Sections 0, Letters 0.15), so every slider is away from Matt's defaults.
  it("Sections: back to -0.14, with the boundaries a drag there gives, and remembered", async () => {
    const p = cannedStructurePayload();
    const expected = createStructureState({ ...p, granularity: DEFAULT_STRUCTURE_PREFS.granularity });
    const v = await mount(p);
    expect(v.slider("Sections").value).toBe("0");
    await v.drag("Sections", 0.6);
    expect(v.slider("Sections").value).toBe("0.6");
    await v.dblclick(v.slider("Sections"));
    expect(v.slider("Sections").value).toBe("-0.14");
    expect(v.handles()).toEqual(expected.boundaries);
    expect((await v.apply()).prefs?.granularity).toBe(-0.14);
  });

  it("Sections: a double-click on the track part of the slider counts, one on the Fewer / More words does not", async () => {
    const v = await mount(cannedStructurePayload());
    await v.drag("Sections", 0.6);
    await v.dblclick(v.doc.querySelector(".end")!); // Fewer
    expect(v.slider("Sections").value).toBe("0.6");
    await v.dblclick(v.slider("Sections").closest(".slider")!);
    expect(v.slider("Sections").value).toBe("-0.14");
  });

  it("Sections: already at its default, a double-click leaves it alone (a drag to where it is would)", async () => {
    const v = await mount(cannedStructurePayload({ granularity: -0.14 }));
    const before = v.handles();
    await v.dblclick(v.slider("Sections"));
    expect(v.slider("Sections").value).toBe("-0.14");
    expect(v.handles()).toEqual(before);
  });

  it("Letters: back to 0.22, and remembered", async () => {
    const v = await mount(cannedStructurePayload());
    expect(v.slider("Letters").value).toBe("0.15");
    await v.drag("Letters", 0.05);
    expect(v.slider("Letters").value).toBe("0.05");
    await v.dblclick(v.slider("Letters"));
    expect(v.slider("Letters").value).toBe("0.22");
    expect((await v.apply()).prefs?.groupDist).toBe(0.22);
  });

  it("Patterns: back to More, the clip's highest real level, and remembered", async () => {
    const v = await mount(cannedStructurePayload());
    const top = createStructureState(cannedStructurePayload()).patternSteps().at(-1)!;
    expect(v.slider("Patterns").value).toBe("1");
    await v.drag("Patterns", 0);
    expect(v.slider("Patterns").value).toBe("0");
    await v.dblclick(v.slider("Patterns"));
    expect(v.slider("Patterns").value).toBe(String(v.slider("Patterns").max));
    expect((await v.apply()).prefs?.patternLevel).toBe(top);
  });

  it("a disabled slider ignores a double-click", async () => {
    const v = await mount(cannedStructurePayload({ patterns: null }));
    expect(v.slider("Patterns").disabled).toBe(true);
    await v.dblclick(v.slider("Patterns"));
    expect((await v.apply()).prefs?.patternLevel).toBe(1); // untouched (the fixture's level)
  });

  it("does not add a boundary: a slider is no waveform", async () => {
    const v = await mount(cannedStructurePayload());
    const before = v.handles();
    await v.dblclick(v.slider("Letters"));
    await v.dblclick(v.slider("Patterns"));
    expect(v.handles()).toEqual(before);
  });
});

describe("double-click the Cue Granularity slider to reset it", () => {
  it("goes back to the granularity the dialog opened with, like a drag there", async () => {
    const p = cannedPayload();
    const v = await mount(p);
    const opened = v.handles();
    expect(opened).toEqual(createDialogState(p).boundaries);
    expect(v.slider("Granularity").value).toBe(String(p.granularity));
    await v.drag("Granularity", 1);
    expect(v.handles()).toEqual(pickPeaks(p.novelty, p.blocksPerSec, 1));
    expect(v.handles()).not.toEqual(opened);
    await v.dblclick(v.slider("Granularity"));
    expect(v.slider("Granularity").value).toBe(String(p.granularity));
    expect(v.handles()).toEqual(opened);
  });
});
