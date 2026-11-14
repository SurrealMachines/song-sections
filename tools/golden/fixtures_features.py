"""allin1 feature fixtures: allin1_filterbank.json, allin1_stemspec.npy, stem_quantise.npy."""
import json
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from demucs.audio import save_audio

from common import FIXTURES, save, test_signal
import allin1_dsp as A
from madmom.audio.filters import LogarithmicFilterbank

# Filterbank: the bins (replicating allin1_dsp.filterbank's bin selection, which does not expose them)
# and every non-zero matrix entry.
bin_freqs = np.fft.fftfreq(A.FRAME_SIZE, 1.0 / A.SAMPLERATE)[: A.NUM_BINS]
left = np.floor(np.log2(A.FMIN / A.FREF) * A.BANDS_PER_OCTAVE)
right = np.ceil(np.log2(A.FMAX / A.FREF) * A.BANDS_PER_OCTAVE)
freqs = A.FREF * 2.0 ** (np.arange(left, right) / A.BANDS_PER_OCTAVE)
freqs = freqs[np.searchsorted(freqs, A.FMIN):]
freqs = freqs[: np.searchsorted(freqs, A.FMAX, "right")]
idx = np.clip(bin_freqs.searchsorted(freqs), 1, A.NUM_BINS - 1)
idx -= freqs - bin_freqs[idx - 1] < bin_freqs[idx] - freqs
bins = np.unique(idx)

# madmom's own centre frequencies: the centre bin of each band (a degenerate single-bin band centres on its start).
madmom_fb = LogarithmicFilterbank(bin_freqs, num_bands=12, fmin=30, fmax=17000, fref=440, norm_filters=True, unique_filters=True)
fb = A.filterbank()
assert np.allclose(fb, np.asarray(madmom_fb), atol=1e-7)
assert fb.shape == (1024, 81) and len(bins) == 83
rows, cols = np.nonzero(fb)
(FIXTURES / "allin1_filterbank.json").write_text(json.dumps({
    "bins": [int(b) for b in bins],
    "centerHz": [float(c) for c in madmom_fb.center_frequencies],
    "entries": [[int(r), int(c), float(fb[r, c])] for r, c in zip(rows, cols)],
}))

# stem_spectrogram of a quiet-ish stereo int16 stem (2 s -> 200 frames)
x = test_signal(88200, 2, 44100)  # (2, N) float32
stereo = (x * np.float32(0.8) * np.int32(32767)).astype(np.int16).T  # (N, 2)
save("allin1_stemspec.npy", A.stem_spectrogram(stereo, fb))

# demucs save_audio(rescale, 16 bit) of a stem that peaks above 1 (1.5 x the test signal's 0.85), then madmom's mono remix
y = (test_signal(44100, 2, 44100) * np.float32(1.5)).astype(np.float32)
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "q.wav"
    save_audio(torch.from_numpy(y.copy()), path, 44100, clip="rescale", bits_per_sample=16)
    audio, sr = sf.read(path, dtype="int16", always_2d=True)
assert sr == 44100 and audio.shape == (44100, 2)
save("stem_quantise.npy", A.mono_int16(audio))
