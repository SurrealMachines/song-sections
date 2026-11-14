<script lang="ts">
  // v2: the right-click menu of a band (the mix) or a stem lane cell. A choice closes the dialog with a send result,
  // as Apply does. Keys as in the rename popover: Esc closes, Up/Down move through the items, Enter picks one; a
  // click anywhere else closes it, and does nothing else (review M4: like a native menu, the dismissing press and its
  // click do not reach what is under the pointer). Focus goes back where it was (review M5). It borrows the Patchbay
  // Menu's list look, as the rename popover does. Matt, 2026-11-11: the title renames a band or a pattern lane's named cell (Plan 6's Rename pattern… did), and
  // (Task 7) a pattern lane's cell sends the lane's slices; a rest's one-slice items are disabled. Task 8: with kept
  // stems, every menu ends with Send all stems to new tracks, which `blocked` leaves enabled (it is about no one lane).
  import { onDestroy, onMount, tick } from "svelte";
  import type { SendTarget } from "./protocol.js";
  import { sendItems, type SendMenuAt } from "./send.js";

  interface Props {
    at: SendMenuAt;
    /** Shown at the top: a band's section label, or the label drawn on the lane cell ("rest" for a pattern rest). */
    label: string;
    /** Why nothing can be sent from here (no stems kept, or an all-rest lane), or null. */
    blocked?: string | null;
    /** Plan 6, Task 8: stems were kept, so Send all stems to new tracks is offered. */
    stems?: boolean;
    onchoose: (target: SendTarget) => void;
    onclose: () => void;
    /**
     * v2: the "Key in names" toggle, on or off; null hides it (the drums, which never carry a key, or no keys at all).
     * A click toggles it and leaves the menu open.
     */
    keyInNames?: boolean | null;
    onkeyinnames?: (on: boolean) => void;
    /**
     * Set for what can be renamed (a band, or a pattern lane's cell that is not a rest): the title is then a button that
     * calls it (Matt, 2026-11-11; it replaced Plan 6's Rename pattern…). It needs no stems, so `blocked` leaves it enabled.
     */
    onrename?: (() => void) | null;
    /**
     * Matt, 2026-11-12: color swatches for a band's name or a pattern lane cell's pattern (Structure, not under Clip
     * color), or null for none. A pick colors every section of that name (every cell of that pattern in its lane) and
     * closes the menu, as Auto does after giving the automatic color back. `note` says what a pick colors.
     */
    swatches?: { shades: number[]; others: number[]; current: number; picked: boolean; note: string } | null;
    oncolor?: (color: number | null) => void;
  }

  let { at, label, blocked = null, stems = false, onchoose, onclose, keyInNames = null, onkeyinnames, onrename = null, swatches = null, oncolor }: Props = $props();

  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  /** The letter or pattern number the shades are of, as the label starts with it. */
  const letter = $derived(/^([A-Z]+|\d+)/.exec(label)?.[0] ?? "");

  const EDGE = 8;
  const items = $derived(sendItems(at.source, at.unit, { rest: at.rest, stems }));
  let root = $state<HTMLDivElement>();
  let w = $state(0);
  let h = $state(0);
  // At the pointer, moved back inside the dialog when it would run off the right or the bottom.
  const left = $derived(Math.max(EDGE, Math.min(at.x, window.innerWidth - EDGE - w)));
  const top = $derived(Math.max(EDGE, Math.min(at.y, window.innerHeight - EDGE - h)));

  // Up/Down run through the send items only: the swatches are for the pointer.
  const buttons = () => [...(root?.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not(.title):not(.swatch):not(.auto)") ?? [])];

  /** What had the focus before the menu took it. */
  const restoreTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

  onMount(() => {
    // Capture on the window: before any handler of the element under the pointer (the timeline's handles act on
    // pointerdown, the bands on click).
    window.addEventListener("pointerdown", onwindowpointerdown, true);
    void tick().then(() => (buttons()[0] ?? root)?.focus({ preventScroll: true }));
  });

  onDestroy(() => {
    window.removeEventListener("pointerdown", onwindowpointerdown, true);
    // Once the menu has gone, focus that fell to the page goes back where it was.
    queueMicrotask(() => {
      const now = document.activeElement;
      if (restoreTo?.isConnected && (now === null || now === document.body)) restoreTo.focus({ preventScroll: true });
    });
  });

  function onkeydown(e: KeyboardEvent) {
    // The timeline's keys listen on the window in the capture phase; the views disable it while the menu is open.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const b = buttons();
      if (b.length === 0) return;
      const k = b.indexOf(document.activeElement as HTMLButtonElement);
      const next = k < 0 ? 0 : (k + (e.key === "ArrowDown" ? 1 : b.length - 1)) % b.length;
      b[next].focus({ preventScroll: true });
    }
  }

  function onfocusout(e: FocusEvent) {
    if (e.relatedTarget instanceof Node && root?.contains(e.relatedTarget)) return;
    onclose();
  }

  /** A double-click this soon after the dismissing press is one the press began (the second press gets through). */
  const DOUBLE_CLICK_MS = 500;

  /**
   * Swallows the click of a dismissing primary press, and any double-click it begins (re-review N2: a fast double-click
   * to dismiss would otherwise open a band's rename). A press that ends without a click (cancelled, or released off
   * the element) drops the click swallow, so a later real click is never eaten.
   */
  function swallowClickOf() {
    const stopClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      dropClick();
    };
    const stopDouble = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    // The click is dispatched in the same task as the release, so a release lets it through first.
    const released = () => void setTimeout(dropClick, 0);
    function dropClick() {
      window.removeEventListener("click", stopClick, true);
      window.removeEventListener("pointerup", released, true);
      window.removeEventListener("pointercancel", dropClick, true);
      clearTimeout(clickTimer);
    }
    const clickTimer = setTimeout(dropClick, 1000);
    window.addEventListener("click", stopClick, true);
    window.addEventListener("pointerup", released, true);
    window.addEventListener("pointercancel", dropClick, true);
    window.addEventListener("dblclick", stopDouble, true);
    setTimeout(() => window.removeEventListener("dblclick", stopDouble, true), DOUBLE_CLICK_MS);
  }

  /** Dismissed: the menu may stay mounted until the next update, and must not take a second press. */
  let dismissed = false;

  function onwindowpointerdown(e: Event) {
    if (dismissed || (e.target instanceof Node && root?.contains(e.target))) return;
    dismissed = true;
    e.preventDefault();
    e.stopPropagation();
    // A right-click elsewhere still opens the menu there: its contextmenu event is not this press.
    // Only a primary press gives a click (a middle press gives auxclick); a right-click elsewhere still opens the
    // menu there, as its contextmenu event is not this press.
    if ((e as PointerEvent).button === 0) swallowClickOf();
    onclose();
  }
</script>

<div
  bind:this={root}
  bind:clientWidth={w}
  bind:clientHeight={h}
  class="send-menu"
  role="menu"
  aria-label="Send {label} ({at.source})"
  tabindex="-1"
  style:left="{left}px"
  style:top="{top}px"
  {onkeydown}
  {onfocusout}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#if onrename}
    <button type="button" class="title renamable" tabindex="-1" title="Rename {label}" onclick={onrename}>{label} <span class="source">({at.source})</span></button>
  {:else}
    <div class="title" title="{label} ({at.source})">{label} <span class="source">({at.source})</span></div>
  {/if}
  {#if swatches && oncolor}
    {#each [["shades", swatches.shades, `Shades of ${letter}`], ["others", swatches.others, "Other colors"]] as const as [kind, colors, heading] (kind)}
      {#if colors.length > 0}
        <div class="swatch-heading">{heading}</div>
        <div class="swatch-row {kind}">
          {#each colors as c (c)}
            <button
              type="button"
              class="swatch"
              tabindex="-1"
              aria-label="{swatches.note}: {hex(c)}"
              aria-pressed={c === swatches.current}
              title={hex(c)}
              style:background={hex(c)}
              onclick={() => (oncolor(c), onclose())}
            ></button>
          {/each}
        </div>
      {/if}
    {/each}
    <div class="swatch-foot">
      <span class="note-inline" title={swatches.note}>{swatches.note}</span>
      <button type="button" class="auto" tabindex="-1" disabled={!swatches.picked} title="Back to the automatic color" onclick={() => (oncolor(null), onclose())}>Auto</button>
    </div>
    <div class="sep" role="separator"></div>
  {/if}
  {#each [items.section, items.all] as group, g (g)}
    {#if g > 0}<div class="sep" role="separator"></div>{/if}
    {#each group as item (item.target)}
      <button type="button" role="menuitem" class="menu__option" disabled={(blocked !== null && item.target !== "allStems") || item.disabled} onclick={() => onchoose(item.target)}>
        {item.label}
      </button>
    {/each}
  {/each}
  {#if keyInNames !== null && onkeyinnames}
    <div class="sep" role="separator"></div>
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={keyInNames}
      class="menu__option key-toggle"
      title="Add the key to the names of what is sent, for example “A - chorus (bass) · Dm”"
      disabled={blocked !== null && !stems}
      onclick={() => onkeyinnames(!keyInNames)}
    >
      <span class="check" aria-hidden="true">{keyInNames ? "✓" : ""}</span>Key in names
    </button>
  {/if}
  {#if blocked}
    <div class="note">{blocked}</div>
  {/if}
</div>

<style>
  .send-menu {
    position: fixed;
    z-index: 40;
    box-sizing: border-box;
    display: grid;
    min-width: 220px;
    max-width: 340px;
    padding: 4px;
    background: var(--live-surface);
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
    font-family: var(--control-font);
    font-size: 12px;
    outline: none;
  }
  .title {
    padding: 3px 6px 4px;
    color: var(--live-fg);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .renamable {
    text-align: left;
    background: none;
    border: none;
    border-radius: 2px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    outline: none;
  }
  .renamable:hover,
  .renamable:focus-visible {
    background: var(--live-control);
  }
  .source,
  .note {
    color: var(--muted-text-color);
    font-weight: normal;
  }
  .note {
    padding: 4px 6px 2px;
    font-size: 11px;
  }
  .sep {
    height: 1px;
    margin: 3px 2px;
    background: var(--live-frame);
  }
  .send-menu :global(.menu__option) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .check {
    display: inline-block;
    width: 1.2em;
  }
  .swatch-heading {
    padding: 4px 6px 2px;
    font-size: 11px;
    color: var(--muted-text-color);
  }
  .swatch-row {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    padding: 0 6px 2px;
  }
  .swatch {
    width: 20px;
    height: 14px;
    padding: 0;
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    cursor: pointer;
  }
  .swatch:hover {
    outline: 1px solid var(--live-fg);
  }
  .swatch[aria-pressed="true"] {
    outline: 2px solid var(--modulation-color);
    outline-offset: 0;
  }
  .swatch-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px 1px;
  }
  .note-inline {
    flex: 1;
    font-size: 11px;
    color: var(--muted-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .auto {
    padding: 0 6px;
    font: inherit;
    font-size: 11px;
    color: var(--live-fg);
    background: var(--live-control);
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    cursor: pointer;
  }
  .auto:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
