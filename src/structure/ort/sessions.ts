// ORT sessions for the structure engine (Plan 3 Task 8). One rule is enforced here rather than left to
// callers: never hold two ORT sessions at once (verdict §5.3; Global Constraints "Memory"). Task 9 must
// release the Demucs core before the first allin1 fold; opening a fold while it is held throws.
import { basename } from "node:path";
import type { InferenceSession } from "onnxruntime-node";
import { type Ort, errorMessage } from "../runtime.js";

/**
 * CPU only (verdict criterion 6). `enableCpuMemArena: true` per E5 (findings): turning it off raised the 8-fold peak
 * RSS by 50 %. `enableMemPattern: false` per Task 9 (findings E6, "memory pattern"): ORT's memory pattern pre-plans one
 * block for all of a run's intermediate tensors; without it the Demucs session's plateau falls from 1910 to 1257 MB
 * at the same speed, and the folds are unchanged (~670 MB, ~18 s). Outputs are bit-identical.
 */
export const SESSION_OPTIONS = {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  enableCpuMemArena: true,
  enableMemPattern: false,
} as const satisfies InferenceSession.SessionOptions;

export type SessionOptions = InferenceSession.SessionOptions;

let open = 0;
let releasedSinceFlush = false;

/** Sessions currently open through openSession (0 or 1). */
export function openSessionCount(): number {
  return open;
}

export interface OpenSession {
  session: InferenceSession;
  /** Releases the session; safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Creates the session for the model at `path` (a path, never bytes: realm trap 2). Rejects when another
 * session is still open. ORT's errors come from the host realm; they are rethrown as an Error of ours
 * naming the model.
 */
export async function openSession(ort: Ort, path: string, options: SessionOptions = SESSION_OPTIONS): Promise<OpenSession> {
  if (open > 0) throw new Error(`Cannot open ${basename(path)}: another ORT session is already open (release it first)`);
  open++; // taken before the await, so a concurrent open is refused too
  let session: InferenceSession;
  try {
    session = await ort.InferenceSession.create(path, options);
  } catch (error) {
    open--;
    throw new Error(`Could not open ${basename(path)}: ${errorMessage(error)}`, { cause: error });
  }
  let released = false;
  return {
    session,
    async release() {
      if (released) return;
      released = true;
      try {
        await session.release();
      } finally {
        open--;
        releasedSinceFlush = true;
      }
    },
  };
}

/**
 * Returns to the system the memory of the session released last, by opening and releasing the model at `path` (an
 * allin1 fold). Does nothing when no session was released since the last call. Why (findings E10): on macOS the
 * released Demucs session's memory stays resident in libmalloc's cache of freed large blocks (footprint unchanged:
 * ~1.1 GB after release()) until later frees push it out, and a fold session's release does that. Without it the
 * first fold's working memory lands on top of Demucs's (5 min: 2229 MB peak instead of 1604). It does not help after
 * the folds (a fold run's memory stays cached whatever is opened next), a session with almost no allocations (an
 * Identity model) evicts nothing, and the cache cannot be switched off from inside the process (MallocLargeCache=0 is
 * an environment variable). Costs one session create, ~1 s.
 */
export async function flushReleased(ort: Ort, path: string, options: SessionOptions = SESSION_OPTIONS): Promise<void> {
  if (!releasedSinceFlush) return;
  const { release } = await openSession(ort, path, options);
  await release();
  releasedSinceFlush = false;
}

type Outputs = InferenceSession.ReturnType;

/** session.run with ORT's error rethrown as ours, prefixed with `label`. */
export async function runSession(session: InferenceSession, feeds: InferenceSession.FeedsType, label: string): Promise<Outputs> {
  try {
    return await session.run(feeds);
  } catch (error) {
    throw new Error(`${label}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * The float32 data of output `name`, checked against `dims`. The array belongs to the host realm (never
 * `instanceof` it); callers index it or view it with localFloat32.
 */
export function outputData(outputs: Outputs, name: string, dims: readonly number[], label: string): Float32Array {
  const t = outputs[name];
  if (!t) throw new Error(`${label}: no output ${name}`);
  const got = [...t.dims];
  if (got.length !== dims.length || got.some((d, i) => d !== dims[i])) {
    throw new Error(`${label}: ${name} has dims [${got}], expected [${dims}]`);
  }
  if (t.type !== "float32") throw new Error(`${label}: ${name} is ${t.type}, expected float32`);
  return t.data as Float32Array;
}
