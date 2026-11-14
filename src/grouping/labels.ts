// Structure section labels: letter + function hint (Plan 4, Task 3). Pure; no Node imports.
import { FUNCTION_LABELS, type FunctionLabel, type StemName, type StructureAnalysis } from "../structure/contract.js";
import type { SectionGroup } from "./letters.js";
import { sectionFrames } from "./sectionVectors.js";

const PRIME = "′";
const EN_DASH = "–";
/** Between the letter and the word: a plain hyphen, which users can type when they rename (feedback round 1). */
export const LABEL_SEP = " - ";

/**
 * What structureLabel puts before LABEL_SEP: a letter (with or without a prime), the en dash, or `no <stem>`. A user
 * renaming types the prime as an ASCII ' or a ’ (feedback round 2), so those count as one too.
 */
const LETTER_PART = /^([A-Z]+['’′]?|–|no \w+)$/;
/**
 * A label that names a group: letters, then any number of primes (′, ' or ’, and ″ or ‴), then nothing or a dash with
 * a space after it, with or without one before (Matt, 2026-11-12: `A″ - verse`, `B- outro`).
 */
const GROUP_LETTER = /^([A-Z]+)(['’′″‴]*)(?:\s*-\s.*)?$/su;

/**
 * A label split for display into its letter and the rest (from LABEL_SEP on), or no letter when the part before the
 * first LABEL_SEP is not one structureLabel makes: a rename like `Breakdown - long` stays one text (review M2).
 */
export function splitLabel(label: string): { letter: string | null; word: string } {
  const k = label.indexOf(LABEL_SEP);
  return k > 0 && LETTER_PART.test(label.slice(0, k)) ? { letter: label.slice(0, k), word: label.slice(k) } : { letter: null, word: label };
}

/** 0 -> A ... 25 -> Z, 26 -> AA, 27 -> AB (spreadsheet style). */
export function letterName(group: number): string {
  let n = Math.floor(group);
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** The inverse of letterName: A -> 0 ... Z -> 25, AA -> 26. `letters` is one or more of A-Z. */
export function letterIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * The group a label's letter names (feedback round 2: a renamed section takes the color of the letter it was given),
 * when the label starts with one (GROUP_LETTER); any prime makes it a variant. Null for any other label, the en dash
 * and `no <stem>` included: those keep their computed color.
 */
export function labelGroup(label: string): { group: number; variant: boolean } | null {
  const m = GROUP_LETTER.exec(label);
  return m ? { group: letterIndex(m[1]), variant: m[2] !== "" } : null;
}

/** Argmax of the mean functionProbs over the span's frames; ties go to the lower index. */
export function sectionFunction(a: StructureAnalysis, start: number, end: number): FunctionLabel {
  const [from, to] = sectionFrames(a, start, end);
  const sums = new Array<number>(FUNCTION_LABELS.length).fill(0);
  for (let f = from; f < to; f++) for (let k = 0; k < sums.length; k++) sums[k] += a.functionProbs[f][k];
  let best = 0;
  for (let k = 1; k < sums.length; k++) if (sums[k] > sums[best]) best = k;
  return FUNCTION_LABELS[best];
}

/**
 * `A′ - chorus`. A silent section gets an en dash for the letter, or, when the letters come from one stem
 * (Group by drums…) or the melody, names it: `no drums - solo`, `no melody - intro`.
 */
export function structureLabel(g: SectionGroup, fn: FunctionLabel, by: StemName | "all" | "melody" = "all"): string {
  const silent = by === "all" ? EN_DASH : `no ${by}`;
  const letter = g.group === null ? silent : letterName(g.group) + (g.variant ? PRIME : "");
  return `${letter}${LABEL_SEP}${fn}`;
}

/**
 * What makes two section names one name, for a color picked for it (Matt, 2026-11-12): case, runs of spaces, the
 * space before the dash and the prime's spelling aside. `A' -  Verse` and `A′ - verse` are one name.
 */
export function nameKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "′")
    .replace(/″/g, "′′")
    .replace(/‴/g, "′′′")
    .replace(/\s*-\s+/, " - ")
    .replace(/\s+/g, " ");
}
