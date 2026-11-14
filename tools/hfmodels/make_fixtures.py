"""Tiny checkpoint fixtures for the TypeScript readers (fb/hfmodels): fixtures/hfmodels/.

    <spike>/.venv/bin/python tools/hfmodels/make_fixtures.py

Writes, from fixed values (deterministic: no randomness, so reruns give the same bytes up to torch.save's zip):

- lightning.pth   torch.save({"state_dict": OrderedDict(...), "config": {...}}), protocol 2 (torch's default):
                  float32 and float16 tensors, a transposed (non-contiguous) one, a slice with a storage offset, two
                  views of one storage, a 0-d tensor, an nn.Parameter, and a config of plain values plus an object
                  of a class the reader does not know (kept inert).
- protocol4.pth   the same state dict saved bare (no "state_dict" nesting), pickle protocol 4 (FRAME, MEMOIZE,
                  STACK_GLOBAL, SHORT_BINUNICODE).
- deflated.pth    lightning.pth re-zipped with every entry deflated.
- hostile.pth     a hand-made torch.save zip whose data.pkl calls os.system("touch <marker>") via GLOBAL + REDUCE;
                  the reader must return it as an inert placeholder and run nothing.
- tiny.safetensors  float32 and float16 tensors.
- expected.json   for every tensor: dtype, shape, the float32 values (C order) and, for 2-D ones, the transpose.
- store/          a miniature model store: weightmap.json for two "models" built from tiny.safetensors and
                  lightning.pth (permutes, float16 widening, a reshape), their graph files (arbitrary bytes: the
                  runtime only copies and checks them) and the sha256 of each .weights, as numpy computes it.
"""

from __future__ import annotations

import collections
import hashlib
import io
import json
import pickle
import zipfile
from pathlib import Path

import numpy as np
import torch
from safetensors.numpy import save_file

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "fixtures" / "hfmodels"


class Unknown:
    """A class only this script defines: unpickled, it must stay an inert placeholder."""

    def __init__(self):
        self.value = 7


def values(n: int, scale: float = 0.25) -> np.ndarray:
    return (np.arange(n, dtype=np.float32) - n / 2) * scale


def state_dict() -> collections.OrderedDict:
    big = torch.from_numpy(values(24)).reshape(6, 4)
    sd = collections.OrderedDict()
    sd["conv.weight"] = torch.from_numpy(values(2 * 3 * 4)).reshape(2, 3, 4)
    sd["conv.bias"] = torch.tensor([0.5, -1.5], dtype=torch.float32)
    sd["dense.weight_t"] = torch.from_numpy(values(12, 0.5)).reshape(3, 4).t()  # stride (1, 4): non-contiguous
    sd["slice"] = big[2:5]  # storage offset 8
    sd["slice_view"] = big[:, 1]  # same storage, stride (4,), offset 1
    sd["half"] = torch.tensor([[1.0, -2.0, 0.5], [65504.0, 6.1035156e-05, 5.9604645e-08]], dtype=torch.float16)
    sd["scalar"] = torch.tensor(3.25, dtype=torch.float32)
    sd["param"] = torch.nn.Parameter(torch.from_numpy(values(6, 1.0)).reshape(2, 3))
    return sd


def config() -> dict:
    return {
        "lr": 0.005, "fps": 100, "big": 2**70, "neg": -123456789, "name": "fold-ü", "flag": True, "off": False,
        "none": None, "list": [1, 2.5, "x"], "tuple": (1, (2, 3)), "nested": {"a": {"b": [None]}}, "obj": Unknown(),
    }


def rezip_deflated(src: Path, dst: Path) -> None:
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            zout.writestr(info.filename, zin.read(info.filename), compress_type=zipfile.ZIP_DEFLATED)


def hostile(dst: Path, marker: str) -> None:
    class Evil:
        def __reduce__(self):
            import os
            return (os.system, (f"touch {marker}",))

    pkl = pickle.dumps({"state_dict": collections.OrderedDict(), "evil": Evil()}, protocol=2)
    assert b"system" in pkl
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:
        z.writestr("hostile/data.pkl", pkl)
        z.writestr("hostile/version", "3\n")


def describe(t: torch.Tensor) -> dict:
    a = t.detach().numpy()
    entry = {"dtype": str(a.dtype), "shape": list(a.shape), "values": a.astype(np.float32).ravel().tolist()}
    if a.ndim == 2:
        entry["transposed"] = np.ascontiguousarray(a.astype(np.float32).T).ravel().tolist()
    return entry


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def store(sd: collections.OrderedDict, st: dict[str, np.ndarray]) -> None:
    """A two-model weight map over tiny.safetensors (source 0) and lightning.pth (source 1)."""
    d = OUT / "store"
    d.mkdir(parents=True, exist_ok=True)
    sources = [
        {"file": "tiny.safetensors", "repo": "test/tiny", "revision": "0" * 40},
        {"file": "lightning.pth", "repo": "test/lightning", "revision": "1" * 40},
    ]
    for s in sources:
        b = (OUT / s["file"]).read_bytes()
        s.update(bytes=len(b), sha256=sha(b))
        (d / s["file"]).write_bytes(b)
    src = [st, {k: v.detach().numpy() for k, v in sd.items()}]
    plan = {
        "alpha.onnx": [  # (source, key, perm, dims)
            (0, "w16", [1, 0], None),
            (1, "conv.weight", None, [6, 4]),
            (1, "dense.weight_t", [1, 0], None),
            (0, "b32", None, None),
        ],
        "beta.onnx": [
            (1, "half", None, None),
            (1, "slice", [1, 0], None),
            (1, "slice_view", None, None),
            (1, "scalar", None, None),
            (1, "param", None, [6]),
        ],
    }
    models = []
    for name, tensors in plan.items():
        weights = bytearray()
        entries = []
        for source, key, perm, dims in tensors:
            a = src[source][key]
            b = a.astype(np.float32)
            if perm is not None:
                b = b.transpose(perm)
            b = np.ascontiguousarray(b)
            weights += b"\0" * ((-len(weights)) % 64)
            e = {"name": f"{name}:{key}", "dims": dims or list(b.shape), "offset": len(weights), "length": b.nbytes,
                 "source": source, "key": key, "dtype": str(a.dtype), "shape": list(a.shape)}
            if perm is not None:
                e["perm"] = perm
            entries.append(e)
            weights += b.tobytes()
        graph = f"graph of {name}: not a real ONNX file\n".encode() * 3
        (d / name).write_bytes(graph)
        wname = name.removesuffix(".onnx") + ".weights"
        models.append({
            "name": name, "v1": {"bytes": 0, "sha256": "0" * 64},
            "graph": {"bytes": len(graph), "sha256": sha(graph)},
            "weights": {"name": wname, "bytes": len(weights), "sha256": sha(bytes(weights))},
            "tensors": entries,
        })
    wm = {"modelSet": "test-set", "align": 64, "sources": sources, "models": models}
    (d / "weightmap.json").write_text(json.dumps(wm, indent=1) + "\n")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sd = state_dict()
    torch.save({"state_dict": sd, "config": config()}, OUT / "lightning.pth")
    torch.save(sd, OUT / "protocol4.pth", pickle_protocol=4)
    rezip_deflated(OUT / "lightning.pth", OUT / "deflated.pth")
    hostile(OUT / "hostile.pth", "HOSTILE_MARKER")
    st = {"w16": values(6, 0.125).reshape(2, 3).astype(np.float16), "b32": values(5)}
    save_file(st, str(OUT / "tiny.safetensors"))

    # Sanity: torch reads back what was saved (the hostile file is never loaded here).
    back = torch.load(OUT / "lightning.pth", weights_only=False)["state_dict"]
    assert all(torch.equal(back[k], sd[k]) for k in sd)
    assert back["dense.weight_t"].stride() == (1, 4) and back["slice"].storage_offset() == 8

    expected = {"state_dict": {k: describe(v) for k, v in sd.items()},
                "safetensors": {k: describe(torch.from_numpy(v)) for k, v in st.items()}}
    (OUT / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")
    store(sd, st)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
