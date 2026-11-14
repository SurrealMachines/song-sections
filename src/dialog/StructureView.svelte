<script lang="ts">
  import { TextButton } from "@patchbayhq/svelte";
  import { onDestroy } from "svelte";
  import { STEM_NAMES, type StemName } from "../structure/contract.js";
  import ModePicker from "./ModePicker.svelte";
  import About from "./About.svelte";
  import RenamePopover from "./RenamePopover.svelte";
  import { letterKey, numberKey } from "../grouping/renumber.js";
  import SendMenu from "./SendMenu.svelte";
  import StemLanes from "./StemLanes.svelte";
  import StructureControls from "./StructureControls.svelte";
  import Timeline from "./Timeline.svelte";
  import { CHECKING_CONNECTION, closeWith, deliver, LOST_CONNECTION } from "./bridge.js";
  import { BYPASS_KEY } from "./modifier.js";
  import type { DialogMode, DialogResult, SendSource, SendTarget, StructurePayload } from "./protocol.js";
  import { createStemPlayer } from "./stemPlayer.js";
  import { ALL_RESTS, allStemsResult, laneCellTarget, NO_STEMS_TO_SEND, sendResult, withKeyInNames, type SendMenuAt } from "./send.js";
  import type { Section } from "../core/types.js";
  import { headerKey, sectionKeyTexts } from "./keys.js";
  import { createStructureState, respan } from "./structureState.js";
  import type { LengthGrid } from "./lengths.js";
  import { AUDITION_SEC, type NudgeGrid } from "./nudge.js";
  import { correctedGrid, nudgeGridFor, structureLengthGrid, structureSnapGrid } from "./gridChoice.js";
  import { fitView } from "./zoom.js";

  let { payload }: { payload: StructurePayload } = $props();

  // svelte-ignore state_referenced_locally
  const dialog = createStructureState(payload);
  // svelte-ignore state_referenced_locally
  const duration = payload.durationSec;

  // `dialog` is a plain object: bump `version` after each mutation to re-render.
  let version = $state(0);
  /** Reads `version` so a $derived using this re-runs after each update(). */
  function tracked<T>(read: () => T): T {
    version;
    return read();
  }

  // The letters and lanes are set here rather than derived, so the sliders can hold them back (fix round, review I3):
  // the clustering is O(n²) in sections, and on a long mix with the Sections slider high it costs a frame or more.
  let sections = $state.raw(dialog.sections());
  // Plan 6: with pattern features the lanes are the stems' pattern lanes; without, the four letter lanes.
  // svelte-ignore state_referenced_locally
  const rows = dialog.patternSources;
  const letterLanes = () => (rows.length > 0 ? null : dialog.lanes());
  let lanes = $state.raw(letterLanes());
  let cells = $state.raw(dialog.patternLanes());
  /** What Slice by offers besides Sections: the sources with a lane that is not all rests (as effectiveSliceBy has it). */
  const sliceable = $derived(rows.filter((s) => cells[s]?.some((c) => !c.rest)));
  /**
   * The clip's real Patterns levels ("only real levels", Matt), read on open and after each marker or slider release,
   * never per drag frame: they follow the markers, and working them out asks the engine about every section.
   */
  let patternSteps = $state.raw(dialog.patternSteps());
  const readSteps = () => (patternSteps = dialog.patternSteps());
  /** A full recompute that took longer than this waits for the slider's release instead of running every frame. */
  const LIVE_BUDGET_MS = 30;
  let slow = false;
  let stale = false; // a slider moved since the letters were last computed
  let frame = 0;

  /**
   * `dragging`: a marker drag frame. Its pattern lanes are previewed (the cut follows the marker, nothing is asked of
   * the engine: final review item 7) until the drop, when moveEnd makes them exact.
   */
  function refresh(dragging = false) {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const t0 = performance.now();
    sections = dialog.sections();
    lanes = letterLanes();
    cells = dragging ? dialog.previewLanes() : dialog.patternLanes();
    if (stale) slow = performance.now() - t0 > LIVE_BUDGET_MS; // only a slider's recompute is a full one
    stale = false;
  }

  /** `dragging`: a handle drag frame, which leaves the pattern lanes and Patterns steps for the release (moveEnd). */
  function update(fn: () => void, dragging = false) {
    if (frozen) return; // fb2 review I3: no edit while the result is on its way (the Delete key reaches the window)
    fn();
    version++;
    refresh(dragging);
    if (!dragging) readSteps(); // memoised on the boundaries: a rename or a colour change costs nothing
  }

  /** A marker drag ended (Timeline onmoveend): the pattern lanes and steps catch up with the markers. */
  function moveEnd() {
    cells = dialog.patternLanes();
    readSteps();
  }

  /**
   * A slider step: the boundaries (and the bands' edges) follow at once; the letters and lanes recompute at most once
   * per animation frame on the latest value, or only on release when that recompute is slower than a frame budget.
   */
  function slide(fn: () => void) {
    if (frozen) return;
    fn();
    version++;
    stale = true;
    sections = respan(dialog.boundaries, duration, sections);
    // The letter lanes are the sections, so they respan with them; the pattern lanes wait for the recompute.
    if (lanes) lanes = Object.fromEntries(Object.entries(lanes).map(([k, l]) => [k, respan(dialog.boundaries, duration, l)])) as typeof lanes;
    if (!slow && !frame) frame = requestAnimationFrame(() => ((frame = 0), refresh()));
  }

  /** The slider was let go (its input's change event): catch the letters up if they are behind. */
  function release() {
    if (stale) refresh();
    readSteps();
  }

  const boundaries = $derived(tracked(() => [...dialog.boundaries]));
  const selected = $derived(tracked(() => dialog.selected));
  const selectedCut = $derived(tracked(() => dialog.selectedCut));
  const sliceBy = $derived(tracked(() => dialog.sliceBy));
  const colorMode = $derived(tracked(() => dialog.colorMode));
  const output = $derived(tracked(() => dialog.output));
  const snap = $derived(tracked(() => dialog.snap));
  const snapTarget = $derived(tracked(() => dialog.snapTarget));
  const granularity = $derived(tracked(() => dialog.granularity));
  const groupDist = $derived(tracked(() => dialog.groupDist));
  const showStems = $derived(tracked(() => dialog.showStems));
  const patternLevel = $derived(tracked(() => dialog.patternLevel));
  const snapMerged = $derived(tracked(() => dialog.snapMerged));
  // v2: the keys, from the host's harmony (the stems without the drums when they were kept, else the mix); a section's
  // follows its edits at once, and the slider's respanned sections too.
  // svelte-ignore state_referenced_locally
  const keyLine = headerKey(payload.harmony, payload.setScale);
  const keys = $derived(sectionKeyTexts(payload.harmony, sections));
  // svelte-ignore state_referenced_locally
  let keyInNames = $state(payload.keyInNames ?? true);
  // svelte-ignore state_referenced_locally
  const hasKeys = payload.harmony != null;

  let timeline: Timeline;

  // fb3: the zoom starts at fit for each dialog and the stem lanes follow it. Nudges and lengths go by the active
  // snap grid while snapping: allin1's beats and downbeats under Downbeats, Live's beats and bars under Bars.
  // fb4, item 1: with snap off they go by allin1's beats and downbeats (bars and beats, not seconds; gridChoice.ts).
  // svelte-ignore state_referenced_locally
  let view = $state(fitView(duration));
  // svelte-ignore state_referenced_locally
  const a = payload.analysis;
  // Matt (Flim): with pattern features, the lengths count bars on their corrected grid where allin1's would be used.
  const allin1Grid = { beats: a.beats, bars: a.downbeats };
  // svelte-ignore state_referenced_locally
  const corrected = payload.patterns ? correctedGrid(allin1Grid, payload.patterns.grid) : null;
  // svelte-ignore state_referenced_locally
  const grids = { allin1: allin1Grid, live: { beats: payload.beatGrid ?? [], bars: payload.barGrid ?? [] }, corrected };
  const snapping = $derived(snap && dialog.canSnap);
  const lengthGrid: LengthGrid | null = $derived(structureLengthGrid(grids, snapping, snapTarget));
  const nudgeGrid: NudgeGrid = $derived(nudgeGridFor(snapping, structureSnapGrid(grids, snapTarget), lengthGrid, a.bpm));

  /** Set when Apply or a switch found the extension gone: the dialog stays open and says so (feedback round 2). */
  let lost = $state(false);
  /**
   * fb2 review I3: Apply, a mode switch or Re-analyze is waiting for the host's answer (bridge.ts hostAlive). The
   * dialog is frozen meanwhile (only Cancel works), so nothing is edited after the click and then lost: the result is
   * built once the host has answered. `sent`: it went out, and Live is closing the dialog.
   */
  let checking = $state(false);
  let sent = $state(false);
  const frozen = $derived(checking || sent);
  /** fb2 review I2: Re-analyze was clicked with hand edits in the dialog; it asks first. */
  let confirmReanalyse = $state(false);

  // Stem audition (feedback round 2 B): a lane cell plays that section of that stem. One sound at a time: a stem
  // stops the band playing and a band stops the stem; a second click on the cell, or a click anywhere else, stops it.
  // svelte-ignore state_referenced_locally
  const stemUrls = payload.stemUrls ?? null;
  /** The lane cell playing, on the stem player. */
  let stemPlaying = $state<{ stem: StemName; index: number } | null>(null);
  let stemHead = $state<number | null>(null);
  let stemError = $state<string | null>(null);
  const stemPlayer = createStemPlayer((e) => {
    stopStem();
    stemError = "Stem playback unavailable: " + (e instanceof Error ? e.message : String(e));
  });
  let stemFrame = 0;

  function tickStem() {
    const t = stemPlayer.position();
    if (t !== null) stemHead = t;
    // null until the first slice is scheduled; once it has played, null means the section ended.
    else if (stemHead !== null) return stopStem();
    stemFrame = requestAnimationFrame(tickStem);
  }

  function stopStem() {
    stemPlayer.stop();
    cancelAnimationFrame(stemFrame);
    stemFrame = 0;
    stemPlaying = null;
    stemHead = null;
  }

  function playStem(source: StemName, index: number) {
    if (stemPlaying?.stem === source && stemPlaying.index === index) return stopStem();
    const cell = rows.length > 0 ? cells[source]?.[index] : lanes?.[source][index];
    if (cell) playCell(source, index, cell.start, cell.end);
  }

  /** Plays [from, to) of lane cell `index`'s source with that cell marked as playing. */
  function playCell(source: StemName, index: number, from: number, to: number) {
    if (!stemUrls) return;
    stopStem();
    timeline?.stop();
    stemError = null;
    stemPlaying = { stem: source, index };
    stemPlayer.play(stemUrls[source], from, to);
    stemFrame = requestAnimationFrame(tickStem);
  }

  /**
   * Plan 6, Task 5: a lane cut was nudged: AUDITION_SEC of the cell it now starts play from it, as a nudged section
   * handle plays its section on the stem player, and the view follows it.
   */
  function audition(source: StemName, index: number) {
    const cell = cells[source]?.[index];
    if (!cell) return;
    timeline?.reveal(cell.start);
    playCell(source, index, cell.start, Math.min(cell.end, cell.start + AUDITION_SEC));
  }

  /** Task 5 review: opens the audio a nudged lane cut's audition will play on, synchronously inside the key press. */
  function unlockAudio(source: StemName) {
    if (stemUrls) stemPlayer.unlock();
  }

  /** Any press outside a lane cell stops the stem (a cell's own click toggles or switches it). */
  function onwindowpointerdown(e: PointerEvent) {
    if (stemPlaying && !(e.target instanceof Element && e.target.closest(".lanes .cell"))) stopStem();
  }

  /** The sections are about to change: nothing may keep playing a range that no longer exists. */
  function stopAll() {
    timeline?.stop();
    stopStem();
  }

  onDestroy(() => {
    stopStem();
    stemPlayer.dispose();
  });

  /** Apply, a switch or Re-analyze: asks the host first, then sends the result `make` builds (bridge.ts deliver). */
  async function close(make: () => DialogResult) {
    if (frozen) return; // a second click while the host is being asked
    stopAll();
    confirmReanalyse = false;
    lost = false;
    checking = true;
    try {
      if (await deliver(() => withKeyInNames(make(), hasKeys ? keyInNames : undefined))) sent = true;
      else lost = true;
    } finally {
      checking = false;
    }
  }

  /** Cancel has nothing to lose: it closes at once, also while the host is being asked. */
  function cancel() {
    stopAll();
    sent = true;
    closeWith(dialog.cancel());
  }

  /** Apply: a rename still being typed (a band's or a pattern's) is committed first, so it is in the result. */
  function apply() {
    if (frozen) return;
    timeline?.commitRename();
    patternPopover?.commit();
    void close(() => dialog.result());
  }

  // v2: a right-click on a band (the mix) or a stem lane cell (that stem) opens the send menu; a choice closes the
  // dialog as Apply does, with the dialog's sections as they are now. Stems can be sent only when they were kept.
  let menu = $state<SendMenuAt | null>(null);
  /** Plan 6, Task 5: the pattern lane cell the menu is for, when it can be renamed (not a rest). */
  let menuCell = $state<{ index: number; anchor: DOMRect } | null>(null);
  /** Plan 6, Task 7: a pattern lane's slices, which a send from its cell sends. */
  let menuLane = $state.raw<{ slices: Section[] } | null>(null);
  /**
   * The menu's title for a lane cell: the label drawn on the cell ("rest" for a pattern rest). Null for a band, whose
   * title is its section's label as it is now. Matt (Flim): a letter lane's cell was titled with its section's letter.
   */
  let menuTitle = $state<string | null>(null);
  function openMenu(source: SendSource, index: number, x: number, y: number, cell: { index: number; anchor: DOMRect } | null = null, lane: typeof menuLane = null, rest = false, title: string | null = null) {
    if (frozen) return;
    stopAll();
    menu = lane ? { source, index, x, y, unit: "patterns", rest } : { source, index, x, y };
    menuCell = cell;
    menuLane = lane;
    menuTitle = title;
  }
  /**
   * Plan 6, Task 7: a right-click on a lane cell. A pattern lane's cell sends the lane's own slices: `index` is the
   * slice the cell is (by its middle), and a rest (StemLanes gives no `cell` for one) is none. A letter lane's cell
   * sends the stem's section, as before. Task 7 review: a cell with no slice (a short last one laneSlices left out)
   * is treated as a rest: titled "rest", with no one-slice sends and no Rename.
   */
  function openLaneMenu(source: StemName, section: number, x: number, y: number, cell: { index: number; anchor: DOMRect } | null) {
    if (rows.length === 0) return openMenu(source, section, x, y, cell, null, false, lanes?.[source][section]?.label ?? "");
    const slices = dialog.laneSlices(source);
    const target = laneCellTarget(cell ? cells[source]?.[cell.index] : undefined, slices);
    openMenu(source, target.index, x, y, target.rest ? null : cell, { slices }, target.rest, target.label);
  }

  /**
   * Matt, 2026-11-12: a band's menu offers color swatches for its name, and a pattern lane cell's for its pattern in
   * that lane (not a rest's, a letter lane's, or any under Clip color, where everything is the clip's color). Read
   * again after every edit, so the picked one is marked.
   */
  const menuSwatches = $derived.by(() => {
    if (!menu || colorMode === "uniform") return null;
    void sections;
    void cells;
    if (menu.source === "mix") {
      if (menuCell !== null) return null;
      return { ...dialog.swatches(menu.index), note: `Colors every “${sections[menu.index]?.label ?? ""}”` };
    }
    if (!menuCell || rows.length === 0) return null;
    return { ...dialog.patternSwatches(menu.source, menuCell.index), note: `Colors every “${menuTitle ?? ""}” in ${menu.source}` };
  });
  function colorFromMenu(color: number | null) {
    const at = menu;
    const cell = menuCell;
    if (!at || frozen) return;
    if (at.source === "mix") update(() => dialog.setNameColor(at.index, color));
    else if (cell) update(() => dialog.setPatternColor(at.source as StemName, cell.index, color));
  }

  /** The menu's title on a band renames it (Matt, 2026-11-11), in the popover a double-click opens. */
  function renameBandFromMenu() {
    const at = menu;
    menu = null;
    menuCell = null;
    menuLane = null;
    menuTitle = null;
    if (at && !frozen) timeline?.renameBand(at.index);
  }
  // Plan 6, Task 5: the menu's title (Rename pattern… until Matt, 2026-11-11) opens the rename popover on the cell,
  // over the lane's labels in use.
  let renaming = $state<{ source: StemName; index: number; anchor: DOMRect; value: string; names: string[] } | null>(null);
  let patternPopover = $state<RenamePopover>();
  function renameFromMenu() {
    const at = menu;
    const cell = menuCell;
    menu = null;
    menuCell = null;
    menuLane = null;
    if (!at || at.source === "mix" || !cell || frozen) return; // a band (the mix) has no pattern to rename
    const lane = cells[at.source] ?? [];
    const names = [...new Set(lane.filter((c) => !c.rest).map((c) => c.label))];
    renaming = { source: at.source, index: cell.index, anchor: cell.anchor, value: lane[cell.index]?.label ?? "", names };
  }
  function renamed(text: string | null, insert = false) {
    const r = renaming;
    renaming = null;
    if (r && text !== null) update(() => dialog.renamePattern(r.source, r.index, text, insert));
  }
  /**
   * Plan 6, Task 8: what Send all stems sends of each stem: its pattern lane's slices (as a lane send's), or, for a
   * stem with no pattern lane (no pattern features, or the engine left that stem out), the dialog's sections.
   */
  const stemSlices = () =>
    Object.fromEntries(STEM_NAMES.map((s) => [s, rows.includes(s) ? dialog.laneSlices(s) : dialog.sections()])) as Record<StemName, Section[]>;
  function send(target: SendTarget) {
    const at = menu;
    menu = null;
    if (!at || frozen) return;
    timeline?.commitRename();
    const lane = menuLane;
    menuLane = null;
    if (target === "allStems") sendAll();
    else void close(() => sendResult(target, at, lane ? lane.slices : dialog.sections(), dialog.prefs()));
  }
  /**
   * Send all stems to new tracks, from the send menu or (Matt, Live, 3 Nov) the footer's Send to new tracks button:
   * a rename still being typed is committed first, as Apply does.
   */
  function sendAll() {
    if (frozen) return;
    timeline?.commitRename();
    patternPopover?.commit();
    void close(() => allStemsResult(dialog.sections(), stemSlices(), dialog.prefs()));
  }

  /** fb2 review I2: one click without hand edits; with them, the inline confirmation first. */
  function reanalyse() {
    if (frozen) return;
    if (dialog.handEdited) confirmReanalyse = true;
    else void close(() => ({ action: "reanalyse", prefs: dialog.prefs() }));
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<main>
  <header class:frozen inert={frozen}>
    <h1>{payload.clipName}</h1>
    {#if keyLine}<span class="key" title={keyLine.title}>{keyLine.text}</span>{/if}
    <ModePicker mode="structure" modes={payload.modes} onswitch={(m: DialogMode) => close(() => ({ action: "switch", mode: m, prefs: dialog.prefs() }))} />
    <span class="hint">Letters group similar sections; the word is a guess. Drag a handle to move, or click it and use ← → (⇧ for a bar). Double-click the waveform to add, double-click a handle or press Delete to remove, double-click a band to rename. Hold {BYPASS_KEY} while dragging or adding to skip snapping; pinch or {BYPASS_KEY}-scroll to zoom. Right-click to send a band or lane, or rename a pattern. Double-click a slider to reset it.</span>
    <About />
  </header>

  <div class="stack" class:frozen inert={frozen}>
    <Timeline
      bind:this={timeline}
      disabled={frozen || menu !== null}
      waveform={payload.waveform}
      {duration}
      {sections}
      {boundaries}
      {selected}
      audioUrl={payload.audioUrl}
      bind:view
      {nudgeGrid}
      {lengthGrid}
      onmove={(i, t, free) => (stopStem(), update(() => dialog.move(i, t, free), true))}
      onmoveend={moveEnd}
      onadd={(t, free) => (stopStem(), update(() => dialog.add(t, free)))}
      onremove={(i) => (stopStem(), update(() => dialog.remove(i)))}
      onselect={(i) =>
        update(() => {
          dialog.selected = i;
          if (i === null) dialog.selectLaneCut(null); // a click on the waveform background unselects a lane cut too
        })}
      onrename={(i, label, insert) => update(() => dialog.rename(i, label, insert))}
      keyOf={letterKey}
      onplaystart={stopStem}
      onmenu={(i, x, y) => openMenu("mix", i, x, y)}
      {keys}
    />
    <StemLanes
      lanes={rows.length > 0 ? cells : lanes!}
      {rows}
      {duration}
      {showStems}
      stems={payload.analysis.stems}
      playable={stemUrls !== null}
      playing={stemPlaying}
      playhead={stemHead}
      onplay={playStem}
      {view}
      {stemUrls}
      onwheel={(e) => timeline?.wheel(e)}
      onmenu={openLaneMenu}
      {keys}
      {sections}
      {selectedCut}
      {nudgeGrid}
      disabled={frozen || menu !== null || renaming !== null}
      onselectcut={(source, index) => (stopAll(), update(() => dialog.selectLaneCut({ source, index })))}
      onmovecut={(source, index, t, free) => (stopStem(), update(() => dialog.moveLaneCut(source, index, t, free)))}
      oninsertcut={(source, t, free) => (stopStem(), update(() => dialog.insertLaneCut(source, t, free)))}
      ondeletecut={(source, index) => (stopStem(), update(() => dialog.deleteLaneCut(source, index)))}
      onnudged={audition}
      onunlock={unlockAudio}
      onview={(v) => (view = v)}
    />
  </div>

  {#if menu}
    <SendMenu
      at={menu}
      label={menuTitle ?? sections[menu.index]?.label ?? ""}
      blocked={menu.source !== "mix" && stemUrls === null ? NO_STEMS_TO_SEND : menuLane?.slices.length === 0 ? ALL_RESTS : null}
      stems={stemUrls !== null}
      onchoose={send}
      onclose={() => ((menu = null), (menuCell = null), (menuLane = null), (menuTitle = null))}
      keyInNames={hasKeys && menu.source !== "drums" ? keyInNames : null}
      onkeyinnames={(on) => (keyInNames = on)}
      onrename={menuCell ? renameFromMenu : menu.source === "mix" ? renameBandFromMenu : null}
      swatches={menuSwatches}
      oncolor={colorFromMenu}
    />
  {/if}

  {#if renaming}
    <RenamePopover bind:this={patternPopover} anchor={renaming.anchor} value={renaming.value} names={renaming.names} keyOf={numberKey} subject="pattern" ondone={renamed} />
  {/if}

  {#if stemError}
    <p class="note error">{stemError}</p>
  {/if}

  {#if payload.warpNote}
    <p class="note">Session slices are rebuilt from the file. Live can’t copy warping, so if Live would warp them differently from this clip, they’re made unwarped at the file’s own tempo. Clip settings like gain reset.</p>
  {/if}

  {#if confirmReanalyse}
    <div class="confirm" role="alertdialog" aria-label="Re-analyze" aria-describedby="reanalyse-note">
      <span class="note" id="reanalyse-note">Re-analyze discards your edits in this dialog.</span>
      <TextButton labels={{ off: "Re-analyze", on: "Re-analyze" }} appearance="primary" onValueChange={() => void close(() => ({ action: "reanalyse", prefs: dialog.prefs() }))} />
      <TextButton labels={{ off: "Keep editing", on: "Keep editing" }} appearance="subtle" onValueChange={() => (confirmReanalyse = false)} />
    </div>
  {/if}

  {#if checking}
    <p class="note" role="status">{CHECKING_CONNECTION}</p>
  {/if}

  {#if lost}
    <p class="note error" role="alert">{LOST_CONNECTION}</p>
  {/if}

  <div class="footer">
    <StructureControls
      {granularity}
      canGranulate={dialog.canGranulate}
      ongranularity={(g) => {
        stopAll(); // the sections are replaced
        slide(() => dialog.setGranularity(g));
      }}
      onrelease={release}
      {groupDist}
      ongroupdist={(d) => slide(() => dialog.setGroupDist(d))}
      {patternSteps}
      {patternLevel}
      canPattern={rows.length > 0 && patternSteps.length > 1}
      onpatterns={(level) => {
        stopStem(); // the lane cells come and go
        slide(() => dialog.setPatternLevel(level));
      }}
      {showStems}
      onshowstems={(on) => update(() => dialog.setShowStems(on))}
      onreanalyse={stemUrls === null ? reanalyse : null}
      {sliceBy}
      {sliceable}
      onslice={(s) => update(() => dialog.setSliceBy(s))}
      {colorMode}
      {output}
      view={payload.view}
      count={sections.length}
      {snap}
      canSnap={dialog.canSnap}
      {snapTarget}
      canSnapDownbeats={dialog.canSnapDownbeats}
      canSnapBars={dialog.canSnapBars}
      {snapMerged}
      onsnap={(on) => {
        stopAll(); // a re-snap can move or merge the playing section
        update(() => dialog.setSnap(on));
      }}
      onsnaptarget={(t) => {
        stopAll();
        update(() => dialog.setSnapTarget(t));
      }}
      oncolormode={(m) => update(() => dialog.setColorMode(m))}
      onoutput={(o) => update(() => (dialog.output = o))}
      busy={frozen}
      oncancel={cancel}
      onapply={apply}
      onsendall={stemUrls === null ? null : sendAll}
    />
  </div>
</main>

<style>
  main {
    box-sizing: border-box;
    height: 100vh;
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* Task 12 I1: the name gives way first (ellipsis, down to 6em) so the picker's buttons stay on screen. */
    flex: 0 100 auto;
    min-width: 6em;
    max-width: 60%;
  }
  .stack {
    /* Task 13 Live fix 4: the timeline takes the spare height, so no empty area is left under the lanes. */
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .key {
    flex: none;
    font-size: 12px;
    white-space: nowrap;
  }
  .hint {
    flex: 1 1 0; /* only the space left over; it wraps (Task 13 Live fix 3) rather than being cut off */
    min-width: 0;
    color: var(--muted-text-color);
    font-size: 11px;
    line-height: 1.35;
  }
  /* A question in the picker takes the row: squeezed beside it the hint grows a column taller than the dialog. */
  header:has(:global(.consent), :global(.confirm), :global(.retry)) .hint {
    display: none;
  }
  .note {
    margin: 0;
    font-size: 12px;
    color: var(--muted-text-color);
  }
  .note.error {
    color: var(--live-alert);
  }
  .footer {
    margin-top: auto;
  }
  .frozen {
    opacity: 0.55;
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .confirm :global(.text-button) {
    min-inline-size: 0;
    min-block-size: 20px;
    padding: 0 10px;
    font-size: 11px;
  }
</style>
