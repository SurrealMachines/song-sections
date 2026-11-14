import { describe, expect, it } from "vitest";
import { testSignal } from "../../test/signals.js";
import { createRealFft } from "./fft.js";

function naiveDft(x: ArrayLike<number>) {
  const n = x.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let a = 0, b = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * ((k * t) % n)) / n;
      a += x[t] * Math.cos(ang);
      b += x[t] * Math.sin(ang);
    }
    re[k] = a;
    im[k] = b;
  }
  return { re, im };
}

describe("createRealFft", () => {
  for (const n of [64, 4096]) {
    it(`forward matches a naive DFT for n = ${n}`, () => {
      const [x] = testSignal(n, 1, 44100);
      const fft = createRealFft(n);
      const re = new Float64Array(n / 2 + 1);
      const im = new Float64Array(n / 2 + 1);
      fft.forward(x, re, im);
      const ref = naiveDft(x);
      let num = 0, den = 0;
      for (let k = 0; k <= n / 2; k++) {
        num += (re[k] - ref.re[k]) ** 2 + (im[k] - ref.im[k]) ** 2;
        den += ref.re[k] ** 2 + ref.im[k] ** 2;
      }
      expect(Math.sqrt(num / den)).toBeLessThanOrEqual(1e-9);
      expect(im[0]).toBeCloseTo(0, 12);
      expect(im[n / 2]).toBeCloseTo(0, 9);
    });

    it(`inverse(forward(x)) / n equals x for n = ${n}`, () => {
      const [x] = testSignal(n, 1, 44100);
      const fft = createRealFft(n);
      const re = new Float64Array(n / 2 + 1);
      const im = new Float64Array(n / 2 + 1);
      fft.forward(x, re, im);
      const out = new Float64Array(n);
      fft.inverse(re, im, out);
      let maxErr = 0;
      for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(out[i] / n - x[i]));
      expect(maxErr).toBeLessThanOrEqual(1e-12);
    });
  }

  it("can be reused and does not modify its input", () => {
    const [x] = testSignal(64, 1, 44100);
    const copy = Float32Array.from(x);
    const fft = createRealFft(64);
    const a = [new Float64Array(33), new Float64Array(33)];
    const b = [new Float64Array(33), new Float64Array(33)];
    fft.forward(x, a[0], a[1]);
    fft.forward(x, b[0], b[1]);
    expect(b).toEqual(a);
    expect(x).toEqual(copy);
  });
});
