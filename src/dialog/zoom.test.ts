import { describe, expect, it } from "vitest";
import { clampView, edgeSpeed, fitView, MIN_SPAN_SEC, minSpan, panBy, timeAt, toFrac, visibleSlice, wheelZoomFactor, zoomAround, zoomLevel } from "./zoom.js";

const D = 180;

describe("zoom maths (fb3, item 5)", () => {
  it("fit shows the whole clip", () => {
    expect(fitView(D)).toEqual({ start: 0, span: D });
    expect(zoomLevel(fitView(D), D)).toBe(1);
  });

  it("zooms around the anchor: the time under the pointer stays under it", () => {
    const v = zoomAround(fitView(D), D, 8, 0.25); // pointer a quarter of the way in, at 45 s
    expect(v.span).toBeCloseTo(D / 8, 12);
    expect(timeAt(v, 0.25)).toBeCloseTo(45, 12);
    const w = zoomAround(v, D, 0.5, 0.75);
    expect(w.span).toBeCloseTo(D / 4, 12);
    expect(timeAt(w, 0.75)).toBeCloseTo(timeAt(v, 0.75), 12);
  });

  it("stays inside the clip and between fit and the deepest zoom", () => {
    const left = zoomAround(fitView(D), D, 8, 0);
    expect(left.start).toBe(0);
    const right = zoomAround(fitView(D), D, 8, 1);
    expect(right.start + right.span).toBeCloseTo(D, 12);
    expect(zoomAround(fitView(D), D, 0.5, 0.5)).toEqual(fitView(D));
    const deep = zoomAround(fitView(D), D, 1e6, 0.5);
    expect(deep.span).toBe(minSpan(D));
    // fb4: a second across the view, however long the clip (under a bar up to 240 BPM).
    expect(minSpan(D)).toBe(MIN_SPAN_SEC);
    expect(MIN_SPAN_SEC).toBe(1);
    expect(minSpan(3600)).toBe(1);
    expect(minSpan(0.5)).toBe(0.5);
    expect(clampView({ start: -5, span: 400 }, D)).toEqual(fitView(D));
  });

  it("pans by seconds, clamped at both ends", () => {
    const v = { start: 50, span: 20 };
    expect(panBy(v, D, 10)).toEqual({ start: 60, span: 20 });
    expect(panBy(v, D, -100)).toEqual({ start: 0, span: 20 });
    expect(panBy(v, D, 1000)).toEqual({ start: 160, span: 20 });
  });

  it("maps times to fractions of the view and back", () => {
    const v = { start: 40, span: 20 };
    expect(toFrac(v, 45)).toBe(0.25);
    expect(timeAt(v, 0.5)).toBe(50);
    expect(toFrac(v, 30)).toBe(-0.5); // left of the view
  });

  it("wheel deltas zoom smoothly: up zooms in, down out, inverse pairs cancel", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(40) * wheelZoomFactor(-40)).toBeCloseTo(1, 12);
  });

  it("auto-scroll speed near a view edge: 0 inside, up to ±1 at and past the edge", () => {
    expect(edgeSpeed(500, 1000, 30)).toBe(0);
    expect(edgeSpeed(15, 1000, 30)).toBeCloseTo(-0.5, 12);
    expect(edgeSpeed(-50, 1000, 30)).toBe(-1);
    expect(edgeSpeed(1000, 1000, 30)).toBe(1);
    expect(edgeSpeed(985, 1000, 30)).toBeCloseTo(0.5, 12);
  });

  it("the data points a view covers: whole points just past both edges, clamped to the data", () => {
    // 2000 points over 180 s: a 22.5 s view from 45 s covers points 500..750.
    expect(visibleSlice({ start: 45, span: 22.5 }, D, 2000)).toEqual({ from: 500, to: 750 });
    expect(visibleSlice(fitView(D), D, 2000)).toEqual({ from: 0, to: 2000 });
    const odd = visibleSlice({ start: 45.01, span: 22.5 }, D, 2000);
    expect(odd).toEqual({ from: 500, to: 751 });
  });
});
