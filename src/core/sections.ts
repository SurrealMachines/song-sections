import type { Section } from "./types.js";

export const MIN_SECTION_SEC = 1;

/** Two times this close are the same edge in a dialog result (the result is JSON: exact in practice). */
const PIECE_SLACK_SEC = 1e-3;

/**
 * Plan 6: Session Apply's pieces (Slice by a source), which leave out its rests and so may have gaps. Before anything
 * touches the Set, each must be finite, at least MIN_SECTION_SEC long (Review Focus 4) and inside [0, durationSec]
 * (within a millisecond of its end), and they must ascend without overlapping. Throws otherwise.
 */
export function assertValidPieces(p: Section[], durationSec: number): void {
  const fail = (why: string) => {
    throw new Error(`Invalid pieces from dialog: ${why}`);
  };
  if (p.length === 0) fail("empty");
  p.forEach((x, i) => {
    if (!Number.isFinite(x.start) || !Number.isFinite(x.end)) fail(`piece ${i} is not finite`);
    if (x.start < 0) fail(`piece ${i} starts before 0`);
    if (x.end > durationSec + PIECE_SLACK_SEC) fail(`piece ${i} ends after the clip`);
    if (x.start >= x.end) fail(`piece ${i} is empty or reversed`);
    if (x.end - x.start < MIN_SECTION_SEC - PIECE_SLACK_SEC) fail(`piece ${i} is shorter than ${MIN_SECTION_SEC} s`);
    if (i > 0 && x.start < p[i - 1].end - PIECE_SLACK_SEC) fail(`piece ${i} overlaps the one before`);
  });
}

export function cueLabel(i: number): string {
  return "Cue " + (i + 1);
}

/** Turns sorted interior boundaries into contiguous sections spanning [0, duration]. */
export function boundariesToSections(
  boundaries: number[],
  duration: number,
  label: (i: number) => string,
): Omit<Section, "color">[] {
  const edges = [0, ...boundaries, duration];
  const sections: Omit<Section, "color">[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    sections.push({ start: edges[i], end: edges[i + 1], label: label(i) });
  }
  return sections;
}

/** Moves boundary i to t, clamped so both neighbouring sections stay at least MIN_SECTION_SEC long. */
export function moveBoundary(
  b: number[],
  i: number,
  t: number,
  duration: number,
): number[] {
  const lo = i > 0 ? b[i - 1] + MIN_SECTION_SEC : MIN_SECTION_SEC;
  const hi = i < b.length - 1 ? b[i + 1] - MIN_SECTION_SEC : duration - MIN_SECTION_SEC;
  const next = [...b];
  next[i] = Math.min(Math.max(t, lo), hi);
  return next;
}

/** Inserts a boundary at t, splitting the section containing it. Ignored if either half would be too short. */
export function addBoundary(b: number[], t: number, duration: number): number[] {
  const lo = b.filter((x) => x <= t).at(-1) ?? 0;
  const hi = b.find((x) => x > t) ?? duration;
  if (t - lo < MIN_SECTION_SEC || hi - t < MIN_SECTION_SEC) return [...b];
  return [...b.filter((x) => x < t), t, ...b.filter((x) => x > t)];
}

export function removeBoundary(b: number[], i: number): number[] {
  return b.filter((_, j) => j !== i);
}

/**
 * Session scene names (sessionOps) must tell repeats apart: the second `B′ - inst` becomes `B′ - inst 2`, the third `… 3`, skipping
 * any number another label already uses. First occurrences and times are unchanged; returns new objects.
 */
export function uniqueLabels<T extends { label: string }>(sections: T[]): T[] {
  const taken = new Set(sections.map((s) => s.label));
  const seen = new Set<string>();
  return sections.map((s) => {
    if (!seen.has(s.label)) {
      seen.add(s.label);
      return { ...s };
    }
    let n = 2;
    while (taken.has(`${s.label} ${n}`)) n++;
    const label = `${s.label} ${n}`;
    taken.add(label);
    return { ...s, label };
  });
}
