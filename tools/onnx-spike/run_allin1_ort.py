"""Run allin1 in ONNX Runtime, from the Demucs-ORT stems, and compare with the baseline.

    uv run python run_allin1_ort.py [--tracks flim inner-city-life] [--model folds|harmonix_all]

Two runs per track, each compared with the PyTorch baseline (out/baseline/<name>.json):

  baseline-spec  allin1-ORT on the baseline's own spectrograms (out/baseline/_spec):
                 isolates the allin1 export from any Demucs-ORT difference.
  ort-stems      the full ONNX pipeline:
                   Task 2's Demucs-ORT float stems (out/ort/<name>/*.wav)
                   -> demucs's write-out (clip rescale, int16 WAV), as baseline.py does
                   -> allin1's feature extraction (allin1.spectrogram, madmom), unchanged
                   -> allin1-ORT: by default the 8 fold models (allin1_harmonix_fold<i>.onnx)
                      with their logits averaged here, as allin1's Ensemble does; or the
                      single-graph ensemble (--model harmonix_all)
                   -> allin1's post-processing (allin1.postprocessing, incl. madmom's
                      DBN downbeat tracker), unchanged

Pass criterion (plan): every segment boundary within 100 ms of the baseline and identical
labels. Beats, downbeats and bpm are compared too. Writes
out/allin1_ort/<name>.<run>.<model>.json and out/allin1_ort/results.<model>.json.
"""

import argparse
import collections
import collections.abc
import json
import os
import time
from pathlib import Path

# madmom 0.16.1 (imported by allin1) still uses collections.MutableSequence.
collections.MutableSequence = collections.abc.MutableSequence

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(HERE / ".cache" / "huggingface"))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from allin1.models import load_pretrained_model  # noqa: E402
from allin1.postprocessing import (  # noqa: E402
    estimate_tempo_from_beats,
    postprocess_functional_structure,
    postprocess_metrical_structure,
)
from allin1.spectrogram import extract_spectrograms  # noqa: E402
from allin1.typings import AllInOneOutput  # noqa: E402
from demucs.audio import save_audio  # noqa: E402

OUT = HERE / "out"
WORK = OUT / "allin1_ort"
STEMS = ("bass", "drums", "other", "vocals")
OUTPUTS = ("logits_beat", "logits_downbeat", "logits_section", "logits_function")
MODELS = {"folds": [f"harmonix_fold{i}" for i in range(8)], "harmonix_all": ["harmonix_all"]}
BOUNDARY_TOL_S = 0.1


def write_stems(name: str) -> tuple:
    """Demucs-ORT float stems -> int16 WAVs exactly as demucs.separate writes them."""
    stem_dir = WORK / "_demix" / name
    stem_dir.mkdir(parents=True, exist_ok=True)
    max_lsb = {}
    for stem in STEMS:
        audio, sr = sf.read(OUT / "ort" / name / f"{stem}.wav", dtype="float32")
        save_audio(torch.from_numpy(audio.T.copy()), stem_dir / f"{stem}.wav", sr,
                   clip="rescale", bits_per_sample=16, as_float=False)
        ours = sf.read(stem_dir / f"{stem}.wav", dtype="int16")[0].astype(np.int32)
        base = sf.read(OUT / "baseline" / name / f"{stem}.wav", dtype="int16")[0].astype(np.int32)
        max_lsb[stem] = int(np.abs(ours - base).max())
    return stem_dir, max_lsb


def ort_stem_spectrogram(name: str) -> tuple:
    stem_dir, max_lsb = write_stems(name)
    spec_dir = WORK / "_spec"
    (spec_dir / f"{name}.npy").unlink(missing_ok=True)  # allin1 silently reuses a stale one
    start = time.perf_counter()
    (spec_path,) = extract_spectrograms([stem_dir], spec_dir, multiprocess=False)
    seconds = time.perf_counter() - start
    return np.load(spec_path), seconds, max_lsb


def postprocess(logits: dict, cfg) -> tuple:
    out = AllInOneOutput(**{k: torch.from_numpy(v) for k, v in logits.items()})
    timings = {}
    start = time.perf_counter()
    metrical = postprocess_metrical_structure(out, cfg)
    timings["metrical_dbn_s"] = time.perf_counter() - start
    start = time.perf_counter()
    segments = postprocess_functional_structure(out, cfg)
    timings["functional_s"] = time.perf_counter() - start
    result = {
        "bpm": estimate_tempo_from_beats(metrical["beats"]),
        "segments": [{"start": float(s.start), "end": float(s.end), "label": s.label} for s in segments],
        **metrical,
    }
    return result, timings


def activations(logits: dict) -> dict:
    sig = lambda x: torch.sigmoid(torch.from_numpy(x[0])).numpy()  # noqa: E731
    return {
        "beat": sig(logits["logits_beat"]),
        "downbeat": sig(logits["logits_downbeat"]),
        "segment": sig(logits["logits_section"]),
        "label": torch.softmax(torch.from_numpy(logits["logits_function"][0]), dim=0).numpy(),
    }


def compare_events(ours: list, base: list) -> dict:
    """Event-time agreement: counts, and each baseline event's distance to our nearest."""
    ours, base = np.asarray(ours), np.asarray(base)
    if len(ours) == 0 or len(base) == 0:
        return {"count": len(ours), "baseline_count": len(base)}
    dist = np.abs(base[:, None] - ours[None, :]).min(axis=1)
    return {
        "count": int(len(ours)),
        "baseline_count": int(len(base)),
        "identical": bool(len(ours) == len(base) and np.allclose(ours, base, atol=1e-9)),
        "max_dist_s": float(dist.max()),
        "within_10ms": int((dist <= 0.0105).sum()),
        "within_70ms": int((dist <= 0.07).sum()),
    }


def compare(result: dict, base: dict) -> dict:
    ours_seg, base_seg = result["segments"], base["segments"]
    ours_b = np.array([s["start"] for s in ours_seg] + [ours_seg[-1]["end"]])
    base_b = np.array([s["start"] for s in base_seg] + [base_seg[-1]["end"]])
    same_count = len(ours_seg) == len(base_seg)
    if same_count:
        boundary_dev = np.abs(ours_b - base_b)
    else:  # nearest-match each baseline boundary
        boundary_dev = np.abs(base_b[:, None] - ours_b[None, :]).min(axis=1)
    labels_ok = same_count and [s["label"] for s in ours_seg] == [s["label"] for s in base_seg]
    boundaries_ok = same_count and bool((boundary_dev <= BOUNDARY_TOL_S).all())
    return {
        "pass": bool(boundaries_ok and labels_ok),
        "segments": len(ours_seg),
        "baseline_segments": len(base_seg),
        "labels_identical": bool(labels_ok),
        "boundaries_within_100ms": boundaries_ok,
        "max_boundary_dev_s": float(boundary_dev.max()),
        "beats": compare_events(result["beats"], base["beats"]),
        "downbeats": compare_events(result["downbeats"], base["downbeats"]),
        "beat_positions_identical": result["beat_positions"] == base["beat_positions"],
        "bpm": result["bpm"],
        "baseline_bpm": base["bpm"],
    }


def infer(sessions: list, spec: np.ndarray) -> dict:
    """Run every session on (1, 4, T, 81) and average their logits (Ensemble's mean)."""
    outs = [s.run(list(OUTPUTS), {"spec": spec[None]}) for s in sessions]
    return {k: np.mean(np.stack([o[i] for o in outs]), axis=0) for i, k in enumerate(OUTPUTS)}


def run(sessions: list, cfg, spec: np.ndarray, name: str) -> dict:
    start = time.perf_counter()
    logits = infer(sessions, spec)
    infer_s = time.perf_counter() - start
    result, post_t = postprocess(logits, cfg)
    base = json.loads((OUT / "baseline" / f"{name}.json").read_text())
    base_act = np.load(OUT / "baseline" / f"{name}.activ.npz")
    act = activations(logits)
    return {
        "result": result,
        "comparison": compare(result, base),
        "activations_vs_baseline_maxabs": {k: float(np.abs(act[k] - base_act[k]).max()) for k in act},
        "timings_s": {"ort_inference_s": infer_s, **post_t},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--tracks", nargs="+", default=["flim", "inner-city-life"])
    parser.add_argument("--model", choices=list(MODELS), default="folds")
    args = parser.parse_args()

    # allin1's post-processing reads its thresholds from the model config (the Ensemble
    # averages the folds' best_threshold_*); load the torch ensemble only for that config.
    cfg = load_pretrained_model("harmonix-all", device="cpu").cfg
    start = time.perf_counter()
    sessions = [ort.InferenceSession(str(OUT / "models" / f"allin1_{m}.onnx"),
                                     providers=["CPUExecutionProvider"]) for m in MODELS[args.model]]
    summary = {"model": args.model, "session_create_s": time.perf_counter() - start,
               "best_threshold_downbeat": float(cfg.best_threshold_downbeat), "tracks": {}}
    WORK.mkdir(parents=True, exist_ok=True)

    for name in args.tracks:
        base_spec = np.load(OUT / "baseline" / "_spec" / f"{name}.npy")
        ort_spec, spec_s, max_lsb = ort_stem_spectrogram(name)
        runs = {"baseline-spec": base_spec, "ort-stems": ort_spec}
        summary["tracks"][name] = track = {
            "frames": int(base_spec.shape[1]),
            "ort_stems_int16_vs_baseline_max_lsb": max_lsb,
            "ort_stems_spec_vs_baseline_maxabs": float(np.abs(ort_spec - base_spec).max()),
            "spectrogram_s": spec_s,
        }
        for run_name, spec in runs.items():
            record = run(sessions, cfg, spec, name)
            (WORK / f"{name}.{run_name}.{args.model}.json").write_text(json.dumps(record, indent=2))
            track[run_name] = {k: v for k, v in record.items() if k != "result"}
            c, t = record["comparison"], record["timings_s"]
            print(f"\n== {name} [{run_name}] {'PASS' if c['pass'] else 'FAIL'}: "
                  f"{c['segments']}/{c['baseline_segments']} segments, labels identical "
                  f"{c['labels_identical']}, max boundary dev {c['max_boundary_dev_s'] * 1000:.1f} ms; "
                  f"beats {c['beats']['count']}/{c['beats']['baseline_count']} "
                  f"(max {c['beats']['max_dist_s'] * 1000:.1f} ms), downbeats "
                  f"{c['downbeats']['count']}/{c['downbeats']['baseline_count']} "
                  f"(max {c['downbeats']['max_dist_s'] * 1000:.1f} ms), bpm {c['bpm']}/{c['baseline_bpm']}")
            print(f"   ORT {t['ort_inference_s']:.2f} s, DBN {t['metrical_dbn_s']:.2f} s, "
                  f"functional {t['functional_s']:.3f} s; activations vs baseline "
                  + ", ".join(f"{k} {v:.1e}" for k, v in record["activations_vs_baseline_maxabs"].items()))
            for s in record["result"]["segments"]:
                print(f"   {s['start']:8.2f} - {s['end']:8.2f}  {s['label']}")
        print(f"   spectrogram from ORT stems: {spec_s:.1f} s; vs baseline spec max abs "
              f"{track['ort_stems_spec_vs_baseline_maxabs']:.2e}; int16 stems max diff {max_lsb} LSB")

    print(f"\nORT sessions ({args.model}) created in {summary['session_create_s']:.1f} s")
    (WORK / f"results.{args.model}.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
