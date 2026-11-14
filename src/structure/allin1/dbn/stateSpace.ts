// Port of madmom 0.16.1 BeatStateSpace / BarStateSpace (madmom/features/beats_hmm.py). See downbeats.ts for the licence notice.

export interface BarStateSpace {
  numBeats: number;
  numStates: number;
  /** Position inside the bar, in beats: [0, numBeats). */
  statePositions: Float64Array;
  /** Beat interval (frames) of each state. */
  stateIntervals: Uint16Array;
  /** First / last state of each tempo, per beat (ascending). */
  firstStates: Uint32Array[];
  lastStates: Uint32Array[];
}

/** numpy.linspace(start, stop, num, endpoint) in float64, same operation order. */
export function linspace(start: number, stop: number, num: number, endpoint = true): Float64Array {
  const y = new Float64Array(num);
  const div = endpoint ? num - 1 : num;
  const delta = stop - start;
  if (div > 0) {
    const step = delta / div;
    if (step === 0) for (let k = 0; k < num; k++) y[k] = (k / div) * delta + start;
    else for (let k = 0; k < num; k++) y[k] = k * step + start;
  } else {
    for (let k = 0; k < num; k++) y[k] = k * delta + start;
  }
  if (endpoint && num > 1) y[num - 1] = stop;
  return y;
}

/** numpy.round (round half to even) to an integer. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** BeatStateSpace's beat intervals: linear integers, or log-spaced quantised intervals when there are more than numIntervals. */
export function beatIntervals(minInterval: number, maxInterval: number, numIntervals?: number): Uint16Array {
  const lo = roundHalfEven(minInterval);
  const hi = roundHalfEven(maxInterval);
  let intervals: number[] = [];
  for (let i = lo; i < hi + 1; i++) intervals.push(i);
  if (numIntervals !== undefined && numIntervals < intervals.length) {
    let numLog = numIntervals;
    intervals = [];
    while (intervals.length < numIntervals) {
      const exps = linspace(Math.log2(minInterval), Math.log2(maxInterval), numLog);
      intervals = [...new Set(Array.from(exps, (e) => roundHalfEven(2 ** e)))].sort((a, b) => a - b);
      numLog++;
    }
  }
  return Uint16Array.from(intervals);
}

export function barStateSpace(beatsPerBar: number, minInterval: number, maxInterval: number, numTempi: number): BarStateSpace {
  const intervals = beatIntervals(minInterval, maxInterval, numTempi);
  const beatStates = intervals.reduce((a, b) => a + b, 0);
  const numStates = beatStates * beatsPerBar;
  const statePositions = new Float64Array(numStates);
  const stateIntervals = new Uint16Array(numStates);
  const firstStates: Uint32Array[] = [];
  const lastStates: Uint32Array[] = [];
  for (let b = 0; b < beatsPerBar; b++) {
    const first = new Uint32Array(intervals.length);
    const last = new Uint32Array(intervals.length);
    let idx = b * beatStates;
    intervals.forEach((n, j) => {
      first[j] = idx;
      // np.linspace(0, 1, n, endpoint=False) + b
      const pos = linspace(0, 1, n, false);
      for (let k = 0; k < n; k++) {
        statePositions[idx + k] = pos[k] + b;
        stateIntervals[idx + k] = n;
      }
      idx += n;
      last[j] = idx - 1;
    });
    firstStates.push(first);
    lastStates.push(last);
  }
  return { numBeats: beatsPerBar, numStates, statePositions, stateIntervals, firstStates, lastStates };
}
