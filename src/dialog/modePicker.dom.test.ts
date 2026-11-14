// The mode picker's Task 12 messages in the built dialog (jsdom): the long-track confirm and the download note.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { injectPayload, type DialogPayload, type ModeInfo } from "./protocol.js";

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
  const sent: unknown[] = [];
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
  const doc = dom.window.document;
  const button = (label: string) => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === label);
  return {
    doc,
    sent,
    button,
    async click(label: string) {
      button(label)!.click();
      await flush();
    },
    text: (sel: string) => doc.querySelector(sel)?.textContent?.trim() ?? null,
  };
}

const modes = (over: Partial<ModeInfo["structure"]>): ModeInfo => ({
  structure: { available: true, reason: null, cached: false, needsDownload: false, downloadBytes: 190048947, estimateSec: 66, warn: false, ...over },
});

describe("ModePicker long-track confirm", () => {
  const long = () => cannedPayload({ durationSec: 1440, modes: modes({ warn: true, estimateSec: 469 }) });

  it("asks before switching, and Analyse switches", async () => {
    const v = await mount(long());
    await v.click("Structure");
    expect(v.text(".confirm .message")).toBe("Structure analysis of this 24-minute clip takes about 8 minutes.");
    expect(v.sent).toEqual([]);
    await v.click("Analyze");
    expect(v.sent).toEqual([{ action: "switch", mode: "structure" }]);
    expect(v.doc.querySelector(".confirm")).toBeNull();
  });

  it("Back dismisses without switching, and the Cue tab stays selected", async () => {
    const v = await mount(long());
    await v.click("Structure");
    await v.click("Back");
    expect(v.doc.querySelector(".confirm")).toBeNull();
    expect(v.sent).toEqual([]);
    expect(v.button("Cue points")!.getAttribute("aria-selected")).toBe("true");
  });

  it("switches at once on a short clip", async () => {
    const v = await mount(cannedPayload({ modes: modes({}) }));
    await v.click("Structure");
    expect(v.doc.querySelector(".confirm")).toBeNull();
    expect(v.sent).toEqual([{ action: "switch", mode: "structure" }]);
  });
});

describe("ModePicker download note", () => {
  it("shows under the tabs in the Cue view when the models need downloading", async () => {
    const v = await mount(cannedPayload({ modes: modes({ needsDownload: true }) }));
    expect(v.text(".picker .note")).toBe("First use downloads the analysis models (190 MB).");
  });
  it("is absent when nothing needs downloading, and in the Structure view", async () => {
    expect((await mount(cannedPayload({ modes: modes({}) }))).text(".picker .note")).toBeNull();
    expect((await mount(cannedStructurePayload({ modes: modes({ needsDownload: true }) }))).text(".picker .note")).toBeNull();
  });
});

describe("ModePicker download consent (fb/hfmodels)", () => {
  const missing = (over: Partial<ModeInfo["structure"]> = {}) =>
    cannedPayload({ modes: modes({ needsDownload: true, downloadBytes: 95_230_008, diskBytes: 190_454_313, ...over }) });
  const CONSENT =
    "Structure needs two analysis models. Song Sections downloads them once from Hugging Face: allin1 by Taejun Kim (MIT licence) " +
    "and HT Demucs by Meta (Alexandre Défossez). The download is about 95 MB. They take about 190 MB on disk.";

  it("asks before downloading: what, from whom, how big; nothing is sent yet", async () => {
    const v = await mount(missing());
    await v.click("Structure");
    expect(v.text(".consent .message")).toBe(CONSENT);
    expect(v.doc.querySelector(".consent a")).toBeNull();
    expect(v.button("Download")).toBeDefined();
    expect(v.button("Not now")).toBeDefined();
    expect(v.text(".picker .note")).toBeNull(); // the prompt says it all
    expect(v.sent).toEqual([]);
    expect(v.button("Cue points")!.getAttribute("aria-selected")).toBe("true");
  });

  it("Download sends the switch with the consent", async () => {
    const v = await mount(missing());
    await v.click("Structure");
    await v.click("Download");
    expect(v.sent).toEqual([{ action: "switch", mode: "structure", download: true }]);
  });

  it("Not now dismisses and sends nothing; the note is back", async () => {
    const v = await mount(missing());
    await v.click("Structure");
    await v.click("Not now");
    expect(v.doc.querySelector(".consent")).toBeNull();
    expect(v.sent).toEqual([]);
    expect(v.text(".picker .note")).toBe("First use downloads the analysis models (95 MB).");
  });

  it("on a long clip, Download then asks about the analysis time, and Analyse carries the consent", async () => {
    const v = await mount({ ...missing({ warn: true, estimateSec: 469 }), durationSec: 1440 });
    await v.click("Structure");
    await v.click("Download");
    expect(v.sent).toEqual([]);
    expect(v.text(".confirm .message")).toBe("Structure analysis of this 24-minute clip takes about 8 minutes.");
    await v.click("Analyze");
    expect(v.sent).toEqual([{ action: "switch", mode: "structure", download: true }]);
  });
});

describe("ModePicker Retry after a failed model download", () => {
  const failed = () =>
    cannedPayload({ modes: modes({ available: false, retryable: true, needsDownload: true, reason: "Downloading the analysis models failed (Model download failed: 503 htdemucs_core.onnx)." }) });

  it("shows the reason and a Retry button in the Cue view straight away", async () => {
    const v = await mount(failed());
    expect(v.text(".retry .message")).toBe("Downloading the analysis models failed (Model download failed: 503 htdemucs_core.onnx).");
    expect(v.button("Retry")).toBeDefined();
  });

  it("Retry sends the existing switch to Structure", async () => {
    const v = await mount(failed());
    await v.click("Retry");
    expect(v.sent).toEqual([{ action: "switch", mode: "structure" }]);
  });

  it("clicking the Structure tab keeps offering Retry and does not switch", async () => {
    const v = await mount(failed());
    await v.click("Structure");
    expect(v.sent).toEqual([]);
    expect(v.button("Retry")).toBeDefined();
    expect(v.doc.querySelector(".blocked")).toBeNull();
  });

  it("offers no Retry for a permanent reason", async () => {
    const v = await mount(cannedPayload({ modes: modes({ available: false, reason: "Structure needs an Apple Silicon Mac (or Windows x64, later)" }) }));
    expect(v.button("Retry")).toBeUndefined();
    await v.click("Structure");
    expect(v.button("Retry")).toBeUndefined();
    expect(v.text(".blocked")).toBe("Structure needs an Apple Silicon Mac (or Windows x64, later)");
  });
});

describe("ModePicker with a long clip name (Task 12 I1)", () => {
  // jsdom has no layout, so this pins the CSS contract; headerLayout.chrome.test.ts measures the pixels in Chrome.
  const LONG = "Bass 01 - Long Arrangement Recording Take 3 (final mix bounce)";

  it("keeps the whole name in the h1, which truncates with an ellipsis and gives way before the picker", async () => {
    const v = await mount(cannedPayload({ clipName: LONG, durationSec: 1440, modes: modes({ warn: true, estimateSec: 469 }) }));
    await v.click("Structure");
    expect(v.doc.querySelector(".picker .confirm")).not.toBeNull();
    expect(v.button("Analyze")).toBeDefined();
    expect(v.button("Back")).toBeDefined();

    const css = (sel: string) => v.doc.defaultView!.getComputedStyle(v.doc.querySelector(sel)!);
    const h1 = css("h1");
    expect(v.text("h1")).toBe(LONG);
    expect([h1.whiteSpace, h1.overflow, h1.textOverflow]).toEqual(["nowrap", "hidden", "ellipsis"]);
    expect(Number(h1.flexShrink)).toBeGreaterThan(Number(css(".picker").flexShrink)); // the name shrinks first
    expect(Number(css(".picker").flexShrink)).toBeGreaterThan(0); // never flex: none, so .row can wrap
    expect(css(".hint").flexBasis).toMatch(/^0(px|%)?$/); // the hint only takes what is left over
    expect(css(".picker .confirm").flexWrap).toBe("wrap");
  });
});

describe("ModePicker background Structure analysis (fb2)", () => {
  /** Mounts as served by the dialog server (http), with fetch answering `structure` from `answers` in turn. */
  async function served(payload: DialogPayload, answers: Array<{ state: string; percent: number } | "no answer" | 404>) {
    const sent: unknown[] = [];
    const polls: number[] = [];
    const fetched: string[] = [];
    const dom = new JSDOM(injectPayload(template, payload), {
      url: "http://127.0.0.1:1/tok/",
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
        (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
          fetched.push(url);
          if (url !== "structure") return { ok: true, status: 204 };
          polls.push(Date.now());
          const answer = answers.length > 1 ? answers.shift()! : answers[0];
          if (answer === "no answer") throw new TypeError("Load failed");
          if (answer === 404) return { ok: false, status: 404 };
          return { ok: true, status: 200, json: async () => answer };
        };
      },
    });
    open.push(dom);
    await flush();
    const doc = dom.window.document;
    const tab = (value: string) => [...doc.querySelectorAll<HTMLButtonElement>(".picker .tab")].find((b) => b.textContent!.trim().startsWith(value));
    return { doc, sent, polls, fetched, tab };
  }

  it("shows the progress on the Structure tab, polled until the analysis is done", async () => {
    const v = await served(cannedPayload({ modes: modes({ background: true }) }), [
      { state: "pending", percent: 0 },
      { state: "running", percent: 37 },
      { state: "done", percent: 100 },
    ]);
    expect(v.tab("Structure")!.textContent!.trim()).toBe("Structure 0%");
    await new Promise((r) => setTimeout(r, 600));
    expect(v.tab("Structure")!.textContent!.trim()).toBe("Structure 37%");
    await new Promise((r) => setTimeout(r, 600));
    expect(v.tab("Structure")!.textContent!.trim()).toBe("Structure");
    const n = v.polls.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(v.polls.length).toBe(n); // done: no more polling
  }, 10_000);

  it("a click on the tab while it runs switches at once", async () => {
    const v = await served(cannedPayload({ modes: modes({ background: true }) }), [{ state: "running", percent: 50 }]);
    v.tab("Structure")!.click();
    await flush();
    expect(v.sent).toEqual([{ action: "switch", mode: "structure" }]);
  });

  it("does not poll without a background analysis, or in the Structure view", async () => {
    const cue = await served(cannedPayload({ modes: modes({}) }), [{ state: "running", percent: 50 }]);
    const structure = await served(cannedStructurePayload({ modes: modes({ background: true }) }), [{ state: "running", percent: 50 }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(cue.polls).toEqual([]);
    expect(structure.polls).toEqual([]);
    expect(cue.tab("Structure")!.textContent!.trim()).toBe("Structure");
  });

  it("fb2 review I2 / fb3 item 2: fetches the whole audio once, as the page mounts, with or without a background analysis", async () => {
    const bg = await served(cannedPayload({ modes: modes({ background: true }) }), [{ state: "running", percent: 1 }]);
    expect(bg.fetched.filter((u) => u === "audio.wav")).toEqual(["audio.wav"]);
    const plain = await served(cannedPayload({ modes: modes({}) }), [{ state: "running", percent: 1 }]);
    expect(plain.fetched.filter((u) => u === "audio.wav")).toEqual(["audio.wav"]);
  });

  it("fb2 review m2: a poll with no answer is tried again, and the tab goes on to the next answer", async () => {
    const v = await served(cannedPayload({ modes: modes({ background: true }) }), [{ state: "running", percent: 20 }, "no answer", { state: "running", percent: 60 }]);
    expect(v.tab("Structure")!.textContent!.trim()).toBe("Structure 20%");
    await new Promise((r) => setTimeout(r, 1700)); // 500 ms, then the retry after 1000 ms
    expect(v.tab("Structure")!.textContent!.trim()).toBe("Structure 60%");
  }, 10_000);

  it("fb2 review m2: after polls with no answer, or one that is not ok, the tab drops its percentage", async () => {
    const v = await served(cannedPayload({ modes: modes({ background: true }) }), [{ state: "running", percent: 20 }, 404]);
    await new Promise((r) => setTimeout(r, 700));
    expect(v.tab("Structure")!.textContent!.trim()).toBe("Structure");
    const n = v.polls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(v.polls.length).toBe(n);
  }, 10_000);

  it("highlights the Structure tab as the suggestion in the Cue view when it was the last mode", async () => {
    const suggested = await mount(cannedPayload({ modes: modes({ suggested: true }) }));
    expect(suggested.doc.querySelector(".picker")!.classList.contains("suggest")).toBe(true);
    const plain = await mount(cannedPayload({ modes: modes({}) }));
    expect(plain.doc.querySelector(".picker")!.classList.contains("suggest")).toBe(false);
    const inStructure = await mount(cannedStructurePayload({ modes: modes({ suggested: true }) }));
    expect(inStructure.doc.querySelector(".picker")!.classList.contains("suggest")).toBe(false);
  });
});
