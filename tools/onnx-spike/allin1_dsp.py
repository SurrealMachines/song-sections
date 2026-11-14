"""Numpy re-implementation of allin1's feature extraction (the input to the exported model).

    uv run python allin1_dsp.py --check [flim inner-city-life]

This is the part Plan 3 has to port to TypeScript. It mirrors allin1 1.1.0's
`allin1.spectrogram` processor chain, which is madmom 0.16.1:

    FramedSignalProcessor(frame_size=2048, fps=100)
    -> ShortTimeFourierTransformProcessor()        (symmetric Hann, scaled for int16)
    -> FilteredSpectrogramProcessor(num_bands=12, fmin=30, fmax=17000, norm_filters=True)
    -> LogarithmicSpectrogramProcessor(mul=1, add=1)

applied to each Demucs stem after madmom's int16 mono down-mix. The model input is the
four stems stacked in the order bass, drums, other, vocals: (4, T, 81) float32, with a
batch axis added for ONNX.

`--check` recomputes the baseline's spectrograms from the baseline's int16 stems
(out/baseline/<name>/*.wav) and compares them with what allin1 itself wrote
(out/baseline/_spec/<name>.npy). Measured: max abs diff <= 3.1e-7 on all stems.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent

SAMPLERATE = 44100
FRAME_SIZE = 2048
HOP = SAMPLERATE / 100  # 441.0: madmom derives the hop from fps and keeps it a float
NUM_BINS = FRAME_SIZE // 2  # rfft bins 0..1023, Nyquist dropped
BANDS_PER_OCTAVE, FMIN, FMAX, FREF = 12, 30.0, 17000.0, 440.0
INT16_MAX = 32767.0
STEMS = ("bass", "drums", "other", "vocals")  # model input order (not Demucs's order)
CHECK_BAR = 1e-6


def mono_int16(stereo: np.ndarray) -> np.ndarray:
    """madmom `remix`: channel mean in float, cast back to int16 (truncates toward zero)."""
    return np.mean(stereo, axis=-1).astype(np.int16)


def filterbank() -> np.ndarray:
    """madmom LogarithmicFilterbank (12 bands/octave, 30-17000 Hz, unique bins, unit-area
    overlapping triangles) as a (1024, 81) float32 matrix."""
    bin_freqs = np.fft.fftfreq(FRAME_SIZE, 1.0 / SAMPLERATE)[:NUM_BINS]
    left = np.floor(np.log2(FMIN / FREF) * BANDS_PER_OCTAVE)
    right = np.ceil(np.log2(FMAX / FREF) * BANDS_PER_OCTAVE)
    freqs = FREF * 2.0 ** (np.arange(left, right) / BANDS_PER_OCTAVE)
    freqs = freqs[np.searchsorted(freqs, FMIN):]
    freqs = freqs[:np.searchsorted(freqs, FMAX, "right")]
    # Nearest bin; an exact tie goes to the upper bin. Then drop duplicates.
    idx = np.clip(bin_freqs.searchsorted(freqs), 1, NUM_BINS - 1)
    idx -= freqs - bin_freqs[idx - 1] < bin_freqs[idx] - freqs
    bins = np.unique(idx)

    fb = np.zeros((NUM_BINS, len(bins) - 2), np.float32)
    for band in range(len(bins) - 2):
        start, center, stop = bins[band:band + 3]
        if stop - start < 2:  # degenerate triangle: a single bin
            center, stop = start, start + 1
        rise, length = center - start, stop - start
        tri = np.zeros(length)
        tri[:rise] = np.linspace(0, 1, rise, endpoint=False)
        tri[rise:] = np.linspace(1, 0, length - rise, endpoint=False)
        fb[start:stop, band] = tri / tri.sum()  # norm_filters: unit area
    return fb


def stem_spectrogram(stereo_int16: np.ndarray, fb: np.ndarray) -> np.ndarray:
    """One stem (N, 2) int16 -> (T, 81) float32 log-filtered magnitude spectrogram."""
    mono = mono_int16(stereo_int16)
    num_frames = int(np.ceil(len(mono) / HOP))
    # Frame i is centred on sample int(i * 441): [ref - 1024, ref + 1024), zero outside.
    half = FRAME_SIZE // 2
    padded = np.concatenate([np.zeros(half, np.int16), mono, np.zeros(FRAME_SIZE, np.int16)])
    refs = (np.arange(num_frames) * HOP).astype(int)
    frames = padded[refs[:, None] + np.arange(FRAME_SIZE)[None, :]]
    # madmom scales the window, not the samples, by the int16 range.
    window = (np.hanning(FRAME_SIZE) / INT16_MAX).astype(np.float32)
    mag = np.abs(np.fft.rfft(frames * window, axis=1)[:, :NUM_BINS]).astype(np.float32)
    return np.log10(mag @ fb + 1).astype(np.float32)


def spectrogram(stem_dir: Path) -> np.ndarray:
    """Directory of int16 stereo stem WAVs -> model input (4, T, 81) float32."""
    fb = filterbank()
    specs = []
    for stem in STEMS:
        audio, sr = sf.read(stem_dir / f"{stem}.wav", dtype="int16", always_2d=True)
        assert sr == SAMPLERATE, f"{stem}: {sr} Hz; allin1 assumes {SAMPLERATE} Hz"
        specs.append(stem_spectrogram(audio, fb))
    return np.stack(specs)


def check(names) -> bool:
    ok = True
    for name in names:
        ours = spectrogram(HERE / "out" / "baseline" / name)
        ref = np.load(HERE / "out" / "baseline" / "_spec" / f"{name}.npy")
        assert ours.shape == ref.shape, (ours.shape, ref.shape)
        diffs = {stem: float(np.abs(ours[k] - ref[k]).max()) for k, stem in enumerate(STEMS)}
        worst = max(diffs.values())
        ok &= worst <= CHECK_BAR
        print(f"{name}: {ref.shape}, max abs diff vs allin1/madmom "
              + ", ".join(f"{s} {d:.2e}" for s, d in diffs.items())
              + f"  -> {'OK' if worst <= CHECK_BAR else 'FAIL'} (bar {CHECK_BAR})")
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", nargs="*", metavar="NAME",
                        help="compare against out/baseline/_spec (default: both tracks)")
    args = parser.parse_args()
    if args.check is None:
        parser.print_help()
        return
    sys.exit(0 if check(args.check or ["flim", "inner-city-life"]) else 1)


if __name__ == "__main__":
    main()
