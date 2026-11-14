"""Reference for node/smoke.mjs: mean of the 8 allin1 fold logits from Python ORT.

Runs the 8 fold models in out/models on out/tensors/allin1_spec.npy (CPU EP) and
writes the element-wise float32 mean of each logit array to
out/tensors/allin1_mean_<output>.npy. smoke.mjs compares its JS average to these.

Usage: uv run python make_ref_mean.py
"""
from pathlib import Path

import numpy as np
import onnxruntime as ort

OUT = Path(__file__).parent / "out"
NAMES = ["logits_beat", "logits_downbeat", "logits_section", "logits_function"]

spec = np.load(OUT / "tensors" / "allin1_spec.npy")
acc = {n: None for n in NAMES}
for k in range(8):
    sess = ort.InferenceSession(
        str(OUT / "models" / f"allin1_harmonix_fold{k}.onnx"),
        providers=["CPUExecutionProvider"],
    )
    outs = dict(zip([o.name for o in sess.get_outputs()], sess.run(None, {"spec": spec})))
    for n in NAMES:
        acc[n] = outs[n] if acc[n] is None else acc[n] + outs[n]
for n in NAMES:
    np.save(OUT / "tensors" / f"allin1_mean_{n}.npy", (acc[n] / 8).astype(np.float32))
print(f"onnxruntime {ort.__version__}: wrote allin1_mean_*.npy")
