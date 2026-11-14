"""resample_48k_44k.npy: julius.resample_frac(testSignal(24000, 1, 48000)[0], 48000, 44100) as float32 (22050 samples)."""
import torch
import julius

from common import save, test_signal

x = torch.from_numpy(test_signal(24000, 1, 48000)[0])
y = julius.resample_frac(x, 48000, 44100)
assert y.shape[-1] == 22050, y.shape
save("resample_48k_44k.npy", y.numpy().astype("float32"))

# Other ratios: downsampling by 96000/44100 (GCD 300 -> 320/147) and the upsampling branch (22050 -> 44100).
x96 = torch.from_numpy(test_signal(4800, 1, 96000)[0])
y96 = julius.resample_frac(x96, 96000, 44100)
assert y96.shape[-1] == 2205, y96.shape
save("resample_96k_44k.npy", y96.numpy().astype("float32"))
x22 = torch.from_numpy(test_signal(2000, 1, 22050)[0])
y22 = julius.resample_frac(x22, 22050, 44100)
assert y22.shape[-1] == 4000, y22.shape
save("resample_22k_44k.npy", y22.numpy().astype("float32"))
