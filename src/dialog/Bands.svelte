<script lang="ts">
  import type { Section } from "../core/types.js";
  import { splitLabel as split } from "../grouping/labels.js";
  import type { KeyOf } from "../grouping/renumber.js";
  import RenamePopover from "./RenamePopover.svelte";
  import { fitView, type ZoomView } from "./zoom.js";

  interface Props {
    sections: Section[];
    duration: number;
    playing: number | null;
    onplay: (i: number) => void;
    /** `insert`: typed in the rename list's + field (Matt, 2026-11-11). */
    onrename: (i: number, label: string, insert?: boolean) => void;
    /** A section's letter, for the rename list's sorting and its +; none in Cue mode, whose names have no letters. */
    keyOf?: KeyOf | null;
    /** fb3: the zoomed window of clip seconds on screen (the whole clip by default). */
    view?: ZoomView;
    /** fb3, item 3: a section's length as shown ("8 bars", "6.2", "12 s"); none when absent. */
    lengthOf?: (s: Section) => string;
    /** v2: a right-click on band i, at client (x, y): the send menu for the mix. None: the browser's own menu. */
    onmenu?: (i: number, x: number, y: number) => void;
    /** v2: each section's key as the dialog shows it ("D minor", "F♯ major?"), or null for none; none when absent. */
    keys?: (string | null)[];
  }

  // svelte-ignore state_referenced_locally
  let { sections, duration, playing, onplay, onrename, keyOf = null, view = fitView(duration), lengthOf, onmenu, keys }: Props = $props();
  const bandEls: HTMLElement[] = [];
  const pct = (t: number) => ((t - view.start) / view.span) * 100;

  /** The band being renamed and where it is on screen, or null. */
  let editing = $state<{ index: number; anchor: DOMRect } | null>(null);
  let popover = $state<RenamePopover>();

  const hex = (rgb: number) => "#" + rgb.toString(16).padStart(6, "0");

  // Task 13 Live fix 3: the letter never gives way; the word after it truncates first. Bands too narrow for the
  // padding drop it and centre the letter. The full label is always in the tooltip. Only a real letter is split off
  // (review M2): a rename like "Breakdown - long" is all word, and truncates.
  const NARROW_PX = 28;
  let width = $state(0);
  const bandPx = (s: Section) => ((s.end - s.start) / view.span) * width;
  const narrow = (s: Section) => width > 0 && bandPx(s) < NARROW_PX;
  // fb3, item 3: the length sits at the band's right end when the band has room for it and a few letters; otherwise
  // it is in the tooltip, after the label. It is drawn over the band (not in it), so the band's text stays the label.
  const LEN_CHAR_PX = 6.5;
  const lenPx = (text: string) => Math.ceil(text.length * LEN_CHAR_PX) + 8;
  const LEN_ROOM_PX = 34; // the letter and a little of the word must still show
  const lengths = $derived(sections.map((s) => lengthOf?.(s) ?? ""));
  const keyTexts = $derived(sections.map((_, i) => keys?.[i] ?? ""));
  /** The part of a band on screen, in px (fb3: zoomed, a band can run off either end). */
  const visiblePx = (s: Section) => ((Math.min(s.end, view.start + view.span) - Math.max(s.start, view.start)) / view.span) * width;
  const fits = (i: number, text: string) => text !== "" && width > 0 && visiblePx(sections[i]) >= lenPx(text) + LEN_ROOM_PX;
  // v2: the key joins the length at the band's right end ("8 bars · D minor") when both fit; otherwise the length alone
  // (as before), or the key alone when there is no length; what does not fit is in the tooltip.
  const metas = $derived(
    sections.map((_, i) => {
      const len = lengths[i];
      const key = keyTexts[i];
      const both = [len, key].filter((t) => t !== "").join(" · ");
      const text = fits(i, both) ? both : len !== "" && fits(i, len) ? len : "";
      return { text, len: text !== "" && len !== "", key: key !== "" && text !== "" && text === both };
    }),
  );
  const lengthShown = (i: number) => metas[i].text !== "";
  /** A band that starts left of the view keeps its label on screen: inset by the part that is off it. */
  const offLeftPx = (s: Section) => (s.start < view.start && s.end > view.start ? ((view.start - s.start) / view.span) * width : 0);
  const tip = (i: number) =>
    [sections[i].label, lengths[i] !== "" && !metas[i].len ? lengths[i] : "", keyTexts[i] !== "" && !metas[i].key ? `Key: ${keyTexts[i]}` : ""]
      .filter((t) => t !== "")
      .join("\n");

  /** The distinct labels in use, computed and renamed, in order of first appearance: the popover's picks. */
  const names = $derived([...new Set(sections.map((s) => s.label))]);

  // Feedback round 2, item 3: a band opens a rename popover anchored to it, not a field as wide as the band.
  function edit(i: number, band: HTMLElement) {
    editing = { index: i, anchor: band.getBoundingClientRect() };
  }

  function done(text: string | null, insert = false) {
    if (editing === null) return;
    const i = editing.index;
    editing = null;
    if (text !== null && (insert || text !== sections[i]?.label)) onrename(i, text, insert);
  }

  /** Opens the rename popover on band i, as a double-click does: the menu's title (Matt, 2026-11-11). */
  export function rename(i: number) {
    const el = bandEls[i];
    if (el) edit(i, el);
  }

  /** Commits an open rename (Enter, a pick, a click elsewhere, or Apply: feedback round 2). */
  export function commit() {
    popover?.commit();
  }
</script>

<div class="bands" bind:clientWidth={width}>
  {#each sections as s, i (i)}
    {@const part = split(s.label)}
    <div
      bind:this={bandEls[i]}
      class="band"
      class:playing={playing === i}
      class:editing={editing?.index === i}
      class:narrow={narrow(s)}
      style:left="{pct(s.start)}%"
      style:width="{((s.end - s.start) / view.span) * 100}%"
      style:background={hex(s.color)}
      style:padding-right={lengthShown(i) ? `${lenPx(metas[i].text) + Math.max(0, ((s.end - view.start - view.span) / view.span) * width)}px` : null}
      style:padding-left={offLeftPx(s) > 0 ? `${offLeftPx(s) + 6}px` : null}
      title={tip(i)}
      role="button"
      tabindex="-1"
      onclick={() => editing?.index !== i && onplay(i)}
      ondblclick={(e) => editing?.index !== i && edit(i, e.currentTarget)}
      oncontextmenu={(e) => {
        if (!onmenu) return;
        e.preventDefault();
        onmenu(i, e.clientX, e.clientY);
      }}
      onkeydown={() => {}}
    >
      <!-- one line: whitespace between the spans would show up in the label's text -->
      {#if playing === i && !narrow(s)}<span class="play">▶&nbsp;</span>{/if}{#if part.letter !== null}<span class="letter">{part.letter}</span>{/if}<span class="word">{part.word}</span>
    </div>
  {/each}
  {#each sections as s, i (i)}
    {#if lengthShown(i)}
      <span class="len" style:right="{Math.max(0, 100 - pct(s.end))}%">{metas[i].text}</span>
    {/if}
  {/each}
</div>

{#if editing !== null}
  <RenamePopover bind:this={popover} anchor={editing.anchor} value={sections[editing.index]?.label ?? ""} {names} {keyOf} ondone={done} />
{/if}

<style>
  .bands {
    position: relative;
    overflow: hidden; /* fb3: zoomed, bands run off both ends */
    height: var(--bands-height, 34px); /* Timeline's handles stop above this strip */
    background: var(--live-clip-border);
  }
  .band {
    position: absolute;
    top: 2px;
    bottom: 2px;
    box-sizing: border-box;
    border-right: 1px solid var(--live-clip-border);
    display: flex;
    align-items: center;
    padding: 0 6px;
    overflow: hidden;
    cursor: pointer;
    color: #111;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    user-select: none;
  }
  .band.playing {
    box-shadow: inset 0 0 0 2px var(--live-fg);
  }
  .band.editing {
    box-shadow: inset 0 0 0 2px var(--modulation-color);
  }
  .band.narrow {
    padding: 0;
    justify-content: center;
  }
  .play,
  .letter {
    flex: none;
  }
  /* The band itself is every click's target. The ▶ comes and goes with playback: a double-click whose second press
     landed on it (it goes when that click stops playback) went to a removed node, so the rename never opened. */
  .band > * {
    pointer-events: none;
  }
  .word {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  .narrow .word {
    display: none;
  }
  .len {
    position: absolute;
    top: 2px;
    bottom: 2px;
    display: flex;
    align-items: center;
    padding-right: 6px;
    color: rgba(17, 17, 17, 0.8);
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
    pointer-events: none; /* clicks and the tooltip are the band's */
    font-variant-numeric: tabular-nums;
  }
</style>
