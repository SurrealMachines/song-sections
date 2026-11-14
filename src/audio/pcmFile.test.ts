import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAiff, makeWav } from "../test/makeWav.js";
import { readPcmFile } from "./pcmFile.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcmfile-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FRAMES = 5000;
const sample = (ch: number, i: number) => 0.8 * Math.sin((i * (ch + 1) * 2 * Math.PI) / 97);

async function readAll(path: string, chunkFrames?: number) {
  const out: number[][] = [[], []];
  let chunks = 0;
  const info = await readPcmFile(
    path,
    (frames) => {
      chunks++;
      frames.forEach((c, ch) => out[ch].push(...c));
    },
    { chunkFrames },
  );
  return { out, info, chunks };
}

function expectMatches(out: number[][]) {
  for (let ch = 0; ch < 2; ch++) {
    expect(out[ch].length).toBe(FRAMES);
    for (let i = 0; i < FRAMES; i++) expect(Math.abs(out[ch][i] - sample(ch, i))).toBeLessThan(1 / 32768);
  }
}

describe("readPcmFile round trip", () => {
  const base = { sampleRate: 44100, channels: 2, frames: FRAMES, sample };
  const cases: [string, () => Promise<string>][] = [
    ["WAV 16", async () => { const p = join(dir, "a16.wav"); await makeWav(p, { ...base, bitDepth: 16 }); return p; }],
    ["WAV 24", async () => { const p = join(dir, "a24.wav"); await makeWav(p, { ...base, bitDepth: 24 }); return p; }],
    ["WAV 32 float", async () => { const p = join(dir, "af.wav"); await makeWav(p, { ...base, bitDepth: 32, float: true }); return p; }],
    ["WAV 32 int", async () => { const p = join(dir, "a32.wav"); await makeWav(p, { ...base, bitDepth: 32 }); return p; }],
    ["WAV 24 extensible", async () => { const p = join(dir, "ax.wav"); await makeWav(p, { ...base, bitDepth: 24, extensible: true }); return p; }],
    ["AIFF 16", async () => { const p = join(dir, "b16.aif"); await makeAiff(p, { ...base, bitDepth: 16 }); return p; }],
    ["AIFF 24", async () => { const p = join(dir, "b24.aif"); await makeAiff(p, { ...base, bitDepth: 24 }); return p; }],
  ];
  for (const [name, make] of cases) {
    it(name, async () => {
      const { out, info, chunks } = await readAll(await make(), 1024);
      expect(info).toEqual({ sampleRate: 44100, channels: 2, frames: FRAMES });
      expect(chunks).toBe(Math.ceil(FRAMES / 1024));
      expectMatches(out);
    });
  }

  it("parses 48 kHz AIFF sample rate", async () => {
    const p = join(dir, "r48.aif");
    await makeAiff(p, { ...base, sampleRate: 48000, bitDepth: 24 });
    expect((await readAll(p)).info.sampleRate).toBe(48000);
  });

  it("rejects compressed AIFC", async () => {
    const p = join(dir, "c.aif");
    const b = Buffer.alloc(12 + 8 + 24);
    b.write("FORM", 0, "ascii");
    b.write("AIFC", 8, "ascii");
    b.write("COMM", 12, "ascii");
    b.writeUInt32BE(24, 16);
    b.writeUInt16BE(2, 20); // channels
    b.writeUInt16BE(16, 26); // sample size
    b.write("ulaw", 38, "ascii"); // compression type
    await writeFile(p, b);
    await expect(readAll(p)).rejects.toThrow(/compress/i);
  });

  it("rejects non-audio files", async () => {
    const p = join(dir, "x.bin");
    await writeFile(p, Buffer.alloc(64));
    await expect(readAll(p)).rejects.toThrow();
  });
});
