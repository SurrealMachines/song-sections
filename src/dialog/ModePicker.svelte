<script lang="ts">
  import { Tabs, TextButton } from "@patchbayhq/svelte";
  import { pollStructure } from "./bridge.js";
  import { chooseMode, pickerNote, structureTabLabel } from "./modeChoice.js";
  import type { DialogMode, ModeInfo, StructureProgress } from "./protocol.js";

  interface Props {
    mode: DialogMode;
    modes: ModeInfo;
    /** The clip's length, for the long-track confirm (only the Cue view can ask for it). */
    durationSec?: number;
    /** `download`: the user agreed to download the models (fb/hfmodels), in the prompt below. */
    onswitch: (m: DialogMode, download?: boolean) => void;
  }

  let { mode, modes, durationSec = 0, onswitch }: Props = $props();

  // fb2: in the Cue view, a Structure analysis running in the host shows its progress on the Structure tab.
  let progress = $state<StructureProgress | null>(null);
  $effect(() => {
    if (mode !== "cue" || !modes.structure.background) return;
    return pollStructure((p) => (progress = p));
  });
  const items = $derived([
    { value: "structure", label: structureTabLabel(progress), disabled: false },
    { value: "cue", label: "Cue points", disabled: false },
  ]);
  // fb2: the last mode applied was Structure; the Cue view opens first and points at it.
  const suggest = $derived(mode === "cue" && modes.structure.suggested === true);

  let blocked = $state<string | null>(null);
  // A failed model download is shown in the Cue view straight away, with Retry (the flow retries on a switch).
  const retry = $derived(mode === "cue" && !modes.structure.available && modes.structure.retryable ? (modes.structure.reason ?? "") : null);
  let confirm = $state<{ target: DialogMode; message: string; download?: boolean } | null>(null);
  // fb/hfmodels: the models are not installed; nothing downloads until Download is clicked here.
  let consent = $state<string | null>(null);
  // Tabs keeps its own selection after a click; re-mounting it snaps the highlight back to the current mode.
  let resets = $state(0);
  const note = $derived(mode === "cue" && consent === null ? pickerNote(modes) : null);

  function pick(v: string) {
    const target = v as DialogMode;
    const choice = chooseMode(target, mode, modes, durationSec);
    if (choice.kind !== "none") consent = null;
    if (choice.kind === "switch") {
      blocked = null;
      confirm = null;
      onswitch(target);
    } else if (choice.kind === "blocked") {
      confirm = null;
      blocked = choice.message;
      resets++;
    } else if (choice.kind === "retry") {
      blocked = null;
      confirm = null;
      resets++;
    } else if (choice.kind === "confirm") {
      blocked = null;
      confirm = { target, message: choice.message };
      resets++;
    } else if (choice.kind === "download") {
      blocked = null;
      confirm = null;
      consent = choice.message;
      resets++;
    }
  }

  function analyse() {
    const target = confirm?.target;
    const download = confirm?.download === true;
    confirm = null;
    if (target) onswitch(target, download);
  }

  /** Download: a long clip still asks about its analysis time next, and its Analyse carries the consent. */
  function download() {
    consent = null;
    const next = chooseMode("structure", mode, { structure: { ...modes.structure, needsDownload: false } }, durationSec);
    if (next.kind === "confirm") confirm = { target: "structure", message: next.message, download: true };
    else onswitch("structure", true);
  }
</script>

<div class="picker" class:suggest>
  <div class="row">
    {#key resets}
      <Tabs {items} value={mode} onValueChange={pick} />
    {/key}
    {#if consent !== null}
      <span class="consent" role="alertdialog" aria-label="Download models">
        <span class="message">{consent}</span>
        <TextButton labels={{ off: "Download", on: "Download" }} appearance="primary" onValueChange={download} />
        <TextButton labels={{ off: "Not now", on: "Not now" }} appearance="subtle" onValueChange={() => (consent = null)} />
      </span>
    {:else if confirm}
      <span class="confirm" role="alertdialog" aria-label="Long clip">
        <span class="message">{confirm.message}</span>
        <TextButton labels={{ off: "Analyze", on: "Analyze" }} appearance="primary" onValueChange={analyse} />
        <TextButton labels={{ off: "Back", on: "Back" }} appearance="subtle" onValueChange={() => (confirm = null)} />
      </span>
    {:else if retry !== null}
      <span class="retry" role="status">
        <span class="message">{retry}</span>
        <TextButton labels={{ off: "Retry", on: "Retry" }} appearance="primary" onValueChange={() => onswitch("structure")} />
      </span>
    {:else if blocked}
      <span class="blocked" role="status">{blocked}</span>
    {/if}
  </div>
  {#if note}
    <span class="note">{note}</span>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* May shrink (after the clip name) so .row wraps rather than pushing buttons off the dialog (Task 12 I1). */
    flex: 0 1 auto;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-width: 0;
  }
  /* The suggested Structure tab (fb2): the active tab's yellow, as an underline and text. */
  .suggest :global(.tab:first-child:not(.is-active)) {
    color: var(--live-fg);
    box-shadow: inset 0 -2px 0 var(--live-on);
  }
  .confirm,
  .consent,
  .retry {
    display: flex;
    flex-wrap: wrap;
    min-width: 0;
    align-items: center;
    gap: 8px;
  }
  .message,
  .blocked,
  .note {
    color: var(--muted-text-color);
    font-size: 11px;
  }
</style>
