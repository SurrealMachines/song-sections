import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AUDITION_RATE, pcm16Header } from "../structure/audition.js";
import { STEM_NAMES } from "../structure/contract.js";
import { STRUCTURE_PROGRESS_ROUTE, type StructureProgress } from "../dialog/protocol.js";
import type { HostActivity } from "../core/pace.js";
import { aboutLinkUrl, OPEN_LINK_ROUTE } from "../core/about.js";

/** What the dialog's page did, as times from `now()` (ms), so a blank dialog can be told apart from a slow one. */
export interface DialogPageStatus {
  /** Bytes of the page (the HTML with the payload inlined). */
  pageBytes: number;
  /** When the page was first requested, or null if it never was. */
  pageAt: number | null;
  /** When the page reported it had mounted (GET ready), or null. */
  readyAt: number | null;
  /** The error the page reported instead of mounting (GET ready?error=…), or null. */
  readyError: string | null;
}

export interface DialogServer {
  url: string;
  close(): Promise<void>;
  status(): DialogPageStatus;
}

/** The longest page error the server keeps; the page sends at most this much. */
export const READY_ERROR_MAX = 200;

/**
 * fb2 review I2: onReady waits, after the page has mounted, until its audio has been sent (the page fetches it as it
 * mounts, so that the first Play needs nothing from the host), but no longer than this.
 */
export const READY_AUDIO_WAIT_MS = 3000;

/** A query parameter, decoded, or null when absent; no URL class (the extension host has none). */
function queryParam(query: string, key: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== key) continue;
    const value = pair.slice(eq + 1).replace(/\+/g, " ");
    try {
      return decodeURIComponent(value);
    } catch {
      return value; // keep the raw text
    }
  }
  return null;
}

/** The `error` query parameter of a ready request. */
function readyError(query: string): string | null {
  return queryParam(query, "error")?.slice(0, READY_ERROR_MAX) ?? null;
}

const HEADER_BYTES = 44;

/** Frames of an audition stem (audition.ts's own 44-byte 16-bit stereo header), or null when it is not one. */
async function stemFrames(path: string): Promise<number | null> {
  const fh = await open(path, "r");
  try {
    const h = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(h, 0, HEADER_BYTES, 0);
    const ok =
      bytesRead === HEADER_BYTES &&
      h.toString("ascii", 0, 4) === "RIFF" &&
      h.toString("ascii", 8, 16) === "WAVEfmt " &&
      h.readUInt16LE(20) === 1 &&
      h.readUInt16LE(22) === 2 &&
      h.readUInt32LE(24) === AUDITION_RATE &&
      h.readUInt16LE(34) === 16 &&
      h.toString("ascii", 36, 40) === "data";
    if (!ok) return null;
    const size = (await fh.stat()).size;
    return Math.floor(Math.min(h.readUInt32LE(40), size - HEADER_BYTES) / 4);
  } finally {
    await fh.close();
  }
}

/**
 * One audition stem: the whole file, or with `start` and `end` (seconds) a complete WAV of just frames
 * [round(start × 44100), round(end × 44100)), clamped to the stem. A slice lets the dialog decode only what it plays: a
 * 30-minute stem is 318 MB of 16-bit and ~690 MB once decoded to float.
 */
async function serveStem(res: ServerResponse, path: string, query: string): Promise<void> {
  const start = queryParam(query, "start");
  const end = queryParam(query, "end");
  let frames: number | null;
  try {
    frames = await stemFrames(path);
  } catch {
    frames = null;
  }
  if (frames === null) {
    res.writeHead(404).end();
    return;
  }
  const send = (header: Buffer | null, from: number, to: number) => {
    const length = (header?.length ?? 0) + (to - from);
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": length, "Cache-Control": "no-store" });
    if (header) res.write(header);
    if (to <= from) return void res.end();
    createReadStream(path, { start: from, end: to - 1 })
      .on("error", () => res.destroy())
      .pipe(res);
  };
  if (start === null && end === null) return send(null, 0, HEADER_BYTES + 4 * frames);
  const a = Number(start ?? "x");
  const b = Number(end ?? "x");
  if (start === "" || end === "" || !Number.isFinite(a) || !Number.isFinite(b)) {
    res.writeHead(400).end();
    return;
  }
  const f0 = Math.min(frames, Math.max(0, Math.round(a * AUDITION_RATE)));
  const f1 = Math.min(frames, Math.max(f0, Math.round(b * AUDITION_RATE)));
  send(pcm16Header(f1 - f0), HEADER_BYTES + 4 * f0, HEADER_BYTES + 4 * f1);
}

/**
 * fb3, item 2: a slice of the preview (audio/prepare.ts: a 44-byte header, 16-bit PCM, mono at 22.05 or 24 kHz)
 * as a complete WAV in the preview's own format: frames [round(start × rate), round(end × rate)), clamped. A click
 * that comes before the whole preview has loaded plays its range from this.
 */
async function serveAudioSlice(res: ServerResponse, path: string, query: string): Promise<void> {
  let header: Buffer | null = null;
  let frames = 0;
  try {
    const fh = await open(path, "r");
    try {
      const h = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await fh.read(h, 0, HEADER_BYTES, 0);
      const channels = h.readUInt16LE(22);
      if (
        bytesRead === HEADER_BYTES &&
        h.toString("ascii", 0, 4) === "RIFF" &&
        h.toString("ascii", 8, 16) === "WAVEfmt " &&
        h.readUInt16LE(20) === 1 &&
        channels > 0 &&
        h.readUInt32LE(24) > 0 &&
        h.readUInt16LE(34) === 16 &&
        h.toString("ascii", 36, 40) === "data"
      ) {
        header = h;
        frames = Math.floor(Math.min(h.readUInt32LE(40), (await fh.stat()).size - HEADER_BYTES) / (2 * channels));
      }
    } finally {
      await fh.close();
    }
  } catch {
    header = null;
  }
  if (!header) {
    res.writeHead(404).end();
    return;
  }
  const start = queryParam(query, "start");
  const end = queryParam(query, "end");
  const a = Number(start ?? "x");
  const b = Number(end ?? "x");
  if (start === "" || end === "" || !Number.isFinite(a) || !Number.isFinite(b)) {
    res.writeHead(400).end();
    return;
  }
  const rate = header.readUInt32LE(24);
  const frameBytes = 2 * header.readUInt16LE(22);
  const f0 = Math.min(frames, Math.max(0, Math.round(a * rate)));
  const f1 = Math.min(frames, Math.max(f0, Math.round(b * rate)));
  const data = (f1 - f0) * frameBytes;
  const h = Buffer.from(header);
  h.writeUInt32LE(36 + data, 4);
  h.writeUInt32LE(data, 40);
  res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": HEADER_BYTES + data, "Cache-Control": "no-store" });
  res.write(h);
  if (data === 0) return void res.end();
  createReadStream(path, { start: HEADER_BYTES + f0 * frameBytes, end: HEADER_BYTES + f1 * frameBytes - 1 })
    .on("error", () => res.destroy())
    .pipe(res);
}

/**
 * Serves the dialog page and its audio file from 127.0.0.1 under a random token path. The page GETs `ready` once it
 * has mounted (bridge.ts signalReady); status() reports when the page was requested and when it was ready. It GETs
 * `alive` before it sends Apply or a mode switch (bridge.ts deliver): the server lives in the extension host, so an
 * answer means the host that opened the dialog is still there to receive the result. With `stemsDir`, the audition
 * stems are served next to the audio as `stems/<stem>.wav` (serveStem).
 *
 * fb2: `onReady` is called once, when the page first reports it has mounted (not when it reports an error), and its
 * audio has been sent or READY_AUDIO_WAIT_MS have passed. With `structureProgress`, GET `structure` answers with it as
 * JSON: the Cue page polls it for the background Structure analysis's progress (the only way to reach the page from
 * here, which has no channel of its own to the dialog); it answers "none" once the page has reported an error.
 *
 * fb2 review I1/I2: with `activity`, every request but those polls counts as foreground work from when it arrives
 * until its answer has been sent, so a background analysis gives way while the page loads, fetches audio or stems,
 * or checks `alive`.
 */
export async function serveDialog(opts: {
  html: string;
  audioPath: string;
  stemsDir?: string | null;
  now?: () => number;
  onReady?: () => void;
  structureProgress?: () => StructureProgress;
  activity?: HostActivity;
  /** READY_AUDIO_WAIT_MS, for tests. */
  readyAudioWaitMs?: number;
  /**
   * Opens a URL in the system browser (openUrl.ts). GET `open?to=<key>` calls it with that About link (core/about.ts):
   * 204 when it opened, 502 when it could not, 404 for any other key or without this option.
   */
  openUrl?: (url: string) => Promise<boolean>;
}): Promise<DialogServer> {
  const now = opts.now ?? Date.now;
  const token = randomBytes(16).toString("hex");
  const htmlPath = `/${token}/`;
  const audioRoute = `/${token}/audio.wav`;
  const readyRoute = `/${token}/ready`;
  const aliveRoute = `/${token}/alive`;
  const stemsRoute = `/${token}/stems/`;
  const progressRoute = `/${token}/${STRUCTURE_PROGRESS_ROUTE}`;
  const openRoute = `/${token}/${OPEN_LINK_ROUTE}`;
  const page = Buffer.from(opts.html, "utf8");
  const status: DialogPageStatus = { pageBytes: page.length, pageAt: null, readyAt: null, readyError: null };

  // onReady: once the page has mounted and its audio has gone out (or the wait is over), whichever is last.
  let mounted = false;
  let audioSent = false;
  let readyFired = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const fireReady = () => {
    if (readyFired || !mounted || !opts.onReady) return;
    readyFired = true;
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    try {
      opts.onReady();
    } catch {
      // the page is served either way
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const notFound = () => {
      res.writeHead(404).end();
    };
    if (req.method !== "GET") return notFound();
    const url = req.url ?? "";
    const q = url.indexOf("?");
    const path = q < 0 ? url : url.slice(0, q);
    if (opts.activity && path !== progressRoute) {
      const end = opts.activity.begin();
      res.once("close", end); // after the answer has been sent, or the connection has gone
    }
    if (path === htmlPath) {
      status.pageAt ??= now();
      // An explicit length (not chunked) and no caching: every dialog has its own token anyway.
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": page.length, "Cache-Control": "no-store" })
        .end(page);
    } else if (path === readyRoute) {
      const first = status.readyAt === null;
      if (first) {
        status.readyAt = now();
        status.readyError = q < 0 ? null : readyError(url.slice(q + 1));
      }
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
      if (first && status.readyError === null && opts.onReady) {
        mounted = true;
        if (audioSent) fireReady();
        else readyTimer = setTimeout(fireReady, opts.readyAudioWaitMs ?? READY_AUDIO_WAIT_MS);
      }
    } else if (path === aliveRoute) {
      // Feedback round 2: the page asks before Apply, so a dialog left open by a host that has gone (a dev-host
      // restart) says so instead of closing on a result nobody receives.
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
    } else if (path === progressRoute && opts.structureProgress) {
      let body: string;
      try {
        // A page that failed to mount never starts the analysis (onReady): it is not pending (fb2 review m2).
        body = JSON.stringify(status.readyError !== null ? ({ state: "none", percent: 0 } satisfies StructureProgress) : opts.structureProgress());
      } catch {
        body = JSON.stringify({ state: "none", percent: 0 } satisfies StructureProgress);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }).end(body);
    } else if (path === openRoute) {
      // Not URLSearchParams: Live runs the extension in a vm context that has no URL or URLSearchParams globals.
      const link = aboutLinkUrl(q < 0 ? "" : (queryParam(url.slice(q + 1), "to") ?? ""));
      const openUrl = opts.openUrl;
      if (!link || !openUrl) return notFound();
      const opened = await Promise.resolve()
        .then(() => openUrl(link))
        .catch(() => false);
      res.writeHead(opened ? 204 : 502, { "Cache-Control": "no-store" }).end();
    } else if (path === audioRoute) {
      if (q >= 0) return serveAudioSlice(res, opts.audioPath, url.slice(q + 1));
      try {
        const { size } = await stat(opts.audioPath);
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": size });
        res.once("close", () => {
          audioSent = true;
          fireReady();
        });
        createReadStream(opts.audioPath)
          .on("error", () => res.destroy())
          .pipe(res);
      } catch {
        audioSent = true; // there is none to wait for
        fireReady();
        notFound();
      }
    } else if (path.startsWith(stemsRoute)) {
      // Only the four names: nothing else under (or outside) the folder can be asked for.
      const file = path.slice(stemsRoute.length);
      if (!opts.stemsDir || !STEM_NAMES.some((s) => `${s}.wav` === file)) return notFound();
      await serveStem(res, join(opts.stemsDir, file), q < 0 ? "" : url.slice(q + 1));
    } else {
      notFound();
    }
  };
  // A route that throws must never reach the host: Live's extension host exits on an unhandled rejection.
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${htmlPath}`,
    status: () => ({ ...status }),
    close: () =>
      new Promise<void>((resolve) => {
        if (readyTimer !== undefined) clearTimeout(readyTimer);
        readyFired = true; // a closed dialog starts nothing
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
