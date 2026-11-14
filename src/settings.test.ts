import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "./settings.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ss-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings", () => {
  it("v2: round-trips Key in names, and ignores a value that is not a boolean", async () => {
    await saveSettings(dir, { lastMode: "cue", keyInNames: false });
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual({ lastMode: "cue", keyInNames: false });
    expect(await loadSettings(dir)).toEqual({ lastMode: "cue", keyInNames: false });
    await writeFile(join(dir, "settings.json"), '{"lastMode":"structure","keyInNames":"no"}');
    expect(await loadSettings(dir)).toEqual({ lastMode: "structure" });
  });

  it("defaults to cue when there is no settings file", async () => {
    expect(await loadSettings(dir)).toEqual({ lastMode: "cue" });
  });

  it("round-trips lastMode through <storageDir>/settings.json", async () => {
    await saveSettings(dir, { lastMode: "structure" });
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual({ lastMode: "structure" });
    expect(await loadSettings(dir)).toEqual({ lastMode: "structure" });
    await saveSettings(dir, { lastMode: "cue" });
    expect(await loadSettings(dir)).toEqual({ lastMode: "cue" });
  });

  it("leaves no temp file behind", async () => {
    await saveSettings(dir, { lastMode: "structure" });
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  it("creates the storage directory when it does not exist yet", async () => {
    const nested = join(dir, "a", "b");
    await saveSettings(nested, { lastMode: "structure" });
    expect(await loadSettings(nested)).toEqual({ lastMode: "structure" });
  });

  it("falls back to the default for a corrupt or unexpected file", async () => {
    for (const text of ["{not json", "null", "[]", '{"lastMode":"waveform"}', '{"lastMode":3}', ""]) {
      await writeFile(join(dir, "settings.json"), text);
      expect(await loadSettings(dir)).toEqual({ lastMode: "cue" });
    }
  });

  it("round-trips the remembered Structure choices, and repairs a damaged entry field by field", async () => {
    const structure = { sliceBy: "drums" as const, patternLevel: 3, colorMode: "uniform" as const, snap: false, snapTarget: "downbeats" as const, granularity: 0.5, groupDist: 0.25, showStems: false };
    await saveSettings(dir, { lastMode: "structure", structure });
    expect(await loadSettings(dir)).toEqual({ lastMode: "structure", structure });
    await writeFile(join(dir, "settings.json"), JSON.stringify({ lastMode: "cue", structure: { ...structure, snapTarget: "beats" } }));
    expect(await loadSettings(dir)).toEqual({ lastMode: "cue", structure: { ...structure, snapTarget: "bars" } });
  });

  it("loads a v2 entry with the old groupBy with the defaults for Slice by and Patterns (Plan 6)", async () => {
    const old = { groupBy: "other", colorMode: "soft", snap: true, snapTarget: "downbeats", granularity: 0.75, groupDist: 0.15, showStems: true };
    await writeFile(join(dir, "settings.json"), JSON.stringify({ lastMode: "structure", structure: old }));
    const { groupBy: _dropped, ...rest } = old;
    expect(await loadSettings(dir)).toEqual({ lastMode: "structure", structure: { ...rest, sliceBy: "sections", patternLevel: 4 } });
  });

  it("remembers Slice by and the Patterns level", async () => {
    const structure = { sliceBy: "bass" as const, patternLevel: 0, colorMode: "soft" as const, snap: true, snapTarget: "downbeats" as const, granularity: 0.75, groupDist: 0.15, showStems: true };
    await saveSettings(dir, { lastMode: "structure", structure });
    expect(await loadSettings(dir)).toEqual({ lastMode: "structure", structure });
  });

  it("reads a remembered Slice by All (the removed \"mix\") as Sections", async () => {
    const structure = { sliceBy: "mix", patternLevel: 2, colorMode: "soft", snap: true, snapTarget: "downbeats", granularity: 0, groupDist: 0.15, showStems: false };
    await saveSettings(dir, { lastMode: "structure", structure: structure as never });
    expect((await loadSettings(dir)).structure).toEqual({ ...structure, sliceBy: "sections" });
  });

  it("has no Structure choices until some were saved", async () => {
    await saveSettings(dir, { lastMode: "structure" });
    expect(await loadSettings(dir)).toEqual({ lastMode: "structure" });
  });
});
