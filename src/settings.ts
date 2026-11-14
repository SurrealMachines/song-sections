// Per-user settings in <storageDir>/settings.json: the last dialog mode, the Structure dialog's choices and (v2) the send
// menu's "Key in names".
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { structurePrefs, type DialogMode, type StructurePrefs } from "./dialog/protocol.js";

export interface Settings {
  lastMode: DialogMode;
  /** Absent until a Structure dialog was applied (feedback round 1). */
  structure?: StructurePrefs;
  /** v2: the send menu's "Key in names"; absent means on. */
  keyInNames?: boolean;
}

const FILE = "settings.json";
const MODES: readonly DialogMode[] = ["cue", "structure"];
const DEFAULTS: Settings = { lastMode: "cue" };

/**
 * A missing, unreadable or corrupt file gives the defaults (`lastMode: "cue"`). A damaged Structure entry is repaired
 * field by field (structurePrefs). Never throws.
 */
export async function loadSettings(storageDir: string): Promise<Settings> {
  try {
    const v = JSON.parse(await readFile(join(storageDir, FILE), "utf8")) as Partial<Settings> | null;
    const lastMode = MODES.includes(v?.lastMode as DialogMode) ? (v!.lastMode as DialogMode) : DEFAULTS.lastMode;
    const structure = v && typeof v === "object" && "structure" in v ? structurePrefs(v.structure) : undefined;
    const keyInNames = typeof v?.keyInNames === "boolean" ? v.keyInNames : undefined;
    return { lastMode, ...(structure ? { structure } : {}), ...(keyInNames !== undefined ? { keyInNames } : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Writes a temp file beside settings.json, then renames it over, so a reader never sees half a file. */
export async function saveSettings(storageDir: string, s: Settings): Promise<void> {
  await mkdir(storageDir, { recursive: true });
  const tmp = join(storageDir, `${FILE}.${randomUUID()}.tmp`);
  try {
    const out: Settings = {
      lastMode: s.lastMode,
      ...(s.structure ? { structure: s.structure } : {}),
      ...(typeof s.keyInNames === "boolean" ? { keyInNames: s.keyInNames } : {}),
    };
    await writeFile(tmp, JSON.stringify(out), "utf8");
    await rename(tmp, join(storageDir, FILE));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
