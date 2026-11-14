import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Handle } from "@ableton-extensions/sdk";
import { abortError } from "../core/abort.js";
import type { ClipInfo } from "../live/acquire.js";
import type { StructureStage } from "./contract.js";
import {
  DEV_LOG_PREFIX,
  DEV_STAGE_TEXT,
  DEV_STRUCTURE_ACTION,
  DEV_STRUCTURE_COMMAND,
  devFileStem,
  registerDevStructure,
  runDevStructure,
  type DevStructureDeps,
  type DevStructureSummary,
} from "./devCommand.js";
import { fakeStructureAnalysis } from "./fake.js";
import { modelDir } from "./models.js";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function info(over: Partial<ClipInfo> = {}): ClipInfo {
  return { view: "arrangement", name: "Flim", warped: false, lengthBeats: 442.8, ...over } as unknown as ClipInfo;
}

interface Opts {
  info?: ClipInfo;
  models?: boolean;
  /** Abort the dialog's signal when this stage is first reported. */
  abortAt?: StructureStage;
  fail?: Error;
  storage?: string | undefined;
}

function setup(opts: Opts = {}) {
  const storage = "storage" in opts ? opts.storage : mkdtempSync(join(tmpdir(), "ss-dev-"));
  if (storage) temps.push(storage);
  const controller = new AbortController();
  const updates: Array<[string, number | undefined]> = [];
  const titles: string[] = [];
  const context = {
    environment: { storageDirectory: storage, tempDirectory: "/temp" },
    getObjectFromHandle: vi.fn(() => ({ fake: "clip" })),
    commands: { registerCommand: vi.fn() },
    ui: {
      registerContextMenuAction: vi.fn(),
      withinProgressDialog: vi.fn(async (title: string, _o: unknown, cb: (u: (t: string, p?: number) => Promise<void>, s: AbortSignal) => Promise<unknown>) => {
        titles.push(title);
        return cb(async (t, p) => void updates.push([t, p]), controller.signal);
      }),
    },
  };
  let clock = 1_000_000;
  let rss = 500e6;
  const analysis = { ...fakeStructureAnalysis(30), inputGainDb: 4.5 };
  const logs: string[] = [];
  const deps: DevStructureDeps = {
    describeClip: vi.fn(() => opts.info ?? info()),
    acquireAudio: vi.fn(async () => {
      clock += 2000; // render: 2 s
      return "/var/render.wav";
    }),
    analyseStructure: vi.fn(async (_path, _env, signal, onProgress) => {
      const steps: Array<[number, StructureStage, number]> = [
        [0.05, "separating", 40_000],
        [0.6, "features", 5_000],
        [0.7, "structure", 16_000],
        [0.95, "beats", 4_000],
      ];
      for (const [f, stage, ms] of steps) {
        onProgress(f, stage);
        if (opts.abortAt === stage) controller.abort();
        if (signal.aborted) throw abortError();
        if (opts.fail && stage === "features") throw opts.fail;
        rss += 300e6;
        clock += ms;
      }
      onProgress(1, "beats");
      return analysis;
    }),
    modelsInstalled: vi.fn(async () => opts.models ?? true),
    extensionRoot: vi.fn(() => "/ext"),
    renderInfo: vi.fn(async () => ({ sampleRate: 48000, channels: 2, frames: 48000 * 30 })),
    removeFile: vi.fn(async () => undefined),
    log: vi.fn((line: string) => void logs.push(line)),
    logError: vi.fn(),
    now: () => clock,
    rssBytes: () => rss,
    maxRssBytes: () => 2_000e6,
  };
  const run = () => runDevStructure(context as never, "h" as unknown as Handle, deps);
  return { context, deps, storage, updates, titles, analysis, logs, run, controller };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as DevStructureSummary;

describe("Analyse Structure (dev)", () => {
  it("renders, analyses with the installed models, and writes the result and a summary to <storage>/dev", async () => {
    const h = setup();
    const s = (await h.run())!;
    const dev = join(h.storage!, "dev");

    expect(h.titles).toEqual([`${DEV_STRUCTURE_ACTION}: Flim`]);
    const env = vi.mocked(h.deps.analyseStructure).mock.calls[0][1];
    expect(vi.mocked(h.deps.analyseStructure).mock.calls[0][0]).toBe("/var/render.wav");
    expect(env).toEqual({ modelDir: modelDir(h.storage!), tempDir: "/temp", storageDir: h.storage, extensionRoot: "/ext" });

    expect(JSON.parse(readFileSync(join(dev, "Flim.structure.json"), "utf8"))).toEqual(h.analysis);
    expect(s.status).toBe("ok");
    expect(s.resultPath).toBe(join(dev, "Flim.structure.json"));
    expect(s.summaryPath).toBe(join(dev, "Flim.arrangement.summary.json"));
    expect(readJson(s.summaryPath)).toEqual(s);
    expect(readJson(join(dev, "last.summary.json"))).toEqual(s);

    expect(s.clip).toEqual({ name: "Flim", view: "arrangement", warped: false, lengthBeats: 442.8 });
    expect(s.render).toEqual({ sampleRate: 48000, channels: 2, frames: 1_440_000, durationSec: 30 });
    expect(s.segments).toEqual(h.analysis.segments.map((x) => ({ start: x.start, end: x.end, label: x.label })));
    expect(s.bpm).toBe(h.analysis.bpm);
    expect(s.beats).toBe(h.analysis.beats.length);
    expect(s.downbeats).toBe(h.analysis.downbeats.length);
    expect(s.durationSec).toBe(30);
    expect(s.inputGainDb).toBe(4.5);
    expect(s.lastPhase).toBe("beats");
    expect(s.seconds).toEqual({ rendering: 2, separating: 40, features: 5, structure: 16, beats: 4, total: 67 });
    expect(s.rssMB).toEqual({ start: 500, peakSampled: 1700, processMax: 2000 });

    expect(h.deps.removeFile).toHaveBeenCalledWith("/var/render.wav");
    const line = h.logs.find((l) => l.startsWith(DEV_LOG_PREFIX))!;
    expect(line).toContain('"status":"ok"');
    expect(line).toContain(h.analysis.segments[1].label);
  });

  it("shows each stage in the progress dialog, in order, with a rising percentage", async () => {
    const h = setup();
    await h.run();
    const texts = h.updates.map(([t]) => t).filter((t, i, a) => t !== a[i - 1]);
    expect(texts).toEqual([DEV_STAGE_TEXT.rendering, DEV_STAGE_TEXT.separating, DEV_STAGE_TEXT.features, DEV_STAGE_TEXT.structure, DEV_STAGE_TEXT.beats]);
    const pcts = h.updates.map(([, p]) => p!);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(pcts.at(-1)).toBe(100);
  });

  it("cancel mid-run writes a 'cancelled' summary with the stages reached and no result", async () => {
    const h = setup({ abortAt: "features" });
    const s = (await h.run())!;
    expect(s.status).toBe("cancelled");
    expect(s.lastPhase).toBe("features");
    expect(s.seconds).toEqual({ rendering: 2, separating: 40, features: 0, total: 42 });
    expect(s.resultPath).toBeUndefined();
    expect(s.segments).toBeUndefined();
    expect(existsSync(join(h.storage!, "dev", "Flim.structure.json"))).toBe(false);
    expect(readJson(join(h.storage!, "dev", "last.summary.json")).status).toBe("cancelled");
    expect(h.deps.removeFile).toHaveBeenCalledWith("/var/render.wav");
    expect(h.deps.logError).not.toHaveBeenCalled();
  });

  it("an engine error is logged and written as status 'error' with the message; it does not throw", async () => {
    const h = setup({ fail: new Error("fold exploded") });
    const s = (await h.run())!;
    expect(s.status).toBe("error");
    expect(s.error).toContain("fold exploded");
    expect(s.lastPhase).toBe("features");
    expect(h.deps.logError).toHaveBeenCalled();
    expect(readJson(join(h.storage!, "dev", "last.summary.json")).error).toContain("fold exploded");
    expect(h.deps.removeFile).toHaveBeenCalledWith("/var/render.wav");
  });

  it("without installed models it says how to install them and does not render", async () => {
    const h = setup({ models: false });
    const s = (await h.run())!;
    expect(s.status).toBe("error");
    expect(s.error).toContain("npm run models:dev");
    expect(h.deps.acquireAudio).not.toHaveBeenCalled();
    expect(h.context.ui.withinProgressDialog).not.toHaveBeenCalled();
  });

  it("names the summary by view, so an Arrangement and a Session run of one clip keep separate summaries", async () => {
    const h = setup({ info: info({ view: "session", name: "SS-scratch Flim" }) });
    const s = (await h.run())!;
    expect(s.summaryPath).toBe(join(h.storage!, "dev", "SS-scratch Flim.session.summary.json"));
    expect(s.clip.view).toBe("session");
  });

  it("does nothing without storage and temp directories", async () => {
    const h = setup({ storage: undefined });
    expect(await h.run()).toBeNull();
    expect(h.deps.logError).toHaveBeenCalled();
    expect(h.deps.acquireAudio).not.toHaveBeenCalled();
  });

  it("ignores a second invocation while one is running", async () => {
    const h = setup();
    let release!: () => void;
    vi.mocked(h.deps.acquireAudio).mockImplementationOnce(() => new Promise((r) => (release = () => r("/var/render.wav"))));
    const first = h.run();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await h.run()).toBeNull();
    release();
    expect((await first)!.status).toBe("ok");
  });

  it("registers one command and one AudioClip context-menu item", () => {
    const h = setup();
    registerDevStructure(h.context as never, h.deps);
    expect(h.context.commands.registerCommand).toHaveBeenCalledWith(DEV_STRUCTURE_COMMAND, expect.any(Function));
    expect(h.context.ui.registerContextMenuAction).toHaveBeenCalledWith("AudioClip", "Analyse Structure (dev)", "songSections.devStructure");
  });
});

describe("devFileStem", () => {
  it("keeps ordinary names and replaces path separators and reserved characters", () => {
    expect(devFileStem("SS-scratch Flim")).toBe("SS-scratch Flim");
    expect(devFileStem("a/b\\c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(devFileStem("../up")).toBe("__up");
  });
  it("never returns an empty or dot-leading name", () => {
    expect(devFileStem("   ")).toBe("clip");
    expect(devFileStem(".hidden")).toBe("_hidden");
    expect(devFileStem("..")).toBe("_");
    expect(devFileStem("x".repeat(300))).toHaveLength(100);
  });
});
