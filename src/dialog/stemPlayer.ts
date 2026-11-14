// Stem audition (feedback round 2 B): plays one section of one stem. The stems are 16-bit 44.1 kHz stereo WAVs served
// next to the clip audio; a 30-minute stem is 318 MB, ~690 MB decoded, so it is never fetched or decoded whole. The
// clicked range is fetched server-cut (`?start=&end=`) and turned into an AudioBuffer by hand (no decodeAudioData: it
// is our own PCM, and 10 s converts in a few ms).
// Controller ruling (fb2, audition ticks): a range of up to WHOLE_MAX_SEC is one request and one buffer, so there is no
// join to hear (21 MB of 16-bit, ~42 MB of float, held while it plays). A longer one is fetched in CHUNK_SEC slices,
// the next when the current one starts (at most two, ~7 MB of float, are held), and every slice is scheduled on one
// AudioContext timeline at a whole frame: the first at a frame of the context, each next one exactly its length in
// frames later. The context is asked for 44.1 kHz, the stems' own rate, so the slices play unresampled and abut
// sample for sample (the browser resamples the context's output once, as a stream, to the device rate).

import { hostFetchBytes } from "./bridge.js";

const RATE = 44100;
/** Seconds per fetched slice. A whole number: slice starts then fall on whole frames at 44.1, 48, 88.2 and 96 kHz. */
export const CHUNK_SEC = 10;
/** A range up to this long is fetched in one request (controller ruling, fb2: no seams to tick). */
export const WHOLE_MAX_SEC = 120;
/** Seconds between the first slice arriving and its start, so its first frames are not cut. */
const LEAD_SEC = 0.03;

export interface StemPlayer {
  /** Plays [start, end) seconds of the stem at `url`, stopping whatever was playing. */
  play(url: string, start: number, end: number): void;
  stop(): void;
  /** Stops playback and closes the AudioContext. */
  dispose(): void;
  /** The clip time being heard, in seconds; null while loading, when stopped, and once the range has ended. */
  position(): number | null;
  /**
   * Plan 6, Task 5 review: opens and resumes the AudioContext now, inside a user gesture (a key press), for a play()
   * that comes after an await, as player.ts's unlock does for the Timeline's nudges.
   */
  unlock(): void;
}

type Timer = unknown;

export interface StemPlayerDeps {
  fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createContext(): AudioContext;
  setTimer(fn: () => void, ms: number): Timer;
  clearTimer(t: Timer): void;
}

/**
 * An AudioContext at the stems' 44.1 kHz, so their buffers play unresampled and slices join on exact frames; the
 * device's default rate where that option is not supported.
 */
export function stemContext(Ctor: new (options?: AudioContextOptions) => AudioContext): AudioContext {
  try {
    return new Ctor({ sampleRate: RATE });
  } catch {
    return new Ctor();
  }
}

const browserDeps = (): StemPlayerDeps => ({
  fetch: hostFetchBytes, // records the host's answers for deliver (bridge.ts HOST_FRESH_MS)
  createContext: () => stemContext(AudioContext),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

/** [start, end) as slices of CHUNK_SEC on whole 44.1 kHz frames, in seconds; [] for an empty range. */
export function chunkRanges(start: number, end: number): Array<[number, number]> {
  const f0 = Math.round(start * RATE);
  const f1 = Math.round(end * RATE);
  const step = CHUNK_SEC * RATE;
  const out: Array<[number, number]> = [];
  for (let f = f0; f < f1; f += step) out.push([f / RATE, Math.min(f + step, f1) / RATE]);
  return out;
}

/**
 * The requests that fetch [start, end), on whole 44.1 kHz frames, in seconds: the whole range in one when it is at most
 * WHOLE_MAX_SEC, CHUNK_SEC slices (chunkRanges) when it is longer, [] for an empty range.
 */
export function requestPlan(start: number, end: number): Array<[number, number]> {
  const f0 = Math.round(start * RATE);
  const f1 = Math.round(end * RATE);
  if (f1 <= f0) return [];
  if (f1 - f0 <= WHOLE_MAX_SEC * RATE) return [[f0 / RATE, f1 / RATE]];
  return chunkRanges(start, end);
}

/** A 16-bit stereo PCM WAV (the server's slice) as an AudioBuffer at its own rate; null when empty or not that format. */
export function pcm16ToBuffer(ctx: AudioContext, data: ArrayBuffer): AudioBuffer | null {
  const view = new DataView(data);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (data.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let rate = 0;
  let pcm16Stereo = false;
  for (let pos = 12; pos + 8 <= data.byteLength; ) {
    const id = tag(pos);
    const len = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= data.byteLength) {
      pcm16Stereo = view.getUint16(body, true) === 1 && view.getUint16(body + 2, true) === 2 && view.getUint16(body + 14, true) === 16;
      rate = view.getUint32(body + 4, true);
    } else if (id === "data") {
      if (!pcm16Stereo || rate <= 0) return null;
      const frames = Math.floor(Math.min(len, data.byteLength - body) / 4);
      if (frames === 0) return null;
      const pcm = body % 2 === 0 ? new Int16Array(data, body, 2 * frames) : new Int16Array(data.slice(body, body + 4 * frames));
      const buf = ctx.createBuffer(2, frames, rate);
      const left = buf.getChannelData(0);
      const right = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        left[i] = pcm[2 * i] / 32768;
        right[i] = pcm[2 * i + 1] / 32768;
      }
      return buf;
    }
    pos = body + len + (len % 2);
  }
  return null;
}

export function createStemPlayer(onError: (e: unknown) => void = () => {}, deps: StemPlayerDeps = browserDeps()): StemPlayer {
  let ctx: AudioContext | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  let timer: Timer | null = null;
  let generation = 0; // invalidates slices still in flight for an earlier play()
  let disposed = false;
  let range: { start: number; end: number; t0: number | null } | null = null; // t0: context time of `start`

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

  function play(url: string, start: number, end: number) {
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
    const chunks = requestPlan(start, end);
    if (chunks.length === 0) return;
    const r = { start, end, t0: null as number | null };
    range = r;
    // One timeline: the first slice starts on a frame of the context, and slice k exactly as many frames later as the
    // stem frames before it (a whole number at 44.1 kHz, and at 48 / 88.2 / 96 kHz too, since slices are whole seconds).
    const rate = c.sampleRate > 0 ? c.sampleRate : RATE;
    const stemFrame0 = Math.round(chunks[0][0] * RATE);
    let frame0: number | null = null;

    const load = (k: number) => {
      timer = null;
      const [a, b] = chunks[k];
      deps
        .fetch(`${url}?start=${a}&end=${b}`)
        .then((res) => {
          if (!res.ok) throw new Error(`Stem request failed (HTTP ${res.status})`);
          return res.arrayBuffer();
        })
        .then((data) => {
          if (mine !== generation) return;
          const buf = pcm16ToBuffer(c, data);
          if (!buf) throw new Error("Stem slice is not 16-bit stereo PCM");
          frame0 ??= Math.ceil((c.currentTime + LEAD_SEC) * rate);
          r.t0 ??= frame0 / rate;
          const when = (frame0 + Math.round(((Math.round(a * RATE) - stemFrame0) / RATE) * rate)) / rate;
          const now = c.currentTime;
          // A slice wholly in the past (a stall longer than a slice) is skipped, so the rest stays in time; it used to
          // be left unstarted in `sources` until stop() (fb2 review M8).
          if (now - when < buf.duration) {
            const src = c.createBufferSource();
            src.buffer = buf;
            src.connect(c.destination);
            src.onended = () => void sources.delete(src);
            if (when >= now) src.start(when);
            else src.start(now, now - when); // late: join part-way in, in time
            sources.add(src);
          }
          if (k + 1 < chunks.length) timer = deps.setTimer(() => load(k + 1), Math.max(0, (when - c.currentTime) * 1000));
        })
        .catch((e) => {
          if (mine !== generation) return;
          stop();
          onError(e);
        });
    };
    load(0);
  }

  function unlock() {
    if (disposed) return;
    try {
      ctx ??= deps.createContext();
      void ctx.resume().catch(() => {});
    } catch {
      // play() tries again, and reports it
    }
  }

  function position(): number | null {
    if (!range || !ctx || range.t0 === null) return null;
    const t = range.start + Math.max(0, ctx.currentTime - range.t0);
    return t < range.end ? t : null;
  }

  function dispose() {
    disposed = true;
    stop();
    void ctx?.close().catch(() => {});
    ctx = null;
  }

  return { play, stop, position, dispose, unlock };
}
