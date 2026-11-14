// Work that runs in the extension host with no dialog of its own (fb2: the Structure analysis runs while the Cue dialog
// is open). A dialog can watch its progress, and wait for it, without owning it: closing that dialog does not stop it.
// No Node imports; reads only `signal.aborted` unless the signal has addEventListener (the host has no AbortSignal API).

export type BackgroundState = "running" | "done" | "failed" | "aborted";

export interface BackgroundRun<T> {
  /** What it works on (the clip's audio hash), so a later run can tell whether it can join it. */
  readonly key: string;
  readonly state: BackgroundState;
  /** The last progress it reported. */
  readonly progress: { text: string; percent: number };
  /** Set once the state is "done". */
  readonly result: T | undefined;
  /** Set once the state is "failed". */
  readonly error: unknown;
  /** Resolves when the work has ended, whatever the outcome; never rejects. */
  readonly settled: Promise<void>;
  abort(): void;
  /** Calls `fn` with each progress report until the returned function is called. */
  watch(fn: (text: string, percent: number) => void): () => void;
}

/**
 * Starts `work` at once. It gets its own signal, a progress callback and `abort` (for work that finds it must stop,
 * such as an analysis that would need a download). A rejection after abort() counts as "aborted", not "failed".
 */
export function startBackground<T>(
  key: string,
  work: (signal: AbortSignal, report: (text: string, percent: number) => void, abort: () => void) => Promise<T>,
): BackgroundRun<T> {
  const controller = new AbortController();
  const watchers = new Set<(text: string, percent: number) => void>();
  let state: BackgroundState = "running";
  let progress = { text: "", percent: 0 };
  let result: T | undefined;
  let error: unknown;
  const abort = () => controller.abort();
  const report = (text: string, percent: number) => {
    if (state !== "running") return;
    progress = { text, percent };
    for (const fn of [...watchers]) {
      try {
        fn(text, percent);
      } catch {
        // a watcher's failure is its own
      }
    }
  };
  const settled = (async () => {
    try {
      result = await work(controller.signal, report, abort);
      state = controller.signal.aborted ? "aborted" : "done";
      if (state === "aborted") result = undefined;
    } catch (e) {
      state = controller.signal.aborted ? "aborted" : "failed";
      if (state === "failed") error = e;
    } finally {
      watchers.clear();
    }
  })();
  return {
    key,
    get state() {
      return state;
    },
    get progress() {
      return progress;
    },
    get result() {
      return result;
    },
    get error() {
      return error;
    },
    settled,
    abort,
    watch(fn) {
      watchers.add(fn);
      return () => void watchers.delete(fn);
    },
  };
}

/** How often a signal without addEventListener is checked. */
export const ABORT_POLL_MS = 250;

/** Resolves when `settled` resolves or `signal` is aborted, whichever is first. */
export function settledOrAborted(settled: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let cleanup = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const target = signal as unknown as { addEventListener?: unknown; removeEventListener?: unknown };
    if (typeof target.addEventListener === "function" && typeof target.removeEventListener === "function") {
      signal.addEventListener("abort", finish);
      cleanup = () => signal.removeEventListener("abort", finish);
    } else {
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        if (signal.aborted) finish();
        else timer = setTimeout(tick, ABORT_POLL_MS);
      };
      timer = setTimeout(tick, ABORT_POLL_MS);
      cleanup = () => clearTimeout(timer);
    }
    if (signal.aborted) finish();
    void settled.then(finish, finish);
  });
}
