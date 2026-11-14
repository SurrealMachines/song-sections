import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { readPcmFile } from "./pcmFile.js";

export interface PreparedAudio {
  analysis: Float32Array;
  analysisRate: number; // mono, decimated by round(sampleRate / 11025)
  durationSec: number;
  waveform: { min: number[]; max: number[] }; // exactly WAVEFORM_BINS bins
  previewPath: string; // mono 16-bit PCM WAV, decimated by round(sampleRate / 22050)
  hash: string; // sha256 hex of the source's raw audio data bytes
}

const WAVEFORM_BINS = 2000;
const ANALYSIS_TARGET_RATE = 11025;
const PREVIEW_TARGET_RATE = 22050;

function toInt16(v: number): number {
  const c = Math.max(-1, Math.min(1, v));
  return Math.round(c < 0 ? c * 32768 : c * 32767);
}

function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/**
 * Streams a WAV/AIFF file once, producing a decimated mono analysis signal,
 * a min/max waveform overview and a decimated mono 16-bit WAV preview.
 * The hash covers the raw audio data region, fed from the same pass.
 */
export async function prepareAudio(srcPath: string, previewPath: string): Promise<PreparedAudio> {
  const hasher = createHash("sha256");
  const preview = await open(previewPath, "w");
  try {
    await preview.write(wavHeader(PREVIEW_TARGET_RATE, 0));

    let analysis = new Float32Array(0);
    let analysisRate = 0;
    let totalFrames = 0;
    let sampleRate = 0;
    let dA = 1;
    let dP = 1;
    let previewRate = 0;
    const wfMin = new Float32Array(WAVEFORM_BINS).fill(Infinity);
    const wfMax = new Float32Array(WAVEFORM_BINS).fill(-Infinity);

    // Streaming state carried across chunks.
    let frameIndex = 0;
    let aSum = 0;
    let aCount = 0;
    let aOut = 0;
    let pSum = 0;
    let pCount = 0;
    let previewBytes = 0;
    let previewBuf = Buffer.alloc(0);

    const info = await readPcmFile(
      srcPath,
      async (planes, channels) => {
        const n = planes[0].length;
        if (previewBuf.length < n * 2 + 4) previewBuf = Buffer.alloc(n * 2 + 4);
        let pOut = 0;
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let ch = 0; ch < channels; ch++) m += planes[ch][i];
          m /= channels;

          const bin = Math.min(WAVEFORM_BINS - 1, Math.floor((frameIndex * WAVEFORM_BINS) / totalFrames));
          if (m < wfMin[bin]) wfMin[bin] = m;
          if (m > wfMax[bin]) wfMax[bin] = m;

          aSum += m;
          if (++aCount === dA) {
            analysis[aOut++] = aSum / dA;
            aSum = 0;
            aCount = 0;
          }
          pSum += m;
          if (++pCount === dP) {
            previewBuf.writeInt16LE(toInt16(pSum / dP), pOut);
            pOut += 2;
            pSum = 0;
            pCount = 0;
          }
          frameIndex++;
        }
        if (pOut > 0) {
          await preview.write(previewBuf, 0, pOut);
          previewBytes += pOut;
        }
      },
      {
        onBytes: (raw) => void hasher.update(raw),
        onHeader: (h) => {
          sampleRate = h.sampleRate;
          totalFrames = Math.max(1, h.frames);
          dA = Math.max(1, Math.round(sampleRate / ANALYSIS_TARGET_RATE));
          dP = Math.max(1, Math.round(sampleRate / PREVIEW_TARGET_RATE));
          analysisRate = sampleRate / dA;
          previewRate = Math.round(sampleRate / dP);
          analysis = new Float32Array(Math.ceil(totalFrames / dA));
        },
      },
    );
    // Trailing partial blocks.
    if (aCount > 0) analysis[aOut++] = aSum / aCount;
    if (pCount > 0) {
      const b = Buffer.alloc(2);
      b.writeInt16LE(toInt16(pSum / pCount), 0);
      await preview.write(b);
      previewBytes += 2;
    }
    await preview.write(wavHeader(previewRate, previewBytes), 0, 44, 0);

    const waveform = {
      min: Array.from(wfMin, (v) => (Number.isFinite(v) ? v : 0)),
      max: Array.from(wfMax, (v) => (Number.isFinite(v) ? v : 0)),
    };
    return {
      analysis: aOut === analysis.length ? analysis : analysis.slice(0, aOut),
      analysisRate,
      durationSec: info.frames / info.sampleRate,
      waveform,
      previewPath,
      hash: hasher.digest("hex"),
    };
  } finally {
    await preview.close();
  }
}
