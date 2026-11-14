"""Shared helpers for fixture generators (run via `npm run fixtures`).

Reads the spike checkout (SONG_SECTIONS_SPIKE) and never writes to it. Fixtures go to fixtures/structure/.
"""
import collections
import collections.abc
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True  # never write .pyc into the (read-only) spike checkout

SPIKE = Path(os.environ.get("SONG_SECTIONS_SPIKE", "/Users/mja/Dev/extensions/song-sections/tools/onnx-spike"))
sys.path.insert(0, str(SPIKE))

# madmom 0.16.1 (imported by allin1) still uses collections.MutableSequence.
collections.MutableSequence = collections.abc.MutableSequence

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "structure"


def test_signal(n: int, channels: int, rate: int) -> np.ndarray:
    """Identical to testSignal() in src/test/signals.ts: float64 maths, stored float32, shape (channels, n)."""
    i = np.arange(n, dtype=np.float64)
    out = []
    for c in range(channels):
        x = (
            0.5 * np.sin(2 * math.pi * 440 * i / rate + c)
            + 0.25 * np.sin(2 * math.pi * 1234.5 * (i / rate) * (1 + i / n))
            + 0.1 * np.sin(2 * math.pi * 3 * i / rate)
        )
        out.append(x.astype(np.float32))
    return np.stack(out)


def save(name: str, array) -> Path:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    path = FIXTURES / name
    np.save(path, np.asarray(array))
    return path
