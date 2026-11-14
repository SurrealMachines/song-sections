// Dev tool (v2, key per section): what the key detector says about the cached Structure analyses in a storage folder,
// per allin1 segment, from the kept stems (bass + other + vocals) and from a stand-in for the mix (all four stems
// summed: the render itself is not kept). Read-only on that folder.
//
//   npx tsx scripts/key-report.ts <storageDir> [hash prefix ...]
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mixHarmony, readMono, stemsHarmony } from "../src/key/harmony.js";
import { clipKey, keyLong, keyScores, sectionKeys, type KeyEstimate } from "../src/key/key.js";
import type { Harmony } from "../src/dialog/protocol.js";
import { STEM_NAMES, STRUCTURE_ENGINE, type StructureAnalysis } from "../src/structure/contract.js";

const [storage, ...prefixes] = process.argv.slice(2);
if (!storage) {
  console.error("usage: tsx scripts/key-report.ts <storageDir> [hash prefix ...]");
  process.exit(1);
}

const fmt = (k: KeyEstimate | null) => (k ? `${keyLong(k).padEnd(10)} (margin ${k.margin.toFixed(3)}, r ${k.score.toFixed(2)})` : "no key");
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
function top3(h: Harmony): string {
  const v = new Float64Array(12);
  for (const r of h.chroma) for (let k = 0; k < 12; k++) v[k] += r[k];
  const s = keyScores(v).map((r, i) => ({ r, name: NAMES[i % 12] + (i >= 12 ? "m" : "") }));
  s.sort((a, b) => b.r - a.r);
  return s.slice(0, 4).map((x) => `${x.name} ${x.r.toFixed(3)}`).join(", ");
}

async function mixStandIn(dir: string): Promise<Harmony> {
  let sum: Float32Array | null = null;
  let rate = 0;
  for (const stem of STEM_NAMES) {
    const m = await readMono(join(dir, `${stem}.wav`));
    rate = m.rate;
    if (!sum) sum = Float32Array.from(m.x);
    else for (let i = 0; i < Math.min(sum.length, m.x.length); i++) sum[i] += m.x[i];
  }
  return mixHarmony(sum!, rate);
}

const stemsRoot = join(storage, "stems");
const hashes = (await readdir(stemsRoot)).filter((h) => prefixes.length === 0 || prefixes.some((p) => h.startsWith(p)));
for (const hash of hashes) {
  let a: StructureAnalysis;
  try {
    a = JSON.parse(await readFile(join(storage, "cache", STRUCTURE_ENGINE, `${hash}.json`), "utf8"));
  } catch {
    continue;
  }
  const dir = join(stemsRoot, hash);
  const t0 = performance.now();
  let stems: Harmony;
  try {
    stems = await stemsHarmony(dir);
  } catch (error) {
    console.log(`${hash.slice(0, 8)}: no stems (${(error as Error).message})`);
    continue;
  }
  const ms = performance.now() - t0;
  const mix = await mixStandIn(dir);
  console.log(`\n${hash.slice(0, 8)}  ${mmss(a.durationSec)}  ${a.bpm ?? "?"} BPM  (stems chroma in ${(ms / 1000).toFixed(1)} s)`);
  console.log(`  tuning: stems ${stems.tuningCents} cents, mix ${mix.tuningCents} cents`);
  console.log(`  clip, stems: ${fmt(clipKey(stems))}   top: ${top3(stems)}`);
  console.log(`  clip, mix:   ${fmt(clipKey(mix))}   top: ${top3(mix)}`);
  const ks = sectionKeys(stems, a.segments);
  const km = sectionKeys(mix, a.segments);
  a.segments.forEach((s, i) => {
    console.log(`  ${mmss(s.start)}-${mmss(s.end)} ${s.label.padEnd(7)} stems ${fmt(ks[i])}   mix ${fmt(km[i])}`);
  });
}
