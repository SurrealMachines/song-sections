// allin1 1.1.0 postprocess_metrical_structure's activations, reproducing torch 2.5.1's CPU float32 arithmetic.
//
// torch.sigmoid(x) on CPU is 1 / (1 + exp(-x)) in float32. Its vectorised loop runs in blocks of 2 × 8 lanes
// (ARM VEC256) using Sleef_expf_u10, and the remaining n % 16 elements go through the scalar op, std::exp
// (correctly rounded in practice). Sleef's expf is not correctly rounded, so a plain Math.exp differs from torch
// on ~8% of inputs. The port below is bit-exact against torch on the fixture and on 2M random inputs.

const f32 = Math.fround;

const fbuf = new Float32Array(1);
const ibuf = new Int32Array(fbuf.buffer);

/** The float32 adjacent to r (a float32), towards +∞ when up, else towards -∞. */
function adjacent(r: number, up: boolean): number {
  if (r === 0) return up ? 1.401298464324817e-45 : -1.401298464324817e-45;
  fbuf[0] = r;
  ibuf[0] += up === r > 0 ? 1 : -1;
  return fbuf[0];
}

/** Fused float32 multiply-add round32(a·b + c) for float32 a, b, c (AdvSIMD vfmaq_f32). */
export function fmaf(a: number, b: number, c: number): number {
  const p = a * b; // exact: 24 + 24 bits
  const s = p + c;
  const bb = s - p;
  const e = (p - (s - bb)) + (c - bb); // s + e is exactly p + c
  const r = f32(s);
  if (e === 0 || r === s) return r;
  // Double rounding can only go wrong when s sits exactly on a float32 midpoint; the error term breaks the tie.
  const n = adjacent(r, s > r);
  if ((r + n) / 2 === s) return e > 0 ? Math.max(r, n) : Math.min(r, n);
  return r;
}

const R_LN2f = f32(1.442695040888963407359924681001892137426645954152985934135449406931);
const L2Uf = f32(0.693145751953125);
const L2Lf = f32(1.428606765330187045e-6);
const P = [
  0.000198527617612853646278381, 0.00139304355252534151077271, 0.00833336077630519866943359, 0.0416664853692054748535156,
  0.166666671633720397949219, 0.5,
].map(f32);

function rintEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Sleef 3.x xexpf (expf_u10), as torch's AdvSIMD build runs it: FMA for every vmla. */
export function sleefExpf(d: number): number {
  const q = rintEven(f32(d * R_LN2f));
  let s = fmaf(q, -L2Uf, d);
  s = fmaf(q, -L2Lf, s);
  let u = P[0];
  for (let k = 1; k < P.length; k++) u = fmaf(u, s, P[k]);
  u = f32(1 + fmaf(f32(s * s), u, s));
  const h = q >> 1; // vldexp2: u · 2^(q>>1) · 2^(q - (q>>1))
  u = f32(f32(u * 2 ** h) * 2 ** (q - h));
  if (d < -104) u = 0;
  if (100 < d) u = Infinity;
  return u;
}

/** torch.sigmoid on a contiguous float32 vector (one TensorIterator chunk; see the note in the report on > 32768 frames). */
export function torchSigmoid(x: Float32Array): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const vec = n - (n % 16);
  for (let i = 0; i < vec; i++) out[i] = f32(1 / f32(1 + sleefExpf(f32(-x[i]))));
  for (let i = vec; i < n; i++) out[i] = f32(1 / f32(1 + f32(Math.exp(-x[i]))));
  return out;
}

/**
 * allin1's madmom input: b = σ(beat), d = σ(downbeat), xbeat = max(1e-8, b - d), no = ((1 - b) + (1 - d)) / 2,
 * each row of [xbeat, d, no] divided by its sum. Returns the [xbeat, d] columns, row-major T×2 float32.
 */
export function downbeatActivations(beatLogits: Float32Array, downbeatLogits: Float32Array): Float32Array {
  const T = Math.min(beatLogits.length, downbeatLogits.length);
  const b = torchSigmoid(beatLogits.length === T ? beatLogits : beatLogits.subarray(0, T));
  const d = torchSigmoid(downbeatLogits.length === T ? downbeatLogits : downbeatLogits.subarray(0, T));
  const tiny = f32(1e-8);
  const out = new Float32Array(2 * T);
  for (let t = 0; t < T; t++) {
    const pb = b[t];
    const pd = d[t];
    const no = f32(f32(f32(1 - pb) + f32(1 - pd)) / 2);
    const xb = Math.max(tiny, f32(pb - pd));
    const sum = f32(f32(xb + pd) + no);
    out[2 * t] = f32(xb / sum);
    out[2 * t + 1] = f32(pd / sum);
  }
  return out;
}
