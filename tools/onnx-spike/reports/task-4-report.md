# Task 4 report: Node smoke test

**Status:** DONE. `onnxruntime-node@1.31.1` runs the exported Demucs core and all 8 allin1 fold models in Node 24.16 on darwin-arm64. On the CPU EP the outputs are **bit-identical to Python ORT 1.31.1** (max abs diff 0.0 on every output, 1e-4 bar passed with infinite margin), because the two use the same CPU kernels.
The CoreML EP loads but is **not usable**: it is slower on Demucs by 45x, and it fails at session init or run for allin1 and some Demucs configs. Use the CPU EP.

Commit: `b5539b2 spike: node onnxruntime smoke test` (package.json, package-lock.json, smoke.mjs only).

## What was built (`tools/onnx-spike/node/`)

- `package.json` is private and ESM, with `onnxruntime-node` pinned to the exact version `1.31.1` (the latest on npm). The lockfile is committed.
- `smoke.mjs`:
  - has a tiny built-in `.npy` reader (f32, C order), so no conversion to `.bin` is needed;
  - runs Demucs (`mix`, `spec` → `spec_out`, `wave_out`) and allin1 fold 0 on the Task 2 and 3 tensors;
  - loads all 8 folds, runs them on the Flim spectrogram and averages the 4 logit arrays in JS (ruling S8);
  - reports max abs diff, relative error (max abs / reference peak) and SDR against the Python ORT outputs;
  - verdict: PASS if abs < 1e-4, "pass-with-note" if abs ≥ 1e-4 but SDR ≥ 60 dB, otherwise FAIL;
  - flags: `--ep cpu|coreml`, `--coreml-flags N`, `--only demucs,allin1,folds`, `--ref-dir`, `--out`, `--log`.
- Reference for the 8-fold mean: there were no stored Python outputs for folds 1-7. I computed the mean of the 8 Python ORT fold outputs with a scratch script (not committed) and passed it with `--ref-dir`.
- Run: `cd tools/onnx-spike/node && npm ci && node smoke.mjs --ep cpu --ref-dir <dir with allin1_mean_*.npy>`.

## Results, CPU EP (default threads, M2 Pro)

| Model | Output | Shape | max abs vs Python ORT | rel | SDR | Verdict |
|---|---|---|---|---|---|---|
| Demucs core | spec_out | 1×4×4×2048×336 | 0.0 | 0 | inf | PASS |
| Demucs core | wave_out | 1×4×2×343980 | 0.0 | 0 | inf | PASS |
| allin1 fold 0 | beat / downbeat / section / function | (1,17711) ×3, (1,10,17711) | 0.0 | 0 | inf | PASS |
| allin1 8-fold JS mean | all 4 logits | same | 0.0 | 0 | inf | PASS |

Python ORT 1.31.1 and Node ORT 1.31.1 are the same version, so the same kernels were used. A different ORT version or build could differ at the 1e-3 level, as Task 2 found against torch.

| Timing | Node CPU | Python ORT (Tasks 2 and 3) |
|---|---|---|
| Demucs session create | 0.69 s | 0.7 s |
| Demucs run, one 7.8 s chunk | 1.05-1.09 s (3 runs) | about 1.0 s |
| allin1 fold 0 session create | 0.88 s | 0.9 s |
| allin1 fold 0 run (17711 frames) | 1.23 s (first run 1.46 s) | 1.3 s |
| Load all 8 folds | **7.2 s** (0.88-0.90 s each) | 7.4 s |
| Run all 8 folds + JS mean, Flim | **10.1-10.2 s** | 10.5 s |

- Node adds no overhead compared with Python.
- **Peak RSS** (corrected in fix round 1; the first draft quoted end-of-run RSS of about 300 MB, which was wrong): whole smoke run 4.08 GB, confirmed by `/usr/bin/time -l` (4,076,175,360 bytes). Per stage, run alone: Demucs 2.0 GB, allin1 fold 0 0.66 GB, 8 folds loaded at once about 4.0 GB. See the memory concern in fix round 1.
- Timing method: wall time from `performance.now()` around `InferenceSession.create` and around `session.run` (which includes copying the output tensors). Runs are sequential, one session at a time. Demucs "run" is the third consecutive run; allin1 fold 0 "run" is the second. Fold times are for all 8 sessions run back to back.
- The JS averaging is a plain loop and takes a negligible time.
- JSON output writes SDR as `null` where it is infinite.

## CoreML EP

onnxruntime-node 1.31.1 does expose CoreML on darwin-arm64. The bundled `libonnxruntime` links CoreML.framework, and `{ name: 'coreml', coreMlFlags }` is accepted. I tried three flag sets per model. Logs came from `logSeverityLevel: 0`.

| Model | Flags | Partitions / nodes on CoreML | Outcome |
|---|---|---|---|
| Demucs | 0 (NeuralNetwork) | 160 partitions, 1325 of 2372 nodes supported (160 nodes placed on CoreML, 1047 on CPU) | Runs. Create 3.2 s, first run 9.3 s, steady **47.4-47.7 s**, against 1.05 s on CPU (45x slower). Accuracy vs Python ORT: spec_out abs 7.5e-3, rel 4.5e-4, SDR 68.6 dB; wave_out abs 2.3e-4, SDR 87.4 dB. Pass-with-note only (abs ≥ 1e-4, SDR ≥ 60). |
| Demucs | 0x10 (MLProgram) | 142 partitions, 1945 of 2372 | Fails at create: `Program failed validation: KernelChannels (48) != InputChannels (1) / Group (1)` |
| Demucs | 0x18 (MLProgram, static shapes only) | 40 partitions, 548 of 2372 | Fails at run: Slice `Ends must be a 1-D array` |
| allin1 fold 0 | 0 | 215 partitions, 898 of 2529 nodes | Fails at run: `Error executing model: Error in building plan` |
| allin1 fold 0 | 0x10 | 135 partitions, 2062 of 2529 | Fails at create: `Invalid tensor rank 0 inferred from: ios18.squeeze` |
| allin1 fold 0 | 0x18 | 35 partitions, 558 of 2529 | Runs, output bit-identical, but only 35 mostly trivial nodes land on CoreML. Run time 1.34 s, the same as CPU. |

Why CoreML takes so little of allin1: the unsupported-op reasons in the log, by count, are rank greater than 5 (the NATTEN gather and transpose tensors are 6-D), Gather output rank greater than 5, MatMul with a non-constant B (attention), non-constant Reshape shapes, `Pad` without a constant value, and the dynamic time axis. Those are inherent to the replacement design.

**Recommendation: CPU EP only.** CoreML on this graph is both slower and fragile. The ONNX models would need reshaping for CoreML (static shapes, rank 5 or less), and the CPU EP is already well below real time:
- Demucs is about 0.2x real time.
- allin1 is about 0.06x real time.

## Native binary footprint and host requirements

- `npm install` of `onnxruntime-node@1.31.1` is 297 MB in `node_modules`. That is mostly the bundled linux, win32 and darwin binaries.
- **What the darwin-arm64 build needs** (verified by deleting everything else from a copy and re-running):
  - `onnxruntime_binding.node`: 0.32 MB;
  - `libonnxruntime.1.dylib`: 45.3 MB, loaded through `@loader_path` rpath;
  - `dist/` and `lib/`: about 0.1 MB of JS, plus `onnxruntime-common`: 1.2 MB.
  - **Total about 45.7 MB native.** `libonnxruntime.1.31.1.dylib` is a byte-identical duplicate of `libonnxruntime.1.dylib` and can be dropped.
  - The dylib links only system frameworks: CoreML, Cocoa, IOKit, QuartzCore, Metal, IOSurface, libsqlite3 and libz. There are no extra dylibs to ship.
- Windows (other bundles in the package), for the Windows build:
  - x64: `onnxruntime.dll` 31.7 MB, `onnxruntime_binding.node` 0.36 MB, plus `DirectML.dll` 18.5 MB and `dxcompiler.dll` 18.0 MB, which are only needed for the DirectML EP.
  - arm64: 32.8 MB, 0.5 MB, 18.4 MB and 22.3 MB respectively.
  - CPU-only needs just the first two files, about 32 MB.
  - Not run in the Windows guest here.
- Linux: x64 is 46 MB and arm64 is 25 MB. On linux/x64 the `postinstall` script downloads CUDA binaries unless it is skipped with `--onnxruntime-node-install=skip`. This is irrelevant on macOS and Windows.
- **Bundling:** `dist/binding.js` does a template-string `require('../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node')`. With esbuild, mark `onnxruntime-node` as external and ship the `bin/napi-v6/<plat>/<arch>` directory next to the package JS. Bundling the JS in is not possible.
- **Permission model:** I ran `node --permission --allow-addons --allow-fs-read=<spike dir> smoke.mjs` and it works unchanged, with output identical to the unrestricted run.
  - `--allow-addons` is required: without it the load fails with `ERR_DLOPEN_DISABLED`.
  - It emits one `SecurityWarning` about `--allow-addons`.
  - `--allow-fs-read` must cover both the models and the addon directory.
  - `--allow-fs-write` is not needed, and neither are `--allow-worker` or `--allow-child-process`.
  - The addon's own dyld load of `libonnxruntime.1.dylib` is not affected by the permission model.
  - CoreML was not tested under `--permission`.
- Code signing: the binding and dylib are ad-hoc, linker-signed arm64 binaries. I did not test hardened-runtime or notarised distribution inside Live; if Live's host enforces library validation, the dylib may need re-signing.

## Notes for Plan 3

- Use the CPU EP, one `InferenceSession` per Demucs core and per allin1 fold, created once. Create costs about 0.7 s for Demucs and 7.2 s for all 8 folds.
- The 8 folds can be averaged element-wise in TypeScript, in float32, with results identical to Python's mean of the same fold outputs.
- Tensors cross the boundary as `Float32Array` with `ort.Tensor('float32', data, dims)`. Outputs come back as `Tensor.data` Float32Array.
- The `session.run` calls are async and run on a native thread pool, so the event loop stays free. Sequential runs were used here. Parallel fold runs were not tested.
- Not tested: `intraOpNumThreads` tuning, memory when running full tracks (31+ chunks) back to back, and the Windows build.

## Files

- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/node/package.json`
- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/node/package-lock.json`
- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/node/smoke.mjs`

## Self-review

- Nothing committed other than the three files. `node_modules` is ignored by the repo's `.gitignore`.
- The scratch Python mean-of-8 script and the CoreML logs/JSON live only in the session scratchpad.
- The CoreML flag sweep is exposed via `--coreml-flags`, kept small, and only exists to produce the table above.

## Fix round 1

Review findings fixed (all in `smoke.mjs`, plus one new script):

1. **NaN passed the comparison.** `compare()` now counts non-finite values in either array (`nonFinite`), and `verdict()` returns `FAIL (non-finite values)` if any exist or if max abs is not finite. A new `--selftest` flag checks this without loading any model.
2. **The 8-fold check was skippable and its reference was not in the repo.**
   - New committed script `tools/onnx-spike/make_ref_mean.py` writes `out/tensors/allin1_mean_*.npy` from the 8 Python ORT fold sessions.
   - `smoke.mjs` reads those by default (`--ref-dir` overrides).
   - If any are missing it prints `8-fold: NOT CHECKED (... run: uv run python make_ref_mean.py)` and records `verdict: "NOT CHECKED"` in the JSON. NOT CHECKED does not set a failing exit code, but it is loud.
3. **Minors.**
   - `process.exitCode = 1` is now set on any FAIL verdict, including a shape mismatch, and on errors.
   - Peak RSS is reported from `process.resourceUsage().maxRSS` (KB, converted), as `peakRssMB`. The earlier "300 MB" claim in this report was end-of-run RSS and was wrong. The corrected figure is above.
   - The timing methodology note is added above.

### Commands and output

```
$ node smoke.mjs --selftest; echo exit=$?
selftest ok   identical: PASS
selftest ok   NaN in output: FAIL (non-finite values)
selftest ok   Inf in output: FAIL (non-finite values)
selftest ok   NaN in reference: FAIL (non-finite values)
selftest ok   large mismatch: FAIL
selftest ok   small diff: PASS
exit=0

$ node smoke.mjs --only folds          # before the reference existed
  8-fold: NOT CHECKED (no allin1_mean_*.npy in .../out/tensors; run: uv run python make_ref_mean.py)

$ cd .. && uv run python make_ref_mean.py
onnxruntime 1.31.1: wrote allin1_mean_*.npy

$ node smoke.mjs --out <scratch>/cpu-fix1.json     # full CPU run
  demucs.spec_out / wave_out                      maxAbs=0 SDR=inf -> PASS
  allin1.fold0.logits_{beat,downbeat,section,function}   maxAbs=0 -> PASS
  allin1.mean8.logits_{beat,downbeat,section,function}   maxAbs=0 -> PASS
done in 35.8s, peak RSS 4076 MB
```

Timings on this re-run were the same as before: Demucs create 0.70 s and run 1.06-1.07 s; fold 0 create 0.90 s and run 1.32-1.34 s; 8 folds load 7.07 s and run 10.5 s.

### New concern: memory

Peak RSS is 4.0 GB when the 8 fold sessions are held at once (about 0.5 GB per session, most likely the ORT CPU memory arena on 17711-frame activations), and 2.0 GB for the Demucs session. That is a lot for an extension host. Plan 3 should consider creating, running and releasing one fold at a time (about 7 s total create cost is paid per analysis), or `enableCpuMemArena: false`. I did not test either here.
