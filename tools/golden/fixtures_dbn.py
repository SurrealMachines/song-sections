"""madmom DBN downbeat fixtures (Plan 3, Task 7): dbn_spaces.json and dbn_synthetic.json.

dbn_spaces.json: madmom 0.16.1's BarStateSpace / BarTransitionModel / RNNDownBeatTrackingObservationModel for
3 and 4 beats per bar with allin1's tempo range, summarised as counts, sums and the values at 64 fixed indices
(`sample_indices` below, mirrored in the TypeScript tests).

dbn_sigmoid.npy: torch.sigmoid on a float32 vector whose length is not a multiple of 16, shape (2, N): row 0 the
input, row 1 the output. torch 2.5.1 on arm64 runs Sleef's expf_u10 on whole 16-lane blocks and std::exp on the
tail, so both paths are covered.

dbn_exact.json: bit-exact references for the Flim golden, cheap enough to commit (a few KB). `activations` is allin1's
`activations_combined[:, :2]` (float32, 17,711 x 2 = 35,422 values) and `logDensities` is madmom's
RNNDownBeatTrackingObservationModel.log_densities on those activations (float64 as madmom returns it, 17,711 x 3).
Each records the SHA-256 of the little-endian bytes, the count, and 64 sampled values for diagnosing a mismatch.
The input logits are read from the spike's tensors (the same file fixtures_post.py copies to flim_logits_*.npy).

dbn_synthetic.json: DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], threshold=0.24, fps=100) on synthetic
2-column activations ([beat-not-downbeat, downbeat]). Activations are stored rounded to 3 decimals; both sides
read them as float32(value).
"""
import hashlib
import json

import numpy as np
import torch

from common import FIXTURES, SPIKE  # noqa: F401  (also patches collections for madmom)

from madmom.features.beats_hmm import BarStateSpace, BarTransitionModel, RNNDownBeatTrackingObservationModel
from madmom.features.downbeats import DBNDownBeatTrackingProcessor

FPS = 100
MIN_INTERVAL = 60.0 * FPS / 215.0
MAX_INTERVAL = 60.0 * FPS / 55.0
THRESHOLD = 0.24


def sample_indices(n: int, k: int = 64) -> list:
    """k fixed indices spread over [0, n): floor(i * (n - 1) / (k - 1))."""
    return [int(i * (n - 1) // (k - 1)) for i in range(k)]


def summary(a, as_int: bool) -> dict:
    a = np.asarray(a)
    idx = sample_indices(len(a))
    cast = int if as_int else float
    return {"length": int(len(a)), "sum": cast(a.astype(np.float64).sum()) if not as_int else int(a.astype(np.int64).sum()),
            "indices": idx, "values": [cast(a[i]) for i in idx]}


def spaces() -> dict:
    out = {"minInterval": MIN_INTERVAL, "maxInterval": MAX_INTERVAL, "numTempi": 60, "transitionLambda": 100,
           "observationLambda": 16, "bars": []}
    for beats in (3, 4):
        st = BarStateSpace(beats, MIN_INTERVAL, MAX_INTERVAL, 60)
        tm = BarTransitionModel(st, 100)
        om = RNNDownBeatTrackingObservationModel(st, 16)
        out["bars"].append({
            "beatsPerBar": beats,
            "numStates": int(st.num_states),
            "nnz": int(len(tm.states)),
            "firstStates": [[int(s) for s in fs] for fs in st.first_states],
            "lastStates": [[int(s) for s in ls] for ls in st.last_states],
            "statePositions": summary(st.state_positions, False),
            "stateIntervals": summary(st.state_intervals, True),
            "pointers": summary(tm.pointers, True),
            "states": summary(tm.states, True),
            "logProbs": summary(tm.log_probabilities, False),
            "obsPointers": summary(om.pointers, True),
            "obsPointerCounts": [int((om.pointers == v).sum()) for v in (0, 1, 2)],
        })
    return out


def beat_track(T: int, period: float, beats_per_bar: int, offset: int, rng) -> np.ndarray:
    act = rng.uniform(0.001, 0.03, (T, 2))  # >= 0.001 after rounding: no log(0) densities
    k = 0
    while True:
        centre = int(round(offset + k * period))
        if centre >= T - 1:
            break
        col = 1 if k % beats_per_bar == 0 else 0
        peak = rng.uniform(0.55, 0.8)
        for dt, w in ((-2, 0.08), (-1, 0.35), (0, 1.0), (1, 0.45), (2, 0.12)):
            if 0 <= centre + dt < T:
                act[centre + dt, col] = max(act[centre + dt, col], peak * w)
        k += 1
    return act


def synthetic() -> dict:
    rng = np.random.default_rng(20261030)
    raw = {
        "120bpm_4_4": beat_track(2000, 50.0, 4, 37, rng),
        "140bpm_3_4": beat_track(2000, 6000.0 / 140.0, 3, 61, rng),
        "noise": rng.uniform(0.0, 0.01, (2000, 2)),
    }
    only0 = rng.uniform(0.0, 0.01, (300, 2))
    only0[0] = [0.5, 0.1]
    raw["only_frame0"] = only0

    proc = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], threshold=THRESHOLD, fps=FPS)
    cases = []
    for name, act in raw.items():
        act = np.round(act, 3)
        act32 = np.array(act.tolist(), dtype=np.float32)  # what the TypeScript side builds from the JSON
        res = proc(act32)
        case = {"name": name, "frames": int(len(act32)),
                "activations": [float(v) for v in np.round(act, 3).ravel()],
                "beats": [float(b) for b in res[:, 0]], "positions": [int(p) for p in res[:, 1]]}
        # the per-HMM decode on the threshold crop, for the viterbi tests
        idx = np.nonzero(act32 >= np.float32(THRESHOLD))[0]
        if idx.any():
            first, last = int(idx.min()), int(idx.max()) + 1
            crop = act32[first:last]
            case["crop"] = [first, last]
            case["hmm"] = []
            for hmm in proc.hmms:
                path, log_prob = hmm.viterbi(crop)
                p = np.asarray(path, dtype=np.int64)
                case["hmm"].append({"logProb": float(log_prob), "pathSum": int(p.sum()),
                                    "pathWeightedSum": int((p * np.arange(len(p))).sum() % 1000000007),
                                    "pathSamples": summary(p, True)})
        cases.append(case)
    return {"threshold": THRESHOLD, "fps": FPS, "cases": cases}


def exact_summary(a: np.ndarray, dtype) -> dict:
    """SHA-256 of a's little-endian bytes (as `dtype`), its element count, and the values at 64 fixed indices."""
    flat = np.ascontiguousarray(a).astype(dtype).ravel()
    assert np.isfinite(flat).all()
    idx = sample_indices(len(flat))
    return {"count": int(len(flat)), "sha256": hashlib.sha256(flat.tobytes()).hexdigest(),
            "indices": idx, "values": [float(flat[i]) for i in idx]}


def exact() -> dict:
    """allin1 1.1.0 postprocess_metrical_structure's activations (copied line for line) on the Flim mean logits."""
    tensors = SPIKE / "out" / "tensors"
    logits_beat = torch.from_numpy(np.load(tensors / "allin1_mean_logits_beat.npy"))
    logits_downbeat = torch.from_numpy(np.load(tensors / "allin1_mean_logits_downbeat.npy"))
    raw_prob_beats = torch.sigmoid(logits_beat[0])
    raw_prob_downbeats = torch.sigmoid(logits_downbeat[0])
    activations_beat = raw_prob_beats
    activations_downbeat = raw_prob_downbeats
    activations_no_beat = 1. - activations_beat
    activations_no_downbeat = 1. - activations_downbeat
    activations_no = (activations_no_beat + activations_no_downbeat) / 2.
    activations_xbeat = torch.maximum(torch.tensor(1e-8), activations_beat - activations_downbeat)
    activations_combined = torch.stack([activations_xbeat, activations_downbeat, activations_no], dim=-1)
    activations_combined /= activations_combined.sum(dim=-1, keepdim=True)
    activations_combined = activations_combined.cpu().numpy()
    act = activations_combined[:, :2]
    assert act.dtype == np.float32
    # log_densities does not depend on the bar length beyond the state space; use 3 beats per bar.
    st = BarStateSpace(3, MIN_INTERVAL, MAX_INTERVAL, 60)
    om = RNNDownBeatTrackingObservationModel(st, 16)
    dens = om.log_densities(act)
    assert dens.dtype == np.float64 and dens.shape == (len(act), 3)
    return {"frames": int(len(act)), "activations": exact_summary(act, "<f4"),
            "logDensities": exact_summary(dens, "<f8")}


def sigmoid_fixture() -> np.ndarray:
    rng = np.random.default_rng(7)
    x = np.concatenate([rng.normal(0.0, 4.0, 4000), rng.uniform(-110.0, 110.0, 96),
                        [0.0, -0.0, 88.0, -88.0, 104.5, -104.5, 7.306672, -7.351490, 1e-8]]).astype(np.float32)
    assert len(x) % 16 != 0
    return np.stack([x, torch.sigmoid(torch.from_numpy(x)).numpy()])


def main():
    np.save(FIXTURES / "dbn_sigmoid.npy", sigmoid_fixture())
    (FIXTURES / "dbn_spaces.json").write_text(json.dumps(spaces()))
    (FIXTURES / "dbn_exact.json").write_text(json.dumps(exact(), separators=(",", ":")))
    syn = synthetic()
    (FIXTURES / "dbn_synthetic.json").write_text(json.dumps(syn, separators=(",", ":")))
    for c in syn["cases"]:
        print(f"{c['name']}: {len(c['beats'])} beats, positions {c['positions'][:8]}, crop {c.get('crop')}")


if __name__ == "__main__":
    main()
