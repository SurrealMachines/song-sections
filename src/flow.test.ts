import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ClipInfo } from "./live/acquire.js";
import type { PreparedAudio } from "./audio/prepare.js";
import type { CueAnalysis } from "./analysis/cue.js";
import { assertValidSections, defaultDeps, isStructureAnalysis, runFind, type FlowDeps } from "./flow.js";
import { ArrangementApplyError } from "./live/execute.js";
import { SendError } from "./live/send.js";
import { abortError } from "./core/abort.js";
import { hostActivity } from "./core/pace.js";
import { cueBeatGrid } from "./core/beatGrid.js";
import { DEFAULT_STRUCTURE_PREFS, type DialogMode, type DialogPayload, type Harmony, type StructurePrefs } from "./dialog/protocol.js";
import { estimateStructureSec, STRUCTURE_ENGINE, type StructureAnalysis } from "./structure/contract.js";
import { fakeStructureAnalysis } from "./structure/fake.js";
import { MODEL_DISK_BYTES, MODEL_DOWNLOAD_BYTES, ModelsDiskSpaceError, ModelsUnavailableError } from "./structure/models.js";
import { DIALOG_GAP_MS, PAGE_WATCHDOG_MS, UPDATE_FLUSH_MS } from "./live/dialogPacing.js";
import { CELL_RATE, PATTERN_ENGINE, type PatternFeatures } from "./patterns/contract.js";

const DIALOG_HTML = "<html><!--PAYLOAD--></html>";
const UNDO_MSG = "Song Sections couldn't finish applying sections. Use Edit › Undo to restore the original.";

const SECTIONS = [
  { start: 0, end: 10, label: "1", color: 0xff0000 },
  { start: 10, end: 20, label: "2", color: 0x00ff00 },
];

function info(over: Partial<ClipInfo> = {}): ClipInfo {
  return {
    view: "arrangement",
    clip: { warpMarkers: [{}, {}, {}] },
    track: {},
    startTime: 8,
    lengthBeats: 40,
    startMarker: 0,
    endMarker: 40,
    warped: true,
    filePath: "/samples/a.wav",
    color: 0x123456,
    name: "Song",
    ...over,
  } as unknown as ClipInfo;
}

/** As the flow builds it, so with the host's own separators. */
const STEMS_DIR = join("/storage", "stems", "abc123");

const prepared: PreparedAudio = {
  analysis: new Float32Array(4),
  analysisRate: 11025,
  durationSec: 20,
  waveform: { min: [0], max: [0] },
  previewPath: "/temp/preview.wav",
  hash: "abc123",
};

const analysis: CueAnalysis = { novelty: [0, 1, 0], blocksPerSec: 2, boundaries: [10], engine: "cue-dsp-1" };

/** v2: what the fake harmony dep answers (a C major chord's pitch classes, or a D minor one's, for 20 s). */
const chordRows = (pcs: number[]) => Array.from({ length: 40 }, () => Array.from({ length: 12 }, (_, k) => (pcs.includes(k) ? 1 : 0)));
const MIX_HARMONY: Harmony = { source: "mix", rate: 2, chroma: chordRows([0, 4, 7]) };
const STEMS_HARMONY: Harmony = { source: "stems", rate: 2, chroma: chordRows([2, 5, 9]) };
/** Plan 5: what the fake patterns dep answers, told apart by whether stems were kept (a sure grid from the stems). */
const patternsOf = (unsure: boolean): PatternFeatures => ({ engine: PATTERN_ENGINE, rate: CELL_RATE, durationSec: 20, grid: [{ start: 0, end: 20, unsure }], sources: {} });
const MIX_PATTERNS = patternsOf(true);
const STEMS_PATTERNS = patternsOf(false);

interface FakeOpts {
  storage?: string | undefined;
  temp?: string | undefined;
  dialogResult?: string;
  abortDuring?: "acquire" | "analyse";
  cached?: CueAnalysis | null;
  info?: ClipInfo;
  /** Dialog results in order; after the last one, `dialogResult` (or cancel) repeats. */
  dialogResults?: string[];
  structureCached?: StructureAnalysis | null;
  /** The remembered Structure choices loadSettings returns (none when absent). */
  structurePrefs?: StructurePrefs;
  lastMode?: DialogMode;
  modelsInstalled?: boolean;
  durationSec?: number;
  abortStructure?: boolean;
  /** Whether auditionReady finds the stem folder (default: no folder). */
  stemsReady?: boolean;
  /** The prepared audio's hash (default abc123): another clip. */
  hash?: string;
  /** Shared with an earlier setup, so a second run sees its background analysis (fb2). */
  background?: FlowDeps["background"];
  activity?: FlowDeps["activity"];
  /** The Song's scale getters (v2): absent ones are undefined, as an older Live's. */
  scale?: { scaleMode: boolean; rootNote: number; scaleName: string };
  /** The remembered "Key in names" (v2); absent: never saved. */
  keyInNames?: boolean;
}

function setup(opts: FakeOpts = {}) {
  // One controller per progress dialog, as in Live: cancelling one dialog does not abort the next.
  let controller = new AbortController();
  const progress: Array<[string, number | undefined]> = [];
  const titles: string[] = [];
  const queue = [...(opts.dialogResults ?? [])];
  // The options of each served dialog; a modal dialog's page "mounts" (onReady) as soon as it opens.
  const served: Array<Parameters<FlowDeps["serveDialog"]>[0]> = [];
  const modal = vi.fn(async (url: string, _w: number, _h: number) => {
    if (url.startsWith("data:")) return "ok";
    served.at(-1)?.onReady?.();
    return queue.shift() ?? opts.dialogResult ?? JSON.stringify({ action: "cancel" });
  });
  const durationSec = opts.durationSec ?? prepared.durationSec;
  const structure = fakeStructureAnalysis(durationSec);
  const context = {
    environment: {
      storageDirectory: "storage" in opts ? opts.storage : "/storage",
      tempDirectory: "temp" in opts ? opts.temp : "/temp",
    },
    application: { song: { tempo: 120, ...opts.scale } },
    getObjectFromHandle: vi.fn(() => ({ fake: "clip" })),
    ui: {
      showModalDialog: modal,
      withinProgressDialog: vi.fn(
        async (text: string, _o: unknown, cb: (u: (t: string, p?: number) => Promise<void>, s: AbortSignal) => Promise<unknown>) => {
          titles.push(text);
          controller = new AbortController();
          return cb(async (t, p) => void progress.push([t, p]), controller.signal);
        },
      ),
    },
  };
  const page = { pageBytes: 2048, pageAt: null as number | null, readyAt: null as number | null, readyError: null as string | null };
  const server = { url: "http://127.0.0.1:1234/tok/", close: vi.fn(async () => undefined), status: vi.fn(() => ({ ...page })) };
  // A fake clock: sleep advances time at once; `after` timers fire only when a test calls fireTimers().
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const clock = {
    now: vi.fn(() => now),
    sleep: vi.fn(async (ms: number) => void (now += ms)),
    after: vi.fn((ms: number, fn: () => void) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    }),
  };
  const advance = (ms: number) => void (now += ms);
  const fireTimers = () => timers.filter((t) => t.live).forEach((t) => ((now = Math.max(now, t.at)), t.fn()));
  // removeFile really deletes (fb2 review C1): an analysis of a deleted render fails, as the real engine's decode would.
  const deleted = new Set<string>();
  const deps: FlowDeps = {
    dialogHtml: DIALOG_HTML,
    describeClip: vi.fn(() => opts.info ?? info()),
    acquireAudio: vi.fn(async (_c, _i, signal: AbortSignal) => {
      if (opts.abortDuring === "acquire") controller.abort();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      deleted.delete("/var/render.aif"); // a fresh render
      return "/var/render.aif";
    }),
    prepareAudio: vi.fn(async (_src: string, previewPath: string) => ({ ...prepared, durationSec, previewPath, hash: opts.hash ?? prepared.hash })),
    analyseCue: vi.fn(async (_p, signal: AbortSignal, onProgress: (f: number) => void) => {
      onProgress(0.5);
      if (opts.abortDuring === "analyse") controller.abort();
      if (signal.aborted) throw new DOMException("Analysis aborted", "AbortError");
      onProgress(1);
      return analysis;
    }),
    loadCached: vi.fn(async (_dir: string, _hash: string, engine: string) =>
      engine === STRUCTURE_ENGINE ? (opts.structureCached ?? null) : (opts.cached ?? null),
    ) as FlowDeps["loadCached"],
    saveCached: vi.fn(async () => undefined),
    serveDialog: vi.fn(async (o) => {
      served.push(o);
      return server;
    }),
    arrangementOps: vi.fn(() => [{ kind: "split", time: 1 }] as never),
    sessionOps: vi.fn(() => [{ kind: "scene", index: 1, name: "1" }] as never),
    executeArrangement: vi.fn(async () => undefined),
    executeSession: vi.fn(async () => undefined),
    executeSend: vi.fn(async () => ({ steps: 4, notes: [] })),
    removeFile: vi.fn(async (path: string) => void deleted.add(path)),
    logError: vi.fn(),
    log: vi.fn(),
    clock,
    analyseStructure: vi.fn(async (path, _env, signal, onProgress) => {
      if (deleted.has(path)) throw new Error(`ENOENT: the render was deleted: ${path}`);
      onProgress(0.1, "separating");
      onProgress(0.5, "features");
      if (opts.abortStructure) controller.abort();
      if (signal.aborted) throw abortError();
      onProgress(0.7, "structure");
      onProgress(0.9, "beats");
      return structure;
    }),
    // As the real one: installed models report all bytes done at once; missing ones download.
    ensureModels: vi.fn(async ({ onProgress }) => {
      if (!(opts.modelsInstalled ?? true)) onProgress(MODEL_DOWNLOAD_BYTES / 2, MODEL_DOWNLOAD_BYTES, "download");
      onProgress(MODEL_DOWNLOAD_BYTES, MODEL_DOWNLOAD_BYTES, "download");
      if (!(opts.modelsInstalled ?? true)) onProgress(MODEL_DISK_BYTES, MODEL_DISK_BYTES, "build");
      return "/storage/models/set";
    }),
    modelsInstalled: vi.fn(async () => opts.modelsInstalled ?? true),
    extensionRoot: vi.fn(() => "/ext"),
    assertStructurePlatform: vi.fn(() => undefined),
    loadSettings: vi.fn(async () => ({
      lastMode: opts.lastMode ?? "cue",
      ...(opts.structurePrefs ? { structure: opts.structurePrefs } : {}),
      ...(opts.keyInNames !== undefined ? { keyInNames: opts.keyInNames } : {}),
    })),
    harmony: vi.fn(async (req) => (req.source === "mix" ? MIX_HARMONY : STEMS_HARMONY)),
    patterns: vi.fn(async (req) => (req.stemsDir ? STEMS_PATTERNS : MIX_PATTERNS)),
    saveSettings: vi.fn(async () => undefined),
    auditionReady: vi.fn(async () => opts.stemsReady ?? false),
    touchAudition: vi.fn(async () => undefined),
    pruneAuditions: vi.fn(async () => []),
    background: opts.background ?? { current: null },
    // No quiet time, so a test sees exactly when work is in flight.
    activity: opts.activity ?? hostActivity({ quietMs: 0 }),
  };
  const run = () => runFind(context as never, "handle-1" as never, deps);
  const payloads = (): DialogPayload[] =>
    vi.mocked(deps.serveDialog).mock.calls.map(([o]) =>
      JSON.parse(o.html.match(/<script id="payload" type="application\/json">(.*)<\/script>/)![1]),
    );
  const messages = () =>
    modal.mock.calls
      .map(([url]) => url)
      .filter((u) => u.startsWith("data:"))
      .map((u) => decodeURIComponent(u.slice(u.indexOf(",") + 1)));
  const dialogCalls = () => modal.mock.calls.filter(([url]) => !url.startsWith("data:"));
  /** Cancels the progress dialog that is open now (Live's Cancel button). */
  const abortProgress = () => controller.abort();
  /** Waits for the background Structure analysis, if any, to end. */
  const settle = async () => void (await deps.background.current?.run.settled);
  return { context, deps, deleted, server, page, clock, advance, fireTimers, run, modal, messages, dialogCalls, progress, titles, payloads, structure, served, abortProgress, settle };
}

const apply = (output = "split") => JSON.stringify({ action: "apply", sections: SECTIONS, output });

describe("runFind", () => {
  it("fails fast with a message when storage or temp directory is missing", async () => {
    for (const missing of [{ storage: undefined }, { temp: undefined }]) {
      const f = setup(missing);
      await f.run();
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]).toMatch(/storage|temp/i);
      expect(f.context.ui.withinProgressDialog).not.toHaveBeenCalled();
      expect(f.deps.describeClip).not.toHaveBeenCalled();
      expect(f.deps.serveDialog).not.toHaveBeenCalled();
    }
  });

  it("runs the full arrangement flow and applies on Apply", async () => {
    // No models: the background Structure analysis (fb2) would keep the render until it settled.
    const f = setup({ modelsInstalled: false, dialogResult: apply("both") });
    await f.run();

    expect(f.context.getObjectFromHandle).toHaveBeenCalledWith("handle-1", expect.anything());
    expect(f.deps.prepareAudio).toHaveBeenCalledWith("/var/render.aif", expect.stringMatching(/^[\\/]temp[\\/].+\.wav$/));
    expect(f.deps.loadCached).toHaveBeenCalledWith("/storage", "abc123", "cue-dsp-1");
    expect(f.deps.saveCached).toHaveBeenCalledWith("/storage", "abc123", "cue-dsp-1", analysis);

    // Progress bands: 0 → 20 → 40 → 40..100.
    const pcts = f.progress.map(([, p]) => p);
    expect(pcts.slice(0, 3)).toEqual([0, 20, 40]);
    expect(pcts).toContain(70);
    expect(pcts.at(-1)).toBe(100);

    const served = vi.mocked(f.deps.serveDialog).mock.calls[0][0];
    expect(served.audioPath).toMatch(/^[\\/]temp[\\/].+\.wav$/);
    const json = served.html.match(/<script id="payload" type="application\/json">(.*)<\/script>/)![1];
    const payload = JSON.parse(json);
    expect(payload).toMatchObject({
      mode: "cue",
      view: "arrangement",
      clipName: "Song",
      durationSec: 20,
      audioUrl: "audio.wav",
      novelty: [0, 1, 0],
      blocksPerSec: 2,
      boundaries: [10],
      granularity: 0.5,
      colorMode: "gradient",
      sourceColor: 0x123456,
      output: "both", // Matt (Live, 4 Nov): the Arrangement output opens on Both
      warpNote: false, // Arrangement split is native and keeps the warp markers
    });

    expect(f.dialogCalls()).toEqual([[f.server.url, 1000, 560]]);
    expect(f.server.close).toHaveBeenCalledTimes(1);
    expect(f.deps.arrangementOps).toHaveBeenCalledWith(expect.anything(), SECTIONS, "both", 120, SECTIONS.map(() => "C"));
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
    expect(f.deps.executeSession).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([]);

    // Rendered AIFF and preview WAV are cleaned up.
    const removed = vi.mocked(f.deps.removeFile).mock.calls.map(([p]) => p);
    expect(removed).toContain("/var/render.aif");
    expect(removed).toContain(served.audioPath);
  });

  it("dispatches Session clips to executeSession", async () => {
    const f = setup({ dialogResult: apply(), info: info({ view: "session", sceneIndex: 2 }) });
    await f.run();
    expect(f.deps.sessionOps).toHaveBeenCalledWith(expect.anything(), SECTIONS, 120, SECTIONS.map(() => "C"));
    expect(f.deps.executeSession).toHaveBeenCalledTimes(1);
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
  });

  it("Live fix 5: Session gets the plain section names (sessionOps numbers the scenes), Arrangement keeps them", async () => {
    const dup = [
      { start: 0, end: 5, label: "B′ - inst", color: 1 },
      { start: 5, end: 10, label: "C - solo", color: 2 },
      { start: 10, end: 15, label: "B′ - inst", color: 1 },
      { start: 15, end: 20, label: "B′ - inst", color: 1 },
    ];
    const result = JSON.stringify({ action: "apply", sections: dup, output: "split" });
    const session = setup({ dialogResult: result, info: info({ view: "session", sceneIndex: 2 }) });
    await session.run();
    const names = vi.mocked(session.deps.sessionOps).mock.calls[0][1].map((x) => x.label);
    expect(names).toEqual(["B′ - inst", "C - solo", "B′ - inst", "B′ - inst"]); // feedback round 1: clips keep the label

    const arrangement = setup({ dialogResult: result });
    await arrangement.run();
    expect(vi.mocked(arrangement.deps.arrangementOps).mock.calls[0][1]).toEqual(dup);
  });

  it("sets warpNote for every warped Session clip (fb3: Live warps a new slice on its own grid)", async () => {
    for (const [over, expected] of [
      [{ view: "session", warped: true, clip: { warpMarkers: [{}, {}, {}] } }, true],
      [{ view: "session", warped: true, clip: { warpMarkers: [{}, {}] } }, true],
      [{ view: "session", warped: false, clip: { warpMarkers: [{}, {}, {}] } }, false],
      // Arrangement split is native (Cmd+E style): markers are kept, so never warn.
      [{ view: "arrangement", warped: true, clip: { warpMarkers: [{}, {}, {}, {}, {}] } }, false],
    ] as const) {
      const f = setup({ info: info(over as unknown as Partial<ClipInfo>) });
      await f.run();
      const html = vi.mocked(f.deps.serveDialog).mock.calls[0][0].html;
      expect(html).toContain(`"warpNote":${expected}`);
    }
  });

  it("skips analysis on a cache hit", async () => {
    // No models: the background Structure analysis (fb2) would save its own cache entry.
    const f = setup({ modelsInstalled: false, cached: analysis });
    await f.run();
    expect(f.deps.analyseCue).not.toHaveBeenCalled();
    expect(f.deps.saveCached).not.toHaveBeenCalled();
    expect(f.dialogCalls()).toHaveLength(1);
  });

  it("returns silently when cancelled during the progress stage", async () => {
    for (const abortDuring of ["acquire", "analyse"] as const) {
      const f = setup({ abortDuring, dialogResult: apply() });
      await f.run();
      expect(f.modal).not.toHaveBeenCalled();
      expect(f.deps.serveDialog).not.toHaveBeenCalled();
      expect(f.deps.executeArrangement).not.toHaveBeenCalled();
      expect(f.deps.saveCached).not.toHaveBeenCalled();
      expect(f.deps.logError).not.toHaveBeenCalled();
    }
  });

  it("does not apply when the dialog is cancelled", async () => {
    const f = setup({ dialogResult: JSON.stringify({ action: "cancel" }) });
    await f.run();
    expect(f.dialogCalls()).toHaveLength(1);
    expect(f.server.close).toHaveBeenCalledTimes(1);
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
    expect(f.deps.executeSession).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([]);
  });

  it("closes the server and cleans up when the dialog rejects", async () => {
    const f = setup();
    f.modal.mockImplementationOnce(async () => {
      throw new Error("Failed to create modal dialog");
    });
    await f.run();
    expect(f.server.close).toHaveBeenCalledTimes(1);
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
    expect(f.deps.logError).toHaveBeenCalled();
    expect(f.messages()).toHaveLength(1);
    expect(f.messages()[0]).not.toContain("Undo");
    expect(vi.mocked(f.deps.removeFile).mock.calls.map(([p]) => p)).toContain("/var/render.aif");
  });

  it("shows an error and leaves the set untouched when analysis fails", async () => {
    const f = setup();
    vi.mocked(f.deps.acquireAudio).mockRejectedValueOnce(new Error("render failed"));
    await f.run();
    expect(f.deps.logError).toHaveBeenCalled();
    expect(f.messages()).toHaveLength(1);
    expect(f.messages()[0]).not.toContain("Undo");
    expect(f.deps.serveDialog).not.toHaveBeenCalled();
  });

  it("still opens the dialog when saving the cache fails", async () => {
    const f = setup();
    vi.mocked(f.deps.saveCached).mockRejectedValueOnce(new Error("disk full"));
    await f.run();
    expect(f.dialogCalls()).toHaveLength(1);
    expect(f.messages()).toEqual([]);
  });

  it("shows the undo message when applying throws", async () => {
    const f = setup({ dialogResult: apply() });
    vi.mocked(f.deps.executeArrangement).mockRejectedValueOnce(new Error("boom"));
    await f.run();
    expect(f.deps.logError).toHaveBeenCalled();
    expect(f.messages()).toHaveLength(1);
    expect(f.messages()[0]).toContain(UNDO_MSG);
  });

  describe("Arrangement apply failures report the completed changes", () => {
    const fail = async (cuts: number, cues: number) => {
      const f = setup({ dialogResult: apply() });
      vi.mocked(f.deps.executeArrangement).mockRejectedValueOnce(new ArrangementApplyError("boom", cuts, cues));
      await f.run();
      return f.messages();
    };

    it("nothing cut yet: the Set is unchanged, so no Undo advice", async () => {
      const msgs = await fail(0, 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain("Song Sections ran into a problem. Your Set was not changed.");
      expect(msgs[0]).not.toContain("Undo");
    });

    it("tells the user how many Undo steps restore the original", async () => {
      const text = (n: string) => `Song Sections couldn't finish applying sections. Use Edit › Undo ${n} to restore the original.`;
      expect((await fail(5, 0))[0]).toContain(text("5 times"));
      expect((await fail(2, 3))[0]).toContain(text("5 times"));
      expect((await fail(1, 0))[0]).toContain(text("once"));
    });
  });

  it("rejects invalid sections from the dialog before touching the Set", async () => {
    const bad: unknown[][] = [
      [],
      [{ start: -1, end: 20, label: "1", color: 0 }],
      [{ start: 0, end: 25, label: "1", color: 0 }],
      [{ start: 5, end: 5, label: "1", color: 0 }],
      [SECTIONS[1], SECTIONS[0]],
      [{ ...SECTIONS[0], end: 12 }, SECTIONS[1]],
      [SECTIONS[0], { ...SECTIONS[1], start: 11 }],
    ];
    for (const sections of bad) {
      for (const [output, view] of [["split", "arrangement"], ["split", "session"]] as const) {
        const f = setup({
          dialogResult: JSON.stringify({ action: "apply", sections, output }),
          info: info({ view }),
        });
        await f.run();
        expect(f.deps.executeArrangement).not.toHaveBeenCalled();
        expect(f.deps.executeSession).not.toHaveBeenCalled();
        expect(f.deps.arrangementOps).not.toHaveBeenCalled();
        expect(f.deps.logError).toHaveBeenCalled();
        expect(f.messages()).toHaveLength(1);
        expect(f.messages()[0]).toContain("Song Sections ran into a problem. Your Set was not changed.");
      }
    }
  });

  it("assertValidSections rejects non-finite values (unreachable via JSON, which turns them into null)", () => {
    expect(() => assertValidSections([{ start: 0, end: Number.NaN, label: "1", color: 0 }], 20)).toThrow(/finite/);
    expect(() => assertValidSections([{ start: 0, end: Infinity, label: "1", color: 0 }], 20)).toThrow(/finite/);
    expect(() => assertValidSections(SECTIONS, 20)).not.toThrow();
  });

  it("accepts sections ending within a millisecond of the clip end", async () => {
    const f = setup({
      dialogResult: JSON.stringify({ action: "apply", sections: [SECTIONS[0], { ...SECTIONS[1], end: 20.0005 }], output: "split" }),
    });
    await f.run();
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
  });
});

const SWITCH = (mode: DialogMode) => JSON.stringify({ action: "switch", mode });
/** fb/hfmodels: the Structure tab's Download (the user agreed to download the models), as the dialog sends it. */
const DOWNLOAD = JSON.stringify({ action: "switch", mode: "structure", download: true });
const CANCEL = JSON.stringify({ action: "cancel" });
const MODELS_MSG = "Structure analysis needs its models, which are not installed yet.";
const PLATFORM_MSG = "Structure needs an Apple Silicon Mac (or Windows x64, later)";

/** What Plan 3 Task 1's runtime.ts throws; built here so this test does not depend on that branch. */
function platformError(): Error {
  const e = new Error(PLATFORM_MSG);
  e.name = "OrtUnsupportedPlatformError";
  return e;
}

const modesOf = (p: DialogPayload) => p.modes.structure;
const structureSaves = (deps: FlowDeps) => vi.mocked(deps.saveCached).mock.calls.filter(([, , engine]) => engine === STRUCTURE_ENGINE);

describe("runFind: Cue and Structure modes", () => {
  it("Cue → switch → Structure renders once, analyses Structure once, caches it and reopens at 1000 × 680", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, CANCEL] });
    await f.run();

    expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
    expect(f.deps.prepareAudio).toHaveBeenCalledTimes(1);
    expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.ensureModels).mock.calls[0][0]).toMatchObject({ storageDir: "/storage" });
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.analyseStructure).mock.calls[0].slice(0, 2)).toEqual([
      "/var/render.aif",
      { modelDir: "/storage/models/set", tempDir: "/temp", storageDir: "/storage", extensionRoot: "/ext", auditionStemsDir: STEMS_DIR },
    ]);
    expect(structureSaves(f.deps)).toEqual([["/storage", "abc123", STRUCTURE_ENGINE, f.structure]]);

    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(f.progress).toEqual(
      expect.arrayContaining([
        ["Downloading analysis models… 48 of 95 MB", 50],
        ["Downloading analysis models… 95 of 95 MB", 100],
        ["Preparing analysis models…", 100],
        // Live fix 7: numbered stages, as in the dev command, with the first-run hint.
        ["1/4 Separating stems… (results are cached for next time)", 10],
        ["2/4 Extracting features… (results are cached for next time)", 50],
        ["3/4 Finding sections… (results are cached for next time)", 70],
        ["4/4 Tracking beats… (results are cached for next time)", 90],
      ]),
    );

    expect(f.dialogCalls().map(([, w, h]) => [w, h])).toEqual([[1000, 560], [1000, 680]]);
    const [cue, structure] = f.payloads();
    expect(cue.mode).toBe("cue");
    expect(structure).toMatchObject({
      mode: "structure",
      view: "arrangement",
      clipName: "Song",
      durationSec: 20,
      audioUrl: "audio.wav",
      sourceColor: 0x123456,
      output: "both",
      warpNote: false,
      sliceBy: "sections",
      patternLevel: 4,
      colorMode: "soft",
      snap: true,
    });
    expect(structure.mode === "structure" && structure.analysis).toEqual(f.structure);
    expect(modesOf(structure).cached).toBe(true);

    // A fresh server per dialog; temp files deleted once, at the end.
    expect(f.server.close).toHaveBeenCalledTimes(2);
    const removed = vi.mocked(f.deps.removeFile).mock.calls.map(([p]) => p);
    expect(removed.filter((p) => p === "/var/render.aif")).toHaveLength(1);
    expect(f.messages()).toEqual([]);
  });

  it("feedback round 1: the Structure payload carries Live's 4/4 bar grid, and none for an unwarped Session clip", async () => {
    const arrangement = setup({ dialogResults: [SWITCH("structure"), CANCEL] }); // startTime 8 at 120 bpm: bar lines every 2 s from 0
    await arrangement.run();
    expect(arrangement.payloads()[1]).toMatchObject({ mode: "structure", snapTarget: "bars", barGrid: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20] });

    const unwarped = setup({ dialogResults: [SWITCH("structure"), CANCEL], info: info({ view: "session", sceneIndex: 0, warped: false }) });
    await unwarped.run();
    expect(unwarped.payloads()[1]).toMatchObject({ mode: "structure", barGrid: null });
  });

  it("Cue → Structure → Cue → Structure analyses Structure once and Cue once (kept in memory)", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), SWITCH("cue"), SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "cue", "structure"]);
    expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(1);
  });

  it("a Structure cache hit opens Cue (fb2), and a switch opens Structure at once without analysing", async () => {
    const cached = fakeStructureAnalysis(20);
    const f = setup({ structureCached: cached, modelsInstalled: false, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.deps.loadCached).toHaveBeenCalledWith("/storage", "abc123", STRUCTURE_ENGINE);
    const [cue, p] = f.payloads();
    expect(modesOf(cue)).toMatchObject({ cached: true, needsDownload: false });
    expect(p.mode).toBe("structure");
    expect(p.mode === "structure" && p.analysis).toEqual(cached);
    expect(modesOf(p)).toMatchObject({ cached: true, needsDownload: false });
    expect(f.dialogCalls()).toEqual([[f.server.url, 1000, 560], [f.server.url, 1000, 680]]);
    expect(f.titles).toEqual(["Finding sections…"]);
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.deps.ensureModels).not.toHaveBeenCalled();
    expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
  });

  // Feedback round 2 B: stem audition.
  const STEM_URLS = { drums: "stems/drums.wav", bass: "stems/bass.wav", vocals: "stems/vocals.wav", other: "stems/other.wav" };
  const serveCalls = (deps: FlowDeps) => vi.mocked(deps.serveDialog).mock.calls.map(([o]) => o.stemsDir);

  it("stem audition: a fresh analysis keeps the stems under <storage>/stems/<key>, prunes the others, and serves them", async () => {
    const f = setup({ stemsReady: true, dialogResults: [SWITCH("structure"), SWITCH("cue"), CANCEL] });
    await f.run();
    expect(vi.mocked(f.deps.analyseStructure).mock.calls[0][1].auditionStemsDir).toBe(STEMS_DIR);
    expect(f.deps.pruneAuditions).toHaveBeenCalledWith("/storage", "abc123");
    // Pruned after the analysis was saved, so the folder in use is the newest.
    const saves = vi.mocked(f.deps.saveCached).mock;
    const structureSave = saves.invocationCallOrder[saves.calls.findIndex(([, , engine]) => engine === STRUCTURE_ENGINE)];
    expect(vi.mocked(f.deps.pruneAuditions).mock.invocationCallOrder[0]).toBeGreaterThan(structureSave);
    const [, structure, cue] = f.payloads();
    expect(structure).toMatchObject({ mode: "structure", stemUrls: STEM_URLS });
    expect(cue).not.toHaveProperty("stemUrls");
    expect(serveCalls(f.deps)).toEqual([null, STEMS_DIR, null]); // the Cue dialog serves no stems
  });

  it("stem audition: a cache hit whose folder is there touches it (LRU) and serves it", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.deps.auditionReady).toHaveBeenCalledWith(STEMS_DIR);
    expect(f.deps.touchAudition).toHaveBeenCalledWith(STEMS_DIR);
    expect(f.payloads()[1]).toMatchObject({ mode: "structure", stemUrls: STEM_URLS });
    expect(serveCalls(f.deps)).toEqual([null, STEMS_DIR]);
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
  });

  it("stem audition: a cache hit with no folder (evicted, or analysed before this build) has stemUrls null and no re-analysis", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: false, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.payloads()[1]).toMatchObject({ mode: "structure", stemUrls: null });
    expect(serveCalls(f.deps)).toEqual([null, null]);
    expect(f.deps.touchAudition).not.toHaveBeenCalled();
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
  });

  it("stem audition: a failing stem check or prune only logs; the dialog opens without stems", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.auditionReady).mockRejectedValue(new Error("EIO"));
    vi.mocked(f.deps.pruneAuditions).mockRejectedValue(new Error("EACCES"));
    await f.run();
    expect(f.payloads()[1]).toMatchObject({ mode: "structure", stemUrls: null });
    expect(f.messages()).toEqual([]);
    expect(vi.mocked(f.deps.logError).mock.calls.flat().join(" ")).toMatch(/EACCES/);
  });

  // fb2 controller ruling: Re-analyze, offered when a cached analysis kept no stems.
  const REANALYSE = (prefs?: StructurePrefs) => JSON.stringify({ action: "reanalyse", ...(prefs ? { prefs } : {}) });
  const PREFS2: StructurePrefs = { sliceBy: "bass", patternLevel: 3, colorMode: "soft", snap: false, snapTarget: "bars", granularity: 0.7, groupDist: 0.2, showStems: true };

  it("Re-analyze analyses again under the progress dialog with the stems kept, and reopens Structure with the dialog's choices", async () => {
    const old = { ...fakeStructureAnalysis(20), bpm: 101 }; // told apart from the new analysis
    const f = setup({ structureCached: old, dialogResults: [SWITCH("structure"), REANALYSE(PREFS2), CANCEL] });
    vi.mocked(f.deps.auditionReady).mockResolvedValueOnce(false).mockResolvedValue(true); // none on the hit; kept now
    await f.run();
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    // The old entry is not removed first: the new analysis replaces it in one save (fb2 review M2).
    expect("removeCached" in f.deps).toBe(false);
    expect(vi.mocked(f.deps.analyseStructure).mock.calls[0][1].auditionStemsDir).toBe(STEMS_DIR);
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(structureSaves(f.deps)).toEqual([["/storage", "abc123", STRUCTURE_ENGINE, f.structure]]);
    const [, before, after] = f.payloads();
    expect(before).toMatchObject({ mode: "structure", stemUrls: null });
    expect(before.mode === "structure" && before.analysis).toEqual(old);
    expect(after).toMatchObject({ mode: "structure", stemUrls: STEM_URLS, ...PREFS2 });
    expect(after.mode === "structure" && after.analysis).toEqual(f.structure);
    expect(serveCalls(f.deps)).toEqual([null, null, STEMS_DIR]);
    expect(f.deps.pruneAuditions).toHaveBeenCalledWith("/storage", "abc123");
    // The choices are kept for the reopened dialog, but only an Apply saves them.
    expect(f.deps.saveSettings).not.toHaveBeenCalled();
    expect(f.dialogCalls().map(([, w, h]) => [w, h])).toEqual([[1000, 560], [1000, 680], [1000, 680]]);
  });

  it("Re-analyze then Apply applies from the new analysis and saves the choices", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), dialogResults: [SWITCH("structure"), REANALYSE(PREFS2), JSON.stringify({ action: "apply", sections: SECTIONS, output: "split", prefs: PREFS2 })] });
    await f.run();
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "structure", structure: PREFS2 }]]);
  });

  it("a cancelled Re-analyze puts the old analysis back, cached again, and reopens Structure with it", async () => {
    const old = { ...fakeStructureAnalysis(20), bpm: 101 }; // told apart from the new analysis
    const f = setup({ structureCached: old, abortStructure: true, dialogResults: [SWITCH("structure"), REANALYSE(PREFS2), CANCEL] });
    await f.run();
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(structureSaves(f.deps)).toEqual([["/storage", "abc123", STRUCTURE_ENGINE, old]]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "structure"]);
    const after = f.payloads()[2];
    expect(after.mode === "structure" && after.analysis).toEqual(old);
    expect(after).toMatchObject({ stemUrls: null, ...PREFS2 });
    expect(modesOf(after)).toMatchObject({ available: true, cached: true });
    expect(f.messages()).toEqual([]);
  });

  it("a failed Re-analyze says so, puts the old analysis back, and reopens Structure (no loop of attempts)", async () => {
    const old = { ...fakeStructureAnalysis(20), bpm: 101 }; // told apart from the new analysis
    const f = setup({ structureCached: old, dialogResults: [SWITCH("structure"), REANALYSE(), CANCEL] });
    vi.mocked(f.deps.analyseStructure).mockRejectedValueOnce(new Error("onnx exploded"));
    await f.run();
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.messages()).toEqual([expect.stringContaining("couldn't analyze the structure")]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "structure"]);
    const after = f.payloads()[2];
    expect(after.mode === "structure" && after.analysis).toEqual(old);
    expect(structureSaves(f.deps)).toEqual([["/storage", "abc123", STRUCTURE_ENGINE, old]]);
  });

  it("a model download that fails during Re-analyze says why, then reopens Structure with the old analysis (fb2 review M3)", async () => {
    const old = { ...fakeStructureAnalysis(20), bpm: 101 };
    const f = setup({ structureCached: old, dialogResults: [SWITCH("structure"), REANALYSE(), CANCEL] });
    vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    await f.run();
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.stringContaining("Downloading the analysis models failed")]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "structure"]);
    const after = f.payloads()[2];
    expect(after.mode === "structure" && after.analysis).toEqual(old);
    expect(modesOf(after)).toMatchObject({ available: true, cached: true });
  });

  it("Re-analyze from Cue does nothing but reopen the dialog", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [REANALYSE(), CANCEL] }); // no models: nothing in the background
    await f.run();
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
  });

  it("ignores a Structure cache entry that is not a valid analysis", async () => {
    const bad = { ...fakeStructureAnalysis(20), frames: 3 };
    const f = setup({ structureCached: bad });
    await f.run();
    expect(f.payloads()[0].mode).toBe("cue");
    expect(modesOf(f.payloads()[0]).cached).toBe(false);
  });

  it("Review Focus 5: cancelling Structure analysis after a switch reopens Cue at its defaults, with no second render", async () => {
    // No models: the switch analyses in the foreground (a background run would not be cancelled by the dialog).
    const f = setup({ modelsInstalled: false, abortStructure: true, dialogResults: [DOWNLOAD, CANCEL] });
    await f.run();
    const [first, second] = f.payloads();
    expect(f.payloads()).toHaveLength(2);
    expect(second).toEqual(first);
    expect(f.dialogCalls().map(([, w, h]) => [w, h])).toEqual([[1000, 560], [1000, 560]]);
    expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
    expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
    expect(structureSaves(f.deps)).toEqual([]);
    expect(f.messages()).toEqual([]);
    expect(f.deps.logError).not.toHaveBeenCalled();
  });

  // fb/hfmodels: nothing downloads until the user agrees.
  /** Answers the flow's own consent dialog (a data: page naming Hugging Face) with `answer`. */
  const answerConsent = (f: ReturnType<typeof setup>, answer: string) => {
    const shown = f.modal.getMockImplementation()!;
    f.modal.mockImplementation(async (url: string, w: number, h: number) =>
      url.startsWith("data:") && decodeURIComponent(url).includes("Hugging Face") ? answer : shown(url, w, h),
    );
  };
  const consents = (f: ReturnType<typeof setup>) => f.messages().filter((m) => m.includes("Hugging Face"));

  it("the Structure tab's Download downloads without asking again", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, CANCEL] });
    await f.run();
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(1);
    expect(consents(f)).toEqual([]);
  });

  it("a switch without the Download asks first, and Not now downloads nothing and reopens Cue", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [SWITCH("structure"), CANCEL] });
    answerConsent(f, "cancel");
    await f.run();
    expect(consents(f)).toHaveLength(1);
    expect(consents(f)[0]).toContain("allin1 by Taejun Kim (MIT licence) and HT Demucs by Meta (Alexandre Défossez)");
    expect(consents(f)[0]).toContain("about 95 MB");
    expect(consents(f)[0]).toContain("about 190 MB on disk");
    expect(consents(f)[0]).not.toMatch(/https?:|<a /); // no links
    expect(f.deps.ensureModels).not.toHaveBeenCalled();
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
  });

  it("a switch without the Download asks first, and Download goes ahead", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [SWITCH("structure"), CANCEL] });
    answerConsent(f, "download");
    await f.run();
    expect(consents(f)).toHaveLength(1);
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(1);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure"]);
  });

  it("asks nothing when the models are installed", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(consents(f)).toEqual([]);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
  });

  it("Re-analyze with the models gone asks first; Not now keeps the cached analysis and downloads nothing", async () => {
    const old = fakeStructureAnalysis(20);
    const f = setup({ structureCached: old, modelsInstalled: false, dialogResults: [SWITCH("structure"), JSON.stringify({ action: "reanalyse" }), CANCEL] });
    answerConsent(f, "cancel");
    await f.run();
    expect(consents(f)).toHaveLength(1);
    expect(f.deps.ensureModels).not.toHaveBeenCalled();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "structure"]);
    const after = f.payloads()[2];
    expect(after.mode === "structure" && after.analysis).toEqual(old);
  });

  it("missing models on a switch show the message, log the install command and reopen Cue", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(new ModelsUnavailableError("no models"));
    await f.run();
    expect(f.messages()).toEqual([expect.stringContaining(MODELS_MSG)]);
    expect(vi.mocked(f.deps.logError).mock.calls.flat().join(" ")).toContain("run npm run models:dev -- <checkpoint dir>");
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
  });

  it("cancelling the opening dialog when the last mode was Structure returns silently and starts nothing in the background", async () => {
    const f = setup({ lastMode: "structure", abortStructure: true, abortDuring: "analyse" });
    await f.run();
    expect(f.messages()).toEqual([]);
    expect(f.dialogCalls()).toEqual([]);
    expect(f.deps.logError).not.toHaveBeenCalled();
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.deps.background.current).toBeNull();
    expect(vi.mocked(f.deps.removeFile).mock.calls.map(([p]) => p)).toContain("/var/render.aif");
  });

  it("Task 5 I1 (P2): a switch whose Structure analysis is cancelled does not save lastMode", async () => {
    const f = setup({ modelsInstalled: false, abortStructure: true, dialogResults: [DOWNLOAD, CANCEL] }); // foreground, as above
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
    expect(vi.mocked(f.deps.saveSettings).mock.calls.map(([, s]) => s.lastMode)).not.toContain("structure");
  });

  it("a switch whose Structure analysis fails does not save lastMode", async () => {
    for (const error of [new Error("ORT session failed"), new ModelsUnavailableError("no models"), new Error("Model download failed: 503 x")]) {
      const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
      vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(error);
      await f.run();
      expect(vi.mocked(f.deps.saveSettings).mock.calls.map(([, s]) => s.lastMode), error.message).not.toContain("structure");
    }
  });

  it("switching modes does not save lastMode; Cancel leaves the settings unchanged", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), SWITCH("cue"), SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "cue", "structure"]);
    expect(f.deps.saveSettings).not.toHaveBeenCalled();
  });

  it("cancelling Cue when the last mode was Structure does not flip lastMode to cue", async () => {
    const f = setup({ lastMode: "structure", abortStructure: true, dialogResults: [CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue"]);
    expect(f.deps.saveSettings).not.toHaveBeenCalled();
  });

  it("Apply saves the mode that was applied, only when it differs from the saved one", async () => {
    const fromCue = setup({ lastMode: "structure", dialogResults: [apply()] });
    await fromCue.run();
    expect(vi.mocked(fromCue.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "cue" }]]);

    const unchanged = setup({ dialogResults: [SWITCH("structure"), SWITCH("cue"), apply()] });
    await unchanged.run();
    expect(unchanged.deps.saveSettings).not.toHaveBeenCalled();
    expect(unchanged.deps.executeArrangement).toHaveBeenCalledTimes(1);
  });

  it("a mode saved on Apply is saved before the Set is changed", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), apply()] });
    await f.run();
    const save = vi.mocked(f.deps.saveSettings).mock.invocationCallOrder[0];
    const exec = vi.mocked(f.deps.executeArrangement).mock.invocationCallOrder[0];
    expect(save).toBeLessThan(exec);
  });

  it("does not save lastMode when the dialog failed to open", async () => {
    const f = setup({ dialogResults: [SWITCH("structure")] });
    let n = 0;
    f.modal.mockImplementation(async (url: string) => {
      if (url.startsWith("data:")) return "ok";
      if (n++ === 0) return SWITCH("structure");
      throw new Error("Failed to create modal dialog");
    });
    await f.run();
    expect(vi.mocked(f.deps.saveSettings).mock.calls.map(([, s]) => s.lastMode)).not.toContain("structure");
  });

  it("a failing Structure availability check does not take Cue down", async () => {
    const throwsModels = setup({ dialogResults: [apply()] });
    vi.mocked(throwsModels.deps.modelsInstalled).mockRejectedValueOnce(new Error("EACCES"));
    const throwsPlatform = setup({ dialogResults: [apply()] });
    vi.mocked(throwsPlatform.deps.assertStructurePlatform).mockImplementation(() => {
      throw new Error("dlopen failed");
    });
    for (const f of [throwsModels, throwsPlatform]) {
      await f.run();
      expect(f.payloads().map((p) => p.mode)).toEqual(["cue"]);
      expect(modesOf(f.payloads()[0]).available).toBe(false);
      expect(modesOf(f.payloads()[0]).reason).toBeTruthy();
      expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
      expect(f.deps.logError).toHaveBeenCalled();
    }
  });

  it("an engine failure after a switch is logged and shown, and Cue reopens", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.analyseStructure).mockRejectedValueOnce(new Error("ORT exploded"));
    await f.run();
    expect(f.deps.logError).toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.stringContaining("Your Set was not changed.")]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
  });

  it("feedback round 2: logs one line per Apply, counting renames and boundary changes against the opening, before the Set changes", async () => {
    // The Cue payload opens with one boundary at 10 s and labels Cue 1, Cue 2; SECTIONS has the boundary at 10 s too.
    const renamed = [{ ...SECTIONS[0], label: "Cue 1" }, { ...SECTIONS[1], label: "Hook" }];
    const f = setup({ dialogResult: JSON.stringify({ action: "apply", sections: renamed, output: "locators" }) });
    vi.mocked(f.deps.executeArrangement).mockImplementation(async () => {
      expect(vi.mocked(f.deps.log).mock.calls.flat().filter((l) => String(l).includes("Apply"))).toHaveLength(1);
    });
    await f.run();
    const lines = vi.mocked(f.deps.log).mock.calls.map(([l]) => String(l)).filter((l) => l.includes("Apply"));
    expect(lines).toEqual(["Song Sections: Apply cue (locators): 2 sections, 1 renamed, boundaries 0 new or moved, 0 gone vs the opening"]);
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
  });

  it("Apply from Structure saves the mode and passes the dialog's sections to executeArrangement", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), apply("both")] });
    await f.run();
    expect(f.deps.arrangementOps).toHaveBeenCalledWith(expect.anything(), SECTIONS, "both", 120, SECTIONS.map(() => "C"));
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "structure" }]]);
  });

  describe("remembered Structure choices (feedback round 1)", () => {
    const PREFS: StructurePrefs = { sliceBy: "other", patternLevel: 2, colorMode: "soft", snap: false, snapTarget: "bars", granularity: 0.4, groupDist: 0.3, showStems: true };
    const withPrefs = (r: string, prefs: StructurePrefs) => JSON.stringify({ ...JSON.parse(r), prefs });

    it("opens Structure with the saved choices, or the defaults when none were saved", async () => {
      const saved = setup({ lastMode: "structure", structurePrefs: PREFS, dialogResults: [SWITCH("structure"), CANCEL] });
      await saved.run();
      expect(saved.payloads()[1]).toMatchObject({ mode: "structure", ...PREFS });
      const fresh = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
      await fresh.run();
      expect(fresh.payloads()[1]).toMatchObject({ mode: "structure", ...DEFAULT_STRUCTURE_PREFS });
    });

    it("Apply saves the dialog's choices with the mode", async () => {
      const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), withPrefs(apply(), PREFS)] });
      await f.run();
      expect(vi.mocked(f.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "structure", structure: PREFS }]]);
    });

    it("does not save when neither the mode nor the choices changed", async () => {
      const f = setup({ lastMode: "structure", structurePrefs: PREFS, dialogResults: [SWITCH("structure"), withPrefs(apply(), { ...PREFS })] });
      await f.run();
      expect(f.deps.saveSettings).not.toHaveBeenCalled();
    });

    it("a Cue Apply after a switch saves only the mode, not Structure choices that were never applied (review M1)", async () => {
      const fresh = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), withPrefs(SWITCH("cue"), PREFS), apply()] });
      await fresh.run();
      expect(fresh.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "cue"]);
      expect(vi.mocked(fresh.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "cue" }]]);
      // With choices saved before, they stay as saved.
      const OLD: StructurePrefs = { ...PREFS, sliceBy: "sections", patternLevel: 1, granularity: 0 };
      const saved = setup({ lastMode: "structure", structurePrefs: OLD, dialogResults: [SWITCH("structure"), withPrefs(SWITCH("cue"), PREFS), apply()] });
      await saved.run();
      expect(vi.mocked(saved.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "cue", structure: OLD }]]);
    });

    it("the choices a switch carried are saved by a later Structure Apply", async () => {
      const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), withPrefs(SWITCH("cue"), PREFS), SWITCH("structure"), withPrefs(apply(), PREFS)] });
      await f.run();
      expect(vi.mocked(f.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "structure", structure: PREFS }]]);
    });

    it("keeps the choices across a switch within the run, but Cancel saves nothing", async () => {
      const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), withPrefs(SWITCH("cue"), PREFS), SWITCH("structure"), CANCEL] });
      await f.run();
      expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "cue", "structure"]);
      expect(f.payloads()[3]).toMatchObject(PREFS);
      expect(f.deps.saveSettings).not.toHaveBeenCalled();
    });
  });

  it("Apply from Structure validates the sections first", async () => {
    const f = setup({
      dialogResults: [SWITCH("structure"), JSON.stringify({ action: "apply", sections: [], output: "split" })],
    });
    await f.run();
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.stringContaining("Your Set was not changed.")]);
  });

  it("a failed lastMode save on Apply is logged, not fatal: the Set is still changed", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), apply()] });
    vi.mocked(f.deps.saveSettings).mockRejectedValueOnce(new Error("read-only"));
    await f.run();
    expect(vi.mocked(f.deps.saveSettings).mock.calls.map(([, s]) => s.lastMode)).toEqual(["structure"]);
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
    expect(f.deps.logError).toHaveBeenCalled();
    expect(f.messages()).toEqual([]);
  });

  it("a cancelled dialog does not save lastMode", async () => {
    const f = setup();
    await f.run();
    expect(f.deps.saveSettings).not.toHaveBeenCalled();
  });

  it("builds modes.structure from the duration, the cache and the model store", async () => {
    const f = setup({ durationSec: 700, modelsInstalled: false });
    await f.run();
    expect(modesOf(f.payloads()[0])).toEqual({
      available: true,
      reason: null,
      cached: false,
      needsDownload: true,
      downloadBytes: MODEL_DOWNLOAD_BYTES,
      diskBytes: MODEL_DISK_BYTES,
      estimateSec: estimateStructureSec(700),
      warn: true,
      retryable: false,
      suggested: false,
      background: false,
    });
    expect(f.deps.modelsInstalled).toHaveBeenCalledWith("/storage");
  });

  it("a clip longer than STRUCTURE_MAX_SEC makes Structure unavailable with the exact reason", async () => {
    const f = setup({ durationSec: 1900, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(modesOf(f.payloads()[0])).toMatchObject({
      available: false,
      reason: "Structure works on clips up to 30 minutes. Use Cue points for longer recordings.",
    });
    // A switch to an unavailable Structure is refused: Cue reopens and nothing is analysed.
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
    expect(f.deps.ensureModels).not.toHaveBeenCalled();
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
  });

  it("an unsupported platform shows Structure as unavailable with the platform error's message; Cue works", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), apply()] });
    vi.mocked(f.deps.assertStructurePlatform).mockImplementation(() => {
      throw platformError();
    });
    await f.run();
    expect(modesOf(f.payloads()[0])).toMatchObject({ available: false, reason: PLATFORM_MSG });
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
  });

  it("an unsupported platform found by the engine marks Structure unavailable and reopens Cue", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.analyseStructure).mockRejectedValueOnce(platformError());
    await f.run();
    const [, again] = f.payloads();
    expect(again.mode).toBe("cue");
    expect(modesOf(again)).toMatchObject({ available: false, reason: PLATFORM_MSG });
    expect(f.messages()).toEqual([expect.stringContaining(PLATFORM_MSG)]);
  });

  it("an unsupported platform found by the background analysis shows only on a switch, then Structure is unavailable", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(platformError());
    finishWhileOpen(f);
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
    expect(modesOf(f.payloads()[0])).toMatchObject({ available: true });
    expect(modesOf(f.payloads()[1])).toMatchObject({ available: false, reason: PLATFORM_MSG });
    expect(f.messages()).toEqual([expect.stringContaining(PLATFORM_MSG)]);
  });

  it("returns after 20 dialogs of switching", async () => {
    const f = setup();
    let last: DialogMode = "cue";
    vi.mocked(f.deps.serveDialog).mockImplementation(async ({ html }) => {
      last = html.includes('"mode":"structure"') ? "structure" : "cue";
      return f.server;
    });
    f.modal.mockImplementation(async (url: string) => (url.startsWith("data:") ? "ok" : SWITCH(last === "cue" ? "structure" : "cue")));
    await f.run();
    expect(f.dialogCalls()).toHaveLength(20);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
  });

  it("Cue gets the beat grid: Arrangement and warped Session snap, unwarped Session does not", async () => {
    for (const [over, snap] of [
      [{ view: "arrangement", warped: false, startTime: 8 }, true],
      [{ view: "session", warped: true, startTime: 0, startMarker: 2 }, true],
      [{ view: "session", warped: false, startTime: 0, startMarker: 0.3 }, false],
    ] as const) {
      const clip = info(over as unknown as Partial<ClipInfo>);
      const f = setup({ info: clip });
      await f.run();
      const [p] = f.payloads();
      expect(p.mode === "cue" && p.beatGrid).toEqual(snap ? cueBeatGrid(clip, 120, 20) : null);
      expect(p.snap).toBe(snap);
    }
  });
  it("fb4: Cue on an unwarped Session clip carries a cached Structure analysis's beats; not with Live's grid", async () => {
    const cached = fakeStructureAnalysis(20);
    const unwarped = setup({ info: info({ view: "session", sceneIndex: 0, warped: false }), structureCached: cached });
    await unwarped.run();
    const [p] = unwarped.payloads();
    expect(p.mode === "cue" && p.structureGrid).toEqual({ beats: cached.beats, downbeats: cached.downbeats });
    const bare = setup({ info: info({ view: "session", sceneIndex: 0, warped: false }) });
    await bare.run();
    const [b] = bare.payloads();
    expect(b.mode === "cue" && b.structureGrid).toBeFalsy();
    const arrangement = setup({ structureCached: cached });
    await arrangement.run();
    const [a] = arrangement.payloads();
    expect(a.mode === "cue" && a.structureGrid).toBeFalsy();
  });
});

describe("isStructureAnalysis", () => {
  it("accepts the fake engine's output", () => {
    expect(isStructureAnalysis(fakeStructureAnalysis(20))).toBe(true);
    expect(isStructureAnalysis(fakeStructureAnalysis(7.3))).toBe(true);
  });

  it("rejects other engines, missing segments, a wrong frame count, missing stems, candidates or peaks", () => {
    const a = fakeStructureAnalysis(20);
    const { vocals: _vocals, ...threeStems } = a.stems;
    const { peak: _peak, ...noPeak } = a.stems.bass;
    for (const bad of [
      null,
      "x",
      { ...a, engine: "cue-dsp-1" },
      { ...a, segments: undefined },
      { ...a, frames: 41 },
      { ...a, stems: threeStems },
      { ...a, stems: undefined },
      { ...a, boundaryCandidates: undefined },
      { ...a, stems: { ...a.stems, bass: noPeak } },
    ]) {
      expect(isStructureAnalysis(bad)).toBe(false);
    }
  });

  it("rejects the dev-only allin1-onnx-3 placeholder shape: empty candidates or empty peaks", () => {
    const a = fakeStructureAnalysis(20);
    const emptyPeaks = Object.fromEntries(Object.entries(a.stems).map(([k, v]) => [k, { ...v, peak: [] }]));
    // As the placeholder engine wrote it, under its own engine string, and under the current one.
    const placeholder = { ...a, engine: "allin1-onnx-3", boundaryCandidates: [], stems: emptyPeaks };
    expect(isStructureAnalysis(placeholder)).toBe(false);
    expect(isStructureAnalysis({ ...placeholder, engine: STRUCTURE_ENGINE })).toBe(false);
    // Each check alone: candidates that miss a segment start, and a peak envelope of the wrong length.
    expect(isStructureAnalysis({ ...a, boundaryCandidates: [] })).toBe(false);
    expect(isStructureAnalysis({ ...a, boundaryCandidates: a.boundaryCandidates.filter((c) => c.time !== a.segments[3].start) })).toBe(false);
    expect(isStructureAnalysis({ ...a, stems: emptyPeaks })).toBe(false);
    expect(isStructureAnalysis({ ...a, stems: { ...a.stems, drums: { ...a.stems.drums, peak: a.stems.drums.peak.slice(1) } } })).toBe(false);
    // A one-segment clip needs no candidates.
    const short = fakeStructureAnalysis(7.3);
    expect(short.boundaryCandidates).toEqual([]);
    expect(isStructureAnalysis(short)).toBe(true);
  });
});

/** The download failures p3/t12-download's ensureModels throws that a second attempt can fix. */
function transientErrors(): Error[] {
  const checksum = new Error("htdemucs_core.onnx does not match the expected size or sha256");
  checksum.name = "ModelChecksumError";
  const network = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  const timeout = new Error("The operation timed out");
  timeout.name = "TimeoutError";
  return [
    new Error("Model download failed: 503 htdemucs_core.onnx"),
    new Error("Model download stalled: allin1_harmonix_fold3.onnx"),
    checksum,
    network,
    timeout,
  ];
}

describe("runFind: Retry after a failed model download", () => {
  it("a transient download failure reopens Cue with Structure unavailable, retryable and the cause in the reason", async () => {
    for (const error of transientErrors()) {
      const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, CANCEL] });
      vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(error);
      await f.run();
      const [, again] = f.payloads();
      expect(again.mode, error.message).toBe("cue");
      expect(modesOf(again), error.message).toMatchObject({ available: false, retryable: true, needsDownload: true });
      expect(modesOf(again).reason).toContain("Downloading the analysis models failed");
      expect(f.messages(), error.message).toEqual([]); // the picker shows the reason with Retry; no extra dialog
      expect(f.deps.logError).toHaveBeenCalled();
      expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    }
  });

  it("review m4: not enough disk space reopens Cue with the plain reason and Retry, and Retry tries again", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(new ModelsDiskSpaceError(301_000_000));
    await f.run();
    const [, again, after] = f.payloads();
    expect(again.mode).toBe("cue");
    expect(modesOf(again)).toMatchObject({ available: false, retryable: true });
    expect(modesOf(again).reason).toBe(
      "There is not enough disk space for the analysis models. They need about 301 MB free. Free some space, then try again.",
    );
    expect(f.messages()).toEqual([]);
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(2);
    expect(after.mode).toBe("structure");
  });

  it("the reason names the HTTP status", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(new Error("Model download failed: 503 htdemucs_core.onnx"));
    await f.run();
    expect(modesOf(f.payloads()[1]).reason).toContain("503");
  });

  it("Retry (a switch to Structure while retryable) calls ensureModels again and analyses on success", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels).mockRejectedValueOnce(new Error("Model download stalled: htdemucs_core.onnx"));
    await f.run();
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(2);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.deps.acquireAudio).toHaveBeenCalledTimes(1);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue", "structure"]);
    expect(modesOf(f.payloads()[2])).toMatchObject({ available: true, reason: null, retryable: false, cached: true });
  });

  it("a Retry that fails again reopens Cue with the new reason, still retryable", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels)
      .mockRejectedValueOnce(new Error("Model download failed: 503 htdemucs_core.onnx"))
      .mockRejectedValueOnce(new Error("Model download failed: 404 htdemucs_core.onnx"));
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue", "cue"]);
    expect(modesOf(f.payloads()[2])).toMatchObject({ available: false, retryable: true });
    expect(modesOf(f.payloads()[2]).reason).toContain("404");
  });

  it("cancelling a download (or a retry) is not a failure: Cue reopens, Structure stays available", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.ensureModels)
      .mockRejectedValueOnce(new Error("Model download failed: 503 htdemucs_core.onnx"))
      .mockImplementationOnce(async () => {
        throw abortError();
      });
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue", "cue"]);
    expect(modesOf(f.payloads()[2])).toMatchObject({ available: true, reason: null, retryable: false });
    expect(f.messages()).toEqual([]);
  });

  it("permanent failures are not retryable", async () => {
    const permanent: Array<[Error, "ensureModels" | "analyseStructure"]> = [
      [platformError(), "ensureModels"],
      [new ModelsUnavailableError("no download URL configured"), "ensureModels"],
      [new Error('Model base URL must end in "/": https://x'), "ensureModels"],
      // Only ensureModels failures are download failures, whatever the engine's message says.
      [new Error("Model download failed: 503 htdemucs_core.onnx"), "analyseStructure"],
    ];
    for (const [error, where] of permanent) {
      const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
      vi.mocked(f.deps[where]).mockRejectedValueOnce(error);
      await f.run();
      expect(modesOf(f.payloads()[1]).retryable, `${where}: ${error.message}`).toBe(false);
    }
  });

  it("a switch to an unavailable, non-retryable Structure still does not call ensureModels", async () => {
    const f = setup({ durationSec: 1900, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.deps.ensureModels).not.toHaveBeenCalled();
  });
});

describe("defaultDeps.assertStructurePlatform", () => {
  it("is runtime.ts's platform check: an Intel or Rosetta Mac throws OrtUnsupportedPlatformError", () => {
    const desc = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    try {
      const deps = defaultDeps("<!--PAYLOAD-->");
      if (process.platform === "darwin") {
        expect(() => deps.assertStructurePlatform()).toThrow(expect.objectContaining({ name: "OrtUnsupportedPlatformError" }));
      } else {
        expect(() => deps.assertStructurePlatform()).not.toThrow(); // win32-x64 is supported
      }
    } finally {
      Object.defineProperty(process, "arch", desc);
    }
  });
});

type Fixture = ReturnType<typeof setup>;
type ProgressImpl = (text: string, o: unknown, cb: (u: (t: string, p?: number) => Promise<void>, s: AbortSignal) => Promise<unknown>) => Promise<unknown>;

/** Records when each Live dialog (progress, modal, message) opened and closed on the fake clock. */
function timeline(f: Fixture) {
  const events: Array<{ kind: string; open: number; close: number }> = [];
  const progress = vi.mocked(f.context.ui.withinProgressDialog).getMockImplementation()! as ProgressImpl;
  vi.mocked(f.context.ui.withinProgressDialog).mockImplementation((async (text, o, cb) => {
    const e = { kind: text, open: f.clock.now(), close: NaN };
    events.push(e);
    try {
      f.advance(50);
      return await progress(text, o, cb);
    } finally {
      e.close = f.clock.now();
    }
  }) as ProgressImpl);
  const modal = f.modal.getMockImplementation()!;
  f.modal.mockImplementation(async (url, w, h) => {
    const e = { kind: url.startsWith("data:") ? "message" : "dialog", open: f.clock.now(), close: NaN };
    events.push(e);
    try {
      f.advance(50);
      return await modal(url, w, h);
    } finally {
      e.close = f.clock.now();
    }
  });
  const gaps = () => events.slice(1).map((e, i) => e.open - events[i].close);
  return { events, gaps };
}

/** Progress updates that Live answers only when `answer(text, pct)` says so; counts the ones still unanswered. */
function slowUpdates(f: Fixture, answer: (title: string, text: string, pct: number | undefined) => boolean) {
  const unansweredAtClose: Array<[string, number]> = [];
  vi.mocked(f.context.ui.withinProgressDialog).mockImplementation((async (title, _o, cb) => {
    f.titles.push(title);
    const controller = new AbortController();
    if (title === "Analyzing structure…" && abortNext) controller.abort();
    let unanswered = 0;
    try {
      return await cb((t, p) => {
        f.progress.push([t, p]);
        if (!answer(title, t, p)) return new Promise<void>(() => undefined);
        unanswered++;
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            unanswered--;
            resolve();
          }, 2),
        );
      }, controller.signal);
    } finally {
      unansweredAtClose.push([title, unanswered]);
    }
  }) as ProgressImpl);
  let abortNext = false;
  return { unansweredAtClose, abortStructure: () => void (abortNext = true) };
}

describe("runFind: dialog pacing and page diagnostics (LO6 A2 blank dialog)", () => {
  it("the Structure dialog after an uncached analysis opens DIALOG_GAP_MS after the progress dialog closed", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    const t = timeline(f);
    await f.run();
    expect(t.events.map((e) => e.kind)).toEqual(["Finding sections…", "dialog", "Analyzing structure…", "dialog"]);
    expect(t.gaps()).toEqual([DIALOG_GAP_MS, DIALOG_GAP_MS, DIALOG_GAP_MS]);
  });

  it("the dialog after a cancelled Structure analysis opens only after the gap (LO5)", async () => {
    const f = setup({ abortStructure: true, dialogResults: [SWITCH("structure"), CANCEL] });
    const t = timeline(f);
    await f.run();
    expect(t.events.map((e) => e.kind)).toEqual(["Finding sections…", "dialog", "Analyzing structure…", "dialog"]);
    expect(t.gaps().every((g) => g >= DIALOG_GAP_MS)).toBe(true);
  });

  it("messages and the dialogs after them are paced too, and a switch reopens after the gap", async () => {
    // No models: both switches analyse in the foreground, and the first of them fails.
    const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.analyseStructure).mockRejectedValueOnce(new Error("ORT session failed"));
    const t = timeline(f);
    await f.run();
    expect(t.events.map((e) => e.kind)).toEqual([
      "Finding sections…",
      "dialog",
      "Analyzing structure…",
      "message",
      "dialog",
      "Analyzing structure…",
      "dialog",
    ]);
    expect(t.gaps().every((g) => g >= DIALOG_GAP_MS)).toBe(true);
  });

  it("the first dialog of a run opens at once", async () => {
    const f = setup({ dialogResult: CANCEL });
    const t = timeline(f);
    await f.run();
    expect(t.events[0].open).toBe(1_000_000);
  });

  it("a finished progress dialog closes only once Live has answered its fire-and-forget updates", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    // The flush's cap never fires here, so only the answers can end the wait.
    vi.mocked(f.clock.sleep).mockImplementation(async (ms: number) => {
      if (ms === UPDATE_FLUSH_MS) return new Promise<void>(() => undefined);
      f.advance(ms);
    });
    const slow = slowUpdates(f, () => true);
    await f.run();
    expect(slow.unansweredAtClose).toEqual([
      ["Finding sections…", 0],
      ["Analyzing structure…", 0],
    ]);
    expect(f.dialogCalls()).toHaveLength(2);
  });

  it("updates Live never answers hold the close for at most UPDATE_FLUSH_MS", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    // Every Structure update is fire-and-forget (reporter); none is answered.
    slowUpdates(f, (title) => title !== "Analyzing structure…");
    await f.run();
    expect(f.clock.sleep).toHaveBeenCalledWith(UPDATE_FLUSH_MS);
    expect(f.dialogCalls()).toHaveLength(2);
  });

  it("a cancelled progress dialog does not wait for its updates", async () => {
    const f = setup({ dialogResults: [SWITCH("structure"), CANCEL] });
    // Neither the cap nor the cancelled dialog's updates ever resolve: waiting on them would hang the run.
    vi.mocked(f.clock.sleep).mockImplementation(async (ms: number) => {
      if (ms === UPDATE_FLUSH_MS) return new Promise<void>(() => undefined);
      f.advance(ms);
    });
    const slow = slowUpdates(f, (title) => title !== "Analyzing structure…");
    slow.abortStructure();
    await f.run();
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(slow.unansweredAtClose.map(([title]) => title)).toEqual(f.titles);
    expect(f.dialogCalls()).toHaveLength(2);
  });

  it("serves the page on the flow's clock and watches it for PAGE_WATCHDOG_MS", async () => {
    const f = setup({ dialogResult: CANCEL });
    await f.run();
    expect(vi.mocked(f.deps.serveDialog).mock.calls[0][0].now).toBe(f.clock.now);
    expect(f.clock.after).toHaveBeenCalledWith(PAGE_WATCHDOG_MS, expect.any(Function));
  });

  it("logs a dialog whose page was never requested while it is still open, and sums it up when it closes", async () => {
    const f = setup();
    f.modal.mockImplementationOnce(async () => {
      f.fireTimers(); // 10 s pass with the dialog blank
      f.advance(200_000);
      return CANCEL;
    });
    await f.run();
    expect(f.deps.logError).toHaveBeenCalledWith(
      "Song Sections: the cue dialog has not requested its page (2 KB) 10 s after opening; Live is probably showing a blank dialog",
    );
    expect(f.deps.log).toHaveBeenCalledWith("Song Sections: cue dialog closed after 210.0 s; page (2 KB) never requested");
  });

  it("a page that mounted logs no warning, only the summary with its timings", async () => {
    const f = setup();
    f.modal.mockImplementationOnce(async () => {
      const opened = f.clock.now();
      f.page.pageAt = opened + 20;
      f.page.readyAt = opened + 300;
      f.fireTimers();
      return CANCEL;
    });
    await f.run();
    expect(f.deps.logError).not.toHaveBeenCalled();
    expect(f.deps.log).toHaveBeenCalledWith("Song Sections: cue dialog closed after 10.0 s; page 2 KB requested +20 ms, mounted +300 ms");
  });

  it("the watchdog stops when the dialog closes", async () => {
    const f = setup({ dialogResult: CANCEL });
    await f.run();
    f.fireTimers();
    expect(f.deps.logError).not.toHaveBeenCalled();
    expect(f.deps.log).toHaveBeenCalledTimes(1);
  });

  it("a dialog that rejects still stops the watchdog, logs its summary and closes the server", async () => {
    const f = setup();
    f.modal.mockImplementationOnce(async () => {
      throw new Error("bad url");
    });
    await f.run();
    f.fireTimers();
    expect(f.deps.logError).not.toHaveBeenCalledWith(expect.stringContaining("has not requested"));
    expect(f.deps.log).toHaveBeenCalledWith(expect.stringContaining("cue dialog closed after"));
    expect(f.server.close).toHaveBeenCalledTimes(1);
  });
});


/**
 * analyseStructure that reports 10 % and 50 %, then waits for release() (or fail()), rejecting with an AbortError when
 * its signal aborts. `count` (shared between fixtures) tracks how many analyses run at once.
 */
function gated(f: Fixture, count = { running: 0, max: 0 }) {
  let release: () => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const signals: AbortSignal[] = [];
  vi.mocked(f.deps.analyseStructure).mockImplementation(async (path, _env, signal, onProgress) => {
    if (f.deleted.has(path)) throw new Error(`ENOENT: the render was deleted: ${path}`);
    signals.push(signal);
    count.running++;
    count.max = Math.max(count.max, count.running);
    try {
      onProgress(0.1, "separating");
      onProgress(0.5, "features");
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
        signal.addEventListener("abort", () => reject(abortError()));
      });
      onProgress(0.9, "beats");
      return f.structure;
    } finally {
      count.running--;
    }
  });
  return { release: () => release(), fail: (e: Error) => fail(e), signals, count };
}

/** Runs `during` inside every progress dialog titled `title`, once its body has started. */
function duringProgress(f: Fixture, title: string, during: () => void) {
  const impl = vi.mocked(f.context.ui.withinProgressDialog).getMockImplementation()! as ProgressImpl;
  vi.mocked(f.context.ui.withinProgressDialog).mockImplementation((async (t, o, cb) =>
    impl(t, o, async (u, s) => {
      if (t === title) setTimeout(during, 5);
      return cb(u, s);
    })) as ProgressImpl);
}

/** Each modal dialog stays open until the background analysis, if any, has ended. */
function finishWhileOpen(f: Fixture) {
  const modal = f.modal.getMockImplementation()!;
  f.modal.mockImplementation(async (url, w, h) => {
    const result = await modal(url, w, h); // the page mounts first (onReady)
    await f.settle();
    return result;
  });
}

const STAGE2 = "2/4 Extracting features… (results are cached for next time)";

describe("runFind: Cue opens first, Structure analyses in the background (fb2)", () => {
  it("opens Structure straight away when it was the last mode and is cached: there is nothing to wait for", async () => {
    const cached = fakeStructureAnalysis(20);
    const f = setup({ lastMode: "structure", structureCached: cached, stemsReady: true, dialogResults: [SWITCH("cue"), CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["structure", "cue"]);
    const [first] = f.payloads();
    expect(first.mode === "structure" && first.analysis).toEqual(cached);
    expect(f.dialogCalls().map(([, w, h]) => [w, h])).toEqual([[1000, 680], [1000, 560]]);
    expect(f.deps.analyseStructure).not.toHaveBeenCalled();
    expect(f.deps.background.current).toBeNull();
    // Cue is analysed only on the switch, under its own progress dialog.
    expect(f.titles).toEqual(["Finding sections…", "Finding sections…"]);
    expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
  });

  it("opens Cue first otherwise, and suggests Structure when it was the last mode", async () => {
    for (const [opts, suggested] of [
      [{ lastMode: "structure" }, true],
      [{ lastMode: "structure", structureCached: fakeStructureAnalysis(20), durationSec: 1900 }, false], // unavailable
      [{ lastMode: "cue", structureCached: fakeStructureAnalysis(20) }, false],
      [{ lastMode: "cue" }, false],
    ] as const) {
      const f = setup(opts);
      await f.run();
      await f.settle();
      expect(f.payloads().map((p) => p.mode), JSON.stringify(opts)).toEqual(["cue"]);
      expect(f.dialogCalls().map(([, w, h]) => [w, h])).toEqual([[1000, 560]]);
      expect(f.titles).toEqual(["Finding sections…"]);
      expect(f.deps.analyseCue).toHaveBeenCalledTimes(1);
      expect(modesOf(f.payloads()[0]).suggested ?? false, JSON.stringify(opts)).toBe(suggested);
    }
  });

  it("starts the analysis in the host once the Cue page is up, with no progress dialog, and reports it to the page", async () => {
    const f = setup({ lastMode: "structure" });
    const g = gated(f);
    let before: unknown;
    let after: unknown;
    f.modal.mockImplementationOnce(async () => {
      const opts = f.served[0];
      before = opts.structureProgress?.();
      expect(f.deps.analyseStructure).not.toHaveBeenCalled(); // not before the page has mounted
      opts.onReady?.();
      await new Promise((r) => setTimeout(r, 5));
      after = opts.structureProgress?.();
      return CANCEL;
    });
    await f.run();
    expect(modesOf(f.payloads()[0]).background).toBe(true);
    expect(before).toEqual({ state: "pending", percent: 0 });
    expect(after).toEqual({ state: "running", percent: 50 });
    expect(f.titles).toEqual(["Finding sections…"]);
    expect(vi.mocked(f.deps.analyseStructure).mock.calls[0].slice(0, 2)).toEqual([
      "/var/render.aif",
      {
        modelDir: "/storage/models/set",
        tempDir: "/temp",
        storageDir: "/storage",
        extensionRoot: "/ext",
        auditionStemsDir: STEMS_DIR,
        pace: f.deps.background.current!.pace, // fb2 review I1: it gives way to the host's foreground work
      },
    ]);
    g.release();
    await f.settle();
    expect(f.served[0].structureProgress?.()).toMatchObject({ state: "done" });
  });

  it("Matt, 31 Oct: starts whatever the last mode was, so with Cue as the last mode it starts once the Cue page is up and is reported to the page", async () => {
    const f = setup({ lastMode: "cue" });
    const g = gated(f);
    let before: unknown;
    let after: unknown;
    f.modal.mockImplementationOnce(async () => {
      const opts = f.served[0];
      before = opts.structureProgress?.();
      expect(f.deps.analyseStructure).not.toHaveBeenCalled(); // not before the page has mounted
      opts.onReady?.();
      await new Promise((r) => setTimeout(r, 5));
      after = opts.structureProgress?.();
      return CANCEL;
    });
    await f.run();
    expect(modesOf(f.payloads()[0]).background).toBe(true);
    expect(modesOf(f.payloads()[0]).suggested ?? false).toBe(false); // the tab's suggestion still follows lastMode
    expect(before).toEqual({ state: "pending", percent: 0 });
    expect(after).toEqual({ state: "running", percent: 50 });
    expect(f.titles).toEqual(["Finding sections…"]);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.deps.background.current).not.toBeNull();
    g.release();
    await f.settle();
    expect(f.served[0].structureProgress?.()).toMatchObject({ state: "done" });
  });

  it("Cancel in Cue lets it finish and cache; the render is deleted only once it has settled", async () => {
    const f = setup({ lastMode: "structure", stemsReady: true });
    const g = gated(f);
    await f.run();
    const removed = () => vi.mocked(f.deps.removeFile).mock.calls.map(([p]) => p);
    expect(removed()).not.toContain("/var/render.aif"); // the analysis still reads it
    expect(removed()).toContainEqual(expect.stringMatching(/^[\\/]temp[\\/].+\.wav$/)); // the preview is the dialog's only
    expect(structureSaves(f.deps)).toEqual([]);
    g.release();
    await f.settle();
    expect(structureSaves(f.deps)).toEqual([["/storage", "abc123", STRUCTURE_ENGINE, f.structure]]);
    expect(f.deps.pruneAuditions).toHaveBeenCalledWith("/storage", "abc123");
    expect(removed()).toContain("/var/render.aif");
    expect(f.messages()).toEqual([]);
    expect(f.deps.logError).not.toHaveBeenCalled();
  });

  it("Apply in Cue applies at once and lets the analysis finish", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [apply()] });
    const g = gated(f);
    await f.run();
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.saveSettings).mock.calls).toEqual([["/storage", { lastMode: "cue" }]]);
    g.release();
    await f.settle();
    expect(structureSaves(f.deps)).toHaveLength(1);
  });

  it("a switch while it runs opens a progress dialog on the same analysis, from its progress so far", async () => {
    const f = setup({ lastMode: "structure", stemsReady: true, dialogResults: [SWITCH("structure"), CANCEL] });
    const g = gated(f);
    duringProgress(f, "Analyzing structure…", g.release);
    await f.run();
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(1);
    const attached = f.progress.slice(f.progress.findIndex(([t]) => t === STAGE2));
    expect(attached[0]).toEqual([STAGE2, 50]);
    expect(attached).toContainEqual(["4/4 Tracking beats… (results are cached for next time)", 90]);
    const [, structure] = f.payloads();
    expect(structure).toMatchObject({ mode: "structure", stemUrls: { drums: "stems/drums.wav", bass: "stems/bass.wav", vocals: "stems/vocals.wav", other: "stems/other.wav" } });
    expect(structure.mode === "structure" && structure.analysis).toEqual(f.structure);
    expect(modesOf(structure)).toMatchObject({ cached: true });
    expect(structureSaves(f.deps)).toHaveLength(1);
  });

  it("cancelling that progress dialog reopens Cue and leaves the analysis running; the next switch opens it when done", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), SWITCH("structure"), CANCEL] });
    const g = gated(f);
    duringProgress(f, "Analyzing structure…", f.abortProgress);
    const modal = f.modal.getMockImplementation()!;
    let n = 0;
    f.modal.mockImplementation(async (url, w, h) => {
      if (!url.startsWith("data:") && n++ === 1) {
        // The reopened Cue dialog: still running, and its page still polls; it finishes while this dialog is open.
        expect(modesOf(f.payloads()[1]).background).toBe(true);
        expect(f.served[1].structureProgress?.()).toEqual({ state: "running", percent: 50 });
        g.release();
        await f.settle();
      }
      return modal(url, w, h);
    });
    await f.run();
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue", "structure"]);
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(g.signals[0].aborted).toBe(false);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(f.messages()).toEqual([]);
  });

  it("a switch once it is done opens Structure at once from its result", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
    finishWhileOpen(f);
    await f.run();
    expect(f.titles).toEqual(["Finding sections…"]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure"]);
    const structure = f.payloads()[1];
    expect(structure.mode === "structure" && structure.analysis).toEqual(f.structure);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(structureSaves(f.deps)).toHaveLength(1);
  });

  it("Re-analyze after a background result runs a new analysis, not the old result again", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), JSON.stringify({ action: "reanalyse" }), CANCEL] });
    finishWhileOpen(f);
    await f.run();
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(2);
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure", "structure"]);
    // fb2 review C1: the new analysis reads the render the background one read; that one must not have deleted it.
    expect(vi.mocked(f.deps.logError).mock.calls.flat().map(String).join(" ")).toBe("");
    expect(f.messages()).toEqual([]);
    expect(f.deleted).toContain("/var/render.aif"); // deleted once both are done
  });

  it("Re-analyze with this clip's finished background result still in the slot runs a new analysis, not that result (merge of fb/bgstruct)", async () => {
    // Run a: Cue opens, the analysis runs in the background (keeping no stems) and finishes after Cancel. Nothing took
    // its result, so it stays in the slot. Run b on the same clip opens Structure from the cache it wrote.
    const a = setup({ lastMode: "structure" });
    await a.run();
    await a.settle();
    expect(a.deps.background.current?.run.state).toBe("done");
    const b = setup({ lastMode: "structure", structureCached: a.structure, background: a.deps.background, dialogResults: [JSON.stringify({ action: "reanalyse" }), CANCEL] });
    await b.run();
    expect(b.payloads().map((p) => p.mode)).toEqual(["structure", "structure"]);
    expect(b.deps.analyseStructure).toHaveBeenCalledTimes(1); // a new analysis, under its own progress dialog
    expect(b.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(b.deps.background.current).toBeNull();
  });

  it("Re-analyze while this clip's background analysis still runs joins it: never two at once (merge of fb/bgstruct)", async () => {
    const count = { running: 0, max: 0 };
    const a = setup({ lastMode: "structure" });
    const g = gated(a, count);
    await a.run();
    expect(a.deps.background.current?.run.state).toBe("running");
    // An older cache entry with no stems (say, from a build before stems were kept) opens Structure with Re-analyze.
    const old = { ...fakeStructureAnalysis(20), bpm: 101 };
    const b = setup({ lastMode: "structure", structureCached: old, background: a.deps.background, dialogResults: [JSON.stringify({ action: "reanalyse" }), CANCEL] });
    gated(b, count);
    duringProgress(b, "Analyzing structure…", g.release);
    await b.run();
    expect(b.deps.analyseStructure).not.toHaveBeenCalled();
    expect(a.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(count.max).toBe(1);
    expect(b.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    const after = b.payloads()[1];
    expect(after.mode === "structure" && after.analysis).toEqual(a.structure);
  });

  it("a new Find Sections on another clip aborts the old analysis first; only one runs at a time", async () => {
    const count = { running: 0, max: 0 };
    const a = setup({ lastMode: "structure" });
    const ga = gated(a, count);
    await a.run();
    expect(a.deps.background.current?.run.state).toBe("running");
    const b = setup({ lastMode: "structure", hash: "def456", background: a.deps.background });
    const gb = gated(b, count);
    vi.mocked(b.deps.prepareAudio).mockImplementation(async (_src, previewPath) => {
      expect(ga.signals[0].aborted).toBe(false); // the clip is not known before it is prepared
      return { ...prepared, previewPath, hash: "def456" };
    });
    await b.run();
    expect(ga.signals[0].aborted).toBe(true);
    expect(vi.mocked(a.deps.removeFile).mock.calls.map(([p]) => p)).toContain("/var/render.aif"); // the old render
    expect(structureSaves(a.deps)).toEqual([]);
    expect(b.deps.background.current?.run.key).toBe("def456");
    gb.release();
    await b.settle();
    expect(count.max).toBe(1);
    expect(a.deps.logError).not.toHaveBeenCalled(); // an abort is not an error
  });

  it("a new Find Sections on the same clip joins the running analysis", async () => {
    const a = setup({ lastMode: "structure" });
    const g = gated(a);
    await a.run();
    const b = setup({ lastMode: "structure", background: a.deps.background, dialogResults: [SWITCH("structure"), CANCEL] });
    duringProgress(b, "Analyzing structure…", g.release);
    await b.run();
    expect(g.signals[0].aborted).toBe(false);
    expect(b.deps.analyseStructure).not.toHaveBeenCalled();
    expect(b.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(b.payloads().map((p) => p.mode)).toEqual(["cue", "structure"]);
  });

  it("is not started when the models are missing, the clip is over the warn length, or Structure is cached or unavailable", async () => {
    for (const opts of [
      { lastMode: "structure", modelsInstalled: false },
      { lastMode: "structure", durationSec: 700 },
      { lastMode: "structure", durationSec: 1900 },
      { lastMode: "structure", structureCached: fakeStructureAnalysis(20) },
    ] as FakeOpts[]) {
      const f = setup(opts);
      await f.run();
      expect(f.deps.ensureModels, JSON.stringify(opts)).not.toHaveBeenCalled();
      expect(f.deps.analyseStructure).not.toHaveBeenCalled();
      expect(f.deps.background.current).toBeNull();
      expect(modesOf(f.payloads()[0]).background ?? false).toBe(false);
      expect(f.served[0].structureProgress?.() ?? { state: "none", percent: 0 }).toEqual({ state: "none", percent: 0 });
    }
  });

  it("never downloads models: one that would is stopped, and a switch then analyses in the foreground", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
    // Installed when checked, gone by the time the analysis asks (a cleared storage folder).
    vi.mocked(f.deps.ensureModels).mockImplementationOnce(async ({ onProgress, signal }) => {
      onProgress(0, MODEL_DOWNLOAD_BYTES);
      if (signal.aborted) throw abortError();
      throw new Error("downloaded");
    });
    await f.run();
    expect(f.deps.ensureModels).toHaveBeenCalledTimes(2);
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure"]);
    expect(f.messages()).toEqual([]);
  });

  it("an error only logs while Cue is open", async () => {
    const f = setup({ lastMode: "structure" });
    vi.mocked(f.deps.analyseStructure).mockRejectedValueOnce(new Error("ORT exploded"));
    await f.run();
    await f.settle();
    expect(f.messages()).toEqual([]);
    expect(vi.mocked(f.deps.logError).mock.calls.flat().join(" ")).toMatch(/background.*ORT exploded/s);
  });

  it("an error surfaces on a switch through the usual path, and the next switch analyses anew", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), SWITCH("structure"), CANCEL] });
    vi.mocked(f.deps.analyseStructure).mockRejectedValueOnce(new Error("ORT exploded"));
    finishWhileOpen(f);
    await f.run();
    expect(f.messages()).toEqual([expect.stringContaining("couldn't analyze the structure")]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue", "structure"]);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(2);
    expect(f.titles).toEqual(["Finding sections…", "Analyzing structure…"]);
  });

  it("fb2 review I1: the run is foreground work except while a dialog waits on the user", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), apply()] });
    const busy: Record<string, boolean[]> = {};
    const note = (where: string) => (busy[where] ??= []).push(f.deps.activity.busy());
    const acquire = vi.mocked(f.deps.acquireAudio).getMockImplementation()!;
    vi.mocked(f.deps.acquireAudio).mockImplementation(async (...a) => (note("render"), acquire(...a)));
    const modal = f.modal.getMockImplementation()!;
    f.modal.mockImplementation(async (url, w, h) => (note(url.startsWith("data:") ? "message" : "dialog"), modal(url, w, h)));
    vi.mocked(f.deps.executeArrangement).mockImplementation(async () => void note("apply"));
    finishWhileOpen(f);
    await f.run();
    expect(busy).toEqual({ render: [true], dialog: [false, false], apply: [true] });
    expect(f.deps.activity.busy()).toBe(false); // and not once it has returned
  });

  it("fb2 review I1: the background analysis gives way to that work, and runs at full speed while a dialog waits for it", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
    const g = gated(f);
    const pace = () => vi.mocked(f.deps.analyseStructure).mock.calls[0][1].pace!;
    let attached: number | undefined;
    duringProgress(f, "Analyzing structure…", () => {
      attached = pace().slice(800);
      g.release();
    });
    await f.run();
    expect(attached).toBe(800); // attached: whole slices
    expect(pace().slice(800)).toBe(100); // detached again: background slices
    // The foreground analysis (Re-analyze, a retry) runs as it always did.
  });

  it("fb2 review I1: a foreground analysis is not paced", async () => {
    // No models, so nothing starts in the background and the switch analyses in the foreground.
    const f = setup({ modelsInstalled: false, dialogResults: [DOWNLOAD, CANCEL] });
    await f.run();
    expect(f.deps.background.current).toBeNull();
    expect(f.titles).toContain("Analyzing structure…");
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.analyseStructure).mock.calls[0][1]).not.toHaveProperty("pace");
  });

  it("fb2 review m1: waiting for another clip's analysis to stop can be cancelled; it keeps its slot until it has", async () => {
    const a = setup({ lastMode: "structure" });
    let release = () => undefined as void;
    vi.mocked(a.deps.analyseStructure).mockImplementation(async (_p, _e, signal, onProgress) => {
      onProgress(0.5, "features");
      await new Promise<void>((resolve) => (release = resolve)); // an ORT run: deaf to the abort
      if (signal.aborted) throw abortError();
      return a.structure;
    });
    await a.run();
    const old = a.deps.background.current!;
    const b = setup({ lastMode: "structure", hash: "def456", background: a.deps.background });
    vi.mocked(b.deps.prepareAudio).mockImplementation(async (_src, previewPath) => {
      setTimeout(b.abortProgress, 5); // the user cancels while it waits
      return { ...prepared, previewPath, hash: "def456" };
    });
    await b.run();
    expect(b.dialogCalls()).toEqual([]);
    expect(b.deps.analyseCue).not.toHaveBeenCalled();
    expect(a.deps.background.current).toBe(old); // still in its ORT run
    release();
    await old.run.settled;
    await new Promise((r) => setTimeout(r, 0));
    expect(a.deps.background.current).toBeNull();
    expect(old.run.state).toBe("aborted");
  });

  it("fb2 review m4: an analysis that ends during the gap before its progress dialog opens no dialog", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
    const g = gated(f);
    vi.mocked(f.clock.sleep).mockImplementation(async (ms) => {
      if (ms === DIALOG_GAP_MS && f.deps.background.current?.run.state === "running") {
        g.release();
        await f.settle();
      }
      f.advance(ms);
    });
    await f.run();
    expect(f.titles).toEqual(["Finding sections…"]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "structure"]);
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
  });

  it("an error found while attached surfaces the same way", async () => {
    const f = setup({ lastMode: "structure", dialogResults: [SWITCH("structure"), CANCEL] });
    const g = gated(f);
    duringProgress(f, "Analyzing structure…", () => g.fail(platformError()));
    await f.run();
    expect(f.messages()).toEqual([expect.stringContaining(PLATFORM_MSG)]);
    expect(f.payloads().map((p) => p.mode)).toEqual(["cue", "cue"]);
    expect(modesOf(f.payloads()[1])).toMatchObject({ available: false, reason: PLATFORM_MSG });
  });
});

describe("runFind: sends (v2)", () => {
  const SEND = (over: Record<string, unknown> = {}) => JSON.stringify({ action: "send", target: "simpler", source: "mix", index: 1, sections: SECTIONS, ...over });

  it("Cue: a mix send closes the dialog and sends the dialog's sections, cut from the render", async () => {
    const f = setup({ modelsInstalled: false, dialogResult: SEND({ target: "drumRack" }) });
    await f.run();
    expect(f.deps.executeSend).toHaveBeenCalledTimes(1);
    const [, clip, req, env] = vi.mocked(f.deps.executeSend).mock.calls[0];
    expect(clip).toMatchObject({ name: "Song", view: "arrangement" });
    expect(req).toEqual({
      target: "drumRack",
      source: "mix",
      index: 1,
      sections: SECTIONS,
      sourcePath: "/var/render.aif",
      tempo: 120,
      durationSec: 20, // Plan 6: where a section that ends there runs to the file's end
      harmony: MIX_HARMONY, // v2: the harmony the dialog keyed its sections from
      keyInNames: true,
    });
    expect(env).toMatchObject({ tempDir: "/temp", storageDir: "/storage" });
    expect(f.deps.executeArrangement).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([]);
    // The render is released only after the send has read it.
    expect(f.deleted.has("/var/render.aif")).toBe(true);
  });

  it("Cue: a stem send is refused (Cue has no stems) and the Set is untouched", async () => {
    const f = setup({ modelsInstalled: false, dialogResult: SEND({ source: "drums" }) });
    await f.run();
    expect(f.deps.executeSend).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.stringContaining("Song Sections ran into a problem. Your Set was not changed.")]);
  });

  it("Structure: a stem send cuts from the kept stem; a mix send from the render", async () => {
    for (const [source, path] of [["bass", join(STEMS_DIR, "bass.wav")], ["mix", "/var/render.aif"]]) {
      const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), SEND({ source, target: "audioWhole" })] });
      await f.run();
      expect(vi.mocked(f.deps.executeSend).mock.calls[0][2]).toMatchObject({ source, target: "audioWhole", sourcePath: path });
    }
  });

  it("Plan 6: a lane send passes unit patterns, its slices with their gaps, and the stem's path (the render's for the mix)", async () => {
    const slices = [
      { start: 0, end: 8, label: "drums 1", color: 1 },
      { start: 12, end: 20, label: "drums 2", color: 2 },
    ];
    for (const [source, path] of [["drums", join(STEMS_DIR, "drums.wav")], ["mix", "/var/render.aif"]]) {
      const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), SEND({ source, target: "drumRack", unit: "patterns", index: 1, sections: slices })] });
      await f.run();
      expect(f.deps.executeSend).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.deps.executeSend).mock.calls[0][2]).toMatchObject({ source, target: "drumRack", unit: "patterns", index: 1, sections: slices, sourcePath: path, durationSec: 20 });
      expect(f.messages()).toEqual([]);
    }
  });

  it("Plan 6: a band send carries no unit, and sections with a gap are refused unless they are a lane's", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), SEND()] });
    await f.run();
    expect(vi.mocked(f.deps.executeSend).mock.calls[0][2]).not.toHaveProperty("unit");
    const gapped = [SECTIONS[0], { ...SECTIONS[1], start: 12 }];
    const g = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), SEND({ source: "bass", sections: gapped })] });
    await g.run();
    expect(g.deps.executeSend).not.toHaveBeenCalled();
    expect(g.messages()).toEqual([expect.stringContaining("Song Sections ran into a problem. Your Set was not changed.")]);
  });

  it("Plan 6: a lane send with overlapping or too-short slices is refused before anything is sent", async () => {
    for (const sections of [
      [SECTIONS[0], { ...SECTIONS[1], start: 9 }],
      [SECTIONS[0], { ...SECTIONS[1], start: 19.5 }],
    ]) {
      const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), SEND({ source: "bass", unit: "patterns", sections })] });
      await f.run();
      expect(f.deps.executeSend).not.toHaveBeenCalled();
    }
  });

  describe("Send all stems (Plan 6, Task 8)", () => {
    const STEMS = {
      drums: [{ start: 0, end: 8, label: "drums 1", color: 1 }, { start: 8, end: 20, label: "drums 2", color: 2 }],
      bass: [],
      vocals: [{ start: 12, end: 20, label: "vocals 1", color: 3 }],
      other: [{ start: 0, end: 20, label: "other 1", color: 4 }],
    };
    const ALL = (over: Record<string, unknown> = {}) => SEND({ target: "allStems", source: "mix", index: 0, stems: STEMS, ...over });

    it("passes the four stems' paths in the stems folder, their slices, and the dialog's sections", async () => {
      const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), ALL()] });
      await f.run();
      expect(f.deps.executeSend).toHaveBeenCalledTimes(1);
      const req = vi.mocked(f.deps.executeSend).mock.calls[0][2];
      expect(req).toMatchObject({
        target: "allStems",
        source: "mix",
        index: 0,
        sections: SECTIONS,
        stems: STEMS,
        stemPaths: { drums: join(STEMS_DIR, "drums.wav"), bass: join(STEMS_DIR, "bass.wav"), vocals: join(STEMS_DIR, "vocals.wav"), other: join(STEMS_DIR, "other.wav") },
        durationSec: 20,
      });
      expect(req).not.toHaveProperty("unit");
      expect(f.messages()).toEqual([]);
      // Matt, 3 Nov: the send places its own locators (send.ts); Apply's ops, and so its Output, play no part.
      expect(f.deps.arrangementOps).not.toHaveBeenCalled();
      expect(f.deps.executeArrangement).not.toHaveBeenCalled();
    });

    it("is refused without kept stems (Cue, or a Structure analysis that kept none), and with a stem's bad slices", async () => {
      for (const f of [
        setup({ modelsInstalled: false, dialogResult: ALL() }),
        setup({ structureCached: fakeStructureAnalysis(20), stemsReady: false, dialogResults: [SWITCH("structure"), ALL()] }),
        setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), ALL({ stems: { ...STEMS, bass: [{ start: 0, end: 30, label: "bass 1", color: 0 }] } })] }),
        setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), ALL({ stems: { ...STEMS, drums: [STEMS.drums[0], { ...STEMS.drums[1], start: 7 }] } })] }),
      ]) {
        await f.run();
        expect(f.deps.executeSend).not.toHaveBeenCalled();
        expect(f.messages()).toEqual([expect.stringContaining("Song Sections ran into a problem. Your Set was not changed.")]);
      }
    });
  });

  it("Structure without kept stems: a stem send is refused", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: false, dialogResults: [SWITCH("structure"), SEND({ source: "vocals" })] });
    await f.run();
    expect(f.deps.executeSend).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.stringContaining("Song Sections ran into a problem. Your Set was not changed.")]);
  });

  it("invalid sections are refused before anything is sent", async () => {
    const f = setup({ modelsInstalled: false, dialogResult: SEND({ sections: [{ start: 0, end: 30, label: "x", color: 0 }], index: 0 }) });
    await f.run();
    expect(f.deps.executeSend).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.stringContaining("Song Sections ran into a problem. Your Set was not changed.")]);
  });

  it("a send's notes are shown once it is done", async () => {
    const f = setup({ modelsInstalled: false, dialogResult: SEND() });
    vi.mocked(f.deps.executeSend).mockResolvedValueOnce({ steps: 4, notes: ["One.", "Two."] });
    await f.run();
    expect(f.messages()).toEqual([expect.stringContaining("<p>One. Two.</p>")]);
  });

  it("a send that fails midway says what it made and how many Undos remove it", async () => {
    const f = setup({ modelsInstalled: false, dialogResult: SEND() });
    vi.mocked(f.deps.executeSend).mockRejectedValueOnce(new SendError("boom", 3, "a new MIDI track with a Simpler"));
    await f.run();
    expect(f.messages()).toEqual([
      expect.stringContaining("Song Sections couldn't finish sending the sections. It made a new MIDI track with a Simpler; use Edit › Undo 3 times to remove it."),
    ]);
    const g = setup({ modelsInstalled: false, dialogResult: SEND() });
    vi.mocked(g.deps.executeSend).mockRejectedValueOnce(new SendError("no project", 0, "nothing"));
    await g.run();
    expect(g.messages()).toEqual([expect.stringContaining("Song Sections couldn't send the sections. Your Set was not changed.")]);
  });

  it("a Structure send remembers the mode and the choices, as Apply does", async () => {
    const prefs = { ...DEFAULT_STRUCTURE_PREFS, sliceBy: "bass" as const };
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), SEND({ source: "drums", prefs })] });
    await f.run();
    expect(f.deps.saveSettings).toHaveBeenCalledWith("/storage", { lastMode: "structure", structure: prefs });
  });

  it("the send is foreground work: a background Structure analysis gives way to it", async () => {
    const f = setup({ dialogResult: SEND() });
    let busy: boolean | undefined;
    vi.mocked(f.deps.executeSend).mockImplementation(async () => ((busy = f.deps.activity.busy()), { steps: 4, notes: [] }));
    await f.run();
    await f.settle();
    expect(busy).toBe(true);
    expect(f.deps.activity.busy()).toBe(false);
  });
});

describe("runFind: keys (v2)", () => {
  const SEND = (over: Record<string, unknown> = {}) => JSON.stringify({ action: "send", target: "simpler", source: "mix", index: 1, sections: SECTIONS, ...over });

  it("Cue keys from the mix, computed from the prepared analysis signal", async () => {
    const f = setup({ modelsInstalled: false });
    await f.run();
    expect(f.payloads()[0]).toMatchObject({ mode: "cue", harmony: MIX_HARMONY, setScale: null, keyInNames: true });
    expect(f.deps.harmony).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.harmony).mock.calls[0][0]).toMatchObject({ storageDir: "/storage", hash: "abc123", source: "mix", rate: 11025 });
  });

  it("Structure with kept stems keys from the stems (asked for once, from their folder); without them, from the mix", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => p.harmony)).toEqual([MIX_HARMONY, STEMS_HARMONY]);
    const asked = vi.mocked(f.deps.harmony).mock.calls.map(([r]) => r);
    expect(asked).toEqual([expect.objectContaining({ source: "mix" }), expect.objectContaining({ source: "stems", dir: STEMS_DIR })]);

    const g = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: false, dialogResults: [SWITCH("structure"), CANCEL] });
    await g.run();
    expect(g.payloads().map((p) => p.harmony)).toEqual([MIX_HARMONY, MIX_HARMONY]);
  });

  it("a fresh Structure analysis that kept its stems keys from them", async () => {
    const f = setup({ modelsInstalled: true, stemsReady: true, lastMode: "cue", dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    await f.settle();
    expect(f.payloads().at(-1)).toMatchObject({ mode: "structure", harmony: STEMS_HARMONY });
  });

  it("concern 5: the stems' harmony of a background Structure run goes at the run's own pace; in a progress dialog, at full speed", async () => {
    const bg = setup({ modelsInstalled: true, stemsReady: true, lastMode: "cue", dialogResults: [SWITCH("structure"), CANCEL] });
    await bg.run();
    await bg.settle();
    const stemsReq = (f: typeof bg) => vi.mocked(f.deps.harmony).mock.calls.map(([r]) => r).find((r) => r.source === "stems")!;
    expect(stemsReq(bg).pace).toBe(vi.mocked(bg.deps.analyseStructure).mock.calls[0][1].pace);
    expect(stemsReq(bg).pace).toBeDefined();

    const fg = setup({
      modelsInstalled: false,
      stemsReady: true,
      dialogResults: [JSON.stringify({ action: "switch", mode: "structure", download: true }), CANCEL],
    });
    await fg.run();
    expect(fg.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(stemsReq(fg).pace).toBeUndefined();
  });

  it("no harmony (it failed) means no keys, and nothing else changes", async () => {
    const f = setup({ modelsInstalled: false, dialogResult: SEND() });
    vi.mocked(f.deps.harmony).mockRejectedValue(new Error("bad wav"));
    await f.run();
    expect(f.payloads()[0].harmony).toBeNull();
    expect(vi.mocked(f.deps.executeSend).mock.calls[0][2]).toMatchObject({ harmony: null });
    expect(f.deps.logError).toHaveBeenCalledWith(expect.stringContaining("could not find the key"), expect.any(Error));
    expect(f.messages()).toEqual([]);
  });

  it("shows the Set's scale only while Scale Mode is on", async () => {
    const on = setup({ modelsInstalled: false, scale: { scaleMode: true, rootNote: 2, scaleName: "Minor" } });
    await on.run();
    expect(on.payloads()[0].setScale).toEqual({ root: 2, name: "Minor" });
    const off = setup({ modelsInstalled: false, scale: { scaleMode: false, rootNote: 2, scaleName: "Minor" } });
    await off.run();
    expect(off.payloads()[0].setScale).toBeNull();
  });

  it("Key in names: the remembered choice opens the dialog, the send uses the dialog's, and turning it off is saved", async () => {
    const f = setup({ modelsInstalled: false, keyInNames: true, dialogResult: SEND({ keyInNames: false }) });
    await f.run();
    expect(f.payloads()[0].keyInNames).toBe(true);
    expect(vi.mocked(f.deps.executeSend).mock.calls[0][2]).toMatchObject({ keyInNames: false });
    expect(f.deps.saveSettings).toHaveBeenCalledWith("/storage", { lastMode: "cue", keyInNames: false });

    const g = setup({ modelsInstalled: false, keyInNames: false, dialogResult: apply() });
    await g.run();
    expect(g.payloads()[0].keyInNames).toBe(false);
    expect(g.deps.saveSettings).not.toHaveBeenCalled(); // nothing changed
  });

  it("a switch carries the toggle into the next dialog of the run", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [JSON.stringify({ action: "switch", mode: "structure", keyInNames: false }), CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => p.keyInNames)).toEqual([true, false]);
    expect(f.deps.saveSettings).not.toHaveBeenCalled();
  });
});

describe("runFind: pattern features (Plan 5)", () => {
  const patternsCalls = (f: ReturnType<typeof setup>) => vi.mocked(f.deps.patterns).mock.calls.map(([r]) => r);
  const order = (fn: unknown, i = 0) => vi.mocked(fn as () => void).mock.invocationCallOrder[i];

  it("Review Focus 4: a cached Structure analysis with stems opens with the patterns of its stems, asked for once", async () => {
    const cached = fakeStructureAnalysis(20);
    const f = setup({ lastMode: "structure", structureCached: cached, stemsReady: true, dialogResults: [CANCEL] });
    await f.run();
    expect(f.deps.patterns).toHaveBeenCalledTimes(1);
    expect(patternsCalls(f)[0]).toMatchObject({ storageDir: "/storage", hash: "abc123", analysis: cached, stemsDir: STEMS_DIR });
    expect(patternsCalls(f)[0].mix).toEqual({ x: prepared.analysis, rate: 11025 });
    expect(patternsCalls(f)[0].pace).toBeUndefined();
    // Right after the stems' harmony.
    const stemsHarmony = vi.mocked(f.deps.harmony).mock.calls.findIndex(([r]) => r.source === "stems");
    expect(order(f.deps.patterns)).toBeGreaterThan(order(f.deps.harmony, stemsHarmony));
    expect(f.payloads()).toEqual([expect.objectContaining({ mode: "structure", patterns: STEMS_PATTERNS })]);
  });

  it("an evicted stems folder asks for the mix's patterns", async () => {
    const f = setup({ lastMode: "structure", structureCached: fakeStructureAnalysis(20), stemsReady: false, dialogResults: [CANCEL] });
    await f.run();
    expect(patternsCalls(f)).toEqual([expect.objectContaining({ stemsDir: null })]);
    expect(f.payloads()[0]).toMatchObject({ mode: "structure", patterns: MIX_PATTERNS });
  });

  it("no patterns (they failed) still opens Structure, with patterns: null", async () => {
    const f = setup({ lastMode: "structure", structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [CANCEL] });
    vi.mocked(f.deps.patterns).mockResolvedValue(null);
    await f.run();
    expect(f.payloads()).toEqual([expect.objectContaining({ mode: "structure", patterns: null })]);
    expect(f.messages()).toEqual([]);
  });

  it("a patterns dep that throws is logged and opens Structure without them; an abort while finding them cancels quietly", async () => {
    const f = setup({ lastMode: "structure", structureCached: fakeStructureAnalysis(20), dialogResults: [CANCEL] });
    vi.mocked(f.deps.patterns).mockRejectedValue(new Error("bad wav"));
    await f.run();
    expect(f.payloads()[0]).toMatchObject({ mode: "structure", patterns: null });
    expect(f.deps.logError).toHaveBeenCalledWith(expect.stringContaining("could not find the patterns"), expect.any(Error));

    const g = setup({ lastMode: "structure", structureCached: fakeStructureAnalysis(20), dialogResults: [CANCEL] });
    vi.mocked(g.deps.patterns).mockRejectedValue(abortError());
    await g.run();
    expect(g.deps.serveDialog).not.toHaveBeenCalled();
    expect(g.messages()).toEqual([]);
  });

  it("a Cue dialog carries no patterns, also when a cached Structure analysis has them", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), stemsReady: true, dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    const [cue, structure] = f.payloads();
    expect(cue.mode).toBe("cue");
    expect("patterns" in cue).toBe(false);
    expect(structure).toMatchObject({ mode: "structure", patterns: STEMS_PATTERNS });
    expect(f.deps.patterns).toHaveBeenCalledTimes(1); // on open; the switch reuses them
  });

  it("a Cue run with nothing cached asks for no patterns", async () => {
    const f = setup({ modelsInstalled: false });
    await f.run();
    expect(f.deps.patterns).not.toHaveBeenCalled();
  });

  it("a fresh Structure analysis finds the patterns of its kept stems after their harmony, at full speed in a progress dialog", async () => {
    const f = setup({
      modelsInstalled: false,
      stemsReady: true,
      dialogResults: [JSON.stringify({ action: "switch", mode: "structure", download: true }), CANCEL],
    });
    await f.run();
    expect(f.deps.analyseStructure).toHaveBeenCalledTimes(1);
    expect(patternsCalls(f)).toEqual([expect.objectContaining({ analysis: f.structure, stemsDir: STEMS_DIR })]);
    expect(patternsCalls(f)[0].pace).toBeUndefined();
    const stemsHarmony = vi.mocked(f.deps.harmony).mock.calls.findIndex(([r]) => r.source === "stems");
    expect(order(f.deps.patterns)).toBeGreaterThan(order(f.deps.harmony, stemsHarmony));
    expect(f.payloads().at(-1)).toMatchObject({ mode: "structure", patterns: STEMS_PATTERNS });
  });

  it("a fresh analysis that kept no stems finds the mix's patterns", async () => {
    const f = setup({ modelsInstalled: false, dialogResults: [JSON.stringify({ action: "switch", mode: "structure", download: true }), CANCEL] });
    await f.run();
    expect(patternsCalls(f)).toEqual([expect.objectContaining({ stemsDir: null })]);
    expect(f.payloads().at(-1)).toMatchObject({ mode: "structure", patterns: MIX_PATTERNS });
  });

  it("a background Structure run finds them at its own pace, and the switch that joins it carries them", async () => {
    const f = setup({ modelsInstalled: true, stemsReady: true, lastMode: "cue", dialogResults: [SWITCH("structure"), CANCEL] });
    await f.run();
    await f.settle();
    expect(f.deps.patterns).toHaveBeenCalledTimes(1);
    expect(patternsCalls(f)[0].pace).toBeDefined();
    expect(patternsCalls(f)[0].pace).toBe(vi.mocked(f.deps.analyseStructure).mock.calls[0][1].pace);
    expect(f.payloads().at(-1)).toMatchObject({ mode: "structure", patterns: STEMS_PATTERNS });
  });

  it("a Re-analyze that does not finish puts the old analysis back with its patterns", async () => {
    const f = setup({ structureCached: fakeStructureAnalysis(20), abortStructure: true, dialogResults: [SWITCH("structure"), JSON.stringify({ action: "reanalyse" }), CANCEL] });
    await f.run();
    expect(f.payloads().map((p) => [p.mode, "patterns" in p ? p.patterns : "none"])).toEqual([
      ["cue", "none"],
      ["structure", MIX_PATTERNS],
      ["structure", MIX_PATTERNS],
    ]);
  });
});

describe("runFind: Apply with Slice by pieces (Plan 6, Task 6)", () => {
  const PIECES = [
    { start: 0, end: 4, label: "drums 1", color: 0x11 },
    { start: 4, end: 10, label: "drums 2", color: 0x22 },
    { start: 10, end: 20, label: "drums 1", color: 0x11 },
  ];
  const applyWith = (pieces: unknown, output = "both") => JSON.stringify({ action: "apply", sections: SECTIONS, output, pieces });
  const keys = SECTIONS.map(() => "C");

  it("passes the pieces to arrangementOps, the sections still giving the locators", async () => {
    const f = setup({ dialogResult: applyWith(PIECES) });
    await f.run();
    expect(f.deps.arrangementOps).toHaveBeenCalledWith(expect.anything(), SECTIONS, "both", 120, keys, PIECES);
    expect(f.deps.executeArrangement).toHaveBeenCalledTimes(1);
    expect(f.deps.log).toHaveBeenCalledWith(expect.stringContaining("3 drums pieces"));
  });

  it("passes the pieces to sessionOps, gaps (left-out rests) and all", async () => {
    const gapped = [PIECES[0], { ...PIECES[2], start: 12 }];
    const f = setup({ dialogResult: applyWith(gapped), info: info({ view: "session", sceneIndex: 2 }) });
    await f.run();
    expect(f.deps.sessionOps).toHaveBeenCalledWith(expect.anything(), SECTIONS, 120, keys, gapped);
    expect(f.deps.executeSession).toHaveBeenCalledTimes(1);
  });

  it("without pieces, both views call the ops exactly as before", async () => {
    const a = setup({ dialogResult: apply("both") });
    await a.run();
    expect(vi.mocked(a.deps.arrangementOps).mock.calls[0]).toEqual([expect.anything(), SECTIONS, "both", 120, keys]);
    const s = setup({ dialogResult: apply(), info: info({ view: "session", sceneIndex: 2 }) });
    await s.run();
    expect(vi.mocked(s.deps.sessionOps).mock.calls[0]).toEqual([expect.anything(), SECTIONS, 120, keys]);
  });

  it("Review Focus 4: a piece under MIN_SECTION_SEC fails assertValidSections before any Live call", async () => {
    const short = [{ ...PIECES[0], end: 0.5 }, { ...PIECES[1], start: 0.5 }, PIECES[2]];
    expect(() => assertValidSections(short, 20)).toThrow(/shorter/);
    for (const view of ["arrangement", "session"] as const) {
      const f = setup({ dialogResult: applyWith(short), info: info({ view, sceneIndex: 2 }) });
      await f.run();
      expect(f.deps.arrangementOps).not.toHaveBeenCalled();
      expect(f.deps.sessionOps).not.toHaveBeenCalled();
      expect(f.deps.executeArrangement).not.toHaveBeenCalled();
      expect(f.deps.executeSession).not.toHaveBeenCalled();
      expect(f.messages()[0]).toContain("Song Sections ran into a problem. Your Set was not changed.");
    }
  });

  it("rejects pieces that are not contiguous in Arrangement, or that overlap in Session, before any Live call", async () => {
    const gapped = [PIECES[0], { ...PIECES[2], start: 12 }];
    const overlapping = [PIECES[0], { ...PIECES[1], start: 3 }, PIECES[2]];
    for (const [pieces, view] of [[gapped, "arrangement"], [overlapping, "session"]] as const) {
      const f = setup({ dialogResult: applyWith(pieces), info: info({ view, sceneIndex: 2 }) });
      await f.run();
      expect(f.deps.executeArrangement).not.toHaveBeenCalled();
      expect(f.deps.executeSession).not.toHaveBeenCalled();
      expect(f.deps.logError).toHaveBeenCalledWith("Song Sections failed:", expect.any(Error));
    }
  });
});
