import { describe, expect, it, vi } from "vitest";
import { abortError, throwIfAborted, yieldToHost } from "./abort.js";
import { settledOrAborted, startBackground } from "./background.js";

describe("startBackground", () => {
  it("runs at once, reports progress to watchers and keeps the result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = startBackground("k", async (_signal, report) => {
      report("half", 50);
      await gate;
      report("all", 100);
      return 42;
    });
    expect(run.key).toBe("k");
    expect(run.state).toBe("running");
    expect(run.progress).toEqual({ text: "half", percent: 50 });
    const seen: number[] = [];
    run.watch((_t, p) => seen.push(p));
    release();
    await run.settled;
    expect(seen).toEqual([100]);
    expect(run.state).toBe("done");
    expect(run.result).toBe(42);
  });

  it("a rejection is kept as the error and settles without rejecting", async () => {
    const boom = new Error("boom");
    const run = startBackground("k", async () => {
      throw boom;
    });
    await expect(run.settled).resolves.toBeUndefined();
    expect(run.state).toBe("failed");
    expect(run.error).toBe(boom);
    expect(run.result).toBeUndefined();
  });

  it("abort() makes the work's rejection an abort, not a failure; so does the work's own abort", async () => {
    const run = startBackground("k", async (signal) => {
      for (;;) {
        await yieldToHost();
        throwIfAborted(signal);
      }
    });
    run.abort();
    await run.settled;
    expect(run.state).toBe("aborted");
    expect(run.error).toBeUndefined();

    const own = startBackground("k", async (signal, _report, abort) => {
      abort();
      throwIfAborted(signal);
    });
    await own.settled;
    expect(own.state).toBe("aborted");
  });

  it("an unwatched watcher gets nothing more, and a throwing one does not stop the work", async () => {
    let step!: (n: number) => void;
    const run = startBackground("k", (_s, report) => new Promise<number>((resolve) => (step = (n) => (n < 100 ? report("x", n) : resolve(n)))));
    const a = vi.fn();
    const stop = run.watch(a);
    run.watch(() => {
      throw new Error("watcher");
    });
    step(10);
    stop();
    step(20);
    step(100);
    await run.settled;
    expect(a.mock.calls).toEqual([["x", 10]]);
    expect(run.state).toBe("done");
  });
});

describe("settledOrAborted", () => {
  it("resolves on the settle or on the abort, whichever is first", async () => {
    const ac = new AbortController();
    const never = new Promise<void>(() => undefined);
    const waiting = settledOrAborted(never, ac.signal);
    ac.abort();
    await expect(waiting).resolves.toBeUndefined();
    await expect(settledOrAborted(Promise.resolve(), new AbortController().signal)).resolves.toBeUndefined();
  });

  it("polls a signal that has no addEventListener (Live's extension host)", async () => {
    vi.useFakeTimers();
    try {
      const signal = { aborted: false } as unknown as AbortSignal;
      let done = false;
      void settledOrAborted(new Promise<void>(() => undefined), signal).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(600);
      expect(done).toBe(false);
      (signal as { aborted: boolean }).aborted = true;
      await vi.advanceTimersByTimeAsync(300);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an already aborted signal resolves at once", async () => {
    const ac = new AbortController();
    ac.abort(abortError());
    await expect(settledOrAborted(new Promise<void>(() => undefined), ac.signal)).resolves.toBeUndefined();
  });
});
