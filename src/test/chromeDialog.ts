// Lays the built dialog out in headless Chrome and reads measurements back (jsdom has no layout engine). Used by the
// *.chrome.test.ts files.
//
// One Chrome per test file: useChromeDialog() builds the dialog bundle and launches Chrome in beforeAll, and each
// measurement opens a tab over the DevTools protocol. Launching a Chrome per measurement timed out under the full
// suite's parallel load. Tests are skipped when Chrome is not installed (CHROME is undefined), and skipped with the
// reason when it is installed but does not start within CHROME_START_MS.
import * as esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, type TestContext } from "vitest";
import { injectPayload, type DialogPayload } from "../dialog/protocol.js";

export const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => fs.existsSync(p));

/** Per-test timeout for every Chrome layout test: generous, since the suite runs files in parallel. */
export const CHROME_TEST_TIMEOUT = 60_000;
const CHROME_START_MS = 30_000;
const MEASURE_MS = 45_000;

const sveltePlugin = ((esbuildSvelte as unknown as { default?: unknown }).default ?? esbuildSvelte) as () => esbuild.Plugin;

export interface ChromeDialog {
  /**
   * Mounts `payload` in a `width` x `height` viewport. After 500 ms the probe's `prelude` statements run (clicks and
   * the like); 300 ms later `expr`, a JavaScript expression, is evaluated and its JSON-serialisable value returned.
   */
  measure<T>(payload: DialogPayload, width: number, height: number, expr: string, prelude?: string): Promise<T>;
  /**
   * Opens `payload` (or, with `url`, a page served from there) in a `width` x `height` tab and keeps it open, so a test
   * can drive it with trusted input the way a user does. The page's close_and_send messages are recorded rather than
   * sent anywhere: read them with `sent()`.
   */
  open(payload: DialogPayload, width: number, height: number, opts?: { url?: string }): Promise<ChromePage>;
  /** The built dialog page with `payload` inlined, as the extension serves it. */
  html(payload: DialogPayload): string;
}

/** A dialog tab driven over the DevTools protocol: real (trusted) mouse and key events, so focus and blur are real. */
export interface ChromePage {
  /** Evaluates a JavaScript expression (awaiting a promise) and returns its JSON-serialisable value. */
  eval<T>(expr: string): Promise<T>;
  /** The centre of the first element matching `selector`, in CSS pixels. Throws when there is none. */
  centre(selector: string, index?: number): Promise<{ x: number; y: number }>;
  /** `modifiers`: CDP's bit field (Alt 1, Ctrl 2, Meta/Cmd 4, Shift 8), held for the whole gesture. */
  click(x: number, y: number, clickCount?: number, modifiers?: number): Promise<void>;
  dblclick(x: number, y: number, modifiers?: number): Promise<void>;
  /** Moves the pointer to (x, y) with no button down (hover). */
  move(x: number, y: number): Promise<void>;
  /** Press at (x0, y0), move to (x1, y1) in `steps`, release. */
  drag(x0: number, y0: number, x1: number, y1: number, steps?: number, modifiers?: number): Promise<void>;
  /** Types text into the focused element (Input.insertText: one input event). */
  type(text: string): Promise<void>;
  /**
   * Presses one key: Enter, Escape, the arrows, Backspace, Delete, Tab or 0, or a select-all chord via `selectAll()`.
   * `modifiers`: as for click (Shift 8, Meta/Cmd 4).
   */
  key(key: "Enter" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Backspace" | "Delete" | "Tab" | "0", modifiers?: number): Promise<void>;
  /** A wheel (or a trackpad scroll or pinch, with Ctrl in `modifiers`) at (x, y), by (dx, dy) pixels. */
  wheel(x: number, y: number, dx: number, dy: number, modifiers?: number): Promise<void>;
  selectAll(): Promise<void>;
  /** The close_and_send results the page has posted, parsed. */
  sent<T = unknown>(): Promise<T[]>;
  /** Waits `ms`, then two animation frames. */
  settle(ms?: number): Promise<void>;
  /** Switches the page's prefers-color-scheme, as the system's appearance would. */
  scheme(value: "light" | "dark"): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

/** Every page starts in the light scheme: headless Chrome would otherwise follow the Mac's appearance, and so the clock. */
const LIGHT_SCHEME = { features: [{ name: "prefers-color-scheme", value: "light" }] };

/** Installed before the page's own scripts: records close_and_send instead of posting it to a host. */
const RECORD_BRIDGE = `(function () {
  window.__sent = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = { postMessage: function (m) { window.__sent.push(m); } };
})();`;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  "0": { code: "Digit0", keyCode: 48, text: "0" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Tab: { code: "Tab", keyCode: 9 },
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  sessionId?: string;
}

/** A minimal DevTools protocol client on the browser endpoint, with flattened per-tab sessions. */
class Cdp {
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private waiters: { method: string; sessionId: string; resolve: () => void }[] = [];

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) {
        this.waiters = this.waiters.filter((w) => {
          if (w.method !== msg.method || w.sessionId !== msg.sessionId) return true;
          w.resolve();
          return false;
        });
      }
    };
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error(`could not connect to Chrome's DevTools at ${url}`));
    });
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  event(method: string, sessionId: string): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ method, sessionId, resolve }));
  }

  close() {
    this.ws.close();
  }
}

/** Launches headless Chrome; `endpoint` resolves to its DevTools browser URL. */
function launch(profile: string): { child: ChildProcess; endpoint: Promise<string> } {
  const child = spawn(
    CHROME!,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = new Promise<string>((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Chrome exited (code ${code}) before DevTools was ready`)));
  });
  return { child, endpoint };
}

async function start(work: string): Promise<{ dialog: ChromeDialog; stop: () => Promise<void> }> {
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
  const template = fs
    .readFileSync("src/dialog/index.html", "utf8")
    .replace("<!--STYLE-->", () => css)
    .replace("<!--BUNDLE-->", () => js.replace(/<\/script/gi, "<\\/script"));

  const { child, endpoint } = launch(join(work, "profile"));
  let cdp: Cdp;
  try {
    cdp = await withTimeout(endpoint.then(Cdp.open), CHROME_START_MS, "starting headless Chrome");
  } catch (error) {
    child.kill();
    throw error;
  }

  const measureOnce = async <T>(payload: DialogPayload, width: number, height: number, expr: string, prelude: string): Promise<T> => {
    const page = join(work, `p${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(page, injectPayload(template, payload));
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send("Emulation.setEmulatedMedia", LIGHT_SCHEME, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      const loaded = cdp.event("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url: pathToFileURL(page).href }, sessionId);
      await loaded;
      const probe = `new Promise(function (resolve) {
  setTimeout(function () {
    ${prelude}
    setTimeout(function () { resolve(JSON.stringify(${expr})); }, 300);
  }, 500);
})`;
      const r = await cdp.send<{ result: { value?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        "Runtime.evaluate",
        { expression: probe, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (r.exceptionDetails) throw new Error(`probe failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return JSON.parse(r.result.value!) as T;
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  };

  const openOnce = async (payload: DialogPayload, width: number, height: number, opts: { url?: string }): Promise<ChromePage> => {
    let url = opts.url;
    if (!url) {
      const file = join(work, `p${Math.random().toString(36).slice(2)}.html`);
      fs.writeFileSync(file, injectPayload(template, payload));
      url = pathToFileURL(file).href;
    }
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const send = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", LIGHT_SCHEME);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: RECORD_BRIDGE });
    const loaded = cdp.event("Page.loadEventFired", sessionId);
    await send("Page.navigate", { url });
    await loaded;
    // Headless Chrome only gives a page focus (and so fires blur on its fields) once it is the focused target.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const evaluate = async <T>(expr: string): Promise<T> => {
      const r = await send<{ result: { value?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        "Runtime.evaluate",
        { expression: `Promise.resolve(${expr}).then(function (v) { return JSON.stringify(v === undefined ? null : v); })`, awaitPromise: true, returnByValue: true },
      );
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return JSON.parse(r.result.value!) as T;
    };
    const settle = (ms = 30) =>
      evaluate(`new Promise(function (r) { setTimeout(function () { requestAnimationFrame(function () { requestAnimationFrame(function () { r(null); }); }); }, ${ms}); })`).then(() => undefined);
    const mouse = (type: string, x: number, y: number, clickCount = 1, buttons = 1, modifiers = 0) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && buttons === 0 ? "none" : "left", buttons, clickCount, modifiers });
    const page: ChromePage = {
      eval: evaluate,
      async centre(selector, index = 0) {
        const c = await evaluate<{ x: number; y: number } | null>(`(function () {
          var e = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
          if (!e) return null;
          var r = e.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (!c) throw new Error(`no element matches ${selector} [${index}]`);
        return c;
      },
      async click(x, y, clickCount = 1, modifiers = 0) {
        await mouse("mouseMoved", x, y, 0, 0, modifiers);
        for (let n = 1; n <= clickCount; n++) {
          await mouse("mousePressed", x, y, n, 1, modifiers);
          await mouse("mouseReleased", x, y, n, 0, modifiers);
        }
        await settle();
      },
      dblclick(x, y, modifiers = 0) {
        return page.click(x, y, 2, modifiers);
      },
      async move(x, y) {
        await mouse("mouseMoved", x, y, 0, 0);
        await settle();
      },
      async drag(x0, y0, x1, y1, steps = 8, modifiers = 0) {
        await mouse("mouseMoved", x0, y0, 0, 0, modifiers);
        await mouse("mousePressed", x0, y0, 1, 1, modifiers);
        for (let k = 1; k <= steps; k++) await mouse("mouseMoved", x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps, 0, 1, modifiers);
        await mouse("mouseReleased", x1, y1, 1, 0, modifiers);
        await settle();
      },
      async type(text) {
        await send("Input.insertText", { text });
        await settle();
      },
      async key(key, modifiers = 0) {
        const k = KEYS[key];
        const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
        const text = k.text && !(modifiers & 6) ? { text: k.text } : {};
        await send("Input.dispatchKeyEvent", { type: text.text ? "keyDown" : "rawKeyDown", ...base, ...text });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await settle();
      },
      async wheel(x, y, dx, dy, modifiers = 0) {
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, modifiers });
        await settle();
      },
      async scheme(value) {
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
        await settle(100);
      },
      async selectAll() {
        await evaluate(`(function () { var e = document.activeElement; if (e && e.select) e.select(); })()`);
      },
      async sent<T>() {
        const raw = await evaluate<{ method: string; params: string[] }[]>("window.__sent");
        return raw.map((m) => JSON.parse(m.params[0]) as T);
      },
      settle,
      async screenshot(path) {
        const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path, Buffer.from(data, "base64"));
      },
      async close() {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      },
    };
    await settle(300);
    return page;
  };

  return {
    dialog: {
      measure: (payload, width, height, expr, prelude = "") =>
        withTimeout(measureOnce(payload, width, height, expr, prelude), MEASURE_MS, "measuring the dialog in Chrome"),
      html: (payload) => injectPayload(template, payload),
      open: (payload, width, height, opts = {}) => withTimeout(openOnce(payload, width, height, opts), MEASURE_MS, "opening the dialog in Chrome"),
    },
    async stop() {
      // Let Chrome exit before the profile is deleted, or it is still writing there.
      const exited = new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
      await cdp.send("Browser.close").catch(() => undefined);
      cdp.close();
      await withTimeout(exited, 5_000, "Chrome exit").catch(() => child.kill("SIGKILL"));
    },
  };
}

/**
 * Registers beforeAll/afterAll for one Chrome per test file. Call `get(ctx)` in each test: it returns the harness,
 * or skips the test with the reason when Chrome did not start.
 */
export function useChromeDialog(): { get(ctx: TestContext): ChromeDialog } {
  let dialog: ChromeDialog | undefined;
  let stop: (() => Promise<void>) | undefined;
  let failure = "";
  let work = "";
  beforeAll(async () => {
    if (!CHROME) return;
    work = fs.mkdtempSync(join(tmpdir(), "ss-layout-"));
    try {
      ({ dialog, stop } = await start(work));
    } catch (error) {
      failure = `headless Chrome did not start: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`Skipping the Chrome layout tests in this file: ${failure}`);
    }
  }, CHROME_START_MS + 30_000);
  afterAll(async () => {
    await stop?.();
    // Best effort: a leftover temp profile must not fail the suite.
    try {
      if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // the OS cleans its temp directory
    }
  }, 15_000);
  return {
    get(ctx) {
      if (!dialog) ctx.skip(failure || "Chrome is not installed");
      return dialog!;
    },
  };
}

/**
 * A second of silence as a data: URL. The fixture's audio.wav does not exist next to a file: page, and the
 * "Playback unavailable" note its failed fetch shows moves the bands up between the two clicks of a double-click.
 */
export function silentWav(seconds = 1, rate = 8000): string {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + 2 * n);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + 2 * n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(2 * rate, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(2 * n, 40);
  return "data:audio/wav;base64," + b.toString("base64");
}
