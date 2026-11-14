// Section preview playback (Web Audio: Live's webview needs it rather than an <audio> element).
//
// fb3, item 2 ("I had to wait a few seconds to hear audio when I first auditioned a cue"): the preview used to be
// fetched and decoded whole on the first click. Now the dialog calls preload() once it has mounted, and the preview
// (audio/prepare.ts: our own 16-bit PCM WAV, mono at 22.05 or 24 kHz) is fetched in the background and kept as its
// 16-bit samples, with no decodeAudioData. A click turns just the clicked range into an AudioBuffer at the preview's
// own rate, so it plays at once. A click before the preview is in plays its range from a range fetch
// (`?start=&end=`, dialogServer.ts). Memory for a 30-minute clip: 86 MB of 16-bit at 24 kHz, against ~345 MB for the
// old whole-clip decode at 48 kHz. A range longer than WHOLE_MAX_SEC is played as CHUNK_SEC buffers made one ahead,
// on one timeline, so a long section never needs one big buffer.
//
// fb2 review I2 (merged at int3): this one preload is also what keeps the first Play off the extension host while a
// background Structure analysis runs. It starts as the dialog mounts (Timeline.svelte), so the preview has gone out
// before the host starts that analysis (dialogServer.ts holds onReady until audio.wav has been sent, or 3 s), and the
// whole preview is fetched once per dialog: a click while it is on its way uses a range fetch, not a second copy.
//
// The rate: every buffer is made at the WAV's own rate, whatever the render's (48 kHz in Matt's Set, 44.1 kHz in
// another): the browser resamples it to the context, so it always plays in real time.

import { hostFetchBytes } from "./bridge.js";

export interface Player {
  /**
   * Starts fetching the whole preview in the background (once; again after a failure), without decoding it, so a
   * click needs nothing from the host. Best effort: never throws (no fetch, or a URL that does not resolve).
   */
  preload(): void;
  /** Whether the whole preview is in memory, so a click needs no fetch. */
  loaded(): boolean;
  /**
   * fb4, item 2: calls `fn` with the preview's samples once they are in (at once if they are already), for the zoomed
   * waveform to draw from. Returns a function that unsubscribes.
   */
  onLoad(fn: (pcm: Pcm16) => void): () => void;
  playRange(start: number, end: number): void;
  /**
   * Opens the audio context and resumes it, right now. For a caller that plays a moment later (after an await): the
   * browser lets a context start only from a user gesture, and the resume must be made inside it.
   */
  unlock(): void;
  stop(): void;
  /** Stops playback and releases the AudioContext and the preview. */
  dispose(): void;
  /** Current playback time in seconds, or null while loading, when stopped, and once the range has ended. */
  position(): number | null;
}

type Timer = unknown;

export interface PlayerDeps {
  fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createContext(): AudioContext;
  setTimer(fn: () => void, ms: number): Timer;
  clearTimer(t: Timer): void;
}

const browserDeps = (): PlayerDeps => ({
  fetch: hostFetchBytes, // records the host's answers for deliver (bridge.ts HOST_FRESH_MS)
  createContext: () => new AudioContext(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

/** A range up to this long is one buffer. */
export const WHOLE_MAX_SEC = 120;
/** Seconds per buffer of a longer range: whole seconds, so each starts on a whole frame at any integer rate. */
export const CHUNK_SEC = 10;
/** Seconds between the first buffer being ready and its start, so its first frames are not cut. */
const LEAD_SEC = 0.03;

/** A 16-bit PCM WAV's samples (interleaved), as a view on `data` where it can be; null when it is not one. */
export interface Pcm16 {
  rate: number;
  channels: number;
  frames: number;
  samples: Int16Array;
}

export function parsePcm16(data: ArrayBuffer): Pcm16 | null {
  const view = new DataView(data);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (data.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: { rate: number; channels: number } | null = null;
  for (let pos = 12; pos + 8 <= data.byteLength; ) {
    const id = tag(pos);
    const len = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= data.byteLength) {
      const pcm16 = view.getUint16(body, true) === 1 && view.getUint16(body + 14, true) === 16;
      const channels = view.getUint16(body + 2, true);
      const rate = view.getUint32(body + 4, true);
      fmt = pcm16 && channels > 0 && rate > 0 ? { rate, channels } : null;
      if (!fmt) return null;
    } else if (id === "data") {
      if (!fmt) return null;
      const frames = Math.floor(Math.min(len, data.byteLength - body) / (2 * fmt.channels));
      const n = frames * fmt.channels;
      const samples = body % 2 === 0 ? new Int16Array(data, body, n) : new Int16Array(data.slice(body, body + 2 * n));
      return { ...fmt, frames, samples };
    }
    pos = body + len + (len % 2);
  }
  return null;
}

/** Frames [f0, f1) of `pcm` as an AudioBuffer at the PCM's own rate; null when that is empty. */
export function toAudioBuffer(ctx: BaseAudioContext, pcm: Pcm16, f0: number, f1: number): AudioBuffer | null {
  const a = Math.max(0, Math.min(pcm.frames, f0));
  const b = Math.max(a, Math.min(pcm.frames, f1));
  if (b === a) return null;
  const buf = ctx.createBuffer(pcm.channels, b - a, pcm.rate);
  const c = pcm.channels;
  for (let ch = 0; ch < c; ch++) {
    const out = buf.getChannelData(ch);
    for (let i = 0, j = a * c + ch; i < b - a; i++, j += c) out[i] = pcm.samples[j] / 32768;
  }
  return buf;
}

/** The buffers [start, end) is played as, in seconds: one up to WHOLE_MAX_SEC, CHUNK_SEC ones beyond; [] if empty. */
export function playPlan(start: number, end: number): Array<[number, number]> {
  if (!(end > start)) return [];
  if (end - start <= WHOLE_MAX_SEC) return [[start, end]];
  const out: Array<[number, number]> = [];
  for (let k = 0; start + k * CHUNK_SEC < end; k++) out.push([start + k * CHUNK_SEC, Math.min(end, start + (k + 1) * CHUNK_SEC)]);
  return out;
}

export function createPlayer(url: string, onError: (e: unknown) => void = () => {}, deps: PlayerDeps = browserDeps()): Player {
  let ctx: AudioContext | null = null;
  let whole: Pcm16 | null = null;
  let loading: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<(pcm: Pcm16) => void>();
  const sources = new Set<AudioBufferSourceNode>();
  let timer: Timer | null = null;
  let generation = 0; // invalidates buffers still on their way for an earlier playRange()
  let range: { start: number; end: number; t0: number | null } | null = null; // t0: context time of `start`

  function preload() {
    if (disposed) return;
    // The context too: Chrome takes ~125 ms to open the audio device for a page's first one (measured, fb3), which a
    // first click otherwise waits for. Made before any click, it starts suspended; the click resumes it.
    try {
      ctx ??= deps.createContext();
    } catch {
      // the click tries again, and reports it
    }
    if (whole || loading) return;
    let request: ReturnType<PlayerDeps["fetch"]>;
    try {
      request = deps.fetch(url);
    } catch {
      return; // no fetch, or a relative URL that does not resolve (a page opened from a file): a click tries again
    }
    loading = request
      .then((r) => {
        if (!r.ok) throw new Error(`Audio request failed (HTTP ${r.status})`);
        return r.arrayBuffer();
      })
      .then((data) => {
        if (disposed) return;
        const pcm = parsePcm16(data);
        if (!pcm) throw new Error("Preview audio is not 16-bit PCM");
        whole = pcm;
        for (const fn of [...listeners]) {
          try {
            fn(pcm);
          } catch {
            // a listener's failure is its own
          }
        }
      })
      .catch(() => {
        // A click still plays, from a range fetch; the next click tries the whole preview again.
      })
      .finally(() => (loading = null));
  }

  /** [a, b) seconds as an AudioBuffer: from memory once the preview is in, otherwise from a range fetch. */
  function segment(c: AudioContext, a: number, b: number): Promise<AudioBuffer | null> {
    const pcm = whole;
    if (pcm) return Promise.resolve(toAudioBuffer(c, pcm, Math.round(a * pcm.rate), Math.round(b * pcm.rate)));
    return deps
      .fetch(`${url}?start=${a}&end=${b}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Audio request failed (HTTP ${r.status})`);
        return r.arrayBuffer();
      })
      .then((data) => {
        const p = parsePcm16(data);
        if (!p) throw new Error("Preview audio is not 16-bit PCM");
        return toAudioBuffer(c, p, 0, p.frames);
      });
  }

  function stop() {
    generation++;
    range = null;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // not started, or already stopped
      }
    }
    sources.clear();
  }

  function unlock() {
    if (disposed) return;
    try {
      ctx ??= deps.createContext();
      void ctx.resume().catch(() => {});
    } catch {
      // playRange tries again, and reports it
    }
  }

  function playRange(start: number, end: number) {
    stop();
    const mine = generation;
    try {
      ctx ??= deps.createContext();
    } catch (e) {
      onError(e);
      return;
    }
    const c = ctx;
    void c.resume().catch(() => {});
    preload();
    const plan = playPlan(start, end);
    if (plan.length === 0) return;
    const r = { start, end, t0: null as number | null };
    range = r;
    const rate = c.sampleRate > 0 ? c.sampleRate : 48000;
    let frame0: number | null = null;

    const load = (k: number) => {
      timer = null;
      const [a, b] = plan[k];
      segment(c, a, b)
        .then((buf) => {
          if (mine !== generation) return;
          if (!buf) return;
          frame0 ??= Math.ceil((c.currentTime + LEAD_SEC) * rate);
          r.t0 ??= frame0 / rate;
          // Buffer k starts exactly (a - start) after the first: whole seconds, so a whole frame of the context.
          const when = (frame0 + Math.round((a - start) * rate)) / rate;
          const now = c.currentTime;
          if (now - when < buf.duration) {
            const src = c.createBufferSource();
            src.buffer = buf;
            src.connect(c.destination);
            src.onended = () => void sources.delete(src);
            if (when >= now) src.start(when);
            else src.start(now, now - when); // late: join part-way in, in time
            sources.add(src);
          }
          if (k + 1 < plan.length) timer = deps.setTimer(() => load(k + 1), Math.max(0, (when - c.currentTime) * 1000));
        })
        .catch((e) => {
          if (mine !== generation) return;
          stop();
          onError(e);
        });
    };
    load(0);
  }

  function position(): number | null {
    if (!range || !ctx || range.t0 === null) return null;
    const t = range.start + Math.max(0, ctx.currentTime - range.t0);
    return t < range.end ? t : null;
  }

  function dispose() {
    stop();
    disposed = true;
    void ctx?.close().catch(() => {});
    ctx = null;
    whole = null;
    listeners.clear();
  }

  function onLoad(fn: (pcm: Pcm16) => void): () => void {
    if (whole) fn(whole);
    else if (!disposed) listeners.add(fn);
    return () => void listeners.delete(fn);
  }

  return { preload, loaded: () => whole !== null, onLoad, playRange, unlock, stop, position, dispose };
}
