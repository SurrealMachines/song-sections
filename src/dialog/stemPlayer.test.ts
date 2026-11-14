import { describe, expect, it, vi } from "vitest";
import { pcm16Header } from "../structure/audition.js";
import { CHUNK_SEC, chunkRanges, createStemPlayer, pcm16ToBuffer, requestPlan, stemContext, WHOLE_MAX_SEC, type StemPlayerDeps } from "./stemPlayer.js";

const RATE = 44100;

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
  constructor(readonly sampleRate = RATE) {}
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

/** A slice as the server sends it: frame f of the stem is (f, -f) / 32768 (mod 32768). */
function slice(url: string): ArrayBuffer {
  const q = url.slice(url.indexOf("?") + 1);
  const get = (k: string) => Number(q.split("&").find((p) => p.startsWith(k + "="))!.slice(k.length + 1));
  const f0 = Math.round(get("start") * RATE);
  const f1 = Math.round(get("end") * RATE);
  const pcm = new Int16Array(2 * (f1 - f0));
  for (let f = f0; f < f1; f++) {
    pcm[2 * (f - f0)] = f % 32768;
    pcm[2 * (f - f0) + 1] = -(f % 32768);
  }
  const b = Buffer.concat([pcm16Header(f1 - f0), Buffer.from(pcm.buffer)]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
}

function harness(opts: { status?: number; sampleRate?: number } = {}) {
  const ctx = new FakeContext(opts.sampleRate);
  const urls: string[] = [];
  const pending: Array<() => void> = []; // fetches resolve only when a test lets them
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const deps: StemPlayerDeps = {
    createContext: () => ctx as unknown as AudioContext,
    fetch: (url) => {
      urls.push(url);
      return new Promise((resolve) =>
        pending.push(() =>
          resolve({ ok: (opts.status ?? 200) === 200, status: opts.status ?? 200, arrayBuffer: async () => slice(url) }),
        ),
      );
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { live: boolean }).live = false),
  };
  const onError = vi.fn();
  const player = createStemPlayer(onError, deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Resolves every fetch in flight and lets the player schedule it. */
  const arrive = async () => {
    while (pending.length) pending.shift()!();
    for (let i = 0; i < 5; i++) await flush();
  };
  const runTimers = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
  const liveTimers = () => timers.filter((t) => t.live);
  return { ctx, urls, deps, onError, player, arrive, runTimers, liveTimers };
}

describe("chunkRanges", () => {
  it("cuts a range into CHUNK_SEC pieces on whole frames, the last one short", () => {
    expect(CHUNK_SEC).toBe(10);
    expect(chunkRanges(0, 25)).toEqual([[0, 10], [10, 20], [20, 25]]);
    const [first, second] = chunkRanges(1.2345, 30);
    const f0 = Math.round(1.2345 * RATE);
    expect(first).toEqual([f0 / RATE, (f0 + 10 * RATE) / RATE]);
    expect(second[0]).toBe(first[1]);
    expect(chunkRanges(5, 5)).toEqual([]);
    expect(chunkRanges(6, 5)).toEqual([]);
  });
});

describe("requestPlan (controller ruling, fb2: audition ticks)", () => {
  it("fetches a range of up to 120 s in one request, on whole frames", () => {
    expect(WHOLE_MAX_SEC).toBe(120);
    expect(requestPlan(12, 37)).toEqual([[12, 37]]);
    expect(requestPlan(0, 120)).toEqual([[0, 120]]);
    const f0 = Math.round(3.33333 * RATE);
    const f1 = Math.round(123.33333 * RATE); // 120 s to the frame
    expect(requestPlan(3.33333, 123.33333)).toEqual([[f0 / RATE, f1 / RATE]]);
    expect(requestPlan(5, 5)).toEqual([]);
    expect(requestPlan(6, 5)).toEqual([]);
  });

  it("cuts a longer range into CHUNK_SEC slices that tile it frame for frame", () => {
    expect(requestPlan(0, 120 + 1 / RATE)).toEqual(chunkRanges(0, 120 + 1 / RATE));
    expect(requestPlan(0, 120 + 1 / RATE)).toHaveLength(13);
    const plan = requestPlan(1.2345, 301.9);
    expect(plan).toHaveLength(31);
    expect(plan[0][0]).toBe(Math.round(1.2345 * RATE) / RATE);
    expect(plan.at(-1)![1]).toBe(Math.round(301.9 * RATE) / RATE);
    for (let k = 1; k < plan.length; k++) expect(plan[k][0]).toBe(plan[k - 1][1]); // no gap, no overlap
    for (const [a, b] of plan) {
      expect(Math.abs(a * RATE - Math.round(a * RATE))).toBeLessThan(1e-6); // on a stem frame
      expect(b - a).toBeLessThanOrEqual(CHUNK_SEC + 1e-9);
    }
  });
});

describe("stemContext", () => {
  it("asks for a 44.1 kHz context, and takes the default rate where that option throws", () => {
    const seen: unknown[] = [];
    class Ok {
      constructor(o?: AudioContextOptions) {
        seen.push(o);
      }
    }
    stemContext(Ok as unknown as typeof AudioContext);
    expect(seen).toEqual([{ sampleRate: 44100 }]);
    class Picky {
      constructor(o?: AudioContextOptions) {
        if (o) throw new DOMException("NotSupportedError");
        seen.push("default");
      }
    }
    expect(stemContext(Picky as unknown as typeof AudioContext)).toBeInstanceOf(Picky);
    expect(seen.at(-1)).toBe("default");
  });
});

describe("pcm16ToBuffer", () => {
  it("decodes a 16-bit stereo WAV slice into a 44.1 kHz AudioBuffer, by hand (no decodeAudioData)", () => {
    const ctx = new FakeContext();
    const buf = pcm16ToBuffer(ctx as unknown as AudioContext, slice("x?start=1&end=1.001")) as unknown as FakeBuffer;
    expect([buf.numberOfChannels, buf.length, buf.sampleRate]).toEqual([2, 44, RATE]);
    expect(buf.data[0][0]).toBe((44100 % 32768) / 32768);
    expect(buf.data[1][3]).toBe(-((44103 % 32768) / 32768));
  });

  it("gives null for an empty slice or a file that is not 16-bit stereo PCM", () => {
    const ctx = new FakeContext() as unknown as AudioContext;
    expect(pcm16ToBuffer(ctx, slice("x?start=1&end=1"))).toBeNull();
    const bad = pcm16Header(4);
    bad.writeUInt16LE(3, 20); // float
    expect(pcm16ToBuffer(ctx, bad.buffer.slice(bad.byteOffset, bad.byteOffset + 44 + 16) as ArrayBuffer)).toBeNull();
  });
});

describe("createStemPlayer", () => {
  it("fetches a section of up to 120 s whole, in one request and one buffer: no joins", async () => {
    const h = harness();
    h.player.play("stems/drums.wav", 12, 37);
    expect(h.urls).toEqual([`stems/drums.wav?start=12&end=37`]);
    expect(h.player.position()).toBeNull(); // loading
    await h.arrive();
    expect(h.ctx.sources).toHaveLength(1);
    expect(h.ctx.sources[0].buffer!.length).toBe(25 * RATE);
    expect(h.liveTimers()).toHaveLength(0);
    expect(h.urls).toHaveLength(1);
  });

  it("beyond 120 s, fetches a chunk at a time and schedules each on one timeline, a whole number of frames after the first", async () => {
    for (const sampleRate of [RATE, 48000]) {
      const h = harness({ sampleRate });
      h.ctx.currentTime = 100.0000123; // between two frames, as a running context is
      h.player.play("stems/drums.wav", 12.34567, 147);
      const plan = requestPlan(12.34567, 147);
      expect(plan).toHaveLength(14);
      expect(h.urls).toEqual([`stems/drums.wav?start=${plan[0][0]}&end=${plan[0][1]}`]); // nothing else fetched yet
      await h.arrive();
      // The next chunk is fetched once the current one starts playing: at most two chunks are in memory.
      for (let k = 1; k < plan.length; k++) {
        expect(h.urls).toHaveLength(k);
        expect(h.liveTimers()).toHaveLength(1);
        h.runTimers();
        expect(h.urls[k]).toBe(`stems/drums.wav?start=${plan[k][0]}&end=${plan[k][1]}`);
        await h.arrive();
      }
      expect(h.liveTimers()).toHaveLength(0); // the last chunk
      const starts = h.ctx.sources.map((src) => src.started![0] * sampleRate);
      expect(starts[0]).toBeGreaterThan(100 * sampleRate);
      expect(Math.abs(starts[0] - Math.round(starts[0]))).toBeLessThan(1e-6); // on a frame of the context
      // Each chunk starts exactly where the one before it ends, in the context's frames.
      for (let k = 1; k < plan.length; k++) {
        const stemFrames = Math.round(plan[k][0] * RATE) - Math.round(plan[0][0] * RATE);
        expect(starts[k] - starts[0]).toBeCloseTo((stemFrames / RATE) * sampleRate, 6);
        expect(Math.abs(starts[k] - Math.round(starts[k]))).toBeLessThan(1e-6); // every chunk on a frame too
        expect(starts[k] - starts[k - 1]).toBeCloseTo(h.ctx.sources[k - 1].buffer!.duration * sampleRate, 6);
      }
      expect(h.ctx.sources.at(-1)!.buffer!.length).toBe(Math.round(147 * RATE) - Math.round(plan.at(-1)![0] * RATE));
    }
  });

  it("position(): the clip time while playing, the start during the lead-in, null once it ends", async () => {
    const h = harness();
    h.player.play("stems/bass.wav", 50, 55);
    await h.arrive();
    const t0 = h.ctx.sources[0].started![0];
    expect(h.player.position()).toBe(50); // before t0
    h.ctx.currentTime = t0 + 2.5;
    expect(h.player.position()).toBeCloseTo(52.5, 9);
    h.ctx.currentTime = t0 + 5;
    expect(h.player.position()).toBeNull();
  });

  it("a chunk that arrives late starts at once, part-way in, so it stays in time", async () => {
    const h = harness();
    h.player.play("stems/other.wav", 0, 130); // over 120 s: chunked
    await h.arrive();
    const t0 = h.ctx.sources[0].started![0];
    h.runTimers();
    h.ctx.currentTime = t0 + 10.25; // chunk 1 should have started 0.25 s ago
    await h.arrive();
    expect(h.ctx.sources[1].started).toEqual([t0 + 10.25, expect.closeTo(0.25, 6)]);
  });

  it("a chunk that arrives after its whole span is skipped, and the next one still plays in time (review M8)", async () => {
    const h = harness();
    h.player.play("stems/other.wav", 0, 140); // over 120 s: chunked
    await h.arrive();
    const t0 = h.ctx.sources[0].started![0];
    const len0 = h.ctx.sources[0].buffer!.duration;
    h.runTimers();
    const n = h.ctx.sources.length;
    h.ctx.currentTime = t0 + len0 + 11; // chunk 1 (10 s) is wholly in the past
    await h.arrive();
    expect(h.ctx.sources).toHaveLength(n); // no source made for it
    expect(h.liveTimers()).toHaveLength(1); // chunk 2 is still asked for
    h.runTimers();
    await h.arrive();
    const s2 = h.ctx.sources.at(-1)!;
    expect(s2.started![0]).toBeCloseTo(t0 + len0 + 11, 9); // joins part-way in, in time
    expect(s2.started![1]).toBeCloseTo(1, 6);
  });

  it("stop() stops what plays, cancels the next fetch, and a fetch that lands afterwards is dropped", async () => {
    const h = harness();
    h.player.play("stems/drums.wav", 0, 30);
    await h.arrive();
    h.player.stop();
    expect(h.ctx.sources[0].stopped).toBe(true);
    expect(h.liveTimers()).toHaveLength(0);
    expect(h.player.position()).toBeNull();

    h.player.play("stems/drums.wav", 0, 30);
    h.player.stop(); // before its first chunk arrives
    await h.arrive();
    expect(h.ctx.sources).toHaveLength(1);
  });

  it("play() on another cell replaces the one playing", async () => {
    const h = harness();
    h.player.play("stems/drums.wav", 0, 30);
    await h.arrive();
    h.player.play("stems/vocals.wav", 40, 45);
    expect(h.ctx.sources[0].stopped).toBe(true);
    await h.arrive();
    expect(h.ctx.sources).toHaveLength(2);
    expect(h.urls.at(-1)).toBe("stems/vocals.wav?start=40&end=45");
  });

  it("an HTTP error reports through onError and plays nothing", async () => {
    const h = harness({ status: 404 });
    h.player.play("stems/drums.wav", 0, 5);
    await h.arrive();
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/404/) }));
    expect(h.ctx.sources).toHaveLength(0);
    expect(h.player.position()).toBeNull();
  });

  it("dispose() closes the AudioContext", async () => {
    const h = harness();
    h.player.play("stems/drums.wav", 0, 5);
    await h.arrive();
    h.player.dispose();
    expect(h.ctx.closed).toBe(true);
  });
});

describe("createStemPlayer unlock (Plan 6, Task 5 review)", () => {
  it("opens the context and resumes it at once, before any play, and again on each call; nothing after dispose", () => {
    const h = harness();
    h.player.unlock();
    expect(h.ctx.resume).toHaveBeenCalledTimes(1);
    h.player.unlock();
    expect(h.ctx.resume).toHaveBeenCalledTimes(2);
    expect(h.urls).toEqual([]);
    expect(h.ctx.sources).toHaveLength(0);
    h.player.dispose();
    h.player.unlock();
    expect(h.ctx.resume).toHaveBeenCalledTimes(2);
  });
});
