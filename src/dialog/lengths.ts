// Section lengths on the bands (fb3, item 3): bars and beats on the active grid, seconds otherwise. Pure.
// fb4, item 1 ("section lengths should be in bars and beats not seconds"): a length is bars and beats on the best grid
// the clip has, whatever the Snap toggle says (gridChoice.ts), and stays so when an end is off the grid: then it is
// Live's bars.beats.sixteenths. Seconds only with no grid at all.

export interface LengthGrid {
  /** Beat times in clip seconds, ascending. */
  beats: number[];
  /** Bar-line times, ascending, on beats of `beats`. */
  bars: number[];
}

/** `t` as a fractional index into `grid` (linear between points, carried on at the end intervals); needs 2 points. */
export function index(grid: number[], t: number): number {
  // k is the last interval start with grid[k] <= t, kept inside [0, n - 2]: a binary search for the first point after t.
  let lo = 1;
  let hi = grid.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] > t) hi = mid;
    else lo = mid + 1;
  }
  const k = lo - 1;
  return k + (t - grid[k]) / (grid[k + 1] - grid[k]);
}

/** The time at fractional index `x` of `grid`: the inverse of index(), carried on past both ends; needs 2 points. */
export function timeAtIndex(grid: number[], x: number): number {
  const k = Math.max(0, Math.min(grid.length - 2, Math.floor(x)));
  return grid[k] + (x - k) * (grid[k + 1] - grid[k]);
}

/** The beats in a bar of `g`: the median count between its bar lines; 4 with fewer than two bar lines. */
export function beatsPerBar(g: LengthGrid): number {
  if (g.bars.length < 2 || g.beats.length < 2) return 4;
  const counts: number[] = [];
  for (let k = 0; k + 1 < g.bars.length; k++) counts.push(Math.round(index(g.beats, g.bars[k + 1]) - index(g.beats, g.bars[k])));
  counts.sort((a, b) => a - b);
  const median = counts[counts.length >> 1];
  return median > 0 ? median : 4;
}

export function formatSeconds(sec: number): string {
  if (sec < 9.95) return `${sec.toFixed(1)} s`;
  if (sec < 59.5) return `${Math.round(sec)} s`;
  const whole = Math.round(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The most lengths kept per grid; a drag makes a new pair of edges at every pointer move, so the memo is bounded. */
const MEMO_MAX = 2048;

interface Formatter {
  /** Beats in a bar of this grid, worked out once. */
  per: number;
  memo: Map<string, string>;
}

// One per grid object (the views make a new object when the grid changes, so a stale one is never used). The grid's
// arrays are not edited after they are made.
const formatters = new WeakMap<LengthGrid, Formatter>();

function formatterFor(grid: LengthGrid): Formatter {
  let f = formatters.get(grid);
  if (!f) formatters.set(grid, (f = { per: beatsPerBar(grid), memo: new Map() }));
  return f;
}

function onGrid(start: number, end: number, grid: LengthGrid, per: number): string {
  // To the nearest sixteenth of a beat: a length a whole number of beats long (both ends on the grid, or both off it
  // by the same) reads as bars and beats, any other as bars.beats.sixteenths, as Live's clip view shows lengths.
  const q = Math.round((index(grid.beats, end) - index(grid.beats, start)) * 4);
  if (q <= 0) return formatSeconds(end - start);
  const n = Math.floor(q / 4);
  const whole = Math.floor(n / per);
  const rest = n % per;
  if (q % 4 !== 0) return `${whole}.${rest}.${q % 4}`;
  return rest === 0 ? `${whole} bar${whole === 1 ? "" : "s"}` : `${whole}.${rest}`;
}

/**
 * "8 bars", "1 bar", "6.2" (6 bars, 2 beats) on the grid, "6.2.3" (and 3 sixteenths) when the length is not a whole
 * number of beats; seconds only without a grid.
 * fb3 review I1: the grid's beats per bar is worked out once, an edge is found by binary search, and a length is
 * remembered by its edges, so an edit that moves one handle works out two lengths and looks the rest up.
 */
export function formatLength(start: number, end: number, grid: LengthGrid | null): string {
  if (!grid || grid.beats.length < 2) return formatSeconds(end - start);
  const f = formatterFor(grid);
  const key = `${start},${end}`;
  let text = f.memo.get(key);
  if (text === undefined) {
    if (f.memo.size >= MEMO_MAX) f.memo.clear();
    f.memo.set(key, (text = onGrid(start, end, grid, f.per)));
  }
  return text;
}
