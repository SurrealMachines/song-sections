// The htdemucs core (the ONNX graph between Task 3's STFT and iSTFT) as a DemucsCore for separate().
import { join } from "node:path";
import { FREQ_BINS, SEGMENT_LENGTH, SPEC_FRAMES } from "../demucs/dsp.js";
import type { DemucsCore } from "../demucs/separate.js";
import { type Ort, hostFloat32, localFloat32 } from "../runtime.js";
import { type SessionOptions, SESSION_OPTIONS, openSession, outputData, runSession } from "./sessions.js";

export const DEMUCS_CORE_FILE = "htdemucs_core.onnx";

const MIX_DIMS = [1, 2, SEGMENT_LENGTH];
const SPEC_DIMS = [1, 4, FREQ_BINS, SPEC_FRAMES];
const SPEC_OUT_DIMS = [1, 4, 4, FREQ_BINS, SPEC_FRAMES];
const WAVE_OUT_DIMS = [1, 4, 2, SEGMENT_LENGTH];

const size = (dims: number[]) => dims.reduce((a, b) => a * b, 1);

/**
 * Opens `htdemucs_core.onnx` from `modelDir`. The returned core maps one chunk's `mix` [1,2,343980] and
 * `spec` [1,4,2048,336] to `spec_out` [1,4,4,2048,336] and `wave_out` [1,4,2,343980]; the outputs are
 * zero-copy views of ORT's arrays (about 55 MB per chunk, garbage once separate() is done with them).
 * It holds the one allowed ORT session until `release()`.
 */
export async function openDemucsCore(
  ort: Ort,
  modelDir: string,
  options: SessionOptions = SESSION_OPTIONS,
): Promise<{ core: DemucsCore; release(): Promise<void> }> {
  const { session, release } = await openSession(ort, join(modelDir, DEMUCS_CORE_FILE), options);
  let released = false;
  const core: DemucsCore = async ({ mix, spec }) => {
    if (released) throw new Error("The Demucs core was used after it was released");
    if (mix.length !== size(MIX_DIMS)) throw new Error(`Demucs core: mix has ${mix.length} values, expected ${size(MIX_DIMS)}`);
    if (spec.length !== size(SPEC_DIMS)) throw new Error(`Demucs core: spec has ${spec.length} values, expected ${size(SPEC_DIMS)}`);
    const out = await runSession(
      session,
      {
        mix: new ort.Tensor("float32", hostFloat32(mix), MIX_DIMS),
        spec: new ort.Tensor("float32", hostFloat32(spec), SPEC_DIMS),
      },
      DEMUCS_CORE_FILE,
    );
    return {
      specOut: localFloat32(outputData(out, "spec_out", SPEC_OUT_DIMS, DEMUCS_CORE_FILE)),
      waveOut: localFloat32(outputData(out, "wave_out", WAVE_OUT_DIMS, DEMUCS_CORE_FILE)),
    };
  };
  return {
    core,
    async release() {
      released = true;
      await release();
    },
  };
}
