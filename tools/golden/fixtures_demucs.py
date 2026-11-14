"""Demucs DSP fixtures: demucs_spec.npy, demucs_ispec.npy, demucs_chunks.json, demucs_separate.npy.

The fake core below is mirrored by src/structure/demucs/separate.test.ts; keep the two identical.
"""
import json

import numpy as np

from common import FIXTURES, save, test_signal
import demucs_dsp as D

# spec / ispec on a short mono signal
x = test_signal(8192, 1, 44100)[0]
z = D.spec(x)  # (2048, 8) complex64
assert z.shape == (2048, 8), z.shape
save("demucs_spec.npy", np.stack([z.real, z.imag]).astype(np.float32))  # (2, 2048, 8)
scaled = z * (np.arange(2048, dtype=np.float32) / 2048)[:, None]
save("demucs_ispec.npy", D.ispec(scaled.astype(np.complex64), 8192).astype(np.float32))

# chunk plan and triangular weights
lengths = [1, 1000, 343980, 343981, 600000, 7810404]
idx = [0, 1, 171989, 171990, 343979]
w = D.chunk_weight()
(FIXTURES / "demucs_chunks.json").write_text(json.dumps({
    "plans": {str(n): [list(map(int, p)) for p in D.chunk_plan(n)] for n in lengths},
    "weightIdx": idx,
    "weight": [float(w[i]) for i in idx],
}))

# separate() with the fake core
G = np.array([0.5, 0.25, 0, 1], dtype=np.float32)
H = np.array([0, 0.5, 1, 0.25], dtype=np.float32)


def fake_core(inputs):
    mix, spec = inputs["mix"], inputs["spec"]  # (B,2,L), (B,4,2048,336)
    spec_out = G[None, :, None, None, None] * spec[:, None]
    ramp = (np.arange(D.SEGMENT_LENGTH, dtype=np.float32) / np.float32(D.SEGMENT_LENGTH))
    wave_out = H[None, :, None, None] * mix[:, None] * ramp
    return spec_out.astype(np.float32), wave_out.astype(np.float32)


sig = test_signal(600000, 2, 44100)
out = D.separate(sig, fake_core)  # (4, 2, 600000)
save("demucs_separate.npy", out[:, :, ::1000].astype(np.float32))
