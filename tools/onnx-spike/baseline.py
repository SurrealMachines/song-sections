"""PyTorch baseline for the ONNX spike.

Usage: uv run python baseline.py [--out DIR] ref/flim.flac ref/inner-city-life.flac

For each track this runs allin1.analyze (Demucs htdemucs stems -> spectrograms ->
harmonix-all ensemble -> post-processing) on CPU and writes, under DIR
(default out/baseline):

  <name>.json                          segments, beats, downbeats, bpm, timings
  <name>.activ.npz                     raw model activations (for later ORT comparisons)
  <name>/{bass,drums,other,vocals}.wav the int16 stems allin1 analysed
  <name>/float/{...}.wav               the same stems as float32, before clip-rescale
                                       and quantisation (raw network output, unclamped)
  _spec/<name>.npy                     the stem spectrograms fed to the allin1 model

Deviation from stock allin1 (controller ruling S3): allin1 1.1.0 shells out to
`demucs.separate` with its default `--shifts 1`, which applies one unseeded random time
offset, so stems and even allin1's boundaries change from run to run. This script
replaces allin1's `demix` step with an in-process equivalent that runs the same
htdemucs Separator with **shifts=0** (deterministic; what the extension would ship).
Everything else matches `demucs.separate`'s defaults (overlap 0.25, split on, int16 WAV,
clip-mode rescale).

Model weights (allin1 and, since demucs 4.1, htdemucs too) come from the Hugging Face
Hub and are cached under .cache/huggingface so their size on disk is easy to measure
and nothing lands in the global caches.
"""

import argparse
import collections
import collections.abc
import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path

# madmom 0.16.1 (the latest PyPI release) still imports MutableSequence from
# `collections`, which Python 3.10 removed. Restore the alias before allin1 imports it.
collections.MutableSequence = collections.abc.MutableSequence

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(HERE / ".cache" / "huggingface"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import allin1  # noqa: E402
from demucs.api import Separator  # noqa: E402
from demucs.audio import save_audio  # noqa: E402

# allin1 1.1.0 calls NATTEN's pre-0.17 op names, which log a deprecation warning per call.
logging.getLogger("natten.functional").setLevel(logging.ERROR)

# `allin1.analyze` the attribute is the function; the module holds the phase helpers.
analyze_module = sys.modules["allin1.analyze"]

STEMS = ("bass", "drums", "other", "vocals")
DEVICE = "cpu"  # NATTEN has no MPS kernels; CPU also matches what ORT will be compared on.
DEMUCS_MODEL = "htdemucs"
DEMUCS_SHIFTS = 0  # stock allin1 uses demucs.separate's default of 1 (random offset)
DEMUCS_OVERLAP = 0.25  # demucs.separate default, unchanged


def make_deterministic_demix(out_dir: Path):
    """Build a drop-in for allin1's `demix(paths, demix_dir, device)` with shifts=0.

    Writes `<demix_dir>/htdemucs/<stem-name>/<stem>.wav` exactly as `demucs.separate`
    would (int16, clip-mode rescale), and additionally the unclipped float32 stems
    to `<out_dir>/<name>/float/`.
    """

    def demix(paths, demix_dir, device):
        separator = Separator(
            model=DEMUCS_MODEL,
            device=str(device),
            shifts=DEMUCS_SHIFTS,
            overlap=DEMUCS_OVERLAP,
            split=True,
            progress=True,
        )
        demix_paths = []
        for path in paths:
            print(f"=> Demixing {path.name} with {DEMUCS_MODEL}, shifts={DEMUCS_SHIFTS}")
            _, sources = separator.separate_audio_file(path)
            track_dir = demix_dir / DEMUCS_MODEL / path.stem
            float_dir = out_dir / path.stem / "float"
            track_dir.mkdir(parents=True, exist_ok=True)
            float_dir.mkdir(parents=True, exist_ok=True)
            for stem, source in sources.items():
                save_audio(source, track_dir / f"{stem}.wav", separator.samplerate,
                           clip="rescale", bits_per_sample=16, as_float=False)
                # Not save_audio(as_float=True): demucs's float encoder clamps to [-1, 1].
                sf.write(float_dir / f"{stem}.wav", source.t().cpu().numpy(),
                         separator.samplerate, subtype="FLOAT")
            demix_paths.append(track_dir)
        return demix_paths

    return demix


def timed(name, fn, timings):
    """Wrap one of allin1.analyze's phase helpers so its wall time lands in `timings`."""

    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            timings[name] = timings.get(name, 0.0) + time.perf_counter() - start

    return wrapper


def stem_format(path: Path) -> dict:
    info = sf.info(path)
    return {
        "samplerate": info.samplerate,
        "channels": info.channels,
        "subtype": info.subtype,
        "frames": info.frames,
    }


def analyze_track(path: Path, out_dir: Path) -> dict:
    demix_dir = out_dir / "_demix"
    spec_dir = out_dir / "_spec"
    # allin1 reuses an existing spectrogram file even with overwrite=True; drop it so the
    # spectrogram always comes from this run's stems (and its timing is real).
    (spec_dir / f"{path.stem}.npy").unlink(missing_ok=True)
    timings = {}
    phases = {
        "demix": make_deterministic_demix(out_dir),
        "extract_spectrograms": analyze_module.extract_spectrograms,
        "load_pretrained_model": analyze_module.load_pretrained_model,
        "run_inference": analyze_module.run_inference,
    }
    originals = {name: getattr(analyze_module, name) for name in phases}
    for name, fn in phases.items():
        setattr(analyze_module, name, timed(name, fn, timings))
    try:
        start = time.perf_counter()
        result = allin1.analyze(
            path,
            device=DEVICE,
            demix_dir=demix_dir,
            spec_dir=spec_dir,
            keep_byproducts=True,
            include_activations=True,
            multiprocess=False,
            overwrite=True,
        )
        timings["total"] = time.perf_counter() - start
    finally:
        for name, fn in originals.items():
            setattr(analyze_module, name, fn)

    name = path.stem
    stem_dir = out_dir / name
    for stem in STEMS:
        shutil.copyfile(demix_dir / DEMUCS_MODEL / name / f"{stem}.wav", stem_dir / f"{stem}.wav")

    np.savez(out_dir / f"{name}.activ.npz", **result.activations)

    audio = sf.info(path)
    record = {
        "source": path.name,
        "duration_s": audio.frames / audio.samplerate,
        "device": DEVICE,
        "demucs": {"model": DEMUCS_MODEL, "shifts": DEMUCS_SHIFTS, "overlap": DEMUCS_OVERLAP},
        "bpm": result.bpm,
        "segments": [
            {"start": s.start, "end": s.end, "label": s.label} for s in result.segments
        ],
        "beats": result.beats,
        "downbeats": result.downbeats,
        "beat_positions": result.beat_positions,
        "stems": {stem: stem_format(stem_dir / f"{stem}.wav") for stem in STEMS},
        "float_stems": {stem: stem_format(stem_dir / "float" / f"{stem}.wav") for stem in STEMS},
        "timings_s": {
            "demix": timings["demix"],
            "spectrograms": timings["extract_spectrograms"],
            "model_load": timings["load_pretrained_model"],
            "inference_and_postprocess": timings["run_inference"],
            "total": timings["total"],
        },
    }
    (out_dir / f"{name}.json").write_text(json.dumps(record, indent=2))
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("tracks", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, default=HERE / "out" / "baseline")
    args = parser.parse_args()

    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    for track in args.tracks:
        path = track.resolve()
        record = analyze_track(path, out_dir)
        t = record["timings_s"]
        print(
            f"\n== {path.name} ({record['duration_s']:.1f} s): "
            f"demix {t['demix']:.1f} s, spectrograms {t['spectrograms']:.1f} s, "
            f"model load {t['model_load']:.1f} s, inference {t['inference_and_postprocess']:.1f} s, "
            f"bpm {record['bpm']}, {len(record['beats'])} beats, "
            f"{len(record['downbeats'])} downbeats"
        )
        for seg in record["segments"]:
            print(f"   {seg['start']:8.2f} - {seg['end']:8.2f}  {seg['label']}")


if __name__ == "__main__":
    main()
