// Horizontal zoom of the timeline, waveform and stem lanes (fb3, item 5). Pure, so it tests without the DOM.
// A view is the window of clip seconds on screen: [start, start + span). Fit is the whole clip.

export interface ZoomView {
  start: number;
  span: number;
}

/**
 * The deepest zoom: MIN_SPAN_SEC across the view (nor more than the clip). fb4, item 2: under one bar at any tempo up
 * to 240 BPM, now that a zoomed waveform draws from the samples (fb3 stopped at a 256th of the clip: 7 s on a 30-minute
 * one, where the overview's bins were already 4 px wide).
 */
export const MIN_SPAN_SEC = 1;

export const fitView = (duration: number): ZoomView => ({ start: 0, span: duration });

export function minSpan(duration: number): number {
  return Math.min(duration, MIN_SPAN_SEC);
}

export function zoomLevel(v: ZoomView, duration: number): number {
  return v.span > 0 ? duration / v.span : 1;
}

/** `v` with its span between minSpan and the clip, and inside [0, duration]. */
export function clampView(v: ZoomView, duration: number): ZoomView {
  const span = Math.min(duration, Math.max(minSpan(duration), v.span));
  const start = Math.min(duration - span, Math.max(0, v.start));
  return { start, span };
}

/** The clip time at fraction `frac` (0 = left edge, 1 = right) of the view. */
export const timeAt = (v: ZoomView, frac: number) => v.start + frac * v.span;
/** Where time `t` is in the view, as a fraction (outside 0..1 when off screen). */
export const toFrac = (v: ZoomView, t: number) => (t - v.start) / v.span;

/** Zooms in by `factor` (> 1 in, < 1 out), keeping the time at `anchorFrac` of the view where it is. */
export function zoomAround(v: ZoomView, duration: number, factor: number, anchorFrac: number): ZoomView {
  const anchor = timeAt(v, anchorFrac);
  const span = Math.min(duration, Math.max(minSpan(duration), v.span / factor));
  return clampView({ start: anchor - anchorFrac * span, span }, duration);
}

export function panBy(v: ZoomView, duration: number, seconds: number): ZoomView {
  return clampView({ start: v.start + seconds, span: v.span }, duration);
}

/** The zoom factor for a wheel's deltaY in pixels (pinch or Cmd+scroll): exponential, so in and out cancel. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.01);
}

/** A drag within this many px of a view edge auto-scrolls it (edgeSpeed); at full speed by EDGE_STEP of the view a frame. */
export const EDGE_PX = 28;
export const EDGE_STEP = 0.02;

/** Auto-scroll while dragging: 0 more than `edgePx` from both edges, rising to -1 (left) or 1 (right) at and past them. */
export function edgeSpeed(x: number, width: number, edgePx: number): number {
  if (x < edgePx) return -Math.min(1, (edgePx - x) / edgePx);
  if (x > width - edgePx) return Math.min(1, (x - (width - edgePx)) / edgePx);
  return 0;
}

/** The points of `n` evenly spread over the clip that the view covers: [from, to), whole points, clamped. */
export function visibleSlice(v: ZoomView, duration: number, n: number): { from: number; to: number } {
  const from = Math.max(0, Math.floor((v.start / duration) * n + 1e-9));
  const to = Math.min(n, Math.ceil(((v.start + v.span) / duration) * n - 1e-9));
  return { from, to: Math.max(from, to) };
}
