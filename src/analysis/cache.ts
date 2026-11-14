import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A path segment is safe when it is a plain name: no separators, not `.` or `..`. */
function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/** Throws when a hash or engine could escape `<dir>/cache`. */
function assertSafeSegment(label: string, segment: string): void {
  if (!isSafeSegment(segment)) {
    throw new Error(`Invalid cache ${label}: ${JSON.stringify(segment)}`);
  }
}

function cachePaths(dir: string, hash: string, engine: string) {
  assertSafeSegment("engine", engine);
  assertSafeSegment("hash", hash);
  const engineDir = join(dir, "cache", engine);
  return { engineDir, finalPath: join(engineDir, `${hash}.json`) };
}

/**
 * Load a cached analysis result. Returns null when the entry is missing,
 * unreadable, not valid JSON, or the engine/hash is an unsafe path segment.
 */
export async function loadCached<T>(dir: string, hash: string, engine: string): Promise<T | null> {
  try {
    const { finalPath } = cachePaths(dir, hash, engine);
    const text = await readFile(finalPath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Store an analysis result. Writes to a temp file in the same directory and
 * renames it into place so readers never see a partially written file.
 * Throws when the engine or hash is an unsafe path segment.
 */
export async function saveCached<T>(
  dir: string,
  hash: string,
  engine: string,
  value: T,
): Promise<void> {
  const { engineDir, finalPath } = cachePaths(dir, hash, engine);
  await mkdir(engineDir, { recursive: true });
  const tempPath = join(engineDir, `${hash}.json.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(value), "utf8");
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Delete a cached analysis result, so the next run analyses again. Resolves when the entry is gone, including when it
 * was never there. Throws when the engine or hash is an unsafe path segment.
 */
export async function removeCached(dir: string, hash: string, engine: string): Promise<void> {
  const { finalPath } = cachePaths(dir, hash, engine);
  await rm(finalPath, { force: true });
}
