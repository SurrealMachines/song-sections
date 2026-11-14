"""Export the htdemucs network core to ONNX, with STFT/iSTFT and chunking kept outside.

    uv run python export_demucs.py [--out out/models/htdemucs_core.onnx]

The exported graph (`HTDemucsCore`) is HTDemucs.forward from just after `_spec` +
`_magnitude` to just before `_mask` + `_ispec`:

    inputs   mix   (B, 2, 343980)         float32  one normalised 7.8 s chunk
             spec  (B, 4, 2048, 336)      float32  its spectrogram, real/imag as channels
    outputs  spec_out (B, 4, 4, 2048, 336) float32  freq-branch estimate (sources, re/im)
             wave_out (B, 4, 2, 343980)    float32  time-branch estimate (sources)

and the full chunk estimate is `ispec(spec_out) + wave_out` (demucs_dsp.py). Only the
batch axis is dynamic: htdemucs always runs on exactly one training-length chunk.

Before exporting, the script checks equivalence in torch on a real chunk of the reference
audio: (1) the core fed by the model's own torch `_spec`, (2) the core fed by the numpy
`demucs_dsp.spec`, recombined by numpy `ispec`, each against the original `model(mix)`.
After exporting, it runs the ONNX model in onnxruntime (CPU) on the same chunk.
"""

import argparse
import os
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(HERE / ".cache" / "huggingface"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from torch import nn  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402
from demucs.htdemucs import HTDemucs  # noqa: E402

import demucs_dsp as dsp  # noqa: E402

OPSET = 17


class HTDemucsCore(nn.Module):
    """HTDemucs.forward minus spectrogram in/out (cac=True, eval, training-length input)."""

    def __init__(self, model: HTDemucs):
        super().__init__()
        assert model.cac and not model.training and model.use_train_segment
        self.m = model

    def forward(self, mix: torch.Tensor, spec: torch.Tensor):
        m = self.m
        x = spec
        B, C, Fq, T = x.shape

        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)

        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)

        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)

        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                x = x.reshape(b, -1, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)

        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        assert not saved and not saved_t and not lengths_t

        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        spec_out = x * std[:, None] + mean[:, None]
        wave_out = xt.view(B, S, -1, mix.shape[-1]) * stdt[:, None] + meant[:, None]
        return spec_out, wave_out


def load_htdemucs() -> HTDemucs:
    bag = get_model("htdemucs")
    assert len(bag.models) == 1 and all(w == 1.0 for w in bag.weights[0])
    model = bag.models[0]
    model.eval()
    assert tuple(model.sources) == dsp.SOURCES
    assert model.samplerate == dsp.SAMPLERATE and model.nfft == dsp.NFFT
    assert int(model.segment * model.samplerate) == dsp.SEGMENT_LENGTH
    return model


def reference_chunk(path: Path, offset_s: float = 60.0) -> np.ndarray:
    """A normalised (as Separator does) training-length chunk of real audio, (1, 2, L)."""
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    assert sr == dsp.SAMPLERATE
    wav = wav.T
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std(ddof=1) + 1e-8)
    start = int(offset_s * sr)
    return np.ascontiguousarray(wav[None, :, start:start + dsp.SEGMENT_LENGTH])


def max_abs(a, b) -> float:
    return float(np.max(np.abs(np.asarray(a) - np.asarray(b))))


def sdr(ref, est) -> float:
    ref, est = np.asarray(ref, np.float64), np.asarray(est, np.float64)
    return float(10 * np.log10(np.sum(ref ** 2) / np.sum((ref - est) ** 2)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=HERE / "out" / "models" / "htdemucs_core.onnx")
    ap.add_argument("--ref", type=Path, default=HERE / "ref" / "flim.flac")
    args = ap.parse_args()
    torch.set_grad_enabled(False)

    model = load_htdemucs()
    core = HTDemucsCore(model).eval()
    mix_np = reference_chunk(args.ref)
    mix = torch.from_numpy(mix_np)

    # 1. Equivalence in torch.
    t0 = time.perf_counter()
    full = model(mix).numpy()
    print(f"original model(mix): {full.shape}, {time.perf_counter() - t0:.2f} s")
    peak = float(np.abs(full).max())

    z = model._spec(mix)
    spec_out, wave_out = core(mix, model._magnitude(z))
    torch_path = (model._ispec(model._mask(z, spec_out), dsp.SEGMENT_LENGTH) + wave_out).numpy()
    print(f"[torch spec ] core vs original: max abs {max_abs(torch_path, full):.3e} "
          f"(output peak {peak:.3f})")

    inputs = dsp.core_inputs(mix_np)
    print(f"numpy spec vs torch _spec: max abs "
          f"{max_abs(inputs['spec'], model._magnitude(z).numpy()):.3e}")
    istft_np = dsp.ispec(dsp.from_cac(spec_out.numpy()), dsp.SEGMENT_LENGTH)
    istft_torch = model._ispec(model._mask(z, spec_out), dsp.SEGMENT_LENGTH).numpy()
    print(f"numpy ispec vs torch _ispec (same core output): max abs "
          f"{max_abs(istft_np, istft_torch):.3e}")
    spec_np, wave_np = core(mix, torch.from_numpy(inputs["spec"]))
    numpy_path = dsp.core_outputs_to_wave(spec_np.numpy(), wave_np.numpy())
    print(f"[numpy spec ] core vs original: max abs {max_abs(numpy_path, full):.3e}, "
          f"SDR {sdr(full, numpy_path):.1f} dB")

    # 2. Export.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    # In eval + no_grad, nn.MultiheadAttention self-attention takes the fused fast path
    # `aten::_native_multi_head_attention`, which has no ONNX symbolic ("not supported
    # in opset 17"). Disabling the fast path traces the ordinary decomposed attention.
    torch.backends.mha.set_fastpath_enabled(False)
    t0 = time.perf_counter()
    torch.onnx.export(
        core,
        (mix, torch.from_numpy(inputs["spec"])),
        str(args.out),
        opset_version=OPSET,
        input_names=["mix", "spec"],
        output_names=["spec_out", "wave_out"],
        dynamic_axes={n: {0: "batch"} for n in ("mix", "spec", "spec_out", "wave_out")},
        do_constant_folding=True,
    )
    size_mb = args.out.stat().st_size / 1e6
    print(f"exported {args.out} (opset {OPSET}, {size_mb:.1f} MB) "
          f"in {time.perf_counter() - t0:.1f} s")

    import onnx
    import onnxruntime as ort

    onnx.checker.check_model(str(args.out))
    ops = sorted({n.op_type for n in onnx.load(str(args.out)).graph.node})
    print(f"ONNX op types ({len(ops)}): {', '.join(ops)}")

    # 3. ONNX Runtime (CPU) on the same chunk, batch 1 and batch 2.
    sess = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    t0 = time.perf_counter()
    o_spec, o_wave = sess.run(None, inputs)
    print(f"ORT CPU batch 1: {time.perf_counter() - t0:.2f} s")
    print(f"ORT vs torch core: spec_out max abs {max_abs(o_spec, spec_np):.3e}, "
          f"wave_out max abs {max_abs(o_wave, wave_np):.3e}")
    ort_path = dsp.core_outputs_to_wave(o_spec, o_wave)
    print(f"[ORT        ] vs original: max abs {max_abs(ort_path, full):.3e}, "
          f"SDR {sdr(full, ort_path):.1f} dB")
    batch2 =dsp.core_inputs(np.concatenate([mix_np, mix_np[..., ::-1]]))
    b_spec, b_wave = sess.run(None, batch2)
    print(f"ORT batch 2, item 0 vs batch 1: max abs "
          f"{max(max_abs(b_spec[:1], o_spec), max_abs(b_wave[:1], o_wave)):.3e}")


if __name__ == "__main__":
    main()
