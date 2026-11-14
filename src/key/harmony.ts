// v2, key per section: the host side. Computes the harmonic chroma (key/chroma.ts) of the mix or of the kept stems,
// and caches it beside the analyses, in its own entry: `cache/harmony-2/<audio hash>-mix.json`, and
// `<audio hash>-stems-<STRUCTURE_ENGINE>.json` for the stems (key review M5: an engine that separates differently makes
// other stems, so its stems get an entry of their own). The analysis
// caches are not touched, so every existing entry stays valid; one without a harmony entry gets one the first time
// it is opened (from its kept stems, or from the mix), which needs no models.
import { loadCached, saveCached } from "../analysis/cache.js";
import { readPcmFile } from "../audio/pcmFile.js";
import { abortError } from "../core/abort.js";
import { FOREGROUND, type Pace } from "../core/pace.js";
import type { Harmony } from "../dialog/protocol.js";
import { STRUCTURE_ENGINE, type StemName } from "../structure/contract.js";
import { chromaRows, estimateTuning, fineChroma, foldChroma, gatedPower, HARMONY_RATE, levelGain } from "./chroma.js";
import { join } from "node:path";

export const HARMONY_ENGINE = "harmony-2"; // 2: level brought to REF_RMS (review I2), folded about the clip's tuning (M1)
/** The rate the stems are read at (the mix comes prepared at it already: audio/prepare.ts ANALYSIS_TARGET_RATE). */
const TARGET_RATE = 11025;
/** The stems a key is heard in: everything but the drums. */
export const HARMONIC_STEMS = ["bass", "other", "vocals"] as const satisfies readonly StemName[];

/** A cached or received harmony is used only when it is whole. */
export function isHarmony(v: unknown): v is Harmony {
  const h = v as Partial<Harmony> | null;
  return (
    typeof h === "object" &&
    h !== null &&
    (h.source === "stems" || h.source === "mix") &&
    h.rate === HARMONY_RATE &&
    (h.tuningCents === undefined || Number.isFinite(h.tuningCents)) &&
    Array.isArray(h.chroma) &&
    h.chroma.every((r) => Array.isArray(r) && r.length === 12 && r.every((x) => typeof x === "number" && Number.isFinite(x)))
  );
}

/** A WAV or AIFF file as mono, box-decimated to about TARGET_RATE (as prepareAudio makes the mix's analysis signal). */
export async function readMono(path: string, signal?: AbortSignal, pace: Pace = FOREGROUND): Promise<{ x: Float32Array; rate: number }> {
  let x = new Float32Array(0);
  let d = 1;
  let rate = 0;
  let out = 0;
  let sum = 0;
  let count = 0;
  await readPcmFile(
    path,
    async (planes, channels) => {
      await pace.yield(signal);
      if (signal?.aborted) throw abortError("Analysis aborted");
      const n = planes[0].length;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let ch = 0; ch < channels; ch++) m += planes[ch][i];
        sum += m / channels;
        if (++count === d) {
          x[out++] = sum / d;
          sum = 0;
          count = 0;
        }
      }
    },
    {
      chunkFrames: pace.slice(65536),
      onHeader: (h) => {
        d = Math.max(1, Math.round(h.sampleRate / TARGET_RATE));
        rate = h.sampleRate / d;
        x = new Float32Array(Math.ceil(h.frames / d));
      },
    },
  );
  if (count > 0) x[out++] = sum / count;
  return { x: x.subarray(0, out), rate };
}

/** The mix's harmony, from the prepared analysis signal (mono, about 11 kHz). */
export async function mixHarmony(x: Float32Array, rate: number, signal?: AbortSignal, pace: Pace = FOREGROUND): Promise<Harmony> {
  const fine = await fineChroma(x, rate, signal, pace, levelGain(gatedPower(x, rate)));
  return tuned("mix", fine);
}

/** The harmony of fine chroma: folded about its own tuning (review M1), which it records in cents. */
function tuned(source: Harmony["source"], fine: Float64Array): Harmony {
  const tuning = estimateTuning(fine);
  return { source, rate: HARMONY_RATE, chroma: chromaRows(foldChroma(fine, tuning)), tuningCents: Math.round(tuning * 100) };
}

/**
 * The harmony of the kept stems in `dir` (`<stem>.wav`): the chroma of bass, other and vocals, summed. `pace`: as
 * harmonicChroma's; it covers the reading too. Review I2: one gain for the three, from their levels together, so a
 * quiet set of stems keys as a loud one and each stem keeps its weight against the others; the stems are read twice
 * for it (a level pass, then the chroma), so only one is ever in memory.
 */
export async function stemsHarmony(dir: string, signal?: AbortSignal, pace: Pace = FOREGROUND): Promise<Harmony> {
  let power = 0;
  for (const stem of HARMONIC_STEMS) {
    const { x, rate } = await readMono(join(dir, `${stem}.wav`), signal, pace);
    power += gatedPower(x, rate);
  }
  const gain = levelGain(power);
  // The fine chroma summed, so the three share one tuning too.
  let sum: Float64Array | null = null;
  for (const stem of HARMONIC_STEMS) {
    const { x, rate } = await readMono(join(dir, `${stem}.wav`), signal, pace);
    const c = await fineChroma(x, rate, signal, pace, gain);
    if (!sum) sum = c;
    else for (let i = 0; i < Math.min(sum.length, c.length); i++) sum[i] += c[i];
  }
  return tuned("stems", sum!);
}

/** The cache entry's name: the stems' is tied to the engine that separated them (review M5). */
export const cacheKey = (hash: string, source: Harmony["source"]) => (source === "stems" ? `${hash}-stems-${STRUCTURE_ENGINE}` : `${hash}-mix`);

export interface HarmonyDeps {
  loadCached: typeof loadCached;
  saveCached: typeof saveCached;
  logError(...args: unknown[]): void;
}

/**
 * The cached harmony of this audio from `source`, or `compute`d and cached. Never throws for a failure to compute
 * (logged; null: the dialog shows no keys) or to cache; an abort is rethrown.
 */
export async function cachedHarmony(
  deps: HarmonyDeps,
  storageDir: string,
  hash: string,
  source: Harmony["source"],
  compute: () => Promise<Harmony>,
): Promise<Harmony | null> {
  const key = cacheKey(hash, source);
  try {
    const hit = await deps.loadCached<Harmony>(storageDir, key, HARMONY_ENGINE);
    if (isHarmony(hit) && hit.source === source) return hit;
  } catch {
    // compute it
  }
  let h: Harmony;
  try {
    h = await compute();
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "AbortError") throw error;
    deps.logError(`Song Sections: could not find the key (${source}):`, error);
    return null;
  }
  await deps.saveCached(storageDir, key, HARMONY_ENGINE, h).catch((error) => {
    deps.logError("Song Sections: could not save the key cache:", error);
  });
  return h;
}
