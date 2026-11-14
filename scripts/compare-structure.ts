// Compares a Structure result (e.g. <storage>/dev/<clip>.structure.json from "Analyse Structure (dev)") with a
// reference: .dev/golden/<track>.structure.json or the spike's out/baseline/<track>.json (same field names).
// Prints one JSON line; exits 0 when segment labels are identical and every boundary is within 100 ms (the plan's
// "48 kHz render" row), 1 otherwise. Beats and bpm are reported, not judged.
// Usage: npx tsx scripts/compare-structure.ts <result.json> <reference.json>
import { readFileSync } from "node:fs";

interface Result {
  segments: { start: number; end: number; label: string }[];
  beats: number[];
  downbeats: number[];
  bpm: number | null;
}

const [gotPath, refPath] = process.argv.slice(2);
if (!gotPath || !refPath) {
  console.error("Usage: npx tsx scripts/compare-structure.ts <result.json> <reference.json>");
  process.exit(2);
}
const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Result;
const got = load(gotPath);
const ref = load(refPath);
const maxAbs = (a: number[], b: number[]) => (a.length === b.length ? a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0) : null);

const labelsIdentical = JSON.stringify(got.segments.map((s) => s.label)) === JSON.stringify(ref.segments.map((s) => s.label));
const maxBoundaryErrSec = maxAbs(got.segments.map((s) => s.start), ref.segments.map((s) => s.start));
const report = {
  pass: labelsIdentical && maxBoundaryErrSec !== null && maxBoundaryErrSec <= 0.1,
  segments: `${got.segments.length}/${ref.segments.length}`,
  labelsIdentical,
  maxBoundaryErrSec,
  beats: `${got.beats.length}/${ref.beats.length}`,
  maxBeatErrSec: maxAbs(got.beats, ref.beats),
  downbeats: `${got.downbeats.length}/${ref.downbeats.length}`,
  bpm: `${got.bpm}/${ref.bpm}`,
  labels: labelsIdentical ? undefined : { got: got.segments.map((s) => s.label), ref: ref.segments.map((s) => s.label) },
};
console.log(JSON.stringify(report));
process.exit(report.pass ? 0 : 1);
