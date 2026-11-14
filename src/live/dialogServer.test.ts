import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostActivity } from "../core/pace.js";
import { pcm16Header } from "../structure/audition.js";
import { STEM_NAMES } from "../structure/contract.js";
import { ABOUT_LINKS } from "../core/about.js";
import { READY_ERROR_MAX, serveDialog } from "./dialogServer.js";

describe("serveDialog", () => {
  it("serves html and audio at a token path, 404s elsewhere, stops on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlg-"));
    const audioPath = join(dir, "a.wav");
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    writeFileSync(audioPath, bytes);
    const { url, close } = await serveDialog({ html: "<p>hi</p>", audioPath });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<p>hi</p>");
    const a = await fetch(new URL("audio.wav", url));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("audio/wav");
    expect(a.headers.get("content-length")).toBe("5");
    expect(Buffer.from(await a.arrayBuffer())).toEqual(bytes);
    expect((await fetch(new URL("../wrong/", url))).status).toBe(404);
    expect((await fetch(new URL("/", url))).status).toBe(404);
    await close();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("sends the page with an explicit length and records when it was requested", async () => {
    let t = 100;
    const html = "<p>héllo</p>"; // multi-byte: the length is in bytes
    const server = await serveDialog({ html, audioPath: "/nope.wav", now: () => t });
    expect(server.status()).toEqual({ pageBytes: Buffer.byteLength(html), pageAt: null, readyAt: null, readyError: null });
    t = 150;
    const res = await fetch(server.url);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(await res.text()).toBe(html);
    t = 400;
    await fetch(server.url); // a reload keeps the first time
    expect(server.status()).toMatchObject({ pageAt: 150, readyAt: null });
    await server.close();
  });

  it("records the page's ready signal, and the error it reports instead", async () => {
    let t = 0;
    const ok = await serveDialog({ html: "x", audioPath: "/nope.wav", now: () => t });
    t = 30;
    const r = await fetch(new URL("ready", ok.url));
    expect(r.status).toBe(204);
    t = 90;
    await fetch(new URL("ready?error=late", ok.url)); // only the first signal counts
    expect(ok.status()).toMatchObject({ readyAt: 30, readyError: null });
    await ok.close();

    const bad = await serveDialog({ html: "x", audioPath: "/nope.wav", now: () => 5 });
    await fetch(new URL("ready?x=1&error=Dialog%20payload%20missing", bad.url));
    expect(bad.status()).toMatchObject({ readyAt: 5, readyError: "Dialog payload missing" });
    await bad.close();

    const long = await serveDialog({ html: "x", audioPath: "/nope.wav" });
    await fetch(new URL(`ready?error=${"e".repeat(500)}`, long.url));
    expect(long.status().readyError).toHaveLength(READY_ERROR_MAX);
    // A ready signal for another token is not this dialog's.
    expect((await fetch(new URL("/other/ready", long.url))).status).toBe(404);
    await long.close();
  });

  it("answers alive under its token while open, and not once closed (feedback round 2)", async () => {
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav" });
    expect((await fetch(new URL("alive", server.url))).status).toBe(204);
    expect((await fetch(new URL("/other/alive", server.url))).status).toBe(404);
    expect(server.status().readyAt).toBeNull(); // alive is not the ready signal
    await server.close();
    await expect(fetch(new URL("alive", server.url))).rejects.toThrow();
  });

  it("fb2: calls onReady once, when the page first mounts, and never for a page that failed", async () => {
    let calls = 0;
    const ok = await serveDialog({ html: "x", audioPath: "/nope.wav", onReady: () => void calls++ });
    await fetch(new URL("alive", ok.url));
    expect(calls).toBe(0);
    await fetch(new URL("audio.wav", ok.url)); // a 404: nothing to wait for
    await fetch(new URL("ready", ok.url));
    await fetch(new URL("ready", ok.url));
    expect(calls).toBe(1);
    await ok.close();
    let failed = 0;
    const bad = await serveDialog({ html: "x", audioPath: "/nope.wav", onReady: () => void failed++ });
    await fetch(new URL("ready?error=boom", bad.url));
    expect(failed).toBe(0);
    await bad.close();
    // A throwing onReady still answers the page.
    const throws = await serveDialog({ html: "x", audioPath: "/nope.wav", onReady: () => { throw new Error("x"); } });
    expect((await fetch(new URL("ready", throws.url))).status).toBe(204);
    await throws.close();
  });

  it("fb2 review I2: onReady waits until the page's audio has been sent, so the first Play needs nothing from the host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlg-ready-"));
    const audioPath = join(dir, "a.wav");
    writeFileSync(audioPath, Buffer.alloc(1 << 20, 7));
    let calls = 0;
    const server = await serveDialog({ html: "x", audioPath, onReady: () => void calls++ });
    await fetch(new URL("ready", server.url));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    const r = await fetch(new URL("audio.wav", server.url));
    expect((await r.arrayBuffer()).byteLength).toBe(1 << 20);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    await server.close();
  });

  it("fb2 review I2: onReady also comes when the audio was sent first, or after the wait when the page fetches none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlg-ready2-"));
    const audioPath = join(dir, "a.wav");
    writeFileSync(audioPath, Buffer.alloc(1024));
    let first = 0;
    const a = await serveDialog({ html: "x", audioPath, onReady: () => void first++ });
    await (await fetch(new URL("audio.wav", a.url))).arrayBuffer();
    await fetch(new URL("ready", a.url));
    expect(first).toBe(1);
    await a.close();
    let late = 0;
    const b = await serveDialog({ html: "x", audioPath, onReady: () => void late++, readyAudioWaitMs: 60 });
    await fetch(new URL("ready", b.url));
    expect(late).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(late).toBe(1);
    await b.close();
    // A dialog closed before then starts nothing.
    let never = 0;
    const c = await serveDialog({ html: "x", audioPath, onReady: () => void never++, readyAudioWaitMs: 60 });
    await fetch(new URL("ready", c.url));
    await c.close();
    await new Promise((r) => setTimeout(r, 120));
    expect(never).toBe(0);
  });

  it("fb2 review I1/I2: each request is foreground work until its answer is sent; the progress polls are not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlg-busy-"));
    const audioPath = join(dir, "a.wav");
    writeFileSync(audioPath, Buffer.alloc(1024));
    const activity = hostActivity({ quietMs: 0 });
    const seen: boolean[] = [];
    const server = await serveDialog({
      html: "x",
      audioPath,
      activity,
      structureProgress: () => {
        seen.push(activity.busy());
        return { state: "running", percent: 1 };
      },
    });
    await (await fetch(new URL("structure", server.url))).json();
    expect(seen).toEqual([false]);
    for (const route of ["", "alive", "audio.wav", "ready"]) {
      await (await fetch(new URL(route, server.url))).arrayBuffer();
      await new Promise((r) => setTimeout(r, 10));
      expect(activity.busy(), route).toBe(false); // ended once answered
    }
    // While an answer is being sent, the host is busy: a slow reader keeps the audio response open.
    const big = join(dir, "big.wav");
    writeFileSync(big, Buffer.alloc(32 << 20));
    const slow = await serveDialog({ html: "x", audioPath: big, activity });
    const r = await fetch(new URL("audio.wav", slow.url));
    const reader = r.body!.getReader();
    await reader.read();
    expect(activity.busy()).toBe(true);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(activity.busy()).toBe(false);
    await slow.close();
    await server.close();
  });

  it("fb2 review m2: answers structure with none once the page has reported an error (it never starts an analysis)", async () => {
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", structureProgress: () => ({ state: "pending", percent: 0 }) });
    expect(await (await fetch(new URL("structure", server.url))).json()).toEqual({ state: "pending", percent: 0 });
    await fetch(new URL("ready?error=boom", server.url));
    expect(await (await fetch(new URL("structure", server.url))).json()).toEqual({ state: "none", percent: 0 });
    await server.close();
  });

  it("fb2: answers structure with the background analysis's progress as JSON, and 404s without one", async () => {
    let percent = 37;
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", structureProgress: () => ({ state: "running", percent }) });
    const r = await fetch(new URL("structure", server.url));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ state: "running", percent: 37 });
    percent = 80;
    expect(await (await fetch(new URL("structure", server.url))).json()).toEqual({ state: "running", percent: 80 });
    expect((await fetch(new URL("/other/structure", server.url))).status).toBe(404);
    await server.close();
    const none = await serveDialog({ html: "x", audioPath: "/nope.wav" });
    expect((await fetch(new URL("structure", none.url))).status).toBe(404);
    await none.close();
  });
});

// Feedback round 2 B: the audition stems, next to audio.wav, whole or as a ?start=&end= slice.
describe("serveDialog stems", () => {
  const FRAMES = 44100 * 3;
  /** A stem folder whose frame f holds (f, -f) as int16 (mod 32768), so any slice can be checked. */
  function stemsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "dlg-stems-"));
    for (const s of STEM_NAMES) {
      const pcm = new Int16Array(2 * FRAMES);
      for (let f = 0; f < FRAMES; f++) {
        pcm[2 * f] = f % 32768;
        pcm[2 * f + 1] = -(f % 32768);
      }
      writeFileSync(join(dir, `${s}.wav`), Buffer.concat([pcm16Header(FRAMES), Buffer.from(pcm.buffer)]));
    }
    return dir;
  }
  const frameData = (b: Buffer) => new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length));

  it("serves each stem whole at stems/<stem>.wav", async () => {
    const dir = stemsDir();
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", stemsDir: dir });
    for (const s of STEM_NAMES) {
      const r = await fetch(new URL(`stems/${s}.wav`, server.url));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/wav");
      expect(r.headers.get("content-length")).toBe(String(44 + 4 * FRAMES));
      expect(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(dir, `${s}.wav`)))).toBe(true); // not toEqual: 0.5 MB element by element is seconds
    }
    await server.close();
  });

  it("serves a slice as a complete WAV of just those frames", async () => {
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", stemsDir: stemsDir() });
    const r = await fetch(new URL("stems/bass.wav?start=1&end=1.5", server.url));
    expect(r.status).toBe(200);
    const b = Buffer.from(await r.arrayBuffer());
    expect(r.headers.get("content-length")).toBe(String(b.length));
    expect(b.subarray(0, 44)).toEqual(pcm16Header(22050));
    const d = frameData(b);
    expect(d.length).toBe(2 * 22050);
    expect([d[0], d[1], d[2 * 22049]]).toEqual([44100 % 32768, -(44100 % 32768), (44100 + 22049) % 32768]); // frames 44100 .. 66149
    await server.close();
  });

  it("clamps a slice to the stem, and an empty or reversed one is a header with no frames", async () => {
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", stemsDir: stemsDir() });
    const tail = Buffer.from(await (await fetch(new URL("stems/drums.wav?start=2.5&end=99", server.url))).arrayBuffer());
    expect(tail.readUInt32LE(40)).toBe(4 * (FRAMES - 110250));
    expect(frameData(tail)[0]).toBe(110250 % 32768);
    const head = Buffer.from(await (await fetch(new URL("stems/drums.wav?start=-4&end=0.001", server.url))).arrayBuffer());
    expect(head.readUInt32LE(40)).toBe(4 * 44);
    const none = Buffer.from(await (await fetch(new URL("stems/drums.wav?start=2&end=1", server.url))).arrayBuffer());
    expect(none.length).toBe(44);
    expect(none.readUInt32LE(40)).toBe(0);
    await server.close();
  });

  it("rejects a bad slice (400), and 404s an unknown stem, a path outside the folder, or no folder", async () => {
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", stemsDir: stemsDir() });
    expect((await fetch(new URL("stems/drums.wav?start=x&end=1", server.url))).status).toBe(400);
    expect((await fetch(new URL("stems/drums.wav?start=1", server.url))).status).toBe(400);
    expect((await fetch(new URL("stems/piano.wav", server.url))).status).toBe(404);
    expect((await fetch(new URL("stems/%2E%2E%2Fdrums.wav", server.url))).status).toBe(404);
    expect((await fetch(new URL("/other/stems/drums.wav", server.url))).status).toBe(404);
    await server.close();
    for (const stemsDir of [undefined, null]) {
      const bare = await serveDialog({ html: "x", audioPath: "/nope.wav", stemsDir });
      expect((await fetch(new URL("stems/drums.wav", bare.url))).status).toBe(404);
      await bare.close();
    }
    // A folder evicted while the dialog is open: 404, not a crash.
    const gone = await serveDialog({ html: "x", audioPath: "/nope.wav", stemsDir: "/nope/stems" });
    expect((await fetch(new URL("stems/drums.wav?start=0&end=1", gone.url))).status).toBe(404);
    await gone.close();
  });
});

// fb3, item 2: a click before the whole preview has loaded plays the clicked range from a range fetch.
describe("serveDialog audio slices", () => {
  /** The preview's own format (audio/prepare.ts): mono 16-bit PCM at `rate`; frame f holds f (mod 32768). */
  function preview(rate: number, seconds: number): string {
    const frames = rate * seconds;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii");
    h.writeUInt32LE(36 + 2 * frames, 4);
    h.write("WAVEfmt ", 8, "ascii");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "ascii");
    h.writeUInt32LE(2 * frames, 40);
    const pcm = new Int16Array(frames);
    for (let f = 0; f < frames; f++) pcm[f] = f % 32768;
    const path = join(mkdtempSync(join(tmpdir(), "dlg-prev-")), "p.wav");
    writeFileSync(path, Buffer.concat([h, Buffer.from(pcm.buffer)]));
    return path;
  }

  for (const rate of [24000, 22050]) {
    it(`cuts a ${rate} Hz preview at its own rate, as a complete WAV in its own format`, async () => {
      const server = await serveDialog({ html: "x", audioPath: preview(rate, 3) });
      const r = await fetch(new URL("audio.wav?start=1&end=1.5", server.url));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/wav");
      const b = Buffer.from(await r.arrayBuffer());
      expect(r.headers.get("content-length")).toBe(String(b.length));
      expect(b.toString("ascii", 0, 4)).toBe("RIFF");
      expect([b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)]).toEqual([1, rate, 16]);
      expect(b.readUInt32LE(40)).toBe(rate); // half a second of 2-byte frames
      expect(b.length).toBe(44 + rate);
      expect(b.readInt16LE(44)).toBe(rate % 32768); // frame `rate` is 1 s in
      await server.close();
    });
  }

  it("clamps a slice to the preview, 400s a bad one, and still serves the whole file without a query", async () => {
    const path = preview(24000, 2);
    const server = await serveDialog({ html: "x", audioPath: path });
    const tail = Buffer.from(await (await fetch(new URL("audio.wav?start=1.5&end=9", server.url))).arrayBuffer());
    expect(tail.readUInt32LE(40)).toBe(2 * 12000);
    const none = Buffer.from(await (await fetch(new URL("audio.wav?start=2&end=1", server.url))).arrayBuffer());
    expect(none.length).toBe(44);
    expect((await fetch(new URL("audio.wav?start=x&end=1", server.url))).status).toBe(400);
    const whole = Buffer.from(await (await fetch(new URL("audio.wav", server.url))).arrayBuffer());
    expect(whole.equals(readFileSync(path))).toBe(true);
    await server.close();
  });
});

describe("serveDialog: About links", () => {
  it("opens only the About links, by key, and says whether the browser opened", async () => {
    const asked: string[] = [];
    let ok = true;
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", openUrl: async (u) => (asked.push(u), ok) });
    expect((await fetch(new URL("open?to=feedback", server.url))).status).toBe(204);
    expect(asked).toEqual([ABOUT_LINKS.feedback]);
    ok = false;
    expect((await fetch(new URL("open?to=source", server.url))).status).toBe(502);
    expect((await fetch(new URL("open?to=https%3A%2F%2Fexample.com", server.url))).status).toBe(404);
    expect((await fetch(new URL("open?to=__proto__", server.url))).status).toBe(404);
    expect((await fetch(new URL("open", server.url))).status).toBe(404);
    expect(asked).toEqual([ABOUT_LINKS.feedback, ABOUT_LINKS.source]);
    await server.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a link without URLSearchParams, which Live's extension sandbox does not provide", async () => {
    const asked: string[] = [];
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav", openUrl: async (u) => (asked.push(u), true) });
    const url = new URL("open?to=page", server.url);
    vi.stubGlobal("URLSearchParams", undefined);
    const res = await fetch(url);
    vi.unstubAllGlobals();
    expect(res.status).toBe(204);
    expect(asked).toEqual([ABOUT_LINKS.page]);
    await server.close();
  });

  it("answers instead of crashing the host when the opener throws", async () => {
    const server = await serveDialog({
      html: "x",
      audioPath: "/nope.wav",
      openUrl: () => {
        throw new Error("boom");
      },
    });
    expect((await fetch(new URL("open?to=page", server.url))).status).toBe(502);
    await server.close();
  });

  it("opens nothing without an opener", async () => {
    const server = await serveDialog({ html: "x", audioPath: "/nope.wav" });
    expect((await fetch(new URL("open?to=feedback", server.url))).status).toBe(404);
    await server.close();
  });
});
