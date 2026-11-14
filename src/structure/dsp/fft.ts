import FFT from "fft.js";

export interface RealFft {
  /** x (length n) -> bins 0..n/2 into re/im (length n/2 + 1). Float64 throughout. */
  forward(x: ArrayLike<number>, re: Float64Array, im: Float64Array): void;
  /** bins 0..n/2 -> n real samples into out, UNSCALED (divide by n to invert `forward`). */
  inverse(re: Float64Array, im: Float64Array, out: Float64Array): void;
}

/** Real-input FFT of size n (a power of two), wrapping fft.js. */
export function createRealFft(n: number): RealFft {
  const fft = new FFT(n);
  const half = n / 2;
  const input = new Float64Array(n);
  const spec = fft.createComplexArray() as number[]; // interleaved, 2n
  const cin = new Float64Array(2 * n);
  const cout = new Float64Array(2 * n);
  return {
    forward(x, re, im) {
      for (let i = 0; i < n; i++) input[i] = x[i];
      fft.realTransform(spec, input);
      for (let k = 0; k <= half; k++) {
        re[k] = spec[2 * k];
        im[k] = spec[2 * k + 1];
      }
    },
    inverse(re, im, out) {
      // Unscaled inverse via conj(FFT(conj(X))) on the Hermitian-completed spectrum, so
      // fft.js's built-in 1/n scaling is never applied and undone.
      for (let k = 0; k <= half; k++) {
        cin[2 * k] = re[k];
        cin[2 * k + 1] = -im[k];
        if (k > 0 && k < half) {
          cin[2 * (n - k)] = re[k];
          cin[2 * (n - k) + 1] = im[k];
        }
      }
      fft.transform(cout, cin);
      for (let i = 0; i < n; i++) out[i] = cout[2 * i];
    },
  };
}
