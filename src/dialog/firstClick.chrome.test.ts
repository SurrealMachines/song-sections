// fb3, items 1 and 2, in headless Chrome against the real dialog server:
// - item 2 ("I had to wait a few seconds to hear audio when I first auditioned a cue"): the first click on a band of
//   a 30-minute clip plays at once, whether it comes after the background load or straight away;
// - item 1: a 48 kHz and a 44.1 kHz render, prepared as the extension prepares them, play each section in real time
//   (the buffer the page starts is the section's length in seconds, at the preview's own rate).
// The audio is silent, so nothing is heard while the suite runs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { prepareAudio } from "../audio/prepare.js";
import { serveDialog } from "../live/dialogServer.js";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog } from "../test/chromeDialog.js";
import { makeAiff } from "../test/makeWav.js";
import { cannedPayload } from "./fixture.js";
import { DIALOG_SIZE } from "./protocol.js";

const chrome = useChromeDialog();
const T = { timeout: CHROME_TEST_TIMEOUT * 2 };

/** A silent preview in prepare.ts's format: mono 16-bit at `rate`. */
function silentPreview(dir: string, rate: number, seconds: number): string {
  const n = rate * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + 2 * n, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(2 * rate, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(2 * n, 40);
  const path = join(dir, `preview-${rate}.wav`);
  writeFileSync(path, Buffer.concat([h, Buffer.alloc(2 * n)]));
  return path;
}

/** Records every buffer the page starts, and the time of the first press. */
const PROBE = `(function () {
  window.__starts = [];
  var start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function () {
    window.__starts.push({ at: performance.now(), duration: this.buffer.duration, rate: this.buffer.sampleRate, ctxRate: this.context.sampleRate });
    return start.apply(this, arguments);
  };
  window.__down = null;
  window.addEventListener("pointerdown", function () { if (window.__down === null) window.__down = performance.now(); }, true);
  window.addEventListener("click", function () { window.__click = performance.now(); }, true);
})()`;

/**
 * The dialog served as in Live. With `holdWholeMs`, a proxy in front holds the whole-preview request back that long,
 * so a click lands before the background load has finished (localhost serves 86 MB faster than a test can click).
 */
async function open(ctx: TestContext, audioPath: string, durationSec: number, holdWholeMs = 0) {
  const harness = chrome.get(ctx);
  const payload = cannedPayload({ durationSec, boundaries: [20, 45, 70] });
  const server = await serveDialog({ html: harness.html(payload), audioPath });
  const target = new URL(server.url);
  const proxy = createServer((req, res) => {
    const go = () =>
      req.pipe(
        request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        }),
      );
    if (holdWholeMs && req.url?.endsWith("/audio.wav")) setTimeout(go, holdWholeMs);
    else go();
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}${target.pathname}`;
  const page = await harness.open(payload, ...DIALOG_SIZE.cue, { url });
  await page.eval(PROBE);
  const close = async () => {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await server.close();
  };
  return { page, server: { close } };
}

/** Clicks band `i` and waits for its buffer to start: ms from the press to `start()` (the sound is due 30 ms on). */
async function clickLatency(page: Awaited<ReturnType<typeof open>>["page"], i: number) {
  await page.eval(`(window.__down = null, window.__starts.length = 0)`);
  const c = await page.centre(".band", i);
  await page.click(c.x, c.y);
  return page.eval<{ ms: number; duration: number; rate: number; ctxRate: number }>(`new Promise(function (resolve, reject) {
    var t = performance.now();
    (function poll() {
      var s = window.__starts[0];
      if (s) return resolve({ clickGap: window.__click - window.__down, ms: s.at - window.__down, duration: s.duration, rate: s.rate, ctxRate: s.ctxRate });
      if (performance.now() - t > 20000) return reject(new Error("no buffer started"));
      setTimeout(poll, 5);
    })();
  })`);
}

describe.skipIf(!CHROME)("first click on a 30-minute clip (fb3, item 2; headless Chrome)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-first-"));
  const DURATION = 1800;

  it("after the background load, plays at once from memory", T, async (ctx) => {
    const { page, server } = await open(ctx, silentPreview(dir, 24000, DURATION), DURATION);
    await page.settle(3000); // 86 MB from localhost
    const r = await clickLatency(page, 0);
    console.log(`fb3 first click, preloaded: ${r.ms.toFixed(1)} ms to start()`, JSON.stringify(r));
    expect(r.ms).toBeLessThan(150);
    expect(r.duration).toBeCloseTo(20, 6);
    await server.close();
    await page.close();
  });

  it("straight after opening, plays its range from a range fetch", T, async (ctx) => {
    const { page, server } = await open(ctx, silentPreview(dir, 24000, DURATION), DURATION, 8000);
    const r = await clickLatency(page, 1);
    expect(await page.eval<boolean>(`performance.getEntriesByType("resource").some(function (e) { return /audio\\.wav\\?start=/.test(e.name); })`)).toBe(true);
    console.log(`fb3 first click, at once: ${r.ms.toFixed(1)} ms to start()`, JSON.stringify(r));
    expect(r.ms).toBeLessThan(400);
    expect(r.duration).toBeCloseTo(25, 6);
    await server.close();
    await page.close();
  });
});

describe.skipIf(!CHROME)("a 48 kHz and a 44.1 kHz render play in real time (fb3, item 1; headless Chrome)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-rate-"));
  it.for([
    [48000, 24000],
    [44100, 22050],
  ] as const)("a %d Hz render: its preview is %d Hz and each section's buffer lasts the section", T, async ([renderRate, previewRate], ctx) => {
    const render = join(dir, `render-${renderRate}.aif`);
    await makeAiff(render, { sampleRate: renderRate, channels: 2, bitDepth: 24, frames: renderRate * 90, sample: () => 0 });
    const p = await prepareAudio(render, join(dir, `prev-${renderRate}.wav`));
    expect(p.durationSec).toBe(90);
    const { page, server } = await open(ctx, p.previewPath, p.durationSec);
    await page.settle(500);
    for (const [i, len] of [
      [1, 25],
      [3, 20],
    ] as const) {
      const r = await clickLatency(page, i);
      expect(r.rate).toBe(previewRate);
      expect(r.duration).toBeCloseTo(len, 6);
      await page.click(...(Object.values(await page.centre(".band", i)) as [number, number])); // stop
    }
    await server.close();
    await page.close();
  });
});
