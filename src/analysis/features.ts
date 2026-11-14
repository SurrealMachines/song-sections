import MeydaModule from "meyda";
import { abortError } from "../core/abort.js";

// meyda ships CommonJS at runtime (module.exports = Meyda) but ESM-style
// typings (export default Meyda); under nodenext the default import is typed
// as the whole module, so retype it as the object it actually is.
const Meyda = MeydaModule as unknown as typeof MeydaModule.default;

export const BLOCK_SEC = 0.5;
const MFCC_DIMS = 13;
const CHROMA_DIMS = 12;
const DIMS = MFCC_DIMS + CHROMA_DIMS;
const YIELD_EVERY_BLOCKS = 200;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * One feature vector per 0.5 s block of `x` (sampled at `rate`): 13 MFCC then
 * 12 chroma, each dimension z-normalized across the clip. Frames of
 * nextPow2(0.093 · rate) samples, hop half a frame, are averaged into the block
 * containing their centre. Non-finite frame features (e.g. from silence)
 * count as 0, and constant dimensions normalize to 0.
 */
export async function blockFeatures(
  x: Float32Array,
  rate: number,
  signal?: AbortSignal,
  onProgress?: (f: number) => void,
): Promise<Float32Array[]> {
  if (signal?.aborted) throw abortError("Analysis aborted");

  const frame = nextPow2(0.093 * rate);
  const hop = frame / 2;
  const blockLen = BLOCK_SEC * rate;
  const nBlocks = Math.ceil(x.length / blockLen);
  if (nBlocks === 0) {
    onProgress?.(1);
    return [];
  }
  const sums = Array.from({ length: nBlocks }, () => new Float64Array(DIMS));
  const counts = new Uint32Array(nBlocks);

  // Meyda is a global singleton; re-apply after every yield in case another
  // analysis at a different rate ran in between.
  const configureMeyda = () => {
    // extract() caches its filter banks and does not rebuild them when the
    // rate (or, for mel/chroma, the frame size) changes, so a new setting
    // would reuse banks built for the old one. Drop them on any change.
    if (Meyda.sampleRate !== rate || Meyda.bufferSize !== frame) {
      const cache = Meyda as unknown as Record<"barkScale" | "melFilterBank" | "chromaFilterBank", unknown>;
      cache.barkScale = cache.melFilterBank = cache.chromaFilterBank = undefined;
    }
    Meyda.bufferSize = frame;
    Meyda.sampleRate = rate;
    Meyda.numberOfMFCCCoefficients = MFCC_DIMS;
    Meyda.chromaBands = CHROMA_DIMS;
  };
  configureMeyda();

  // A clip shorter than one frame is analysed as a single zero-padded frame.
  const padded = x.length < frame ? (() => { const p = new Float32Array(frame); p.set(x); return p; })() : x;
  const nFrames = Math.floor((padded.length - frame) / hop) + 1;

  let nextYieldBlock = YIELD_EVERY_BLOCKS;
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    const block = Math.min(nBlocks - 1, Math.floor((start + frame / 2) / blockLen));
    if (block >= nextYieldBlock) {
      nextYieldBlock = block + YIELD_EVERY_BLOCKS;
      onProgress?.(block / nBlocks);
      await new Promise<void>((r) => setTimeout(r, 0)); // host-safe: Live has no setImmediate
      if (signal?.aborted) throw abortError("Analysis aborted");
      configureMeyda();
    }
    const feats = Meyda.extract(["mfcc", "chroma"], padded.subarray(start, start + frame)) as
      | { mfcc: number[]; chroma: number[] }
      | null;
    const s = sums[block];
    if (feats) {
      for (let k = 0; k < MFCC_DIMS; k++) {
        const v = feats.mfcc[k];
        if (Number.isFinite(v)) s[k] += v;
      }
      for (let k = 0; k < CHROMA_DIMS; k++) {
        const v = feats.chroma[k];
        if (Number.isFinite(v)) s[MFCC_DIMS + k] += v;
      }
    }
    counts[block]++;
  }

  // Block means; a block no frame centre fell into copies its predecessor.
  const blocks: Float32Array[] = [];
  for (let b = 0; b < nBlocks; b++) {
    const v = new Float32Array(DIMS);
    if (counts[b] > 0) for (let k = 0; k < DIMS; k++) v[k] = sums[b][k] / counts[b];
    else if (b > 0) v.set(blocks[b - 1]);
    blocks.push(v);
  }

  // z-normalize each dimension across the clip.
  for (let k = 0; k < DIMS; k++) {
    let mean = 0;
    for (const v of blocks) mean += v[k];
    mean /= nBlocks || 1;
    let varSum = 0;
    for (const v of blocks) varSum += (v[k] - mean) ** 2;
    const sd = Math.sqrt(varSum / (nBlocks || 1));
    for (const v of blocks) v[k] = sd > 1e-9 ? (v[k] - mean) / sd : 0;
  }

  onProgress?.(1);
  return blocks;
}
