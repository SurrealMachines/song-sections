"""signal_ref.npy: test_signal(1024, 2, 44100), pinning the TS/Python testSignal identity (src/test/plumbing.test.ts)."""
from common import save, test_signal

save("signal_ref.npy", test_signal(1024, 2, 44100))
