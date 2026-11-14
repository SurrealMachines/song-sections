"""Export allin1 (harmonix-all ensemble, and each of its 8 folds) to ONNX, dynamic time axis.

    uv run python export_allin1.py [--tracks flim inner-city-life]

The exported graph is the allin1 model on its spectrogram input, with NATTEN replaced by
the pure-torch ops in natten_torch.py:

    input    spec              (1, 4, T, 81)  float32  stem log-spectrograms, stems ordered
                                                       bass, drums, other, vocals
    outputs  logits_beat       (1, T)         float32
             logits_downbeat   (1, T)
             logits_section    (1, T)
             logits_function   (1, 10, T)     HARMONIX_LABELS order

T (frames at 100 fps) is dynamic. `harmonix_all` averages the 8 folds' logits inside the
graph, exactly as allin1's Ensemble does. `harmonix_fold<i>` is one fold; averaging the 8
folds' logits on the host gives the same result, and the 8 small sessions load in ~8 s in
total where the single 8-fold graph takes ~30 s (ORT session creation grows faster than
linearly with graph size).

Checks, all on the baseline spectrograms (out/baseline/_spec/<name>.npy, full tracks):

1. Reference logits from the stock model with the **real** NATTEN 0.17.4 ops (slow: the
   naive CPU kernels; cached in out/allin1/natten_<model>_<name>.npz). Also checked
   against the baseline's saved activations.
2. The patched (pure-torch) model in torch vs that reference: max abs diff, bar 1e-4.
3. The ONNX exports in onnxruntime (CPU) vs the same reference, on both full tracks and
   on two short excerpts (6 s and 30 s, shorter than the 102 s that triggers allin1's
   per-layer padding, so that path is exercised too): the ensemble graph, the mean of
   the 8 fold graphs, and fold 0 alone against stock fold 0.

Writes out/models/allin1_<model>.onnx, out/allin1/export-results.json, and the fold-0
input/output tensors for the Node smoke test (out/tensors/allin1_*.npy).
"""

import argparse
import collections
import collections.abc
import json
import logging
import os
import time
import warnings
from pathlib import Path

# madmom 0.16.1 (imported by allin1) still uses collections.MutableSequence.
collections.MutableSequence = collections.abc.MutableSequence

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(HERE / ".cache" / "huggingface"))

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
from torch import nn  # noqa: E402
from allin1.models import load_pretrained_model  # noqa: E402

import natten_torch  # noqa: E402

# allin1 1.1.0 calls NATTEN's deprecated op names, which log a warning on every call.
logging.getLogger("natten.functional").setLevel(logging.ERROR)

OPSET = 17
OUTPUTS = ("logits_beat", "logits_downbeat", "logits_section", "logits_function")
# Stock models whose real-NATTEN logits are the references (fold 0 also checked alone).
MODELS = {"harmonix_all": "harmonix-all", "harmonix_fold0": "harmonix-fold0"}
EXCERPTS = {"6s": (6000, 6600), "30s": (6000, 9000)}  # frame ranges of flim
BAR = 1e-4
OUT = HERE / "out"


class LogitsOnly(nn.Module):
    """allin1 model -> tuple of the four logits (drops the embeddings output)."""

    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model
        # allin1's Ensemble holds its folds in a plain list; register them so their
        # weights export as initializers rather than traced constants.
        self.folds = nn.ModuleList(getattr(model, "models", []))

    def forward(self, spec: torch.Tensor):
        with natten_torch.shared_neighborhoods():  # no-op for the stock NATTEN model
            out = self.model(spec)
        return tuple(getattr(out, k) for k in OUTPUTS)


def load_spec(name: str) -> np.ndarray:
    return np.load(OUT / "baseline" / "_spec" / f"{name}.npy")[None]  # (1, 4, T, 81)


def run_torch(model: nn.Module, spec: np.ndarray) -> dict:
    with torch.no_grad():
        out = LogitsOnly(model)(torch.from_numpy(spec))
    return {k: v.numpy() for k, v in zip(OUTPUTS, out)}


def max_diff(a: dict, b: dict) -> dict:
    return {k: float(np.abs(a[k] - b[k]).max()) for k in OUTPUTS}


def reference_logits(models: dict, key: str, name: str, spec: np.ndarray, tag: str) -> tuple:
    """Stock-NATTEN logits, cached on disk because the naive CPU kernels are slow."""
    path = OUT / "allin1" / f"natten_{key}_{tag}.npz"
    if path.is_file():
        return dict(np.load(path)), None
    start = time.perf_counter()
    logits = run_torch(models[key], spec)
    seconds = time.perf_counter() - start
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, **logits)
    return logits, seconds


def check_against_baseline_activations(name: str, logits: dict) -> dict:
    """The reference logits must reproduce what baseline.py saved (same model, same input)."""
    act = np.load(OUT / "baseline" / f"{name}.activ.npz")
    sig = lambda x: 1 / (1 + np.exp(-x.astype(np.float64)))  # noqa: E731
    f = torch.softmax(torch.from_numpy(logits["logits_function"][0]), dim=0).numpy()
    return {
        "beat": float(np.abs(sig(logits["logits_beat"][0]) - act["beat"]).max()),
        "downbeat": float(np.abs(sig(logits["logits_downbeat"][0]) - act["downbeat"]).max()),
        "segment": float(np.abs(sig(logits["logits_section"][0]) - act["segment"]).max()),
        "label": float(np.abs(f - act["label"]).max()),
    }


def export(model: nn.Module, example: np.ndarray, path: Path) -> float:
    path.parent.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    with torch.no_grad(), warnings.catch_warnings():
        # The tracer flags 3 Python branches: allin1's `was_padded` and `logits.shape[1]
        # == 1`, and the instrument pad in natten_torch._maybe_pad_2d. All depend only on
        # static sizes (4 instruments, 1 class), never on T; the excerpt checks in ORT
        # confirm the graph generalises across lengths.
        warnings.simplefilter("ignore", torch.jit.TracerWarning)
        torch.onnx.export(
            LogitsOnly(model),
            (torch.from_numpy(example),),
            str(path),
            opset_version=OPSET,
            input_names=["spec"],
            output_names=list(OUTPUTS),
            dynamic_axes={
                "spec": {2: "frames"},
                "logits_beat": {1: "frames"},
                "logits_downbeat": {1: "frames"},
                "logits_section": {1: "frames"},
                "logits_function": {2: "frames"},
            },
        )
    seconds = time.perf_counter() - start
    onnx.checker.check_model(str(path))
    return seconds


def run_ort(session: ort.InferenceSession, spec: np.ndarray) -> tuple:
    start = time.perf_counter()
    out = session.run(list(OUTPUTS), {"spec": spec})
    return dict(zip(OUTPUTS, out)), time.perf_counter() - start


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--tracks", nargs="+", default=["flim", "inner-city-life"])
    args = parser.parse_args()

    results = {"opset": OPSET, "bar": BAR, "models": {}, "tracks": {}}
    specs = {name: load_spec(name) for name in args.tracks}
    excerpt_src = specs.get("flim", next(iter(specs.values())))
    excerpts = {k: np.ascontiguousarray(excerpt_src[:, :, a:b]) for k, (a, b) in EXCERPTS.items()}

    # 1. Stock model (real NATTEN) reference logits.
    stock = {key: load_pretrained_model(name, device="cpu") for key, name in MODELS.items()}
    refs = {}
    for key in MODELS:
        for name, spec in {**specs, **{f"excerpt-{k}": v for k, v in excerpts.items()}}.items():
            if key != "harmonix_all" and name.startswith("excerpt"):
                continue
            logits, seconds = reference_logits(stock, key, name, spec, name)
            refs[key, name] = logits
            entry = results["tracks"].setdefault(name, {}).setdefault(key, {})
            entry["frames"] = int(spec.shape[2])
            if seconds is not None:
                entry["natten_torch_s"] = round(seconds, 1)
            if key == "harmonix_all" and name in specs:
                entry["natten_vs_baseline_activations"] = check_against_baseline_activations(name, logits)
            print(f"[natten] {key} {name}: T={spec.shape[2]}"
                  + (f", {seconds:.1f} s" if seconds is not None else " (cached)"))

    # 2. Patched model in torch vs the reference.
    patched = {key: natten_torch.patch_model(m) for key, m in stock.items()}
    for (key, name), ref in refs.items():
        spec = specs.get(name, excerpts.get(name.removeprefix("excerpt-")))
        start = time.perf_counter()
        logits = run_torch(patched[key], spec)
        seconds = time.perf_counter() - start
        diff = max_diff(logits, ref)
        entry = results["tracks"][name][key]
        entry["patched_torch_s"] = round(seconds, 2)
        entry["patched_vs_natten_maxabs"] = diff
        print(f"[patched] {key} {name}: {seconds:.1f} s, max abs diff {max(diff.values()):.2e}  {diff}")

    # 3. Export and check in onnxruntime: the single-graph ensemble, and each fold on its
    #    own (fold i = the ensemble's i-th member), whose logits the host averages.
    example = specs.get("flim", next(iter(specs.values())))
    to_export = {"harmonix_all": patched["harmonix_all"]}
    to_export.update({f"harmonix_fold{i}": m for i, m in enumerate(patched["harmonix_all"].models)})
    sessions = {}
    for key, model in to_export.items():
        path = OUT / "models" / f"allin1_{key}.onnx"
        export_s = export(model, example, path)
        graph = onnx.load(str(path))
        start = time.perf_counter()
        sessions[key] = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        results["models"][key] = {
            "path": str(path.relative_to(HERE)),
            "bytes": path.stat().st_size,
            "nodes": len(graph.graph.node),
            "export_s": round(export_s, 1),
            "session_create_s": round(time.perf_counter() - start, 2),
            "op_types": sorted({n.op_type for n in graph.graph.node}),
            "params": int(sum(np.prod(t.dims) for t in graph.graph.initializer)),
        }
        m = results["models"][key]
        print(f"[export] {path.name}: {m['bytes'] / 1e6:.2f} MB, {m['nodes']} nodes, exported in "
              f"{export_s:.1f} s, ORT session created in {m['session_create_s']:.2f} s")

    folds = [k for k in to_export if k != "harmonix_all"]
    for (rkey, name), ref in refs.items():
        spec = specs.get(name, excerpts.get(name.removeprefix("excerpt-")))
        entry = results["tracks"][name][rkey]
        runs = {"ort": (rkey,)}
        if rkey == "harmonix_all":
            runs["ort_folds_mean"] = tuple(folds)  # 8 fold sessions, logits averaged here
        for stage, keys in runs.items():
            outs, seconds = zip(*(run_ort(sessions[k], spec) for k in keys))
            logits = {k: np.mean(np.stack([o[k] for o in outs]), axis=0) for k in OUTPUTS}
            diff = max_diff(logits, ref)
            entry[f"{stage}_s"] = round(sum(seconds), 2)
            entry[f"{stage}_vs_natten_maxabs"] = diff
            print(f"[{stage}] {rkey} {name}: {sum(seconds):.2f} s, max abs diff {max(diff.values()):.2e}  {diff}")
        if rkey == "harmonix_fold0" and name == "flim":
            tensors = OUT / "tensors"
            tensors.mkdir(parents=True, exist_ok=True)
            np.save(tensors / "allin1_spec.npy", spec)
            for k, v in outs[0].items():
                np.save(tensors / f"allin1_{k}.npy", v)

    (OUT / "allin1").mkdir(parents=True, exist_ok=True)
    (OUT / "allin1" / "export-results.json").write_text(json.dumps(results, indent=2))
    worst = {
        stage: max(max(e[stage].values()) for t in results["tracks"].values() for e in t.values())
        for stage in ("patched_vs_natten_maxabs", "ort_vs_natten_maxabs")
    }
    worst["ort_folds_mean_vs_natten_maxabs"] = max(
        max(t["harmonix_all"]["ort_folds_mean_vs_natten_maxabs"].values()) for t in results["tracks"].values())
    print(f"\nworst max abs diff vs real NATTEN: {worst}  (bar {BAR})")


if __name__ == "__main__":
    main()
