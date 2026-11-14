// Dev-only command (Plan 3, Task 10): "Analyse Structure (dev)" on an audio clip runs the real Structure engine
// on the clip's render under a progress dialog and writes what happened to <storageDirectory>/dev/. Registered by
// extension.ts only when __DEV__ (never in a production build). It changes nothing in the Set except the
// temporary render track a Session clip needs (acquireAudio deletes it again).
//
// Files, all under <storageDirectory>/dev/:
// - <clip>.structure.json   the StructureAnalysis (status "ok" only), same shape as .dev/golden/<track>.structure.json
// - <clip>.<view>.summary.json  status, stage seconds, RSS, segments, bpm, beat counts (every run, also on cancel/error)
// - last.summary.json        a copy of the latest summary, at a fixed path for whoever drives the run
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AudioClip, type ExtensionContext, type Handle } from "@ableton-extensions/sdk";
import { readPcmFile, type PcmInfo } from "../audio/pcmFile.js";
import { throwIfAborted } from "../core/abort.js";
import { acquireAudio, describeClip, type ClipInfo } from "../live/acquire.js";
import type { AnalyseStructure, StructureAnalysis, StructureStage } from "./contract.js";
import { analyseStructure } from "./engine.js";
import { modelDir, modelsInstalled } from "./models.js";
import { extensionRoot } from "./root.js";

type Ctx = ExtensionContext<"1.0.0">;

export const DEV_STRUCTURE_COMMAND = "songSections.devStructure";
export const DEV_STRUCTURE_ACTION = "Analyse Structure (dev)";
export const DEV_LOG_PREFIX = "SONG_SECTIONS_DEV";

const STAGES: StructureStage[] = ["separating", "features", "structure", "beats"];
type Phase = "rendering" | StructureStage;
export const DEV_STAGE_TEXT: Record<Phase, string> = {
  rendering: "Rendering audio…",
  separating: "1/4 Separating stems…",
  features: "2/4 Extracting features…",
  structure: "3/4 Finding sections…",
  beats: "4/4 Tracking beats…",
};

export interface DevStructureSummary {
  command: typeof DEV_STRUCTURE_COMMAND;
  status: "ok" | "cancelled" | "error";
  error?: string;
  startedAt: string; // ISO
  clip: { name: string; view: ClipInfo["view"]; warped: boolean; lengthBeats: number };
  render: (PcmInfo & { durationSec: number }) | null; // the file Live rendered (its rate is the Set's)
  /** The phase running when the run ended (the last one reached; "beats" on success). */
  lastPhase: Phase;
  /** Wall seconds per phase, from its first progress report to the next phase's; total = render + engine. */
  seconds: Partial<Record<Phase, number>> & { total: number };
  rssMB: {
    start: number;
    /** Highest process RSS sampled at each progress report during this run (misses short transients). */
    peakSampled: number;
    /** process.resourceUsage().maxRSS at the end: the peak of the whole host process, earlier runs included. */
    processMax: number;
  };
  durationSec?: number;
  inputGainDb?: number; // gain the engine applied to a quiet mix (Task 9 review I1); 0 when untouched
  bpm?: number | null;
  beats?: number;
  downbeats?: number;
  segments?: { start: number; end: number; label: string }[];
  resultPath?: string;
  summaryPath: string;
}

export interface DevStructureDeps {
  describeClip: typeof describeClip;
  acquireAudio: typeof acquireAudio;
  analyseStructure: AnalyseStructure;
  modelsInstalled(storageDir: string): Promise<boolean>;
  extensionRoot(): string;
  renderInfo(path: string): Promise<PcmInfo | null>;
  /** Best-effort delete; must not throw. */
  removeFile(path: string): Promise<void>;
  log(line: string): void;
  logError(...args: unknown[]): void;
  now(): number; // ms
  rssBytes(): number;
  maxRssBytes(): number;
}

const STOP = { stop: true };

/** Sample rate, channels and frames of a WAV/AIFF from its header alone. */
async function readRenderInfo(path: string): Promise<PcmInfo | null> {
  let info: PcmInfo | null = null;
  try {
    await readPcmFile(path, () => undefined, {
      onHeader: (h) => {
        info = h;
        throw STOP;
      },
    });
  } catch (error) {
    if (error !== STOP) return null;
  }
  return info;
}

export function defaultDevDeps(): DevStructureDeps {
  return {
    describeClip,
    acquireAudio,
    analyseStructure,
    modelsInstalled: (storageDir) => modelsInstalled(storageDir),
    extensionRoot,
    renderInfo: readRenderInfo,
    removeFile: (path) => rm(path, { force: true }).catch(() => undefined),
    log: (line) => console.log(line),
    logError: (...args) => console.error(...args),
    now: () => Date.now(),
    rssBytes: () => process.memoryUsage().rss,
    maxRssBytes: () => process.resourceUsage().maxRSS * 1024, // maxRSS is in KiB
  };
}

/** A clip name as a file name: no path separators or reserved characters, never empty or dot-leading. */
export function devFileStem(name: string): string {
  const s = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .replace(/^\.+/, "_")
    .slice(0, 100);
  return s || "clip";
}

const mb = (bytes: number) => Math.round(bytes / 1e6);
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";
const messageOf = (error: unknown) => {
  const e = error as { message?: unknown; stack?: unknown } | null;
  return typeof e?.stack === "string" ? e.stack : typeof e?.message === "string" ? e.message : String(error);
};

let running = false;

/**
 * Runs describeClip → acquireAudio → analyseStructure under one progress dialog and writes the result and a
 * summary to <storageDirectory>/dev/. Never throws; resolves to the summary (null when it could not start).
 */
export async function runDevStructure(context: Ctx, handle: Handle, deps: DevStructureDeps): Promise<DevStructureSummary | null> {
  const storageDir = context.environment.storageDirectory;
  const tempDir = context.environment.tempDirectory;
  if (!storageDir || !tempDir) {
    deps.logError(`${DEV_LOG_PREFIX}: storageDirectory/tempDirectory undefined; start the host with npm start`);
    return null;
  }
  if (running) {
    deps.logError(`${DEV_LOG_PREFIX}: a run is already in progress; ignored`);
    return null;
  }
  running = true;
  const t0 = deps.now();
  const devDir = join(storageDir, "dev");
  let renderedPath: string | undefined;
  let info: ClipInfo | undefined;
  let phase: Phase = "rendering";
  const phaseStart: Partial<Record<Phase, number>> = { rendering: t0 };
  const rssStart = deps.rssBytes();
  let rssPeak = rssStart;
  let render: DevStructureSummary["render"] = null;
  let analysis: StructureAnalysis | undefined;
  let status: DevStructureSummary["status"] = "ok";
  let errorText: string | undefined;

  const enter = (p: Phase) => {
    if (phaseStart[p] === undefined) phaseStart[p] = deps.now();
    phase = p;
  };
  const sample = () => {
    rssPeak = Math.max(rssPeak, deps.rssBytes());
  };

  try {
    info = deps.describeClip(context, context.getObjectFromHandle(handle, AudioClip));
    const clip = info;
    if (!(await deps.modelsInstalled(storageDir))) {
      throw new Error(`Models not installed in ${modelDir(storageDir)}. Run: npm run models:dev -- <checkpoint dir> "${storageDir}"`);
    }
    let signal: AbortSignal | undefined;
    try {
      await context.ui.withinProgressDialog(`${DEV_STRUCTURE_ACTION}: ${clip.name}`, { progress: 0 }, async (update, s) => {
        signal = s;
        let last = "";
        const report = (text: string, pct: number) => {
          const key = `${text}|${pct}`;
          if (key === last) return;
          last = key;
          void update(text, pct).catch(() => undefined);
        };
        report(DEV_STAGE_TEXT.rendering, 0);
        renderedPath = await deps.acquireAudio(context, clip, s);
        throwIfAborted(s);
        const header = await deps.renderInfo(renderedPath);
        render = header ? { ...header, durationSec: header.frames / header.sampleRate } : null;
        const env = { modelDir: modelDir(storageDir), tempDir, storageDir, extensionRoot: deps.extensionRoot() };
        analysis = await deps.analyseStructure(renderedPath, env, s, (fraction, stage) => {
          enter(stage);
          sample();
          report(DEV_STAGE_TEXT[stage], Math.round(100 * Math.min(1, Math.max(0, fraction))));
        });
        throwIfAborted(s);
      });
    } catch (error) {
      if (!(isAbort(error) || signal?.aborted)) throw error;
      status = "cancelled";
    }
    if (status === "ok" && (signal?.aborted || !analysis)) status = "cancelled";
  } catch (error) {
    status = "error";
    errorText = messageOf(error);
    deps.logError(`${DEV_LOG_PREFIX}: failed:`, error);
  } finally {
    running = false;
    if (renderedPath) await deps.removeFile(renderedPath);
  }

  sample();
  const end = deps.now();
  const seconds: DevStructureSummary["seconds"] = { total: round3((end - t0) / 1000) };
  const order: Phase[] = ["rendering", ...STAGES];
  for (let i = 0; i < order.length; i++) {
    const start = phaseStart[order[i]];
    if (start === undefined) continue;
    const next = order.slice(i + 1).map((p) => phaseStart[p]).find((t) => t !== undefined) ?? end;
    seconds[order[i]] = round3((next - start) / 1000);
  }

  const stem = devFileStem(info?.name ?? "clip");
  const summaryPath = join(devDir, `${stem}.${info?.view ?? "unknown"}.summary.json`);
  const summary: DevStructureSummary = {
    command: DEV_STRUCTURE_COMMAND,
    status,
    ...(errorText !== undefined ? { error: errorText } : {}),
    startedAt: new Date(t0).toISOString(),
    clip: { name: info?.name ?? "", view: info?.view ?? "arrangement", warped: info?.warped ?? false, lengthBeats: info?.lengthBeats ?? 0 },
    render,
    lastPhase: phase,
    seconds,
    rssMB: { start: mb(rssStart), peakSampled: mb(rssPeak), processMax: mb(deps.maxRssBytes()) },
    summaryPath,
  };
  if (status === "ok" && analysis) {
    const a: StructureAnalysis = analysis;
    Object.assign(summary, {
      durationSec: a.durationSec,
      inputGainDb: a.inputGainDb,
      bpm: a.bpm,
      beats: a.beats.length,
      downbeats: a.downbeats.length,
      segments: a.segments.map((s) => ({ start: round3(s.start), end: round3(s.end), label: s.label })),
      resultPath: join(devDir, `${stem}.structure.json`),
    });
  }

  try {
    await mkdir(devDir, { recursive: true });
    if (summary.resultPath && analysis) await writeFile(summary.resultPath, JSON.stringify(analysis));
    const text = JSON.stringify(summary, null, 1);
    await writeFile(summaryPath, text);
    await writeFile(join(devDir, "last.summary.json"), text);
  } catch (error) {
    deps.logError(`${DEV_LOG_PREFIX}: could not write ${devDir}:`, error);
  }
  const { segments, ...rest } = summary;
  const segText = segments?.map((s) => `${s.start.toFixed(2)} ${s.label}`).join(" | ");
  deps.log(`${DEV_LOG_PREFIX} ${JSON.stringify({ ...rest, segments: segText })}`);
  return summary;
}

/** Registers the dev command and its AudioClip context-menu item. extension.ts calls this only when __DEV__. */
export function registerDevStructure(context: Ctx, deps: DevStructureDeps = defaultDevDeps()): void {
  context.commands.registerCommand(DEV_STRUCTURE_COMMAND, (handle) => void runDevStructure(context, handle as Handle, deps));
  context.ui.registerContextMenuAction("AudioClip", DEV_STRUCTURE_ACTION, DEV_STRUCTURE_COMMAND);
}
