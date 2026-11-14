// Dialog pacing and page diagnostics (LO6 A2: a Structure dialog that opened right after a 100 s progress dialog stayed
// blank for minutes; LO5: the progress dialog opened right after a cancelled one never showed). Both opened a Live
// dialog in the same tick as the previous one closed. The SDK resolves a progress dialog's close when Live answers
// close_progress_dialog, which need not mean the window is gone, so the flow leaves a short gap between dialogs and
// logs what each modal page did, so the next blank dialog is diagnosable from the host log.
// No Node imports: plain timers and Date only (the extension host has no performance or queueMicrotask).
import type { DialogPageStatus } from "./dialogServer.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Calls `fn` after `ms` unless the returned function is called first. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** The least time between one Live dialog closing and the next one opening. */
export const DIALOG_GAP_MS = 400;
/** How long a progress dialog waits, before it closes, for Live to answer the updates still in flight. */
export const UPDATE_FLUSH_MS = 1000;
/** A modal page that has not mounted this long after the dialog opened is logged as a likely blank dialog. */
export const PAGE_WATCHDOG_MS = 10_000;

export interface DialogPacer {
  /** Resolves once at least DIALOG_GAP_MS have passed since the last dialog closed (at once if none has). */
  beforeOpen(): Promise<void>;
  /** Marks that a dialog has just closed. */
  closed(): void;
}

export function dialogPacer(clock: Clock, gapMs = DIALOG_GAP_MS): DialogPacer {
  let closedAt: number | null = null;
  return {
    async beforeOpen() {
      if (closedAt === null) return;
      const wait = closedAt + gapMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
    },
    closed() {
      closedAt = clock.now();
    },
  };
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const since = (at: number, openedAt: number) => `+${Math.max(0, Math.round(at - openedAt))} ms`;

/** The watchdog's warning when the page has not mounted by now, or null when it has. */
export function pageStallMessage(label: string, s: DialogPageStatus, openedAt: number, now: number): string | null {
  if (s.readyAt !== null) return null;
  const after = `${Math.round((now - openedAt) / 1000)} s`;
  if (s.pageAt === null) {
    return `Song Sections: the ${label} dialog has not requested its page (${kb(s.pageBytes)}) ${after} after opening; Live is probably showing a blank dialog`;
  }
  return `Song Sections: the ${label} dialog requested its page at ${since(s.pageAt, openedAt)} but has not mounted ${after} after opening`;
}

/** One host-log line per modal dialog: how long it was open and when its page was requested and mounted. */
export function dialogSummary(label: string, s: DialogPageStatus, openedAt: number, closedAt: number): string {
  const open = `${((closedAt - openedAt) / 1000).toFixed(1)} s`;
  let page: string;
  if (s.pageAt === null) page = `page (${kb(s.pageBytes)}) never requested`;
  else {
    page = `page ${kb(s.pageBytes)} requested ${since(s.pageAt, openedAt)}, `;
    if (s.readyAt === null) page += "never mounted";
    else if (s.readyError !== null) page += `failed ${since(s.readyAt, openedAt)}: ${s.readyError}`;
    else page += `mounted ${since(s.readyAt, openedAt)}`;
  }
  return `Song Sections: ${label} dialog closed after ${open}; ${page}`;
}
