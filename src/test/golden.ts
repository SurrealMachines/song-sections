import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the committed fixtures, independent of the working directory. */
export const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures", "structure");

/** The model directory for model-gated tests (gate with `describe.skipIf(!modelsDir())`, not on the env var alone), or undefined when SONG_SECTIONS_MODELS is unset or missing. */
export function modelsDir(): string | undefined {
  const d = process.env.SONG_SECTIONS_MODELS;
  return d && existsSync(d) ? d : undefined;
}

/** The spike's `out/` directory (the models dir's parent): holds `tensors/` and `baseline/`. */
export function spikeOut(): string | undefined {
  const d = modelsDir();
  return d ? dirname(d) : undefined;
}

/** 10·log10(Σref² / Σ(ref−got)²) in dB; Infinity when identical. */
export function snrDb(ref: ArrayLike<number>, got: ArrayLike<number>): number {
  if (ref.length !== got.length) throw new Error(`length ${ref.length} vs ${got.length}`);
  let sig = 0;
  let err = 0;
  for (let i = 0; i < ref.length; i++) {
    sig += ref[i] * ref[i];
    const d = ref[i] - got[i];
    err += d * d;
  }
  return err === 0 ? Infinity : 10 * Math.log10(sig / err);
}
