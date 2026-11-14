"""Pure-torch drop-ins for the four NATTEN 0.17 ops allin1 1.1.0 calls, plus the patch.

    natten1dqkrpb(q, k, rpb, kernel_size, dilation)  q, k: (B, H, L, D)    -> (B, H, L, ks)
    natten1dav(attn, v, kernel_size, dilation)        attn: (B, H, L, ks)   -> (B, H, L, D)
    natten2dqkrpb(q, k, rpb, kernel_size, dilation)  q, k: (B, H, X, Y, D) -> (B, H, X, Y, ks*ks)
    natten2dav(attn, v, kernel_size, dilation)        attn: (..., ks*ks)    -> (B, H, X, Y, D)

Semantics copied from NATTEN 0.17.4's CPU reference kernels
(csrc/include/natten/cpu/naive/natten_cpu_commons.h, `get_window_start` / `get_pb_start`):

- Dilation d splits the axis into d interleaved groups (index % d). A query attends only
  within its group, to `ks` group members.
- The window is centred on the query but **clamped** to stay inside the group: in group
  coordinates (j = index // d, group length Lg = ceil((L - index % d) / d)) it starts at
  clamp(j - ks//2, 0, Lg - ks). Edge queries therefore see a shifted window, not a
  zero-padded one, which is why this is a gather over computed indices and not
  `unfold` + mask (unfold + mask would give edge queries fewer keys than NATTEN does).
- The relative-position bias index is (key_j - query_j) + ks - 1 into a table of 2*ks - 1.
- NATTEN requires every group to hold at least `ks` members (L >= ks * d); allin1 pads
  the sequence to guarantee it (see `patch_allin1`).

Everything is built from arange / integer arithmetic on the (dynamic) axis length, Gather
(advanced indexing) and MatMul, so it traces into a graph whose time axis stays dynamic
in ONNX, and contains only standard ops.

`patch_model()` swaps these ops into a loaded allin1 model and replaces the two
`maybe_pad` methods with export-friendly equivalents (see their docstrings). Run the
patched model inside `shared_neighborhoods()` when exporting, so the index tensors are
built once per graph instead of once per call.
"""

from contextlib import contextmanager

import numpy as np
import torch
from torch import Tensor
from torch.nn import functional as F

# While `shared_neighborhoods()` is active: the time-axis length and the neighborhood
# index tensors, computed once per forward pass and reused by every layer and fold.
_shared = None


@contextmanager
def shared_neighborhoods():
    """Compute each distinct neighborhood index set once per forward pass.

    Without this, every qk and av call of every layer (and every fold of the ensemble)
    rebuilds its indices from the axis length, which costs ~45 graph nodes each: the
    8-fold export had 75k nodes and took 130-190 s to load in onnxruntime. Inside the
    context, the indices depend on one shared time-length value and are keyed by
    (kernel, dilation, pad window), so they are built once and shared.
    """
    global _shared
    _shared = {}
    try:
        yield
    finally:
        _shared = None


def _axis_length(x: Tensor, dim: int) -> Tensor:
    """The length of `dim` as a 0-d tensor, so torch.onnx.export traces it as a Shape op
    rather than freezing the example input's length into the graph."""
    return torch._shape_as_tensor(x)[dim]


def _neighborhood_static(length: int, kernel_size: int, dilation: int):
    """`neighborhood` for a static length (allin1's instrument axis): graph constants.

    Under tracing the size arrives as a traced value; int() freezes it, which is correct
    here because the instrument axis is fixed by the architecture (4 stems, padded to 5).
    """
    length = int(length)
    nh = kernel_size // 2
    i = np.arange(length)
    g, j = i % dilation, i // dilation
    group_len = (length - g + dilation - 1) // dilation
    start = np.minimum(np.maximum(j - nh, 0), group_len - kernel_size)
    pos = start[:, None] + np.arange(kernel_size)[None, :]
    return torch.from_numpy(g[:, None] + dilation * pos), torch.from_numpy(pos - j[:, None] + kernel_size - 1)


def neighborhood(length, kernel_size: int, dilation: int, device=None):
    """Key indices and bias indices of each query's neighborhood along one axis.

    Returns (keys, bias), both int64 of shape (length, kernel_size): `keys[i, n]` is the
    index of query i's n-th key, `bias[i, n]` the index into the 2*ks-1 bias table.
    All quantities are non-negative, so integer division can truncate.
    """
    nh = kernel_size // 2
    i = torch.arange(length, device=device)
    n = torch.arange(kernel_size, device=device)
    if dilation == 1:
        start = torch.minimum(torch.clamp(i - nh, min=0), length - kernel_size)
        pos = start[:, None] + n[None, :]
        return pos, pos - i[:, None] + (kernel_size - 1)
    g = i % dilation  # group (dilation phase)
    j = torch.div(i, dilation, rounding_mode="trunc")  # position within the group
    group_len = torch.div(length - g + (dilation - 1), dilation, rounding_mode="trunc")
    start = torch.minimum(torch.clamp(j - nh, min=0), group_len - kernel_size)
    pos = start[:, None] + n[None, :]  # key positions in group coordinates
    keys = g[:, None] + dilation * pos
    bias = pos - j[:, None] + (kernel_size - 1)
    return keys, bias


def _time_neighborhood(x: Tensor, dim: int, kernel_size: int, dilation: int):
    """Neighborhood along the dynamic time axis `dim` of `x`, shared when possible."""
    if _shared is None or "length" not in _shared:
        return neighborhood(_axis_length(x, dim), kernel_size, dilation, x.device)
    window, length = _shared["length"]
    key = (kernel_size, dilation, window)
    if key not in _shared:
        _shared[key] = neighborhood(length, kernel_size, dilation, x.device)
    return _shared[key]


def _shared_time_length(hidden_states: Tensor, dim: int):
    """The input's time length T (one traced value per forward while sharing)."""
    if _shared is None:
        return _axis_length(hidden_states, dim)
    if "T" not in _shared:
        _shared["T"] = _axis_length(hidden_states, dim)
    return _shared["T"]


def natten1dqkrpb(query: Tensor, key: Tensor, rpb: Tensor, kernel_size: int, dilation: int) -> Tensor:
    keys, bias = _time_neighborhood(query, 2, kernel_size, dilation)
    k_nb = key[:, :, keys]  # (B, H, L, ks, D)
    scores = torch.matmul(k_nb, query.unsqueeze(-1)).squeeze(-1)  # (B, H, L, ks)
    if rpb is not None:
        scores = scores + rpb[:, bias]  # (H, L, ks)
    return scores


def natten1dav(attn: Tensor, value: Tensor, kernel_size: int, dilation: int) -> Tensor:
    keys, _ = _time_neighborhood(value, 2, kernel_size, dilation)
    v_nb = value[:, :, keys]  # (B, H, L, ks, D)
    return torch.matmul(attn.unsqueeze(-2), v_nb).squeeze(-2)  # (B, H, L, D)


def _one_hot_rows(keys: Tensor, length: int) -> Tensor:
    """(X, ks) static key indices -> (X, ks, X) float one-hot, so a gather over rows is a
    MatMul (exact: one 1.0 per sum)."""
    rows = torch.arange(int(length))
    return (keys[:, :, None] == rows[None, None, :]).to(torch.float32)


def natten2dqkrpb(query: Tensor, key: Tensor, rpb: Tensor, kernel_size: int, dilation: int) -> Tensor:
    # query, key: (B, H, X, Y, D); X is allin1's (padded) instrument axis, Y is time.
    B, H, X, _, D = query.shape
    ks = kernel_size
    keys_x, bias_x = _neighborhood_static(X, ks, dilation)
    keys_y, bias_y = _time_neighborhood(query, 3, ks, dilation)

    # Gather the time neighborhood of every key row: (B, H, Z, Y, ky, D), Z = all X rows.
    k_y = key[:, :, :, keys_y]
    k_y = k_y.permute(0, 1, 3, 5, 2, 4).reshape(B, H, -1, D, X * ks)  # (B, H, Y, D, Z*ky)
    q = query.permute(0, 1, 3, 2, 4)  # (B, H, Y, X, D)
    s = torch.matmul(q, k_y).reshape(B, H, -1, X, X, ks)  # (B, H, Y, x, z, ky)
    # Pick each query row's ks key rows z = keys_x[x, kx] with a one-hot MatMul (exact).
    s = torch.matmul(_one_hot_rows(keys_x, X), s)  # (X, kx, Z) @ (..., x, Z, ky) -> (B, H, Y, x, kx, ky)
    if rpb is not None:
        b = rpb[:, bias_x][:, :, :, bias_y]  # (H, X, kx, Y, ky)
        s = s + b.permute(0, 3, 1, 2, 4)  # (H, Y, X, kx, ky)
    return s.permute(0, 1, 3, 2, 4, 5).reshape(B, H, X, -1, ks * ks)


def natten2dav(attn: Tensor, value: Tensor, kernel_size: int, dilation: int) -> Tensor:
    B, H, X, _, D = value.shape
    ks = kernel_size
    keys_x, _ = _neighborhood_static(X, ks, dilation)
    keys_y, _ = _time_neighborhood(value, 3, ks, dilation)

    a = attn.reshape(B, H, X, -1, ks, ks).permute(0, 1, 3, 2, 4, 5)  # (B, H, Y, x, kx, ky)
    # Scatter the kx weights back onto all key rows z: (B, H, Y, x, Z, ky).
    a = torch.matmul(_one_hot_rows(keys_x, X).transpose(1, 2), a)  # (X, Z, kx) @ (..., x, kx, ky)
    a = a.reshape(B, H, -1, X, X * ks)
    v_y = value[:, :, :, keys_y]  # (B, H, Z, Y, ky, D)
    v_y = v_y.permute(0, 1, 3, 2, 4, 5).reshape(B, H, -1, X * ks, D)  # (B, H, Y, Z*ky, D)
    out = torch.matmul(a, v_y)  # (B, H, Y, X, D)
    return out.permute(0, 1, 3, 2, 4)


def _maybe_pad_1d(self, hidden_states: Tensor, frames):
    """Export-friendly DinatLayer1d.maybe_pad (allin1 pads T up to the window if shorter).

    allin1's version branches in Python on `frames < window_size`, which tracing would
    freeze at the example length. This always appends `window_size` zero frames and then
    keeps the first max(T, window_size) of them: identical output for any T, with no
    Python branch. Returning a positive pad makes the caller trim the result back to T.
    """
    window = self.window_size
    padded = F.pad(hidden_states, (0, 0, 0, window))
    length = torch.clamp(_shared_time_length(hidden_states, 1), min=window)
    padded = padded.index_select(1, torch.arange(length, device=hidden_states.device))
    if _shared is not None:
        _shared["length"] = (window, length)  # what this layer's attention calls see
    return padded, (0, 0, 0, window)


def _maybe_pad_2d(self, hidden_states: Tensor, height, width):
    """Export-friendly DinatLayer2d.maybe_pad: pad only the (static) instrument axis.

    allin1 pads instruments 4 -> 5 (= kernel size) and would pad time only if T < 5 frames
    (50 ms), which no real track hits; the time branch is dropped so nothing is traced
    against the example length.
    """
    pad_b = max(0, self.window_size - height)
    pad_values = (0, 0, 0, 0, 0, pad_b)
    if pad_b:
        hidden_states = F.pad(hidden_states, pad_values)
    if _shared is not None:
        _shared["length"] = (None, _shared_time_length(hidden_states, 2))
    return hidden_states, pad_values


def patch_allin1():
    """Route allin1's DiNAT modules through the pure-torch ops above. Models built after
    this call use them; for models already built, use `patch_model` (each attention
    instance holds its own reference to the op)."""
    from allin1.models import dinat

    dinat.natten1dqkrpb, dinat.natten1dav = natten1dqkrpb, natten1dav
    dinat.natten2dqkrpb, dinat.natten2dav = natten2dqkrpb, natten2dav
    dinat.DinatLayer1d.maybe_pad = _maybe_pad_1d
    dinat.DinatLayer2d.maybe_pad = _maybe_pad_2d


def patch_model(model: torch.nn.Module) -> torch.nn.Module:
    """Point every neighborhood-attention instance in `model` at the pure-torch ops."""
    from allin1.models import dinat

    patch_allin1()
    # allin1's Ensemble keeps its folds in a plain list, invisible to .modules().
    roots = [model, *getattr(model, "models", [])]
    for m in (m for root in roots for m in root.modules()):
        if isinstance(m, dinat.NeighborhoodAttention1d):
            m.nattendqkrpb, m.nattendav = natten1dqkrpb, natten1dav
        elif isinstance(m, dinat.NeighborhoodAttention2d):
            m.nattendqkrpb, m.nattendav = natten2dqkrpb, natten2dav
    return model
