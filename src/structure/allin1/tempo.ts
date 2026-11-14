// Port of allin1 1.1.0 postprocessing/tempo.py (estimate_tempo_from_beats).

/** numpy's ndarray.round(): halves go to the even integer. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * The mode of round(60 / interval) over consecutive beats; null with fewer than 2 beats.
 * Tie rule: the larger bpm wins (allin1's np.argsort(...)[::-1] puts the higher bin first on equal counts).
 * Intervals that are not positive and finite are ignored (allin1 would raise or produce garbage); null if none remain.
 */
export function estimateTempo(beats: number[]): number | null {
  if (beats.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1];
    if (!(d > 0) || !Number.isFinite(d)) continue;
    const bpm = roundHalfEven(60 / d);
    counts.set(bpm, (counts.get(bpm) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [bpm, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && bpm > best)) {
      best = bpm;
      bestCount = count;
    }
  }
  return best;
}
