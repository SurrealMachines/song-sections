// v2, key per section: what the dialog shows of the keys (key/key.ts does the finding). No Node imports.
import type { Harmony, SetScale } from "./protocol.js";
import { clipKey, keyLong, sectionKeys, setScaleName } from "../key/key.js";

/** Each section's key in the dialog's form ("D minor", "F♯ major?"), or null for none. */
export function sectionKeyTexts(h: Harmony | null | undefined, sections: readonly { start: number; end: number }[]): (string | null)[] {
  return sectionKeys(h, sections).map((k) => (k ? keyLong(k) : null));
}

/** The header's key line, "Key: D minor" (with "· Set: D Minor" when Scale Mode is on), and its tooltip; null: none. */
export function headerKey(h: Harmony | null | undefined, setScale: SetScale | null | undefined): { text: string; title: string } | null {
  const k = clipKey(h);
  if (!k || !h) return null;
  const from = h.source === "stems" ? "the bass, other and vocals stems" : "the clip's audio";
  const set = setScale ? ` · Set: ${setScaleName(setScale.root, setScale.name)}` : "";
  return {
    text: `Key: ${keyLong(k)}${set}`,
    title:
      `The whole clip's key, heard in ${from}. Each section's key is on its band, or in its tooltip.` +
      (k.sure ? "" : " The ? means it is not sure: another key fits almost as well, or the section is too short to tell.") +
      (setScale ? " Set: the Set's scale (Scale Mode is on), for comparison." : ""),
  };
}
