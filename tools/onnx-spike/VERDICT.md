# ONNX conversion spike: verdict

**Verdict: PASS (numeric; listening pending Matt).** allin1 (structure) and Demucs htdemucs
(stems) both run in Node 24 through `onnxruntime-node` 1.31.1 on the CPU execution
provider. Results for the full ONNX pipeline (Demucs-ORT → features → allin1-ORT →
post-processing), run through **Python ORT**, match the PyTorch originals on both
reference tracks:

- every boundary is at the same frame (0.0 ms deviation);
- every function label, beat and downbeat is identical, and so is the bpm;
- the stems are 73–87 dB SDR from PyTorch.

**Node's scope.** Node produced bit-identical output to Python ORT (max abs diff 0.0) on
the inputs it ran:
- one Demucs chunk (Flim chunk 4);
- allin1 fold 0 on full Flim;
- the 8-fold mean on full Flim.

Both runtimes use the same ORT 1.31.1 CPU kernels, so the full two-track results carry
over to Node. **No full-track pipeline was run in Node.**

**Speed.** A 5-minute track takes an estimated **~90 s end to end on an M2 Pro CPU**, and
the end-to-end figure is the one that matters. The Structure stages after Demucs take about
22 s. But Structure needs the Demucs stems as its input, so it can't run in 22 s by itself.
Either way, the run is well under the spec's "about real time" target.

**Recommendation:** Plan 3 builds the Structure engine on ONNX in Node, with no Python
helper. The work that remains is TypeScript ports of the DSP around the graphs (listed
below). The biggest of these is madmom's DBN downbeat tracker.

Three items still gate the release:

- **Memory.** The smoke run peaked at **4.08 GB RSS** with all 8 allin1 folds held at once.
  Plan 3 must run the folds in sequence (sections 5.3 and 7).
- **Weight licences** still need confirming (section 6).
- **Listening.** Matt must listen to the seam excerpts in `out/ort/seams/` to close the
  "sounds the same by ear" half of criterion 3b.

Spike dates: started and finished **2026-10-29**. That is **under 1 day of the 3-day
box**: about **2¾ hours** of wall clock in total.

- Plan 2 kicked off at about 19:02, right after Plan 1 merged at 19:00.
- The environment setup and the NATTEN build came before the first spike commit at 19:32.
- This verdict landed at about 21:45–21:47.

Reference set: `ref/flim.flac` (Aphex Twin "Flim", 177.1 s) and `ref/inner-city-life.flac`
(232.0 s). Both are gitignored. The PyTorch baseline uses Demucs `shifts=0`, which is
deterministic (ruling S3). allin1's default `shifts=1` is randomly seeded, so PyTorch
doesn't even match itself to 30 dB: two runs score 15–24 dB SDR against each other, and
their segments differ.

Detailed evidence lives in the task reports, committed in `reports/task-{1..5}-report.md`,
and in `out/`, which is gitignored:

- `out/ort/results-b1.json`
- `out/allin1/export-results.json`
- `out/allin1_ort/results.folds.json`
- Node smoke output from `node/smoke.mjs`

---

## 1. Pass criteria

| # | Criterion (plan header / review focus) | Result | Numbers |
|---|---|---|---|
| 1 | Boundaries within **100 ms** of PyTorch | **PASS** | Max deviation **0.0 ms** on both tracks: 10/10 segments on Flim, 14/14 on Inner City Life. This holds for the full ONNX chain (Demucs-ORT stems → features → allin1-ORT → post-processing). |
| 2 | **Identical** function labels | **PASS** | Every label is identical on both tracks. Beats are also identical (328/328 and 408/408), as are downbeats (82/82 and 102/102), beat positions and bpm (150 and 154). |
| 3a | Stems: SDR **≥ 30 dB** against PyTorch | **PASS** | Flim: drums 84.1, bass 73.1, other 77.1, vocals 84.8 dB. ICL: drums 78.7, bass 87.2, other 78.3, vocals 86.3 dB. The worst stem clears the bar by 43 dB. Max sample diff 3.14e-4 (Flim bass). Compared against the float32 baseline stems (ruling S5). |
| 3b | Stems "sound the same by ear", plus a seam check | **PASS (numeric)**. **Listening is still pending (Matt).** | Ruling S6 replaced listening with a numeric check. I checked 3 chunk seams per track, with ±100 ms windows at 3 points per seam, for 72 windows in total. All are **≥ 60.6 dB** and none dip below the stem's normal spread. Excerpts to listen to are in `out/ort/seams/` (24 WAVs: ±2 s around 6 seams, all 4 stems). Caveat: this check measures ONNX-vs-PyTorch divergence, so a seam artefact that Demucs itself produces would not show up. |
| 4 | Node matches Python ORT | **PASS** (on the inputs Node ran) | On the CPU EP, the max abs diff is **0.0** on every output: the Demucs core on one chunk (Flim chunk 4: `spec_out`, `wave_out`), allin1 fold 0 on full Flim (all 4 logits) and the 8-fold mean computed in JS on full Flim. Criteria 1–3 were measured on both tracks through the Python ORT pipeline, and they carry over to Node by this bit-identity. **No full-track Node pipeline run was done.** The bar was 1e-4. Both use ORT 1.31.1, so the CPU kernels are the same. `make_ref_mean.py` regenerates the 8-fold reference, and `smoke.mjs` fails on NaN or Inf (checked with `--selftest`). |
| 5 | Dynamic length | **PASS** | **allin1** has a dynamic time axis. One exported graph matches NATTEN at 600, 3000, 17711 and 23198 frames. 600 and 3000 frames exercise allin1's short-sequence pad path (< 10240 frames). The minimum input of **5 frames** is inferred from the 2D pad code and was not tested at graph level. **Demucs** has a fixed 343980-sample chunk by design (`apply_model` always pads to the training length) and a dynamic batch axis. Track length is handled by the external chunker: 31 and 40 chunks on the two tracks. |
| 6 | Op support in `onnxruntime-node` | **PASS (CPU EP)**. CoreML is unusable but not needed. | Demucs uses 39 op types and allin1 uses 28 (plus ReduceMean in the unused ensemble graph). All are standard `ai.onnx` ops at opset 17, with no custom domains and all supported on CPU. The CoreML EP is 45x slower on Demucs (47.5 s vs 1.05 s per chunk). On allin1, 2 of 3 flag sets fail at session create or run; the third (0x18) runs but offloads only about 35 trivial nodes, so it is as slow as CPU. On Demucs, 2 of 3 flag sets fail. Causes include rank > 5 tensors, non-constant MatMul B and the dynamic axis. |
| 7 | NATTEN replacement drift (review focus 1) | **PASS** | The pure-torch gather replacement differs from real NATTEN 0.17.4 by at most **5.7e-6** on the final logits, over the full tracks. ORT differs from NATTEN by at most **7.2e-6**. The bar was 1e-4. The difference does not grow with length: 600 frames give the same as 23198. |
| 8 | CPU speed in Node (review focus 4) | **PASS (estimated — DBN timing from Python)** | About 90 s for a 5-min track including stems. allin1 inference with the 8 folds is about 0.06x real time and Demucs about 0.2x. See section 4. |

The Demucs export needed one workaround: `torch.backends.mha.set_fastpath_enabled(False)`,
because `aten::_native_multi_head_attention` has no opset-17 export. allin1 needed NATTEN
replaced by an index-gather implementation (`natten_torch.py`). Ruling S7 explains why a
gather is used rather than `unfold` + mask: NATTEN clamps edge windows rather than masking
them.

---

## 2. Versions

| Component | Version |
|---|---|
| Machine | Apple M2 Pro, macOS (Darwin 25.6), Apple clang 21.0.0 |
| Python | 3.11.18 (uv 0.13.6) |
| allin1 | 1.1.0, model `harmonix-all` (8 folds, HF `taejunkim/allinone` snapshot `379e5fd0`) |
| demucs | 4.1.0, model `htdemucs` (signature `955717e8`, HF `adefossez/HTDemucs` snapshot `cbc8a9b1`) |
| natten | 0.17.4, built from source for CPU (0.17.5 breaks on CPU-only torch; 0.20 removed allin1's ops). Used only for the baseline. |
| madmom | 0.16.1 from PyPI, not git master (ruling S4) |
| torch / torchaudio | 2.5.1 / 2.5.1 |
| numpy | 1.23.5 (madmom 0.16.1 needs < 1.24) |
| onnx | 1.23.2, **opset 17**, TorchScript exporter (`torch.onnx.export`) |
| onnxruntime (Python) | 1.31.1 |
| onnxruntime-node | 1.31.1 (onnxruntime-common 1.31.1), pinned exactly |
| Node | 24.16.0 |
| Others | soundfile 0.14.0, librosa 0.11.0, scipy 1.15.3, huggingface-hub 2.4.0. The full freeze is in Task 1's report and `uv.lock`. |

The pins are old on purpose: NATTEN 0.17.4, torch 2.5.1, numpy 1.23.5 and setuptools<81.
`HTDemucsCore` (in `export_demucs.py`) copies `HTDemucs.forward` from demucs 4.1.0.
`natten_torch.py` copies allin1 1.1.0's `maybe_pad` and NATTEN 0.17.4's index rules. If
any of those versions change, re-run the export scripts and their checks.

---

## 3. Model sizes

| Model | File | Size on disk | Notes |
|---|---|---|---|
| Demucs htdemucs core | `out/models/htdemucs_core.onnx` | **168.7 MB** (168,677,067 B) | 42.0 M params in f32. The source checkpoint `955717e8.safetensors` is 80 MB and appears to be fp16. |
| allin1, one fold | `out/models/allin1_harmonix_fold{0..7}.onnx` | 2.67 MB each (2,671,485 B) | 300,631 params each. The source `.pth` is 1.3 MB. |
| allin1, 8 folds | | **21.4 MB** (21,371,880 B) | **This is what ships** (ruling S8). |
| allin1, single-graph ensemble | `out/models/allin1_harmonix_all.onnx` | 21.2 MB | **Do not use.** Session create takes 31 s, against 7.2 s for the 8 folds. |
| **Combined download** (Demucs + 8 folds) | | **190.0 MB** (190,048,947 B; 181 MiB) | Downloaded on first run into `context.storageDirectory` (release gate). |
| onnxruntime-node runtime, darwin-arm64 | `bin/napi-v6/darwin/arm64/` + `dist/`, `lib/`, `onnxruntime-common` | **about 46.9 MB** | Ships with the extension code, not with the weights. Contents: `libonnxruntime.1.dylib` 45.3 MB, the binding 0.32 MB, JS about 0.1 MB, and `onnxruntime-common` 1.2 MB. |
| onnxruntime-node native, win32 x64 (CPU only) | | about 32 MB | `onnxruntime.dll` plus the binding. The DirectML DLLs (36.5 MB) are not needed. |

**Shrinking Demucs (untested option).** Demucs is 89% of the download.

- **fp16 weights** would bring it to about 84 MB (168.7 / 2). That is close to the 80 MB
  source checkpoint, but it is not the same figure. That could be fp16 initialisers with a
  Cast to f32 at load, or a full fp16 graph. CPU EP
  support and speed for fp16 were not tested.
- **Dynamic int8 quantisation** of Conv, MatMul and Gemm would bring it to about 42 MB.
- Either option must re-pass the 30 dB check and the identical-labels check. Demucs-ORT
  error already reaches allin1's activations at about 3e-4, and int8 error would be much
  larger.

---

## 4. Node timings for a 5-minute track (extrapolated)

All figures are for an **M2 Pro, CPU EP, default ORT threads, a single Node process,
running sessions one after another**. Neither intra-op thread tuning nor parallel fold runs
were tested. The Node figures were measured in Task 4. The feature and DBN figures are
Python/madmom figures from Task 3, because their TypeScript ports don't exist yet.

**Demucs.**

- A 5-min track is 300 s × 44100 = 13,230,000 samples.
- Chunks are 343980 samples (7.8 s) at stride 257985 (overlap 0.25). That gives
  `ceil(13,230,000 / 257,985)` = **52 chunks**. The same formula gives 31 chunks for Flim
  and 40 for Inner City Life, which matches the runs.
- Core: 52 × 1.05–1.09 s (measured per chunk in Node) = **54.6–56.7 s**.
- DSP around the core: 52 × 0.113 s (numpy pre 0.035 s plus post 0.078 s per chunk) =
  5.9 s. The core plus DSP is about **60.5–62.6 s**.
- Cross-check: the Python full-track run averaged 1.15 s per chunk, and 52 × 1.15 = 59.8 s.

**allin1 (8 folds).**

- Measured in Node: 10.1–10.2 s for all 8 folds plus the JS mean on Flim's 17711 frames
  (177.1 s).
- The model is neighbourhood attention, so it is linear in T. Python ORT measured 10.5 s
  on Flim and 13.2 s on ICL's 23198 frames, so the scaling is if anything slightly
  sublinear.
- For 30000 frames: 10.1–10.2 × 300 / 177.1 = **17.1–17.3 s**.

**Post-processing (Python today).**

- Features: 1.8 s × 300 / 177.1 = about **3.0 s**.
- DBN: 1.1 s × 300 / 177.1 = 1.9 s, or 1.7 s × 300 / 232 = 2.2 s. About **2 s**.
- Functional peak picking takes 0.01 s.

**One-time session creation per process.** Demucs takes 0.69 s and the 8 folds take
7.2 s, about **7.9 s**.

| Stage, 5-min track | Seconds |
|---|---|
| Session creation (Demucs 0.69 s + 8 folds 7.2 s; paid on each analysis if sessions are released) | 7.9 |
| Demucs: 52 chunks of core, plus DSP | 60.5–62.6 |
| allin1 features (Python figure) | ~3.0 |
| allin1 8 folds + mean | 17.1–17.3 |
| DBN + functional post (Python figure) | ~2.0 |
| **Total** | **≈ 90–93 s (about 0.3x real time)** |
| Of which the Structure stages after Demucs (features + allin1 + post, excluding loads) | ≈ 22 s (0.07x real time). Structure requires the Demucs stems, so the figure that matters is the end-to-end ≈ 90 s. |

**Memory, a first-class risk (see section 7).** Peak RSS measured with `/usr/bin/time -l`
(Task 4 fix round):

| Run | Peak RSS |
|---|---|
| Whole Node smoke run | **4.08 GB** (4,076,175,360 B) |
| Demucs session, run alone | ≈ 2.0 GB |
| allin1 fold 0, run alone | ≈ 0.66 GB |
| All 8 folds loaded at once | ≈ 4.0 GB, about 0.5 GB per session |

The 0.5 GB per session is most likely the ORT CPU memory arena holding 17711-frame
activations. An earlier figure of "about 300 MB" was end-of-run RSS and was wrong. Running a
full track's 52 Demucs chunks back to back was not measured in Node.

Section 5.3 gives the mitigations, all of them untested. If the folds are created, run and
released one at a time, the 7.2 s of fold creation is paid on every analysis rather than
once per process. The totals above already include it once.

**Caveat.** The DSP, feature and DBN figures come from numpy and madmom's Cython. A plain
TypeScript FFT, filterbank or Viterbi could be several times slower. Even at 5x, which
adds 4 × (5.9 + 3.0 + 2.0) ≈ 44 s for a total of about 135 s, the run stays under real
time.

---

## 5. What Plan 3 must port to TypeScript

Everything outside the two graphs is listed here. The reference implementations are
`demucs_dsp.py` (Demucs, proven exact to float32 rounding against torch: 113–123 dB),
`run_allin1_ort.py` and allin1 1.1.0's `spectrogram.py` and `postprocessing/`.

### 5.1 Demucs pre- and post-processing (`demucs_dsp.py`)

**0. Resampling and channels (untested in the spike).**

- Live renders at the **project sample rate**, and 48 kHz is common. Both graphs assume
  44.1 kHz: htdemucs was trained at 44.1 kHz, and allin1's features hard-code sr 44100
  (hop 441, filterbank bin frequencies).
- In Python, demucs handles this in `convert_audio`
  (`demucs.audio.convert_audio_channels` then `julius.resample_frac(wav, from_sr, 44100)`,
  a windowed-sinc resampler). A mono render is duplicated to 2 channels.
- **Plan 3 needs a TypeScript 48k→44.1k (generally any→44.1k) resampler plus mono→stereo
  up-mix** before step 1.
- **State a match target for this path**, because the spike never ran it. A suggested
  target: the TS resampler is ≥ 90 dB SNR against `julius.resample_frac` on the reference
  tracks rendered at 48 kHz, and the full pipeline from a 48 kHz render gives boundaries
  within 100 ms and identical labels against the PyTorch pipeline on the same 48 kHz
  render. The 44.1 kHz results in this verdict say nothing about it.

**Input to step 1.** 44.1 kHz stereo float.

**1. Track normalisation.**

- `ref = mean over channels`.
- `wav = (wav − mean(ref)) / (std(ref, ddof=1) + 1e-8)`. Note the **unbiased** std.
- Undo this on the output.

**2. Chunk plan.**

- Segment length is 343980 samples; stride is `int(0.75·343980)` = 257985; offsets are
  `0, stride, …` while below N.
- A short tail chunk is read **centred**: `start = offset − (343980 − len)//2`, zero-filled
  outside the track, and its output is centre-trimmed back to `len`.
- Batch 1: larger batches were slower (batch 2 took 44.0 s and batch 4 37.9 s, against
  35.7 s at batch 1).

**3. `_spec` (STFT) for each chunk.**

- Reflect-pad by 1536 on the left and by `1536 + ceil(L/1024)·1024 − L` on the right.
- STFT parameters:
  - nfft 4096, hop 1024;
  - **periodic** Hann window;
  - `center=True` with a reflect pad of 2048;
  - scaled by `1/√4096`.
- Drop the Nyquist bin, which leaves 2048 bins, and keep frames `[2, 2+336)`.

**4. CaC layout.**

- Graph input `spec` is `(1, 4, 2048, 336)` f32, with channels `[L.re, L.im, R.re, R.im]`.
- Graph input `mix` is `(1, 2, 343980)`, the normalised chunk.

**5. Graph outputs.**

- `spec_out` is `(1, 4 sources, 4, 2048, 336)` in the same re/im layout.
- `wave_out` is `(1, 4 sources, 2, 343980)`.
- **Source order: drums, bass, other, vocals.**

**6. `_ispec` (iSTFT).**

- Unpack re/im, set the Nyquist bin back to 0, and pad 2 zero frames on each side.
- iSTFT: multiply by `√4096`, overlap-add with a periodic Hann window, divide by the
  Σw² envelope, and trim 2048 at the centre.
- Take `[1536, 1536+L)`.
- The chunk estimate is `ispec(spec_out) + wave_out`.

**7. Overlap-add.**

- Triangular weights: `concat(1..L/2, L−L/2..1) / max`.
- The short tail chunk's output is centre-trimmed (step 2), but its weights are
  **`weight[:chunk_len]`, taken from the start of the window, not centred**
  (`demucs_dsp.py:184`, as demucs `apply_model` does).
- Each output sample is the weighted sum of chunk estimates divided by the summed weights.
- Then undo the normalisation.

**8. Write-out (optional).** This step keeps the output bit-compatible with what allin1
analysed in the baseline.

- Per stem: `x / max(1.01·max|x|, 1)`, then `clamp(−1, 1)·32767`, **truncated** toward zero
  to int16.
- Skipping the int16 round trip changes the spectrogram by about 1e-3. A difference 4x that
  size changed nothing on the reference set, but that is not proven for all music.
- Flim's drums stem peaks at 1.033, so the rescale does trigger in practice.

**9. float32 stem write-out for the lanes.**

- The lanes use the stems themselves, so Plan 3 must also write them out as float32 WAVs
  (or keep them in memory).
- Use the raw network output, before the clip rescale and int16 step.
- Do **not** clamp. demucs's own float writer silently clamps to ±1, and that clipped Flim
  drums at 1.0 when the true peak was 1.033 (Task 1).

### 5.2 allin1 feature extraction (madmom recipe)

The reference implementation is **`allin1_dsp.py`**. `uv run python allin1_dsp.py --check`
recomputes the baseline spectrograms from the baseline stems and matches allin1/madmom to
≤ 3.1e-7 on all 4 stems of both tracks. Stem order for the model is **bass, drums, other, vocals**, which differs from
Demucs's output order.

**1. Mono.**

- Take the int16 stereo stem and `mean(axis=channels)` in float.
- Cast back to **int16, truncating** (madmom `remix`).

**2. Frames.**

- Frame size 2048 and hop **441.0** (fps 100, sr 44100), with `num_frames = ceil(N/441)`.
- Frame i covers `[int(i·441) − 1024, int(i·441) + 1024)`, zero-padded outside the signal.

**3. Window.**

- `np.hanning(2048)` (the **symmetric** Hann), divided by **32767**.
- The samples stay as raw integers.

**4. STFT.**

- rfft of size 2048; keep bins 0..1023 and drop the Nyquist bin.
- Take `|X|` as float32.

**5. Logarithmic filterbank (81 bands).**

- Bin frequencies are `fftfreq(2048, 1/44100)[:1024]`.
- Centre frequencies are `440·2^(k/12)` for `k ∈ [floor(12·log2(30/440)), ceil(12·log2(17000/440)))`.
- Trim the centres to [30, 17000] with `searchsorted` (left for fmin, right for fmax).
- Map each centre to the nearest bin, with ties going to the upper bin, and remove
  duplicate bins.
- Triangular filters cover consecutive bin triples:
  - the rising edge is `linspace(0,1,c−s,endpoint=False)` and the falling edge is
    `linspace(1,0,e−c,endpoint=False)`;
  - when `e−s < 2`, the filter is a single bin;
  - each filter is **normalised to unit area**.
- The result is a (1024 × 81) f32 matrix.

**6. Log and stack.**

- `log10(S + 1)`.
- Stack to `(4, T, 81)`, then add a batch axis to get `(1, 4, T, 81)` as graph input `spec`.
- No other normalisation is applied.

**Guard.** Reject input with **T < 5 frames**, which is under 50 ms. The 5-frame limit is
inferred from the 2D pad code: the export dropped allin1's time pad for T < 5. It was not
tested at graph level.

### 5.3 allin1 inference and fold averaging

- There is one `InferenceSession` per fold, 8 in all, and creating them takes 7.2 s in
  total.
- **Do not hold all 8 sessions at once:** that peaks at about 4.0 GB RSS. Mitigations for
  Plan 3, **all untested**:
  1. run the folds sequentially: create, run, accumulate the logits into the running mean,
     then release the session (`session.release()`), one fold at a time;
  2. try the session option `enableCpuMemArena: false` and measure both speed and RSS;
  3. release the Demucs session (about 2.0 GB) before starting allin1.

  The target is a peak of about 2 GB or less. Measure it with `/usr/bin/time -l` on a
  full 5-min track.
- Run each fold on `spec`. The outputs are `logits_beat`, `logits_downbeat` and
  `logits_section`, each `(1, T)`, and `logits_function` `(1, 10, T)`.
- Average the **logits** element-wise in float32 across the 8 folds. In Node this is
  identical to the Python mean, and within 4e-6 of allin1's `stack().mean(0)`.
- Do not use the single-graph ensemble (ruling S8).

### 5.4 Functional structure (segments and labels): small port

**1. Local maxima.**

- Compute `p = sigmoid(logits_section)`.
- Run `local_maxima` with filter size **97** (`4·24 + 1`). A value is kept only where it
  equals the max of its ±48 window (padded with −inf); everything else becomes 0.

**2. Peak picking.**

- Use window_past = window_future = **1200 frames**, and zero-pad the sequence.
- A frame is a candidate where it equals the max of its 2401-frame window and is > 0.
- Its strength is `x − (mean(past 1200) + mean(future 1200))/2`.
- A frame is a **boundary** where the strength is > 0.

**3. Times.**

- `frame · 441/44100`.
- Insert 0 and the duration (`T · 0.01`) if they are missing.

**4. Labels.**

- For each segment, compute the mean over its frames of `softmax(logits_function, over the
  10 classes)`.
- Take the argmax and map it to `HARMONIX_LABELS`. Its index order, from allin1 1.1.0
  `config.py`, is:

  | Index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | Label | start | end | intro | outro | break | bridge | inst | solo | verse | chorus |

### 5.5 Metrical structure: madmom `DBNDownBeatTrackingProcessor`. **This is the biggest port.**

**Input.**

- `b = sigmoid(beat)` and `d = sigmoid(downbeat)` (from the fold-mean logits).
- `xbeat = max(1e-8, b − d)` and `no = ((1−b) + (1−d))/2`.
- Normalise `[xbeat, d, no]` to sum to 1, then pass columns `[xbeat, d]`.

**Parameters.**

- `beats_per_bar = [3, 4]`.
- `threshold = cfg.best_threshold_downbeat` = **0.24**, the mean of the 8 folds.
- `fps = 100`.
- madmom defaults:
  - `min_bpm 55`, `max_bpm 215`, so the beat interval is 60·100/215 to 60·100/55 frames;
  - `num_tempi 60`;
  - `transition_lambda 100`, `observation_lambda 16`;
  - `correct = True`.

**Algorithm.**

- Crop to the first and last frame where any activation is ≥ threshold.
- For each bar length, build a `BarStateSpace` with log-spaced tempi and a
  `BarTransitionModel` (exponential tempo-change transitions with λ = 100).
- Build an `RNNDownBeatTrackingObservationModel` (λ = 16).
- Viterbi-decode each HMM and keep the bar length with the higher log-probability. madmom
  does the decode in Cython: port it from `madmom/ml/hmm.pyx` at the **v0.16.1 tag**
  (`HiddenMarkovModel.viterbi`), not from git master.
- State-space sizes with these parameters, computed with madmom's `BarStateSpace`:
  **11,157 states** for a 3/4 bar and **14,876** for 4/4. The decode runs over states × T
  frames.
- `correct`: snap each beat to the activation argmax inside each run of "beat-range"
  states.
- Output `(time, beat number)` pairs. Downbeats are the pairs where `beat number == 1`.

**Quirks to reproduce** (madmom 0.16.1 `features/downbeats.py`, `process`):

- The threshold crop's offset `first` is **added back** to the beat frames before dividing
  by fps (`(beats + first) / fps`, line 327).
- `correct` takes `np.argmax(activations[left:right]) // 2 + left` over the **flattened
  2-column** slice, so it picks the frame holding the larger of the beat and downbeat
  activations (line 318).
- `if idx.any()` tests the index *values*, not emptiness. In the threshold crop (line 274),
  when the only frame with an activation ≥ threshold is frame 0, `idx` holds only zeros, so
  the test is False. The crop becomes empty and the track gets **no beats**. Match this,
  or document the deviation. The same test in `correct` (line 312) cannot hit this case,
  because its change-point list always has an even length with a non-zero end.

**Estimated size.** Several hundred lines of TypeScript, plus a sparse transition matrix.
madmom's source is BSD. Keep its notice in the port; see section 6 for where to get the
licence text.

**Backpointer memory.** Storing backpointers as uint32 (states × frames × 4 B) is very
large. For a 5-min track (30000 frames) that is about 1.34 GB (3/4) and 1.79 GB (4/4). Use
compact uint16 backpointers, since the state counts are below 65536, to halve that. For
long tracks, a chunked or checkpointed Viterbi is better still. Decode the two bar lengths
one after the other, not at once.

Beats and downbeats depend on this; segments and labels do not. An untested shortcut would
be plain peak-picking of beats, but an exact match with the baseline needs the DBN.

### 5.6 Tempo

- **Guard:** if `len(beats) < 2`, return `bpm = None` (allin1 `estimate_tempo_from_beats`).
  Material with few percussive elements can produce this.
- Otherwise, `bpm = mode(round(60 / diff(beats)))` as an int.
- Implement it as `bincount`, then the first entry of `argsort(counts)[::-1]`. Ties follow
  numpy's argsort order, reversed.

### 5.7 Runtime, packaging and host

**Execution provider and sessions.**

- Use the **CPU EP only**. CoreML is slower and fragile (see criterion 6).
- Session create costs 0.69 s for Demucs and 7.2 s for the 8 folds. Run the sessions in
  sequence and release each one, as section 5.3 describes, because of memory.
- Tensors cross as `new ort.Tensor('float32', Float32Array, dims)`.
- `session.run` is async on a native thread pool, so the event loop stays free.

**Bundling.**

- The runtime must be included in the `.ablx` explicitly with
  `extensions-cli package -i <paths>`, listing the `onnxruntime-node` and
  `onnxruntime-common` paths below. They are not picked up by the esbuild bundle.
- `dist/binding.js` loads `../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`
  through a template-string `require`.
- Mark `onnxruntime-node` as **esbuild `external`**.
- Ship `node_modules/onnxruntime-node/{dist,lib,package.json}`, `onnxruntime-common`, and
  only the target's `bin/napi-v6/<plat>/<arch>/`.
- Drop the other platforms: the full `npm install` is 297 MB.
- On Linux x64, `postinstall` fetches CUDA unless `--onnxruntime-node-install=skip` is
  passed. This doesn't matter on macOS or Windows.

**Dylib dedupe.** `libonnxruntime.1.31.1.dylib` is a byte-identical duplicate of
`libonnxruntime.1.dylib`. Ship only the latter, which the binding loads through
`@loader_path`.

**Node permission model.**

- Live's host must allow `--allow-addons`; without it the load fails with
  `ERR_DLOPEN_DISABLED`.
- `--allow-fs-read` must cover the addon directory and the model directory
  (`context.storageDirectory`).
- No fs-write, worker or child-process permission is needed.
- Verified with `node --permission`. The addon's own dyld load is unaffected.

**Notarisation and signing.**

- The binding and dylib are ad-hoc, linker-signed arm64 binaries.
- Not tested: hardened runtime or library validation inside Live's host, and notarised
  `.ablx` distribution. They may need re-signing with the distribution identity.

**Model delivery.**

- Download the 190 MB on first run into `context.storageDirectory`, which is a release
  gate.
- Show progress, verify checksums, and allow resume or retry.
- The hosting location for the converted `.onnx` files is still to be decided, and the
  licences below decide whether the files may be redistributed at all.

---

## 6. Weight licences

Checked locally only. There was no web access in this session, so I read package metadata,
the LICENSE files in the venv and the HF cache under `.cache/huggingface/hub/`.

**Note:** neither HF snapshot in the cache contains a model card or licence file:

- `taejunkim/allinone` contains only the 8 `harmonix-fold*.pth` files;
- `adefossez/HTDemucs` contains only `955717e8.safetensors` and `htdemucs.yaml`.

The ONNX files Plan 3 would host are **derived from these weights**, so the weights' terms
govern redistribution.

| Item | Licence | Status |
|---|---|---|
| allin1 **code** (1.1.0) | **MIT**, © 2023 Taejun Kim (`allin1-1.1.0.dist-info/licenses/LICENSE`, `License-Expression: MIT`) | Confirmed |
| allin1 **weights** (`harmonix-fold0..7`, HF `taejunkim/allinone`) | No licence in the local cache or in the package. The README says they are "trained on the Harmonix Set with 8-fold cross-validation". | **UNCONFIRMED. Must verify before release.** Check the HF model card and repo licence, and the **Harmonix Set** dataset terms (urinieto/harmonixset). Those terms matter if they restrict models trained on the annotations or on the audio used for them. Ask the author if it is still unclear. |
| Demucs **code** (4.1.0) | **MIT**, © Meta Platforms (`demucs-4.1.0.dist-info/licenses/LICENSE`; README: "Demucs is released under the MIT license") | Confirmed |
| Demucs **htdemucs weights** (`955717e8`, HF `adefossez/HTDemucs`) | No separate weights licence locally. The README says the model is "trained on MUSDB HQ + an extra training dataset of 800 songs". | **UNCONFIRMED. Must verify before release.** Check whether the weights fall under the repo's MIT licence. Check whether MUSDB18-HQ's terms or those of the 800-song internal set reach the weights. Check the HF repo's stated licence. |
| madmom (0.16.1), used for the feature recipe and DBN, which Plan 3 **ports** | Source code **BSD**, per the README and package metadata. The 0.16.1 wheel has no top-level LICENSE; only `madmom/models/LICENSE` is present. Copy LICENSE from the madmom repo for the port's notice. Model and data files **CC BY-NC-SA 4.0** (non-commercial; for commercial use, contact JKU's Gerhard Widmer). | Confirmed for our use. allin1 imports only madmom **code**: the spectrogram processors and `DBNDownBeatTrackingProcessor`. It uses none of madmom's model files (checked with grep). A TypeScript port is a BSD derivative, so keep madmom's copyright and BSD notice. |
| NATTEN (0.17.4) | MIT, © Ali Hassani | Not shipped. Used only for the baseline. `natten_torch.py` reimplements its index rules. |
| onnxruntime / onnxruntime-node (1.31.1) | MIT (package metadata) | Confirmed. Ship its third-party notices with the runtime. |

---

## 7. Open risks for Plan 3

1. **The madmom DBN port** (section 5.5) is the largest and least-proven piece. It needs
   several hundred lines of TypeScript and a Viterbi over 11,157 (3/4) to 14,876 (4/4)
   states per frame. Port it with a golden test against madmom's output on the reference
   set: 328/328 and 408/408 beats.

   Backpointers stored as uint32 would take about 1.3–1.8 GB on a 5-min track, and more on
   longer tracks. The TypeScript port should use uint16 backpointers or a chunked Viterbi
   (section 5.5).
2. **Memory.** Peak RSS was **4.08 GB** for the Node smoke run. The Demucs session alone
   takes about 2.0 GB, one allin1 fold about 0.66 GB, and all 8 folds held at once about
   4.0 GB. That is a lot for Live's extension host. The mitigations in section 5.3 are
   untested:
   - create, run and release the folds one at a time;
   - try `enableCpuMemArena: false`;
   - release the Demucs session before allin1.

   Plan 3 must measure peak RSS on a full 5-min track before choosing.
3. **A 190 MB download on first run**, plus about 46.9 MB of onnxruntime-node runtime in
   the extension. Demucs is 168.7 MB of it. fp16 or int8 could roughly halve or quarter that,
   but that is untested and must re-pass the criteria. The download also needs progress,
   resume and checksums, and somewhere licence-compatible to host it.
4. **Weight licences are unconfirmed** for both allin1 (Harmonix Set) and htdemucs
   (MUSDB HQ + 800 songs). This is a release gate. If either licence forbids
   redistribution, the extension cannot host the converted ONNX files itself; for example,
   it might have to convert them on the user's machine, which defeats the purpose.

   An **untested alternative**: ship only the graphs, with no weights, and at first run
   download the original weights from their HF repos (`taejunkim/allinone`,
   `adefossez/HTDemucs`), loading them as **external initialisers** into the graph. That
   avoids redistributing derived weights, but it still depends on the weights' terms
   permitting use, and it needs a TypeScript loader for `.pth` (pickle) and safetensors.
5. **Notarisation and library validation.** The ad-hoc-signed `libonnxruntime.1.dylib` and
   binding have not been tested inside Live's (hardened?) host or in a notarised `.ablx`.
   Also confirm that Live's extension host allows `--allow-addons`.
6. **Windows is untested.** The win32 x64 and arm64 binaries exist in the package (about
   32 MB CPU-only), but nothing was run in the Windows guest.
7. **Only two reference tracks, both 3–4 minutes long.** Dynamic length is covered by the
   excerpts (600 and 3000 frames). There was no very long track (over 10 min) and no
   memory measurement over a full 52-chunk run in Node.
8. **Listening.** Matt still needs to listen to the seam excerpts in `out/ort/seams/` to
   satisfy the "sounds the same by ear" half of criterion 3b.
9. **Version coupling.** `HTDemucsCore` and `natten_torch` copy demucs 4.1.0, allin1 1.1.0
   and NATTEN 0.17.4 internals. Re-export only with the same pins, or re-verify. The
   numbers are also against PyPI madmom 0.16.1, not git master (ruling S4).
10. **Sample rate and channels.** The pipeline assumes 44.1 kHz stereo, but Live renders at
   the project rate (48 kHz is common). Plan 3 needs a TypeScript any→44.1 kHz resampler
   (demucs uses `julius.resample_frac`) and mono→stereo up-mix, with the match target in
   section 5.1 step 0. None of this was tested in the spike.

## 8. Files

Committed:

- `pyproject.toml`, `uv.lock`, `baseline.py`
- `demucs_dsp.py`, `export_demucs.py`, `run_demucs_ort.py`
- `natten_torch.py`, `export_allin1.py`, `run_allin1_ort.py`
- `allin1_dsp.py`: the numpy feature recipe, with `--check` against the baseline
- `node/{package.json,package-lock.json,smoke.mjs}`. `smoke.mjs` is NaN-safe and has
  `--selftest`.
- `make_ref_mean.py`, which writes the 8-fold Python ORT mean reference to
  `out/tensors/allin1_mean_*.npy` for `smoke.mjs`
- `reports/task-{1..5}-report.md`: the task reports (detailed evidence)
- this file

Gitignored, local only:

- `ref/`
- `out/models/*.onnx`
- `out/baseline/`, `out/ort/`, `out/allin1*/`, `out/tensors/`
- `.cache/huggingface/`

To reproduce, run these in order from `tools/onnx-spike/`, with the reference audio in
`ref/`:

1. `uv sync`
2. `uv run python baseline.py ref/*.flac`
3. `uv run python export_demucs.py`
4. `uv run python run_demucs_ort.py ref/flim.flac ref/inner-city-life.flac`
5. `uv run python export_allin1.py`
6. `uv run python run_allin1_ort.py`
7. `uv run python make_ref_mean.py`
8. `cd node && npm ci && node smoke.mjs`

Optionally, `uv run python allin1_dsp.py --check` after step 2.

**Warning:** after re-running the baseline (step 2), delete `out/allin1/natten_*.npz`
before step 5. `export_allin1.py` caches the real-NATTEN reference logits keyed by track
name only (`export_allin1.py:105`), so a stale cache would be silently compared against
new spectrograms. Each script's docstring has its options; the reports in `reports/` have
the details.
