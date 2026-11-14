import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAiff, makeWav } from "../test/makeWav.js";
import { readPcmFile } from "./pcmFile.js";
import { frameAt, writeSlices } from "./slice.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "slice-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every frame's own value, so a slice shows exactly which source frames it holds (16-bit exact: i / 32768). */
const ramp = (ch: number, i: number) => ((i % 20000) - 10000 + ch) / 32768;

async function frames(path: string) {
  const out: number[][] = [];
  let rate = 0;
  await readPcmFile(
    path,
    (planes) => planes.forEach((p, c) => (out[c] ??= []).push(...p)),
    { onHeader: (h) => void (rate = h.sampleRate) },
  );
  return { out, rate };
}

describe("frameAt", () => {
  it("rounds to the nearest frame and stays inside the file", () => {
    expect(frameAt(1, 48000, 1e6)).toBe(48000);
    expect(frameAt(1.00001, 48000, 1e6)).toBe(48000);
    expect(frameAt(1.000011, 48000, 1e6)).toBe(48001);
    expect(frameAt(-1, 48000, 1e6)).toBe(0);
    expect(frameAt(100, 48000, 1e6)).toBe(1e6);
  });
});

describe("writeSlices", () => {
  it("cuts sample-accurately at the shared edges, with the last cut running to the file's end", async () => {
    const src = join(dir, "src.wav");
    const N = 30_001; // one frame more than 0.625 s at 48 kHz: the render is a little longer than the clip
    await makeWav(src, { sampleRate: 48000, channels: 2, bitDepth: 16, frames: N, sample: ramp });
    const edges = [0, 0.2, 0.41234, 0.625];
    const cuts = edges.slice(0, -1).map((a, i) => ({
      startSec: a,
      endSec: edges[i + 1],
      toEnd: i === edges.length - 2,
      path: join(dir, `s${i}.wav`),
    }));
    // Small chunks, so cuts straddle chunk edges.
    const r = await writeSlices(src, cuts, { chunkFrames: 4096 });
    expect(r).toMatchObject({ sampleRate: 48000, channels: 2, bits: 16 });
    expect(r.slices.map((s) => [s.startFrame, s.frames])).toEqual([
      [0, 9600],
      [9600, Math.round(0.41234 * 48000) - 9600],
      [Math.round(0.41234 * 48000), N - Math.round(0.41234 * 48000)],
    ]);
    // Together they are the source, frame for frame, in both channels.
    const whole: number[][] = [[], []];
    for (const c of cuts) {
      const f = await frames(c.path);
      expect(f.rate).toBe(48000);
      f.out.forEach((p, ch) => whole[ch].push(...p));
    }
    const orig = await frames(src);
    expect(whole[0]).toEqual(orig.out[0]);
    expect(whole[1]).toEqual(orig.out[1]);
  });

  it("copies a 24-bit AIFF render as 24-bit WAV exactly, keeping its rate", async () => {
    const src = join(dir, "render.aif");
    const s24 = (ch: number, i: number) => ((i * 977 + ch * 13) % 8_000_000 - 4_000_000) / 8388608;
    await makeAiff(src, { sampleRate: 44100, channels: 2, bitDepth: 24, frames: 10_000, sample: s24 });
    const out = join(dir, "r.wav");
    const r = await writeSlices(src, [{ startSec: 0.1, endSec: 0.2, path: out }]);
    expect(r.bits).toBe(24);
    const bytes = await readFile(out);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt16LE(34)).toBe(24);
    expect(bytes.readUInt32LE(24)).toBe(44100);
    expect((await stat(out)).size).toBe(44 + 4410 * 6);
    const f = await frames(out);
    const o = await frames(src);
    expect(f.out[0]).toEqual(o.out[0].slice(4410, 8820));
    expect(f.out[1]).toEqual(o.out[1].slice(4410, 8820));
  });

  it("writes overlapping and out-of-order cuts in the one pass", async () => {
    const src = join(dir, "mono.wav");
    await makeWav(src, { sampleRate: 1000, channels: 1, bitDepth: 16, frames: 1000, sample: ramp });
    const a = join(dir, "a.wav");
    const b = join(dir, "b.wav");
    await writeSlices(src, [
      { startSec: 0.5, endSec: 0.9, path: a },
      { startSec: 0.1, endSec: 0.6, path: b },
    ], { chunkFrames: 64 });
    const o = (await frames(src)).out[0];
    expect((await frames(a)).out[0]).toEqual(o.slice(500, 900));
    expect((await frames(b)).out[0]).toEqual(o.slice(100, 600));
  });

  it("writes a float source as 24-bit, to the nearest step, clamped at full scale (review M7)", async () => {
    const src = join(dir, "float.wav");
    const f32 = (ch: number, i: number) => (i === 0 ? 1 : i === 1 ? -1 : Math.sin(i / 7 + ch) * 0.9);
    await makeWav(src, { sampleRate: 48000, channels: 2, bitDepth: 32, float: true, frames: 2000, sample: f32 });
    const out = join(dir, "float-out.wav");
    const r = await writeSlices(src, [{ startSec: 0, endSec: 1, toEnd: true, path: out }]);
    expect(r.bits).toBe(24);
    expect(r.slices[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const o = (await frames(src)).out;
    const g = (await frames(out)).out;
    expect(g[0][0]).toBe(8388607 / 8388608); // +1.0 is the top step
    expect(g[0][1]).toBe(-1);
    for (let ch = 0; ch < 2; ch++) for (let i = 2; i < 2000; i++) expect(Math.abs(g[ch][i] - o[ch][i])).toBeLessThanOrEqual(0.5 / 8388608 + 1e-12);
  });

  it("hashes each slice's audio, the same for the same frames", async () => {
    const src = join(dir, "hash.wav");
    await makeWav(src, { sampleRate: 1000, channels: 1, bitDepth: 16, frames: 1000, sample: ramp });
    const r = await writeSlices(src, [
      { startSec: 0.1, endSec: 0.2, path: join(dir, "h1.wav") },
      { startSec: 0.1, endSec: 0.2, path: join(dir, "h2.wav") },
      { startSec: 0.1, endSec: 0.201, path: join(dir, "h3.wav") },
    ]);
    expect(r.slices[0].sha256).toBe(r.slices[1].sha256);
    expect(r.slices[2].sha256).not.toBe(r.slices[0].sha256);
  });

  it("refuses a cut with no audio before writing anything", async () => {
    const src = join(dir, "short.wav");
    await makeWav(src, { sampleRate: 1000, channels: 1, bitDepth: 16, frames: 1000, sample: ramp });
    const p = join(dir, "never.wav");
    await expect(writeSlices(src, [{ startSec: 1.2, endSec: 1.5, path: p }])).rejects.toThrow(/no audio/);
    await expect(stat(p)).rejects.toThrow();
  });
});
