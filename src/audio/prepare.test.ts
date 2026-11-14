import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeAiff, makeWav } from "../test/makeWav.js";
import { prepareAudio } from "./prepare.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "prepare-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sine = (ch: number, i: number) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100);

async function readHeader(path: string) {
  const fh = await open(path, "r");
  const b = Buffer.alloc(44);
  await fh.read(b, 0, 44, 0);
  await fh.close();
  return {
    riff: b.toString("ascii", 0, 4),
    tag: b.readUInt16LE(20),
    channels: b.readUInt16LE(22),
    rate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
    dataSize: b.readUInt32LE(40),
    riffSize: b.readUInt32LE(4),
  };
}

describe("prepareAudio", () => {
  it("prepares a 10 s 44.1 kHz stereo sine", async () => {
    const src = join(dir, "sine.wav");
    const prev = join(dir, "sine-prev.wav");
    await makeWav(src, { sampleRate: 44100, channels: 2, bitDepth: 16, frames: 441000, sample: sine });
    const r = await prepareAudio(src, prev);
    expect(r.durationSec).toBeCloseTo(10, 2);
    expect(r.analysisRate).toBe(11025);
    expect(Math.abs(r.analysis.length - 110250)).toBeLessThanOrEqual(1);
    expect(r.waveform.min.length).toBe(2000);
    expect(r.waveform.max.length).toBe(2000);
    expect(Math.max(...r.waveform.max)).toBeGreaterThan(0.45);
    expect(Math.min(...r.waveform.min)).toBeLessThan(-0.45);
    expect(r.previewPath).toBe(prev);
    const h = await readHeader(prev);
    expect(h).toMatchObject({ riff: "RIFF", tag: 1, channels: 1, rate: 22050, bits: 16 });
    expect(h.dataSize).toBeCloseTo(220500 * 2, -2);
    expect(h.riffSize).toBe(36 + h.dataSize);
  });

  it("gives the same hash for the same input and a different one otherwise", async () => {
    const a = join(dir, "h1.wav");
    const b = join(dir, "h2.wav");
    const c = join(dir, "h3.wav");
    await makeWav(a, { sampleRate: 44100, channels: 1, bitDepth: 16, frames: 4410, sample: sine });
    await makeWav(b, { sampleRate: 44100, channels: 1, bitDepth: 16, frames: 4410, sample: sine });
    await makeWav(c, { sampleRate: 44100, channels: 1, bitDepth: 16, frames: 4410, sample: (ch, i) => sine(ch, i) / 2 });
    const [ra, ra2, rb, rc] = [
      await prepareAudio(a, join(dir, "p1.wav")),
      await prepareAudio(a, join(dir, "p2.wav")),
      await prepareAudio(b, join(dir, "p3.wav")),
      await prepareAudio(c, join(dir, "p4.wav")),
    ];
    expect(ra.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ra2.hash).toBe(ra.hash);
    expect(rb.hash).toBe(ra.hash);
    expect(rc.hash).not.toBe(ra.hash);
  });

  it("rejects cleanly on a missing source without an unhandled rejection", async () => {
    const spy = vi.fn();
    process.on("unhandledRejection", spy);
    try {
      await expect(prepareAudio(join(dir, "nope.wav"), join(dir, "nope-prev.wav"))).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", spy);
    }
  });

  it("accepts AIFF input (24-bit, 48 kHz) and still writes a mono WAV preview", async () => {
    const src = join(dir, "r.aif");
    const prev = join(dir, "r-prev.wav");
    await makeAiff(src, { sampleRate: 48000, channels: 2, bitDepth: 24, frames: 48000 * 2, sample: sine });
    const r = await prepareAudio(src, prev);
    expect(r.durationSec).toBeCloseTo(2, 3);
    expect(r.analysisRate).toBe(12000); // 48000 / round(48000/11025)
    const h = await readHeader(prev);
    expect(h).toMatchObject({ channels: 1, bits: 16, rate: 24000 });
  });

  it(
    "streams a 60-minute 48 kHz stereo 16-bit file in under 400 MB of extra RSS",
    async () => {
      const src = join(dir, "long.wav");
      const frames = 48000 * 3600;
      await makeWav(src, {
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
        frames,
        blockFrames: 480000,
        sample: (ch, i) => 0.3 * Math.sin((i % 4800) * 2 * Math.PI / 4800),
      });
      const before = process.memoryUsage().rss;
      let peak = before;
      const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
      try {
        const r = await prepareAudio(src, join(dir, "long-prev.wav"));
        expect(r.durationSec).toBeCloseTo(3600, 1);
      } finally {
        clearInterval(timer);
        await rm(src, { force: true });
      }
      peak = Math.max(peak, process.memoryUsage().rss);
      expect(peak - before).toBeLessThan(400 * 1024 * 1024);
    },
    600_000,
  );
});
