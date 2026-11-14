import { describe, expect, it, vi } from "vitest";
import { CHUNK_SEC, createPlayer, parsePcm16, playPlan, WHOLE_MAX_SEC, type PlayerDeps } from "./player.js";

// Fakes as in stemPlayer.test.ts: buffers record their rate and samples, sources when they were started.
class FakeBuffer {
  readonly data: Float32Array[];
  readonly duration: number;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    this.duration = length / sampleRate;
  }
  getChannelData(c: number) {
    return this.data[c];
  }
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  started: number[] | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {}
  start(...args: number[]) {
    this.started = args;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeContext {
  constructor(readonly sampleRate: number) {}
  currentTime = 100;
  destination = {};
  closed = false;
  sources: FakeSource[] = [];
  resume = vi.fn(async () => {});
  async close() {
    this.closed = true;
  }
  createBuffer(ch: number, n: number, rate: number) {
    return new FakeBuffer(ch, n, rate);
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

/** The preview's format (audio/prepare.ts): mono 16-bit at `rate`; frame f holds f (mod 32768). Frames [f0, f1). */
function wav(rate: number, f0: number, f1: number): ArrayBuffer {
  const n = Math.max(0, f1 - f0);
  const b = Buffer.alloc(44 + 2 * n);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + 2 * n, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(2 * rate, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(2 * n, 40);
  for (let f = f0; f < f1; f++) b.writeInt16LE(f % 32768, 44 + 2 * (f - f0));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
}

/** A preview of `seconds` at `fileRate` (the render's rate halved), played on a context at `ctxRate`. */
function harness(fileRate: number, ctxRate: number, seconds = 600, failWhole = false) {
  const ctx = new FakeContext(ctxRate);
  const urls: string[] = [];
  const pending: Array<() => void> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const deps: PlayerDeps = {
    createContext: () => ctx as unknown as AudioContext,
    fetch: (url) => {
      urls.push(url);
      const q = url.indexOf("?");
      const get = (k: string) => Number(url.slice(q + 1).split("&").find((p) => p.startsWith(k + "="))!.slice(k.length + 1));
      const body = q < 0 ? wav(fileRate, 0, seconds * fileRate) : wav(fileRate, Math.round(get("start") * fileRate), Math.round(get("end") * fileRate));
      const ok = !(failWhole && q < 0);
      return new Promise((resolve) => pending.push(() => resolve({ ok, status: ok ? 200 : 500, arrayBuffer: async () => body })));
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { live: boolean }).live = false),
  };
  const onError = vi.fn();
  const player = createPlayer("audio.wav", onError, deps);
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const arrive = async () => {
    while (pending.length) pending.shift()!();
    await flush();
  };
  const runTimers = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
  return { ctx, urls, player, onError, arrive, flush, runTimers, timers };
}

describe("parsePcm16", () => {
  it("reads the preview's rate, channels and samples without copying", () => {
    const data = wav(24000, 0, 480);
    const p = parsePcm16(data)!;
    expect(p).toMatchObject({ rate: 24000, channels: 1, frames: 480 });
    expect(p.samples.buffer).toBe(data);
    expect(p.samples[479]).toBe(479);
    expect(parsePcm16(new ArrayBuffer(10))).toBeNull();
  });
});

describe("playPlan", () => {
  it("one buffer up to WHOLE_MAX_SEC, CHUNK_SEC ones beyond, nothing for an empty range", () => {
    expect(playPlan(3, 3 + WHOLE_MAX_SEC)).toEqual([[3, 3 + WHOLE_MAX_SEC]]);
    const long = playPlan(5, 5 + WHOLE_MAX_SEC + 1);
    expect(long).toHaveLength(WHOLE_MAX_SEC / CHUNK_SEC + 1);
    expect(long[0]).toEqual([5, 15]);
    expect(long.at(-1)).toEqual([5 + WHOLE_MAX_SEC, 5 + WHOLE_MAX_SEC + 1]);
    expect(playPlan(4, 4)).toEqual([]);
  });
});

// fb3, item 1: a 48 kHz render gives a 24 kHz preview, a 44.1 kHz one a 22.05 kHz preview; each must play in real
// time on a context at either rate.
describe.each([
  [24000, 48000],
  [24000, 44100],
  [22050, 48000],
  [22050, 44100],
])("a %d Hz preview on a %d Hz context", (fileRate, ctxRate) => {
  it("is made at the preview's own rate and plays [start, end) in real time", async () => {
    const h = harness(fileRate, ctxRate);
    h.player.preload();
    await h.arrive();
    expect(h.player.loaded()).toBe(true);
    h.player.playRange(10, 14);
    await h.flush();
    expect(h.urls).toEqual(["audio.wav"]); // no fetch for the click
    const src = h.ctx.sources[0];
    expect(src.buffer!.sampleRate).toBe(fileRate);
    expect(src.buffer!.length).toBe(4 * fileRate);
    expect(src.buffer!.duration).toBe(4);
    expect(src.buffer!.data[0][0] * 32768).toBe((10 * fileRate) % 32768); // frame 10 s in
    const t0 = Math.ceil((100 + 0.03) * ctxRate) / ctxRate;
    expect(src.started).toEqual([t0]);
    h.ctx.currentTime = t0 + 1.5;
    expect(h.player.position()).toBeCloseTo(11.5, 9);
    h.ctx.currentTime = t0 + 4;
    expect(h.player.position()).toBeNull();
  });
});

describe("createPlayer (fb3 review m2: unlock)", () => {
  it("unlock opens the context and resumes it at once, before any playRange, and again on each call", () => {
    const h = harness(24000, 48000);
    h.player.unlock();
    expect(h.ctx.resume).toHaveBeenCalledTimes(1);
    h.player.unlock();
    expect(h.ctx.resume).toHaveBeenCalledTimes(2);
    expect(h.ctx.sources).toHaveLength(0);
  });
  it("unlock after dispose does nothing", () => {
    const h = harness(24000, 48000);
    h.player.dispose();
    h.player.unlock();
    expect(h.ctx.resume).not.toHaveBeenCalled();
  });
});

describe("createPlayer (fb3, item 2: no wait on the first click)", () => {
  it("preload makes the context and fetches the whole preview once, and does nothing more until a click", async () => {
    const h = harness(24000, 48000);
    let made = 0;
    const p = createPlayer("audio.wav", () => {}, {
      fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
      createContext: () => (made++, h.ctx as unknown as AudioContext),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    p.preload();
    p.preload();
    expect(made).toBe(1);
    h.player.preload();
    h.player.preload();
    expect(h.urls).toEqual(["audio.wav"]);
    await h.arrive();
    expect(h.ctx.sources).toHaveLength(0);
    h.player.preload();
    expect(h.urls).toHaveLength(1);
  });

  it("a click before the preview is in plays its range from a range fetch, and the preview still arrives", async () => {
    const h = harness(24000, 48000);
    h.player.preload();
    h.player.playRange(30, 32.5);
    expect(h.urls).toEqual(["audio.wav", "audio.wav?start=30&end=32.5"]);
    await h.arrive();
    const src = h.ctx.sources[0];
    expect(src.buffer!.length).toBe(2.5 * 24000);
    expect(src.buffer!.data[0][0] * 32768).toBe((30 * 24000) % 32768);
    expect(h.player.loaded()).toBe(true);
    h.player.playRange(40, 41);
    await h.flush();
    expect(h.urls).toHaveLength(2);
    expect(h.ctx.sources).toHaveLength(2);
  });

  it("a long range plays as CHUNK_SEC buffers from memory, each made one ahead, back to back", async () => {
    const h = harness(24000, 48000);
    h.player.preload();
    await h.arrive();
    h.player.playRange(0, 300);
    await h.flush();
    expect(h.ctx.sources).toHaveLength(1);
    expect(h.ctx.sources[0].buffer!.duration).toBe(CHUNK_SEC);
    h.runTimers();
    await h.flush();
    expect(h.ctx.sources).toHaveLength(2);
    const [a, b] = h.ctx.sources.map((s) => s.started![0]);
    expect(b - a).toBeCloseTo(CHUNK_SEC, 12);
    expect(h.urls).toHaveLength(1);
  });

  it("stop and a new click drop a range fetch still on its way", async () => {
    const h = harness(24000, 48000);
    h.player.playRange(1, 2);
    h.player.stop();
    await h.arrive();
    expect(h.ctx.sources).toHaveLength(0);
    expect(h.player.position()).toBeNull();
  });

  it("a failed whole fetch leaves clicks working from range fetches, and the next click tries it again", async () => {
    const h = harness(24000, 48000, 600, true);
    h.player.preload();
    await h.arrive();
    expect(h.player.loaded()).toBe(false);
    h.player.playRange(5, 6);
    expect(h.urls).toEqual(["audio.wav", "audio.wav", "audio.wav?start=5&end=6"]);
    await h.arrive();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.ctx.sources).toHaveLength(1);
  });

  it("dispose closes the context and drops the preview", async () => {
    const h = harness(24000, 48000);
    h.player.preload();
    await h.arrive();
    h.player.playRange(0, 1);
    await h.flush();
    h.player.dispose();
    expect(h.ctx.closed).toBe(true);
    expect(h.player.loaded()).toBe(false);
    expect(h.ctx.sources[0].stopped).toBe(true);
  });
});

describe("createPlayer.onLoad (fb4, item 2)", () => {
  it("hands the preview's samples over once they are in, at once to a late subscriber, never after unsubscribing", async () => {
    const h = harness(24000, 48000);
    const got: number[] = [];
    const off = h.player.onLoad((p) => got.push(p.frames));
    const gone: number[] = [];
    h.player.onLoad((p) => gone.push(p.frames))();
    h.player.preload();
    expect(got).toEqual([]);
    await h.arrive();
    expect(got).toHaveLength(1);
    expect(got[0]).toBeGreaterThan(0);
    expect(gone).toEqual([]);
    const late: number[] = [];
    h.player.onLoad((p) => late.push(p.frames));
    expect(late).toEqual(got);
    off();
  });
});
