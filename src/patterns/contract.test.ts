import { describe, expect, it, vi } from "vitest";
import {
  CELL_RATE,
  PATTERN_ENGINE,
  PATTERN_SOURCES,
  barIndexAt,
  barsIn,
  decodeInt8,
  encodeInt8,
  isPatternFeatures,
  patternText,
  sourceKind,
  type GridBar,
  type PatternFeatures,
  type SourceCells,
} from "./contract.js";
import { FEATURE_LAYOUT, type DecodedSource } from "./features.js";
import { REST_BELOW_DB, REST_FLOOR_DB, WEIGHTS, zScoreCells } from "./similarity.js";

const regularGrid = (barSec: number, total: number): GridBar[] =>
  Array.from({ length: Math.round(total / barSec) }, (_, i) => ({ start: i * barSec, end: (i + 1) * barSec, unsure: false }));

const cells = (kind: SourceCells["kind"], n: number, dims: number): SourceCells => ({
  kind,
  dims,
  cells: n,
  data: encodeInt8(new Int8Array(n * dims)),
  loud: encodeInt8(new Int8Array(n)),
});

// Two 50 ms cells: a 0.1 s clip with one bar.
const valid = (): PatternFeatures => ({
  engine: PATTERN_ENGINE,
  rate: CELL_RATE,
  durationSec: 0.1,
  grid: [{ start: 0, end: 0.1, unsure: false }],
  sources: { mix: cells("mix", 2, 3), drums: cells("drums", 2, 4) },
});

describe("grid helpers", () => {
  const grid = regularGrid(2, 16);
  it("counts the bars between the nearest grid points", () => {
    expect(barsIn(grid, { start: 0.02, end: 3.97 })).toBe(2);
    expect(barsIn(grid, { start: 4, end: 4.3 })).toBe(1);
    expect(barsIn(grid, { start: 0, end: 16 })).toBe(8);
  });
  it("finds the bar whose start is nearest", () => {
    expect(barIndexAt(grid, 4.9)).toBe(2);
    expect(barIndexAt(grid, 5.1)).toBe(3);
    expect(barIndexAt(grid, -3)).toBe(0);
    expect(barIndexAt(grid, 99)).toBe(7);
  });
  it("copes with an empty grid", () => {
    expect(barsIn([], { start: 0, end: 5 })).toBe(1);
    expect(barIndexAt([], 2)).toBe(0);
  });
  it("follows an irregular grid", () => {
    const g: GridBar[] = [
      { start: 0, end: 1, unsure: false },
      { start: 1, end: 3.5, unsure: true },
      { start: 3.5, end: 4, unsure: false },
    ];
    expect(barsIn(g, { start: 0.9, end: 4 })).toBe(2);
    expect(barIndexAt(g, 3.4)).toBe(2);
  });
});

describe("codec", () => {
  it("round-trips Int8 values", () => {
    const input = Int8Array.of(-128, -1, 0, 1, 127);
    const out = decodeInt8(encodeInt8(input));
    expect(out.length).toBe(input.length);
    input.forEach((v, i) => expect(out[i]).toBe(v));
  });
  it("round-trips a large array and an empty one", () => {
    const big = Int8Array.from({ length: 100_003 }, (_, i) => ((i * 31) % 256) - 128);
    expect(Array.from(decodeInt8(encodeInt8(big)))).toEqual(Array.from(big));
    expect(decodeInt8(encodeInt8(new Int8Array(0))).length).toBe(0);
  });

  // Reference: what the codec produced with btoa/atob, which the caches and fixtures on disk were written with.
  const viaBtoa = (a: Int8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
  const samples: Record<string, Int8Array> = {
    empty: new Int8Array(0),
    "length 1 (mod 3 = 1)": Int8Array.of(-128),
    "length 2 (mod 3 = 2)": Int8Array.of(127, -1),
    "length 3 (mod 3 = 0)": Int8Array.of(0, 1, -2),
    "length 4": Int8Array.of(-128, 127, 0, 5),
    "every value -128..127": Int8Array.from({ length: 256 }, (_, i) => i - 128),
    "every value, rotated (length 257)": Int8Array.from({ length: 257 }, (_, i) => ((i * 7) % 256) - 128),
    "a view into a larger buffer": new Int8Array(Int8Array.from({ length: 40 }, (_, i) => i - 20).buffer, 5, 11),
    "large (100003)": Int8Array.from({ length: 100_003 }, (_, i) => ((i * 31) % 256) - 128),
  };
  for (const [name, a] of Object.entries(samples)) {
    it(`encodes byte-identically to btoa and round-trips: ${name}`, () => {
      const text = encodeInt8(a);
      expect(text).toBe(viaBtoa(a));
      expect(text).toBe(btoa(Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), (v) => String.fromCharCode(v)).join("")));
      expect(Array.from(decodeInt8(viaBtoa(a)))).toEqual(Array.from(a));
      expect(Array.from(decodeInt8(text))).toEqual(Array.from(a));
    });
  }
  it("decodes known RFC 4648 vectors", () => {
    const text = (s: string) => Array.from(decodeInt8(s), (v) => String.fromCharCode(v & 255)).join("");
    for (const [plain, b64] of [["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["foob", "Zm9vYg=="], ["fooba", "Zm9vYmE="], ["foobar", "Zm9vYmFy"]]) {
      expect(text(b64)).toBe(plain);
      expect(encodeInt8(Int8Array.from(plain, (c) => c.charCodeAt(0)))).toBe(b64);
    }
  });
  it("rejects what is not base64", () => {
    for (const bad of ["abc", "ab=c", "a===", "ab!d", "Zm9\u00e9"]) expect(() => decodeInt8(bad)).toThrow(/invalid base64/);
  });
  it("works in Live's host, where btoa and atob do not exist", () => {
    vi.stubGlobal("btoa", undefined);
    vi.stubGlobal("atob", undefined);
    try {
      expect(typeof globalThis.btoa).toBe("undefined");
      expect(typeof globalThis.atob).toBe("undefined");
      const a = Int8Array.from({ length: 1001 }, (_, i) => ((i * 13) % 256) - 128);
      const text = encodeInt8(a);
      expect(text).toBe(viaBtoa(a));
      expect(Array.from(decodeInt8(text))).toEqual(Array.from(a));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(typeof globalThis.btoa).toBe("function");
  });
});

describe("names and kinds", () => {
  it("writes pattern names", () => {
    expect(patternText({ pattern: 2, variant: true })).toBe("2′");
    expect(patternText({ pattern: 1, variant: false })).toBe("1");
    expect(patternText({ pattern: null, variant: false })).toBe("");
  });
  it("maps sources to kinds", () => {
    expect(sourceKind("mix")).toBe("mix");
    expect(sourceKind("drums")).toBe("drums");
    expect(sourceKind("vocals")).toBe("tonal");
    expect(PATTERN_SOURCES).toEqual(["mix", "drums", "bass", "vocals", "other"]);
  });
});

describe("isPatternFeatures", () => {
  it("accepts a 2-cell features object", () => {
    expect(isPatternFeatures(valid())).toBe(true);
  });
  it("survives a JSON round trip", () => {
    expect(isPatternFeatures(JSON.parse(JSON.stringify(valid())))).toBe(true);
  });
  const mutations: [string, (f: any) => void][] = [
    ["a wrong engine", (f) => (f.engine = "patterns-0")],
    ["rate 10", (f) => (f.rate = 10)],
    ["a grid gap", (f) => {
      f.durationSec = 0.2;
      f.grid = [{ start: 0, end: 0.1, unsure: false }, { start: 0.12, end: 0.2, unsure: false }];
    }],
    ["a grid ending before durationSec", (f) => (f.grid[0].end = 0.05)],
    ["a grid not starting at 0", (f) => (f.grid[0].start = 0.02)],
    ["data of the wrong length", (f) => (f.sources.mix.data = encodeInt8(new Int8Array(5)))],
    ["loud of the wrong length", (f) => (f.sources.mix.loud = encodeInt8(new Int8Array(3)))],
    ["data that is not base64", (f) => (f.sources.mix.data = "not base64!!")],
    ["an unknown source key", (f) => (f.sources.piano = cells("tonal", 2, 3))],
    ["a kind that does not match its source", (f) => (f.sources.drums.kind = "tonal")],
    ["a non-integer dims", (f) => (f.sources.mix.dims = 1.5)],
    ["a non-boolean unsure", (f) => (f.grid[0].unsure = 0)],
    ["a missing grid", (f) => delete f.grid],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects ${name}`, () => {
      const f = valid();
      mutate(f);
      expect(isPatternFeatures(f)).toBe(false);
    });
  }
  it("rejects non-objects", () => {
    for (const v of [null, undefined, 3, "x", []]) expect(isPatternFeatures(v)).toBe(false);
  });
});

describe("size (Review Focus 5)", () => {
  it("keeps a 30-minute, 5-source clip under 6 MB of JSON", () => {
    // base64 inflates 4/3, so 5 sources x (dims + 1 loudness) bytes x 20 cells/s x 1800 s must fit: dims <= 23.
    const dims = 20;
    const durationSec = 1800;
    const n = Math.ceil(durationSec * CELL_RATE);
    let seed = 12345;
    const random = (len: number) => Int8Array.from({ length: len }, () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24) - 128);
    const src = (kind: SourceCells["kind"]): SourceCells => ({ kind, dims, cells: n, data: encodeInt8(random(n * dims)), loud: encodeInt8(random(n)) });
    const f: PatternFeatures = {
      engine: PATTERN_ENGINE,
      rate: CELL_RATE,
      durationSec,
      grid: regularGrid(2, durationSec),
      sources: { mix: src("mix"), drums: src("drums"), bass: src("tonal"), vocals: src("tonal"), other: src("tonal") },
    };
    expect(JSON.stringify(f).length).toBeLessThan(6e6);
    expect(isPatternFeatures(JSON.parse(JSON.stringify(f)))).toBe(true);
  });
});

describe("PATTERN_ENGINE (final review I3)", () => {
  // A cached entry holds each source's cells, laid out as FEATURE_LAYOUT, and the corrected grid, which patternGrid
  // finds from the cells gated with REST_* and z-scored and weighted as similarity's zScoreCells does. An entry written
  // under other values must not be read: change any of these, and bump PATTERN_ENGINE with them (then update this).
  it("is bumped whenever what a cached entry means changes", () => {
    let seed = 99;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24) - 128;
    const zFingerprint = (kind: SourceCells["kind"]) => {
      const { dims } = FEATURE_LAYOUT[kind];
      const cells = 64;
      const src: DecodedSource = { kind, dims, cells, data: Int8Array.from({ length: cells * dims }, random), loudDb: new Int8Array(cells) };
      const z = zScoreCells(src, Uint8Array.from({ length: cells }, (_, i) => (i % 3 ? 1 : 0)));
      let [sum, abs, moment] = [0, 0, 0];
      z.forEach((v, i) => ([sum, abs, moment] = [sum + v, abs + Math.abs(v), moment + v * (i % 17)]));
      return [sum, abs, moment].map((v) => v.toFixed(3));
    };
    expect({
      engine: PATTERN_ENGINE,
      dims: { tonal: FEATURE_LAYOUT.tonal.dims, drums: FEATURE_LAYOUT.drums.dims, mix: FEATURE_LAYOUT.mix.dims },
      layout: FEATURE_LAYOUT,
      rest: [REST_BELOW_DB, REST_FLOOR_DB],
      weights: WEIGHTS,
      z: { tonal: zFingerprint("tonal"), drums: zFingerprint("drums"), mix: zFingerprint("mix") },
    }).toMatchInlineSnapshot(`
      {
        "dims": {
          "drums": 12,
          "mix": 20,
          "tonal": 19,
        },
        "engine": "patterns-1",
        "layout": {
          "drums": {
            "chroma": null,
            "dims": 12,
            "flux": {
              "at": 0,
              "n": 6,
            },
            "shape": {
              "at": 6,
              "n": 6,
            },
          },
          "mix": {
            "chroma": {
              "at": 0,
              "n": 12,
            },
            "dims": 20,
            "flux": {
              "at": 12,
              "n": 4,
            },
            "shape": {
              "at": 16,
              "n": 4,
            },
          },
          "tonal": {
            "chroma": {
              "at": 0,
              "n": 12,
            },
            "dims": 19,
            "flux": {
              "at": 18,
              "n": 1,
            },
            "shape": {
              "at": 12,
              "n": 6,
            },
          },
        },
        "rest": [
          27,
          -60,
        ],
        "weights": {
          "drums": {
            "chroma": 0,
            "flux": 1,
            "shape": 0.6,
          },
          "mix": {
            "chroma": 1,
            "flux": 1,
            "shape": 0.6,
          },
          "tonal": {
            "chroma": 1,
            "flux": 1.2,
            "shape": 0.6,
          },
        },
        "z": {
          "drums": [
            "-41.085",
            "543.875",
            "-337.167",
          ],
          "mix": [
            "28.687",
            "1019.228",
            "509.740",
          ],
          "tonal": [
            "-16.359",
            "921.590",
            "-272.711",
          ],
        },
      }
    `);
  });
});
