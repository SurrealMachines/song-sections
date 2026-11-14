import { describe, expect, it } from "vitest";
import { detailBin, detailColumns, detailCovers, detailRange, needsDetail, reduceDetail } from "./stemDetail.js";

describe("stemDetail (fb4, item 2)", () => {
  it("needs the samples once a 20 Hz block is DETAIL_PX (2) wide or more", () => {
    expect(needsDetail({ start: 0, span: 60 }, 1000)).toBe(false); // 1200 blocks over 1000 px
    expect(needsDetail({ start: 0, span: 25 }, 1000)).toBe(false); // exactly 2 px a block
    expect(needsDetail({ start: 0, span: 24 }, 1000)).toBe(true);
    expect(needsDetail({ start: 0, span: 1 }, 0)).toBe(false);
  });

  it("fetches the view and a quarter of it either side, inside the clip", () => {
    expect(detailRange({ start: 100, span: 20 }, 1800)).toEqual({ start: 95, end: 125 });
    expect(detailRange({ start: 2, span: 20 }, 24)).toEqual({ start: 0, end: 24 });
  });

  it("bins a power of two frames, no wider than a column, at least 16", () => {
    expect(detailBin({ start: 0, span: 20 }, 1000, 44100)).toBe(512); // 882 frames a column
    expect(detailBin({ start: 0, span: 0.1 }, 1000, 44100)).toBe(16);
  });

  it("reduces a stereo slice to the max |sample| per bin, and draws the columns from it", () => {
    const frames = 4410; // 0.1 s
    const samples = new Int16Array(frames * 2);
    samples[2 * 100] = 16384; // left, bin 6
    samples[2 * 1000 + 1] = -32768; // right, bin 62
    const d = reduceDetail({ rate: 44100, channels: 2, frames, samples }, 10, 16);
    expect(d.start).toBe(10);
    expect(d.end).toBeCloseTo(10.1, 12);
    expect(d.peak.length).toBe(Math.ceil(frames / 16));
    expect(d.peak[6]).toBe(0.5);
    expect(d.peak[62]).toBe(1);
    expect(d.peak[7]).toBe(0);
    const v = { start: 10, span: 0.1 };
    expect(detailCovers(d, v, 200)).toBe(true);
    const cols = detailColumns(d, v, 200);
    // Each peak lands in the column its frame is in, or the next (a bin goes to the column its end is in).
    const at = (f: number) => Math.floor((f / frames) * 200);
    expect(Math.max(cols[at(100)], cols[at(100) + 1])).toBe(0.5);
    expect(Math.max(cols[at(1000)], cols[at(1000) + 1])).toBe(1);
    expect(Math.max(...cols)).toBe(1);
    expect(cols.filter((x) => x > 0)).toHaveLength(2);
  });

  it("draws the columns into a buffer it is given, without allocating (fb4 review M4)", () => {
    const d = { start: 0, end: 1, binSec: 0.01, peak: Float32Array.from({ length: 100 }, (_, i) => i / 100) };
    const v = { start: 0, span: 1 };
    const buf = new Float32Array(500).fill(9);
    const got = detailColumns(d, v, 50, buf);
    expect(got).toBe(buf);
    expect(Array.from(got.subarray(0, 50))).toEqual(Array.from(detailColumns(d, v, 50)));
  });

  it("covers a view inside its range with bins at most two columns wide; not a pan off it or a zoom past it", () => {
    const d = { start: 95, end: 125, binSec: 512 / 44100, peak: new Float32Array(2584) };
    expect(detailCovers(d, { start: 100, span: 20 }, 1000)).toBe(true);
    expect(detailCovers(d, { start: 110, span: 20 }, 1000)).toBe(false);
    expect(detailCovers(d, { start: 100, span: 5 }, 1000)).toBe(false); // a column is 5 ms, a bin 11.6 ms
    expect(detailCovers(undefined, { start: 100, span: 20 }, 1000)).toBe(false);
  });

  // fb4 review I1: the stem slice route rounds both ends to a frame, so at the clip's right edge (where the fetch is
  // clamped to the duration and there is no margin) the slice can end a frame before the view does. It must still
  // count as covering, or the view stays coarse and every settle fetches all four stems again.
  describe("a view flush with the clip's end (fb4 review I1)", () => {
    const RATE = 44100;
    /** What the stem slice route returns for the range (dialogServer.ts), reduced as the component does. */
    const fetched = (duration: number, view: { start: number; span: number }, stemFrames: number, width = 1000) => {
      const { start, end } = detailRange(view, duration);
      const f0 = Math.min(stemFrames, Math.max(0, Math.round(start * RATE)));
      const f1 = Math.min(stemFrames, Math.max(f0, Math.round(end * RATE)));
      const frames = f1 - f0;
      const pcm = { rate: RATE, channels: 2, frames, samples: new Int16Array(frames * 2) };
      return reduceDetail(pcm, start, detailBin(view, width, RATE));
    };
    const spans = [0.7, 3.3, 5.6, 12.5];
    const durations = [183.337, 241.0004, 197.50011, 99.99997, 1800.123456];

    for (const [name, stemFrames] of [
      ["round(duration × rate) frames", (d: number) => Math.round(d * RATE)],
      ["floor(duration × rate) frames", (d: number) => Math.floor(d * RATE)],
      ["a frame short", (d: number) => Math.round(d * RATE) - 1],
      ["a few ms short", (d: number) => Math.round(d * RATE) - 441],
    ] as const) {
      it(`covers the last view of a clip whose stems are ${name}`, () => {
        for (const duration of durations) {
          for (const span of spans) {
            const view = { start: duration - span, span };
            const d = fetched(duration, view, stemFrames(duration));
            expect(detailCovers(d, view, 1000, duration), `duration ${duration}, span ${span}`).toBe(true);
          }
        }
      });
    }

    it("still does not cover a view that runs well past the slice's end", () => {
      const view = { start: 100, span: 20 };
      const d = fetched(183.337, view, Math.round(183.337 * RATE));
      expect(detailCovers(d, { start: 110, span: 20 }, 1000, 183.337)).toBe(false);
      expect(detailCovers(d, { start: 183.337 - 30, span: 30 }, 1000, 183.337)).toBe(false);
    });
  });
});
