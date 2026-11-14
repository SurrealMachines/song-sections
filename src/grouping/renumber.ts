// Renumbering the letters of sections and the numbers of patterns when one is renamed (Matt, 2026-11-11): the + in
// the rename list inserts a letter or number, moving the ones after it up, and no rename ever leaves a gap.
// Pure; no Node imports.
import { LABEL_SEP, letterIndex, letterName } from "./labels.js";

/** What a label's letter or number is (zero-based), and the label with another one in its place. */
export interface LabelKey {
  key: number;
  with(key: number): string;
}
export type KeyOf = (label: string) => LabelKey | null;

/** The head is the whole label, or the part before the first LABEL_SEP. */
function keyed(label: string, head: RegExp, toKey: (m: string) => number, fromKey: (k: number) => string): LabelKey | null {
  const k = label.indexOf(LABEL_SEP);
  const part = k > 0 ? label.slice(0, k) : label;
  const m = head.exec(part);
  if (!m) return null;
  const rest = label.slice(m[1].length);
  return { key: toKey(m[1]), with: (n) => fromKey(n) + rest };
}

/** A section's letter, as labelGroup reads it: letters, then an optional prime in any of its three spellings. */
export const letterKey: KeyOf = (label) => keyed(label, /^([A-Z]+)['’′]?$/, letterIndex, letterName);

/** A pattern's number, as patternHues reads it: 1, 2, … (key 0, 1, …), then an optional prime. */
export const numberKey: KeyOf = (label) =>
  keyed(
    label,
    /^([1-9]\d*)['’′]?$/,
    (m) => Number(m) - 1,
    (k) => String(k + 1),
  );

/** True when the text is a letter (or number) alone, with no prime and no word: the + then inserts a new one. */
export function isBareKey(text: string, keyOf: KeyOf): boolean {
  const t = text.trim();
  return keyOf(t) !== null && !/['’′]/.test(t) && !t.includes(LABEL_SEP);
}

/** Every label whose key is `at` or later moves up one, so `at` is free for the label the + is adding. */
export function insertKey(labels: string[], keyOf: KeyOf, at: number): string[] {
  return labels.map((l) => {
    const k = keyOf(l);
    return k && k.key >= at ? k.with(k.key + 1) : l;
  });
}

/** The keys in use are renumbered 0, 1, 2, … in order, so none is missing; labels with no key are left alone. */
export function closeGaps(labels: string[], keyOf: KeyOf): string[] {
  const keys = labels.map(keyOf);
  const used = [...new Set(keys.filter((k) => k !== null).map((k) => k!.key))].sort((x, y) => x - y);
  if (used.every((k, i) => k === i)) return labels;
  return labels.map((l, i) => {
    const k = keys[i];
    return k ? k.with(used.indexOf(k.key)) : l;
  });
}
