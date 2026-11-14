<script lang="ts">
  import type { KeyOf } from "../grouping/renumber.js";
  import { onDestroy, onMount, tick } from "svelte";
  import type { Section } from "../core/types.js";
  import Bands from "./Bands.svelte";
  import Waveform from "./Waveform.svelte";
  import { formatLength, type LengthGrid } from "./lengths.js";
  import { BYPASS_KEY, bypassesSnap, isTextEntry } from "./modifier.js";
  import { AUDITION_SEC, nudgeTime, type NudgeGrid } from "./nudge.js";
  import { createPlayer, type Pcm16 } from "./player.js";
  import { EDGE_PX, EDGE_STEP, edgeSpeed, fitView, panBy, toFrac, wheelZoomFactor, zoomAround, zoomLevel, type ZoomView } from "./zoom.js";

  // The waveform, bands, boundary handles and section playback, shared by the Cue and Structure views.
  // It owns playback; a parent that changes the sections out from under it calls stop().
  // fb3: it owns the zoom too (`view`, bound by the Structure view so the stem lanes follow it), the arrow-key nudges
  // of a selected handle with their audition, and the section lengths.
  interface Props {
    waveform: { min: number[]; max: number[] };
    duration: number;
    sections: Section[];
    boundaries: number[];
    selected: number | null;
    audioUrl: string;
    /** `free`: the snap-bypass key was held (modifier.ts), or a nudge put it on the grid itself. */
    onmove: (i: number, t: number, free: boolean) => void;
    onadd: (t: number, free: boolean) => void;
    onremove: (i: number) => void;
    /** Plan 6: a boundary move is done (a dragged handle let go, or a nudge); onmove fires on every drag frame. */
    onmoveend?: () => void;
    onselect: (i: number | null) => void;
    onrename: (i: number, label: string, insert?: boolean) => void;
    /** Bands.keyOf: a section's letter, for the rename list. */
    keyOf?: KeyOf | null;
    /** A band started playing (the Structure view stops a stem that is playing). */
    onplaystart?: () => void;
    /** fb3: the zoomed window of clip seconds on screen. Starts at fit; each dialog has its own. */
    view?: ZoomView;
    /** fb3, item 4: what an arrow key moves the selected handle by. */
    nudgeGrid?: NudgeGrid;
    /** fb3, item 3: the active grid for the lengths (bars and beats), or null for seconds. */
    lengthGrid?: LengthGrid | null;
    /** fb3 review m1: the dialog is frozen (Apply is being checked or has gone): the keys do nothing. */
    disabled?: boolean;
    /** v2: a right-click on a band (Bands.onmenu). */
    onmenu?: (i: number, x: number, y: number) => void;
    /** v2: each section's key as shown (Bands.keys). */
    keys?: (string | null)[];
  }

  let {
    waveform,
    duration,
    sections,
    boundaries,
    selected,
    audioUrl,
    onmove,
    onadd,
    onremove,
    onmoveend,
    onselect,
    onrename,
    keyOf = null,
    onplaystart,
    // svelte-ignore state_referenced_locally
    view = $bindable(fitView(duration)),
    nudgeGrid,
    lengthGrid = null,
    disabled = false,
    onmenu,
    keys,
  }: Props = $props();

  // Playback
  let playing = $state<number | null>(null);
  let playhead = $state<number | null>(null);
  let playError = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  const player = createPlayer(audioUrl, (e) => {
    stop();
    playError = "Playback unavailable: " + (e instanceof Error ? e.message : String(e));
  });
  let frame = 0;

  function tickPlayhead() {
    const t = player.position();
    if (t !== null) playhead = t;
    // position() is null until the first buffer is scheduled; once it has played, null means it ended.
    else if (playhead !== null) return stop();
    frame = requestAnimationFrame(tickPlayhead);
  }

  let bands: Bands;

  /** Commits a rename still being typed, so an Apply clicked while its field is open includes it. */
  export function commitRename() {
    bands?.commit();
  }

  /** Opens the rename popover on band i (the send menu's title). */
  export function renameBand(i: number) {
    bands?.rename(i);
  }

  export function stop() {
    player.stop();
    cancelAnimationFrame(frame);
    playing = null;
    playhead = null;
  }

  /** Plays [from, to) of the clip with band `i` (none: null) marked as playing. */
  function playFrom(i: number | null, from: number, to: number) {
    stop();
    playError = null;
    playing = i;
    onplaystart?.();
    player.playRange(from, to);
    frame = requestAnimationFrame(tickPlayhead);
  }

  function play(i: number) {
    if (playing === i) return stop();
    const s = sections[i];
    playFrom(i, s.start, s.end);
  }

  // fb3, item 2: the preview loads in the background once the dialog is up, so the first click plays at once.
  // fb2 review I2 (merged at int3): the same preload, started right at mount rather than on idle, is what the host's
  // background Structure analysis waits for (dialogServer.ts onReady), so it must not wait for the page to go quiet.
  // It runs in every dialog, with or without a background analysis, and fetches the whole preview once.
  // fb4, item 2: the same preview's samples draw the zoomed waveform once they are in.
  let pcm = $state.raw<Pcm16 | null>(null);
  onMount(() => {
    const off = player.onLoad((p) => (pcm = p));
    player.preload();
    return off;
  });

  onDestroy(() => {
    stop();
    player.dispose();
    cancelAnimationFrame(scrollFrame);
    clearTimeout(readoutTimer);
  });

  // Zoom (fb3, item 5): pinch or Cmd+scroll zooms around the pointer, horizontal scroll or the scrollbar pans, Fit or
  // Cmd+0 resets. Everything in the timeline is placed by `view`.
  let timeline: HTMLDivElement;
  const zoomed = $derived(zoomLevel(view, duration) > 1 + 1e-9);
  const pct = (t: number) => toFrac(view, t) * 100;
  const fracAt = (clientX: number) => {
    const r = timeline.getBoundingClientRect();
    return r.width > 0 ? (clientX - r.left) / r.width : 0;
  };

  const FIT_KEY = BYPASS_KEY === "⌘" ? "⌘0" : `${BYPASS_KEY}+0`;

  export function fit() {
    view = fitView(duration);
  }

  /** A wheel over the timeline or the stem lanes (StructureView forwards theirs): zoom or pan. */
  export function wheel(e: WheelEvent) {
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      // A trackpad pinch arrives as a wheel with ctrlKey in Chrome; Cmd+scroll is the mouse's way.
      e.preventDefault();
      view = zoomAround(view, duration, wheelZoomFactor(e.deltaY * scale), Math.min(1, Math.max(0, fracAt(e.clientX))));
      return;
    }
    const dx = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (dx === 0 || Math.abs(e.deltaY) > Math.abs(dx) * 2 + 1e-9 && !e.shiftKey) return; // a vertical scroll: not ours
    if (!zoomed) return;
    e.preventDefault();
    const r = timeline.getBoundingClientRect();
    view = panBy(view, duration, ((dx * scale) / Math.max(1, r.width)) * view.span);
  }

  // WebKit (Live's web view on the Mac) sends a trackpad pinch as gesture events, not as a ctrl wheel.
  let gesture: { view: ZoomView; frac: number } | null = null;
  type Gesture = Event & { scale: number; clientX: number };
  function gesturestart(e: Event) {
    e.preventDefault();
    gesture = { view, frac: Math.min(1, Math.max(0, fracAt((e as Gesture).clientX))) };
  }
  function gesturechange(e: Event) {
    e.preventDefault();
    if (gesture) view = zoomAround(gesture.view, duration, (e as Gesture).scale, gesture.frac);
  }
  function gestureend(e: Event) {
    e.preventDefault();
    gesture = null;
  }

  $effect(() => {
    // Not passive: a zoom or pan must not also scroll or zoom the page.
    const el = timeline;
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gesturestart);
    el.addEventListener("gesturechange", gesturechange);
    el.addEventListener("gestureend", gestureend);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gesturestart);
      el.removeEventListener("gesturechange", gesturechange);
      el.removeEventListener("gestureend", gestureend);
    };
  });

  /** Pans just enough to show `t`, a little in from the edge (Plan 6: also a nudged lane cut, for the Structure view). */
  export function reveal(t: number) {
    const margin = view.span * 0.05;
    if (t < view.start + margin) view = panBy(view, duration, t - margin - view.start);
    else if (t > view.start + view.span - margin) view = panBy(view, duration, t + margin - (view.start + view.span));
  }

  // The scrollbar: drag the thumb to pan; a press on the track centres the view there.
  let track = $state<HTMLDivElement>();
  let thumbDrag: { x: number; start: number } | null = null;
  function trackDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = track!.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * duration;
    if (!(e.target as HTMLElement).classList.contains("thumb")) view = panBy(view, duration, t - view.span / 2 - view.start);
    thumbDrag = { x: e.clientX, start: view.start };
  }
  function trackMove(e: PointerEvent) {
    if (!thumbDrag) return;
    const r = track!.getBoundingClientRect();
    view = panBy({ start: thumbDrag.start, span: view.span }, duration, ((e.clientX - thumbDrag.x) / r.width) * duration);
  }
  function trackUp() {
    thumbDrag = null;
  }

  // Boundary handles
  let dragging = $state<number | null>(null);
  let downX = 0;
  let moved = $state(false);
  let lastX = 0;
  let lastFree = false;
  let scrollFrame = 0;
  const DRAG_THRESHOLD_PX = 3;

  function timeAt(clientX: number): number {
    return view.start + fracAt(clientX) * view.span;
  }

  function grab(e: PointerEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = i;
    downX = e.clientX;
    lastX = e.clientX;
    moved = false;
    stop();
    onselect(i);
  }

  function drag(e: PointerEvent) {
    if (dragging === null) return;
    lastX = e.clientX;
    lastFree = bypassesSnap(e);
    // A click or double-click must not nudge the boundary.
    if (!moved && Math.abs(e.clientX - downX) <= DRAG_THRESHOLD_PX) return;
    moved = true;
    onmove(dragging, timeAt(e.clientX), lastFree);
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoscroll);
  }

  /** fb3, item 5: a handle dragged near or past an edge of a zoomed view scrolls it, and keeps following the pointer. */
  function autoscroll() {
    scrollFrame = 0;
    if (dragging === null || !moved || !zoomed) return;
    const r = timeline.getBoundingClientRect();
    const speed = edgeSpeed(lastX - r.left, r.width, EDGE_PX);
    if (speed === 0) return;
    const before = view.start;
    view = panBy(view, duration, speed * EDGE_STEP * view.span);
    if (view.start !== before) onmove(dragging, Math.min(duration, Math.max(0, timeAt(lastX))), lastFree);
    scrollFrame = requestAnimationFrame(autoscroll);
  }

  function drop() {
    if (dragging !== null && moved) onmoveend?.();
    dragging = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  function removeAt(e: MouseEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    stop();
    onremove(i);
  }

  // Section lengths (fb3, item 3): on the bands, and live beside a handle while it is dragged or nudged.
  const lengthOf = (s: Section) => formatLength(s.start, s.end, lengthGrid);
  /** The handle whose two sections' lengths are shown beside it: the dragged one, or the one nudged last. */
  let nudged = $state<number | null>(null);
  let readoutTimer: ReturnType<typeof setTimeout> | undefined;
  const READOUT_MS = 1500;
  const readout = $derived(dragging !== null && moved ? dragging : nudged);

  // Nudging (fb3, item 4): with a handle selected, Left/Right move it a beat of the active grid and Shift a bar, then
  // play AUDITION_SEC of the section that now starts there, from the handle; each nudge restarts it.
  async function nudge(i: number, dir: 1 | -1, bar: boolean) {
    if (!nudgeGrid) return;
    const from = boundaries[i];
    const to = nudgeTime(from, dir, bar, nudgeGrid);
    if (to === from) return;
    player.unlock(); // fb3 review m2: still inside the key press, so the first nudge may start the audio
    onmove(i, to, true); // on the grid already (or free with snap off): not snapped again
    onmoveend?.();
    await tick();
    const b = boundaries[i];
    if (b === undefined) return;
    reveal(b);
    nudged = i;
    clearTimeout(readoutTimer);
    readoutTimer = setTimeout(() => (nudged = null), READOUT_MS);
    const s = sections[i + 1];
    if (s) playFrom(i + 1, b, Math.min(s.end, b + AUDITION_SEC));
  }

  // In the capture phase, so with a handle selected an arrow key moves only the handle: the slider or the tabs that
  // have focus never see it.
  function onkeydown(e: KeyboardEvent) {
    if (disabled || isTextEntry(e.target)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "0" || e.code === "Digit0")) {
      e.preventDefault();
      e.stopPropagation();
      fit();
      return;
    }
    if (selected === null) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      void nudge(selected, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    stop();
    onremove(selected);
  }

  /** The lengths beside handle `i`: of the section it ends and of the one it starts. */
  const sidesOf = (i: number) => {
    const a = sections[i];
    const b = sections[i + 1];
    return a && b ? { at: boundaries[i], left: lengthOf(a), right: lengthOf(b) } : null;
  };
  const sides = $derived(readout === null ? null : sidesOf(readout));
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="timeline" class:zoomed bind:this={timeline}>
  <Waveform
    {waveform}
    {duration}
    {sections}
    {playhead}
    {view}
    {pcm}
    onadd={(t, free) => {
      stop();
      onadd(t, free);
    }}
    onbackground={() => onselect(null)}
  />
  <Bands bind:this={bands} {sections} {duration} {playing} onplay={play} {onrename} {keyOf} {view} {lengthOf} {onmenu} {keys} />
  {#each boundaries as b, i (i)}
    {@const f = toFrac(view, b)}
    <div
      class="handle"
      class:selected={selected === i}
      class:offscreen={f < 0 || f > 1}
      style:left="{pct(b)}%"
      role="slider"
      aria-label="Boundary {i + 1}"
      aria-valuenow={b}
      tabindex="-1"
      onpointerdown={(e) => grab(e, i)}
      onpointermove={drag}
      onpointerup={drop}
      onpointercancel={drop}
      onlostpointercapture={drop}
      ondblclick={(e) => removeAt(e, i)}
    ></div>
  {/each}
  {#if sides && toFrac(view, sides.at) >= 0 && toFrac(view, sides.at) <= 1}
    <div class="readout" style:left="{pct(sides.at)}%" aria-live="polite">
      <span class="side left">{sides.left}</span><span class="side right">{sides.right}</span>
    </div>
  {/if}
  {#if zoomed}
    <button class="fit" type="button" title="Show the whole clip ({FIT_KEY})" onclick={fit}>Fit</button>
    <!-- A mouse affordance (the keyboard has Cmd+0); hidden from assistive tech like the handles' tick marks. -->
    <div
      class="scroll"
      bind:this={track}
      aria-hidden="true"
      onpointerdown={trackDown}
      onpointermove={trackMove}
      onpointerup={trackUp}
      onpointercancel={trackUp}
    >
      <div class="thumb" style:left="min({(view.start / duration) * 100}%, calc(100% - 16px))" style:width="{(view.span / duration) * 100}%"></div>
    </div>
  {/if}
</div>

{#if playError}
  <p class="note error">{playError}</p>
{/if}

<style>
  .timeline {
    position: relative;
    border: 1px solid var(--live-frame);
    /* Task 13 Live fix 4: fill the dialog's spare height (the waveform grows); the bands keep their height. */
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden; /* fb3: zoomed, handles and bands run off both ends */
  }
  .timeline {
    --bands-height: 34px;
  }
  /* Feedback round 2: a handle is grabbed over the waveform only. Over the bands it covered a whole narrow band (11 px
     wide, as wide as a 2 s section), so a double-click meant to rename that band removed its boundary instead. Its line
     still runs down through the bands, but lets clicks through to them. */
  .handle {
    position: absolute;
    top: 0;
    bottom: var(--bands-height);
    width: 11px;
    margin-left: -5px;
    cursor: ew-resize;
    touch-action: none;
  }
  .handle.offscreen {
    visibility: hidden;
  }
  .handle::before {
    content: "";
    position: absolute;
    left: 5px;
    top: 0;
    bottom: calc(-1 * var(--bands-height));
    width: 1px;
    pointer-events: none;
    background: color-mix(in srgb, var(--live-fg) 80%, transparent);
  }
  .handle::after {
    content: "";
    position: absolute;
    left: 1px;
    top: 0;
    width: 9px;
    height: 9px;
    background: color-mix(in srgb, var(--live-fg) 80%, transparent);
    clip-path: polygon(0 0, 100% 0, 50% 100%);
  }
  .handle:hover::before,
  .handle:hover::after {
    background: var(--live-fg);
  }
  .handle.selected::before,
  .handle.selected::after {
    background: var(--modulation-color);
  }
  .handle.selected::before {
    width: 2px;
    left: 4.5px;
  }
  /* fb3, item 3: the two neighbouring sections' lengths, either side of the handle being moved. */
  .readout {
    position: absolute;
    top: 12px;
    width: 0;
    pointer-events: none;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .side {
    position: absolute;
    top: 0;
    padding: 3px 5px;
    border-radius: 2px;
    background: var(--live-control);
    color: var(--live-fg);
    border: 1px solid var(--live-frame);
    white-space: nowrap;
  }
  .side.left {
    right: 4px;
  }
  .side.right {
    left: 4px;
  }
  /* fb3, item 5: zoom controls over the waveform's corner and foot, only while zoomed (the layout does not move). */
  .fit {
    position: absolute;
    top: 4px;
    right: 4px;
    padding: 2px 8px;
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    background: var(--live-control);
    color: var(--live-fg);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .fit:hover {
    color: var(--live-on-fg);
    background: var(--live-on);
  }
  .scroll {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(var(--bands-height) + 1px);
    height: 7px;
    background: color-mix(in srgb, var(--live-fg) 18%, transparent);
    cursor: pointer;
    touch-action: none;
  }
  .thumb {
    position: absolute;
    top: 1px;
    bottom: 1px;
    min-width: 16px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--live-fg) 45%, transparent);
  }
  .scroll:hover .thumb {
    background: color-mix(in srgb, var(--live-fg) 65%, transparent);
  }
  .note {
    margin: 0;
    font-size: 12px;
    color: var(--muted-text-color);
  }
  .note.error {
    color: var(--live-alert);
  }
</style>
