# Task 5 report: Verdict

**Status:** DONE_WITH_CONCERNS. The concerns are documentation items, not doubts about the
verdict; they are listed at the end.

Commit: `5ce2c1e spike: onnx verdict`. Only `tools/onnx-spike/VERDICT.md` was committed,
with `git add <path>`.

## What was written

`tools/onnx-spike/VERDICT.md` gives an overall verdict of **PASS** and recommends that
Plan 3 run ONNX in Node with no Python helper. Its sections:

1. **Pass criteria, PASS or FAIL with numbers.**
   - Boundaries deviate by 0.0 ms; labels, beats, downbeats and bpm are identical.
   - Stem SDR is 73.1–87.2 dB.
   - The seam check gives ≥ 60.6 dB over 72 windows (ruling S6). Listening by Matt is
     still pending.
   - Node vs Python ORT differs by 0.0.
   - Dynamic length: allin1 was tested at 600, 3000, 17711 and 23198 frames. Demucs uses a
     fixed chunk by design.
   - Op support: CPU EP PASS; CoreML is unusable.
   - NATTEN drift ≤ 7.2e-6.
   - CPU speed PASS.
2. **Versions.**
3. **Model sizes, taken from byte counts in `out/models`.** Demucs is 168.7 MB, the 8 folds
   21.4 MB, and the two combined 190.0 MB. The native runtime is 45.7 MB on darwin-arm64
   and about 32 MB on win32 x64. fp16 and int8 are noted as untested shrink options.
4. **5-minute timings, with the arithmetic shown.**
   - Demucs: 52 chunks × 1.05–1.09 s, plus 0.113 s of DSP per chunk, = 60.5–62.6 s.
   - allin1: 10.1–10.2 s × 300/177.1 = 17.1–17.3 s.
   - Features about 3 s, DBN about 2 s, session loads 7.9 s.
   - Total about 90–93 s, or about 0.3x real time, measured as M2 Pro CPU single-process.
   - The chunk formula was cross-checked against the 31 and 40 chunks the real runs used.
5. **Port list for Plan 3.**
   - Demucs DSP: normalisation, chunk plan, STFT/iSTFT, CaC layout, overlap-add, write-out.
   - Feature recipe, fold averaging, functional peak picking and labels.
   - DBN, with its parameters re-read from madmom and allin1's `metrical.py`.
   - Tempo.
   - The T < 5 frame guard.
   - Packaging and host items: esbuild external, `bin/napi-v6`, `--allow-addons`, CPU EP
     only, dylib dedupe, re-signing.
   - Stem order also differs between the two models, which the port has to handle: Demucs
     outputs drums, bass, other, vocals, and allin1's features take bass, drums, other,
     vocals.
6. **Weight licences, checked locally.**
   - Confirmed:
     - allin1 code is MIT, © 2023 Taejun Kim;
     - demucs code is MIT, © Meta;
     - onnxruntime-node is MIT;
     - madmom source is BSD and its model files are CC BY-NC-SA. allin1 uses only madmom's
       code; I checked this with grep.
   - **UNCONFIRMED:** the allin1 weights (Harmonix Set) and the htdemucs weights (MUSDB HQ
     plus 800 songs). Neither HF snapshot contains a model card or licence file.
7. **Open risks.**
8. **Days spent.** The whole spike ran on 2026-10-29, under 1 day of the 3-day box: about
   3 h of wall clock, from 19:32 to 21:40 by commit times, plus the verdict.

## Verification

This was a documentation task with no tests (ruling S1). I checked every number against
the Task 1–4 reports and progress.md. The sizes were re-measured with `ls -la out/models`,
and the extrapolations were recomputed with a small Python one-liner: 52 chunks; 54.6/56.7
and 60.5/62.6 s; 17.1/17.3 s; 190,048,947 B.

## Concerns

1. **Download size.** The brief's open-risk wording says "215 MB+ model download". The
   measured combined size of the weights that ship (Demucs plus 8 folds) is **190.0 MB**.
   Adding the 45.7 MB native runtime gives about 236 MB. I could not reproduce the 215
   figure, so VERDICT.md states the measured numbers.
2. **Licences.** Without web access, the weight licences could only be marked UNCONFIRMED.
   This is a release gate that is still open.
3. **Sample rate.** The 44.1 kHz stereo assumption, and the resampling it may need, is my
   inference from the pipeline, not something the spike tested. It is flagged as such in
   VERDICT.md.
4. **Other changes in the working tree.** `tools/onnx-spike/node/smoke.mjs` is modified and
   `tools/onnx-spike/make_ref_mean.py` is untracked. These are probably the concurrent
   Task 4 work. I did not touch or commit them.

## Fix round 1: coordinator correction (Task 4 fix round, 26ea173)

Commit: `a268695 spike: onnx verdict — memory risk and Task 4 fix-round updates`. This is a
follow-up commit, not an amend, and it changes VERDICT.md only.

**Headline.** It now names memory as a second item, alongside the licences, that still
needs work before release: the smoke run peaked at 4.08 GB RSS.

**Section 4.** The wrong figures were "about 520 MB for Demucs" and "about 300 MB for
allin1"; the 300 MB was end-of-run RSS. They are replaced by a peak-RSS table:

| Run | Peak RSS |
|---|---|
| Whole run | 4.08 GB (4,076,175,360 B, from `/usr/bin/time -l`) |
| Demucs | ≈ 2.0 GB |
| allin1 fold 0 | ≈ 0.66 GB |
| All 8 folds at once | ≈ 4.0 GB |

The section also notes that releasing sessions means paying the 7.2 s fold creation on
every analysis. The session-creation row in the timing table says the same.

**Sections 5.3 and 5.7.** These now carry the mitigations, all marked untested:
- create, run and release the folds sequentially, with a running mean;
- `enableCpuMemArena: false`;
- release the Demucs session before allin1;
- measure peak RSS on a full 5-min track.

**Section 7.** Memory is added as risk 2, and the other risks are renumbered 3–10.

**Criterion 4 row and section 8.** These note that:
- `make_ref_mean.py` now regenerates the 8-fold reference, and it is listed among the
  committed files;
- `smoke.mjs` is NaN-safe and has `--selftest`.

**Verification.** I read the diff and checked the figures against the updated
task-4-report.md: lines 42, 115–122 and 152–154. A grep finds no stale "300 MB" or
"520 MB" claim left; the only "300 MB" is the sentence saying that figure was wrong.

## Fix round 2: VERDICT.md review (fix round 1)

Commit: `73cdc7f spike: onnx verdict — review fix round 1`. This is a new commit that
changes VERDICT.md only.

### Important

1. **Listening.**
   - The headline now reads "PASS (numeric; listening pending Matt)".
   - Listening to the seam excerpts is the third item that still gates the release.
2. **What Node actually ran.**
   - The headline and the criterion 4 cell now name the inputs Node ran:
     - one Demucs chunk (Flim chunk 4);
     - fold 0 on Flim;
     - the 8-fold mean on Flim.
   - The two-track equality was measured through the Python ORT pipeline and carries over
     to Node by bit-identity.
   - Full-track Node runs are marked untested.
3. **Time spent.**
   - Now about 2¾ hours: kickoff at about 19:02 (Plan 1 merged at 19:00) to the verdict at
     about 21:45–21:47.
   - The `5ce2c1e` commit time is 21:45:34.

### Minors

- **CoreML on allin1:** 2 of 3 flag sets fail; 0x18 runs but offloads only about 35
  trivial nodes.
- **Runtime size:**
  - now 46.9 MB everywhere: the dylib 45.3 MB, the binding 0.32 MB, JS 0.1 MB and
    onnxruntime-common 1.2 MB;
  - the 45.7 MB figure is gone.
- **fp16 size:** now given as 168.7 / 2 ≈ 84 MB, and distinguished from the 80 MB source
  checkpoint.
- **Structure timing:** the ≈ 22 s figure is clarified as excluding Demucs, which Structure
  requires; the end-to-end time is ≈ 90 s. This is fixed in the headline and in the timing
  table.
- **Minimum length:** "min 5 frames" is now marked as inferred and untested at graph level,
  in criterion 5 and in the 5.2 guard.
- **Additions to the port list:**
  - the HARMONIX_LABELS index table (from allin1 `config.py`: start, end, intro, outro,
    break, bridge, inst, solo, verse, chorus);
  - the `len(beats) < 2 → bpm None` guard (read from allin1 `postprocessing/tempo.py`);
  - item 5.1.9, float32 stem write-out for the lanes, with no clamp.
- **DBN state space and backpointers:**
  - State counts are 11,157 (3/4) and 14,876 (4/4). I computed them with madmom
    `BarStateSpace(b, 60·100/215, 60·100/55, 60)` in the venv.
  - uint32 backpointers on 30000 frames would take 1.34 GB and 1.79 GB.
  - The port should use uint16 or a chunked Viterbi. This is in 5.5 and in risk 1.
- **madmom licence:** "BSD per README/metadata; the 0.16.1 wheel has no top-level LICENSE
  (only `madmom/models/LICENSE`), so copy LICENSE from the madmom repo".

### Verification

I read the diff. A grep confirms that no "45.7", "10⁴", "3 hours" or "Structure alone"
remains.
