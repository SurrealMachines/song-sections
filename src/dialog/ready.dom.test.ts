// The built dialog tells the dialog server it has mounted (GET ready), or why it could not (GET ready?error=…), so a
// blank dialog in Live shows up in the host log (dialogPacing.ts). jsdom, with fetch stubbed.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import * as fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cannedStructurePayload } from "./fixture.js";
import { injectPayload } from "./protocol.js";

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

async function load(html: string, withFetch = true) {
  const fetched: string[] = [];
  const dom = new JSDOM(html, {
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
      if (withFetch) {
        (w as unknown as { fetch: unknown }).fetch = (url: string) => {
          fetched.push(url);
          return Promise.resolve({ ok: true, status: 204 });
        };
      }
    },
  });
  open.push(dom);
  await flush();
  return { dom, fetched };
}

describe("dialog ready signal", () => {
  it("GETs ready once the dialog has mounted (and the preview, once, as it mounts: fb2 review I2 / fb3 item 2)", async () => {
    const { dom, fetched } = await load(injectPayload(template, cannedStructurePayload()));
    expect(dom.window.document.querySelector("#app")!.children.length).toBeGreaterThan(0);
    expect(fetched.filter((u) => u.startsWith("ready"))).toEqual(["ready"]);
    expect(fetched.filter((u) => u !== "ready")).toEqual(["audio.wav"]);
  });

  it("GETs ready with the error when the dialog cannot mount", async () => {
    // No payload injected: readPayload throws "Dialog payload missing".
    const { dom, fetched } = await load(template);
    expect(dom.window.document.querySelector("#app")!.textContent).toContain("Song Sections could not open");
    expect(fetched).toEqual(["ready?error=Dialog%20payload%20missing"]);
  });

  it("still mounts where there is no fetch", async () => {
    const { dom, fetched } = await load(injectPayload(template, cannedStructurePayload()), false);
    expect(dom.window.document.querySelector("#app")!.children.length).toBeGreaterThan(0);
    expect(fetched).toEqual([]);
  });
});
