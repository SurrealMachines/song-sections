"""Split the v1 ONNX models into weightless graphs plus a weight map (fb/hfmodels).

    <spike>/.venv/bin/python tools/hfmodels/build_models.py \
        --v1 <dir with the 9 v1 .onnx files> --sources <dir with the 9 source checkpoints> [--out models]

<spike> is the onnx-spike checkout (tools/onnx-spike on branch spike/onnx), whose venv has torch 2.5.1, onnx,
onnxruntime and safetensors. `--sources` may be a Hugging Face snapshot folder (symlinks are fine).

For each v1 model `<name>.onnx` it writes, under `--out`:

- `<name>.onnx`: the same graph, with every initializer moved to ONNX external data in `<name>.weights`
  (`location`, `offset`, `length`; offsets 64-byte aligned, zero padding). Nothing else changes: the nodes, the
  embedded Constant nodes (shapes, windows: no checkpoint source) and the model metadata are v1's.
- an entry in `weightmap.json`: for each initializer its name, dims, offset and length in `<name>.weights`, and its
  source (checkpoint file, tensor key, the source's dtype and shape, and the axis permutation, if any, that turns
  the source tensor into the initializer). Every initializer is float32; a float16 source is widened exactly.
  Plus the sha256 of the whole `<name>.weights` and of the graph, which the runtime checks after building.

How sources are found: each v1 initializer is matched against every checkpoint tensor by value (sorted values as a
permutation-invariant fingerprint), then confirmed byte for byte after the transform. A key named like the
initializer wins; otherwise the first match in key order. The script fails if any initializer has no source.

Checks before writing anything: (1) every initializer rebuilt from its source is byte-identical to v1's; (2) the
weightless graph loaded with its external data has the same initializers (name, dims, bytes) and the same nodes,
inputs and outputs as v1; (3) ONNX Runtime (CPU) gives bit-identical outputs for v1 and the rebuilt model on a
random input.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import shutil
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import numpy_helper
from safetensors import safe_open

ALIGN = 64
MODEL_SET = "allin1-htdemucs-hf-v1"

# The pinned sources (verified via the HF API, 31 Oct 2026). Licence: allin1 MIT (model card), Demucs code MIT.
ALLIN1 = {"repo": "taejunkim/allinone", "revision": "379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19"}
DEMUCS = {"repo": "adefossez/HTDemucs", "revision": "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003"}
FOLD_FILES = [
    "harmonix-fold0-0vra4ys2.pth",
    "harmonix-fold1-3ozjhtsj.pth",
    "harmonix-fold2-gmgo0nsy.pth",
    "harmonix-fold3-i92b7m8p.pth",
    "harmonix-fold4-1bql5qo0.pth",
    "harmonix-fold5-x4z5zeef.pth",
    "harmonix-fold6-x7t226rq.pth",
    "harmonix-fold7-qwwskhg6.pth",
]
DEMUCS_FILE = "955717e8.safetensors"
# v1 model -> (its source file, the prefix the export put before the checkpoint's keys)
MODELS = {"htdemucs_core.onnx": (DEMUCS_FILE, "m.")}
MODELS.update({f"allin1_harmonix_fold{i}.onnx": (f, "model.") for i, f in enumerate(FOLD_FILES)})


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_source(path: Path) -> dict[str, np.ndarray]:
    """Checkpoint tensors by key, in their stored dtype. `.pth`: allin1's Lightning-style {"state_dict": ...}."""
    if path.suffix == ".pth":
        ckpt = torch.load(path, map_location="cpu", weights_only=True)
        return {k: v.numpy() for k, v in ckpt["state_dict"].items()}
    with safe_open(str(path), framework="np") as f:
        return {k: f.get_tensor(k) for k in f.keys()}


def fingerprint(a: np.ndarray) -> str:
    return hashlib.sha1(np.sort(a.astype(np.float32).ravel()).tobytes()).hexdigest()


def transformed(src: np.ndarray, perm: tuple[int, ...] | None) -> bytes:
    """The bytes the runtime writes: widen to float32, permute axes, C order."""
    a = src.astype(np.float32)
    if perm is not None:
        a = a.transpose(perm)
    return np.ascontiguousarray(a).tobytes()


def find_source(name: str, target: np.ndarray, src: dict, by_fp: dict, prefix: str):
    want = target.tobytes()
    keys = sorted(by_fp.get(fingerprint(target), []), key=lambda k: (prefix + k != name, k))
    for k in keys:
        s = src[k]
        if s.size != target.size:
            continue
        for perm in itertools.permutations(range(s.ndim)):
            p = None if perm == tuple(range(s.ndim)) else perm
            if transformed(s, p) == want:
                return k, p
    raise SystemExit(f"no checkpoint source for initializer {name} {list(target.shape)}")


def split(model_path: Path, source_path: Path, prefix: str, out_dir: Path, source_index: int) -> dict:
    name = model_path.name
    weights_name = name.removesuffix(".onnx") + ".weights"
    v1 = onnx.load(str(model_path))
    src = load_source(source_path)
    by_fp: dict[str, list[str]] = {}
    for k, v in src.items():
        by_fp.setdefault(fingerprint(v), []).append(k)

    graph = onnx.ModelProto()
    graph.CopyFrom(v1)
    tensors = []
    offset = 0
    weights_path = out_dir / weights_name
    with open(weights_path, "wb") as w:
        for t in graph.graph.initializer:
            a = numpy_helper.to_array(t)
            if a.dtype != np.float32 or t.data_location == onnx.TensorProto.EXTERNAL or not t.HasField("raw_data"):
                raise SystemExit(f"{name}: initializer {t.name} is not an embedded float32 raw_data tensor")
            key, perm = find_source(t.name, a, src, by_fp, prefix)
            data = t.raw_data
            assert transformed(src[key], perm) == data  # (1)
            pad = (-offset) % ALIGN
            w.write(b"\0" * pad)
            offset += pad
            w.write(data)
            s = src[key]
            entry = {
                "name": t.name,
                "dims": [int(d) for d in t.dims],
                "offset": offset,
                "length": len(data),
                "source": source_index,
                "key": key,
                "dtype": {np.dtype("float32"): "float32", np.dtype("float16"): "float16"}[s.dtype],
                "shape": [int(d) for d in s.shape],
            }
            if perm is not None:
                entry["perm"] = list(perm)
            tensors.append(entry)
            del t.external_data[:]
            t.ClearField("raw_data")
            t.data_location = onnx.TensorProto.EXTERNAL
            for k, v in (("location", weights_name), ("offset", str(offset)), ("length", str(len(data)))):
                e = t.external_data.add()
                e.key, e.value = k, v
            offset += len(data)
    graph_path = out_dir / name
    graph_path.write_bytes(graph.SerializeToString())
    return {
        "name": name,
        "v1": {"bytes": model_path.stat().st_size, "sha256": sha256(model_path)},
        "graph": {"bytes": graph_path.stat().st_size, "sha256": sha256(graph_path)},
        "weights": {"name": weights_name, "bytes": weights_path.stat().st_size, "sha256": sha256(weights_path)},
        "tensors": tensors,
    }


def strip_initializers(m: onnx.ModelProto) -> bytes:
    c = onnx.ModelProto()
    c.CopyFrom(m)
    del c.graph.initializer[:]
    return c.SerializeToString()


def check_model(v1_path: Path, graph_path: Path) -> None:
    """(2) and (3) for one model: the rebuilt one (graph + .weights) against v1."""
    v1 = onnx.load(str(v1_path))
    rebuilt = onnx.load(str(graph_path), load_external_data=True)
    assert strip_initializers(v1) == strip_initializers(rebuilt), f"{graph_path.name}: graph differs from v1"
    assert len(v1.graph.initializer) == len(rebuilt.graph.initializer)
    for a, b in zip(v1.graph.initializer, rebuilt.graph.initializer):
        assert a.name == b.name and list(a.dims) == list(b.dims) and a.data_type == b.data_type
        assert a.raw_data == b.raw_data, f"{graph_path.name}: {a.name} differs"

    rng = np.random.default_rng(0)
    if graph_path.name.startswith("htdemucs"):
        feeds = {"mix": rng.standard_normal((1, 2, 343980), dtype=np.float32),
                 "spec": rng.standard_normal((1, 4, 2048, 336), dtype=np.float32)}
    else:
        feeds = {"spec": rng.standard_normal((1, 4, 700, 81), dtype=np.float32)}
    outs = []
    for p in (v1_path, graph_path):
        s = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
        outs.append(s.run(None, feeds))
        del s
    for x, y in zip(*outs):
        assert x.tobytes() == y.tobytes(), f"{graph_path.name}: ORT outputs differ"


def dump_weightmap(weightmap: dict) -> str:
    compact = lambda v: json.dumps(v, separators=(",", ":"))  # noqa: E731
    lines = ["{"]
    lines += [f' "{k}": {compact(weightmap[k])},' for k in ("modelSet", "align")]
    lines.append(' "sources": [')
    lines.append(",\n".join(f"  {compact(s)}" for s in weightmap["sources"]))
    lines.append(" ],")
    lines.append(' "models": [')
    models = []
    for m in weightmap["models"]:
        head = {k: v for k, v in m.items() if k != "tensors"}
        body = ",\n".join(f"    {compact(t)}" for t in m["tensors"])
        models.append(f"  {compact(head)[:-1]},\"tensors\":[\n{body}\n  ]}}")
    lines.append(",\n".join(models))
    lines.append(" ]")
    lines.append("}")
    text = "\n".join(lines)
    assert json.loads(text) == weightmap
    return text


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--v1", type=Path, required=True)
    ap.add_argument("--sources", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("models"))
    args = ap.parse_args()

    sources = []
    for f in [DEMUCS_FILE, *FOLD_FILES]:
        p = args.sources / f
        origin = DEMUCS if f == DEMUCS_FILE else ALLIN1
        sources.append({"file": f, **origin, "bytes": p.stat().st_size, "sha256": sha256(p)})
    index = {s["file"]: i for i, s in enumerate(sources)}

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        models = []
        for name, (src_file, prefix) in MODELS.items():
            entry = split(args.v1 / name, args.sources / src_file, prefix, work, index[src_file])
            check_model(args.v1 / name, work / name)
            print(f"{name}: {len(entry['tensors'])} initializers, graph {entry['graph']['bytes']} B, "
                  f"weights {entry['weights']['bytes']} B, ORT outputs identical")
            models.append(entry)
        args.out.mkdir(parents=True, exist_ok=True)
        for m in models:
            shutil.copyfile(work / m["name"], args.out / m["name"])  # the .weights stay behind: never shipped
    weightmap = {"modelSet": MODEL_SET, "align": ALIGN, "sources": sources, "models": models}
    # One line per tensor: readable diffs, and less than half the size of indent=1.
    text = dump_weightmap(weightmap)
    (args.out / "weightmap.json").write_text(text + "\n")
    print(f"wrote {args.out}/weightmap.json ({len(text)} B)")


if __name__ == "__main__":
    main()
