// Hands the dialog's result to the extension and closes the dialog (the host's close_and_send bridge).
// No Node imports: the dialog bundles this file.
import { STRUCTURE_PROGRESS_ROUTE, type DialogResult, type StructureProgress } from "./protocol.js";

type Bridge = { postMessage(message: unknown): void };
type Host = { webkit?: { messageHandlers?: { live?: Bridge } }; chrome?: { webview?: Bridge } };

export function closeWith(result: DialogResult): void {
  const w = window as unknown as Host; // read on use, so Node tests can import the messages below
  const message = { method: "close_and_send", params: [JSON.stringify(result)] };
  (w.webkit?.messageHandlers?.live ?? w.chrome?.webview)?.postMessage(message);
}

/**
 * Tells the extension the page has mounted (or why it could not), for the host log: GET `ready` next to the page,
 * which the dialog server records (dialogServer.ts). Best effort: a page opened from a file (dialog:preview) or a test
 * without fetch just skips it.
 */
export function signalReady(error?: string): void {
  if (typeof fetch !== "function") return;
  const query = error === undefined ? "" : "?error=" + encodeURIComponent(error.slice(0, 200));
  try {
    void fetch("ready" + query, { cache: "no-store" }).catch(() => undefined);
  } catch {
    // a relative URL may not resolve (about:blank, data:)
  }
}

/** Shown, with the dialog left open, when Apply or a mode switch finds the extension gone (feedback round 2). */
export const LOST_CONNECTION =
  "Song Sections lost its connection to Live, so your edits were not applied. Cancel closes this dialog; run Song Sections again to start over.";

/** Shown, with the dialog frozen, while Apply, a mode switch or Re-analyze waits for the host's answer (fb2 review I3). */
export const CHECKING_CONNECTION = "Checking the connection to Live…";

/**
 * How long the page waits for the host's answer before it treats the host as gone. 10 s (fb2 review I3, was 3 s): a
 * busy host (the A2 incident had the VM at 200 % CPU) can take seconds, and a false "lost" costs the user their edits.
 */
export const ALIVE_TIMEOUT_MS = 10_000;

/**
 * Controller ruling on fb2 review I3 (int3): an ok answer from the host this recent stands in for a new `alive`
 * request, so Apply, a mode switch or Re-analyze does not wait behind one ORT run (up to about 3.3 s) in a busy host
 * that has just shown it is there. A host that has gone stops answering, so its last answer ages past this and the
 * check runs as before. The cost: a host that dies within this window of its last answer is not caught.
 */
export const HOST_FRESH_MS = 2000;

let lastHostAnswer: number | null = null;

/** Whether `url` is served by the page's own host (not a data: or blob: URL, nor another origin). */
function fromHost(url: string): boolean {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** Records an ok answer from the host to a request for `url` (ignored when another server answered it). */
export function noteHostAnswer(url: string): void {
  if (fromHost(url)) lastHostAnswer = Date.now();
}

/** Whether the host answered ok within the last `ms`. */
export function hostAnsweredWithin(ms = HOST_FRESH_MS): boolean {
  return lastHostAnswer !== null && Date.now() - lastHostAnswer <= ms;
}

/** Forgets the last answer (tests: every page starts with none). */
export function resetHostAnswer(): void {
  lastHostAnswer = null;
}

/** fetch, recording an ok answer from the host (noteHostAnswer). The structure poll and the alive check use it. */
export async function hostFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (r.ok) noteHostAnswer(url);
  return r;
}

/**
 * hostFetch for the audio and stem players' deps: records the answer when it arrives, and again when its body has
 * been read in full (a long body is the host answering until its last byte).
 */
export async function hostFetchBytes(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }> {
  const r = await hostFetch(url);
  return {
    ok: r.ok,
    status: r.status,
    arrayBuffer: async () => {
      const b = await r.arrayBuffer();
      if (r.ok) noteHostAnswer(url);
      return b;
    },
  };
}

/**
 * True when the extension that opened this dialog still answers: GET `alive` next to the page (dialogServer.ts), which
 * the extension host serves. Live closes the dialog on close_and_send whether or not anything receives the result, so
 * a dialog left open by a host that went away (a dev-host restart) would close on an Apply that does nothing.
 * A page not served over http (dialog:preview opens a file) has no host to ask, and counts as connected.
 */
export async function hostAlive(timeoutMs = ALIVE_TIMEOUT_MS): Promise<boolean> {
  if (typeof fetch !== "function" || !/^https?:$/.test(location.protocol)) return true;
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ac?.abort(), timeoutMs);
  try {
    const r = await hostFetch("alive", { cache: "no-store", signal: ac?.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks that the host is still there to receive a result, then sends the one `make` builds and closes the dialog.
 * The result is built only once the host has answered (fb2 review I3), so it is what the dialog shows then; the page
 * stays frozen meanwhile. Resolves false, with nothing sent and the dialog still open, when the host is gone; the page
 * then shows LOST_CONNECTION. A cancel has nothing to lose: send it with closeWith, without asking.
 *
 * When the host answered ok within HOST_FRESH_MS (the structure poll, an alive check, an audio or stem fetch), that
 * answer is the check: no new `alive` request, and the result goes at once (controller ruling, int3).
 */
export async function deliver(make: () => DialogResult): Promise<boolean> {
  if (!hostAnsweredWithin() && !(await hostAlive())) return false;
  closeWith(make());
  return true;
}

/** How often the Cue view asks for the background Structure analysis's progress (fb2). */
export const STRUCTURE_POLL_MS = 500;
/** Polls that fail in a row (no answer at all) before the page gives up on the progress (fb2 review m2). */
export const STRUCTURE_POLL_FAILURES = 5;

const NO_PROGRESS: StructureProgress = { state: "none", percent: 0 };

/**
 * fb2: GETs STRUCTURE_PROGRESS_ROUTE now and every STRUCTURE_POLL_MS while the background Structure analysis is pending
 * or running, passing each answer to `onProgress`. The extension cannot push to the dialog, so the page asks; the
 * dialog server answers from the host. Stops when the analysis has ended, or when the returned function is called.
 * A page not served over http (dialog:preview) has no host and never polls.
 *
 * fb2 review m2: a poll that gets no answer (the host was busy past the web view's timeout) is tried again, at twice
 * the interval; after STRUCTURE_POLL_FAILURES in a row, or an answer that is not ok (no such route), the page stops
 * and reports "none", so the tab reads plain "Structure" rather than a percentage frozen where it was.
 */
export function pollStructure(onProgress: (p: StructureProgress) => void, intervalMs = STRUCTURE_POLL_MS): () => void {
  if (typeof fetch !== "function" || !/^https?:$/.test(location.protocol)) return () => undefined;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    let p: StructureProgress;
    try {
      const r = await hostFetch(STRUCTURE_PROGRESS_ROUTE, { cache: "no-store" });
      p = r.ok ? ((await r.json()) as StructureProgress) : NO_PROGRESS;
    } catch {
      if (stopped) return;
      if (++failures >= STRUCTURE_POLL_FAILURES) return onProgress(NO_PROGRESS);
      timer = setTimeout(() => void poll(), 2 * intervalMs);
      return;
    }
    if (stopped) return;
    failures = 0;
    onProgress(p);
    if (p.state === "pending" || p.state === "running") timer = setTimeout(() => void poll(), intervalMs);
  };
  void poll();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
