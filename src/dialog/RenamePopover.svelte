<script lang="ts">
  // Feedback round 2, item 3: renaming a band. A small section's band is too narrow for an inline field, so the rename
  // is a popover anchored to the band: a text field at least 220 px wide, kept inside the dialog, prefilled and
  // selected, over a list of the labels in use to pick from. Typing filters the list; Up/Down move through it.
  // A row is committed only when the user chose it: a click on it, or Enter after Up/Down moved there. The mouse
  // hovering a row only highlights it (fb2 review I1: the list sits between the band and the waveform, so the pointer
  // crosses it on the way anywhere). Enter with no row chosen, a click anywhere else, and Apply commit the typed text.
  // Esc cancels.
  // Patchbay has no text field or combobox (its Menu is a closed select), so this borrows the Menu's list look: its
  // .menu__option rows, the highlight in --modulation-color and the selected dot.
  // Matt, 2026-11-11: with `keyOf` (a Structure band's letters, a pattern lane's numbers) the list is sorted by them, and
  // the last row of each letter or number has a + that opens an empty field under it. What is typed there is committed
  // with `insert` set: a letter or number alone that is in use then moves it and the later ones up (the state does that).
  import { onMount, tick } from "svelte";
  import { LABEL_SEP } from "../grouping/labels.js";
  import type { KeyOf } from "../grouping/renumber.js";

  interface Props {
    /** The band's box on screen (getBoundingClientRect). */
    anchor: DOMRect;
    value: string;
    /** The distinct labels in use, in order of first appearance. */
    names: string[];
    /** The text to commit, or null when cancelled; `insert` when it was typed in a + field. Called once. */
    ondone: (text: string | null, insert?: boolean) => void;
    /** What a name's letter or number is: the list is sorted by it, with a + on each one's last row. Null: neither. */
    keyOf?: KeyOf | null;
    /** Plan 6: what is renamed, for its labels: a section (a band) or a pattern (a lane cell). */
    subject?: "section" | "pattern";
  }

  let { anchor, value, names, ondone, subject = "section", keyOf = null }: Props = $props();

  /** The popover's width; the field inside it is 228 px, over the required 220. */
  const WIDTH = 240;
  /** Kept this far from the dialog's edges, the dialog's own side padding. */
  const EDGE = 16;
  const GAP = 4;
  const LIST_MAX = 172; // the Patchbay Menu list's max height

  // svelte-ignore state_referenced_locally
  let draft = $state(value);
  let typed = $state(false); // filtering starts with the first keystroke: until then every label is listed
  let active = $state(-1); // the row Up/Down moved to; -1 is the text field itself. Hover does not set it.
  let input = $state<HTMLInputElement>();
  let root = $state<HTMLDivElement>();
  let closed = false;

  const id = `rename-${Math.random().toString(36).slice(2)}`;
  const primed = (n: string) => /['’′]/.test(n.split(LABEL_SEP)[0]);
  /** By letter or number, its plain names before its variants; names with neither keep their order, after the rest. */
  const sorted = $derived.by(() => {
    if (!keyOf) return names;
    const of = keyOf;
    return [...names].sort((a, b) => {
      const ka = of(a);
      const kb = of(b);
      if (!ka || !kb) return (ka ? 0 : 1) - (kb ? 0 : 1);
      return ka.key - kb.key || Number(primed(a)) - Number(primed(b)) || a.localeCompare(b);
    });
  });
  const shown = $derived.by(() => {
    const q = draft.trim().toLowerCase();
    return typed && q ? sorted.filter((n) => n.toLowerCase().includes(q)) : sorted;
  });
  /** The row k of `shown` is the last of its letter or number: it carries the +. */
  const lastOfKey = (k: number) => {
    const key = keyOf?.(shown[k])?.key;
    return key !== undefined && keyOf?.(shown[k + 1] ?? "")?.key !== key;
  };
  /** The row whose + was clicked (its index in `shown`), with the field under it; null when none is open. */
  let adding = $state<number | null>(null);
  let addDraft = $state("");
  let addInput = $state<HTMLInputElement>();
  async function openAdd(k: number) {
    adding = k;
    addDraft = "";
    await tick();
    addInput?.focus({ preventScroll: true });
  }
  function onaddkeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const t = addDraft.trim();
      if (t !== "") finish(t, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      adding = null;
      input?.focus({ preventScroll: true });
    }
  }

  // Above the band when there is more room there (the waveform), below it otherwise; centred on it, clamped inside.
  const place = $derived.by(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - WIDTH / 2, vw - EDGE - WIDTH));
    const above = anchor.top - GAP - EDGE;
    const below = vh - anchor.bottom - GAP - EDGE;
    return above >= below
      ? { left, top: null, bottom: vh - anchor.top + GAP, room: above }
      : { left, top: anchor.bottom + GAP, bottom: null, room: below };
  });
  /** The list gets what the field (about 40 px with the padding) leaves of the room. */
  const listMax = $derived(Math.max(0, Math.min(LIST_MAX, place.room - 40)));

  onMount(async () => {
    await tick();
    input?.focus({ preventScroll: true });
    input?.select();
  });

  function finish(text: string | null, insert = false) {
    if (closed) return;
    closed = true;
    ondone(text, insert);
  }

  /** Commits the text as typed (focus leaving the popover, or Apply). */
  export function commit() {
    finish(draft);
  }

  /** Enter: the row Up/Down moved to, or else the text as typed. */
  function commitChoice() {
    finish(active >= 0 && shown[active] !== undefined ? shown[active] : draft);
  }

  async function move(by: number) {
    if (shown.length === 0) return;
    active = Math.max(-1, Math.min(shown.length - 1, active + by));
    await tick();
    root?.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  }

  function onkeydown(e: KeyboardEvent) {
    e.stopPropagation(); // keep Delete/Backspace from removing a boundary
    if (e.key === "Enter") {
      e.preventDefault();
      commitChoice();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(null);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      void move(e.key === "ArrowDown" ? 1 : -1);
    }
  }

  function oninput() {
    typed = true;
    active = -1;
  }

  // A click anywhere else commits. The rows keep the focus in the field (their pointerdown is cancelled), so focus
  // only leaves the popover for something outside it.
  function onfocusout(e: FocusEvent) {
    if (e.relatedTarget instanceof Node && root?.contains(e.relatedTarget)) return;
    commit();
  }
</script>

<div
  bind:this={root}
  class="rename"
  role="dialog"
  aria-label="Rename {subject}"
  tabindex="-1"
  style:left="{place.left}px"
  style:top={place.top === null ? null : `${place.top}px`}
  style:bottom={place.bottom === null ? null : `${place.bottom}px`}
  style:width="{WIDTH}px"
  {onfocusout}
>
  <input
    bind:this={input}
    bind:value={draft}
    {oninput}
    {onkeydown}
    role="combobox"
    aria-label={subject === "pattern" ? "Pattern name" : "Section name"}
    aria-expanded={shown.length > 0}
    aria-controls="{id}-list"
    aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
    spellcheck="false"
    autocomplete="off"
  />
  {#if shown.length > 0}
    <div class="list" id="{id}-list" role="listbox" style:max-height="{listMax}px">
      {#each shown as name, k (name)}
        <div class="row">
          <button
            type="button"
            id="{id}-{k}"
            role="option"
            tabindex="-1"
            aria-selected={k === active}
            class={["menu__option", k === active && "is-active", name === value && "is-selected"].filter(Boolean).join(" ")}
            title={name}
            onpointerdown={(e) => e.preventDefault()}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => finish(name)}
          >
            {name}
          </button>
          {#if lastOfKey(k)}
            <button
              type="button"
              class="add"
              tabindex="-1"
              aria-label="Add after {name}"
              title={subject === "pattern" ? "Add a pattern: a number in use moves it and the later ones up" : "Add a section name: a letter in use moves it and the later ones up"}
              onpointerdown={(e) => e.preventDefault()}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => openAdd(k)}>+</button
            >
          {/if}
        </div>
        {#if adding === k}
          <input
            bind:this={addInput}
            bind:value={addDraft}
            class="add-field"
            onkeydown={onaddkeydown}
            aria-label={subject === "pattern" ? "New pattern name" : "New section name"}
            placeholder={subject === "pattern" ? "3, or 3 - fill" : "C, or C′ - solo"}
            spellcheck="false"
            autocomplete="off"
          />
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .rename {
    position: fixed;
    z-index: 40;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 5px;
    background: var(--live-surface);
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
    font-family: var(--control-font);
    font-size: 12px;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    min-block-size: 23px;
    padding: 0 6px;
    color: var(--live-fg);
    background: var(--live-control);
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    font: inherit;
    outline: none;
  }
  input:focus {
    border-color: var(--focus-border);
  }
  .list {
    display: grid;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .row :global(.menu__option) {
    flex: 1;
    min-width: 0;
  }
  .add {
    flex: none;
    width: 20px;
    height: 20px;
    padding: 0;
    color: var(--muted-text-color);
    background: none;
    border: none;
    border-radius: 2px;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .add:hover {
    color: var(--live-fg);
    background: var(--live-control);
  }
  .add-field {
    margin: 2px 0 2px 8px;
    width: calc(100% - 8px);
  }
  .list :global(.menu__option) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
