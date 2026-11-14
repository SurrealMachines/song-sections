# Task 2 report: Export Demucs

**Status:** DONE. htdemucs exports to ONNX at opset 17, needing one workaround. The ORT pipeline reproduces the PyTorch float stems at **73–87 dB SDR per stem** on both tracks, against a 30 dB bar. The seam check shows no dips. ORT on CPU is about **1.8x faster** than PyTorch on CPU.

Commit: `e5ef7b2 spike: demucs onnx export`. It contains three scripts and nothing else; no .onnx files or outputs are committed.

## What was built

| File | Role |
|---|---|
| `tools/onnx-spike/demucs_dsp.py` | A numpy re-implementation of everything outside the graph: STFT/iSTFT, `_spec`/`_ispec` padding, the cac real/imag packing, and `Separator` + `apply_model` (shifts=0, split, overlap 0.25). **This is the code Plan 3 ports to TypeScript.** |
| `tools/onnx-spike/export_demucs.py` | Defines `HTDemucsCore`, checks it against the original model in torch, exports it to ONNX, then checks the export in ORT. |
| `tools/onnx-spike/run_demucs_ort.py` | Runs the full-track ORT pipeline. It writes the stems, scores SDR against the float baseline, runs the seam check, writes the seam excerpts and dumps the tensors for Task 4. `--engine torch` swaps in the torch core, which checks the numpy pipeline on its own. |

I added the helper module because the export check and the runner share the DSP. Keeping it in one file also gives Plan 3 a single file to port.

### The exported core (`out/models/htdemucs_core.onnx`)

- **Graph:** `HTDemucs.forward` from just after `_spec`/`_magnitude` to just before `_mask`/`_ispec`. Both input normalisations (spec and wave) and their de-normalisations stay inside the graph.
- **Inputs:**
  - `mix`: `(batch, 2, 343980)` f32, one normalised 7.8 s chunk.
  - `spec`: `(batch, 4, 2048, 336)` f32, the chunk's spectrogram with channels ordered `[L.re, L.im, R.re, R.im]`.
- **Outputs:**
  - `spec_out`: `(batch, 4 sources, 4, 2048, 336)`, freq-branch estimates in the same re/im layout.
  - `wave_out`: `(batch, 4 sources, 2, 343980)`, time-branch estimates.
  - A chunk's estimate is `ispec(spec_out) + wave_out`.
  - Source order is drums, bass, other, vocals.
- **Opset 17**, with a dynamic batch axis only. The time axis is fixed because htdemucs always runs exactly one training-length chunk: `apply_model` pads short chunks up to it.
- **Size:** 168.7 MB, a single file (42.0 M params, f32). The safetensors checkpoint is 80 MB, apparently stored in fp16.
- **Op types (39):** Add, Cast, Concat, Constant, ConstantOfShape, Conv, ConvTranspose, Cos, Div, Equal, Erf, Expand, Gather, Gemm, InstanceNormalization, LayerNormalization, MatMul, Mod, Mul, Pad, Pow, Range, ReduceMean, ReduceProd, Reshape, ScatterND, Shape, Sigmoid, Sin, Slice, Softmax, Split, Sqrt, Squeeze, Sub, Tile, Transpose, Unsqueeze, Where. All are standard ai.onnx ops with no custom domains.
  - Sin, Cos and Range build the positional embeddings at runtime.
  - Task 4 should confirm onnxruntime-node CPU/CoreML coverage (review focus 5).

### Op that failed, and the workaround

The first `torch.onnx.export` attempt failed with this error:

```
torch.onnx.errors.UnsupportedOperatorError: Exporting the operator 'aten::_native_multi_head_attention' to ONNX opset version 17 is not supported.
```

In eval mode with no_grad, `nn.MultiheadAttention` self-attention takes PyTorch's fused fast path. The fix is `torch.backends.mha.set_fastpath_enabled(False)` before export, which traces the decomposed MatMul/Softmax attention instead. The cross-attention and everything else exported on the first try, and no newer opset was needed.

## Verification

### 1. Torch equivalence on one real chunk (Flim at 60 s, normalised as Separator does)

| Check | max abs diff |
|---|---|
| `HTDemucsCore` + torch `_spec`/`_ispec` vs original `model(mix)` | **0.0** (bit-exact) |
| numpy `spec` vs torch `_spec` | 4.6e-6 |
| numpy `ispec` vs torch `_ispec` (same core output) | 6.0e-7 |
| numpy spec → torch core → numpy ispec vs original | 4.4e-6 (SDR 121.9 dB), output peak 5.5 in normalised units |
| ORT core vs torch core | spec_out 1.6e-3, wave_out 1.1e-3 |
| numpy → ORT → numpy vs original | 1.1e-3 (SDR **76.7 dB**) |
| ORT batch=2 item 0 vs batch=1 | 1.0e-5 |

### 2. Pipeline-only check (`--engine torch`, Flim full track vs baseline float stems)

This run uses the numpy chunking, STFT and overlap-add around the torch core. It scores SDR drums 122.9, bass 116.4, other 117.8 and vocals 113.2 dB, with max sample diff ≤ 3.1e-6. **So the numpy re-implementation of `apply_model` is exact, to float32 rounding.** All the remaining ORT error comes from the ORT core's arithmetic.

Two details had to be matched for this:
- torch's unbiased `std` (ddof=1) in the track normalisation.
- `TensorChunk.padded`'s centred zero padding of the short tail chunks.

FLAC decoding with soundfile is bit-identical to demucs's `sphn.read`, with max diff 0.0 on both tracks.

### 3. Main result: ORT vs PyTorch float baseline, full tracks (S5)

Command: `uv run python run_demucs_ort.py ref/flim.flac ref/inner-city-life.flac`. Results are in `out/ort/results-b1.json`.

| Track | drums | bass | other | vocals | max sample diff |
|---|---|---|---|---|---|
| flim (177.1 s, 31 chunks) | **84.1 dB** | **73.1 dB** | **77.1 dB** | **84.8 dB** | ≤ 3.1e-4 |
| inner-city-life (232.0 s, 40 chunks) | **78.7 dB** | **87.2 dB** | **78.3 dB** | **86.3 dB** | ≤ 2.6e-4 |

**Every stem passes the 30 dB bar by more than 43 dB.** Two runs gave identical numbers, so the result is deterministic.

### 4. Seam check (S6, numeric, replacing listening)

Seam k is the crossfade between chunk k−1 and chunk k, about 1.95 s long. I checked three seams per track, at roughly ¼, ½ and ¾ of the track. Local SDR was measured in ±100 ms windows at three points per seam: the start of chunk k, the overlap midpoint, and the end of chunk k−1.

Reference distribution, from all 200 ms windows of the track, skipping near-silent windows below about −80 dBFS:

| Track | Stem | median | p5 | min |
|---|---|---|---|---|
| flim | drums | 86.7 | 75.4 | 63.0 |
| flim | bass | 75.6 | 56.4 | 47.3 |
| flim | other | 83.3 | 68.4 | 59.6 |
| flim | vocals | 96.7 | 82.4 | 65.7 |
| ICL | drums | 87.1 | 73.2 | 62.0 |
| ICL | bass | 86.6 | 70.8 | 58.5 |
| ICL | other | 82.7 | 70.9 | 60.0 |
| ICL | vocals | 88.2 | 72.1 | 64.0 |

Seam windows, in dB (chunk start / overlap mid / previous chunk end):

| Seam | drums | bass | other | vocals |
|---|---|---|---|---|
| flim 7 (40.95–42.90 s) | 85.8 / 92.1 / 90.5 | 77.0 / 72.2 / 79.3 | 80.9 / 90.3 / 77.6 | 98.3 / 98.3 / 95.3 |
| flim 14 (81.90–83.85 s) | 78.5 / 89.9 / 80.4 | 60.6 / 67.7 / 70.2 | 75.1 / 80.1 / 71.2 | 93.9 / 100.8 / 94.7 |
| flim 22 (128.70–130.65 s) | 87.3 / 84.5 / 83.9 | 74.4 / 93.9 / 83.7 | 77.7 / 88.9 / 84.4 | 94.7 / 91.9 / 85.1 |
| ICL 10 (58.50–60.45 s) | 95.5 / 94.7 / 95.7 | 85.1 / 84.6 / 84.3 | 88.2 / 85.9 / 93.1 | 96.5 / 94.7 / 83.3 |
| ICL 20 (117.00–118.95 s) | 88.0 / 91.0 / 78.2 | 91.5 / 74.3 / 90.9 | 85.1 / 88.3 / 74.3 | 75.0 / 96.9 / 74.2 |
| ICL 29 (169.65–171.60 s) | 84.6 / 82.5 / 81.4 | 90.7 / 91.3 / 91.0 | 64.8 / 73.1 / 72.7 | 85.1 / 87.6 / 77.5 |

- **No seam dips.** All 72 seam windows are at least 60.6 dB, and each sits above its track and stem's global SDR or within the normal spread of all windows.
- One window falls below its stem's 5th percentile: ICL other at seam 29 chunk start, 64.8 dB against a p5 of 70.9. That is above the stem's minimum of 60.0. With 72 windows, about 3.6 would be expected below p5 by chance, so this is not a seam effect.
- **Caveat:** this test measures ORT-vs-PyTorch divergence at seams. Any seam artefact that Demucs itself produces would be in the reference too, and both would match. Since ORT matches PyTorch to about 80 dB, the ORT output sounds like the PyTorch output, seams included.
- **Excerpts for Matt to listen to:** `tools/onnx-spike/out/ort/seams/<track>_seam<k>_<stem>.wav`. These are the 6 seams above, ±2 s around each overlap midpoint, all 4 stems, f32 ORT output: 24 files, 32 MB.

### 5. Timing (M2 Pro, CPU)

| Track | ORT separate (batch 1) | ORT total incl. read + WAV write | PyTorch demix (Task 1) |
|---|---|---|---|
| flim, 177 s | 35.7–37.7 s (3 runs) | 36.1 s | 64.7 s |
| inner-city-life, 232 s | 46.2–46.3 s | 46.8 s | 84.3 s |

- The ORT session is created once: 0.7 s.
- That is about 0.20x real time, roughly 1.15 s per chunk.
  - About 1.0 s of each chunk is the ORT core.
  - The numpy pre-processing takes 0.035 s per chunk and the post-processing 0.078 s.
- On a 5-min track, extrapolated, that is about 60 s.
- For comparison, the torch core inside the same numpy pipeline took 67.8 s on Flim, about the same as baseline.py's 64.7 s. The speed-up is ORT's, not a pipeline difference.
- Batching does not help. On Flim, batch 2 took 44.0 s and batch 4 took 37.9 s, against 35.7 s at batch 1. The runner defaults to batch 1. Default ORT threading was used.

### Numerical tolerances observed

| Comparison | Tolerance |
|---|---|
| ORT core vs torch core, per element | ≤ 1.6e-3 abs on normalised-domain outputs of magnitude about 5 |
| Final stems vs PyTorch, max sample diff | ≤ 3.1e-4 |
| numpy DSP vs torch, max | ≤ 4.6e-6 |
| Batch-size invariance | 1e-5 |

For Task 4, a Node-vs-Python ORT bar of **1e-4 abs may be tight** for `spec_out`. The same model in a different ORT build or EP could differ by more, since it already differs from torch by 1.6e-3. Use a relative bar or SDR if 1e-4 fails.

## Artefacts (gitignored)

- `out/models/htdemucs_core.onnx`: 168.7 MB.
- `out/ort/<name>/{drums,bass,other,vocals}.wav`: f32 stems, unclipped. Task 3 should apply the clip rescale and int16 conversion before allin1, as baseline does.
- `out/ort/results-b1.json`: all numbers above.
  - `results-b2.json` and `results-b4.json` are the Flim-only batch timing runs.
- `out/ort/seams/*.wav`.
- `out/numpy-torch/`: the pipeline-only check, with stems and results.
- `out/tensors/demucs_{mix,spec,spec_out,wave_out}.npy` are for Task 4. They hold chunk 4 of Flim (offset 4·257985 samples, 23.4 s), and are the exact ORT batch-1 inputs and outputs:

| File | Shape | dtype | Size |
|---|---|---|---|
| `demucs_mix.npy` | (1, 2, 343980) | f32 | 2.8 MB |
| `demucs_spec.npy` | (1, 4, 2048, 336) | f32 | 11 MB |
| `demucs_spec_out.npy` | (1, 4, 4, 2048, 336) | f32 | 44 MB |
| `demucs_wave_out.npy` | (1, 4, 2, 343980) | f32 | 11 MB |

## What Plan 3 must port (Demucs side), all in `demucs_dsp.py`

1. **Track normalisation:** `ref = mean over channels`; `(wav − mean(ref)) / (std_unbiased(ref) + 1e-8)`, inverted at the end.
2. **Chunking:** segment 343980 samples, stride 257985, offsets `0, stride, …, < N`.
   - A short tail chunk is read centred: `start = offset − (343980 − len)//2`, zero-filled outside the track. Its output is centre-trimmed back.
   - Overlap-add uses triangular weights, `cat(1..L/2, L−L/2..1) / max`, divided by the summed weights.
3. **`_spec`:**
   - Reflect-pad by 1536 on the left and by `1536 + ceil(L/1024)·1024 − L` on the right.
   - STFT: nfft 4096, hop 1024, periodic Hann, center reflect pad 2048, scaled by 1/√4096.
   - Drop the Nyquist bin and keep frames `[2, 2+336)`.
   - Pack the channels as re/im.
4. **`_ispec`:**
   - Unpack re/im, pad the Nyquist bin back to 0, pad 2 zero frames each side.
   - iSTFT with ×√4096, periodic Hann OLA divided by the Σw² envelope, trimming 2048 from the center.
   - Take `[1536, 1536+L)`, then add `wave_out`.
5. **Write-out:** clip rescale `x / max(1.01·peak, 1)` per stem and int16 conversion, if matching what allin1 analysed. That belongs to Task 3.

## Self-review

- The diff is exactly the three scripts.
- I removed a dead `batch2` dict comprehension from the export script before committing, and split an unreadable print line.
- Not overbuilt. `--engine torch` exists because it proved the pipeline separately from ORT. `--batch` exists because it answered the batching question.
- Concern: `HTDemucsCore.forward` copies `HTDemucs.forward` from the installed demucs 4.1.0. It replaces einops `rearrange` with equivalent `reshape`s. That is fine for a spike, since equivalence is proven bit-exact, but it is tied to that version.
- One process note: running the `--batch` variants overwrote `out/ort/flim` and `results-b1.json`. I re-ran the canonical batch-1 run on both tracks afterwards, so all files in `out/ort/` come from that final run.
