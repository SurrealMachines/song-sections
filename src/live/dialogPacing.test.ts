import { describe, expect, it, vi } from "vitest";
import { DIALOG_GAP_MS, dialogPacer, dialogSummary, pageStallMessage, realClock, type Clock } from "./dialogPacing.js";
import type { DialogPageStatus } from "./dialogServer.js";

function fakeClock(start = 1000) {
  let now = start;
  const clock: Clock = {
    now: () => now,
    sleep: vi.fn(async (ms: number) => void (now += ms)),
    after: () => () => undefined,
  };
  return { clock, advance: (ms: number) => void (now += ms), now: () => now };
}

const status = (over: Partial<DialogPageStatus> = {}): DialogPageStatus => ({
  pageBytes: 2_048_000,
  pageAt: null,
  readyAt: null,
  readyError: null,
  ...over,
});

describe("dialogPacer", () => {
  it("opens the first dialog at once", async () => {
    const { clock } = fakeClock();
    await dialogPacer(clock).beforeOpen();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("waits out the rest of the gap after a dialog closed", async () => {
    const f = fakeClock();
    const pacer = dialogPacer(f.clock);
    pacer.closed();
    f.advance(150);
    await pacer.beforeOpen();
    expect(f.clock.sleep).toHaveBeenCalledWith(DIALOG_GAP_MS - 150);
  });

  it("does not wait when the gap has already passed", async () => {
    const f = fakeClock();
    const pacer = dialogPacer(f.clock, 400);
    pacer.closed();
    f.advance(400);
    await pacer.beforeOpen();
    expect(f.clock.sleep).not.toHaveBeenCalled();
  });

  it("the real clock's timers run and cancel", async () => {
    const before = realClock.now();
    await realClock.sleep(5);
    expect(realClock.now()).toBeGreaterThanOrEqual(before);
    const fired = vi.fn();
    realClock.after(1, fired)();
    const kept = vi.fn();
    realClock.after(1, kept);
    await realClock.sleep(20);
    expect(fired).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });
});

describe("pageStallMessage", () => {
  it("is null once the page has mounted", () => {
    expect(pageStallMessage("structure", status({ pageAt: 10, readyAt: 40 }), 0, 10_000)).toBeNull();
  });

  it("says the page was never requested (the LO6 blank dialog)", () => {
    expect(pageStallMessage("structure", status(), 0, 10_000)).toBe(
      "Song Sections: the structure dialog has not requested its page (2000 KB) 10 s after opening; Live is probably showing a blank dialog",
    );
  });

  it("says the page was requested but has not mounted", () => {
    expect(pageStallMessage("cue", status({ pageAt: 120 }), 0, 10_000)).toBe(
      "Song Sections: the cue dialog requested its page at +120 ms but has not mounted 10 s after opening",
    );
  });
});

describe("dialogSummary", () => {
  it("reports when the page was requested and mounted", () => {
    expect(dialogSummary("structure", status({ pageAt: 1085, readyAt: 1412 }), 1000, 33_100)).toBe(
      "Song Sections: structure dialog closed after 32.1 s; page 2000 KB requested +85 ms, mounted +412 ms",
    );
  });

  it("reports a page that was never requested or never mounted", () => {
    expect(dialogSummary("structure", status(), 0, 210_000)).toBe(
      "Song Sections: structure dialog closed after 210.0 s; page (2000 KB) never requested",
    );
    expect(dialogSummary("cue", status({ pageAt: 50 }), 0, 1000)).toBe(
      "Song Sections: cue dialog closed after 1.0 s; page 2000 KB requested +50 ms, never mounted",
    );
  });

  it("reports the error a page sent instead of mounting", () => {
    expect(dialogSummary("cue", status({ pageAt: 50, readyAt: 90, readyError: "Dialog payload missing" }), 0, 1000)).toBe(
      "Song Sections: cue dialog closed after 1.0 s; page 2000 KB requested +50 ms, failed +90 ms: Dialog payload missing",
    );
  });
});
