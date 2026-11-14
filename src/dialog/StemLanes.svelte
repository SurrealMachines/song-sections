<script lang="ts">
  import { tick, untrack } from "svelte";
  import { STEM_NAMES, type StemFeatures, type StemName } from "../structure/contract.js";
  import { hostFetchBytes } from "./bridge.js";
  import { liveColor, onSchemeChange } from "./liveTheme.js";
  import { bypassesSnap, isTextEntry } from "./modifier.js";
  import { nudgeTime, type NudgeGrid } from "./nudge.js";
  import { parsePcm16 } from "./player.js";
  import { detailBin, detailColumns, detailCovers, detailRange, needsDetail, reduceDetail, type StemDetail } from "./stemDetail.js";
  import { columnPeaks, peakScale } from "./stemPeaks.js";
  import { sectionAt, type LaneCell, type LaneCutRef, type LaneSection } from "./structureState.js";
  import { EDGE_PX, EDGE_STEP, edgeSpeed, fitView, panBy, zoomLevel, type ZoomView } from "./zoom.js";

  // Four lanes under the bands, cut at the same boundaries.
  // Plan 6: with pattern features, `rows` lists the pattern lanes instead: the mix first, then each stem that has one,
  // each cut at its own pattern slices. Without them (`rows` empty) it is the four letter lanes as before.
  // Show stems (feedback round 1): the lanes grow and each draws its stem's waveform over the coloured cells.
  // Stem audition (feedback round 2 B): with the stems kept (`playable`), a click on a cell plays that section of that
  // stem; the parent owns playback and says which cell is playing and where.
  // Plan 6, Task 5: the pattern lanes' cuts are edited as the section handles are (Timeline.svelte): each cut has a
  // handle the lane's height; a press selects it, a drag moves it (snapped unless the bypass key is held), the arrows
  // nudge the selected one and the parent plays that lane's source from it, Delete or a double-click on a handle
  // removes it, and a double-click in a cell adds one at the pointer. The parent owns the edits (the dialog's state).
  interface Props {
    /** Each row's cells: the pattern lanes (LaneCell) for `rows`, or with `rows` empty the four letter lanes (LaneSection). */
    lanes: Partial<Record<StemName, Array<LaneCell | LaneSection>>>;
    /** Plan 6: the pattern lanes to draw; [] draws the four letter lanes of STEM_NAMES. */
    rows?: StemName[];
    duration: number;
    showStems: boolean;
    stems: Record<StemName, StemFeatures>;
    playable?: boolean;
    playing?: { stem: StemName; index: number } | null;
    playhead?: number | null;
    /** A click on a cell: it plays with `playable` only (kept stems). */
    onplay?: (source: StemName, index: number) => void;
    /** fb3: the Timeline's zoomed window of clip seconds, so the lanes line up with it. */
    view?: ZoomView;
    /** fb3: a wheel over the lanes zooms or pans as one over the timeline does (Timeline.wheel). */
    onwheel?: (e: WheelEvent) => void;
    /** fb4, item 2: the kept stems' audition WAVs (null: none kept): zoomed past the envelope, the lanes draw from them. */
    stemUrls?: Record<StemName, string> | null;
    /** For tests: how a stem slice is fetched (the page's own fetch, recorded for the alive check, by default). */
    fetchBytes?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
    /**
     * v2: a right-click on a cell, at client (x, y): the send menu for that source. `section` indexes `sections`: the
     * section around the cell's middle (a letter lane's cells are the sections). Plan 6, Task 5: `cell` is the pattern
     * row's cell and its box on screen, for renaming from the menu's title; null for a rest and on the letter lanes.
     */
    onmenu?: (source: StemName, section: number, x: number, y: number, cell: { index: number; anchor: DOMRect } | null) => void;
    /** v2: each section's key as shown ("D minor"), or null; in the tooltips of the lanes a key is heard in. */
    keys?: (string | null)[];
    /** Plan 6: the sections `keys` and `onmenu` go by, for the pattern rows, whose cells are not the sections. */
    sections?: readonly { start: number; end: number }[];
    /** Plan 6, Task 5: the selected lane cut (its index among the lane's cuts: cell index + 1 starts at it), or null. */
    selectedCut?: LaneCutRef | null;
    /** What an arrow key moves the selected lane cut by (the section handles' own). */
    nudgeGrid?: NudgeGrid;
    /** The dialog is frozen or a menu is open: the keys do nothing. */
    disabled?: boolean;
    /** The pattern rows' cut edits; without `onmovecut` the cuts have no handles. `free`: the snap-bypass key was held. */
    onselectcut?: (source: StemName, index: number) => void;
    onmovecut?: (source: StemName, index: number, t: number, free: boolean) => void;
    oninsertcut?: (source: StemName, t: number, free: boolean) => void;
    ondeletecut?: (source: StemName, index: number) => void;
    /** A nudge moved the selected cut: the parent plays that lane's source from cell `cell` (the one it starts). */
    onnudged?: (source: StemName, cell: number) => void;
    /**
     * Task 5 review: an arrow key is about to nudge a cut of `source`: the parent opens that source's audio now, still
     * inside the key press (WebKit plays only from a gesture), for the audition that follows an await.
     */
    onunlock?: (source: StemName) => void;
    /** Task 5 review: a cut dragged to an edge of a zoomed view pans it, as a section handle does (Timeline.autoscroll). */
    onview?: (v: ZoomView) => void;
  }

  let {
    lanes,
    rows = [],
    duration,
    showStems,
    stems,
    playable = false,
    playing = null,
    playhead = null,
    onplay = () => {},
    // svelte-ignore state_referenced_locally
    view = fitView(duration),
    onwheel,
    stemUrls = null,
    fetchBytes = hostFetchBytes,
    onmenu,
    keys,
    sections,
    selectedCut = null,
    nudgeGrid,
    disabled = false,
    onselectcut,
    onmovecut,
    oninsertcut,
    ondeletecut,
    onnudged,
    onunlock,
    onview,
  }: Props = $props();
  // The canvases are painted in Live's theme colours, so they repaint when the system switches light or dark.
  let schemeChanges = $state(0);
  $effect(() => onSchemeChange(() => schemeChanges++));

  /** The rows drawn: the pattern lanes, or the four letter lanes. */
  const shown: readonly StemName[] = $derived(rows.length > 0 ? rows : STEM_NAMES);
  const isRest = (c: LaneCell | LaneSection) => "rest" in c && c.rest;
  /** The section a cell is in, for its key and its send menu: a letter lane's cell index is the section's. */
  const sectionOf = (c: LaneCell | LaneSection, i: number) => (rows.length > 0 && sections ? sectionAt(sections, (c.start + c.end) / 2) : i);
  const pct = (t: number) => ((t - view.start) / view.span) * 100;

  /**
   * Shown on every cell when there are no stems to play (an analysis from before this build, or evicted). The
   * Re-analyze button next to Show stems is then shown too (fb2 ruling).
   */
  const NO_STEMS_HINT = "Click Re-analyze to listen to stems";
  const isPlaying = (src: StemName, i: number) => playing?.stem === src && playing.index === i;
  const tip = (src: StemName, s: LaneCell | LaneSection, i: number) => {
    const key = src !== "drums" ? keys?.[sectionOf(s, i)] : null;
    return `${src}: ${isRest(s) ? "rest" : s.label}` + (key ? `\nKey: ${key}` : "") + (playable ? "" : `\n${NO_STEMS_HINT}`);
  };

  const MIN_LABEL_PX = 18;
  let width = $state(0);
  const canvases: Partial<Record<StemName, HTMLCanvasElement>> = $state({});
  const scale = $derived(peakScale(stems));
  let root: HTMLDivElement;
  $effect(() => {
    if (!onwheel) return;
    const el = root;
    const h = (e: WheelEvent) => onwheel(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  });

  const hex = (rgb: number) => "#" + rgb.toString(16).padStart(6, "0");
  /** Dark text on light lanes, light text on dark ones (silent and quiet sections are near-black). */
  const ink = (rgb: number) => ((((rgb >> 16) & 0xff) * 299 + ((rgb >> 8) & 0xff) * 587 + (rgb & 0xff) * 114) / 1000 > 110 ? "#111" : "#d8d8d8");
  const px = (s: LaneCell | LaneSection) => ((s.end - s.start) / view.span) * width;

  // fb2: a thin lane's name sits over its first cells, so a letter centred under it read as "drAums". A cell that
  // starts under the name gets a left inset clear of it (its letter centres in what is left) and drops the letter
  // when too little is left; the tooltip always has it. With Show stems the letter is at the top and the name at
  // the bottom, so they cannot meet.
  const NAME_LEFT_PX = 0; // .name's left (its text sits 4 px in, inside its backing)
  const NAME_GAP_PX = 3;
  const nameWidth: Partial<Record<StemName, number>> = $state({});
  const inset = (src: StemName, s: LaneCell | LaneSection) =>
    showStems || !nameWidth[src] ? 0 : Math.max(0, NAME_LEFT_PX + nameWidth[src]! + NAME_GAP_PX - (pct(s.start) / 100) * width);
  /** A rest is never named (Plan 6); any other cell shows its label when it has the room. */
  const showLabel = (src: StemName, s: LaneCell | LaneSection) => !isRest(s) && px(s) - inset(src, s) >= MIN_LABEL_PX;

  // fb4, item 2: zoomed so far that the 20 Hz envelope is blocky, the shown stems' samples for the view (and a margin)
  // are fetched through the stem slice route, one stem at a time, DETAIL_DEBOUNCE_MS after the view stops changing,
  // and each lane draws from them while they cover the view (stemDetail.ts). A newer view drops an older fetch.
  const DETAIL_DEBOUNCE_MS = 150;
  let details = $state.raw<Partial<Record<StemName, StemDetail>>>({});
  let detailGen = 0;
  $effect(() => {
    const v = view;
    const w = width;
    if (!showStems || !stemUrls || !needsDetail(v, w)) return;
    // Not tracked: a slice arriving must not start the fetch again (it would drop the other stems' slices).
    const stemsShown = shown;
    if (stemsShown.every((stem) => detailCovers(untrack(() => details)[stem], v, w, duration))) return;
    const gen = ++detailGen;
    const urls = stemUrls;
    const timer = setTimeout(async () => {
      const { start, end } = detailRange(v, duration);
      for (const stem of stemsShown) {
        if (gen !== detailGen) return;
        if (detailCovers(untrack(() => details)[stem], v, w, duration)) continue;
        try {
          const r = await fetchBytes(`${urls[stem]}?start=${start}&end=${end}`);
          if (!r.ok) continue;
          const pcm = parsePcm16(await r.arrayBuffer());
          if (!pcm || gen !== detailGen) continue;
          details = { ...details, [stem]: reduceDetail(pcm, start, detailBin(v, w, pcm.rate)) };
        } catch {
          // the envelope stays: a failed slice is only a coarser drawing
        }
      }
    }, DETAIL_DEBOUNCE_MS);
    // fb4 review M1: whatever re-runs the effect (a new view, Show stems off, the lanes going away) ends this loop, so a
    // stale slice never replaces a good one and no stem is read for a view no longer wanted. This also holds when the
    // re-run takes one of the early returns above, which schedule nothing.
    return () => {
      clearTimeout(timer);
      detailGen++;
    };
  });

  // Plan 6, Task 5: lane cut handles, as Timeline's boundary handles: a press selects, a drag past DRAG_THRESHOLD_PX
  // moves (with the bypass key read on every frame), a double-click removes; a double-click in a cell adds a cut.
  const editable = $derived(rows.length > 0 && !!onmovecut);
  const DRAG_THRESHOLD_PX = 3;
  let dragging: { src: StemName; downX: number; lastX: number; free: boolean; moved: boolean } | null = null;
  const isSelected = (src: StemName, k: number) => selectedCut?.source === src && selectedCut.index === k;

  function timeAt(clientX: number): number {
    const r = root.getBoundingClientRect();
    const t = view.start + (r.width > 0 ? (clientX - r.left) / r.width : 0) * view.span;
    return Math.min(duration, Math.max(0, t));
  }

  function grab(e: PointerEvent, src: StemName, k: number) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = { src, downX: e.clientX, lastX: e.clientX, free: false, moved: false };
    onselectcut?.(src, k);
  }

  function drag(e: PointerEvent) {
    if (!dragging) return;
    dragging.lastX = e.clientX;
    dragging.free = bypassesSnap(e);
    // A click or double-click must not nudge the cut.
    if (!dragging.moved && Math.abs(e.clientX - dragging.downX) <= DRAG_THRESHOLD_PX) return;
    dragging.moved = true;
    moveDragged();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoscroll);
  }

  /** Moves the dragged cut to the pointer. The selected cut's index, not the pressed one's: a cut it hid can come back as it moves. */
  function moveDragged() {
    const sel = selectedCut;
    if (dragging && sel?.source === dragging.src) onmovecut?.(sel.source, sel.index, timeAt(dragging.lastX), dragging.free);
  }

  // As Timeline.autoscroll: a cut dragged near or past an edge of a zoomed view scrolls it, and keeps following the pointer.
  let scrollFrame = 0;
  function autoscroll() {
    scrollFrame = 0;
    if (!dragging?.moved || !onview || zoomLevel(view, duration) <= 1 + 1e-9) return;
    const r = root.getBoundingClientRect();
    const speed = edgeSpeed(dragging.lastX - r.left, r.width, EDGE_PX);
    if (speed === 0) return;
    const before = view.start;
    onview(panBy(view, duration, speed * EDGE_STEP * view.span));
    if (view.start !== before) moveDragged();
    scrollFrame = requestAnimationFrame(autoscroll);
  }

  function drop() {
    dragging = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  $effect(() => () => cancelAnimationFrame(scrollFrame));

  function removeAt(e: MouseEvent, src: StemName, k: number) {
    e.preventDefault();
    e.stopPropagation();
    ondeletecut?.(src, k);
  }

  function insertAt(e: MouseEvent, src: StemName) {
    if (!editable) return;
    e.preventDefault();
    oninsertcut?.(src, timeAt(e.clientX), bypassesSnap(e));
  }

  // The arrows nudge the selected cut a beat (Shift: a bar) of the section handles' grid, then the parent plays the
  // lane's source from it; Delete or Backspace removes it. Only while a lane cut is selected: the Timeline's keys act
  // only while a boundary is, and the dialog's state keeps the two selections apart.
  async function nudge(sel: LaneCutRef, dir: 1 | -1, bar: boolean) {
    const from = lanes[sel.source]?.[sel.index + 1]?.start;
    if (!nudgeGrid || from === undefined) return;
    const to = nudgeTime(from, dir, bar, nudgeGrid);
    if (to === from) return;
    onmovecut?.(sel.source, sel.index, to, true); // on the grid already (or free with snap off): not snapped again
    await tick();
    const now = selectedCut;
    if (now?.source === sel.source) onnudged?.(now.source, now.index + 1);
  }

  // In the capture phase, as the Timeline's: with a lane cut selected an arrow key moves only the cut.
  function onkeydown(e: KeyboardEvent) {
    const sel = selectedCut;
    if (disabled || !editable || sel === null || isTextEntry(e.target)) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      onunlock?.(sel.source); // before nudge's await: still inside the key press
      void nudge(sel, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    ondeletecut?.(sel.source, sel.index);
  }

  let scratch = new Float32Array(0);

  // One canvas per stem lane, the lane's own size: a mirrored peak envelope in a light ink, scaled so the loudest stem
  // fills its lane and the others keep their level relative to it. fb3: zoomed, only the blocks on screen are read.
  $effect(() => {
    if (!showStems || !width) return;
    const v = view;
    const dpr = window.devicePixelRatio || 1;
    for (const stem of shown) {
      const canvas = canvases[stem];
      const peak = stems[stem]?.peak;
      if (!canvas || !peak) continue;
      const h = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(h * dpr);
      const g = canvas.getContext("2d");
      if (!g) continue;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, h);
      void schemeChanges;
      g.fillStyle = liveColor(canvas, "--live-waveform");
      const mid = h / 2;
      const amp = h / 2 - 3;
      const from = (v.start / duration) * peak.length;
      const to = ((v.start + v.span) / duration) * peak.length;
      const d = details[stem];
      const cols = Math.round(width);
      const fine = !!d && needsDetail(v, width) && detailCovers(d, v, width, duration);
      if (scratch.length < cols) scratch = new Float32Array(cols); // one buffer for all the lanes, not one per frame
      const col: ArrayLike<number> = fine ? detailColumns(d, v, cols, scratch) : columnPeaks(peak, cols, from, to);
      const mark = fine ? "samples" : "envelope"; // for the tests; written only when it changes
      if (canvas.dataset.drawn !== mark) canvas.dataset.drawn = mark;
      for (let x = 0; x < cols; x++) {
        const half = Math.max(0.5, (col[x] / scale) * amp);
        g.fillRect(x, mid - half, 1, 2 * half);
      }
    }
  });
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="lanes" class:stems={showStems} bind:clientWidth={width} bind:this={root}>
  {#each shown as src (src)}
    <div class="lane" class:playable data-source={src}>
      {#each lanes[src] ?? [] as s, i (i)}
        <div
          class="cell"
          class:playing={isPlaying(src, i)}
          style:left="{pct(s.start)}%"
          style:width="{((s.end - s.start) / view.span) * 100}%"
          style:background={isRest(s) ? null : hex(s.color)}
          style:color={ink(s.color)}
          style:padding-left="{inset(src, s)}px"
          title={tip(src, s, i)}
          role="button"
          tabindex="-1"
          aria-disabled={!playable}
          onclick={() => playable && onplay(src, i)}
          oncontextmenu={(e) => {
            if (!onmenu) return;
            e.preventDefault();
            const named = rows.length > 0 && !isRest(s) ? { index: i, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() } : null;
            onmenu(src, sectionOf(s, i), e.clientX, e.clientY, named);
          }}
          ondblclick={(e) => insertAt(e, src)}
          onkeydown={() => {}}
        >
          {#if !showStems && showLabel(src, s)}<span class="label">{isPlaying(src, i) ? "▶ " : ""}{s.label}</span>{/if}
        </div>
      {/each}
      {#if showStems}
        <canvas class="wave" bind:this={canvases[src as StemName]}></canvas>
        {#each lanes[src] ?? [] as s, i (i)}
          {#if !isRest(s) && px(s) >= MIN_LABEL_PX}
            <span class="tag" style:left="{pct(s.start)}%" style:color={ink(s.color)}>{s.label}</span>
          {/if}
        {/each}
      {/if}
      {#if editable}
        {#each (lanes[src] ?? []).slice(1) as c, k (k)}
          <div
            class="cut"
            class:selected={isSelected(src, k)}
            class:offscreen={c.start < view.start || c.start > view.start + view.span}
            style:left="{pct(c.start)}%"
            role="separator"
            aria-orientation="vertical"
            aria-label="{src} cut {k + 1}"
            aria-valuenow={c.start}
            tabindex="-1"
            onpointerdown={(e) => grab(e, src, k)}
            onpointermove={drag}
            onpointerup={drop}
            onpointercancel={drop}
            onlostpointercapture={drop}
            ondblclick={(e) => removeAt(e, src, k)}
          ></div>
        {/each}
      {/if}
      {#if playing?.stem === src && playhead !== null}
        <div class="head" style:left="{pct(playhead)}%"></div>
      {/if}
      <span class="name" bind:clientWidth={nameWidth[src]}>{src}</span>
    </div>
  {/each}
</div>

<style>
  .lanes {
    display: grid;
    gap: 1px;
    margin: 0 1px; /* the Timeline above has a 1px border */
    user-select: none;
  }
  .playable .cell {
    cursor: pointer;
  }
  .cell.playing {
    box-shadow: inset 0 0 0 2px var(--live-fg);
  }
  /* Drawn over the cells, but a click or a hover (the tooltip) goes through to the cell underneath. */
  .wave,
  .tag,
  .name,
  .head {
    pointer-events: none;
  }
  .head {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--live-fg);
  }
  .lane {
    position: relative;
    overflow: hidden; /* fb3: zoomed, cells run off both ends */
    height: 16px;
    background: var(--live-area);
  }
  .stems .lane {
    height: 40px;
  }
  .cell {
    position: absolute;
    top: 0;
    bottom: 0;
    box-sizing: border-box;
    border-right: 1px solid var(--live-clip-border);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }
  /* Patchbay's global .label (a 150 px minimum width, 12 px grey text) would push the letter out of its cell, where
     the cell's overflow hides it: the letter takes the cell's own size and ink. */
  .label {
    min-inline-size: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    white-space: nowrap;
  }
  .wave {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  /* With the waveform drawn, the letter moves to the cell's top-left corner, over the waveform. */
  .tag {
    position: absolute;
    top: 2px;
    margin-left: 4px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }
  /* Task 4 review: the name sits over the lane's first cells, whatever their colour, so it has a backing. */
  .name {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    padding: 0 4px;
    border-radius: 0 2px 2px 0;
    background: color-mix(in srgb, var(--live-surface) 80%, transparent);
    color: var(--live-fg);
    font-size: 10px;
    z-index: 1;
  }
  .stems .lane .name {
    top: auto;
    bottom: 2px;
    height: 13px;
    color: var(--live-fg);
  }
  /* Plan 6, Task 5: a lane cut's handle, the lane's height, as the section handles in the Timeline: drawn only on
     hover, and in the selection colour while selected (the cells' own edges show the cuts otherwise). */
  .cut {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 7px;
    margin-left: -3px;
    cursor: ew-resize;
    touch-action: none;
  }
  .cut.offscreen {
    visibility: hidden;
  }
  .cut::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 1px;
    pointer-events: none;
  }
  .cut:hover::before {
    background: var(--live-fg);
  }
  /* Task 5 review: a selected (or hovered) cut is drawn over the row name's backing, so the name never hides it. */
  .cut:hover,
  .cut.selected {
    z-index: 2;
  }
  .cut.selected::before {
    left: 2.5px;
    width: 2px;
    background: var(--modulation-color);
  }
</style>
