<script lang="ts">
  import Controls from "./Controls.svelte";
  import ModePicker from "./ModePicker.svelte";
  import About from "./About.svelte";
  import SendMenu from "./SendMenu.svelte";
  import Timeline from "./Timeline.svelte";
  import { CHECKING_CONNECTION, closeWith, deliver, LOST_CONNECTION } from "./bridge.js";
  import { BYPASS_KEY } from "./modifier.js";
  import type { CuePayload, DialogMode, DialogResult, SendTarget } from "./protocol.js";
  import { createDialogState } from "./state.js";
  import { sendResult, withKeyInNames, type SendMenuAt } from "./send.js";
  import { headerKey, sectionKeyTexts } from "./keys.js";
  import type { LengthGrid } from "./lengths.js";
  import type { NudgeGrid } from "./nudge.js";
  import { cueLengthGrid, nudgeGridFor } from "./gridChoice.js";
  import { fitView } from "./zoom.js";

  let { payload }: { payload: CuePayload } = $props();

  // svelte-ignore state_referenced_locally
  const dialog = createDialogState(payload);
  // svelte-ignore state_referenced_locally
  const duration = payload.durationSec;

  // `dialog` is a plain object: bump `version` after each mutation to re-render.
  let version = $state(0);
  function update(fn: () => void) {
    if (frozen) return; // fb2 review I3: no edit while the result is on its way (the Delete key reaches the window)
    fn();
    version++;
  }
  /** Reads `version` so a $derived using this re-runs after each update(). */
  function tracked<T>(read: () => T): T {
    version;
    return read();
  }
  const sections = $derived(tracked(() => dialog.sections()));
  const boundaries = $derived(tracked(() => [...dialog.boundaries]));
  const selected = $derived(tracked(() => dialog.selected));
  const granularity = $derived(tracked(() => dialog.granularity));
  const colorMode = $derived(tracked(() => dialog.colorMode));
  const output = $derived(tracked(() => dialog.output));
  const snap = $derived(tracked(() => dialog.snap));
  const snapMerged = $derived(tracked(() => dialog.snapMerged));
  // v2: the keys, from the host's harmony; a section's follows its edits at once.
  // svelte-ignore state_referenced_locally
  const keyLine = headerKey(payload.harmony, payload.setScale);
  const keys = $derived(sectionKeyTexts(payload.harmony, sections));
  // svelte-ignore state_referenced_locally
  let keyInNames = $state(payload.keyInNames ?? true);
  // svelte-ignore state_referenced_locally
  const hasKeys = payload.harmony != null;

  let timeline: Timeline;

  // fb3: the zoom starts at fit for each dialog. fb4, item 1: the lengths go by Live's grid for the clip whether Snap is
  // on or not, or by a cached Structure analysis's beats where Live has none; the nudges by the same grid
  // (gridChoice.ts).
  // svelte-ignore state_referenced_locally
  let view = $state(fitView(duration));
  // svelte-ignore state_referenced_locally
  const liveGrid: LengthGrid | null = payload.beatGrid ? { beats: payload.beatGrid, bars: payload.barGrid ?? [] } : null;
  // svelte-ignore state_referenced_locally
  const sg = payload.structureGrid;
  const lengthGrid: LengthGrid | null = cueLengthGrid({ live: liveGrid, structure: sg ? { beats: sg.beats, bars: sg.downbeats } : null });
  const snapping = $derived(snap && dialog.canSnap);
  // svelte-ignore state_referenced_locally
  const nudgeGrid: NudgeGrid = $derived(nudgeGridFor(snapping, liveGrid, lengthGrid, payload.tempo));

  /** Set when Apply or a switch found the extension gone: the dialog stays open and says so (feedback round 2). */
  let lost = $state(false);
  /** fb2 review I3, as in StructureView: frozen (only Cancel works) while the host is asked, and once the result went. */
  let checking = $state(false);
  let sent = $state(false);
  const frozen = $derived(checking || sent);

  /** Apply or a switch: asks the host first, then sends the result `make` builds (bridge.ts deliver). */
  async function close(make: () => DialogResult) {
    if (frozen) return; // a second click while the host is being asked
    timeline?.stop();
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
    timeline?.stop();
    sent = true;
    closeWith(dialog.cancel());
  }

  /** Apply: a rename still being typed is committed first, so it is in the result. */
  function apply() {
    if (frozen) return;
    timeline?.commitRename();
    void close(() => dialog.result());
  }

  // v2: a right-click on a band opens the send menu for the mix; a choice closes the dialog as Apply does.
  let menu = $state<SendMenuAt | null>(null);
  function openMenu(index: number, x: number, y: number) {
    if (frozen) return;
    timeline?.stop();
    menu = { source: "mix", index, x, y };
  }
  /** The menu's title renames its band (Matt, 2026-11-11), in the popover a double-click opens. */
  function renameFromMenu() {
    const at = menu;
    menu = null;
    if (at && !frozen) timeline?.renameBand(at.index);
  }
  function send(target: SendTarget) {
    const at = menu;
    menu = null;
    if (!at || frozen) return;
    timeline?.commitRename();
    void close(() => sendResult(target, at, dialog.sections()));
  }
</script>

<main>
  <header class:frozen inert={frozen}>
    <h1>{payload.clipName}</h1>
    {#if keyLine}<span class="key" title={keyLine.title}>{keyLine.text}</span>{/if}
    <ModePicker mode="cue" modes={payload.modes} durationSec={duration} onswitch={(m: DialogMode, download?: boolean) => close(() => ({ action: "switch", mode: m, ...(download ? { download: true as const } : {}) }))} />
    <span class="hint">Drag a handle to move, or click it and use ← → (⇧ for a bar). Double-click the waveform to add, double-click a handle or press Delete to remove, double-click a band to rename. Hold {BYPASS_KEY} while dragging or adding to skip snapping; pinch or {BYPASS_KEY}-scroll to zoom. Right-click a band to send it. Double-click the slider to reset it.</span>
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
    onmove={(i, t, free) => update(() => dialog.move(i, t, free))}
    onadd={(t, free) => update(() => dialog.add(t, free))}
    onremove={(i) => update(() => dialog.remove(i))}
    onselect={(i) => update(() => (dialog.selected = i))}
    onrename={(i, label) => update(() => dialog.rename(i, label))}
    onmenu={openMenu}
    {keys}
  />
  </div>

  {#if menu}
    <SendMenu
      at={menu}
      label={sections[menu.index]?.label ?? ""}
      onchoose={send}
      onclose={() => (menu = null)}
      keyInNames={hasKeys ? keyInNames : null}
      onkeyinnames={(on) => (keyInNames = on)}
      onrename={renameFromMenu}
    />
  {/if}

  {#if payload.warpNote}
    <p class="note">Session slices are rebuilt from the file. Live can’t copy warping, so if Live would warp them differently from this clip, they’re made unwarped at the file’s own tempo. Clip settings like gain reset.</p>
  {/if}

  {#if checking}
    <p class="note" role="status">{CHECKING_CONNECTION}</p>
  {/if}

  {#if lost}
    <p class="note error" role="alert">{LOST_CONNECTION}</p>
  {/if}

  <div class="footer">
    <Controls
      {granularity}
      defaultGranularity={payload.granularity}
      {colorMode}
      {output}
      view={payload.view}
      count={sections.length}
      {snap}
      canSnap={dialog.canSnap}
      {snapMerged}
      onsnap={(on) => {
        timeline?.stop(); // a re-snap can move or merge the playing section
        update(() => dialog.setSnap(on));
      }}
      ongranularity={(g) => {
        timeline?.stop();
        update(() => dialog.setGranularity(g));
      }}
      oncolormode={(m) => update(() => (dialog.colorMode = m))}
      onoutput={(o) => update(() => (dialog.output = o))}
      busy={frozen}
      oncancel={cancel}
      onapply={apply}
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
  .stack {
    /* fb2 review I3: wraps the timeline so it can be frozen; it lays out as main did (the timeline takes the height). */
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .footer {
    margin-top: auto;
  }
  .frozen {
    opacity: 0.55;
  }
</style>
