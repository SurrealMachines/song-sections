import { describe, expect, it } from "vitest";
import { BACKGROUND_MAX_REST_MS, FOREGROUND, backgroundPace, hostActivity } from "./pace.js";

/** A fake clock: sleep advances time at once and records how long it was asked to sleep. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("hostActivity", () => {
  it("is busy while work is in flight and for the quiet time after the last of it", () => {
    const c = clock();
    const a = hostActivity({ quietMs: 100, now: c.now });
    expect(a.busy()).toBe(false);
    const one = a.begin();
    const two = a.begin();
    c.advance(1000);
    one();
    one(); // counted once
    expect(a.busy()).toBe(true); // two is still in flight
    two();
    c.advance(99);
    expect(a.busy()).toBe(true);
    c.advance(1);
    expect(a.busy()).toBe(false);
  });
});

describe("FOREGROUND", () => {
  it("keeps slices as they are", () => {
    expect(FOREGROUND.slice(1 << 22)).toBe(1 << 22);
  });
});

describe("backgroundPace", () => {
  it("cuts slices finer, never below one", () => {
    const p = backgroundPace(hostActivity(), { sliceDivisor: 8 });
    expect(p.slice(8000)).toBe(1000);
    expect(p.slice(3)).toBe(1);
  });

  it("rests after each slice in proportion to how long it ran, within its bounds", async () => {
    const c = clock();
    const p = backgroundPace(hostActivity({ now: c.now }), { now: c.now, sleep: c.sleep, restRatio: 0.25, minRestMs: 1, maxRestMs: 150 });
    await p.yield(); // the first slice's length is unknown
    c.advance(40); // a 40 ms slice
    await p.yield();
    c.advance(3300); // a fold's ORT run
    await p.yield();
    expect(c.sleeps).toEqual([1, 10, BACKGROUND_MAX_REST_MS]);
    expect(p.stats()).toMatchObject({ slices: 3, longestSliceMs: 3300, pausedMs: 0 });
  });

  it("stops at a yield while the host has foreground work, until it has been quiet", async () => {
    const c = clock();
    const activity = hostActivity({ quietMs: 100, now: c.now });
    const end = activity.begin();
    const polls: number[] = [];
    const pace = backgroundPace(activity, {
      now: c.now,
      minRestMs: 1,
      pollMs: 25,
      sleep: async (ms) => {
        if (ms === 25) {
          polls.push(c.now());
          if (polls.length === 4) end(); // the foreground work ends while it waits (at t = 76)
        }
        await c.sleep(ms);
      },
    });
    await pace.yield();
    expect(polls).toEqual([1, 26, 51, 76, 101, 126, 151]); // then 100 ms of quiet have passed
    expect(c.now()).toBe(176);
    expect(pace.stats()).toMatchObject({ restMs: 1, pausedMs: 175 });
  });

  it("an abort ends the wait at once", async () => {
    const c = clock();
    const activity = hostActivity({ now: c.now });
    activity.begin(); // never ends
    const signal = { aborted: false };
    let polls = 0;
    const pace = backgroundPace(activity, {
      now: c.now,
      sleep: async (ms) => {
        if (++polls === 3) signal.aborted = true;
        await c.sleep(ms);
      },
    });
    await pace.yield(signal);
    expect(polls).toBe(3);
  });

  it("runs as in the foreground while attached: no rest, no stop, whole slices", async () => {
    const c = clock();
    const activity = hostActivity({ now: c.now });
    const end = activity.begin();
    const pace = backgroundPace(activity, { now: c.now, sleep: c.sleep, sliceDivisor: 8 });
    const detach = pace.attach();
    expect(pace.slice(8000)).toBe(8000);
    await pace.yield();
    c.advance(500);
    await pace.yield();
    expect(c.sleeps).toEqual([]);
    detach();
    detach(); // counted once
    expect(pace.slice(8000)).toBe(1000);
    end();
  });
});
