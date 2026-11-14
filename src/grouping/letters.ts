// Similarity letters: average-linkage clustering of section vectors (Plan 4, Task 2). Pure; no Node imports.
// Task 13 note: real allin1 bands below ~360 Hz are one per FFT bin (2-6 semitones wide), so their pitch classes alias;
// the fake uses a clean semitone grid. Revisit the chroma floor (MIN_CHROMA_HZ) or weight bands by coverage on real data.
export const GROUP_DIST = 0.15; // the default; the Letters slider (feedback round 1) moves it over the range below
export const VARIANT_DIST = GROUP_DIST / 3; // the variant threshold is always a third of the group distance
/**
 * The Letters slider's ends: Strict and Loose. Tuned on Flim and Inner City Life (feedback round 1): one stem's
 * section vectors sit much closer together than all four stems' (Group by Other: most repeats 0.01 to 0.10 apart,
 * against 0.03 to 0.25 for All), so Strict goes down to 0.02 to split them; at 0.40 Group by All keeps one letter for
 * Flim's six middle sections (the melody's repeats over changing drums and strings) and Group by Other has one or
 * two letters left.
 */
export const GROUP_DIST_MIN = 0.02;
export const GROUP_DIST_MAX = 0.4;
export const SILENT_DB = -45; // a section quieter than this (power mean) is silent
/**
 * Group by Melody's letters use chroma alone, whose distances are 3 to 5 times smaller than one stem's chroma and
 * timbre (Flim, Matt's second reference: repeats 0.001 to 0.031 apart, his B and C melodies 0.058, A and B 0.12). The
 * Letters slider's distance is scaled by this under Melody, so its default position gives 0.05 (fb2).
 */
export const MELODY_DIST_SCALE = 1 / 3;

export interface SectionGroup {
  group: number | null; // 0, 1, 2... in order of each group's first section; null when silent
  variant: boolean; // true: A' (same group as the first section, but audibly different from it)
}

const isZero = (v: Float64Array) => v.every((x) => x === 0);

// d = 1 - v_i . v_j. Two all-zero vectors (an audible stem whose features never vary) count as identical, not as far apart.
const dist = (a: Float64Array, b: Float64Array, bothZero: boolean) => {
  if (bothZero) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
};

/**
 * The full average-linkage merge sequence of `vectors` (null: silent, left out). It does not depend on the threshold:
 * clustering at any `groupDist` is the prefix of these merges up to the first one farther than it (cutLinkage), so the
 * dialog computes it once per set of sections and the Letters slider only cuts it (fix round, review I3).
 */
export interface Linkage {
  /** The vector index of each clustered (non-null) item. */
  idx: number[];
  /** True where that item's vector is all zeros. */
  zero: boolean[];
  /** Merge k joins cluster bj[k] into bi[k] (bi < bj; a cluster is keyed by its lowest item) at distance d[k]. */
  bi: Int32Array;
  bj: Int32Array;
  d: Float64Array;
}

export function linkage(vectors: (Float64Array | null)[]): Linkage {
  const idx: number[] = [];
  vectors.forEach((v, i) => v && idx.push(i));
  const n = idx.length;

  // Pairwise distance sums between clusters; cluster c is keyed by its lowest member, so scanning in order breaks ties by (i, j).
  const sum = Array.from({ length: n }, () => new Float64Array(n));
  const zero = idx.map((k) => isZero(vectors[k]!));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sum[i][j] = sum[j][i] = dist(vectors[idx[i]]!, vectors[idx[j]]!, zero[i] && zero[j]);
  const size = new Int32Array(n).fill(1); // 0 once merged away
  const link = (i: number, j: number) => sum[i][j] / (size[i] * size[j]);

  // Each live cluster i caches its nearest live j > i (first on a tie) and that distance, so a merge costs O(n) per
  // touched row instead of a full O(n²) rescan. The sums and distances are the same arithmetic as a full rescan, and
  // the pick (first i with the strictly smallest cached distance) is the (i, j) a lexicographic scan would pick.
  const nearJ = new Int32Array(n).fill(-1);
  const nearD = new Float64Array(n).fill(Infinity);
  const rescan = (i: number) => {
    let bj = -1;
    let best = Infinity;
    for (let j = i + 1; j < n; j++) {
      if (!size[j]) continue;
      const d = link(i, j);
      if (d < best) {
        best = d;
        bj = j;
      }
    }
    nearJ[i] = bj;
    nearD[i] = best;
  };
  for (let i = 0; i < n; i++) rescan(i);

  const out = { bi: new Int32Array(Math.max(0, n - 1)), bj: new Int32Array(Math.max(0, n - 1)), d: new Float64Array(Math.max(0, n - 1)) };
  let m = 0;
  for (;;) {
    let bi = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (size[i] && nearD[i] < best) {
        best = nearD[i];
        bi = i;
      }
    }
    if (bi < 0) break;
    const bj = nearJ[bi];
    out.bi[m] = bi;
    out.bj[m] = bj;
    out.d[m++] = best;
    for (let k = 0; k < n; k++) {
      sum[bi][k] += sum[bj][k];
      sum[k][bi] = sum[bi][k];
    }
    size[bi] += size[bj];
    size[bj] = 0;
    // Only distances to bi changed, and bj is gone. Row bi and rows that pointed at bi or bj are rescanned; any other
    // row i < bi only weighs its new distance to bi against its cached nearest (an equal one wins if bi comes first).
    rescan(bi);
    for (let i = 0; i < n; i++) {
      if (!size[i] || i === bi) continue;
      if (nearJ[i] === bj || nearJ[i] === bi) rescan(i);
      else if (i < bi) {
        const d = link(i, bi);
        if (d < nearD[i] || (d === nearD[i] && bi < nearJ[i])) {
          nearD[i] = d;
          nearJ[i] = bi;
        }
      }
    }
  }
  return { idx, zero, bi: out.bi.subarray(0, m), bj: out.bj.subarray(0, m), d: out.d.subarray(0, m) };
}

/**
 * Groups from a linkage of `vectors`: its merges up to the first one farther than `groupDist`; within a group, a
 * section farther than `variantDist` from the group's first section is a variant (A′).
 */
export function cutLinkage(
  vectors: (Float64Array | null)[],
  l: Linkage,
  groupDist: number = GROUP_DIST,
  variantDist: number = groupDist / 3,
  /** Instead of the distance test: whether vector `k` is a variant of its group's first, `root` (Group by Melody, fb2). */
  isVariant?: (root: number, k: number) => boolean,
): SectionGroup[] {
  const { idx, zero } = l;
  const n = idx.length;
  // A merge joins bj's cluster into bi's, and bi is its lowest item, so each cluster's root is its first section.
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < l.d.length && !(l.d[k] > groupDist); k++) parent[l.bj[k]] = l.bi[k];
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) root[i] = parent[i] === i ? i : root[parent[i]]; // parent[i] < i, already resolved

  const out: SectionGroup[] = vectors.map(() => ({ group: null, variant: false }));
  const groupOf = new Map<number, number>(); // root -> group, numbered in order of each group's first section
  for (let k = 0; k < n; k++) {
    const r = root[k];
    if (!groupOf.has(r)) groupOf.set(r, groupOf.size);
    const variant = k !== r && (isVariant ? isVariant(idx[r], idx[k]) : dist(vectors[idx[r]]!, vectors[idx[k]]!, zero[r] && zero[k]) > variantDist);
    out[idx[k]] = { group: groupOf.get(r)!, variant };
  }
  return out;
}

/**
 * Clusters sections whose average-linkage distance is at most `groupDist`; within a group, a section farther than
 * `variantDist` from the group's first section is a variant (A′).
 */
export function groupSections(
  vectors: (Float64Array | null)[],
  groupDist: number = GROUP_DIST,
  variantDist: number = groupDist / 3,
): SectionGroup[] {
  return cutLinkage(vectors, linkage(vectors), groupDist, variantDist);
}
