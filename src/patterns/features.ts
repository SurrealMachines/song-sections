// Feature cells: CELL_RATE (20) cells a second per source, each `dims` Int8 values with a fixed scale per dim, plus the
// cell's RMS loudness. Browser-safe (the dialog decodes these); the extractor is synchronous and streams, so a clip can
// be pushed in any chunks and gives the very same cells.
//
// The features are level-free: a bar played 6 dB quieter gives the same values (within a step or two), and level lives
// only in `loud`. Three groups, every one scaled to [-127, 127]:
//   chroma  12 pitch classes, C first, as a sharp (c/max)² of a peak-picked chroma (spike 2: sharp chroma makes pitch
//           decide the match). Peaks are interpolated, so a low bass note lands in its class even with ~5 Hz bins.
//           The engine should z-score the 12 with ONE pooled mean and sd, so that rotating the chroma (a transposition)
//           commutes with the normalisation.
//   shape   the spectral envelope: each band's energy relative to the cell's total, in dB, floored at -60.
//   flux    onsets: how much of the cell is new. The positive rise in each band's amplitude over the cell's 4 short
//           frames, over the amplitude of its loudest frame, so 1 is "all of it arrived here", a faint tail or noise
//           floor before an onset barely counts, and the scale is bounded. Frames are causal (a window ends at its
//           frame's time), so a frame never hears a hit before it happens. Drums and the mix get one per band; a tonal
//           source gets one onset dim, bin by bin, so a pitch change at a steady level counts too.
// Per kind (≤ 20 dims, the size budget of a 30-minute clip):
//   tonal  chroma 12 · shape 6 · onset 1   = 19
//   drums  flux 6 · shape 6                = 12
//   mix    chroma 12 · flux 4 · shape 4    = 20
import { CELL_RATE, LOUD_FLOOR_DB, decodeInt8, encodeInt8, type SourceCells, type SourceKind } from "./contract.js";
import { createRealFft, type RealFft } from "../structure/dsp/fft.js";

export interface FeatureRange {
  at: number;
  n: number;
}
export interface FeatureLayout {
  dims: number;
  chroma: FeatureRange | null; // 12 dims, C at `at`
  shape: FeatureRange;
  flux: FeatureRange;
}

export const FEATURE_LAYOUT: Record<SourceKind, FeatureLayout> = {
  tonal: { dims: 19, chroma: { at: 0, n: 12 }, shape: { at: 12, n: 6 }, flux: { at: 18, n: 1 } },
  drums: { dims: 12, chroma: null, flux: { at: 0, n: 6 }, shape: { at: 6, n: 6 } },
  mix: { dims: 20, chroma: { at: 0, n: 12 }, flux: { at: 12, n: 4 }, shape: { at: 16, n: 4 } },
};

// Band edges in Hz; the last band runs to Nyquist.
const TONAL_EDGES = [50, 108, 232, 500, 1077, 2321, Infinity]; // log-spaced, ~1.1 octaves each
const DRUM_EDGES = [30, 90, 200, 500, 1200, 2800, Infinity]; // kick, low toms/body, snare body, snare crack, presence, hats
const MIX_EDGES = [30, 150, 600, 2500, Infinity]; // kick/bass, low-mid, high-mid, hats/air

const LONG_SEC = 0.186; // the chroma window (2048 at 11025 Hz): resolves pitch
const SHORT_SEC = 0.046; // the onset and band-energy window (512 at 11025 Hz): resolves time
const SUBS = 4; // short frames per cell (12.5 ms apart)

const CHROMA_LO_HZ = 40;
const CHROMA_HI_HZ = 3000;
const PEAK_RANGE_DB = 60; // chroma ignores spectral peaks this far below the cell's highest
const PC_WINDOW = 4 / 3; // a peak feeds the pitch classes within 2/3 semitone, cos²-weighted (as HPCP does)

const ABS_FLOOR_DB = -100; // energy (mean square, dB) below this counts as silence
const SHAPE_RANGE_DB = 60;
const FLUX_MAX = 1; // the band flux scale's top (two onsets in one cell can rise past it, and clip)
const ONSET_MAX = 1.2; // the tonal onset's top: bins peak in different frames, so one onset can sum a little past 1
const ONSET_LO_HZ = 50; // the tonal onset's bins start here

const ABS_FLOOR_POW = 10 ** (ABS_FLOOR_DB / 10);
const ABS_FLOOR_AMP = Math.sqrt(ABS_FLOOR_POW);

/** v in [lo, hi] → [-127, 127], clamped. */
function quantise(v: number, lo: number, hi: number): number {
  const u = (v - lo) / (hi - lo);
  return Math.round((u <= 0 ? 0 : u >= 1 ? 1 : u) * 254 - 127);
}

const dB = (p: number) => 10 * Math.log10(p + 1e-30);

/** Hann-windowed power spectrum, scaled so a band's sum is its mean-square level (Parseval). */
class Spectrum {
  readonly n: number;
  readonly binHz: number;
  readonly power: Float64Array;
  private readonly fft: RealFft;
  private readonly w: Float64Array;
  private readonly buf: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly scale: number;

  constructor(n: number, rate: number) {
    this.n = n;
    this.binHz = rate / n;
    this.fft = createRealFft(n);
    this.w = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    this.scale = 1 / (n * this.w.reduce((s, v) => s + v * v, 0));
    this.buf = new Float64Array(n);
    this.re = new Float64Array(n / 2 + 1);
    this.im = new Float64Array(n / 2 + 1);
    this.power = new Float64Array(n / 2 + 1);
  }

  compute(sample: (abs: number) => number, start: number): Float64Array {
    for (let i = 0; i < this.n; i++) this.buf[i] = sample(start + i) * this.w[i];
    this.fft.forward(this.buf, this.re, this.im);
    const half = this.n / 2;
    for (let k = 0; k <= half; k++) {
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      this.power[k] = (k === 0 || k === half ? 1 : 2) * p * this.scale;
    }
    return this.power;
  }

  /** [k0, k1) bin ranges of the bands between consecutive edges (Infinity = Nyquist). */
  bands(edges: number[]): [number, number][] {
    const half = this.n / 2;
    const bin = (hz: number) => (hz === Infinity ? half + 1 : Math.min(half + 1, Math.max(1, Math.ceil(hz / this.binHz))));
    return edges.slice(1).map((hi, b) => [bin(edges[b]), bin(hi)]);
  }
}

function bandPowers(power: Float64Array, bands: [number, number][], out: Float64Array): Float64Array {
  bands.forEach(([k0, k1], b) => {
    let s = 0;
    for (let k = k0; k < k1; k++) s += power[k];
    out[b] = s;
  });
  return out;
}

/** Peak-picked chroma (C = 0) from a power spectrum, sharpened to (c/max)², each in [0, 1]. All 0 for silence. */
function chroma(power: Float64Array, binHz: number, out: Float64Array): Float64Array {
  out.fill(0);
  const k0 = Math.max(2, Math.ceil(CHROMA_LO_HZ / binHz));
  const k1 = Math.min(power.length - 2, Math.floor(CHROMA_HI_HZ / binHz));
  let top = 0;
  for (let k = k0; k <= k1; k++) top = Math.max(top, power[k]);
  const floor = Math.max(ABS_FLOOR_POW, top * 10 ** (-PEAK_RANGE_DB / 10));
  for (let k = k0; k <= k1; k++) {
    const p = power[k];
    if (p <= floor || p <= power[k - 1] || p < power[k + 1]) continue;
    // parabolic interpolation of the peak on dB
    const a = dB(power[k - 1]);
    const b = dB(p);
    const c = dB(power[k + 1]);
    const den = a - 2 * b + c;
    const off = den < 0 ? (0.5 * (a - c)) / den : 0;
    const mag = 10 ** ((b - 0.25 * (a - c) * off) / 20);
    const midi = 69 + 12 * Math.log2(((k + off) * binHz) / 440);
    const near = Math.round(midi);
    for (let m = near - 1; m <= near + 1; m++) {
      const d = Math.abs(midi - m);
      if (d < PC_WINDOW / 2) out[((m % 12) + 12) % 12] += mag * Math.cos((Math.PI * d) / PC_WINDOW) ** 2;
    }
  }
  let max = 0;
  for (let j = 0; j < 12; j++) max = Math.max(max, out[j]);
  for (let j = 0; j < 12; j++) out[j] = max > 0 ? (out[j] / max) ** 2 : 0;
  return out;
}

/** Each band's level relative to their total, in [-SHAPE_RANGE_DB, 0] dB. */
function shape(p: Float64Array, out: Float64Array): Float64Array {
  let total = 0;
  for (const v of p) total += v;
  const ref = dB(Math.max(total, ABS_FLOOR_POW));
  for (let b = 0; b < p.length; b++) out[b] = Math.max(-SHAPE_RANGE_DB, dB(p[b]) - ref);
  return out;
}

const pow2Window = (sec: number, rate: number) => 2 ** Math.max(5, Math.round(Math.log2(sec * rate)));

export interface CellExtractor {
  push(x: Float32Array): void;
  finish(): SourceCells;
}

/** Feature cells of a mono signal at `rate`. Synchronous; push in any chunks, then finish once. */
export function cellExtractor(kind: SourceKind, rate: number): CellExtractor {
  if (!(rate > 0)) throw new Error(`cellExtractor: bad rate ${rate}`);
  const layout = FEATURE_LAYOUT[kind];
  const dims = layout.dims;
  const hop = rate / CELL_RATE; // samples per cell (fractional)
  const long = layout.chroma ? new Spectrum(pow2Window(LONG_SEC, rate), rate) : null;
  const short = new Spectrum(pow2Window(SHORT_SEC, rate), rate);
  // drums and the mix take band flux and shape from the short frames; a tonal source only its bin-wise onset
  const shortBands = kind === "tonal" ? [] : short.bands(kind === "drums" ? DRUM_EDGES : MIX_EDGES);
  const longBands = long ? long.bands(TONAL_EDGES) : [];
  const nb = shortBands.length;

  const longStart = (i: number) => Math.round((i + 0.5) * hop - (long?.n ?? 0) / 2);
  // Short frame g stands for time (g + 1) · hop / SUBS, and its window ends there (causal).
  const subStart = (g: number) => Math.round(((g + 1) * hop) / SUBS) - short.n;
  const loudStart = (i: number) => Math.floor(i * hop);
  const needEnd = (i: number) =>
    Math.max(long ? longStart(i) + long.n : 0, subStart(SUBS * i + SUBS - 1) + short.n, loudStart(i + 1));
  const needStart = (i: number) => Math.min(long ? longStart(i) : Infinity, subStart(SUBS * i), loudStart(i));

  // input window: samples [base, base + len) are in buf; past the end (after finish) they are 0
  let buf = new Float32Array(1 << 14);
  let base = 0;
  let len = 0;
  let ended = false;
  const sample = (abs: number) => (abs < base || abs >= base + len ? 0 : buf[abs - base]);

  let out = new Int8Array(1 << 12);
  let loud = new Int8Array(1 << 8);
  let next = 0; // the next cell to compute
  let finished = false;

  // the previous short frame's band amplitudes, total amplitude and (tonal) bin powers, carried across cells
  const half = short.n / 2;
  const onsetK0 = Math.max(1, Math.ceil(ONSET_LO_HZ / short.binHz));
  let prevAmp = new Float64Array(nb);
  let curAmp = new Float64Array(nb);
  let prevBins = new Float64Array(half + 1);
  let curBins = new Float64Array(half + 1);
  let prevTotal = 0;
  let prevBinSum = 0;
  const bandP = new Float64Array(nb);
  const meanP = new Float64Array(nb);
  const flux = new Float64Array(nb);
  const shapeOut = new Float64Array(Math.max(nb, longBands.length));
  const longP = new Float64Array(longBands.length);
  const chromaOut = new Float64Array(12);

  /** Short frame g into curAmp/curBins (and bandP); returns its total amplitude and its bins' power sum. */
  const shortFrame = (g: number): [number, number] => {
    const power = short.compute(sample, subStart(g));
    bandPowers(power, shortBands, bandP);
    let total = 0;
    for (let b = 0; b < nb; b++) {
      curAmp[b] = Math.sqrt(bandP[b]);
      total += bandP[b];
    }
    let binSum = 0;
    if (kind === "tonal") {
      for (let k = onsetK0; k <= half; k++) binSum += curBins[k] = power[k];
    }
    return [Math.sqrt(total), binSum];
  };
  const swap = () => {
    [prevAmp, curAmp] = [curAmp, prevAmp];
    [prevBins, curBins] = [curBins, prevBins];
  };

  function cell(i: number) {
    if (out.length < (i + 1) * dims) {
      const grown = new Int8Array(out.length * 2 + dims);
      grown.set(out);
      out = grown;
    }
    if (loud.length < i + 1) {
      const grown = new Int8Array(loud.length * 2);
      grown.set(loud);
      loud = grown;
    }
    const row = i * dims;
    const put = (r: FeatureRange, values: ArrayLike<number>, lo: number, hi: number) => {
      for (let j = 0; j < r.n; j++) out[row + r.at + j] = quantise(values[j], lo, hi);
    };

    // onsets and short-frame band energy
    if (i === 0) {
      [prevTotal, prevBinSum] = shortFrame(-1);
      swap();
    }
    meanP.fill(0);
    flux.fill(0);
    let topTotal = prevTotal;
    let topBins = prevBinSum;
    let binRise = 0;
    for (let s = 0; s < SUBS; s++) {
      const [total, binSum] = shortFrame(SUBS * i + s);
      for (let b = 0; b < nb; b++) {
        flux[b] += Math.max(0, curAmp[b] - prevAmp[b]);
        meanP[b] += bandP[b] / SUBS;
      }
      if (kind === "tonal") for (let k = onsetK0; k <= half; k++) binRise += Math.max(0, curBins[k] - prevBins[k]);
      topTotal = Math.max(topTotal, total);
      topBins = Math.max(topBins, binSum);
      prevTotal = total;
      prevBinSum = binSum;
      swap();
    }
    if (kind === "tonal") {
      put(layout.flux, [Math.sqrt(binRise / Math.max(topBins, ABS_FLOOR_POW))], 0, ONSET_MAX);
    } else {
      for (let b = 0; b < nb; b++) flux[b] /= Math.max(topTotal, ABS_FLOOR_AMP);
      put(layout.flux, flux, 0, FLUX_MAX);
      put(layout.shape, shape(meanP, shapeOut), -SHAPE_RANGE_DB, 0);
    }

    // pitch (and, for tonal, the finer spectral shape) from the long frame
    if (long && layout.chroma) {
      const power = long.compute(sample, longStart(i));
      put(layout.chroma, chroma(power, long.binHz, chromaOut), 0, 1);
      if (kind === "tonal") put(layout.shape, shape(bandPowers(power, longBands, longP), shapeOut), -SHAPE_RANGE_DB, 0);
    }

    // loudness: RMS over the cell's own samples
    const a = loudStart(i);
    const b = ended ? Math.min(loudStart(i + 1), base + len) : loudStart(i + 1);
    let ms = 0;
    for (let k = a; k < b; k++) ms += sample(k) ** 2;
    const db = b > a ? 10 * Math.log10(ms / (b - a)) : -Infinity;
    loud[i] = db > LOUD_FLOOR_DB ? Math.min(127, Math.round(db)) : LOUD_FLOOR_DB;
  }

  return {
    push(x) {
      if (finished) throw new Error("cellExtractor: push after finish");
      if (len + x.length > buf.length) {
        const grown = new Float32Array(Math.max(2 * buf.length, len + x.length));
        grown.set(buf.subarray(0, len));
        buf = grown;
      }
      buf.set(x, len);
      len += x.length;
      while (needEnd(next) <= base + len) cell(next++);
      const drop = Math.min(len, Math.max(0, needStart(next) - base));
      if (drop > 0) {
        buf.copyWithin(0, drop, len);
        base += drop;
        len -= drop;
      }
    },
    finish() {
      if (finished) throw new Error("cellExtractor: finish called twice");
      finished = true;
      ended = true;
      const cells = Math.ceil(((base + len) * CELL_RATE) / rate);
      while (next < cells) cell(next++);
      return {
        kind,
        dims,
        cells,
        data: encodeInt8(out.subarray(0, cells * dims)),
        loud: encodeInt8(loud.subarray(0, cells)),
      };
    },
  };
}

export interface DecodedSource {
  kind: SourceKind;
  dims: number;
  cells: number;
  data: Int8Array; // [cells · dims], row-major, laid out as FEATURE_LAYOUT[kind]
  loudDb: Int8Array; // [cells]
}

export function decodeSource(s: SourceCells): DecodedSource {
  const data = decodeInt8(s.data);
  const loudDb = decodeInt8(s.loud);
  if (data.length !== s.cells * s.dims || loudDb.length !== s.cells) {
    throw new Error(`decodeSource: ${s.kind} has ${data.length} values and ${loudDb.length} loudness cells for ${s.cells} cells`);
  }
  return { kind: s.kind, dims: s.dims, cells: s.cells, data, loudDb };
}
