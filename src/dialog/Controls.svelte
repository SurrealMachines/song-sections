<script lang="ts">
  import { Slider, Tabs, TextButton, Toggle } from "@patchbayhq/svelte";
  import { resetOnDoubleClick } from "./resetOnDoubleClick.js";
  import type { ArrangementOutput, ColorMode, View } from "../core/types.js";

  interface Props {
    granularity: number;
    /** What a double-click on the slider sets it to: the granularity the dialog opened with. */
    defaultGranularity: number;
    colorMode: ColorMode;
    output: ArrangementOutput;
    view: View;
    count: number;
    snap: boolean;
    canSnap: boolean;
    /** Boundaries the last snapping pass dropped. */
    snapMerged: number;
    onsnap: (on: boolean) => void;
    ongranularity: (g: number) => void;
    oncolormode: (m: ColorMode) => void;
    onoutput: (o: ArrangementOutput) => void;
    /** fb2 review I3: the result is on its way; everything but Cancel is disabled. */
    busy?: boolean;
    oncancel: () => void;
    onapply: () => void;
  }

  let { granularity, defaultGranularity, colorMode, output, view, count, snap, canSnap, snapMerged, onsnap, ongranularity, oncolormode, onoutput, busy = false, oncancel, onapply }: Props =
    $props();

  const colorItems = [
    { value: "gradient", label: "Gradient", disabled: false },
    { value: "uniform", label: "Clip color", disabled: false },
  ];
  const outputItems = [
    { value: "split", label: "Split clip", disabled: false },
    { value: "locators", label: "Locators", disabled: false },
    { value: "both", label: "Both", disabled: false },
  ];
</script>

<div class="controls" class:busy>
  <div class="granularity" inert={busy} use:resetOnDoubleClick={() => granularity !== defaultGranularity && ongranularity(defaultGranularity)}>
    <Slider
      label="Granularity"
      orientation="horizontal"
      min={0}
      max={1}
      step={0.01}
      value={granularity}
      onValueChange={ongranularity}
    />
  </div>

  <div class="group" inert={busy}>
    <span class="caption">Colors</span>
    <Tabs items={colorItems} value={colorMode} onValueChange={(v) => oncolormode(v as ColorMode)} />
  </div>

  {#if view === "arrangement"}
    <div class="group" inert={busy}>
      <span class="caption">Output</span>
      <Tabs items={outputItems} value={output} onValueChange={(v) => onoutput(v as ArrangementOutput)} />
    </div>
  {/if}

  {#if canSnap}
    <div class="snap" inert={busy}>
      <Toggle label="Snap to beats" checked={snap} onCheckedChange={onsnap} />
      <span class="caption">Snap to beats</span>
    </div>
  {/if}

  <span class="count" inert={busy}>{count} {count === 1 ? "section" : "sections"}{#if snapMerged > 0}{` (${snapMerged} merged by snap)`}{/if}</span>

  <div class="actions">
    <TextButton labels={{ off: "Cancel", on: "Cancel" }} appearance="subtle" onValueChange={oncancel} />
    <TextButton labels={{ off: "Apply", on: "Apply" }} appearance="primary" disabled={busy} onValueChange={onapply} />
  </div>
</div>

<style>
  .controls {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap; /* the 1000 px dialog is narrower than all the controls side by side */
    gap: 10px 24px;
  }
  .granularity {
    width: 220px;
  }
  .granularity :global(.slider) {
    --slider-length: 220px;
  }
  .granularity :global(.field__label) {
    text-align: left;
  }
  .group {
    display: grid;
    gap: 7px;
  }
  .snap {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 0;
  }
  /* Match the 20px height of the Tabs next to it. */
  .snap :global(.toggle) {
    inline-size: 20px;
    block-size: 20px;
  }
  .snap :global(.toggle span) {
    inline-size: 20px;
    block-size: 20px;
  }
  .caption,
  .count {
    color: var(--muted-text-color);
    font-size: 12px;
  }
  .count {
    padding-bottom: 3px;
  }
  .busy > :not(.actions) {
    opacity: 0.55;
  }
  .actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
</style>
