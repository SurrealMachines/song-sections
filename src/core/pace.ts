// How long-running work shares the extension host's one JS thread (fb2 review I1, I2). The host has no Worker, so a
// Structure analysis runs on the thread that also answers Live, serves the dialog's page and audio, and answers the
// page's `alive` check. In the foreground (a progress dialog the user watches) it only yields between slices, as
// before. In the background it gives way: slices are cut finer, it rests after each one in proportion to how long it
// ran, and it stops at its next yield while the host has foreground work in flight (a Live call, a dialog request).
// No Node imports; plain timers and Date only (the host has no performance, setImmediate or queueMicrotask).
import { yieldToHost } from "./abort.js";

/** How a piece of work yields to the host between its slices. */
export interface Pace {
  /**
   * Yields between two slices of work. Resolves early once `signal` is aborted; the caller checks the signal, as it
   * does after any yield.
   */
  yield(signal?: { aborted: boolean }): Promise<void>;
  /** The size of one slice of work, given its foreground size. A finer cut is the same work: results do not change. */
  slice(n: number): number;
}

/** The foreground: one event-loop turn between slices, slices as they are. */
export const FOREGROUND: Pace = { yield: () => yieldToHost(), slice: (n) => n };

/** Foreground work in flight in the host, which background work gives way to. */
export interface HostActivity {
  /** Marks work as in flight until the returned function is called (calling it again does nothing). */
  begin(): () => void;
  /** True while any work is in flight, and for the quiet time after the last of it ended. */
  busy(): boolean;
}

/**
 * How long background work keeps giving way after the last foreground work ended. Long enough to cover the gaps in a
 * burst: the page's `alive` answer, Live closing the dialog and the flow starting Apply; Live's answer to one call and
 * the flow's next call.
 */
export const QUIET_MS = 750;

export function hostActivity(opts: { quietMs?: number; now?: () => number } = {}): HostActivity {
  const quietMs = opts.quietMs ?? QUIET_MS;
  const now = opts.now ?? Date.now;
  let inFlight = 0;
  let endedAt = -Infinity;
  return {
    begin() {
      inFlight++;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        inFlight--;
        endedAt = now();
      };
    },
    busy: () => inFlight > 0 || now() - endedAt < quietMs,
  };
}

/** Background slices are this many times finer than the foreground's (~80 ms at most there; ~10 ms here). */
export const BACKGROUND_SLICE_DIVISOR = 8;
/** After a slice, background work rests this fraction of the time the slice took, … */
export const BACKGROUND_REST_RATIO = 0.25;
/** … at least this long (ms), so every yield lets timers and I/O run, … */
export const BACKGROUND_MIN_REST_MS = 1;
/** … and at most this long (ms): after a 1–4 s ORT run, which cannot be split, it rests this long. */
export const BACKGROUND_MAX_REST_MS = 150;
/** How often background work that gives way checks whether the host is quiet again (ms). */
export const BACKGROUND_POLL_MS = 25;

export interface BackgroundPaceStats {
  /** Slices run (yields taken). */
  slices: number;
  /** The longest time between two yields (ms): a slice of ours, or an ORT run. */
  longestSliceMs: number;
  /** Time spent resting after slices (ms). */
  restMs: number;
  /** Time spent stopped while the host had foreground work (ms). */
  pausedMs: number;
}

export interface BackgroundPace extends Pace {
  /**
   * Someone now waits for this work (a progress dialog attached to it): it runs as in the foreground until the
   * returned function is called. Counted, so two attachments need two detaches.
   */
  attach(): () => void;
  stats(): BackgroundPaceStats;
}

export interface BackgroundPaceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  sliceDivisor?: number;
  restRatio?: number;
  minRestMs?: number;
  maxRestMs?: number;
  pollMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A Pace for work that runs while the user does something else; see the file comment. */
export function backgroundPace(activity: HostActivity, opts: BackgroundPaceOptions = {}): BackgroundPace {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const divisor = opts.sliceDivisor ?? BACKGROUND_SLICE_DIVISOR;
  const restRatio = opts.restRatio ?? BACKGROUND_REST_RATIO;
  const minRest = opts.minRestMs ?? BACKGROUND_MIN_REST_MS;
  const maxRest = opts.maxRestMs ?? BACKGROUND_MAX_REST_MS;
  const pollMs = opts.pollMs ?? BACKGROUND_POLL_MS;
  let attached = 0;
  let resumedAt: number | null = null; // when the slice now running began
  const stats: BackgroundPaceStats = { slices: 0, longestSliceMs: 0, restMs: 0, pausedMs: 0 };

  return {
    async yield(signal) {
      const t0 = now();
      const ran = resumedAt === null ? 0 : t0 - resumedAt;
      stats.slices++;
      if (ran > stats.longestSliceMs) stats.longestSliceMs = ran;
      if (attached > 0) {
        await yieldToHost();
      } else {
        await sleep(Math.min(maxRest, Math.max(minRest, ran * restRatio)));
        const t1 = now();
        stats.restMs += t1 - t0;
        while (attached === 0 && !signal?.aborted && activity.busy()) await sleep(pollMs);
        stats.pausedMs += now() - t1;
      }
      resumedAt = now();
    },
    slice: (n) => (attached > 0 ? n : Math.max(1, Math.floor(n / divisor))),
    attach() {
      attached++;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        attached--;
      };
    },
    stats: () => ({ ...stats }),
  };
}
