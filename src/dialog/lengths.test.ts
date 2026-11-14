import { describe, expect, it } from "vitest";
import { formatLength, formatSeconds, type LengthGrid } from "./lengths.js";

// 120 BPM in 4/4: a beat every 0.5 s, a bar every 2 s.
const beats = Array.from({ length: 200 }, (_, i) => i * 0.5);
const bars = beats.filter((_, i) => i % 4 === 0);
const grid = { beats, bars };

describe("formatLength (fb3, item 3)", () => {
  it("whole bars on the grid", () => {
    expect(formatLength(0, 16, grid)).toBe("8 bars");
    expect(formatLength(4, 6, grid)).toBe("1 bar");
  });
  it("bars and beats as bars.beats", () => {
    expect(formatLength(0, 13, grid)).toBe("6.2"); // 26 beats
    expect(formatLength(2, 3.5, grid)).toBe("0.3");
  });
  it("counts beats where it starts, off a bar line", () => {
    expect(formatLength(0.5, 2.5, grid)).toBe("1 bar");
  });
  it("a 3/4 grid has three beats a bar", () => {
    const g = { beats, bars: beats.filter((_, i) => i % 3 === 0) };
    expect(formatLength(0, 6, g)).toBe("4 bars");
    expect(formatLength(0, 7, g)).toBe("4.2");
  });
  it("follows a grid whose tempo changes (allin1's beats are not even)", () => {
    const b = [0, 0.5, 1, 1.5, 2, 2.6, 3.2, 3.8, 4.4];
    expect(formatLength(0, 4.4, { beats: b, bars: [0, 2, 4.4] })).toBe("2 bars");
  });
  it("seconds without a grid, or for nothing", () => {
    expect(formatLength(0, 13, null)).toBe("13 s");
    expect(formatLength(0, 13, { beats: [], bars: [] })).toBe("13 s");
    expect(formatLength(0, 13, { beats: [1], bars: [] })).toBe("13 s");
    expect(formatLength(1, 1.01, grid)).toBe("0.0 s"); // under a 32nd of a beat
  });
  it("fb4: off the grid, still bars and beats, with sixteenths as Live shows them", () => {
    expect(formatLength(0.2, 13.37, grid)).toBe("6.2.1"); // 26.34 beats: 6 bars, 2 beats and a sixteenth
    expect(formatLength(1, 1.2, grid)).toBe("0.0.2"); // 0.4 beats
    expect(formatLength(0.3, 16.3, grid)).toBe("8 bars"); // both ends 0.6 beats off: 32 whole beats
    expect(formatLength(0.1, 16.3, grid)).toBe("8.0.2");
    expect(formatLength(0.03, 16, grid)).toBe("8 bars"); // 31.94 beats: 32 to the nearest sixteenth
  });
  it("fb4: before the first beat and past the last, the end intervals carry on", () => {
    const g = { beats: [10, 10.5, 11, 11.5, 12], bars: [10, 12] };
    expect(formatLength(2, 10, g)).toBe("4 bars");
    expect(formatLength(12, 14, g)).toBe("1 bar");
  });
});

describe("formatSeconds", () => {
  it("tenths under 10 s, whole seconds under a minute, m:ss beyond", () => {
    expect(formatSeconds(4.46)).toBe("4.5 s");
    expect(formatSeconds(23.4)).toBe("23 s");
    expect(formatSeconds(59.6)).toBe("1:00");
    expect(formatSeconds(83)).toBe("1:23");
    expect(formatSeconds(1805)).toBe("30:05");
  });
});

// fb3 review I1: the reference is formatLength as it was before the memo and the binary search (linear scans, the
// beats per bar worked out on every call).
function refIndex(grid: number[], t: number): number {
  const n = grid.length;
  let k = 0;
  while (k < n - 2 && t >= grid[k + 1]) k++;
  return k + (t - grid[k]) / (grid[k + 1] - grid[k]);
}
function refBeatsPerBar(g: LengthGrid): number {
  const counts: number[] = [];
  for (let k = 0; k + 1 < g.bars.length; k++) counts.push(Math.round(refIndex(g.beats, g.bars[k + 1]) - refIndex(g.beats, g.bars[k])));
  counts.sort((a, b) => a - b);
  const median = counts[counts.length >> 1];
  return median > 0 ? median : 4;
}
function refFormatLength(start: number, end: number, g: LengthGrid | null): string {
  const seconds = formatSeconds(end - start);
  if (!g || g.beats.length < 2) return seconds;
  // fb4: the length to the nearest sixteenth of a beat, wherever its ends are.
  const q = Math.round((refIndex(g.beats, end) - refIndex(g.beats, start)) * 4);
  if (q <= 0) return seconds;
  const n = Math.floor(q / 4);
  const per = g.bars.length >= 2 ? refBeatsPerBar(g) : 4;
  const whole = Math.floor(n / per);
  const rest = n % per;
  if (q % 4 !== 0) return `${whole}.${rest}.${q % 4}`;
  return rest === 0 ? `${whole} bar${whole === 1 ? "" : "s"}` : `${whole}.${rest}`;
}

/** A small deterministic generator, so a failure repeats. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("formatLength against the linear reference (fb3 review I1)", () => {
  const grids: Array<[string, LengthGrid | null]> = [
    ["4/4 at 120", grid],
    ["3/4", { beats, bars: beats.filter((_, i) => i % 3 === 0) }],
    ["tempo change", { beats: [0, 0.5, 1, 1.5, 2, 2.6, 3.2, 3.8, 4.4, 5, 5.6, 6.2], bars: [0, 2, 4.4, 6.2] }],
    ["two beats", { beats: [1, 1.5], bars: [] }],
    ["one bar line", { beats, bars: [0] }],
    ["no bars", { beats, bars: [] }],
    ["one beat", { beats: [0], bars: [] }],
    ["none", null],
  ];
  for (const [name, g] of grids) {
    it(`gives the same text on ${name}, repeated or not`, () => {
      const rand = rng(7);
      const top = g && g.beats.length > 0 ? g.beats[g.beats.length - 1] : 10;
      // Edges on beats, near beats, off them, before the first beat and past the last; the repeats hit the memo.
      for (let n = 0; n < 4000; n++) {
        const near = n % 3 === 0 ? 0 : n % 3 === 1 ? 0.02 : 0.3;
        const snap = (t: number) => Math.round(t * 2) / 2 + (rand() - 0.5) * near;
        const a = snap(rand() * top * 1.1 - 2);
        const b = a + rand() * 30;
        const want = refFormatLength(a, b, g);
        expect(formatLength(a, b, g)).toBe(want);
        expect(formatLength(a, b, g)).toBe(want);
      }
    });
  }
  it("a changed grid object is its own: no length is carried over from the old one", () => {
    const a: LengthGrid = { beats, bars: beats.filter((_, i) => i % 4 === 0) };
    const b: LengthGrid = { beats, bars: beats.filter((_, i) => i % 3 === 0) };
    expect(formatLength(0, 12, a)).toBe("6 bars");
    expect(formatLength(0, 12, b)).toBe("8 bars");
    expect(formatLength(0, 12, a)).toBe("6 bars");
  });
  it("keeps working past the memo's bound", () => {
    for (let k = 0; k < 5000; k++) expect(formatLength(0, 0.5 * (k + 1), grid)).toBe(refFormatLength(0, 0.5 * (k + 1), grid));
  });
});

// Wall-clock bounds run only under `npm run test:perf` (SONG_SECTIONS_PERF=1); load on a shared machine makes them flaky.
describe.skipIf(!process.env.SONG_SECTIONS_PERF)("lengths on a 30-minute clip (fb3 review I1)", () => {
  it("one full recompute (new grid, 60 sections) takes under 5 ms", () => {
    // 150 BPM: a beat every 0.4 s, 4500 beats and 1125 bars in 30 minutes.
    const newGrid = (): LengthGrid => {
      const bt = Array.from({ length: 4500 }, (_, i) => i * 0.4);
      return { beats: bt, bars: bt.filter((_, i) => i % 4 === 0) };
    };
    const edges = Array.from({ length: 61 }, (_, i) => Math.round((i * 4500) / 60) * 0.4 + (i % 7 === 3 ? 0.17 : 0));
    const grids = Array.from({ length: 21 }, newGrid);
    const times: number[] = [];
    for (const g of grids) {
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) formatLength(edges[i], edges[i + 1], g);
      times.push(performance.now() - t0);
    }
    times.shift(); // the first runs cold in the JIT too
    times.sort((x, y) => x - y);
    expect(times[times.length >> 1]).toBeLessThan(5);
    // One edit moves one handle: two lengths are new, the other 58 come from the memo.
    const g = grids[0];
    const moved = edges.slice();
    moved[30] += 0.4;
    const t1 = performance.now();
    for (let i = 0; i < 60; i++) formatLength(moved[i], moved[i + 1], g);
    expect(performance.now() - t1).toBeLessThan(5);
  });
});
