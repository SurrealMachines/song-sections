# Task 1 report: Environment and PyTorch baseline

**Status:** DONE_WITH_CONCERNS. The baseline is the official PyTorch path, using real NATTEN and no monkey-patching. But the baseline Demucs output is **not deterministic**, and that matters for the 30 dB criterion in Task 2 (see Concerns).

Commit: `b4e28e9 spike: allin1 pytorch baseline`. It contains pyproject.toml, uv.lock, baseline.py, .gitignore and .python-version.

## Environment

- Python **3.11.18** (uv-managed), venv at `tools/onnx-spike/.venv`, Apple M2 Pro, macOS (Darwin 25.6), Apple clang 21.0.0.
- Key versions:
  - allin1 1.1.0
  - **natten 0.17.4**, built from source, CPU only
  - torch 2.5.1, torchaudio 2.5.1
  - demucs 4.1.0 (PyPI; homepage adefossez/demucs)
  - **madmom 0.16.1** (PyPI)
  - numpy 1.23.5, onnx 1.23.2, onnxruntime 1.31.1, soundfile 0.14.0, librosa 0.11.0, scipy 1.15.3, huggingface-hub 2.4.0
  - Build-only: cython 0.29.37, setuptools 80.10.2, cmake 4.4.4 (pip)
- Full `uv pip freeze`: allin1==1.1.0 antlr4-python3-runtime==4.9.3 anyio==4.15.1 audioread==3.1.0 certifi==2026.10.23 cffi==2.1.1 charset-normalizer==3.5.2 click==8.5.0 cloudpickle==3.1.2 cmake==4.4.4 contourpy==1.3.2 cycler==0.12.1 cython==0.29.37 decorator==5.3.1 demucs==4.1.0 einops==0.8.2 filelock==4.2.4 flatbuffers==25.12.19 fonttools==4.68.0 fsspec==2026.9.0 h11==0.16.0 hf-xet==1.7.1 httpcore2==2.16.0 httpx2==2.16.0 huggingface-hub==2.4.0 hydra-core==1.3.8 idna==3.20 jinja2==3.1.6 joblib==1.6.0 julius==0.2.8 kiwisolver==1.5.1 lameenc==1.9.0 lazy-loader==0.6 librosa==0.11.0 llvmlite==0.50.0 madmom==0.16.1 markupsafe==3.0.4 matplotlib==3.10.9 mido==1.3.3 ml-dtypes==0.5.4 mpmath==1.3.0 msgpack==1.2.4 natten==0.17.4 networkx==3.6.1 numba==0.68.1 numpy==1.23.5 omegaconf==2.3.1 onnx==1.23.2 onnxruntime==1.31.1 packaging==26.3 pillow==13.0.0 platformdirs==4.14.0 pooch==1.9.0 protobuf==7.36.2 pycparser==3.12 pyparsing==3.3.3 python-dateutil==3.0.0 pyyaml==6.0.3 requests==2.34.2 safetensors==0.8.0 scikit-learn==1.7.2 scipy==1.15.3 setuptools==80.10.2 six==1.17.0 soundfile==0.14.0 soxr==1.1.0 sphn==0.2.1 sympy==1.13.1 threadpoolctl==3.7.0 torch==2.5.1 torchaudio==2.5.1 tqdm==4.70.1 truststore==0.10.5 typing-extensions==4.16.0 tzdata==2026.6 urllib3==2.8.0 wheel==0.48.0

### How NATTEN got installed on macOS arm64 (about 20 min, so not a blocker)

1. allin1 1.1.0 calls the old op names: `natten1dqkrpb`, `natten1dav`, `natten2dqkrpb` and `natten2dav`, with the signature `(q, k, rpb, kernel_size, dilation)`. Those exist only up to NATTEN 0.17.x; 0.20 removed them. PyPI ships only sdists for NATTEN, with no mac wheels.
2. 0.17.5 failed to compile with Apple clang 21. The error is `torch/include/c10/util/strong_type.h:1608: error: 'is_arithmetic' cannot be specialized ... [-Winvalid-specialization]`. Building with `CXXFLAGS=-Wno-invalid-specialization` fixed it.
3. 0.17.5 then failed at import on CPU-only torch: `natten/utils/testing.py` calls `torch.cuda.get_device_capability()` at module import, and that raises `AssertionError: Torch not compiled with CUDA enabled`. **0.17.4 doesn't have that line**, so we pinned 0.17.4.
4. pyproject handles both for `uv sync`:
   - `no-build-isolation-package = ["natten", "madmom"]`: NATTEN must build against the venv's torch.
   - `[tool.uv.extra-build-variables] natten = { CXXFLAGS = "-Wno-invalid-specialization", ... }`.
   - Verified: after uninstalling NATTEN and running `uv cache clean natten`, a plain `uv sync` rebuilt it with no extra environment variables (about 25 s).
   - Trap: if a NATTEN build fails once, uv's cached sdist keeps a stale CMakeCache. Run `uv cache clean natten` before retrying.
5. NATTEN on CPU is the naive kernel. That is slow: about 1.5 s per `natten2dqkrpb` call, and it dominates the inference time below. There are no MPS kernels, so allin1 runs on CPU.

### madmom (deviation from allin1's README)

allin1's README installs madmom with `pip install git+https://github.com/CPJKU/madmom`. **The auto-mode classifier blocked `uv add "madmom @ git+https://github.com/CPJKU/madmom"`.** I used PyPI madmom 0.16.1 (2019) instead, which needed three things:

- `numpy==1.23.5`, because 0.16.1 uses `np.float` and `np.int`, which were removed in numpy 1.24. This is the lowest version that satisfies onnx's `numpy>=1.23.2`.
- `cython<3`, built without isolation.
- `setuptools<81`: madmom imports `pkg_resources`, which setuptools 81+ removed.

baseline.py also aliases `collections.MutableSequence = collections.abc.MutableSequence` before importing allin1, because madmom 0.16.1 imports it from `collections`.

madmom provides allin1's spectrogram front end and the DBN downbeat post-processing. The git master may differ slightly from 0.16.1 in post-processing. If Matt wants the README-exact madmom, he needs to allow the git install (or run it himself).

## What baseline.py does

`uv run python baseline.py ref/flim.flac ref/inner-city-life.flac`

- For each track it calls `allin1.analyze(path, device="cpu", keep_byproducts=True, include_activations=True, multiprocess=False, overwrite=True)`, with demix and spec dirs under `out/baseline/`.
- It times each phase by temporarily wrapping `demix`, `extract_spectrograms`, `load_pretrained_model` and `run_inference` inside `allin1.analyze`'s module.
- Per track it writes:
  - `out/baseline/<name>.json`: source, duration, device, bpm, segments (start, end, label), beats, downbeats, beat_positions, stem WAV format, and timings.
  - `out/baseline/<name>.activ.npz`: raw activations, for comparisons in Tasks 3 and 4.
  - `out/baseline/<name>/{bass,drums,other,vocals}.wav`: copies of the Demucs stems allin1 used.
  - `out/baseline/_spec/<name>.npy`: the stem spectrograms fed to the model (the Task 3 export input). Shapes come from the files: flim 22.9 MB, inner-city-life 30.1 MB.
- `HF_HOME` is set to `tools/onnx-spike/.cache/huggingface`, so all weights stay local. `.cache/` is gitignored, along with `ref/`, `out/`, `*.onnx`, `.venv/` and `__pycache__/`.
- NATTEN's per-call deprecation log spam is silenced. The output still has tqdm bars, one madmom `VisibleDeprecationWarning` and an HF "unauthenticated requests" notice.

## Verification (ran it on the reference set)

Final run: both tracks in one invocation, exit 0, 670 s wall, peak RSS 3.5 GB. Each track produced its JSON and four stem WAVs (44.1 kHz, stereo, PCM_16, length equal to the source).

| Track | Duration | Demix (htdemucs, CPU) | Spectrograms | Model load | Inference + post | Total |
|---|---|---|---|---|---|---|
| flim | 177.1 s | 77.1 s | 1.9 s | 1.9 s | 212.0 s | 292.8 s |
| inner-city-life | 232.0 s | 92.9 s | 2.3 s | 1.6 s | 274.3 s | 371.1 s |

- The first-ever run took longer: demix 102 s and model load 13.1 s, because both included the HF downloads.
- Inference runs at about 1.2x real time. That is the 8-fold ensemble on naive CPU NATTEN.
- Demucs was run on CPU, not MPS. That keeps the baseline on the same device class as ORT, and allin1 passes one device to both stages while NATTEN can't run on MPS.

### Weights (sizes on disk)

- allin1 `harmonix-all` is 8 fold checkpoints `harmonix-fold{0..7}-*.pth`, 1.3 MB each, **11 MB total**, from HF `taejunkim/allinone`.
- htdemucs is `955717e8.safetensors` (**80 MB**) plus `htdemucs.yaml`, from HF `adefossez/HTDemucs`.
  - demucs 4.1.0 downloads from HF, not dl.fbaipublicfiles.
  - The signature `955717e8` matches the original `htdemucs` checkpoint `955717e8-8726e21a.th`.
- Location: `tools/onnx-spike/.cache/huggingface/hub/`.
- Weight licences aren't checked yet (Task 5).

### Segments: current baseline (Demucs shifts=0, deterministic; see Fix round 1)

The first-pass lists from stock allin1 (shifts=1, random) are superseded. In those, Flim had 321 beats and a solo 129.17–155.14 followed by an outro from 155.14, and Inner City Life differed by at most 0.01 s.

**flim** (bpm 150, 328 beats, 82 downbeats):

| start | end | label |
|---|---|---|
| 0.00 | 2.67 | start |
| 2.67 | 28.62 | intro |
| 28.62 | 44.83 | intro |
| 44.83 | 70.76 | inst |
| 70.76 | 86.98 | inst |
| 86.98 | 112.95 | inst |
| 112.95 | 129.17 | solo |
| 129.17 | 147.02 | solo |
| 147.02 | 169.15 | outro |
| 169.15 | 177.11 | end |

**inner-city-life** (bpm 154, 408 beats, 102 downbeats):

| start | end | label |
|---|---|---|
| 0.00 | 0.45 | start |
| 0.45 | 25.29 | verse |
| 25.29 | 44.03 | verse |
| 44.03 | 68.78 | verse |
| 68.78 | 93.56 | verse |
| 93.56 | 105.94 | chorus |
| 105.94 | 118.34 | verse |
| 118.34 | 136.92 | verse |
| 136.92 | 155.51 | chorus |
| 155.51 | 167.89 | chorus |
| 167.89 | 192.66 | break |
| 192.66 | 205.06 | chorus |
| 205.06 | 220.56 | outro |
| 220.56 | 231.98 | end |

## Concerns

1. **The PyTorch baseline is non-deterministic, which the spike's pass criteria must account for.**
   - allin1 runs `demucs.separate` with the defaults `--shifts 1 --overlap 0.25`. In demucs `apply.py`, `shifts=1` means one **unseeded** `random.randint(0, 0.5 s)` time offset.
   - **Stems differ between two runs:** I re-ran Demucs on Flim with identical arguments and compared it with the baseline stems. SDR was bass 15.5 dB, drums 21.3 dB, other 18.9 dB, vocals 24.0 dB. So PyTorch doesn't even match itself to the 30 dB bar.
   - **allin1's output changes with them:**
     - My first Flim run had 316 beats and 79 downbeats, and a single `solo` segment from 112.95 to 155.14.
     - The final run has 321 beats and 81 downbeats, and splits `solo` at 129.17.
     - All other boundaries and labels were identical.
   - Recommendation for the controller (not done, because it changes what "baseline" means):
     - Re-run the baseline with deterministic Demucs, either `--shifts 0` or a seeded or fixed offset. `--shifts 0` is also what an ONNX port would most plausibly do, and it is faster.
     - Task 2 should then compare against that.
     - Task 3's label and boundary criterion also needs Demucs-ORT and the baseline to use the same shift policy. Otherwise label differences can come from Demucs randomness rather than the export.
2. **Clip rescaling.** Demucs's default `--clip-mode rescale` divides a whole stem by `1.01 * peak` when it would clip. The Flim drums stem peaks at exactly 0.9901, so it was rescaled. Task 2's numpy pipeline must apply the same rescale and the int16 quantisation, or SDR will be dominated by a gain error.
3. **madmom 0.16.1 from PyPI instead of git master** (classifier block, see above). Low risk for the spike, but it is not README-exact.
4. **The pin stack is old on purpose:** NATTEN 0.17.4, torch 2.5.1, numpy 1.23.5 and setuptools<81. Later tasks need ONNX export in this venv. torch 2.5.1's exporter supports opset 17, so this should be fine, but note it if Task 2 or 3 wants the dynamo exporter features of newer torch.

## Files

- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/pyproject.toml`
- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/uv.lock`
- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/.python-version`
- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/.gitignore`
- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/baseline.py`
- Outputs (gitignored): `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/out/baseline/`

## Self-review

- The diff is only the committed files above.
- After the final run, baseline.py changed only in its docstring and in dropping an unused `TORCH_HOME` default. I recompiled it and checked it with a no-args run.
- Not overbuilt: activations and specs are kept because Tasks 3 and 4 need them as comparison inputs.

## Fix round 1 (controller rulings S3, S4)

Commit: `8efe89d spike: deterministic demucs (shifts=0) and float stems in baseline`. Only baseline.py changed.

### What changed in baseline.py

**Deterministic Demucs (ruling S3).**
- allin1's `demix` step is now replaced, explicitly and documented in the module docstring and the constants `DEMUCS_SHIFTS = 0` and `DEMUCS_OVERLAP = 0.25`, by an in-process equivalent of `demucs.separate`.
- It builds `demucs.api.Separator(model="htdemucs", device="cpu", shifts=0, overlap=0.25, split=True)`. That is the same Separator and the same `separate_audio_file` call that `demucs.separate` makes, minus the random shift.
- It writes the stems with demucs's own `save_audio(clip="rescale", bits_per_sample=16)`, so allin1 sees exactly what `demucs.separate --shifts 0` would have produced.
- Each JSON now records `"demucs": {"model": "htdemucs", "shifts": 0, "overlap": 0.25}`.

**Float stems (concern 2).**
- New output: `out/baseline/<name>/float/{bass,drums,other,vocals}.wav`. These are float32, the raw network output before clip-rescale and quantisation.
- They are written with soundfile, not demucs's `save_audio(as_float=True)`. **Trap found:** demucs's float WAV encoder silently does `wav.clamp(-1, 1)`. My first float pass came out clipped: Flim drums peaked at exactly 1.0000, while the true peak is 1.0329.

**Other changes.**
- `--out DIR` option, used for the repeatability run.
- The track's cached spectrogram `.npy` is now deleted before each analysis. allin1 silently reuses an existing one even with `overwrite=True`, so a stale spectrogram could have been analysed and its timing read as 0 s.

### Repeatability proof (Flim, two independent runs)

Run A wrote `out/baseline`. Run B was `--out out/baseline-repeat`, separate processes into separate dirs.

| Check | Result |
|---|---|
| int16 stems, all 4 (`cmp`) | **bit-identical** (SDR is infinite) |
| float32 stems, all 4 (`cmp`, both from the clamping writer at that point) | **bit-identical** |
| `_spec/flim.npy` | bit-identical |
| activations (`beat`, `downbeat`, `segment`, `label`) | max abs diff **0.0** |
| segments, beats, downbeats, beat_positions, bpm | **identical** |

- The Flim int16 stems and spectrogram were also bit-identical across two later full runs, after the float-writer and spec-cache fixes.
- Inner City Life's segments, beats and bpm were identical across its two shifts=0 runs too.
- So with shifts=0, PyTorch matches itself exactly on CPU. The earlier 15–24 dB run-to-run spread was entirely the random shift.

### Which stems Task 2 should compare against

**Compare against `out/baseline/<name>/float/*.wav`**, the raw float32 network output. Reasons:
- It isolates the ONNX export from Demucs's write-out policy.
- The int16 files carry 16-bit noise. Their SDR versus the float stems is only 44 dB on Flim's quiet vocals (peak 0.029), against 66–76 dB elsewhere. That noise would eat into the margin.
- Flim drums was rescaled: true peak 1.0329, divided by 1.0433. Its int16 file is only **27.6 dB** from the float stem, below the 30 dB bar even though both come from the same PyTorch output.

If Task 2 wants to compare against the int16 stems that allin1 actually analysed, it must apply `x / max(1.01*peak, 1)` and int16 rounding first. With that, int16 versus rescaled float is 66–76 dB for all loud stems, with max sample diff ≤ 6.1e-5, about 2 LSB.

Only Flim drums was rescaled. No other stem on either track exceeded peak 1.

### Final run (both tracks, shifts=0, fresh spectrograms)

| Track | Demix | Spectrograms | Model load | Inference + post | Total |
|---|---|---|---|---|---|
| flim (177.1 s) | 64.7 s | 1.8 s | 1.5 s | 208.7 s | 276.7 s |
| inner-city-life (232.0 s) | 84.3 s | 2.2 s | 1.4 s | 272.1 s | 360.1 s |

- shifts=0 demix is about 10–15 s faster than shifts=1. The Demucs model load is now included in demix time.
- Segment lists are updated above, in "Segments: current baseline".
  - Flim versus the first-pass run: the solo/outro boundary moved from 155.14 to 147.02, and beats went from 321 to 328.
  - Inner City Life: boundaries moved by at most 0.01 s.

### Ruling S4: madmom

PyPI madmom 0.16.1 is accepted instead of git master. It is pinned with numpy 1.23.5, cython<3, setuptools<81 and the `collections.MutableSequence` alias in baseline.py.

### Outputs

- `/Users/mja/Dev/extensions/song-sections/tools/onnx-spike/out/baseline/` is the canonical baseline.
- `out/baseline-repeat/` holds the Flim repeat run. Its float stems come from the old clamping writer, so don't use them.
- `out/prev/` holds scratch JSON copies used for diffs.
- All three are gitignored.
