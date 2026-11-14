// Dev tool (Plan 5, Task 10): scores the pattern engine on the real songs in a storage folder. Flim against Matt's answer key
// (fixtures/patterns/flim-answer-key.json) and his phrase-level reading (flim-answer-key-v2.json), Kashmir against spike 2's
// labels (kashmir-spike2.json). Read-only on that folder. Exits 1 unless every Flim rule of both keys passes (an "info" rule
// is printed but never fails it), at least 70 % of Kashmir's pairs are kept and at most 10 % are wrong merges.
//
//   npx tsx scripts/patterns-score.ts <storageDir>      (npm run patterns:score -- <storageDir>)
import { formatScore, scoreBaseline, scoreKey } from "../src/patterns/answerKey.js";
import { FLIM, KASHMIR, findSong, loadSong, readBaseline, readKey, readKeyV2 } from "../src/test/realPatterns.js";

const storage = process.argv[2];
if (!storage) {
  console.error("usage: tsx scripts/patterns-score.ts <storageDir>");
  process.exit(2);
}
for (const hash8 of [FLIM, KASHMIR]) {
  if (!findSong(storage, hash8)) {
    console.error(`${hash8}: no allin1 analysis with kept stems in ${storage}`);
    process.exit(2);
  }
}

const [key, keyV2, baseline] = [await readKey(), await readKeyV2(), await readBaseline()];
const flim = await loadSong(storage, key.hash, key.source);
const kashmir = await loadSong(storage, baseline.hash, baseline.source);
const { text, pass } = formatScore(scoreKey(key, flim), scoreBaseline(baseline, kashmir), baseline, scoreKey(keyV2, flim));
console.log(text);
process.exit(pass ? 0 : 1);
