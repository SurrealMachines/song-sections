import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AudioClip, type ExtensionContext, type Handle } from "@ableton-extensions/sdk";
import { analyseCue, DEFAULT_GRANULARITY, type CueAnalysis } from "./analysis/cue.js";
import { loadCached, saveCached } from "./analysis/cache.js";
import { prepareAudio, type PreparedAudio } from "./audio/prepare.js";
import {
  DEFAULT_STRUCTURE_PREFS,
  DIALOG_SIZE,
  injectPayload,
  parseResult,
  type DialogMode,
  type DialogPayload,
  type Harmony,
  type ModeInfo,
  type SetScale,
  type StructurePrefs,
  type StructureProgress,
} from "./dialog/protocol.js";
import { barGrid, cueBeatGrid } from "./core/beatGrid.js";
import { assertValidPieces, MIN_SECTION_SEC } from "./core/sections.js";
import type { Section } from "./core/types.js";
import { acquireAudio, describeClip, type ClipInfo } from "./live/acquire.js";
import { arrangementOps } from "./live/arrangementOps.js";
import { serveDialog } from "./live/dialogServer.js";
import { openInBrowser } from "./live/openUrl.js";
import { applySummary } from "./dialog/applySummary.js";
import {
  dialogPacer,
  dialogSummary,
  PAGE_WATCHDOG_MS,
  pageStallMessage,
  realClock,
  UPDATE_FLUSH_MS,
  type Clock,
  type DialogPacer,
} from "./live/dialogPacing.js";
import { ArrangementApplyError, executeArrangement, executeSession } from "./live/execute.js";
import { sessionOps } from "./live/sessionOps.js";
import { sectionKeys } from "./key/key.js";
import { executeSend, nameKey, SendError, sendFailedMessage } from "./live/send.js";
import { throwIfAborted } from "./core/abort.js";
import { settledOrAborted, startBackground, type BackgroundRun } from "./core/background.js";
import { sharedFile, type SharedFile } from "./core/sharedFile.js";
import { backgroundPace, hostActivity, type BackgroundPace, type HostActivity } from "./core/pace.js";
import { loadSettings, saveSettings } from "./settings.js";
import { cachedHarmony, mixHarmony, stemsHarmony } from "./key/harmony.js";
import type { PatternFeatures } from "./patterns/contract.js";
import { cachedPatterns, computePatterns, type PatternsRequest } from "./patterns/host.js";
import {
  estimateStructureSec,
  PEAK_RATE,
  STEM_NAMES,
  STRUCTURE_ENGINE,
  STRUCTURE_MAX_SEC,
  STRUCTURE_WARN_SEC,
  type AnalyseStructure,
  type EnsureModels,
  type StemName,
  type StructureAnalysis,
  type StructureStage,
} from "./structure/contract.js";
import { auditionDir, auditionReady, pruneAuditions, touchAudition } from "./structure/audition.js";
import { analyseStructure } from "./structure/engine.js";
import { downloadConsent } from "./dialog/modeChoice.js";
import {
  ensureModels,
  MODEL_DISK_BYTES,
  MODEL_DOWNLOAD_BYTES,
  modelDir,
  modelsInstalled,
  ModelsUnavailableError,
} from "./structure/models.js";
import { extensionRoot } from "./structure/root.js";
import { assertSupportedPlatform } from "./structure/runtime.js";

type Ctx = ExtensionContext<"1.0.0">;

const ENGINE = "cue-dsp-1";

/**
 * Snap to Bars assumes 4/4: the extensions SDK (1.0.0-beta.0) has no Song.signatureNumerator/Denominator (only
 * Scene has them), so the song's time signature cannot be read. barGrid() takes any signature once it can.
 */
const SONG_SIGNATURE = { numerator: 4, denominator: 4 };

/** At most this many dialogs per invocation; a runaway switch loop then just closes. */
const MAX_DIALOGS = 20;
/** Numbered as in the dev command, with the first-run hint: this only runs when the clip is not in the cache. */
const CACHE_HINT = " (results are cached for next time)";
const STAGE_TEXT: Record<StructureStage, string> = {
  separating: "1/4 Separating stems…" + CACHE_HINT,
  features: "2/4 Extracting features…" + CACHE_HINT,
  structure: "3/4 Finding sections…" + CACHE_HINT,
  beats: "4/4 Tracking beats…" + CACHE_HINT,
};

const MSG_NO_DIRS =
  "Song Sections needs a storage and a temp directory, but Live did not provide one. " +
  "Run the extension with npm start (it passes --storage-directory and --temp-directory).";
const MSG_FAILED = "Song Sections ran into a problem. Your Set was not changed.";
const MSG_MODELS = "Structure analysis needs its models, which are not installed yet.";
const MSG_STRUCTURE_UNAVAILABLE = "Structure analysis is not available right now. Cue points still work.";
const MSG_STRUCTURE_FAILED = "Song Sections couldn't analyze the structure of this clip. Your Set was not changed.";
const msgTooLong = () =>
  `Structure works on clips up to ${STRUCTURE_MAX_SEC / 60} minutes. Use Cue points for longer recordings.`;
const MSG_APPLY_FAILED =
  "Song Sections couldn't finish applying sections. Use Edit › Undo to restore the original.";

/** Arrangement apply failed after `steps` Set changes (cuts and locators) had already completed. */
const applyFailedMessage = (steps: number) =>
  `Song Sections couldn't finish applying sections. Use Edit › Undo ${steps === 1 ? "once" : `${steps} times`} to restore the original.`;

/** Collaborators of runFind, injectable for tests. */
export interface FlowDeps {
  dialogHtml: string;
  describeClip: typeof describeClip;
  acquireAudio: typeof acquireAudio;
  prepareAudio: typeof prepareAudio;
  analyseCue: typeof analyseCue;
  loadCached: typeof loadCached;
  saveCached: typeof saveCached;
  serveDialog: typeof serveDialog;
  /** Opens an About link in the system browser (the dialog's About panel). */
  openUrl?: (url: string) => Promise<boolean>;
  arrangementOps: typeof arrangementOps;
  sessionOps: typeof sessionOps;
  executeArrangement: typeof executeArrangement;
  executeSession: typeof executeSession;
  /** v2: a send from the dialog (live/send.ts). */
  executeSend: typeof executeSend;
  /** Best-effort delete; must not throw. */
  removeFile(path: string): Promise<void>;
  logError(...args: unknown[]): void;
  /** Info lines for the host log (one per modal dialog: how its page loaded; one per Apply: what it changed). */
  log(...args: unknown[]): void;
  /** Time and timers for dialog pacing and the page watchdog. */
  clock: Clock;
  analyseStructure: AnalyseStructure;
  ensureModels: EnsureModels;
  modelsInstalled(storageDir: string): Promise<boolean>;
  extensionRoot(): string;
  /** Throws OrtUnsupportedPlatformError (Plan 3 Task 1) when this machine cannot run the Structure engine. */
  assertStructurePlatform(): void;
  loadSettings: typeof loadSettings;
  saveSettings: typeof saveSettings;
  /**
   * v2, key per section: the harmonic chroma of this audio, from the mix (the prepared analysis signal) or from the kept
   * stems, cached (key/harmony.ts). null: none could be computed (the dialog shows no keys). Throws only an abort.
   */
  harmony(req: HarmonyRequest, signal?: AbortSignal): Promise<Harmony | null>;
  /**
   * Plan 5: the pattern engine's feature cells and bar grid of a clip with a Structure analysis, from the mix and the
   * kept stems, cached (patterns/host.ts). null: none could be computed (no pattern lanes). Throws only an abort.
   */
  patterns(req: PatternsRequest, signal?: AbortSignal): Promise<PatternFeatures | null>;
  /** Feedback round 2 B: the stems kept for audition (structure/audition.ts). */
  auditionReady(dir: string): Promise<boolean>;
  touchAudition(dir: string): Promise<void>;
  pruneAuditions(storageDir: string, keepKey: string): Promise<string[]>;
  /** fb2: the background Structure analysis, shared by every run so a new one can join or stop it. */
  background: BackgroundSlot;
  /**
   * fb2 review I1/I2: the host's foreground work, which a background analysis gives way to. Shared by every run: a run
   * is busy except while it waits on the user in a dialog, and the dialog server marks the page's requests.
   */
  activity: HostActivity;
}

/** What the harmony of a clip is computed from (FlowDeps.harmony). */
export type HarmonyRequest = {
  storageDir: string;
  hash: string;
  /** How the computing yields: a background Structure run's own pace (absent: the foreground). */
  pace?: BackgroundPace;
} & (
  | { source: "mix"; x: Float32Array; rate: number }
  | { source: "stems"; dir: string }
);

/**
 * A finished Structure analysis and the audition stem folder it kept (null: none), the stems' harmony (v2), and the
 * pattern features of the stems or, without them, the mix (Plan 5).
 */
export interface StructureRun {
  analysis: StructureAnalysis;
  stemsDir: string | null;
  harmony?: Harmony | null;
  patterns?: PatternFeatures | null;
}

/** Which step a Structure analysis is in: a failure while getting the models may be a retryable download error. */
interface Phase {
  phase: "models" | "analysis";
}

/** fb2: a Structure analysis running in the host while the Cue dialog is open, keyed on the clip's audio hash. */
export interface BackgroundStructure {
  run: BackgroundRun<StructureRun>;
  at: Phase;
  /** How it shares the host (core/pace.ts); a dialog that waits for it attaches, so it runs at full speed. */
  pace: BackgroundPace;
}

/** At most one background Structure analysis per extension (fb2 ruling: only one runs at a time). */
export interface BackgroundSlot {
  current: BackgroundStructure | null;
}

/** The real modules. The dialog HTML is passed in because only the esbuild bundle can import it. */
export function defaultDeps(dialogHtml: string): FlowDeps {
  return {
    dialogHtml,
    describeClip,
    acquireAudio,
    prepareAudio,
    analyseCue,
    loadCached,
    saveCached,
    serveDialog,
    openUrl: (url) => openInBrowser(url),
    arrangementOps,
    sessionOps,
    executeArrangement,
    executeSession,
    executeSend,
    removeFile: (path) => rm(path, { force: true }).catch(() => undefined),
    logError: (...args) => console.error(...args),
    log: (...args) => console.log(...args),
    clock: realClock,
    analyseStructure,
    ensureModels,
    modelsInstalled: (storageDir) => modelsInstalled(storageDir),
    extensionRoot,
    assertStructurePlatform: () => assertSupportedPlatform(),
    loadSettings,
    saveSettings,
    harmony: (req, signal) =>
      cachedHarmony({ loadCached, saveCached, logError: (...args) => console.error(...args) }, req.storageDir, req.hash, req.source, () =>
        req.source === "mix" ? mixHarmony(req.x, req.rate, signal, req.pace) : stemsHarmony(req.dir, signal, req.pace),
      ),
    patterns: (req, signal) => cachedPatterns({ loadCached, saveCached, logError: (...args) => console.error(...args) }, req, computePatterns, signal),
    auditionReady,
    touchAudition,
    pruneAuditions: (storageDir, keepKey) => pruneAuditions(storageDir, keepKey),
    background: { current: null },
    activity: hostActivity(),
  };
}

/**
 * v2: the Set's scale when Live's Scale Mode is on (shown beside the clip's key, read-only), else null. Never throws:
 * a Song without these getters (an older Live) shows no scale.
 */
function setScaleOf(context: Ctx, deps: Pick<FlowDeps, "logError">): SetScale | null {
  try {
    const song = context.application.song;
    if (song.scaleMode !== true) return null;
    const root = song.rootNote;
    const name = song.scaleName;
    return Number.isInteger(root) && root >= 0 && root < 12 && typeof name === "string" && name !== "" ? { root, name } : null;
  } catch (error) {
    deps.logError("Song Sections: could not read the Set's scale:", error);
    return null;
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EPIPE",
]);

/**
 * An `ensureModels` failure a second attempt can fix (the .part is kept, so a retry resumes): a network error, a
 * timeout, a non-2xx status or stall (`Model download failed: …` / `Model download stalled: …`), or a checksum
 * mismatch that survived the built-in retry (ModelChecksumError). Matched by name, message and code, never by
 * `instanceof`: fetch errors may come from the host realm.
 */
function isTransientDownloadError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown } | null } | null;
  if (typeof e !== "object" || e === null) return false;
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (name === "ModelChecksumError" || name === "TimeoutError") return true;
  if (/^Model download (failed|stalled):/.test(message)) return true;
  const code = typeof e.code === "string" ? e.code : typeof e.cause?.code === "string" ? e.cause.code : "";
  if (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_")) return true;
  return name === "TypeError" && /fetch failed|network|terminated/i.test(message);
}

const downloadFailedReason = (error: unknown) =>
  `Downloading the analysis models failed (${String((error as { message?: unknown } | null)?.message ?? error)}).`;

/** Plan 3 Task 1's OrtUnsupportedPlatformError, matched by name so the flow does not load the ORT runtime module. */
function isUnsupportedPlatform(error: unknown): error is Error {
  return error instanceof Error && error.name === "OrtUnsupportedPlatformError";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A tiny page (well under the data: URL limit, F6b) with an OK button that closes it. */
function messagePage(text: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
body{font:13px -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#2b2b2b;color:#ddd;display:flex;flex-direction:column;height:calc(100vh - 32px)}
p{flex:1;margin:0;line-height:1.4}button{align-self:flex-end;padding:4px 18px}
</style><p>${escapeHtml(text)}</p><button id="ok" autofocus>OK</button><script>
document.getElementById("ok").onclick=function(){var m={method:"close_and_send",params:["ok"]};
if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);
else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);};
</script>`;
}

/** fb/hfmodels: `text` with Download and Not now; Download closes with "download", anything else is Not now. */
function consentPage(text: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
body{font:13px -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#2b2b2b;color:#ddd;display:flex;flex-direction:column;height:calc(100vh - 32px)}
p{flex:1;margin:0;line-height:1.4}div{align-self:flex-end;display:flex;gap:8px}button{padding:4px 18px}
</style><p>${escapeHtml(text)}</p><div><button id="no">Not now</button><button id="yes" autofocus>Download</button></div><script>
function send(v){var m={method:"close_and_send",params:[v]};
if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);
else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);}
document.getElementById("yes").onclick=function(){send("download")};document.getElementById("no").onclick=function(){send("cancel")};
</script>`;
}

async function showMessage(
  context: Ctx,
  deps: FlowDeps,
  dialogs: DialogPacer,
  text: string,
  onUser: <T>(wait: () => Promise<T>) => Promise<T> = (wait) => wait(),
): Promise<void> {
  try {
    await dialogs.beforeOpen();
    await onUser(() => context.ui.showModalDialog("data:text/html;charset=utf-8," + encodeURIComponent(messagePage(text)), 420, 160));
  } catch (error) {
    deps.logError("Song Sections: could not show message:", text, error);
  } finally {
    dialogs.closed();
  }
}

const EPSILON_SEC = 1e-3;

/**
 * parseResult only type-checks. Before anything touches the Set, require a non-empty,
 * finite, sorted, contiguous run of sections inside [0, durationSec]: the split ops
 * cut the clip at every section edge (Arrangement) or rebuild every slice (Session), so an
 * empty or bogus list would cut or rebuild it in the wrong places.
 * Plan 6 (Review Focus 4): with more than one, each is at least MIN_SECTION_SEC long, as the dialog's edits keep them
 * (a lone section is the whole clip, whatever its length). Arrangement's Slice by pieces are checked here too.
 */
export function assertValidSections(sections: Section[], durationSec: number): void {
  const fail = (why: string) => {
    throw new Error(`Invalid sections from dialog: ${why}`);
  };
  if (sections.length === 0) fail("empty");
  sections.forEach((s, i) => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) fail(`section ${i} is not finite`);
    if (s.start < 0) fail(`section ${i} starts before 0`);
    if (s.end > durationSec + EPSILON_SEC) fail(`section ${i} ends after the clip`);
    if (s.start >= s.end) fail(`section ${i} is empty or reversed`);
    if (sections.length > 1 && s.end - s.start < MIN_SECTION_SEC - EPSILON_SEC) fail(`section ${i} is shorter than ${MIN_SECTION_SEC} s`);
    if (i > 0 && Math.abs(s.start - sections[i - 1].end) > EPSILON_SEC) fail(`section ${i} is not contiguous`);
  });
}

function isCueAnalysis(v: unknown): v is CueAnalysis {
  const a = v as CueAnalysis | null;
  return a?.engine === ENGINE && Array.isArray(a.novelty) && Array.isArray(a.boundaries) && a.blocksPerSec === 2;
}

/** A cached Structure result is used only when it is this engine's and its shape is intact. */
export function isStructureAnalysis(v: unknown): v is StructureAnalysis {
  const a = v as StructureAnalysis | null;
  return (
    typeof a === "object" &&
    a !== null &&
    a.engine === STRUCTURE_ENGINE &&
    Array.isArray(a.segments) &&
    typeof a.durationSec === "number" &&
    a.frames === Math.ceil(a.durationSec * 2) &&
    Array.isArray(a.boundaryCandidates) &&
    // Every segment start after the first is a candidate as the same float (contract); a dev-era result with
    // placeholder [] candidates fails this and is re-analysed.
    a.segments.slice(1).every((seg) => a.boundaryCandidates.some((c) => c?.time === seg?.start)) &&
    typeof a.stems === "object" &&
    a.stems !== null &&
    STEM_NAMES.every((s) => s in a.stems && Array.isArray(a.stems[s]?.peak) && a.stems[s].peak.length === Math.ceil(a.durationSec * PEAK_RATE))
  );
}

type Update = (text: string, progress?: number) => Promise<void>;

/**
 * Runs `body` under a progress dialog. Resolves true when it finished, false when the user cancelled
 * (an AbortError or an aborted signal); any other error is rethrown.
 *
 * The dialog opens at least DIALOG_GAP_MS after the previous one closed, and a finished body waits (up to
 * UPDATE_FLUSH_MS) for Live to answer the fire-and-forget updates still in flight, so the SDK's close is the last
 * message the dialog gets (see dialogPacing.ts).
 */
async function inProgress(
  context: Ctx,
  dialogs: DialogPacer,
  clock: Clock,
  title: string,
  body: (update: Update, signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
  let signal: AbortSignal | undefined;
  await dialogs.beforeOpen();
  try {
    await context.ui.withinProgressDialog(title, { progress: 0 }, async (update, s) => {
      signal = s;
      const pending = new Set<Promise<void>>();
      const tracked: Update = (text, progress) => {
        const sent = update(text, progress);
        pending.add(sent);
        const settle = () => void pending.delete(sent);
        sent.then(settle, settle);
        return sent;
      };
      await body(tracked, s);
      // A cancelled dialog is already gone in Live and may never answer, so only a finished body waits.
      if (!s.aborted && pending.size > 0) await Promise.race([Promise.allSettled([...pending]), clock.sleep(UPDATE_FLUSH_MS)]);
    });
  } catch (error) {
    if (isAbort(error) || signal?.aborted) return false;
    throw error;
  } finally {
    dialogs.closed();
  }
  return !signal?.aborted;
}

/** Fire-and-forget progress updates, sent only when the text or the percentage changes. */
function reporter(update: Update): (text: string, pct: number) => void {
  let last = "";
  return (text, pct) => {
    const key = `${text}|${pct}`;
    if (key === last) return;
    last = key;
    void update(text, pct).catch(() => undefined);
  };
}

const percent = (fraction: number) => Math.round(100 * Math.min(1, Math.max(0, fraction)));
const megabytes = (bytes: number) => Math.round(bytes / 1e6);

/**
 * Find Sections on the clip behind `handle`: render the audio once, analyse it for Cue points under a progress
 * dialog, and show the Cue dialog. Switching mode closes the dialog; the other mode is analysed (or taken from memory
 * or the cache) and the dialog reopens. Apply writes the user's sections to the Set. Cancelling at any point leaves
 * the Live Set untouched (apart from the temp-track undo entries of F4).
 *
 * fb2: a run opens in Cue, unless the last mode applied was Structure and this clip's Structure analysis is cached
 * (then it opens Structure, as there is nothing to wait for). When the last mode was Structure and the analysis is not
 * cached, it starts in the host as soon as the Cue page is up (models installed and the clip under the warn length:
 * nothing downloads, nothing long starts unasked). A switch to Structure joins it under a progress dialog, or opens
 * at once when it is done; it finishes and caches after a Cue Apply or Cancel too. Its errors surface only on a switch.
 */
export async function runFind(context: Ctx, handle: Handle, deps: FlowDeps): Promise<void> {
  const storageDir = context.environment.storageDirectory;
  const tempDir = context.environment.tempDirectory;
  // Every dialog of this run opens through `dialogs`, so none opens in the same moment the previous one closed.
  const dialogs = dialogPacer(deps.clock);
  const progressDialog = (title: string, body: (update: Update, signal: AbortSignal) => Promise<void>) =>
    inProgress(context, dialogs, deps.clock, title, body);
  // fb2 review I1/I2: this run is foreground work (it renders, analyses and applies through Live) except while a
  // dialog waits on the user; a background analysis gives way to it meanwhile.
  let endBusy = deps.activity.begin();
  const onUser = async <T>(wait: () => Promise<T>): Promise<T> => {
    endBusy();
    try {
      return await wait();
    } finally {
      endBusy = deps.activity.begin();
    }
  };
  const say = (text: string) => showMessage(context, deps, dialogs, text, onUser);
  if (!storageDir || !tempDir) {
    deps.logError("Song Sections: storageDirectory/tempDirectory undefined (F8)");
    await say(MSG_NO_DIRS);
    endBusy();
    return;
  }

  /**
   * Live's render. This run holds a reference until it returns; a background Structure analysis it starts holds its
   * own, so the file is deleted when the last of them is done (fb2 review C1).
   */
  let render: SharedFile | undefined;
  let releaseRender: (() => Promise<void>) | undefined;
  let previewPath: string | undefined;
  let applying = false;
  try {
    const info: ClipInfo = deps.describeClip(context, context.getObjectFromHandle(handle, AudioClip));
    const settings = await deps.loadSettings(storageDir);

    let prepared: PreparedAudio | undefined;
    let cue: CueAnalysis | null = null;
    let structure: StructureAnalysis | null = null;
    let modes: ModeInfo | undefined;
    // fb2: a run opens in Cue unless Structure was the last mode and is cached; otherwise the remembered mode only
    // starts the background Structure analysis and suggests it.
    let mode: DialogMode = "cue";
    /** The audition stem folder of this clip's Structure analysis, once it is known to be there (round 2 B). */
    let stemsDir: string | null = null;
    /**
     * Re-analyze (fb2): the analysis being replaced and the Structure mode info it had. A new analysis that does not
     * finish (cancelled or failed) puts them back, cached again, so the Structure dialog reopens as it was.
     */
    let replacing: { analysis: StructureAnalysis; modes: ModeInfo["structure"]; patterns: PatternFeatures | null } | null = null;
    /** fb/hfmodels: the user agreed, in this run, to download the models (agreeToDownload). */
    let downloadAgreed = false;
    /**
     * v2, key per section: the harmonic chroma of the mix (every dialog can use it) and of the kept stems (bass, other
     * and vocals: a Structure dialog with stems uses it). null: not computed, or it failed (no keys then).
     */
    let mixHarmony: Harmony | null = null;
    let stemsHarmony: Harmony | null = null;
    /** v2: the send menu's "Key in names" toggle, as the last dialog left it. */
    let keyInNames = settings.keyInNames ?? true;
    const harmonyOf = async (req: HarmonyRequest, signal?: AbortSignal): Promise<Harmony | null> => {
      try {
        return await deps.harmony(req, signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        deps.logError(`Song Sections: could not find the key (${req.source}):`, error);
        return null;
      }
    };
    /** Plan 5: the pattern features of the Structure analysis in hand (the Structure dialog's pattern lanes). */
    let patterns: PatternFeatures | null = null;
    const patternsOf = async (req: PatternsRequest, signal?: AbortSignal): Promise<PatternFeatures | null> => {
      try {
        return await deps.patterns(req, signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        deps.logError("Song Sections: could not find the patterns:", error);
        return null;
      }
    };

    /** `<storage>/stems/<hash>`, or null for a hash that is not a plain name (never thrown: Cue must keep working). */
    const stemFolder = (hash: string): string | null => {
      try {
        return auditionDir(storageDir, hash);
      } catch {
        return null;
      }
    };
    /** Checks the folder is complete; a cached analysis uses it, so it is touched (the LRU clock). Never throws. */
    const findStems = async (dir: string | null, touch: boolean): Promise<string | null> => {
      if (!dir) return null;
      try {
        if (!(await deps.auditionReady(dir))) return null;
        if (touch) await deps.touchAudition(dir);
        return dir;
      } catch (error) {
        deps.logError("Song Sections: could not check the kept stems:", error);
        return null;
      }
    };

    const analyseCueIn = async (update: Update, signal: AbortSignal, p: PreparedAudio, from: number) => {
      const report = reporter(update);
      const a = await deps.analyseCue(p, signal, (f) => report("Analyzing…", from + Math.round((100 - from) * Math.min(1, Math.max(0, f)))));
      throwIfAborted(signal);
      await deps.saveCached(storageDir, p.hash, ENGINE, a).catch((error) => {
        deps.logError("Song Sections: could not save analysis cache:", error);
      });
      return a;
    };

    const structureModes = async (durationSec: number, cached: boolean): Promise<ModeInfo["structure"]> => {
      const base = {
        cached,
        needsDownload: false,
        downloadBytes: MODEL_DOWNLOAD_BYTES,
        diskBytes: MODEL_DISK_BYTES,
        estimateSec: estimateStructureSec(durationSec),
        warn: durationSec > STRUCTURE_WARN_SEC,
        retryable: false,
      };
      try {
        let platformReason: string | null = null;
        try {
          deps.assertStructurePlatform();
        } catch (error) {
          if (!isUnsupportedPlatform(error)) throw error;
          platformReason = error.message;
        }
        const tooLong = durationSec > STRUCTURE_MAX_SEC;
        return {
          ...base,
          available: platformReason === null && !tooLong,
          reason: platformReason ?? (tooLong ? msgTooLong() : null),
          needsDownload: !cached && !(await deps.modelsInstalled(storageDir)),
        };
      } catch (error) {
        // A Structure bug must not take Cue down: mark Structure unavailable and carry on.
        deps.logError("Song Sections: could not check Structure availability:", error);
        return { ...base, available: false, reason: MSG_STRUCTURE_UNAVAILABLE };
      }
    };

    // 1. Render and prepare once; load both caches; analyse Cue (it opens every run) in the same progress dialog.
    const ready = await progressDialog("Finding sections…", async (update, signal) => {
      await update("Rendering audio…", 0);
      render = sharedFile(await deps.acquireAudio(context, info, signal), deps.removeFile);
      releaseRender = render.retain();
      throwIfAborted(signal);

      await update("Preparing audio…", 20);
      previewPath = join(tempDir, `${randomUUID()}.wav`);
      const p = await deps.prepareAudio(render.path, previewPath);
      throwIfAborted(signal);

      // fb2: one background analysis at a time. One of this clip still going (or done) is joined; any other is
      // stopped first. The clip is known only once its audio is prepared.
      const old = deps.background.current;
      if (old && !(old.run.key === p.hash && (old.run.state === "running" || old.run.state === "done"))) {
        old.run.abort();
        // It leaves the slot only once it has ended (it may be inside an ORT run that cannot be stopped), so no other
        // analysis starts beside it. Waiting for it can be cancelled (fb2 review m1).
        void old.run.settled.then(() => {
          if (deps.background.current === old) deps.background.current = null;
        });
        await settledOrAborted(old.run.settled, signal);
      }
      throwIfAborted(signal);

      await update("Analyzing…", 40);
      const cachedCue = await deps.loadCached<CueAnalysis>(storageDir, p.hash, ENGINE);
      if (isCueAnalysis(cachedCue)) cue = cachedCue;
      const cachedStructure = await deps.loadCached<StructureAnalysis>(storageDir, p.hash, STRUCTURE_ENGINE);
      if (isStructureAnalysis(cachedStructure)) {
        structure = cachedStructure;
        // A folder that is gone (evicted, or analysed before stems were kept) means no audition: not a re-analysis.
        stemsDir = await findStems(stemFolder(p.hash), true);
      }

      const s = await structureModes(p.durationSec, structure !== null);
      modes = { structure: { ...s, suggested: s.available && settings.lastMode === "structure" } };
      // fb2 controller ruling: a cached Structure analysis has nothing to wait for, so the last mode opens as before.
      if (s.available && s.cached && settings.lastMode === "structure") mode = "structure";

      if (mode === "cue" && !cue) cue = await analyseCueIn(update, signal, p, 40);
      throwIfAborted(signal);
      // v2: the keys. Cached after the first time (a fraction of a second for the mix, a second or two for the stems).
      mixHarmony = await harmonyOf({ storageDir, hash: p.hash, source: "mix", x: p.analysis, rate: p.analysisRate }, signal);
      if (stemsDir) stemsHarmony = await harmonyOf({ storageDir, hash: p.hash, source: "stems", dir: stemsDir }, signal);
      // Plan 5: the pattern lanes of the cached analysis, from its kept stems or the mix. Cached after the first time.
      if (structure) {
        const mix = { x: p.analysis, rate: p.analysisRate };
        patterns = await patternsOf({ storageDir, hash: p.hash, analysis: structure, mix, stemsDir }, signal);
      }
      throwIfAborted(signal);
      await update("Analyzing…", 100);
      prepared = p;
    });
    if (!ready || !prepared || !modes || !render) return;
    const audio: PreparedAudio = prepared;
    const modeInfo: ModeInfo = modes;
    const rendered: SharedFile = render;

    // "fallback": Structure became unavailable (platform, or a retryable download failure); open the other mode.
    type Outcome = "ok" | "back" | "fallback";

    const ensureCue = async (): Promise<Outcome> => {
      if (cue) return "ok";
      const ok = await progressDialog("Finding sections…", async (update, signal) => {
        await update("Analyzing…", 0);
        cue = await analyseCueIn(update, signal, audio, 0);
      });
      return ok ? "ok" : "back";
    };

    /** This clip's background Structure analysis (fb2), started by this run or joined from an earlier one. */
    const ownBackground = (): BackgroundStructure | null => {
      const bg = deps.background.current;
      return bg && bg.run.key === audio.hash ? bg : null;
    };
    // fb2: the background analysis starts once the first Cue page is up; it is never started twice in a run.
    // Matt, 31 Oct: whatever the last mode was, so a Cue Apply does not switch it off for the next clip.
    let backgroundWanted =
      modeInfo.structure.available &&
      !structure &&
      !modeInfo.structure.warn &&
      !modeInfo.structure.needsDownload &&
      !ownBackground();

    /**
     * Gets the models and analyses the render, caching the result and keeping its audition stems. `noDownload`
     * (background): called instead of reporting when the models would have to be downloaded.
     */
    const runStructure = async (
      signal: AbortSignal,
      at: Phase,
      report: (text: string, pct: number) => void,
      background?: { noDownload: () => void; pace: BackgroundPace },
    ): Promise<StructureRun> => {
      const noDownload = background?.noDownload;
      const dir = await deps.ensureModels({
        storageDir,
        signal,
        onProgress: (done, total, phase) => {
          if (noDownload && done < total) return noDownload();
          const pct = percent(total > 0 ? done / total : 0);
          if (phase === "build") report("Preparing analysis models…", pct);
          else report(`Downloading analysis models… ${megabytes(done)} of ${megabytes(total)} MB`, pct);
        },
      });
      throwIfAborted(signal);
      at.phase = "analysis";
      const keep = stemFolder(audio.hash);
      const env = {
        modelDir: dir,
        tempDir,
        storageDir,
        extensionRoot: deps.extensionRoot(),
        ...(keep ? { auditionStemsDir: keep } : {}),
        ...(background ? { pace: background.pace } : {}),
      };
      const a = await deps.analyseStructure(rendered.path, env, signal, (fraction, stage) => report(STAGE_TEXT[stage], percent(fraction)));
      throwIfAborted(signal);
      await deps.saveCached(storageDir, audio.hash, STRUCTURE_ENGINE, a).catch((error) => {
        deps.logError("Song Sections: could not save structure cache:", error);
      });
      // The engine renamed the folder into place only if it wrote all four stems; then the others are pruned
      // (least recently used first, never this one) to stay under the 1.5 GB cap.
      const kept = await findStems(keep, false);
      if (keep) {
        await deps.pruneAuditions(storageDir, audio.hash).catch((error) => {
          deps.logError("Song Sections: could not prune the kept stems:", error);
        });
      }
      // v2: the stems' harmony for the keys, while the stems are certainly there; in the background, at its pace.
      const harmony = kept
        ? await harmonyOf({ storageDir, hash: audio.hash, source: "stems", dir: kept, ...(background ? { pace: background.pace } : {}) }, signal)
        : null;
      throwIfAborted(signal);
      // Plan 5: and the pattern features, from the stems while they are there (or the mix); in the background, at its pace.
      const found = await patternsOf(
        {
          storageDir,
          hash: audio.hash,
          analysis: a,
          mix: { x: audio.analysis, rate: audio.analysisRate },
          stemsDir: kept,
          ...(background ? { pace: background.pace } : {}),
        },
        signal,
      );
      throwIfAborted(signal);
      return { analysis: a, stemsDir: kept, harmony, patterns: found };
    };

    /** fb2: the Cue page is up; start the Structure analysis in the host, with no dialog of its own. */
    const startInBackground = () => {
      if (!backgroundWanted) return;
      backgroundWanted = false;
      if (structure || ownBackground()) return;
      const at: Phase = { phase: "models" };
      const releaseOwn = rendered.retain(); // its own reference: this run may return first, or analyse again after it
      const pace = backgroundPace(deps.activity);
      const run = startBackground<StructureRun>(audio.hash, (signal, report, abort) =>
        runStructure(
          signal,
          at,
          (text, pct) => {
            if (at.phase === "analysis") report(text, pct); // the models are installed: their check is not progress
          },
          {
            noDownload: () => {
              deps.logError("Song Sections: the Structure models are not installed after all; the background analysis stops (it never downloads)");
              abort();
            },
            pace,
          },
        ),
      );
      deps.background.current = { run, at, pace };
      void run.settled.then(async () => {
        if (run.state === "failed") deps.logError("Song Sections: background Structure analysis failed:", run.error);
        await releaseOwn();
      });
    };

    /** What the Cue page's Structure tab polls (dialogServer.ts). */
    const structureProgress = (): StructureProgress => {
      const bg = ownBackground();
      if (!bg) return { state: backgroundWanted ? "pending" : "none", percent: 0 };
      const state = bg.run.state;
      if (state === "aborted") return { state: "none", percent: 0 };
      return { state, percent: state === "running" ? bg.run.progress.percent : state === "done" ? 100 : 0 };
    };

    /**
     * fb2: this clip's background analysis, waited for under a progress dialog while it still runs. "back": that
     * dialog was cancelled, and the analysis goes on. null: there is none to use (or it stopped for a download), so
     * analyse here. Its error is thrown, for the usual error path. A result or error is taken once: a Re-analyze
     * then runs a new analysis, and a failure is not shown twice.
     */
    const joinBackground = async (at: Phase): Promise<StructureRun | "back" | null> => {
      const bg = ownBackground();
      if (!bg) return null;
      // The user now waits for it: full speed, as a foreground analysis (fb2 review I1), until it ends or they cancel.
      const detach = bg.pace.attach();
      try {
        // One that ends while the gap before a dialog passes opens no dialog (fb2 review m4).
        if (bg.run.state === "running") await dialogs.beforeOpen();
        if (bg.run.state === "running") {
          const ok = await progressDialog("Analyzing structure…", async (update, signal) => {
            const report = reporter(update);
            if (bg.run.progress.text) report(bg.run.progress.text, bg.run.progress.percent);
            const stop = bg.run.watch(report);
            try {
              await settledOrAborted(bg.run.settled, signal);
            } finally {
              stop();
            }
          });
          if (!ok) return "back";
        }
      } finally {
        detach();
      }
      if (deps.background.current === bg) deps.background.current = null;
      if (bg.run.state === "done") return bg.run.result ?? null;
      if (bg.run.state === "failed") {
        at.phase = bg.at.phase;
        throw bg.run.error;
      }
      return null;
    };

    const ensureStructure = async (): Promise<Outcome> => {
      if (structure) return "ok";
      const outcome = await analyseStructureNow();
      const previous = replacing;
      replacing = null;
      if (outcome !== "ok" && previous) {
        // A transient model-download failure returns "fallback" with no message, for the picker to show its reason;
        // putting the old mode info back would hide it, so say it here (fb2 review M3).
        const failed = modeInfo.structure;
        if (outcome === "fallback" && failed.retryable && failed.reason) await say(failed.reason);
        structure = previous.analysis;
        modeInfo.structure = previous.modes;
        patterns = previous.patterns;
        await deps.saveCached(storageDir, audio.hash, STRUCTURE_ENGINE, previous.analysis).catch((error) => {
          deps.logError("Song Sections: could not restore the structure cache:", error);
        });
        return "ok";
      }
      return outcome;
    };

    /**
     * fb/hfmodels: nothing downloads until the user agrees. The Cue view's Structure tab asks (its Download comes back as
     * a switch with `download: true`); any other way to a download (a Re-analyze once the models are gone, say) asks
     * here first, in a small dialog with the same words. Installed models need no consent. Agreed once, for this run.
     */
    const agreeToDownload = async (): Promise<boolean> => {
      if (downloadAgreed) return true;
      try {
        if (await deps.modelsInstalled(storageDir)) return true;
      } catch (error) {
        deps.logError("Song Sections: could not check the installed models:", error);
      }
      let answer = "";
      try {
        await dialogs.beforeOpen();
        const page = consentPage(downloadConsent(modeInfo.structure));
        answer = await onUser(() => context.ui.showModalDialog("data:text/html;charset=utf-8," + encodeURIComponent(page), 460, 200));
      } catch (error) {
        deps.logError("Song Sections: could not ask to download the models:", error);
      } finally {
        dialogs.closed();
      }
      downloadAgreed = answer === "download";
      return downloadAgreed;
    };

    const analyseStructureNow = async (): Promise<Outcome> => {
      const at: Phase = { phase: "models" };
      try {
        const joined = await joinBackground(at);
        if (joined === "back") return "back";
        if (joined) {
          structure = joined.analysis;
          stemsDir = joined.stemsDir;
          stemsHarmony = joined.harmony ?? null;
          patterns = joined.patterns ?? null;
        } else {
          if (!(await agreeToDownload())) return "back";
          const ok = await progressDialog("Analyzing structure…", async (update, signal) => {
            const r = await runStructure(signal, at, reporter(update));
            structure = r.analysis;
            stemsDir = r.stemsDir;
            stemsHarmony = r.harmony ?? null;
            patterns = r.patterns ?? null;
          });
          if (!ok) return "back";
        }
        modeInfo.structure = { ...modeInfo.structure, cached: true, needsDownload: false };
        return "ok";
      } catch (error) {
        if (isUnsupportedPlatform(error)) {
          // Ruling: the picker shows Structure as unavailable with this message; Cue keeps working.
          deps.logError("Song Sections: Structure is not supported on this machine:", error);
          modeInfo.structure = { ...modeInfo.structure, available: false, reason: error.message, retryable: false };
          await say(error.message);
          return "fallback";
        }
        if (at.phase === "models" && (error as { name?: unknown } | null)?.name === "ModelsDiskSpaceError") {
          // Review m4: say why in plain words, with Retry (the downloads so far are kept, so it resumes).
          deps.logError("Song Sections: not enough disk space for the models:", error);
          modeInfo.structure = { ...modeInfo.structure, available: false, reason: String((error as Error).message), retryable: true };
          return "fallback";
        }
        if (at.phase === "models" && isTransientDownloadError(error)) {
          // The picker shows the reason with Retry, which comes back as a switch to Structure.
          deps.logError("Song Sections: model download failed:", error);
          modeInfo.structure = { ...modeInfo.structure, available: false, reason: downloadFailedReason(error), retryable: true };
          return "fallback";
        }
        if (error instanceof ModelsUnavailableError) {
          deps.logError(
            `Song Sections: ${error.message}; expected in ${modelDir(storageDir)}. ` +
              `For development, run npm run models:dev -- <checkpoint dir> ${storageDir}`,
          );
          await say(MSG_MODELS);
          return "fallback";
        }
        // Any other failure (Task 5 I1): say so and open Cue, which always works.
        deps.logError("Song Sections: Structure analysis failed:", error);
        await say(MSG_STRUCTURE_FAILED);
        return "fallback";
      }
    };

    const ensure = (m: DialogMode) => (m === "cue" ? ensureCue() : ensureStructure());

    const payloadFor = (m: DialogMode): DialogPayload => {
      const base = {
        view: info.view,
        clipName: info.name,
        durationSec: audio.durationSec,
        audioUrl: "audio.wav",
        waveform: audio.waveform,
        sourceColor: info.color,
        output: "both" as const, // Matt (Live, 4 Nov): Cue and Structure both open on Both
        // Only Session rebuilds slices from the file; Arrangement splits natively and keeps markers.
        // fb3: any warped Session clip; Live warps a new clip on its own grid (live/execute.ts executeSession).
        warpNote: info.view === "session" && info.warped,
        tempo: context.application.song.tempo,
        modes: {
          structure: { ...modeInfo.structure, background: m === "cue" && (backgroundWanted || ownBackground()?.run.state === "running") },
        },
        // v2: Structure with kept stems keys from them (no drums); Cue, or no stems, from the mix.
        harmony: m === "structure" && stemsDir && stemsHarmony ? stemsHarmony : mixHarmony,
        setScale: setScaleOf(context, deps),
        keyInNames,
      };
      if (m === "structure") {
        const bars = barGrid(info, context.application.song.tempo, audio.durationSec, SONG_SIGNATURE);
        const stemUrls = stemsDir ? (Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as Record<StemName, string>) : null;
        // fb3: Live's beats too, for nudging by a beat under Snap to Bars.
        const liveBeats = cueBeatGrid(info, context.application.song.tempo, audio.durationSec);
        return { ...base, ...(prefs ?? DEFAULT_STRUCTURE_PREFS), mode: "structure", analysis: structure!, barGrid: bars, beatGrid: liveBeats, stemUrls, patterns };
      }
      const beatGrid = cueBeatGrid(info, context.application.song.tempo, audio.durationSec);
      // fb3: bar lines too, for Shift+arrow nudges and the length labels.
      const cueBars = barGrid(info, context.application.song.tempo, audio.durationSec, SONG_SIGNATURE);
      return {
        ...base,
        mode: "cue",
        novelty: cue!.novelty,
        blocksPerSec: cue!.blocksPerSec,
        boundaries: cue!.boundaries,
        granularity: DEFAULT_GRANULARITY,
        colorMode: "gradient",
        beatGrid,
        barGrid: cueBars,
        // fb4, item 1: no Live grid, but a Structure analysis of this audio is in hand: its beats give the lengths.
        ...(beatGrid === null && structure ? { structureGrid: { beats: structure.beats, downbeats: structure.downbeats } } : {}),
        snap: beatGrid !== null,
      };
    };

    // lastMode is saved on Apply and the Structure choices on a Structure Apply, only when they changed: a cancelled run (or a
    // cancelled Structure attempt that fell back to Cue) never changes the defaults for the next run. Within a run, the
    // choices a Structure dialog closed with (Apply or a switch) open the next Structure dialog.
    let savedMode: DialogMode = settings.lastMode;
    let savedPrefs: StructurePrefs | undefined = settings.structure;
    let prefs: StructurePrefs | undefined = settings.structure;
    let savedKeyInNames: boolean | undefined = settings.keyInNames;
    const remember = async (lastMode: DialogMode) => {
      // Only a Structure Apply saves the Structure choices (review M1): ones tried there and left by a switch to Cue
      // were never applied, so a Cue Apply saves the mode alone.
      const structure = lastMode === "structure" ? prefs : savedPrefs;
      // v2: "Key in names" is saved once it is turned off, or once it was saved before (settings.json gains no field until then).
      const keyPref = keyInNames === false || savedKeyInNames !== undefined ? keyInNames : undefined;
      if (lastMode === savedMode && JSON.stringify(structure) === JSON.stringify(savedPrefs) && keyPref === savedKeyInNames) return;
      try {
        await deps.saveSettings(storageDir, { lastMode, ...(structure ? { structure } : {}), ...(keyPref !== undefined ? { keyInNames: keyPref } : {}) });
        savedMode = lastMode;
        savedPrefs = structure;
        savedKeyInNames = keyPref;
      } catch (error) {
        deps.logError("Song Sections: could not save settings:", error);
      }
    };

    let shown: DialogMode | null = null; // the mode of the last dialog shown; its analysis is in memory
    for (let i = 0; i < MAX_DIALOGS; i++) {
      let outcome = await ensure(mode);
      if (outcome === "fallback") {
        mode = shown ?? "cue";
        outcome = await ensure(mode);
      }
      if (outcome === "back") {
        // Only a switch can be cancelled: the opening mode was analysed (Cue) or cached (Structure) already (fb2).
        if (shown === null) return;
        mode = shown;
      }

      // F6/R15: the dialog is far too big for a data: URL, so it is served from localhost.
      await dialogs.beforeOpen();
      const payload = payloadFor(mode);
      const server = await deps.serveDialog({
        html: injectPayload(deps.dialogHtml, payload),
        audioPath: audio.previewPath,
        stemsDir: mode === "structure" ? stemsDir : null,
        now: deps.clock.now,
        activity: deps.activity,
        openUrl: deps.openUrl,
        ...(mode === "cue" ? { onReady: startInBackground, structureProgress } : {}),
      });
      const label = mode;
      const openedAt = deps.clock.now();
      // There is no way to close a modal dialog from here, so a page that never loads can only be reported.
      const stopWatch = deps.clock.after(PAGE_WATCHDOG_MS, () => {
        const stall = pageStallMessage(label, server.status(), openedAt, deps.clock.now());
        if (stall) deps.logError(stall);
      });
      let raw: string;
      try {
        raw = await onUser(() => context.ui.showModalDialog(server.url, ...DIALOG_SIZE[mode]));
      } finally {
        stopWatch();
        dialogs.closed();
        deps.log(dialogSummary(label, server.status(), openedAt, deps.clock.now()));
        await server.close();
      }
      shown = mode;

      const result = parseResult(raw);
      if (result.action === "cancel") return;
      if (result.prefs) prefs = result.prefs;
      if (result.keyInNames !== undefined) keyInNames = result.keyInNames;
      if (result.action === "reanalyse") {
        // Offered by the Structure dialog when its analysis kept no stems: run the analysis again (the loop's ensure),
        // so the stems are kept; the dialog then reopens with the choices it sent, not its edits. The cached entry stays
        // until the new analysis replaces it (fb2 review M2): ensure analyses because `structure` is null, without
        // reading the cache, so a quit or host restart mid-way still leaves the old one.
        if (mode !== "structure" || !structure) continue;
        // This clip's background analysis (fb2): one still running is joined by ensure, so two never run at once. A
        // finished one nobody took is the analysis being replaced (it wrote the cache this dialog opened from), so it
        // is dropped: joining it would hand back the same result instead of analysing again.
        const bg = ownBackground();
        if (bg && bg.run.state !== "running" && deps.background.current === bg) deps.background.current = null;
        replacing = { analysis: structure, modes: modeInfo.structure, patterns };
        structure = null;
        stemsDir = null;
        stemsHarmony = null;
        patterns = null;
        continue;
      }
      if (result.action === "switch") {
        if (result.mode === "structure" && result.download) downloadAgreed = true;
        if (result.mode === "structure" && !modeInfo.structure.available) {
          // The picker blocks an unavailable Structure; if one slips through, reopen the current mode. A retryable
          // one is the picker's Retry: make it available again and call ensureModels again (it resumes the .part).
          if (!modeInfo.structure.retryable) continue;
          modeInfo.structure = { ...modeInfo.structure, available: true, reason: null, retryable: false };
        }
        mode = result.mode;
        continue;
      }

      if (result.action === "send") {
        // v2: the mix is the render the dialog's preview is made from (the clip's own rate and channels; the preview is
        // mono 22 kHz); a stem is the kept Structure stem, which exists only behind a Structure dialog.
        const sourcePath = result.source === "mix" ? rendered.path : mode === "structure" && stemsDir ? join(stemsDir, `${result.source}.wav`) : null;
        if (!sourcePath) throw new Error(`Invalid send from dialog: no ${result.source} stem behind the ${mode} dialog`);
        // Plan 6: a pattern lane's slices leave its rests out, so they may have gaps (as Session Apply's pieces).
        if (result.unit === "patterns") assertValidPieces(result.sections, audio.durationSec);
        else assertValidSections(result.sections, audio.durationSec);
        // Plan 6, Task 8: Send all stems takes each kept stem's file, and its slices (none for a stem that rests throughout).
        let allStems: { stems: Record<StemName, Section[]>; stemPaths: Record<StemName, string> } | null = null;
        if (result.target === "allStems") {
          const dir = mode === "structure" ? stemsDir : null;
          if (!dir || !result.stems) throw new Error(`Invalid send from dialog: no stems behind the ${mode} dialog`);
          for (const s of STEM_NAMES) if (result.stems[s].length > 0) assertValidPieces(result.stems[s], audio.durationSec);
          allStems = { stems: result.stems, stemPaths: Object.fromEntries(STEM_NAMES.map((s) => [s, join(dir, `${s}.wav`)])) as Record<StemName, string> };
          deps.log(`Song Sections: send all stems, ${STEM_NAMES.map((s) => `${result.stems![s].length} ${s}`).join(", ")} slices (${mode})`);
        } else {
          const what = result.unit === "patterns" ? "slice" : "section";
          deps.log(`Song Sections: send ${result.target} of ${result.source}, ${what} ${result.index + 1} of ${result.sections.length} (${mode})`);
        }
        await remember(mode);
        applying = true;
        const { target, source, index, sections, unit } = result;
        // v2: the names carry the keys the dialog showed: the same harmony, keyed by the same code (key/key.ts).
        const sent = await deps.executeSend(
          context,
          info,
          {
            target,
            source,
            index,
            sections,
            ...(unit ? { unit } : {}),
            ...(allStems ?? {}),
            sourcePath,
            tempo: context.application.song.tempo,
            durationSec: audio.durationSec,
            harmony: payload.harmony ?? null,
            keyInNames,
          },
          { tempDir, storageDir, log: deps.log },
        );
        deps.log(`Song Sections: sent, ${sent.steps} undo steps`);
        if (sent.notes.length > 0) await say(sent.notes.join(" "));
        return;
      }
      assertValidSections(result.sections, audio.durationSec);
      // Plan 6, Slice by: the pieces tile the clip in Arrangement (a rest joins a neighbour); Session leaves rests out.
      const { pieces } = result;
      if (pieces) {
        if (info.view === "session") assertValidPieces(pieces, audio.durationSec);
        else assertValidSections(pieces, audio.durationSec);
      }
      deps.log(applySummary(payload, result));
      await remember(mode);
      applying = true;
      const tempo = context.application.song.tempo;
      // v2 (Matt, 31 Oct): locators and scenes carry each section's sure key, as sends do (Key in names).
      const keys = keyInNames && payload.harmony ? sectionKeys(payload.harmony, result.sections).map(nameKey) : undefined;
      if (info.view === "session") {
        // Live fix 5: sessionOps numbers repeated scene names; the clips keep the plain section labels.
        // Plan 6: with pieces, one scene per piece, named `<section label> <n>`.
        const ops = pieces ? deps.sessionOps(info, result.sections, tempo, keys, pieces) : deps.sessionOps(info, result.sections, tempo, keys);
        await deps.executeSession(context, info, ops);
      } else {
        // Plan 6: the pieces give the splits and clip names; the sections always give the locators.
        const ops = pieces
          ? deps.arrangementOps(info, result.sections, result.output, tempo, keys, pieces)
          : deps.arrangementOps(info, result.sections, result.output, tempo, keys);
        await deps.executeArrangement(context, info, ops);
      }
      return;
    }
    deps.logError(`Song Sections: closed after ${MAX_DIALOGS} dialogs`);
  } catch (error) {
    // Cancelled in a progress dialog: return silently, the Set is untouched.
    if (!applying && isAbort(error)) return;
    deps.logError("Song Sections failed:", error);
    let message = applying ? MSG_APPLY_FAILED : MSG_FAILED;
    if (error instanceof ArrangementApplyError) {
      // Each completed cut or locator is believed to be one undo step; with none done the Set is untouched.
      const steps = error.cuts + error.cues;
      message = steps === 0 ? MSG_FAILED : applyFailedMessage(steps);
    } else if (error instanceof SendError) message = sendFailedMessage(error);
    await say(message);
  } finally {
    // Deletes only the file (Live's AudioRender-* directory remains); best-effort, may be outside storage/temp.
    // A background Structure analysis that still reads the render holds its own reference (fb2 review C1).
    await releaseRender?.();
    if (previewPath) await deps.removeFile(previewPath);
    endBusy();
  }
}
