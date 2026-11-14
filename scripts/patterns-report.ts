// Dev tool (Plan 5, Task 11): prints the pattern engine's lanes of a song as text, for tuning and for checking by ear. Same shape
// as spike 2's out/melody<hash>.txt. Reads the storage folder only: the pattern features are computed in a scratch folder (symlinks
// to the analysis cache and the kept stems) that is removed on exit, so nothing is written beside the analyses.
//
//   npx tsx scripts/patterns-report.ts <storageDir> [hash8 …] [--source other] [--level 1] [--grid 56-71]
//   (npm run patterns:report -- <storageDir> …)
//
// Defaults: Flim and Kashmir, every source, level 1. One row per section: its allin1 name, its start (m:ss), then one token per bar:
// a slice's label on its first bar and "-" on the bars it holds on, "." on a rest, "~" after the label of a slice that holds an
// unsure bar, and "|" every 4 bars from the section's start. --grid a-b lists, for those seconds, each corrected bar
// (start end length-in-median-bars unsure) beside allin1's downbeats.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATTERN_LEVELS, PATTERN_SOURCES, barIndexAt, type GridBar, type PatternSource } from "../src/patterns/contract.js";
import { createPatternEngine, type PatternEngine, type PatternSlice } from "../src/patterns/engine.js";
import { NO_EDITS } from "../src/patterns/lane.js";
import { STRUCTURE_ENGINE, type StructureAnalysis } from "../src/structure/contract.js";
import { FLIM, KASHMIR, findSong, loadSong } from "../src/test/realPatterns.js";

const USAGE = "usage: tsx scripts/patterns-report.ts <storageDir> [hash8 …] [--source other] [--level 1] [--grid 56-71]";
const PRETTY: Record<string, string> = { inst: "Instrumental", start: "Start", end: "End" };

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) positional.push(argv[i]);
    else if (argv[i + 1] === undefined) fail(`${argv[i]} needs a value\n${USAGE}`);
    else flags.set(argv[i], argv[++i]);
  }
  for (const f of flags.keys()) if (!["--source", "--level", "--grid"].includes(f)) fail(`unknown option ${f}\n${USAGE}`);
  const [storage, ...hashes] = positional;
  if (!storage) fail(USAGE);

  const source = flags.get("--source");
  if (source !== undefined && !(PATTERN_SOURCES as readonly string[]).includes(source)) {
    fail(`--source must be one of ${PATTERN_SOURCES.join(", ")}`);
  }
  const level = Number(flags.get("--level") ?? 1);
  if (!Number.isInteger(level) || level < 0 || level > PATTERN_LEVELS) fail(`--level must be an integer from 0 to ${PATTERN_LEVELS}`);
  const gridText = flags.get("--grid");
  const range = gridText?.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (gridText !== undefined && (!range || Number(range[1]) >= Number(range[2]))) fail("--grid must be a-b seconds, e.g. 56-71");
  return {
    storage,
    hashes: hashes.length > 0 ? hashes : [FLIM, KASHMIR],
    source: source as PatternSource | undefined,
    level,
    grid: range ? ([Number(range[1]), Number(range[2])] as const) : undefined,
  };
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** allin1's word for each section (the segment it overlaps most), numbered when a word repeats: `Verse 1`, `Verse 2`. */
function sectionNames(analysis: StructureAnalysis, sections: { start: number; end: number }[]): string[] {
  const segs = analysis.segments.filter((s) => s.end - s.start > 0.05);
  const labels = sections.map((sec) => {
    const overlap = (s: { start: number; end: number }) => Math.min(s.end, sec.end) - Math.max(s.start, sec.start);
    return segs.reduce((best, s) => (overlap(s) > overlap(best) ? s : best), segs[0]).label as string;
  });
  const total: Record<string, number> = {};
  const seen: Record<string, number> = {};
  for (const l of labels) total[l] = (total[l] ?? 0) + 1;
  return labels.map((l) => {
    const base = PRETTY[l] ?? l[0].toUpperCase() + l.slice(1);
    seen[l] = (seen[l] ?? 0) + 1;
    return total[l] > 1 ? `${base} ${seen[l]}` : base;
  });
}

/** `== other: 9 patterns (2 heard once), level 1`: patterns are counted by number, a variant belonging to its pattern. */
function header(source: PatternSource, lane: PatternSlice[], level: number): string {
  const counts = new Map<number, number>();
  for (const s of lane) if (s.name.pattern !== null) counts.set(s.name.pattern, (counts.get(s.name.pattern) ?? 0) + 1);
  const once = [...counts.values()].filter((n) => n === 1).length;
  return `== ${source}: ${counts.size} patterns (${once} heard once), level ${level}`;
}

/** One row per section. A bar belongs to the section and the slice that hold its midpoint, as spike 2 did for its phrases. */
function rows(grid: GridBar[], lane: PatternSlice[], sections: { start: number; end: number }[], names: string[]): string[] {
  const owner = (t: number, spans: { start: number; end: number }[]) => spans.findIndex((s) => t >= s.start && t < s.end);
  const bars = grid.map((b) => {
    const mid = (b.start + b.end) / 2;
    return { section: owner(mid, sections), slice: owner(mid, lane), unsure: b.unsure };
  });
  return sections.map((sec, k) => {
    const mine = bars.filter((b) => b.section === k);
    const cells: string[] = [];
    mine.forEach((b, i) => {
      if (i % 4 === 0 && i > 0) cells.push("|");
      const slice = lane[b.slice];
      if (slice?.label === null) return cells.push(".");
      if (!slice || (i > 0 && mine[i - 1].slice === b.slice)) return cells.push("-");
      cells.push(slice.label + (mine.some((m) => m.slice === b.slice && m.unsure) ? "~" : ""));
    });
    return `${`${names[k]} ${clock(sec.start)}`.padEnd(20)} ${cells.join(" ")}`.trimEnd();
  });
}

/** The corrected bars between `a` and `b` seconds beside allin1's downbeats in each. */
function gridTable(grid: GridBar[], downbeats: number[], a: number, b: number): string[] {
  const lengths = grid.map((g) => g.end - g.start).sort((x, y) => x - y);
  const median = lengths[Math.floor(lengths.length / 2)];
  const out = [
    `-- grid ${a}-${b} s: corrected bars (median bar ${median.toFixed(3)} s) beside allin1's downbeats`,
    "bar    start      end     bars  unsure  allin1 downbeats",
  ];
  grid.forEach((g, i) => {
    if (g.end <= a || g.start >= b) return;
    const beside = downbeats.filter((d) => d >= g.start && d < g.end).map((d) => d.toFixed(3));
    out.push(
      [String(i).padStart(3), g.start.toFixed(3).padStart(9), g.end.toFixed(3).padStart(9), ((g.end - g.start) / median).toFixed(2).padStart(7), (g.unsure ? "yes" : "no").padStart(7), `  ${beside.join(" ") || "-"}`].join(" "),
    );
  });
  return out;
}

const args = parseArgs(process.argv.slice(2));
const full = args.hashes.map((h) => {
  if (!findSong(args.storage, h)) fail(`${h}: no allin1 analysis with kept stems in ${args.storage}`);
  return findSong(args.storage, h)!;
});

// Pattern features are cached beside the analyses; give them a scratch folder instead, so the real storage stays untouched.
const scratch = mkdtempSync(join(tmpdir(), "patterns-report-"));
try {
  mkdirSync(join(scratch, "cache"));
  symlinkSync(join(args.storage, "cache", STRUCTURE_ENGINE), join(scratch, "cache", STRUCTURE_ENGINE));
  symlinkSync(join(args.storage, "stems"), join(scratch, "stems"));

  for (const [i, hash8] of args.hashes.entries()) {
    const analysis = JSON.parse(await readFile(join(args.storage, "cache", STRUCTURE_ENGINE, `${full[i]}.json`), "utf8")) as StructureAnalysis;
    const song = await loadSong(scratch, hash8);
    const engine: PatternEngine = createPatternEngine(song.features);
    const names = sectionNames(analysis, song.sections);
    console.log(`${hash8}: ${analysis.durationSec.toFixed(1)} s, ${song.features.grid.length} bars, ${analysis.bpm ?? "?"} bpm`);
    for (const source of args.source ? [args.source] : engine.sources) {
      const lane = engine.lane(source, song.markers, args.level, NO_EDITS);
      console.log(["", header(source, lane, args.level), ...rows(song.features.grid, lane, song.sections, names)].join("\n"));
    }
    if (args.grid) console.log(["", ...gridTable(song.features.grid, analysis.downbeats, ...args.grid)].join("\n"));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
