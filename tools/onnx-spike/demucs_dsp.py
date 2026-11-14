"""Numpy re-implementation of everything htdemucs does *outside* the exported ONNX core.

This is the part Plan 3 has to port to TypeScript. It mirrors, line for line, the
installed demucs 4.1.0 code it replaces:

- `stft` / `istft`          <- demucs.spec.spectro / ispectro (torch.stft / torch.istft,
                               hann (periodic) window, normalized=True, center=True,
                               reflect padding)
- `spec` / `ispec`          <- HTDemucs._spec / HTDemucs._ispec (extra reflect pad,
                               drop the Nyquist bin, drop 2 frames each side)
- `to_cac` / `from_cac`     <- HTDemucs._magnitude / HTDemucs._mask with cac=True
                               (complex as real/imag channels: [c0re, c0im, c1re, c1im])
- `separate`                <- demucs.api.Separator.separate_tensor + demucs.apply.apply_model
                               with shifts=0, split=True, overlap=0.25, transition_power=1
                               (track-level normalisation, 7.8 s chunks, centred zero
                               padding of short chunks, triangular overlap-add weights)

Constants are htdemucs's: 44.1 kHz, stereo, nfft 4096, hop 1024, segment 39/5 s.
"""

from fractions import Fraction

import numpy as np

SAMPLERATE = 44100
CHANNELS = 2
NFFT = 4096
HOP = NFFT // 4
SEGMENT = Fraction(39, 5)  # HTDemucs.segment for the htdemucs checkpoint
SEGMENT_LENGTH = int(SEGMENT * SAMPLERATE)  # 343980 samples; the core's fixed input length
SOURCES = ("drums", "bass", "other", "vocals")  # model output order


def hann(n: int) -> np.ndarray:
    """torch.hann_window(n) (periodic=True)."""
    return (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float32)


def stft(x: np.ndarray) -> np.ndarray:
    """torch.stft(x, 4096, 1024, hann, normalized=True, center=True, pad_mode='reflect').

    x: (..., L) float32 -> (..., NFFT//2 + 1, 1 + L//HOP) complex64.
    """
    lead = x.shape[:-1]
    x = x.reshape(-1, x.shape[-1])
    x = np.pad(x, ((0, 0), (NFFT // 2, NFFT // 2)), mode="reflect")
    n_frames = 1 + (x.shape[-1] - NFFT) // HOP
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = x[:, idx] * hann(NFFT)  # (N, frames, NFFT)
    z = np.fft.rfft(frames, axis=-1) / np.sqrt(NFFT)  # normalized=True -> * n_fft^-0.5
    z = np.swapaxes(z, -1, -2).astype(np.complex64)
    return z.reshape(*lead, z.shape[-2], z.shape[-1])


def istft(z: np.ndarray, length: int) -> np.ndarray:
    """torch.istft(z, 4096, 1024, hann, normalized=True, center=True, length=length).

    z: (..., NFFT//2 + 1, frames) complex -> (..., length) float32.
    """
    lead = z.shape[:-2]
    n_frames = z.shape[-1]
    z = z.reshape(-1, z.shape[-2], n_frames)
    frames = np.fft.irfft(np.swapaxes(z, -1, -2) * np.sqrt(NFFT), n=NFFT, axis=-1)
    window = hann(NFFT).astype(np.float64)
    frames = frames * window  # (N, frames, NFFT)
    full = (n_frames - 1) * HOP + NFFT
    out = np.zeros((frames.shape[0], full))
    env = np.zeros(full)
    # NFFT == 4 * HOP: add the 4 hop-sized quarters of every frame with one strided add each.
    for q in range(NFFT // HOP):
        part = frames[:, :, q * HOP:(q + 1) * HOP].reshape(frames.shape[0], -1)
        out[:, q * HOP:q * HOP + n_frames * HOP] += part
        env[q * HOP:q * HOP + n_frames * HOP] += np.tile(window[q * HOP:(q + 1) * HOP] ** 2,
                                                         n_frames)
    start = NFFT // 2  # center=True
    out = out[:, start:start + length]
    env = env[start:start + length]
    assert env.min() > 1e-11, "istft window envelope (NOLA) violated"
    out = (out / env).astype(np.float32)
    return out.reshape(*lead, length)


def spec(x: np.ndarray) -> np.ndarray:
    """HTDemucs._spec: (..., L) -> (..., 2048, ceil(L/1024)) complex64."""
    length = x.shape[-1]
    le = int(np.ceil(length / HOP))
    pad = HOP // 2 * 3
    widths = [(0, 0)] * (x.ndim - 1) + [(pad, pad + le * HOP - length)]
    x = np.pad(x, widths, mode="reflect")
    z = stft(x)[..., :-1, :]
    assert z.shape[-1] == le + 4
    return z[..., 2:2 + le]


def ispec(z: np.ndarray, length: int) -> np.ndarray:
    """HTDemucs._ispec: (..., 2048, T) complex -> (..., length) float32."""
    widths = [(0, 0)] * (z.ndim - 2)
    z = np.pad(z, widths + [(0, 1), (2, 2)])
    pad = HOP // 2 * 3
    le = HOP * int(np.ceil(length / HOP)) + 2 * pad
    x = istft(z, le)
    return x[..., pad:pad + length]


def to_cac(z: np.ndarray) -> np.ndarray:
    """HTDemucs._magnitude (cac): (B, C, F, T) complex -> (B, 2C, F, T) float32."""
    b, c, f, t = z.shape
    m = np.stack([z.real, z.imag], axis=2)  # (B, C, 2, F, T)
    return np.ascontiguousarray(m.reshape(b, c * 2, f, t), dtype=np.float32)


def from_cac(m: np.ndarray) -> np.ndarray:
    """HTDemucs._mask (cac): (B, S, 2C, F, T) float -> (B, S, C, F, T) complex64."""
    b, s, c2, f, t = m.shape
    m = m.reshape(b, s, c2 // 2, 2, f, t)
    return (m[:, :, :, 0] + 1j * m[:, :, :, 1]).astype(np.complex64)


def core_inputs(mix_chunks: np.ndarray):
    """Inputs of the ONNX core for a batch of SEGMENT_LENGTH chunks (B, 2, L)."""
    assert mix_chunks.shape[-1] == SEGMENT_LENGTH
    return {"mix": np.ascontiguousarray(mix_chunks, dtype=np.float32),
            "spec": to_cac(spec(mix_chunks))}


def core_outputs_to_wave(spec_out: np.ndarray, wave_out: np.ndarray) -> np.ndarray:
    """Recombine the core's two branches: iSTFT(freq branch) + time branch -> (B, S, 2, L)."""
    return ispec(from_cac(spec_out), wave_out.shape[-1]) + wave_out


def chunk_weight() -> np.ndarray:
    """apply_model's triangular overlap-add weight (transition_power=1)."""
    n = SEGMENT_LENGTH
    w = np.concatenate([np.arange(1, n // 2 + 1), np.arange(n - n // 2, 0, -1)])
    return (w / w.max()).astype(np.float32)


def chunk_plan(length: int, overlap: float = 0.25):
    """apply_model's split=True chunking: [(offset, chunk_len, src_start, src_end, pad_left)].

    Each chunk is read as SEGMENT_LENGTH samples centred on [offset, offset+chunk_len)
    (TensorChunk.padded), zero-filled where it runs off the track.
    """
    stride = int((1 - overlap) * SEGMENT_LENGTH)
    plan = []
    for offset in range(0, length, stride):
        chunk_len = min(length - offset, SEGMENT_LENGTH)
        delta = SEGMENT_LENGTH - chunk_len
        start = offset - delta // 2
        end = start + SEGMENT_LENGTH
        src_start, src_end = max(0, start), min(length, end)
        plan.append((offset, chunk_len, src_start, src_end, src_start - start))
    return plan


def separate(wav: np.ndarray, run_core, batch_size: int = 1, overlap: float = 0.25):
    """Separator.separate_tensor + apply_model(shifts=0, split=True) around `run_core`.

    wav: (2, N) float32 at 44.1 kHz.
    run_core(inputs: dict) -> (spec_out (B,4,4,2048,336), wave_out (B,4,2,L)).
    Returns (S, 2, N) float32 in SOURCES order.
    """
    ref = wav.mean(0)
    mean = ref.mean()
    std = ref.std(ddof=1) + 1e-8  # torch.Tensor.std is unbiased
    mix = ((wav - mean) / std).astype(np.float32)
    length = mix.shape[-1]

    out = np.zeros((len(SOURCES), CHANNELS, length), dtype=np.float32)
    sum_weight = np.zeros(length, dtype=np.float32)
    weight = chunk_weight()
    plan = chunk_plan(length, overlap)

    for b0 in range(0, len(plan), batch_size):
        batch = plan[b0:b0 + batch_size]
        chunks = np.zeros((len(batch), CHANNELS, SEGMENT_LENGTH), dtype=np.float32)
        for i, (_, _, s, e, pl) in enumerate(batch):
            chunks[i, :, pl:pl + e - s] = mix[:, s:e]
        spec_out, wave_out = run_core(core_inputs(chunks))
        est = core_outputs_to_wave(spec_out, wave_out)
        for i, (offset, chunk_len, _, _, _) in enumerate(batch):
            d = SEGMENT_LENGTH - chunk_len  # center_trim
            chunk_out = est[i, ..., d // 2:d // 2 + chunk_len]
            out[..., offset:offset + chunk_len] += weight[:chunk_len] * chunk_out
            sum_weight[offset:offset + chunk_len] += weight[:chunk_len]
    assert sum_weight.min() > 0
    out /= sum_weight
    return out * std + mean
