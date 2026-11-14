import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeAiff, makeWav } from "../../test/makeWav.js";
import { decodeForDemucs } from "./decode.js";

const dir = mkdtempSync(join(tmpdir(), "decode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const sine = (hz: number, rate: number) => (_c: number, i: number) => 0.4 * Math.sin((2 * Math.PI * hz * i) / rate);

describe("decodeForDemucs", () => {
  it("resamples a 2 s, 48 kHz, 24-bit stereo AIFF to 88200 frames per channel", async () => {
    const p = join(dir, "a.aif");
    await makeAiff(p, { sampleRate: 48000, channels: 2, bitDepth: 24, frames: 96000, sample: (c, i) => sine(c ? 660 : 440, 48000)(c, i) });
    const r = await decodeForDemucs(p, new AbortController().signal);
    expect(r.sourceRate).toBe(48000);
    expect(r.left).toHaveLength(88200);
    expect(r.right).toHaveLength(88200);
    // A 440 Hz tone stays a 440 Hz tone: check a mid-file zero crossing region has the right amplitude.
    let peak = 0;
    for (let i = 20000; i < 60000; i++) peak = Math.max(peak, Math.abs(r.left[i]));
    expect(peak).toBeGreaterThan(0.39);
    expect(peak).toBeLessThan(0.41);
  });

  it("duplicates a mono 44.1 kHz WAV to both channels, exactly", async () => {
    const p = join(dir, "m.wav");
    await makeWav(p, { sampleRate: 44100, channels: 1, bitDepth: 16, frames: 30000, sample: sine(440, 44100) });
    const r = await decodeForDemucs(p, new AbortController().signal);
    expect(r.sourceRate).toBe(44100);
    expect(r.left).toHaveLength(30000);
    expect(r.right).not.toBe(r.left);
    expect(r.right).toEqual(r.left);
  });

  it("uses the first two channels of a multichannel file", async () => {
    const p = join(dir, "q.wav");
    await makeWav(p, { sampleRate: 44100, channels: 4, bitDepth: 16, frames: 1000, sample: (c) => [0.1, -0.2, 0.3, 0.4][c] });
    const r = await decodeForDemucs(p, new AbortController().signal);
    expect(r.left[500]).toBeCloseTo(0.1, 3);
    expect(r.right[500]).toBeCloseTo(-0.2, 3);
  });

  it("rejects AbortError when aborted mid-decode", async () => {
    const p = join(dir, "long.wav");
    await makeWav(p, { sampleRate: 48000, channels: 2, bitDepth: 16, frames: 48000 * 5, sample: sine(440, 48000) });
    const ac = new AbortController();
    let chunks = 0;
    const err = await decodeForDemucs(p, ac.signal, () => {
      if (++chunks === 2) ac.abort();
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect(chunks).toBe(2);
  });

  it("rejects AbortError when aborted asynchronously between chunks", async () => {
    const p = join(dir, "long.wav");
    const ac = new AbortController();
    let chunks = 0;
    const err = await decodeForDemucs(p, ac.signal, () => {
      chunks++;
      if (chunks === 1) setTimeout(() => ac.abort(), 0);
    }).catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(chunks).toBeLessThan(4); // the file has 4 chunks; the pre-chunk check stops it early
  });

  it("rejects AbortError when already aborted", async () => {
    const p = join(dir, "m.wav");
    const ac = new AbortController();
    ac.abort();
    await expect(decodeForDemucs(p, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
