import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelsDir, spikeOut } from "../../test/golden.js";
import { readNpy } from "../../test/npy.js";
import { functionalStructure } from "../allin1/functional.js";
import { FREQ_BINS, SEGMENT_LENGTH, SPEC_FRAMES } from "../demucs/dsp.js";
import { type Ort, loadOrt } from "../runtime.js";
import { openDemucsCore } from "./demucsCore.js";
import { FOLD_CONTEXT_FRAMES, FOLD_COUNT, FOLD_MAX_FRAMES, flushReleasedMemory, foldFile, foldWindows, runFolds, type FoldWindow } from "./folds.js";
import { SESSION_OPTIONS, openSession, openSessionCount } from "./sessions.js";

// ---------------------------------------------------------------------------------------------
// A fake onnxruntime: records every create/release and returns outputs we can predict.
// ---------------------------------------------------------------------------------------------

interface FakeLog {
  created: string[];
  released: string[];
  maxOpen: number;
  options: unknown[];
  feeds: Record<string, { data: unknown; dims: readonly number[] }>[];
}

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: Float32Array,
    readonly dims: readonly number[],
  ) {}
}

/** `outputs(path, feeds)` builds the run result for the session at `path`. */
function fakeOrt(outputs: (path: string, feeds: Record<string, FakeTensor>) => Record<string, FakeTensor>, failRun?: (path: string) => boolean) {
  const log: FakeLog = { created: [], released: [], maxOpen: 0, options: [], feeds: [] };
  let open = 0;
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(path: string, options: unknown) {
        log.created.push(path);
        log.options.push(options);
        open++;
        log.maxOpen = Math.max(log.maxOpen, open);
        return {
          async run(feeds: Record<string, FakeTensor>) {
            log.feeds.push(feeds);
            if (failRun?.(path)) throw runInNewContext("new Error('kaboom')"); // an error from another realm, like ORT's
            return outputs(path, feeds);
          },
          async release() {
            log.released.push(path);
            open--;
          },
        };
      },
    },
  };
  return { ort: ort as unknown as Ort, log };
}

const foldIndex = (path: string) => Number(/fold(\d)\.onnx$/.exec(path)![1]);

/** Fold k returns k+1 everywhere (beat), 10(k+1) (downbeat), -(k+1) (section), and i + k for function. */
function foldOutputs(T: number) {
  return (path: string) => {
    const k = foldIndex(path);
    const fill = (n: number, v: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => v(i));
    return {
      logits_beat: new FakeTensor("float32", fill(T, () => k + 1), [1, T]),
      logits_downbeat: new FakeTensor("float32", fill(T, () => 10 * (k + 1)), [1, T]),
      logits_section: new FakeTensor("float32", fill(T, () => -(k + 1)), [1, T]),
      logits_function: new FakeTensor("float32", fill(10 * T, (i) => i + k), [1, 10, T]),
    };
  };
}

const neverAborted = () => new AbortController().signal;

afterEach(() => {
  expect(openSessionCount()).toBe(0); // every test leaves no session open
});

describe("SESSION_OPTIONS", () => {
  it("runs on the CPU execution provider with full graph optimisation", () => {
    expect(SESSION_OPTIONS.executionProviders).toEqual(["cpu"]);
    expect(SESSION_OPTIONS.graphOptimizationLevel).toBe("all");
    expect(SESSION_OPTIONS.enableCpuMemArena).toBe(true); // E5
    expect(SESSION_OPTIONS.enableMemPattern).toBe(false); // Task 9: Demucs plateau 1910 -> 1257 MB, same speed
  });
});

describe("openSession", () => {
  it("refuses a second session while one is open (verdict §5.3: never two at once)", async () => {
    const { ort, log } = fakeOrt(() => ({}));
    const a = await openSession(ort, "/m/a.onnx");
    await expect(openSession(ort, "/m/b.onnx")).rejects.toThrow(/already open/);
    expect(log.created).toEqual(["/m/a.onnx"]);
    await a.release();
    await a.release(); // idempotent
    expect(log.released).toEqual(["/m/a.onnx"]);
    const b = await openSession(ort, "/m/b.onnx");
    await b.release();
  });

  it("passes SESSION_OPTIONS to create", async () => {
    const { ort, log } = fakeOrt(() => ({}));
    await (await openSession(ort, "/m/a.onnx")).release();
    expect(log.options[0]).toBe(SESSION_OPTIONS);
  });

  it("a failed create frees the slot and names the model, with a message from another realm", async () => {
    const ort = {
      InferenceSession: {
        create: async () => {
          throw runInNewContext("new Error('Load model failed')");
        },
      },
    } as unknown as Ort;
    const error = await openSession(ort, "/m/x.onnx").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not open x.onnx: Load model failed");
    expect(openSessionCount()).toBe(0);
  });
});

describe("runFolds (fake runtime)", () => {
  const T = 7;
  const spec = () => new Float32Array(4 * T * 81).map((_, i) => i);

  it("runs the 8 folds one at a time, in order, and returns the mean of each output", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T));
    const folds: number[] = [];
    const out = await runFolds(ort, "/models", spec(), T, neverAborted(), (k) => folds.push(k));
    expect(log.created).toEqual(Array.from({ length: 8 }, (_, k) => join("/models", `allin1_harmonix_fold${k}.onnx`)));
    expect(log.released).toEqual(log.created);
    expect(log.maxOpen).toBe(1);
    expect(folds).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...out.beat]).toEqual(Array(T).fill(4.5));
    expect([...out.downbeat]).toEqual(Array(T).fill(45));
    expect([...out.section]).toEqual(Array(T).fill(-4.5));
    expect(out.fn.length).toBe(10 * T);
    expect(out.fn[0]).toBe(3.5);
    expect(out.fn[10 * T - 1]).toBe(10 * T - 1 + 3.5);
    for (const a of [out.beat, out.downbeat, out.section, out.fn]) expect(a).toBeInstanceOf(Float32Array);
  });

  it("feeds spec [1,4,T,81] as float32, the caller's data unchanged", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T));
    const s = spec();
    await runFolds(ort, "/models", s, T, neverAborted(), () => {});
    expect(log.feeds).toHaveLength(8);
    for (const feeds of log.feeds) {
      expect(Object.keys(feeds)).toEqual(["spec"]);
      expect(feeds.spec.dims).toEqual([1, 4, T, 81]);
      expect([...(feeds.spec.data as Float32Array)]).toEqual([...s]);
    }
  });

  it("sums in float32 then divides by 8, as make_ref_mean.py does in numpy", async () => {
    // 0.1 per fold: a float64 sum would give 0.8/8 = 0.1 exactly; float32 accumulation does not.
    const { ort } = fakeOrt(() => ({
      logits_beat: new FakeTensor("float32", Float32Array.of(0.1), [1, 1]),
      logits_downbeat: new FakeTensor("float32", Float32Array.of(0.1), [1, 1]),
      logits_section: new FakeTensor("float32", Float32Array.of(0.1), [1, 1]),
      logits_function: new FakeTensor("float32", new Float32Array(10).fill(0.1), [1, 10, 1]),
    }));
    const out = await runFolds(ort, "/models", new Float32Array(4 * 81), 1, neverAborted(), () => {});
    let acc = 0;
    for (let k = 0; k < 8; k++) acc = Math.fround(acc + Math.fround(0.1));
    expect(out.beat[0]).toBe(Math.fround(acc / 8));
  });

  it("aborting after fold 2 rejects AbortError, and every session it opened is released", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T));
    const c = new AbortController();
    const error = await runFolds(ort, "/models", spec(), T, c.signal, (k) => {
      if (k === 2) c.abort();
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(log.created).toHaveLength(3);
    expect(log.released).toEqual(log.created);
  });

  it("an aborted signal opens no session at all", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T));
    const c = new AbortController();
    c.abort();
    await expect(runFolds(ort, "/models", spec(), T, c.signal, () => {})).rejects.toMatchObject({ name: "AbortError" });
    expect(log.created).toHaveLength(0);
  });

  it("a failing fold releases its session and names the fold", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T), (path) => foldIndex(path) === 4);
    const error = await runFolds(ort, "/models", spec(), T, neverAborted(), () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("allin1_harmonix_fold4.onnx: kaboom");
    expect(log.released).toEqual(log.created);
    expect(log.created).toHaveLength(5);
  });

  it("rejects an output with unexpected dims", async () => {
    const { ort, log } = fakeOrt(() => ({ ...foldOutputs(T)("fold0.onnx"), logits_beat: new FakeTensor("float32", new Float32Array(T), [T]) }));
    await expect(runFolds(ort, "/models", spec(), T, neverAborted(), () => {})).rejects.toThrow(/logits_beat has dims \[7\], expected \[1,7\]/);
    expect(log.released).toEqual(log.created);
  });

  it("rejects a spec whose length is not 4·T·81", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T));
    await expect(runFolds(ort, "/models", new Float32Array(10), T, neverAborted(), () => {})).rejects.toThrow(/4·T·81/);
    expect(log.created).toHaveLength(0);
  });

  it("yields to the host between folds", async () => {
    const { ort } = fakeOrt(foldOutputs(T));
    const spy = vi.spyOn(globalThis, "setTimeout");
    await runFolds(ort, "/models", spec(), T, neverAborted(), () => {});
    expect(spy.mock.calls.filter(([, ms]) => ms === 0).length).toBeGreaterThanOrEqual(FOLD_COUNT);
    spy.mockRestore();
  });

  it("passes options.session to create", async () => {
    const { ort, log } = fakeOrt(foldOutputs(T));
    const session = { ...SESSION_OPTIONS, intraOpNumThreads: 2 };
    await runFolds(ort, "/models", spec(), T, neverAborted(), () => {}, { session });
    expect(log.options).toEqual(Array(8).fill(session));
  });

  it("names the fold files allin1_harmonix_fold{k}.onnx", () => {
    expect(FOLD_COUNT).toBe(8);
    expect(foldFile(7)).toBe("allin1_harmonix_fold7.onnx");
  });
});

describe("openDemucsCore (fake runtime)", () => {
  const plane = FREQ_BINS * SPEC_FRAMES;
  const outputs = () => ({
    spec_out: new FakeTensor("float32", new Float32Array(16 * plane).fill(1), [1, 4, 4, FREQ_BINS, SPEC_FRAMES]),
    wave_out: new FakeTensor("float32", new Float32Array(8 * SEGMENT_LENGTH).fill(2), [1, 4, 2, SEGMENT_LENGTH]),
  });

  it("feeds mix [1,2,L] and spec [1,4,2048,336] and returns spec_out and wave_out", async () => {
    const { ort, log } = fakeOrt(outputs);
    const { core, release } = await openDemucsCore(ort, "/models");
    expect(log.created).toEqual([join("/models", "htdemucs_core.onnx")]);
    const r = await core({ mix: new Float32Array(2 * SEGMENT_LENGTH), spec: new Float32Array(4 * plane) });
    expect(log.feeds[0].mix.dims).toEqual([1, 2, SEGMENT_LENGTH]);
    expect(log.feeds[0].spec.dims).toEqual([1, 4, FREQ_BINS, SPEC_FRAMES]);
    expect(r.specOut.length).toBe(16 * plane);
    expect(r.waveOut.length).toBe(8 * SEGMENT_LENGTH);
    expect(r.specOut[5]).toBe(1);
    expect(r.waveOut[5]).toBe(2);
    expect(r.specOut).toBeInstanceOf(Float32Array);
    await release();
    expect(log.released).toEqual(log.created);
    await expect(core({ mix: new Float32Array(2 * SEGMENT_LENGTH), spec: new Float32Array(4 * plane) })).rejects.toThrow(/released/);
  });

  it("rejects inputs of the wrong length", async () => {
    const { ort } = fakeOrt(outputs);
    const { core, release } = await openDemucsCore(ort, "/models");
    await expect(core({ mix: new Float32Array(5), spec: new Float32Array(4 * plane) })).rejects.toThrow(/mix/);
    await release();
  });

  it("holds the only session: no fold can open until the core is released", async () => {
    const { ort } = fakeOrt(outputs);
    const { release } = await openDemucsCore(ort, "/models");
    await expect(runFolds(ort, "/models", new Float32Array(4 * 81), 1, neverAborted(), () => {})).rejects.toThrow(/already open/);
    await release();
  });
});

/** The checks every window plan must pass: outputs tile [0, T), inputs contain their outputs with `context` frames on every inner side, and no input is longer than `maxFrames`. */
function expectValidPlan(plan: FoldWindow[], T: number, maxFrames: number, context: number) {
  expect(plan[0].outStart).toBe(0);
  expect(plan.at(-1)!.outEnd).toBe(T);
  for (const [i, w] of plan.entries()) {
    if (i > 0) expect(w.outStart).toBe(plan[i - 1].outEnd);
    expect(w.outEnd).toBeGreaterThan(w.outStart);
    expect(w.inStart).toBeGreaterThanOrEqual(0);
    expect(w.inEnd).toBeLessThanOrEqual(T);
    expect(w.inEnd - w.inStart).toBeLessThanOrEqual(maxFrames);
    expect(w.inStart === 0 || w.outStart - w.inStart >= context).toBe(true);
    expect(w.inEnd === T || w.inEnd - w.outEnd >= context).toBe(true);
  }
}

describe("foldWindows (long tracks, findings E10)", () => {
  it("covers the measured receptive field and bounds a run to 6 minutes", () => {
    // fold 0 on Flim: a window edge changes outputs up to 8000-8250 frames away, and nothing beyond (E10)
    expect(FOLD_CONTEXT_FRAMES).toBeGreaterThanOrEqual(8250);
    expect(FOLD_MAX_FRAMES).toBe(36_000);
  });

  it("is one window over the whole input up to FOLD_MAX_FRAMES", () => {
    for (const T of [1, 17711, 30_000, FOLD_MAX_FRAMES]) expect(foldWindows(T)).toEqual([{ inStart: 0, inEnd: T, outStart: 0, outEnd: T }]);
  });

  it("uses the fewest windows that fit: 3 for 10 minutes, 6 for 20, 9 for 30", () => {
    const counts = [[FOLD_MAX_FRAMES + 1, 2], [60_000, 3], [120_000, 6], [180_000, 9]] as const;
    for (const [T, n] of counts) {
      const plan = foldWindows(T);
      expectValidPlan(plan, T, FOLD_MAX_FRAMES, FOLD_CONTEXT_FRAMES);
      expect(plan).toHaveLength(n);
      expect(foldWindows(T, FOLD_MAX_FRAMES, FOLD_CONTEXT_FRAMES)).toEqual(plan);
    }
  });

  it("gives valid plans for any length and small settings", () => {
    for (let T = 1; T <= 400; T += 7) expectValidPlan(foldWindows(T, 60, 20), T, 60, 20);
  });

  it("rejects a window that cannot hold context on both sides", () => {
    expect(() => foldWindows(100, 40, 20)).toThrow(/maxFrames/);
  });
});

describe("runFolds over windows (fake runtime)", () => {
  const T = 1000;
  // spec[stem][t][band] = stem * 100000 + t * 81 + band: every frame of every stem is distinct
  const spec = () => new Float32Array(4 * T * 81).map((_, i) => Math.floor(i / (T * 81)) * 100_000 + (i % (T * 81)));
  /** A per-frame fold: frame t's outputs depend only on input frame t, so any windowing gives the same result. */
  const perFrame = (path: string, feeds: Record<string, FakeTensor>) => {
    const k = foldIndex(path);
    const [, , L] = feeds.spec.dims;
    const x = feeds.spec.data;
    const at = (stem: number, t: number, band: number) => x[(stem * L + t) * 81 + band];
    const fill = (n: number, v: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => v(i));
    return {
      logits_beat: new FakeTensor("float32", fill(L, (t) => at(0, t, 0) + k), [1, L]),
      logits_downbeat: new FakeTensor("float32", fill(L, (t) => at(1, t, 1)), [1, L]),
      logits_section: new FakeTensor("float32", fill(L, (t) => at(3, t, 80)), [1, L]),
      logits_function: new FakeTensor("float32", fill(10 * L, (i) => at(2, i % L, Math.floor(i / L))), [1, 10, L]),
    };
  };

  it("gives exactly the whole-input result, opening each fold once and running it once per window", async () => {
    const whole = await runFolds(fakeOrt(perFrame).ort, "/models", spec(), T, neverAborted(), () => {});
    const { ort, log } = fakeOrt(perFrame);
    const folds: number[] = [];
    const out = await runFolds(ort, "/models", spec(), T, neverAborted(), (k) => folds.push(k), { maxFrames: 400, context: 100 });
    const windows = foldWindows(T, 400, 100).length;
    expect(windows).toBeGreaterThan(2);
    expect(log.created).toHaveLength(8);
    expect(log.released).toEqual(log.created);
    expect(log.feeds).toHaveLength(8 * windows);
    for (const feeds of log.feeds) expect(feeds.spec.dims[2]).toBeLessThanOrEqual(400);
    expect(folds).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const k of ["beat", "downbeat", "section", "fn"] as const) expect([...out[k]]).toEqual([...whole[k]]);
    expect(out.beat[0]).toBe(3.5);
  });

  it("checks the signal between windows: a cancel during a window's run lands before the next window", async () => {
    const c = new AbortController();
    let runs = 0;
    const { ort, log } = fakeOrt((path, feeds) => {
      if (++runs === 2) c.abort(); // during fold 0's second window
      return perFrame(path, feeds);
    });
    const error = await runFolds(ort, "/models", spec(), T, c.signal, () => {}, { maxFrames: 400, context: 100 }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(log.feeds).toHaveLength(2);
    expect(log.released).toEqual(log.created);
  });
});

describe("flushReleasedMemory (findings E10)", () => {
  it("after a session was released, opens and releases fold 0 once; otherwise does nothing", async () => {
    const { ort, log } = fakeOrt(() => ({}));
    await flushReleasedMemory(ort, "/models"); // may flush what earlier tests released
    log.created.length = 0;
    log.released.length = 0;
    await flushReleasedMemory(ort, "/models");
    expect(log.created).toEqual([]);
    await (await openSession(ort, "/m/demucs.onnx")).release();
    await flushReleasedMemory(ort, "/models");
    expect(log.created).toEqual(["/m/demucs.onnx", join("/models", foldFile(0))]);
    expect(log.released).toEqual(log.created);
    await flushReleasedMemory(ort, "/models");
    expect(log.created).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Real models (SONG_SECTIONS_MODELS): goldens against the spike's Python ORT tensors.
// ---------------------------------------------------------------------------------------------

function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`length ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= m)) m = d; // NaN propagates
  }
  return m;
}

const tensor = (name: string) => readNpy(join(spikeOut()!, "tensors", `${name}.npy`));

describe.skipIf(!modelsDir())("ORT runners on the real models", () => {
  const ort = () => loadOrt(process.cwd(), undefined);

  it("Demucs core matches the Python ORT tensors (max abs ≤ 1e-4)", async () => {
    const mix = tensor("demucs_mix");
    const spec = tensor("demucs_spec");
    expect(mix.shape).toEqual([1, 2, SEGMENT_LENGTH]);
    expect(spec.shape).toEqual([1, 4, FREQ_BINS, SPEC_FRAMES]);
    const { core, release } = await openDemucsCore(ort(), modelsDir()!);
    try {
      const out = await core({ mix: mix.data as Float32Array, spec: spec.data as Float32Array });
      const specErr = maxAbs(out.specOut, tensor("demucs_spec_out").data);
      const waveErr = maxAbs(out.waveOut, tensor("demucs_wave_out").data);
      console.log(`demucs core max abs: spec_out ${specErr.toExponential(3)}, wave_out ${waveErr.toExponential(3)}`);
      expect(specErr).toBeLessThanOrEqual(1e-4);
      expect(waveErr).toBeLessThanOrEqual(1e-4);
    } finally {
      await release();
    }
  }, 60_000);

  it("runFolds matches the Python 8-fold mean (max abs ≤ 1e-6)", async () => {
    const spec = tensor("allin1_spec");
    const T = spec.shape[2];
    expect(spec.shape).toEqual([1, 4, 17711, 81]);
    const folds: number[] = [];
    const out = await runFolds(ort(), modelsDir()!, spec.data as Float32Array, T, neverAborted(), (k) => folds.push(k));
    expect(folds).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const errs = {
      beat: maxAbs(out.beat, tensor("allin1_mean_logits_beat").data),
      downbeat: maxAbs(out.downbeat, tensor("allin1_mean_logits_downbeat").data),
      section: maxAbs(out.section, tensor("allin1_mean_logits_section").data),
      fn: maxAbs(out.fn, tensor("allin1_mean_logits_function").data),
    };
    console.log(`8-fold mean max abs: ${JSON.stringify(errs)}`);
    for (const e of Object.values(errs)) expect(e).toBeLessThanOrEqual(1e-6);
  }, 180_000);

  it("runFolds over two windows stays at the noise floor of the Python 8-fold mean (findings E10)", async () => {
    const spec = tensor("allin1_spec");
    const T = spec.shape[2];
    const plan = foldWindows(T, 17_500, FOLD_CONTEXT_FRAMES);
    expect(plan).toHaveLength(2);
    const out = await runFolds(ort(), modelsDir()!, spec.data as Float32Array, T, neverAborted(), () => {}, { maxFrames: 17_500 });
    const errs = {
      beat: maxAbs(out.beat, tensor("allin1_mean_logits_beat").data),
      downbeat: maxAbs(out.downbeat, tensor("allin1_mean_logits_downbeat").data),
      section: maxAbs(out.section, tensor("allin1_mean_logits_section").data),
      fn: maxAbs(out.fn, tensor("allin1_mean_logits_function").data),
    };
    console.log(`windowed 8-fold mean max abs: ${JSON.stringify(errs)}`);
    // ORT's own output moves by up to 2.9e-6 when only the thread count changes (E10); a window adds no more than that
    for (const e of Object.values(errs)) expect(e).toBeLessThanOrEqual(5e-6);
    // Contract allin1-onnx-3: the boundary candidates of the windowed run are the single pass's (same frames, same
    // segments; strengths within one 3-decimal step).
    const whole = functionalStructure(tensor("allin1_mean_logits_section").data as Float32Array, tensor("allin1_mean_logits_function").data as Float32Array, T);
    const windowed = functionalStructure(out.section, out.fn, T);
    expect(windowed.segments).toEqual(whole.segments);
    expect(windowed.candidates.map((c) => c.time)).toEqual(whole.candidates.map((c) => c.time));
    windowed.candidates.forEach((c, i) => expect(Math.abs(c.strength - whole.candidates[i].strength)).toBeLessThanOrEqual(0.001 + 1e-9));
  }, 300_000);

  it("aborting after fold 2 rejects AbortError and leaves no session open (spy on create/release)", async () => {
    const real = ort();
    const spec = tensor("allin1_spec");
    const T = spec.shape[2];
    // The spec comes from another realm, as it does in Live's host: runFolds must re-wrap it for ORT.
    const foreign = runInNewContext(`new Float32Array(${spec.data.length})`) as Float32Array;
    foreign.set(spec.data as Float32Array);
    const released: string[] = [];
    const realCreate = real.InferenceSession.create.bind(real.InferenceSession) as (path: string, options: unknown) => Promise<{ release(): Promise<void> }>;
    const create = vi.spyOn(real.InferenceSession, "create").mockImplementation((async (path: string, options: unknown) => {
      const session = await realCreate(path, options);
      const release = session.release.bind(session);
      session.release = async () => {
        released.push(path);
        await release();
      };
      return session;
    }) as never);
    const c = new AbortController();
    try {
      const error = await runFolds(real, modelsDir()!, foreign, T, c.signal, (k) => {
        if (k === 2) c.abort();
      }).catch((e: unknown) => e);
      expect((error as Error).name).toBe("AbortError");
      expect(create).toHaveBeenCalledTimes(3);
      expect(released).toEqual([0, 1, 2].map((k) => join(modelsDir()!, foldFile(k))));
    } finally {
      create.mockRestore();
    }
  }, 120_000);

  // Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); measured (findings E5/E6,
  // M2 Pro, plain node): Demucs chunk ~1.1 s, 8 folds on Flim (T = 17711) ~18 s. Bounds are about 2x that.
  it.skipIf(!process.env.SONG_SECTIONS_PERF)("speed: a Demucs chunk under 2.5 s, the 8 folds on Flim under 40 s", async () => {
    const mix = tensor("demucs_mix").data as Float32Array;
    const spec = tensor("demucs_spec").data as Float32Array;
    const { core, release } = await openDemucsCore(ort(), modelsDir()!);
    let chunkMs: number;
    try {
      await core({ mix, spec }); // the first run includes one-off allocation
      const t = performance.now();
      await core({ mix, spec });
      chunkMs = performance.now() - t;
    } finally {
      await release();
    }
    const a = tensor("allin1_spec");
    const t = performance.now();
    await runFolds(ort(), modelsDir()!, a.data as Float32Array, a.shape[2], neverAborted(), () => {});
    const foldsMs = performance.now() - t;
    console.log(`speed: Demucs chunk ${Math.round(chunkMs)} ms, 8 folds ${Math.round(foldsMs)} ms`);
    expect(chunkMs).toBeLessThan(2500);
    expect(foldsMs).toBeLessThan(40_000);
  }, 180_000);
});
