// Matt's listening notes on Flim as machine-checkable rules, and the Kashmir no-regression baseline (Plan 5, Task 10).
// Pure and browser-safe: it reads lanes the engine already made and never runs it. The scorer script and the real-data
// test feed it; fixtures/patterns/ holds the data.
import { PATTERN_LEVELS, barIndexAt, type GridBar, type PatternSource, type Span } from "./contract.js";
import type { PatternSlice } from "./engine.js";

export type KeyRule = (
  | { id: string; kind: "oneSlice"; section: string; levels: number[] }
  | { id: string; kind: "repeats"; section: string; level: number; count: number; bars: number }
  | { id: string; kind: "consistentDeeper"; section: string; parts: number; levels: number[] }
  | { id: string; kind: "partBars"; section: string; level: number; bars: number }
  | { id: string; kind: "firstIsNew"; section: string; against: string[]; level: number }
  | { id: string; kind: "sameSequence"; a: string; b: string; level: number }
  | { id: string; kind: "sliceNotIn"; section: string; slice: number; against: string[]; level: number }
  /**
   * The listed slices of the section (negative counts from its end) are `bars` bars each and share one base (variants
   * allowed); with `count`, the section has exactly that many slices; with `like`, that base is also one of `like`'s.
   */
  | { id: string; kind: "slicesAlike"; section: string; level: number; slices: number[]; bars: number; count?: number; like?: string }
  /** A slice of `a` shares a base with a slice of `b`. Its detail gives the best score of an `a` slice against a `b` slice. */
  | { id: string; kind: "basesRelated"; a: string; b: string; level: number }
) & {
  /** Reported, PASS or FAIL, but not gating: the scorer passes whatever it says. */
  info?: boolean;
};
export interface AnswerKey {
  song: string;
  note?: string; // whose reading it is, and when
  hash: string;
  source: PatternSource;
  sections: Record<string, number>;
  rules: KeyRule[];
}
export interface Baseline {
  song: string;
  hash: string;
  source: PatternSource;
  bars: { start: number; end: number; label: string }[];
}
export interface SongLanes {
  durationSec: number;
  sections: Span[];
  grid: GridBar[];
  levels: PatternSlice[][]; // levels[0 … PATTERN_LEVELS]: the lane of the key's source, whole song, at each level
  /** The key's source's unshifted score of two spans of one bar count (null otherwise), when known: for basesRelated. */
  score?(a: Span, b: Span): number | null;
}
export interface RuleResult {
  id: string;
  pass: boolean;
  detail: string;
  info?: boolean; // the rule's info: reported, not gating
}

const SECTION_TOL_SEC = 0.5; // a key section is the song section whose start is this close to the key's time
const MAX_LISTED = 10; // bars printed in the broken-pair listing
const PRIME = "′";

const result = (rule: KeyRule, detail: string, pass = false): RuleResult => ({ id: rule.id, pass, detail, ...(rule.info ? { info: true } : {}) });

/** The slices of `level` that lie in `span` (by their midpoints). */
function within(slices: PatternSlice[], span: Span): PatternSlice[] {
  return slices.filter((s) => {
    const mid = (s.start + s.end) / 2;
    return mid >= span.start && mid < span.end;
  });
}

const barsOf = (grid: GridBar[], s: Span) => barIndexAt(grid, s.end) - barIndexAt(grid, s.start);
/** Base pattern text: "." for a rest, else the number, ignoring the variant. */
const baseOf = (s: PatternSlice) => (s.name.pattern === null ? "." : String(s.name.pattern));
const labelOf = (s: PatternSlice) => s.label ?? ".";

const NA = "n/a: one slice"; // a rule about the inside of a section proves nothing on a section that was not cut

class Missing extends Error {}

export function scoreKey(key: AnswerKey, song: SongLanes): RuleResult[] {
  const section = (name: string): Span => {
    const t = key.sections[name];
    let best: Span | undefined;
    for (const s of song.sections) if (t !== undefined && Math.abs(s.start - t) <= SECTION_TOL_SEC && (!best || Math.abs(s.start - t) < Math.abs(best.start - t))) best = s;
    if (!best) throw new Missing(`section ${name} not found (key ${t === undefined ? "has no such time" : `${t} s`})`);
    return best;
  };
  const slices = (name: string, level: number): PatternSlice[] => {
    const lane = song.levels[level];
    if (!lane || level < 0 || level > PATTERN_LEVELS) throw new Missing(`no level ${level}`);
    return within(lane, section(name));
  };
  const bases = (names: string[], level: number) => new Set(names.flatMap((n) => slices(n, level).map(baseOf)).filter((b) => b !== "."));

  function check(rule: KeyRule): RuleResult {
    switch (rule.kind) {
      case "oneSlice": {
        for (const level of rule.levels) {
          const sl = slices(rule.section, level);
          if (sl.length !== 1) return result(rule, `level ${level}: ${sl.length} slices in ${rule.section}, want 1`);
          if (sl[0].name.pattern === null) return result(rule, `level ${level}: the one slice is a rest`);
        }
        return result(rule, `${rule.section} is one slice at levels ${rule.levels.join(", ")}`, true);
      }
      case "repeats": {
        const sl = slices(rule.section, rule.level);
        const labels = sl.map(labelOf);
        const lens = sl.map((s) => barsOf(song.grid, s));
        const text = `${labels.join(" ")} (${lens.join("+")} bars)`;
        if (sl.length !== rule.count) return result(rule, `${sl.length} slices, want ${rule.count}: ${text}`);
        if (lens.some((n) => n !== rule.bars)) return result(rule, `slices are not all ${rule.bars} bars: ${text}`);
        if (sl.some((s) => s.label === null || s.label.includes(PRIME)) || new Set(labels).size !== 1) return result(rule, `not one plain label: ${text}`);
        return result(rule, `${rule.count} × ${labels[0]} of ${rule.bars} bars`, true);
      }
      case "consistentDeeper": {
        const parts = slices(rule.section, 1);
        if (parts.length !== rule.parts) return result(rule, `level 1 has ${parts.length} parts, want ${rule.parts}`);
        for (const level of rule.levels) {
          const shape = parts.map((p) => {
            const inner = within(song.levels[level] ?? [], p);
            return {
              offsets: inner.slice(1).map((s) => barIndexAt(song.grid, s.start) - barIndexAt(song.grid, p.start)),
              labels: inner.map(labelOf),
            };
          });
          const want = JSON.stringify(shape[0]);
          const odd = shape.findIndex((s) => JSON.stringify(s) !== want);
          if (odd >= 0) {
            const show = (s: (typeof shape)[number]) => `cuts at +${s.offsets.join(",+") || "none"} bars, ${s.labels.join(" ")}`;
            return result(rule, `level ${level}: part ${odd + 1} has ${show(shape[odd])}; part 1 has ${show(shape[0])}`);
          }
        }
        return result(rule, `${rule.parts} parts cut alike at levels ${rule.levels.join(", ")}`, true);
      }
      case "partBars": {
        const sl = slices(rule.section, rule.level);
        const lens = sl.map((s) => barsOf(song.grid, s));
        const bad = lens.findIndex((n, i) => (i < lens.length - 1 ? n !== rule.bars : n < 1 || n > rule.bars));
        if (sl.length === 0) return result(rule, "no slices");
        if (bad >= 0) return result(rule, `slice ${bad + 1} is ${lens[bad]} bars, want ${rule.bars} (${lens.join("+")})`);
        return result(rule, `${lens.join("+")} bars`, true);
      }
      case "firstIsNew": {
        const all = slices(rule.section, rule.level);
        if (all.length === 1) return result(rule, NA);
        const first = all[0];
        if (!first) return result(rule, "no slices");
        if (first.name.pattern === null) return result(rule, "the first slice is a rest");
        const base = baseOf(first);
        if (bases(rule.against, rule.level).has(base)) return result(rule, `the first slice (${labelOf(first)}) has a base that ${rule.against.join(", ")} also hold`);
        return result(rule, `the first slice (${labelOf(first)}) is not in ${rule.against.join(", ")}`, true);
      }
      case "sameSequence": {
        const [sa, sb] = [slices(rule.a, rule.level), slices(rule.b, rule.level)];
        if (sa.length === 1 || sb.length === 1) return result(rule, NA);
        const a = sa.map(baseOf);
        const b = sb.map(baseOf);
        const text = `${rule.a} ${a.join(" ")} / ${rule.b} ${b.join(" ")}`;
        return a.length === b.length && a.every((x, i) => x === b[i]) ? result(rule, text, true) : result(rule, text);
      }
      case "slicesAlike": {
        const sl = slices(rule.section, rule.level);
        const text = `${sl.map(labelOf).join(" ")} (${sl.map((s) => barsOf(song.grid, s)).join("+")} bars)`;
        if (rule.count !== undefined && sl.length !== rule.count) return result(rule, `${sl.length} slices, want ${rule.count}: ${text}`);
        const picked = rule.slices.map((k) => sl[k < 0 ? sl.length + k : k]);
        if (picked.some((s) => !s)) return result(rule, `${rule.section} has no slice ${rule.slices.join(", ")}: ${text}`);
        if (picked.some((s) => s.name.pattern === null)) return result(rule, `a listed slice is a rest: ${text}`);
        if (picked.some((s) => barsOf(song.grid, s) !== rule.bars)) return result(rule, `listed slices are not all ${rule.bars} bars: ${text}`);
        const base = baseOf(picked[0]);
        if (picked.some((s) => baseOf(s) !== base)) return result(rule, `slices ${rule.slices.join(", ")} do not share a base: ${text}`);
        if (rule.like !== undefined && !bases([rule.like], rule.level).has(base)) {
          return result(rule, `their base ${base} is not ${rule.like}'s (${slices(rule.like, rule.level).map(labelOf).join(" ")}): ${text}`);
        }
        return result(rule, `slices ${rule.slices.join(", ")} share base ${base}${rule.like ? ` with ${rule.like}` : ""}: ${text}`, true);
      }
      case "basesRelated": {
        const [sa, sb] = [slices(rule.a, rule.level), slices(rule.b, rule.level)];
        let best: { score: number; i: number; j: number } | null = null;
        if (song.score) {
          for (const [i, x] of sa.entries()) {
            for (const [j, y] of sb.entries()) {
              const score = song.score(y, x);
              if (score !== null && (!best || score > best.score)) best = { score, i, j };
            }
          }
        }
        const scored = best ? `best score ${best.score.toFixed(2)} (${rule.a} slice ${best.i + 1} against ${rule.b} slice ${best.j + 1})` : "no score";
        const text = `${rule.a} ${sa.map(labelOf).join(" ")} / ${rule.b} ${sb.map(labelOf).join(" ")}; ${scored}`;
        const shared = [...bases([rule.a], rule.level)].filter((b) => bases([rule.b], rule.level).has(b));
        return shared.length > 0 ? result(rule, `share base ${shared.join(", ")}: ${text}`, true) : result(rule, `share no base: ${text}`);
      }
      case "sliceNotIn": {
        const sl = slices(rule.section, rule.level);
        if (sl.length === 1) return result(rule, NA);
        const slice = sl[rule.slice < 0 ? sl.length + rule.slice : rule.slice];
        if (!slice) return result(rule, `${rule.section} has no slice ${rule.slice} (${sl.length} slices)`);
        if (slice.name.pattern === null) return result(rule, `slice ${rule.slice} is a rest`);
        if (bases(rule.against, rule.level).has(baseOf(slice))) return result(rule, `slice ${rule.slice} (${labelOf(slice)}) has a base that ${rule.against.join(", ")} also hold`);
        return result(rule, `slice ${rule.slice} (${labelOf(slice)}) is not in ${rule.against.join(", ")}`, true);
      }
    }
  }

  return key.rules.map((rule) => {
    try {
      return check(rule);
    } catch (error) {
      if (error instanceof Missing) return result(rule, error.message);
      throw error;
    }
  });
}

export interface BaselineScore {
  pairs: number; // same-label bar pairs (no ′, no rests)
  kept: number; // of those, grouped by the lane
  broken: Array<[number, number]>; // the rest, as bar indices
  merges: { n: number; bad: number }; // see scoreBaseline
}

/**
 * Spike 2's Kashmir bar labels against a lane. Every two bars with the same label (a ′ label and a rest form none; "J+2"
 * pairs only with "J+2") must still be grouped: both midpoints in one slice (coarser cuts are fine), or their slices share a
 * base. A bar whose midpoint is in no slice belongs to none.
 *
 * It also checks the lane does not merge what spike 2 told apart (a lane of one name everywhere keeps every pair). Among the
 * bars (no ′, no rests) at the same offset in different slices of one base, `merges.bad` of `merges.n` pairs have different labels.
 */
export function scoreBaseline(b: Baseline, song: SongLanes, level = 1): BaselineScore {
  const lane = song.levels[level] ?? [];
  const sliceOf = b.bars.map((bar) => {
    const mid = (bar.start + bar.end) / 2;
    return lane.findIndex((s) => mid >= s.start && mid < s.end);
  });
  const offset = b.bars.map((_, i) => {
    let k = i;
    while (k > 0 && sliceOf[i] >= 0 && sliceOf[k - 1] === sliceOf[i]) k--;
    return i - k;
  });
  const sharesBase = (i: number, j: number) => {
    const [si, sj] = [sliceOf[i], sliceOf[j]];
    return si >= 0 && sj >= 0 && si !== sj && lane[si].name.pattern !== null && lane[si].name.pattern === lane[sj].name.pattern;
  };
  const plain = (i: number) => b.bars[i].label !== "." && !b.bars[i].label.includes(PRIME);
  const byLabel = new Map<string, number[]>();
  b.bars.forEach((bar, i) => {
    if (plain(i)) byLabel.set(bar.label, [...(byLabel.get(bar.label) ?? []), i]);
  });
  let pairs = 0;
  let kept = 0;
  const broken: Array<[number, number]> = [];
  for (const members of byLabel.values()) {
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const [i, j] = [members[x], members[y]];
        pairs++;
        if ((sliceOf[i] >= 0 && sliceOf[i] === sliceOf[j]) || sharesBase(i, j)) kept++;
        else broken.push([i, j]);
      }
    }
  }
  broken.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let n = 0;
  let bad = 0;
  for (let i = 0; i < b.bars.length; i++) {
    if (!plain(i)) continue;
    for (let j = i + 1; j < b.bars.length; j++) {
      if (!plain(j) || offset[i] !== offset[j] || !sharesBase(i, j)) continue;
      n++;
      if (b.bars[i].label !== b.bars[j].label) bad++;
    }
  }
  return { pairs, kept, broken, merges: { n, bad } };
}

const mmss = (t: number) => {
  const tenths = Math.round(t * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, "0")}.${tenths % 10}`;
};

/**
 * The scorer's report. It passes when every Flim rule passes, of both keys (`flimV2` is the second; an info rule is listed
 * but never fails it), at least 70 % of Kashmir's pairs are kept (a lane of whole phrases cannot keep much more than
 * 70-78 %: it cuts a repeated phrase once, where spike 2 labelled every bar) and at most 10 % of its same-offset merges join
 * bars spike 2 told apart. `baseline` (the bars the pairs were made from) names the bars in the listing; without it they
 * show as bar numbers.
 */
export function formatScore(flim: RuleResult[], kashmir: BaselineScore, baseline?: Baseline, flimV2: RuleResult[] = []): { text: string; pass: boolean } {
  const line = (r: RuleResult) => `${r.info ? "INFO " : ""}${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`;
  const lines = flim.map(line);
  const gating = (rs: RuleResult[]) => rs.filter((r) => !r.info);
  const passed = (rs: RuleResult[]) => gating(rs).filter((r) => r.pass).length;
  const { pairs, kept, merges } = kashmir;
  lines.push(`Flim: ${passed(flim)}/${gating(flim).length}`);
  if (flimV2.length > 0) {
    lines.push(...flimV2.map(line));
    const info = flimV2.length - gating(flimV2).length;
    lines.push(`Flim v2: ${passed(flimV2)}/${gating(flimV2).length}${info > 0 ? ` (and ${info} info)` : ""}`);
  }
  lines.push(`Kashmir: ${kept}/${pairs} pairs kept`);
  lines.push(`Kashmir merges: ${merges.bad}/${merges.n} wrong`);
  // The bars in the most broken pairs: those are the ones to check by ear.
  const count = new Map<number, number>();
  for (const [i, j] of kashmir.broken) for (const k of [i, j]) count.set(k, (count.get(k) ?? 0) + 1);
  const worst = [...count].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  for (const [k, n] of worst.slice(0, MAX_LISTED)) {
    const bar = baseline?.bars[k];
    lines.push(bar ? `  ${mmss(bar.start)} ${bar.label} ×${n}` : `  bar ${k + 1} ×${n}`);
  }
  if (worst.length > MAX_LISTED) lines.push(`  … and ${worst.length - MAX_LISTED} more bars`);
  const keys = [flim, flimV2].every((rs) => passed(rs) === gating(rs).length);
  const pass = keys && pairs > 0 && kept * 10 >= pairs * 7 && merges.bad * 10 <= merges.n; // integers: no float edge
  return { text: lines.join("\n"), pass };
}
