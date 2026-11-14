// Scores the engine on the real Flim (both of Matt's keys) and Kashmir (Plan 5, Task 10). Skipped without SONG_SECTIONS_STORAGE pointing at a
// storage folder that holds both songs' allin1 cache and stems:
//   SONG_SECTIONS_STORAGE=/path/to/.dev/storage npm test -- src/patterns/answerKey.real
import { describe, expect, it } from "vitest";
import { FLIM_LIVE, loadSong, loadSongAt, readBaseline, readKey, readKeyV2, realStorage, storageWith } from "../test/realPatterns.js";
import { formatScore, scoreBaseline, scoreKey } from "./answerKey.js";
import { PATTERN_LEVELS, barIndexAt } from "./contract.js";
import { createPatternEngine } from "./engine.js";

describe.skipIf(!realStorage())("pattern engine on the real songs", () => {
  it("passes Matt's Flim answer key and keeps Kashmir's spike-2 groups", { timeout: 120_000 }, async () => {
    const storage = realStorage() as string;
    const [key, keyV2, baseline] = [await readKey(), await readKeyV2(), await readBaseline()];
    const flim = await loadSong(storage, key.hash, key.source);
    const kashmir = await loadSong(storage, baseline.hash, baseline.source);
    const { text, pass } = formatScore(scoreKey(key, flim), scoreBaseline(baseline, kashmir), baseline, scoreKey(keyV2, flim));
    expect(pass, text).toBe(true);
  });

  // review 6: a section cut like the music it repeats keeps, at each level, every cut of the level below, as one cut by
  // its own split does
  it("keeps every machine cut of a level at the levels above, in every lane of both songs", { timeout: 120_000 }, async () => {
    const storage = realStorage() as string;
    for (const hash of [(await readKey()).hash, (await readBaseline()).hash]) {
      const song = await loadSong(storage, hash);
      const engine = createPatternEngine(song.features);
      for (const source of engine.sources) {
        const levels = engine.machineLevels(source, song.sections);
        for (let level = 1; level < PATTERN_LEVELS; level++) {
          const above = new Set(levels[level + 1]);
          expect(levels[level].filter((c) => !above.has(c)), `${hash} ${source} level ${level}`).toEqual([]);
        }
      }
    }
  });
});

// Matt in Live (fix round 3): his Flim, at his Sections slider (-0.14 in settings.json), has Instrumental 1 and 2 as one
// 26-bar section. Its 5-bar Ds differ at their ends, so they repeat neither a bar on nor one D on, only two Ds on; the
// loop guard of fix round 2 read that as a loop and cut the section into 2-bar pieces.
describe.skipIf(!storageWith(FLIM_LIVE))("pattern engine on Matt's Flim in Live", () => {
  it("cuts its 26-bar instrumental into 6 bars and four 5-bar Ds of one pattern, on other at level 1", { timeout: 120_000 }, async () => {
    const song = await loadSongAt(storageWith(FLIM_LIVE) as string, FLIM_LIVE, -0.14);
    const bars = (s: { start: number; end: number }) => barIndexAt(song.grid, s.end) - barIndexAt(song.grid, s.start);
    const inst = song.sections.find((s) => bars(s) === 26);
    expect(inst, `sections of ${song.sections.map(bars).join(" | ")} bars`).toBeDefined();
    const slices = song.levels[1].filter((x) => (x.start + x.end) / 2 >= inst!.start && (x.start + x.end) / 2 < inst!.end);
    const text = slices.map((x) => `${x.label}(${bars(x)})`).join(" ");
    expect(slices.map(bars), text).toEqual([6, 5, 5, 5, 5]);
    expect(new Set(slices.slice(1).map((x) => x.name.pattern)).size, text).toBe(1);
  });
});
