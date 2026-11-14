// The fractal split (Plan 5, Task 5). Browser-safe: no Node imports.
//
// Level 0 is one piece per section. Each level up looks inside every piece of the level below for repetition, and
// splits it into parts of L whole bars (L from PART_BARS: phrases of 1 to 6 bars and 8, so a 3-, 5- or 6-bar phrase is
// found too) only when it finds some; otherwise the piece stays whole, and so it stays whole at every level above too.
//
// A piece is read as its bars (the grid bars between the grid points nearest its ends), and each L is judged by how
// cheaply its parts describe the piece, in sounding bars: a part that repeats an earlier part of the piece costs
// little, a new one costs its sounding bars, and every piece costs PIECE_COST more, a run of rest pieces once (it
// becomes one slice). Rest bars cost nothing, split or whole, so silence repeating itself never pays for a split on
// its own (a sparse stem's few bars among rests stay whole). The cheapest L wins if it beats the piece left whole,
// and if at least one of its parts (one that is not silence) repeats an earlier one. So a piece of X Y X Y X Y X Y is
// four X Y parts (4 bars of cost against 5 for two X Y X Y parts and 6 for eight bars), and four 4-bar phrases of
// four similar bars are four phrases, not sixteen bars: describing the bars costs more pieces than it saves. Where L
// does not divide the piece, the bars left over (before the parts, after them, or both) are a piece each, all new. The
// parts are as many as fit, or one fewer, so the bars left over before or after them may be more than L: a section
// whose boundary is late holds the end of the phrase before it (Flim's Instrumental 1 under allin1's markers: 6 + 5 + 5).
// Once the parts are chosen, each run of consecutive rest pieces becomes one rest piece: a run of silence is one slice.
// A part looks for the earlier part it repeats only among those that start at most REACH bars before it, so a long
// section (a 30-minute take with no markers) costs the split its bars, not their pairs; each pair of bars is compared
// once per source, in a table of numbers kept beside its Similarity (barTable).
// A rest piece is never split, and no piece is made shorter than MIN_SECTION_SEC. Repeats are split alike: the parts
// that repeat each other form a family, and a family is split one way at the next level (see sectionCuts).
//
// Two parts are compared bar by bar, each bar as its whole grid bar (so the bar at a section edge off the grid is
// compared as the whole bar it clips, not as the clipped part stretched to a bar). A bar that is a rest in both is left out (so silent bars never make
// unrelated parts alike), a rest against a sounding bar is unrelated, and parts that are silence throughout repeat
// each other. A repeat must also be anchored in time: aligned, the parts must match better, by ANCHOR, than with the
// later one nudged early by one of NUDGES: a beat, or 5/32 of a bar, which is off the sixteenth grid, so that a pattern
// repeating every beat, eighth or sixteenth (four on the floor) still differs from itself there. A sound held or
// swelling across the bar line matches itself however it is nudged, so it is never a repeat. Only the unrotated score
// counts: a transposed repeat is a new part here. A part new by its score is new however it is anchored.
//
// Repeats are cut alike across sections too (machineCuts, cutAlike): a section whose bars, as a whole, repeat a stretch
// heard before it (repeatLags) is cut at that stretch's machine cuts, not by its own split, when they fit its bars no worse
// than its own cuts. So Flim's Instrumental 2, whose two 5-bar halves are too unlike each other to split it on their own,
// is cut like the end of Instrumental 1 it repeats, and Instrumental 3 like Intro 1's four 4-bar phrases. A section's own
// split still depends on it alone; its final cuts also on the sections before it.
//
// A part of 3, 5 or 6 bars must be a phrase of its own: where its bars repeat at a shorter period (a 1-bar loop), the
// music is counted in 1, 2, 4 or 8 bars, so a steady loop is never cut into 3- or 5-bar parts (see periodic in waysOf).
import { MIN_SECTION_SEC } from "../core/sections.js";
import { PART_BARS, PATTERN_LEVELS, barIndexAt, type GridBar, type Span } from "./contract.js";
import { tuned, type Similarity } from "./similarity.js";

/** A part this alike an earlier part of the piece, or more, repeats it and costs nothing to describe. */
export const REPEAT = 0.9;
/** ...this alike or less, it is new and costs its sounding bars; between the two, a share of them. */
export const UNRELATED = 0.5;
/** A repeat matches aligned better than nudged (by one of NUDGES at least), by at least this. */
export const ANCHOR = 0.2;
/** What each piece costs on top of its bars' description, in bars. */
export const PIECE_COST = 0.5;
/**
 * REPEAT, UNRELATED, ANCHOR and PIECE_COST on real stems (see tuned), fitted on Matt's answer key and Kashmir, and
 * checked on the played synth songs. There a repeated bar scores 0.62 to 0.89 (Kashmir's A, 10th to 90th percentile)
 * and two different bars of one phrase up to 0.67 (Flim's Intro 1), so UNRELATED rises and those stay new; a repeat
 * is anchored by 0.033 to 0.35 (reverb and legato blur the nudge: the least, Flim's two 5-bar Ds in Instrumental 1, end
 * on held chords), so ANCHOR falls to 0.02, between 0 and 0.033, where the whole gate passes (at 0.03 the Ds had a 0.003
 * margin; 0.02 and 0.03 give the same lanes on every stemmed song in Matt's storage); and since a noisy repeat never
 * saves all of its bars, a piece costs less: at 0.5 Intro 2's five 2-bar ideas tie with the whole section. Below 0.3 a played
 * fourBarPhrase can be cut into 2-bar parts; from 0.35 Kashmir's A B C sections stay whole.
 */
export const REPEAT_STEMS = 0.8;
export const UNRELATED_STEMS = 0.65;
export const ANCHOR_STEMS = 0.02;
export const PIECE_COST_STEMS = 0.3;

/** A part looks for an earlier part it repeats among those starting at most this many bars before it. */
export const REACH = 64;
/** A section is cut like the stretches it repeats best, this many at most (repeatLags), when they all cut it alike. */
export const REPEAT_LAGS = 8;

/** Part lengths a steady loop is counted in: any other length in PART_BARS must be a phrase of its own (periodic). */
const COUNTED_BARS: readonly number[] = [1, 2, 4, 8];
/**
 * A 3-, 5- or 6-bar phrase must make its piece repeat better, by this much novelty, at its own length than at a shorter
 * period that divides it (see periodic in waysOf): four bars and a tag (A A A A B) are about 0.4 new a bar on and 0 five
 * bars on; a played 1-bar loop with or without a fill now and then is as new a bar on as three bars on.
 */
const PHRASE_GAIN = 0.1;
/**
 * ...and the run must repeat at the shorter period at all, at most this new, to be a loop there: the split's "at most
 * half new" (the level repeatLags takes a stretch as heard before at, (REPEAT + UNRELATED) / 2). Without it, music that
 * repeats neither a bar on nor a phrase on (Flim's two takes of a 5-bar D, which differ at the end, as Matt's clip
 * 26b0798f has them in one 26-bar section) read as a loop, and lost its 5-bar parts.
 */
const LOOP_NOVELTY = 0.5;
const NUDGES = [1 / 4, 5 / 32]; // of a bar
const EPS = 1e-9;

/** Index of the grid point (a bar start, or the last bar's end) nearest t; the earlier one on a tie. */
function nearestPoint(grid: GridBar[], t: number): number {
  const i = barIndexAt(grid, t);
  const last = grid.length - 1;
  return i === last && grid[last].end - t < t - grid[last].start ? grid.length : i;
}

/**
 * A piece's bars: `at` their boundaries (its start, the grid bar starts strictly between its nearest grid points, its
 * end), and `first` the grid index of its first bar: bar k is grid bar first + k, whole, which is what it is compared
 * and judged a rest as. null without a grid (the piece is one bar).
 */
function pieceBars(grid: GridBar[], piece: Span): { at: number[]; first: number } | null {
  if (grid.length === 0) return null;
  const i0 = barIndexAt(grid, piece.start);
  const i1 = Math.max(i0 + 1, nearestPoint(grid, piece.end));
  const at = [piece.start];
  for (let i = i0; i < i1; i++) at.push(i + 1 < i1 ? grid[i + 1].start : piece.end);
  return { at, first: i0 };
}

/**
 * The grid bars of one source, each compared with the bars up to REACH before it at most once, however many sections,
 * pieces and ways ask: kept per Similarity (and grid) for as long as it lives, in typed arrays of the grid's bars times
 * REACH + 1 (about 0.5 MB a source on a 30-minute clip), so a section split again, or a section's repeatLags, scores no
 * pair twice and the Similarity keeps none of them.
 */
interface BarTable {
  rest(i: number): boolean;
  /** Grid bar y's score against an earlier one x, at most REACH before it, neither a rest. */
  score(x: number, y: number): number;
  /** ...and how much better y matches x aligned than nudged early by the nudge it is least like. */
  anchor(x: number, y: number): number;
}

const tables = new WeakMap<Similarity, { grid: GridBar[]; table: BarTable }>();

function barTable(sim: Similarity, grid: GridBar[]): BarTable {
  const kept = tables.get(sim);
  if (kept?.grid === grid) return kept.table;
  const score = sim.score ? (a: Span, b: Span) => sim.score!(a, b, { keep: false }) : (a: Span, b: Span) => sim.compare(a, b)?.score ?? null;
  // one Span object per bar and nudge, so the Similarity finds each by identity
  const spans = new Map<number, Span[]>(); // grid index → [the bar, nudged by each of NUDGES]
  const spansOf = (i: number): Span[] => {
    let s = spans.get(i);
    if (!s) {
      const { start, end } = grid[i];
      spans.set(i, (s = [{ start, end }, ...NUDGES.map((f) => ({ start: start - f * (end - start), end: end - f * (end - start) }))]));
    }
    return s;
  };
  const rests = new Int8Array(grid.length).fill(-1); // -1: not known yet
  const scores = new Float32Array(grid.length * (REACH + 1)).fill(NaN); // at y · (REACH + 1) + (y − x)
  const anchors = new Float32Array(grid.length * (REACH + 1)).fill(NaN);
  const at = (x: number, y: number) => y * (REACH + 1) + (y - x);
  function barScore(x: number, y: number): number {
    let s = scores[at(x, y)];
    if (Number.isNaN(s)) scores[at(x, y)] = s = score(spansOf(x)[0], spansOf(y)[0]) ?? 0;
    return s;
  }
  function anchor(x: number, y: number): number {
    let a = anchors[at(x, y)];
    if (Number.isNaN(a)) {
      const bx = spansOf(x)[0];
      const off = Math.min(...spansOf(y).slice(1).map((nudged) => Math.max(0, score(bx, nudged) ?? 0)));
      anchors[at(x, y)] = a = barScore(x, y) - off;
    }
    return a;
  }
  function rest(i: number): boolean {
    if (rests[i] < 0) rests[i] = sim.rest(spansOf(i)[0]) ? 1 : 0;
    return rests[i] === 1;
  }
  const table = { rest, score: barScore, anchor };
  tables.set(sim, { grid, table });
  return table;
}

/** The split's thresholds for one source (see tuned). */
interface Thresholds {
  repeat: number;
  unrelated: number;
  anchor: number;
}
const thresholds = (sim: Similarity): Thresholds => ({
  repeat: tuned(sim, REPEAT, REPEAT_STEMS),
  unrelated: tuned(sim, UNRELATED, UNRELATED_STEMS),
  anchor: tuned(sim, ANCHOR, ANCHOR_STEMS),
});

/**
 * How new the L grid bars from bar `y` are against the L from an earlier bar `x` (at most REACH before it), from 0 (a
 * repeat) to 1 (new), compared bar by bar. A bar that is a rest in both is left out, a rest against a sounding bar scores
 * 0, and silence against silence is a repeat. A part new by its score is new however it is anchored, so its nudges are
 * never compared; else it is new unless it is anchored, on average, by ANCHOR.
 */
function partNovelty(table: BarTable, t: Thresholds, x: number, y: number, L: number): number {
  let count = 0;
  let score = 0;
  for (let k = 0; k < L; k++) {
    const [rx, ry] = [table.rest(x + k), table.rest(y + k)];
    if (rx && ry) continue;
    count++;
    if (!rx && !ry) score += table.score(x + k, y + k);
  }
  if (count === 0) return 0;
  const nu = Math.min(1, Math.max(0, (t.repeat - score / count) / (t.repeat - t.unrelated)));
  if (nu === 1) return 1;
  let anchored = 0; // a rest against a sounding bar is not anchored
  for (let k = 0; k < L; k++) if (!table.rest(x + k) && !table.rest(y + k)) anchored += table.anchor(x + k, y + k);
  return anchored / count < t.anchor ? 1 : nu;
}

/** One way to split a piece: q parts of L bars from bar o, with the leftover bars before and after them a piece each. */
interface Way {
  key: string; // `${L},${q},${o}`: the same way for every piece of the same bar count
  bounds: number[]; // bar indices of the piece boundaries, 0 … n
  cost: number;
  found: boolean; // a part (not silence) repeats an earlier one
  links: [number, number][]; // [earlier, later] pieces (indices into bounds' pieces) where the later repeats the earlier
}
/** A piece's bars and every way it can be split; null for a piece that is never split (a rest, or under 2 bars). */
interface Ways {
  at: number[]; // the bar boundaries in seconds (pieceBars)
  n: number;
  whole: number; // the cost of the piece left whole
  ways: Way[]; // largest L first
  silent: (from: number, to: number) => boolean;
}

function waysOf(sim: Similarity, table: BarTable, grid: GridBar[], piece: Span): Ways | null {
  if (sim.rest(piece)) return null;
  const pb = pieceBars(grid, piece);
  if (!pb || pb.at.length - 1 < 2) return null;
  const { at, first: g0 } = pb;
  const n = at.length - 1;
  const rest = Array.from({ length: n }, (_, k) => table.rest(g0 + k));
  const sounding = [0]; // sounding[k]: the sounding bars before bar k
  for (const r of rest) sounding.push(sounding[sounding.length - 1] + (r ? 0 : 1));
  const bars = (from: number, to: number) => sounding[to] - sounding[from];
  const pieceCost = tuned(sim, PIECE_COST, PIECE_COST_STEMS);

  const t = thresholds(sim);
  const novelties = new Map<string, number>(); // `${a},${b},${L}` → novelty: the ways of a piece share their parts
  /** partNovelty of the part of L bars from piece bar `b` against the earlier one from piece bar `a`. */
  function novelty(a: number, b: number, L: number): number {
    const key = `${a},${b},${L}`;
    let nu = novelties.get(key);
    if (nu === undefined) novelties.set(key, (nu = partNovelty(table, t, g0 + a, g0 + b, L)));
    return nu;
  }

  const silent = (from: number, to: number) => bars(from, to) === 0;
  const long = (from: number, to: number) => at[to] - at[from] >= MIN_SECTION_SEC - EPS;

  /**
   * Whether q parts of L bars from bar o (L not 1, 2, 4 or 8) would cut music whose period is shorter: their run repeats
   * itself p bars on (p a divisor of L) about as well as L bars on, within PHRASE_GAIN, so L explains nothing p does not.
   * That is p-bar music, counted in 1, 2, 4 or 8 bars: a steady 1-bar loop, or one with a fill now and then at no period,
   * is no 3- or 5-bar phrase. A tag bar or a new idea that comes back every L bars makes the run repeat much better at L
   * than at p, and keeps the phrase (A A A A B, A B A B A C), as do Kashmir's A B C and Flim's 5-bar D, whose bars all
   * differ. Music that does not repeat at p (more than LOOP_NOVELTY new) is no loop there, whatever it does at L.
   */
  function periodic(L: number, o: number, q: number): boolean {
    if (COUNTED_BARS.includes(L)) return false;
    const atL = novelty(o, o + L, (q - 1) * L);
    for (let p = 1; p < L; p++) {
      if (L % p !== 0) continue;
      const atP = novelty(o, o + p, q * L - p);
      if (atP <= LOOP_NOVELTY && atP <= atL + PHRASE_GAIN) return true; // a loop must repeat at p
    }
    return false;
  }

  const ways: Way[] = [];
  for (const L of [...PART_BARS].reverse()) {
    // as many parts as fit, or one fewer: the bars left over (under 2L) may hold a phrase cut off by the section's edge
    for (let q = Math.floor(n / L); q >= Math.max(2, Math.floor(n / L) - 1); q--) {
      const r = n - q * L;
      for (let o = 0; o <= r; o++) {
        if (q < Math.floor(n / L) && (o === L || r - o === L)) continue; // a leftover of L bars is the way with one part more
        // leftover bars (o before the parts, r − o after) are a piece each, all new
        const bounds = [...(o > 0 ? [0] : []), ...Array.from({ length: q + 1 }, (_, j) => o + j * L), ...(o < r ? [n] : [])];
        if (!bounds.slice(1).every((b, i) => long(bounds[i], b))) continue;
        if (periodic(L, o, q)) continue;
        const first = o > 0 ? 1 : 0; // the index in bounds' pieces of the first part
        // a run of rest pieces is one piece (sectionCuts merges it), and only sounding bars cost
        let pieces = 0;
        for (let j = 0; j + 1 < bounds.length; j++) {
          if (!(j > 0 && silent(bounds[j - 1], bounds[j]) && silent(bounds[j], bounds[j + 1]))) pieces++;
        }
        let cost = bars(0, o) + bars(o + q * L, n) + pieceCost * pieces;
        let found = false;
        const links: [number, number][] = [];
        for (let j = 0; j < q; j++) {
          const from = o + j * L;
          let nu = 1;
          let like = -1; // the earlier part it is least new against
          for (let i = Math.max(0, j - Math.floor(REACH / L)); i < j && nu > 0; i++) {
            const v = novelty(o + i * L, from, L);
            if (v < nu) [nu, like] = [v, i];
          }
          if (nu < 1 && !silent(from, from + L)) {
            found = true; // silence repeating is not repetition found
            links.push([first + like, first + j]);
          }
          cost += bars(from, from + L) * nu;
        }
        ways.push({ key: `${L},${q},${o}`, bounds, cost, found, links });
      }
    }
  }
  return { at, n, whole: bars(0, n) + pieceCost, ways, silent };
}

/**
 * The way to split a family of pieces (see sectionCuts), all of the same bar count, or null to leave them whole: the
 * way that describes them all most cheaply, if it beats leaving them whole and finds a repeat in one of them at least.
 * Largest L first, and only a strictly cheaper way replaces the best: a tie keeps the fewer, longer parts.
 */
function familyWay(members: Ways[]): string | null {
  let best = members.reduce((sum, m) => sum + m.whole, 0);
  let chosen: string | null = null;
  for (const way of members[0].ways) {
    const each = members.map((m) => m.ways.find((w) => w.key === way.key));
    if (each.some((w) => !w)) continue; // not a way for every member (a part under MIN_SECTION_SEC)
    const cost = each.reduce((sum, w) => sum + w!.cost, 0);
    if (each.some((w) => w!.found) && cost < best - EPS) [best, chosen] = [cost, way.key];
  }
  return chosen;
}

interface Piece {
  span: Span;
  whole: boolean;
  family: number;
}

/** A small union-find over 0 … n − 1. */
function unionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  return { find, union: (a: number, b: number) => void (parent[find(a)] = find(b)) };
}

/**
 * cuts[level] for one section, level 0 … PATTERN_LEVELS: sorted times strictly inside it; cuts[0] = []; cuts[k] ⊆ cuts[k+1].
 *
 * Repeats are split alike. The parts a split makes form families: a part and the earlier part it repeats are one
 * family, and so are the parts at the same place in the members of one family. At the next level each family of
 * pieces of one bar count is split one way, the way cheapest over all of them, or all left whole. So four takes of one
 * phrase are cut the same, even where noise lets one take's bars look like repeats and another's not.
 */
export function sectionCuts(sim: Similarity, grid: GridBar[], section: Span): number[][] {
  const levels: number[][] = [[]];
  const table = barTable(sim, grid);
  let families = 0;
  // a piece that stayed whole once stays whole at every level above, so it is not split again
  let pieces: Piece[] = [{ span: section, whole: false, family: families++ }];
  for (let k = 1; k <= PATTERN_LEVELS; k++) {
    const ways = pieces.map((p) => (p.whole ? null : waysOf(sim, table, grid, p.span)));
    const groups = new Map<string, number[]>(); // family and bar count → indices into pieces
    ways.forEach((w, i) => {
      if (!w) return;
      const key = `${pieces[i].family}|${w.n}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    const children = new Map<number, Piece[]>(); // pieces index → its parts
    for (const members of groups.values()) {
      const chosen = familyWay(members.map((i) => ways[i]!));
      if (chosen === null) continue;
      const split = members.map((i) => ways[i]!.ways.find((w) => w.key === chosen)!);
      const parts = split[0].bounds.length - 1;
      const uf = unionFind(members.length * parts);
      split.forEach((w, m) => {
        if (m > 0) for (let j = 0; j < parts; j++) uf.union(m * parts + j, j); // the same place in each member
        for (const [a, b] of w.links) uf.union(m * parts + b, m * parts + a);
      });
      const ids = new Map<number, number>();
      const familyOf = (m: number, j: number) => {
        const root = uf.find(m * parts + j);
        if (!ids.has(root)) ids.set(root, families++);
        return ids.get(root)!;
      };
      members.forEach((i, m) => {
        const { at, silent } = ways[i]!;
        const { bounds } = split[m];
        // a cut between two rest pieces is dropped: a run of rests is one piece
        const restRun = (j: number) => silent(bounds[j], bounds[j + 1]) && silent(bounds[j + 1], bounds[j + 2]);
        const kept = bounds.slice(1, -1).flatMap((_, j) => (restRun(j) ? [] : [j + 1]));
        const starts = [0, ...kept];
        const p = pieces[i].span;
        const times = [p.start, ...kept.map((j) => at[bounds[j]]), p.end];
        children.set(
          i,
          starts.map((j, c) => ({ span: { start: times[c], end: times[c + 1] }, whole: false, family: familyOf(m, j) })),
        );
      });
    }
    pieces = pieces.flatMap((p, i) => children.get(i) ?? [{ ...p, whole: true }]);
    levels.push(pieces.slice(1).map((p) => p.span.start));
  }
  return levels;
}

/**
 * How many bars back the section's music was heard before, best match first: each lag whose stretch (as many bars as the
 * section, ending by its start and starting at most REACH bars before it) matches the section's bars, aligned and bar by
 * bar, at most half new by the split's measure (a mean score of (REPEAT + UNRELATED) / 2 or more, see `novelty`), and
 * anchored as a repeat is. A rest, or a section without a grid, repeats nothing.
 */
export function repeatLags(sim: Similarity, grid: GridBar[], section: Span): number[] {
  if (sim.rest(section)) return [];
  const pb = pieceBars(grid, section);
  if (!pb) return [];
  const { first: s0 } = pb;
  const n = pb.at.length - 1;
  const table = barTable(sim, grid);
  const t = thresholds(sim);
  const least = (t.repeat + t.unrelated) / 2;
  const found: { lag: number; score: number; count: number }[] = [];
  for (let lag = n; lag <= REACH && lag <= s0; lag++) {
    let count = 0;
    let score = 0;
    for (let k = 0; k < n; k++) {
      // the mean can reach `least` only if every bar left scores 1 (scores are at most 1): else the lag is dropped early
      if (count > 0 && (score + n - k) / (count + n - k) < least - EPS) break;
      const [x, y] = [s0 - lag + k, s0 + k];
      const [rx, ry] = [table.rest(x), table.rest(y)];
      if (rx && ry) continue;
      count++;
      if (!rx && !ry) score += table.score(x, y); // a rest against a sounding bar scores 0
    }
    if (count > 0 && score / count >= least - EPS) found.push({ lag, score: score / count, count });
  }
  // best first, anchored (a rest against a sounding bar is not), REPEAT_LAGS at most: so only those are anchored
  const lags: number[] = [];
  for (const { lag, count } of found.sort((a, b) => b.score - a.score || a.lag - b.lag)) {
    let anchored = 0;
    for (let k = 0; k < n; k++) if (!table.rest(s0 - lag + k) && !table.rest(s0 + k)) anchored += table.anchor(s0 - lag + k, s0 + k);
    if (anchored / count >= t.anchor) lags.push(lag);
    if (lags.length === REPEAT_LAGS) break;
  }
  return lags;
}

/**
 * What describing the bars of `section` cut at `cuts` costs, by the split's measure (see waysOf), leaving out what its
 * pieces cost (PIECE_COST): each piece costs its sounding bars times how new it is against the most alike earlier piece of
 * the section of its bar count (at most REACH bars before it). Cuts that follow the music cost no more than fewer cuts
 * do (a repeat cut in two halves costs what it cost whole); cuts against it cost more.
 */
export function barsCost(sim: Similarity, grid: GridBar[], section: Span, cuts: number[]): number {
  const pb = pieceBars(grid, section);
  if (!pb) return 0;
  const table = barTable(sim, grid);
  const t = thresholds(sim);
  const g0 = pb.first;
  const n = pb.at.length - 1;
  const bounds = [0, ...new Set(cuts.map((c) => barIndexAt(grid, c) - g0).filter((b) => b > 0 && b < n)), n];
  let cost = 0;
  for (let j = 0; j + 1 < bounds.length; j++) {
    const [from, to] = [bounds[j], bounds[j + 1]];
    let bars = 0;
    for (let b = from; b < to; b++) if (!table.rest(g0 + b)) bars++;
    if (bars === 0) continue; // rests cost nothing
    let nu = 1;
    for (let i = 0; i < j && nu > 0; i++) {
      const [a, b] = [bounds[i], bounds[i + 1]];
      if (b - a === to - from && from - a <= REACH) nu = Math.min(nu, partNovelty(table, t, g0 + a, g0 + from, to - from));
    }
    cost += bars * nu;
  }
  return cost;
}

/** Costs this close are equal: a repeat cut in two halves costs what it cost whole, to rounding. */
const COST_TOLERANCE = 1e-6;

/**
 * Repeats are cut alike across sections too. A section whose music was heard before (`lags[i]`, from repeatLags) may be
 * cut, at every level, where that stretch of the lane has machine cuts (never at its markers: a section start is where
 * allin1 or he put it, not where the music was cut), moved on by the lag, in place of its own split. Only when
 *
 * - every stretch it repeats would cut it the same way, at every level: a steady loop repeats at many lags, cut at
 *   different places; and
 * - at level 1 the copied cuts describe the section's bars no worse than its own cuts do (`cost`, barsCost). Their
 *   pieces are not charged: the stretch they come from paid for them, so a section its own split leaves whole can take
 *   the cuts of the music it repeats. Cuts that do not fit its music (a 4 + 1 + 1 + 1 + 1 over a 2-bar loop) cost more,
 *   and are not copied.
 *
 * `own[i]` is section i's sectionCuts (every level), sections in time order. The stretch's cuts are its final ones, so a
 * section cut like an earlier one passes those cuts on. A copied cut that would leave a piece under MIN_SECTION_SEC is
 * left out; a level keeps every cut of the level below. Level 0 stays uncut.
 */
export function cutAlike(
  grid: GridBar[],
  sections: Span[],
  own: number[][][],
  lags: number[][],
  cost: (section: Span, cuts: number[]) => number,
): number[][][] {
  // per level, the grid bars of the lane's machine cuts so far, ascending
  const lanes: number[][] = Array.from({ length: PATTERN_LEVELS + 1 }, () => []);
  /** Section `section`'s cuts at every level where the lane is cut `lag` bars before them, each level nesting the last. */
  function copied(section: Span, s0: number, n: number, lag: number): number[][] {
    const out: number[][] = [[]];
    for (let level = 1; level <= PATTERN_LEVELS; level++) {
      const lane = lanes[level];
      const times = new Set(out[level - 1]);
      for (let i = lowerBound(lane, s0 - lag + 1); i < lane.length && lane[i] + lag < s0 + n; i++) times.add(grid[lane[i] + lag].start);
      const kept = out[level - 1];
      const cuts: number[] = [];
      for (const t of [...times].sort((a, b) => a - b)) {
        const fits = (u: number) => Math.abs(u - t) >= MIN_SECTION_SEC - EPS;
        if (kept.includes(t) || (fits(section.start) && fits(section.end) && kept.every(fits) && cuts.every(fits))) cuts.push(t);
      }
      out.push(cuts);
    }
    return out;
  }
  return sections.map((section, i) => {
    const pb = pieceBars(grid, section);
    let cuts = own[i];
    if (pb && lags[i].length > 0) {
      const [s0, n] = [pb.first, pb.at.length - 1];
      const first = copied(section, s0, n, lags[i][0]);
      const agree = lags[i].slice(1).every((lag) => copied(section, s0, n, lag).every((c, level) => sameTimes(c, first[level])));
      if (agree && cost(section, first[1]) <= cost(section, own[i][1]) + COST_TOLERANCE) cuts = first;
    }
    lanes.forEach((lane, level) => lane.push(...cuts[level].map((t) => barIndexAt(grid, t))));
    return cuts;
  });
}

/** The first index in ascending `xs` whose value is at least `v` (xs.length if none). */
function lowerBound(xs: number[], v: number): number {
  let [lo, hi] = [0, xs.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const sameTimes = (a: number[], b: number[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** The machine cuts of every section at `level`, in time order: sectionCuts of each, cut alike across sections (cutAlike). */
export function machineCuts(sim: Similarity, grid: GridBar[], sections: Span[], level: number): number[] {
  if (!Number.isInteger(level) || level < 0 || level > PATTERN_LEVELS) throw new RangeError(`no pattern level ${level}`);
  const own = sections.map((s) => sectionCuts(sim, grid, s));
  const lags = sections.map((s) => repeatLags(sim, grid, s));
  return cutAlike(grid, sections, own, lags, (s, cuts) => barsCost(sim, grid, s, cuts)).flatMap((c) => c[level]);
}
