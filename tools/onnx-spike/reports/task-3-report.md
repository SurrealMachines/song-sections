# Task 3 report: Export allin1

**Status:** DONE. The pure-torch NATTEN replacement matches real NATTEN 0.17.4 to **≤ 5.7e-6** max abs on the final logits (bar 1e-4), on both full tracks. The ONNX export (opset 17, dynamic time axis) matches it to **≤ 7.2e-6** in onnxruntime. The full ONNX pipeline is Demucs-ORT stems → allin1 features → allin1-ORT → allin1 post-processing. On both tracks its output is **identical to the PyTorch baseline**:
- every segment boundary is at the same frame (0.0 ms deviation);
- every label matches;
- every beat and downbeat matches, and so does the bpm.

allin1 on ORT CPU is about **20x faster** than PyTorch with the naive NATTEN kernels.

Commit: `710c1e8 spike: allin1 onnx export`. It contains three scripts only; no .onnx files and no outputs.

## What was built

| File | Role |
|---|---|
| `tools/onnx-spike/natten_torch.py` | Pure-torch `natten1dqkrpb`, `natten1dav`, `natten2dqkrpb` and `natten2dav`, with dilation. It has `patch_model()` to monkey-patch a loaded allin1 model, export-friendly `maybe_pad` replacements, and the `shared_neighborhoods()` context (see "Load time"). |
| `tools/onnx-spike/export_allin1.py` | Runs real-NATTEN reference logits (cached), then the patched-torch check, then exports the 8-fold ensemble and each fold, then the ORT check. It also dumps the Task 4 tensors. |
| `tools/onnx-spike/run_allin1_ort.py` | The full pipeline plus the comparison with the baseline, in two runs per track: `baseline-spec` and `ort-stems`. `--model folds` is the default; `--model harmonix_all` uses the single-graph ensemble. |

### Deviation from the brief: gather, not `unfold` + mask

NATTEN does **not** zero-pad at the edges. Per its CPU reference (`natten_cpu_commons.h`, `get_window_start` / `get_pb_start`):
- The window is clamped to stay inside the sequence, or inside the dilation group, so an edge query still sees `ks` real keys, just shifted.
- The relative-position-bias index shifts with it.

`unfold` + mask would give edge queries fewer keys, which is a different function. The replacement therefore computes neighbor indices from the axis length using `arange` and integer math, then uses Gather and MatMul.

Index math, in group coordinates with `j = i // d`, `g = i % d` and `Lg = ceil((L-g)/d)`:
- window start = `clamp(j - ks//2, 0, Lg - ks)`
- key = `g + d·(start + n)`
- bias index = `start + n - j + ks - 1`

The 2D op is used for the instrument × time attention, kernel 5 and dilation 1. The 4 instruments are padded to 5. It gathers along time, then selects instrument rows with a one-hot MatMul. That keeps the temporaries at about 14 M floats on a 23k-frame track, where a full 25-neighbour gather would need about 70 M.

### Dynamic length and allin1's padding (review focus 3)

- allin1's `DinatLayer1d.maybe_pad` zero-pads the layer-normed sequence up to `window = 5·dilation·2` frames when T is shorter. In the last layer that is **10240 frames, or 102 s**. This is a Python branch that tracing would freeze at the example length.
- The replacement always appends `window` zero frames, then keeps the first `max(T, window)`. Both are graph ops, the output is identical for every T, and the caller trims back to T.
- The 2D pad covers the instrument axis only, which is static. It would pad time only when T < 5 frames, so that case was dropped. Minimum input: 5 frames.
- The tracer flags 3 static branches (`was_padded`, `logits.shape[1]==1`, the instrument pad). They depend only on the 4 instruments and 1 class, never on T. The warnings are silenced in `export()`, with a comment.
- The 2 full tracks (17711 and 23198 frames) and 2 excerpts (600 and 3000 frames, below 10240, so the pad path runs) all match NATTEN through **one** exported graph. The export example was the full Flim track.

## Step 1: patched torch vs real NATTEN (full tracks, baseline spectrograms)

Reference logits come from the stock allin1 model with real NATTEN 0.17.4. They reproduce the baseline's saved activations to ≤ 4.7e-8, with labels exact.

| Input | Model | patched torch, max abs diff (worst of 4 logits) | ORT, max abs diff |
|---|---|---|---|
| flim, 17711 frames | 8-fold ensemble | 2.9e-6 | 2.9e-6 (single graph), 2.9e-6 (mean of 8 fold graphs) |
| inner-city-life, 23198 frames | 8-fold ensemble | 3.8e-6 | 3.8e-6 / 3.8e-6 |
| flim excerpt, 600 frames | ensemble | 2.9e-6 | 2.9e-6 / 2.9e-6 |
| flim excerpt, 3000 frames | ensemble | 2.9e-6 | 2.9e-6 / 2.9e-6 |
| flim | fold 0 alone | 3.8e-6 | 5.7e-6 |
| inner-city-life | fold 0 alone | 5.7e-6 | 7.2e-6 |

**The worst case is 7.2e-6, against a 1e-4 bar, about 14x headroom.** The diff does not grow with track length: 600 frames give the same as 23198. So there is no sign of NATTEN replacement drift (review focus 1). At op level I also ran random tensors against NATTEN with L from 5 to 17711, dilations 1 to 2048, and 2D shapes up to (5, 17711): max diff 3.8e-6. That was a scratch script, not committed.

All numbers are in `out/allin1/export-results.json`; the log is `out/allin1/export.log`.

## Step 2: the export

| Model | File | Size | Nodes | ORT session create | ORT run, flim / ICL |
|---|---|---|---|---|---|
| 8-fold ensemble (mean inside the graph) | `out/models/allin1_harmonix_all.onnx` | 21.2 MB | 47705 | **31.3 s** | 9.9 s / 13.0 s |
| one fold, ×8 (`allin1_harmonix_fold{0..7}.onnx`) | each 2.67 MB, **21.4 MB total** | | 6690 each | 0.9 s each, **7.4 s for all 8** | 8 folds summed: 10.6 s / 13.2 s |

- **Inputs and outputs.** The input is `spec` (1, 4, T, 81) f32. The outputs are `logits_beat`, `logits_downbeat` and `logits_section`, each (1, T), and `logits_function` (1, 10, T). T is dynamic.
- **Params.** 300,631 per fold, f32, which matches the 1.3 MB `.pth`. The rest of each 2.67 MB file is graph structure.
- **Op types (28):** Add, Cast, Clip, Concat, Constant, ConstantOfShape, Conv, Div, Elu, Erf, Gather, LayerNormalization, MatMul, MaxPool, Min, Mod, Mul, Pad, Range, ReduceSum, Reshape, Shape, Slice, Softmax, Squeeze, Sub, Transpose, Unsqueeze. The ensemble graph adds ReduceMean. All are standard ai.onnx ops; there is no Einsum and no custom domain. Task 4 should still confirm coverage on onnxruntime-node and CoreML.

### Load time: a trap that was found and fixed

- **The trap.** My first export recomputed the neighbor indices in every qk and av call. That gave 9466 nodes per fold and 75632 for the ensemble, and the ensemble took **131 s to create an ORT session**: 190 s with optimisations off, 147 s with basic. Inference was fine at 10 s.
- **The fix.** `natten_torch.shared_neighborhoods()` builds each distinct index set once per forward. The key is (kernel, dilation, pad window), computed from a single traced T, and the sets are shared across layers, qk/av and folds. That cut nodes to 6690 per fold and 47705 for the ensemble. Session creation fell to 0.9 s per fold and 31 s for the ensemble.
- **Still superlinear.** The ensemble's creation cost grows faster than linearly with graph size. An ORT-optimised re-save had 17k nodes and still took 35 s. **Recommendation for Plan 3:** load the 8 fold models and average the four logit arrays in TypeScript, a plain element-wise mean. That is 7.4 s to load all 8 versus 31 s, with identical results, as shown below.

## Step 3: full pipeline vs PyTorch baseline (S3: shifts=0 baseline)

Command: `uv run python run_allin1_ort.py`, using the 8 fold models. Results are in `out/allin1_ort/results.folds.json` and `<name>.<run>.folds.json`. `--model harmonix_all` gives the same verdicts and numbers (`results.harmonix_all.json`).

| Track | Run | Verdict | Segments | Labels | Max boundary dev | Beats | Downbeats | beat_positions | bpm |
|---|---|---|---|---|---|---|---|---|---|
| flim | baseline-spec | **PASS** | 10/10 | identical | 0.0 ms | 328/328 identical | 82/82 identical | identical | 150/150 |
| flim | ort-stems | **PASS** | 10/10 | identical | 0.0 ms | 328/328 identical | 82/82 identical | identical | 150/150 |
| inner-city-life | baseline-spec | **PASS** | 14/14 | identical | 0.0 ms | 408/408 identical | 102/102 identical | identical | 154/154 |
| inner-city-life | ort-stems | **PASS** | 14/14 | identical | 0.0 ms | 408/408 identical | 102/102 identical | identical | 154/154 |

How the error accumulates, as max abs diff of activations against the baseline's `activ.npz` (post-sigmoid/softmax):

| Track | baseline-spec (allin1 export alone) | ort-stems (Demucs-ORT + allin1-ORT) |
|---|---|---|
| flim | beat 1.8e-7, downbeat 2.1e-7, segment 8.9e-8, label 4.5e-7 | beat 2.7e-4, downbeat 3.2e-4, segment 2.0e-5, label 1.4e-4 |
| inner-city-life | 2.1e-7, 3.3e-7, 1.0e-7, 3.6e-7 | 8.3e-5, 7.4e-5, 1.4e-5, 8.7e-5 |

- In the ort-stems run, the int16 stems differ from the baseline's by at most 11 LSB (bass, Flim). The spectrogram then differs by up to 4.4e-3.
- So almost all the remaining difference comes from Demucs-ORT, not the allin1 export. Even that is about 1000x too small to move a peak pick, a label argmax or the DBN path on these tracks.
- The pipeline writes Demucs-ORT stems exactly as baseline.py does: demucs `save_audio` with clip rescale and int16.

## Timings (M2 Pro, CPU, default ORT threads)

| Stage | flim, 177 s | ICL, 232 s | Notes |
|---|---|---|---|
| PyTorch + real NATTEN, 8 folds | 209.3 s | 271.5 s | from this task's reference run; Task 1 reported 212 s / 274 s including post-processing |
| PyTorch + natten_torch, 8 folds | 13.9–15.5 s | 18.4–20.0 s | pure-torch ops are about 14x faster than the naive NATTEN CPU kernels |
| **ORT, 8 fold sessions** | **10.5 s** | **13.2 s** | about 0.06x real time; the single-graph ensemble takes 9.9 s / 13.0 s |
| ORT session creation, 8 folds | 7.4 s (once per process) | | |
| Feature extraction (madmom, Python) | 1.8 s | 2.5 s | |
| DBN beats and downbeats (madmom) | 1.1 s | 1.7 s | |
| Functional post-processing | 0.01 s | 0.01 s | |

- **Extrapolated to a 5-min track:** about 17 s ORT, 3 s features and 2 s DBN, plus Demucs-ORT's roughly 60 s (Task 2).
- allin1 is comfortably under the spec's "Structure ~ real-time" target on Python ORT. Node timings come in Task 4.

## What Node / Plan 3 must reimplement

### A. Demucs write-out (only needed to stay bit-compatible with the baseline)

- Per stem: `x / max(1.01·max|x|, 1)`, then `clamp(-1, 1) · 32767`, **truncated** toward zero to int16. That is demucs `_pcm_bytes` with `.astype('<i2')`.
- Plan 3 can decide whether to skip the int16 round trip. It changes the spectrogram by about 1e-3. A stem difference 4x that size (ort-stems) changed nothing here, but it is not proven equal on all music.

### B. Feature extraction (allin1.spectrogram, madmom 0.16.1)

I verified this recipe in a scratch numpy reimplementation: **max abs diff ≤ 3.1e-7** against allin1's `_spec/flim.npy` on all 4 stems. Per stem, in the order bass, drums, other, vocals:

1. **Mono:** load the int16 stereo WAV, `np.mean(axis=-1)` in float, then cast back to **int16, truncating**. That is madmom `remix`.
2. **Frames:**
   - frame_size 2048 and hop **441.0** (fps 100, sr 44100); `num_frames = ceil(N / 441)`.
   - Frame i covers samples `[int(i·441) − 1024, int(i·441) + 1024)`, zero-padded outside the signal (origin 0, centred).
3. **Window:** `np.hanning(2048)`, which is the **symmetric** Hann, divided by **32767**. This is madmom's int16 scaling; the samples stay raw ints.
4. **STFT:** rfft of size 2048, keep bins 0..1023 (Nyquist dropped). Take the magnitude, `|X|`, as float32.
5. **Filterbank:** LogarithmicFilterbank, 81 bands.
   - Bin frequencies are `fftfreq(2048, 1/44100)[:1024]`.
   - Centre frequencies are `440·2^(k/12)` for `k ∈ [floor(12·log2(30/440)), ceil(12·log2(17000/440)))`, trimmed to [30, 17000] with `searchsorted` (left for fmin, right for fmax).
   - Each frequency maps to the nearest bin (an exact tie goes to the upper bin), and duplicate bins are removed (`unique_filters=True`).
   - Overlapping triangular filters cover consecutive bin triples (start, centre, stop):
     - the rising edge is `linspace(0, 1, centre − start, endpoint=False)` and the falling edge is `linspace(1, 0, stop − centre, endpoint=False)`;
     - when `stop − start < 2`, the filter is a single bin;
     - each filter is **normalised to unit area** (`norm_filters=True`);
     - each filter is its own column of a (1024 × 81) float32 matrix.
6. **Log:** `log10(1·S + 1)`, float32.
7. **Stack:** (4, T, 81), then add a batch axis to get (1, 4, T, 81).

### C. Inference

- Run the 8 fold models and take the element-wise mean of each logit array. This is in float32; mean of 8 versus allin1's `stack().mean(0)` is within 4e-6.
- No normalisation is applied to `spec`. Everything else is inside the graph.

### D. Post-processing (allin1.postprocessing)

1. **Functional structure (small port):**
   - Compute `sig(logits_section)`, then `local_maxima` with filter **97** (= 4·min_hops_per_beat 24 + 1). It keeps a value only where it equals the max of its ±48 window, padded with −inf; everything else becomes 0.
   - Then `peak_picking` with window_past = window_future = **1200 frames**:
     - zero-pad the sequence;
     - a frame is a candidate where it equals the max of its 2401-frame window and is > 0;
     - its strength is `x − (mean(past 1200) + mean(future 1200))/2`;
     - **boundary = strength > 0**.
   - Boundary times are `frame · 441/44100`. Insert 0 and the duration `T·0.01` if they are missing.
   - Each segment's label is the argmax of the **mean over its frames** of `softmax(logits_function, axis=classes)`, split at the boundary frames, with labels in the 10 HARMONIX_LABELS.
2. **Metrical structure: madmom `DBNDownBeatTrackingProcessor`. FLAG: this is the big port.**
   - **Input:** `b = sig(beat)` and `d = sig(downbeat)`. Then `xbeat = max(1e-8, b − d)`, `no = ((1−b) + (1−d))/2`, normalise `[xbeat, d, no]` to sum 1, and pass columns `[xbeat, d]`.
   - **Parameters:**
     - `beats_per_bar=[3, 4]`, `threshold = 0.24` (the mean of the 8 folds' best_threshold_downbeat), `fps=100`;
     - madmom defaults: min_bpm 55, max_bpm 215, num_tempi 60, transition_lambda 100, observation_lambda 16, correct=True.
   - **What it does:**
     - crops to the first and last frame where any activation ≥ threshold;
     - builds a bar-pointer HMM state space (BarStateSpace and BarTransitionModel, with exponential tempo transitions) per bar length;
     - runs a Viterbi decode for each (Cython in madmom) and keeps the higher log-probability;
     - with `correct=True`, moves each beat to the activation argmax inside each "beat range" run of states;
     - returns times and beat numbers.
   - **Port size:** I estimate several hundred lines of TypeScript. Viterbi runs over about 10⁴ states × T frames per hypothesis; madmom does both in 1–2 s here.
   - **Simpler alternative (untested):** peak-pick beats and drop the DBN. Exact match with the baseline would need the DBN.
3. **Tempo:** take the mode of `round(60 / diff(beats))` as an int (`bincount`, then the first entry of `argsort(strength)[::-1]`; ties follow numpy's argsort order, reversed).

## Tensors for Task 4 (`out/tensors/`, fold 0, full Flim, baseline spectrogram)

| File | Shape | dtype | Size |
|---|---|---|---|
| `allin1_spec.npy` | (1, 4, 17711, 81) | f32 | 23 MB |
| `allin1_logits_beat.npy` | (1, 17711) | f32 | 71 kB |
| `allin1_logits_downbeat.npy` | (1, 17711) | f32 | 71 kB |
| `allin1_logits_section.npy` | (1, 17711) | f32 | 71 kB |
| `allin1_logits_function.npy` | (1, 10, 17711) | f32 | 709 kB |

- These are the exact ORT batch-1 outputs of `out/models/allin1_harmonix_fold0.onnx`, which takes 1.3 s per run in Python ORT.
- ORT differs from torch by ≤ 7e-6 here, so the 1e-4 Node-vs-Python bar looks realistic for allin1, unlike Demucs.

## Concerns

1. **madmom DBN port.** This is the biggest TypeScript item in Plan 3 (see D.2). allin1's beat and downbeat output depends on it, and segments do not. madmom is still PyPI 0.16.1 (ruling S4), not git master.
2. **Global state in natten_torch.** `shared_neighborhoods()` uses a module-level dict that the layers' `maybe_pad` fill and the ops read in sequence. It is only active inside `LogitsOnly.forward`, during export and checks, and it is single-threaded. Without the context, the ops recompute their indices and behave the same; the op-level test ran that way. It is fine for a spike, but it is not reusable library code.
3. **natten_torch copies allin1 1.1.0 internals.** These are `maybe_pad` semantics and the NATTEN 0.17.4 index rules. If allin1 or NATTEN versions change, the export must be re-verified with `export_allin1.py`.
4. **Single-graph ensemble load time is 31 s.** Use the 8 fold files (7.4 s). Session creation was not explored further, for example with ORT-format models or session-option tuning; Task 4 should measure it in Node.
5. **Cached references.** The real-NATTEN reference logits are cached under `out/allin1/natten_*.npz`. The NATTEN timings above come from the first, uncached run (`natten_torch_s` is absent from the final JSON because the last run used the cache). Delete the cache to re-measure.
6. **Not committed.** The two scratch checks (op-level random-tensor test, numpy feature recipe) live in the session scratchpad only, as verification evidence. A committed `allin1_dsp.py`, analogous to `demucs_dsp.py`, would be a natural Plan 3 or Task 5 artefact.

## Self-review

- The diff is exactly the three planned files. There is no `git add -A` and no amend.
- `pyflakes` is clean on all three.
- Not overbuilt. The fold exports exist because of the load-time finding. The excerpts exist because they are the only test of the short-track padding path. `--model` exists to show that the ensemble and the fold mean agree.
- Verification is measured numbers throughout, as the brief requires for a spike: no TDD.

## Artefacts (gitignored)

- `out/models/allin1_harmonix_all.onnx` (21.2 MB) and `out/models/allin1_harmonix_fold{0..7}.onnx` (2.67 MB each).
- `out/allin1/export-results.json`, `export.log`, and `natten_*.npz` (the reference logits).
- `out/allin1_ort/results.{folds,harmonix_all}.json` and per-run JSONs.
- `out/allin1_ort/_demix/<name>/*.wav` (the int16 Demucs-ORT stems) and `_spec/<name>.npy`.
- `out/allin1_ort.folds.log`.
- `out/tensors/allin1_*.npy`.

## Fix wave (final branch review)

- **Concern 6 is resolved.** The scratch numpy feature recipe is now committed as `tools/onnx-spike/allin1_dsp.py`. Its `--check` mode reproduces the claim on **both** tracks: `uv run python allin1_dsp.py --check` gives max abs diff ≤ 3.13e-7 on Flim and ≤ 3.03e-7 on Inner City Life, against `out/baseline/_spec`, with exit 0.
- The op-level random-tensor NATTEN test is still scratch only.
