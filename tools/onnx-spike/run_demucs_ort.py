"""Run htdemucs through ONNX Runtime with numpy pre/post-processing, and score it.

    uv run python run_demucs_ort.py ref/flim.flac ref/inner-city-life.flac
    uv run python run_demucs_ort.py --engine torch ref/flim.flac   # pipeline-only check

Pipeline (demucs_dsp.separate): track normalisation -> apply_model's shifts=0 /
overlap=0.25 chunking -> numpy STFT -> ONNX core (CPU EP) -> numpy iSTFT + time branch
-> triangular overlap-add -> de-normalisation. `--engine torch` swaps the ONNX core for
the torch core (export_demucs.HTDemucsCore) to isolate the numpy pipeline from ORT.

Writes per track:
- out/<engine dir>/<name>/{drums,bass,other,vocals}.wav  float32 stems (unclipped)
- out/<engine dir>/seams/<name>_seam<k>_<stem>.wav     ±2 s around 3 chunk seams
- out/tensors/demucs_*.npy                              one chunk's ORT inputs/outputs
  (first track only; for the Node smoke test)
and prints SDR against the float PyTorch baseline (out/baseline/<name>/float/*.wav),
the numeric seam check, and timings.
"""

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf

import demucs_dsp as dsp

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SEAM_HALF_WINDOW_S = 0.1  # local SDR window: ±100 ms
EXCERPT_HALF_S = 2.0
N_SEAMS = 3


def sdr(ref: np.ndarray, est: np.ndarray) -> float:
    ref, est = ref.astype(np.float64), est.astype(np.float64)
    num, den = np.sum(ref ** 2), np.sum((ref - est) ** 2)
    if den == 0:
        return float("inf")
    return float(10 * np.log10(num / den))


def make_ort_core(model_path: Path, threads: int):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    if threads:
        opts.intra_op_num_threads = threads
    t0 = time.perf_counter()
    sess = ort.InferenceSession(str(model_path), opts, providers=["CPUExecutionProvider"])
    load_s = time.perf_counter() - t0

    def run(inputs):
        return sess.run(["spec_out", "wave_out"], inputs)

    return run, load_s


def make_torch_core():
    os.environ.setdefault("HF_HOME", str(HERE / ".cache" / "huggingface"))
    import torch
    from export_demucs import HTDemucsCore, load_htdemucs

    torch.set_grad_enabled(False)
    t0 = time.perf_counter()
    core = HTDemucsCore(load_htdemucs()).eval()
    load_s = time.perf_counter() - t0

    def run(inputs):
        s, w = core(torch.from_numpy(inputs["mix"]), torch.from_numpy(inputs["spec"]))
        return s.numpy(), w.numpy()

    return run, load_s


def recording_core(run_core, plan_index: int, sink: dict):
    """Wrap run_core to keep one chunk's inputs/outputs (batch must be 1)."""
    calls = {"n": 0}

    def run(inputs):
        out = run_core(inputs)
        if calls["n"] == plan_index:
            assert inputs["mix"].shape[0] == 1
            sink.update(mix=inputs["mix"], spec=inputs["spec"], spec_out=out[0],
                        wave_out=out[1])
        calls["n"] += 1
        return out

    return run


def seam_check(name: str, ref: dict, est: dict, length: int, seam_dir: Path) -> dict:
    """Local SDR in ±100 ms windows at 3 chunk seams vs global SDR and vs all windows."""
    sr = dsp.SAMPLERATE
    plan = dsp.chunk_plan(length)
    half = int(SEAM_HALF_WINDOW_S * sr)
    # Seam k is the crossfade between chunk k-1 and chunk k: chunk k starts at offset_k,
    # chunk k-1 ends at offset_{k-1} + SEGMENT_LENGTH. Pick 3 spread over the track.
    n_full = sum(1 for p in plan if p[1] == dsp.SEGMENT_LENGTH)
    ks = sorted({max(1, round(n_full * f)) for f in (0.25, 0.5, 0.75)})
    win = 2 * half
    n_win = length // win

    report = {"seams": [], "window_s": 2 * SEAM_HALF_WINDOW_S}
    for stem in dsp.SOURCES:
        r = ref[stem][:, :n_win * win].reshape(2, n_win, win)
        e = est[stem][:, :n_win * win].reshape(2, n_win, win)
        num = np.sum(r.astype(np.float64) ** 2, axis=(0, 2))
        den = np.sum((r.astype(np.float64) - e) ** 2, axis=(0, 2))
        ok = num > 1e-8 * win  # skip near-silent windows (below about -80 dBFS)
        local = 10 * np.log10(num[ok] / np.maximum(den[ok], 1e-30))
        report.setdefault("all_windows", {})[stem] = {
            "median_db": float(np.median(local)), "p05_db": float(np.percentile(local, 5)),
            "min_db": float(local.min()), "n": int(ok.sum())}

    seam_dir.mkdir(parents=True, exist_ok=True)
    for k in ks:
        start_k = plan[k][0]
        end_prev = plan[k - 1][0] + dsp.SEGMENT_LENGTH
        mid = (start_k + end_prev) // 2
        points = {"chunk_start": start_k, "overlap_mid": mid, "prev_chunk_end": end_prev}
        entry = {"k": k, "time_s": {p: round(v / sr, 3) for p, v in points.items()},
                 "local_sdr_db": {}}
        for stem in dsp.SOURCES:
            entry["local_sdr_db"][stem] = {
                p: round(sdr(ref[stem][:, v - half:v + half], est[stem][:, v - half:v + half]), 1)
                for p, v in points.items()}
        report["seams"].append(entry)
        a, b = max(0, mid - int(EXCERPT_HALF_S * sr)), min(length, mid + int(EXCERPT_HALF_S * sr))
        for stem in dsp.SOURCES:
            sf.write(seam_dir / f"{name}_seam{k}_{stem}.wav", est[stem][:, a:b].T, sr,
                     subtype="FLOAT")
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("tracks", nargs="+", type=Path)
    ap.add_argument("--engine", choices=("ort", "torch"), default="ort")
    ap.add_argument("--model", type=Path, default=OUT / "models" / "htdemucs_core.onnx")
    ap.add_argument("--batch", type=int, default=1, help="chunks per core call")
    ap.add_argument("--threads", type=int, default=0, help="ORT intra-op threads (0=default)")
    ap.add_argument("--dump-chunk", type=int, default=4,
                    help="plan index of the chunk saved to out/tensors (first track)")
    args = ap.parse_args()

    if args.engine == "ort":
        run_core, load_s = make_ort_core(args.model, args.threads)
        out_root = OUT / "ort"
    else:
        run_core, load_s = make_torch_core()
        out_root = OUT / "numpy-torch"
    print(f"{args.engine} core load: {load_s:.2f} s")

    results = {"engine": args.engine, "batch": args.batch, "threads": args.threads,
               "core_load_s": load_s, "tracks": {}}
    for ti, path in enumerate(args.tracks):
        name = path.stem
        t0 = time.perf_counter()
        wav, sr = sf.read(path, dtype="float32", always_2d=True)
        assert sr == dsp.SAMPLERATE and wav.shape[1] == dsp.CHANNELS
        wav = np.ascontiguousarray(wav.T)

        tensors = {}
        core = run_core
        if ti == 0 and args.engine == "ort" and args.batch == 1:
            core = recording_core(run_core, args.dump_chunk, tensors)
        t1 = time.perf_counter()
        stems = dsp.separate(wav, core, batch_size=args.batch)
        sep_s = time.perf_counter() - t1

        track_dir = out_root / name
        track_dir.mkdir(parents=True, exist_ok=True)
        est = dict(zip(dsp.SOURCES, stems))
        for stem, x in est.items():
            sf.write(track_dir / f"{stem}.wav", x.T, sr, subtype="FLOAT")
        total_s = time.perf_counter() - t0

        if tensors:
            tdir = OUT / "tensors"
            tdir.mkdir(parents=True, exist_ok=True)
            for k, v in tensors.items():
                np.save(tdir / f"demucs_{k}.npy", v)
            print(f"saved chunk {args.dump_chunk} of {name} to {tdir}/demucs_*.npy")

        ref = {}
        for stem in dsp.SOURCES:
            r, rsr = sf.read(OUT / "baseline" / name / "float" / f"{stem}.wav",
                             dtype="float32", always_2d=True)
            assert rsr == sr and r.shape[0] == wav.shape[1]
            ref[stem] = r.T
        scores = {stem: sdr(ref[stem], est[stem]) for stem in dsp.SOURCES}
        max_diff = {stem: float(np.abs(ref[stem] - est[stem]).max()) for stem in dsp.SOURCES}
        seams = seam_check(name, ref, est, wav.shape[1], out_root / "seams")

        n_chunks = len(dsp.chunk_plan(wav.shape[1]))
        results["tracks"][name] = {
            "duration_s": wav.shape[1] / sr, "chunks": n_chunks,
            "separate_s": sep_s, "total_s": total_s, "sdr_db": scores,
            "max_abs_diff": max_diff, "seam_check": seams}
        print(f"\n== {name}: {wav.shape[1] / sr:.1f} s, {n_chunks} chunks, "
              f"separate {sep_s:.1f} s, total {total_s:.1f} s "
              f"(+ core load {load_s:.1f} s once)")
        for stem in dsp.SOURCES:
            a = seams["all_windows"][stem]
            print(f"  {stem:7s} SDR {scores[stem]:6.1f} dB  max|diff| {max_diff[stem]:.2e}  "
                  f"200ms windows: median {a['median_db']:.1f} / p5 {a['p05_db']:.1f} / "
                  f"min {a['min_db']:.1f} dB")
        for s in seams["seams"]:
            print(f"  seam {s['k']} at {s['time_s']}:")
            for stem, v in s["local_sdr_db"].items():
                print(f"    {stem:7s} " + "  ".join(f"{p} {d:.1f}" for p, d in v.items()))

    out_json = out_root / f"results-b{args.batch}.json"
    out_json.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out_json}")


if __name__ == "__main__":
    main()
