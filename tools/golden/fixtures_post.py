"""Post-processing fixtures (Plan 3, Task 6; Task 7 reads them too).

Copies the Flim 8-fold mean logits and runs allin1's own postprocess_functional_structure,
postprocess_metrical_structure and estimate_tempo_from_beats on them. Writes flim_post.json.
"""
import json
import shutil
from types import SimpleNamespace

import torch

from common import FIXTURES, SPIKE  # noqa: F401  (also puts the spike on sys.path and patches collections)

from allin1.config import HARMONIX_LABELS
from allin1.postprocessing.functional import postprocess_functional_structure
from allin1.postprocessing.metrical import postprocess_metrical_structure
from allin1.postprocessing.tempo import estimate_tempo_from_beats
from allin1.typings import AllInOneOutput

import numpy as np

TENSORS = SPIKE / "out" / "tensors"
CFG = SimpleNamespace(fps=100, hop_size=441, sample_rate=44100, min_hops_per_beat=24, best_threshold_downbeat=0.24)


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    logits = {}
    for name in ("beat", "downbeat", "section", "function"):
        src = TENSORS / f"allin1_mean_logits_{name}.npy"
        shutil.copyfile(src, FIXTURES / f"flim_logits_{name}.npy")
        logits[name] = torch.from_numpy(np.load(src))

    out = AllInOneOutput(
        logits_beat=logits["beat"],
        logits_downbeat=logits["downbeat"],
        logits_section=logits["section"],
        logits_function=logits["function"],
    )
    segments = postprocess_functional_structure(out, CFG)
    metrical = postprocess_metrical_structure(out, CFG)
    bpm = estimate_tempo_from_beats(metrical["beats"])
    assert all(s.label in HARMONIX_LABELS for s in segments)

    post = {
        "frames": int(logits["section"].shape[-1]),
        "cfg": {"fps": CFG.fps, "hop_size": CFG.hop_size, "sample_rate": CFG.sample_rate,
                "min_hops_per_beat": CFG.min_hops_per_beat, "best_threshold_downbeat": CFG.best_threshold_downbeat},
        "segments": [{"start": float(s.start), "end": float(s.end), "label": s.label} for s in segments],
        "beats": metrical["beats"],
        "downbeats": metrical["downbeats"],
        "beat_positions": metrical["beat_positions"],
        "bpm": bpm,
    }
    path = FIXTURES / "flim_post.json"
    path.write_text(json.dumps(post, indent=1))
    print(f"wrote {path} ({len(post['segments'])} segments, {len(post['beats'])} beats, bpm {bpm})")


if __name__ == "__main__":
    main()
