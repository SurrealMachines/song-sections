/**
 * Deterministic test signal shared with tools/golden/common.py (keep the two expressions identical):
 * x_c[i] = 0.5 sin(2π 440 i/rate + c) + 0.25 sin(2π 1234.5 (i/rate)(1 + i/n)) + 0.1 sin(2π 3 i/rate),
 * computed in float64 and stored as float32.
 */
export function testSignal(n: number, channels: number, rate: number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] =
        0.5 * Math.sin((2 * Math.PI * 440 * i) / rate + c) +
        0.25 * Math.sin(2 * Math.PI * 1234.5 * (i / rate) * (1 + i / n)) +
        0.1 * Math.sin((2 * Math.PI * 3 * i) / rate);
    }
    return x;
  });
}
