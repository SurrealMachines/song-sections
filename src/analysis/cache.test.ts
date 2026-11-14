import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadCached, removeCached, saveCached } from "./cache.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "song-sections-cache-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("analysis cache", () => {
  test("save then load returns a deep-equal value", async () => {
    const value = { bpm: 120, boundaries: [0, 16.5, 32], labels: ["intro", "verse"] };
    await saveCached(dir, "abc123", "meyda-1", value);
    expect(await loadCached(dir, "abc123", "meyda-1")).toEqual(value);
  });

  test("a different engine string returns null", async () => {
    await saveCached(dir, "abc123", "meyda-1", { x: 1 });
    expect(await loadCached(dir, "abc123", "meyda-2")).toBeNull();
  });

  test("a missing entry returns null", async () => {
    expect(await loadCached(dir, "nothere", "meyda-1")).toBeNull();
  });

  test("a corrupt file returns null", async () => {
    const engineDir = join(dir, "cache", "meyda-1");
    await mkdir(engineDir, { recursive: true });
    await writeFile(join(engineDir, "bad.json"), "{");
    expect(await loadCached(dir, "bad", "meyda-1")).toBeNull();
  });

  test("load rejects a traversal engine and returns null", async () => {
    await saveCached(dir, "abc123", "meyda-1", { x: 1 });
    expect(await loadCached(dir, "abc123", "../cache/meyda-1")).toBeNull();
    expect(await loadCached(dir, "abc123", "../x")).toBeNull();
    expect(await loadCached(dir, "abc123", "a/b")).toBeNull();
    expect(await loadCached(dir, "abc123", "..")).toBeNull();
    expect(await loadCached(dir, "abc123", ".")).toBeNull();
    expect(await loadCached(dir, "abc123", "")).toBeNull();
  });

  test("load rejects a traversal hash and returns null", async () => {
    await saveCached(dir, "abc123", "meyda-1", { x: 1 });
    expect(await loadCached(dir, "../abc123", "meyda-1")).toBeNull();
    expect(await loadCached(dir, "a/b", "meyda-1")).toBeNull();
    expect(await loadCached(dir, "..", "meyda-1")).toBeNull();
    expect(await loadCached(dir, "", "meyda-1")).toBeNull();
  });

  test("save rejects a traversal engine and writes nothing outside the cache", async () => {
    await expect(saveCached(dir, "abc123", "../x", { x: 1 })).rejects.toThrow();
    await expect(saveCached(dir, "abc123", "a/b", { x: 1 })).rejects.toThrow();
    await expect(saveCached(dir, "abc123", "..", { x: 1 })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  test("save rejects a traversal hash and writes nothing outside the cache", async () => {
    await expect(saveCached(dir, "../escape", "meyda-1", { x: 1 })).rejects.toThrow();
    await expect(saveCached(dir, "a/b", "meyda-1", { x: 1 })).rejects.toThrow();
    await expect(saveCached(dir, "..", "meyda-1", { x: 1 })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  test("save leaves no temp files behind", async () => {
    await saveCached(dir, "abc123", "meyda-1", { x: 1 });
    expect(await readdir(join(dir, "cache", "meyda-1"))).toEqual(["abc123.json"]);
  });

  test("removeCached deletes one entry, leaves the others, and is quiet when there is none (fb2 Re-analyze)", async () => {
    await saveCached(dir, "abc123", "meyda-1", { x: 1 });
    await saveCached(dir, "abc123", "cue-1", { x: 2 });
    await removeCached(dir, "abc123", "meyda-1");
    expect(await loadCached(dir, "abc123", "meyda-1")).toBeNull();
    expect(await loadCached(dir, "abc123", "cue-1")).toEqual({ x: 2 });
    await expect(removeCached(dir, "abc123", "meyda-1")).resolves.toBeUndefined();
    await expect(removeCached(dir, "../abc123", "meyda-1")).rejects.toThrow();
  });
});
