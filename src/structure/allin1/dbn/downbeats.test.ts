import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../test/golden.js";
import { readNpy } from "../../../test/npy.js";
import { decodeDownbeats, trackDownbeats } from "./downbeats.js";
import { activationsOf, synthetic } from "./fixtures.js";

describe("decodeDownbeats equals madmom's DBNDownBeatTrackingProcessor on synthetic activations", () => {
  for (const c of synthetic.cases) {
    it(`${c.name}: ${c.beats.length} beats`, async () => {
      const got = await decodeDownbeats(activationsOf(c), c.frames);
      expect(got.positions).toEqual(c.positions);
      expect(got.beats).toHaveLength(c.beats.length);
      got.beats.forEach((b, i) => expect(Math.abs(b - c.beats[i])).toBeLessThanOrEqual(1e-9));
    });
  }

  it("the 4/4 case decodes as 4/4 and the 3/4 case as 3/4", () => {
    expect(Math.max(...synthetic.cases.find((c) => c.name === "120bpm_4_4")!.positions)).toBe(4);
    expect(Math.max(...synthetic.cases.find((c) => c.name === "140bpm_3_4")!.positions)).toBe(3);
  });

  it("reproduces madmom's idx.any() quirk: only frame 0 over the threshold gives no beats", async () => {
    const act = new Float32Array(600).fill(0.01);
    act[0] = 0.5;
    expect(await decodeDownbeats(act, 300)).toEqual({ beats: [], positions: [] });
    act[2] = 0.5; // frame 1 as well: now the crop is [0, 2) and decoding runs
    const r = await decodeDownbeats(act, 300);
    expect(r.beats.length).toBeGreaterThan(0);
  });

  it("returns no beats for no frames", async () => {
    expect(await decodeDownbeats(new Float32Array(0), 0)).toEqual({ beats: [], positions: [] });
    expect(await trackDownbeats(new Float32Array(0), new Float32Array(0))).toEqual({ beats: [], positions: [] });
  });

  it("rejects with AbortError when aborted", async () => {
    const c = synthetic.cases[0];
    const ac = new AbortController();
    ac.abort();
    await expect(decodeDownbeats(activationsOf(c), c.frames, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

const beat = readNpy(`${FIXTURES}/flim_logits_beat.npy`).data as Float32Array;
const downbeat = readNpy(`${FIXTURES}/flim_logits_downbeat.npy`).data as Float32Array;
const post = JSON.parse(readFileSync(`${FIXTURES}/flim_post.json`, "utf8")) as { beats: number[]; beat_positions: number[]; downbeats: number[] };

describe("trackDownbeats on the Flim golden (madmom 0.16.1 via allin1)", () => {
  it("gives exactly madmom's 328 beats and positions", async () => {
    const got = await trackDownbeats(beat, downbeat);
    expect(post.beats).toHaveLength(328);
    expect(got.positions).toEqual(post.beat_positions);
    expect(got.beats).toEqual(post.beats);
    expect(got.beats.filter((_, i) => got.positions[i] === 1)).toEqual(post.downbeats);
  }, 60_000);
});

describe.skipIf(!process.env.SONG_SECTIONS_PERF)("trackDownbeats speed", () => {
  it("decodes Flim (~3 min) in under 8 s", async () => {
    const t0 = Date.now();
    await trackDownbeats(beat, downbeat);
    const ms = Date.now() - t0;
    console.log(`trackDownbeats on Flim: ${ms} ms`);
    expect(ms).toBeLessThan(8000);
  }, 60_000);
});

describe.skipIf(!process.env.SONG_SECTIONS_PERF)("trackDownbeats on a 20-minute input (Review Focus 5)", () => {
  it("stays bounded in memory and yields to the host", async () => {
    // 120 bpm, 4/4, 20 min of logits: beat logit +2 on beats, downbeat logit +2 on every 4th, -4 elsewhere.
    const T = 20 * 60 * 100;
    const b = new Float32Array(T).fill(-4);
    const d = new Float32Array(T).fill(-4);
    for (let k = 0; 50 * k + 13 < T; k++) {
      b[50 * k + 13] = 2;
      if (k % 4 === 0) d[50 * k + 13] = 2;
    }
    const base = process.memoryUsage();
    let peakAb = 0;
    let peakRss = 0;
    let samples = 0;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peakAb = Math.max(peakAb, m.arrayBuffers - base.arrayBuffers);
      peakRss = Math.max(peakRss, m.rss - base.rss);
      samples++;
    }, 20);
    const t0 = Date.now();
    const r = await trackDownbeats(b, d);
    clearInterval(timer);
    const ms = Date.now() - t0;
    console.log(`20 min: ${r.beats.length} beats in ${ms} ms; peak +${(peakAb / 2 ** 20).toFixed(1)} MB array buffers, +${(peakRss / 2 ** 20).toFixed(1)} MB RSS (${samples} samples)`);
    // a quarter-note or half-time reading of the impulses are both fine here; this test is about memory
    expect(r.beats.length).toBeGreaterThan(1000);
    for (let i = 1; i < r.beats.length; i++) expect(r.beats[i]).toBeGreaterThan(r.beats[i - 1]);
    expect(samples).toBeGreaterThan(10); // the timer ran during the decode, so it yielded
    expect(peakAb).toBeLessThan(128 * 2 ** 20);
  }, 600_000);
});
