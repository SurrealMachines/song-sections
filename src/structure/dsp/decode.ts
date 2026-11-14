import { readPcmFile } from "../../audio/pcmFile.js";
import { createResampler } from "./resample.js";
import { abortError } from "../../core/abort.js";

export const DEMUCS_RATE = 44100;

/**
 * Decode a WAV/AIFF file to 44.1 kHz stereo float, resampling while streaming so the
 * source-rate audio is never held whole. Mono is duplicated; >2 channels use the first two.
 * `onChunk(fraction)` runs after each decoded chunk (progress; tests also use it to abort).
 */
export async function decodeForDemucs(
  path: string,
  signal: AbortSignal,
  onChunk?: (fraction: number) => void,
): Promise<{ left: Float32Array; right: Float32Array; sourceRate: number }> {
  if (signal.aborted) throw abortError();

  let left: Float32Array = new Float32Array(0);
  let right: Float32Array = new Float32Array(0);
  let nl = 0;
  let nr = 0;
  let resampler: ReturnType<typeof createResampler> | undefined;
  let resR: ReturnType<typeof createResampler> | undefined;
  let frames = 0;
  let done = 0;

  const append = (dst: Float32Array, at: number, src: Float32Array): Float32Array => {
    if (at + src.length > dst.length) {
      const grown = new Float32Array(Math.max(at + src.length, Math.floor(dst.length * 1.5)));
      grown.set(dst.subarray(0, at));
      dst = grown;
    }
    dst.set(src, at);
    return dst;
  };

  const info = await readPcmFile(
    path,
    (chunk, channels) => {
      if (signal.aborted) throw abortError();
      const l = chunk[0];
      const ol = resampler!.push(l);
      // Mono: one resample, duplicated. Otherwise the second channel gets its own resampler state.
      const or = channels > 1 ? resR!.push(chunk[1]) : ol;
      left = append(left, nl, ol);
      right = append(right, nr, or);
      nl += ol.length;
      nr += or.length;
      done += l.length;
      onChunk?.(frames ? done / frames : 1);
      if (signal.aborted) throw abortError();
    },
    {
      onHeader: (h) => {
        frames = h.frames;
        resampler = createResampler(h.sampleRate, DEMUCS_RATE);
        resR = h.channels > 1 ? createResampler(h.sampleRate, DEMUCS_RATE) : undefined;
        const expected = Math.floor((DEMUCS_RATE * h.frames) / h.sampleRate);
        left = new Float32Array(expected);
        right = new Float32Array(expected);
      },
    },
  );

  const tl = resampler!.end();
  const tr = resR ? resR.end() : tl;
  left = append(left, nl, tl);
  right = append(right, nr, tr);
  nl += tl.length;
  nr += tr.length;
  return { left: left.subarray(0, nl), right: right.subarray(0, nr), sourceRate: info.sampleRate };
}
