<script lang="ts">
  import { Slider, Tabs, TextButton, Toggle } from "@patchbayhq/svelte";
  import type { ArrangementOutput, View } from "../core/types.js";
  import { GROUP_DIST_MAX, GROUP_DIST_MIN } from "../grouping/letters.js";
  import { dragOnly } from "./dragOnly.js";
  import { resetOnDoubleClick } from "./resetOnDoubleClick.js";
  import type { StemName } from "../structure/contract.js";
  import { DEFAULT_STRUCTURE_PREFS, type SliceBy, type SnapTarget, type StructureColorMode } from "./protocol.js";
  import { stepIndex } from "./structureState.js";

  interface Props {
    /** Sections slider, -1 (Fewer) .. 1 (More). */
    granularity: number;
    canGranulate: boolean;
    ongranularity: (g: number) => void;
    /** Letters slider: the grouping distance, GROUP_DIST_MIN (Strict) .. GROUP_DIST_MAX (Loose). */
    groupDist: number;
    ongroupdist: (d: number) => void;
    /**
     * Plan 6, Patterns slider: one position per real level of the clip (`patternSteps`, "only real levels", Matt), from
     * Fewer to More. It sits on the last step at or below `patternLevel`, and a move hands on the engine level of its
     * new position. Disabled when `canPattern` is false (no pattern lanes, or only one real level).
     */
    patternSteps: readonly number[];
    patternLevel: number;
    canPattern: boolean;
    onpatterns: (level: number) => void;
    /** A slider was let go (its range input's change event). */
    onrelease: () => void;
    /** What the clip is sliced by. */
    sliceBy: SliceBy;
    /**
     * The sources the clip can be sliced by: those with a pattern lane that is not all rests. Any other source has its
     * Slice by item disabled (the engine may leave out a source the payload lists; an all-rest lane has nothing to name).
     */
    sliceable: readonly StemName[];
    onslice: (s: SliceBy) => void;
    colorMode: StructureColorMode;
    output: ArrangementOutput;
    view: View;
    count: number;
    snap: boolean;
    canSnap: boolean;
    snapTarget: SnapTarget;
    canSnapDownbeats: boolean;
    canSnapBars: boolean;
    /** Boundaries the last snapping pass dropped. */
    snapMerged: number;
    onsnap: (on: boolean) => void;
    onsnaptarget: (t: SnapTarget) => void;
    showStems: boolean;
    onshowstems: (on: boolean) => void;
    /** fb2: set only when this analysis kept no stems to play; shows Re-analyze next to Show stems. */
    onreanalyse?: (() => void) | null;
    oncolormode: (m: StructureColorMode) => void;
    onoutput: (o: ArrangementOutput) => void;
    /** fb2 review I3: the result is on its way; everything but Cancel is disabled. */
    busy?: boolean;
    oncancel: () => void;
    onapply: () => void;
    /**
     * Matt (Live, 3 Nov): set only when stems are kept; shows Send to new tracks between Cancel and Apply, which does
     * what the send menu's Send all stems to new tracks does.
     */
    onsendall?: (() => void) | null;
  }

  let {
    granularity,
    canGranulate,
    ongranularity,
    groupDist,
    ongroupdist,
    patternSteps,
    patternLevel,
    canPattern,
    onpatterns,
    onrelease,
    sliceBy,
    sliceable,
    onslice,
    colorMode,
    output,
    view,
    count,
    snap,
    canSnap,
    snapTarget,
    canSnapDownbeats,
    canSnapBars,
    snapMerged,
    onsnap,
    onsnaptarget,
    showStems,
    onshowstems,
    onreanalyse = null,
    oncolormode,
    onoutput,
    busy = false,
    oncancel,
    onapply,
    onsendall = null,
  }: Props = $props();

  // Plan 6: Slice by. Locators place the section locators and cut nothing, so only Sections applies there.
  const sliceItems = $derived.by(() => {
    const noCuts = view === "arrangement" && output === "locators";
    const item = (value: SliceBy, label: string) => ({
      value,
      label,
      disabled: value !== "sections" && (noCuts || !sliceable.includes(value)),
    });
    return [item("sections", "Sections"), item("drums", "Drums"), item("bass", "Bass"), item("vocals", "Vocals"), item("other", "Other")];
  });
  const colorItems = [
    { value: "groups", label: "Vivid", disabled: false },
    { value: "soft", label: "Soft", disabled: false },
    { value: "uniform", label: "Clip color", disabled: false },
  ];
  // Feedback round 1: try allin1's downbeats and Live's bars side by side. An unwarped Session clip has no bars.
  const targetItems = $derived([
    { value: "downbeats", label: "Downbeats", disabled: !canSnapDownbeats },
    { value: "bars", label: "Bars", disabled: !canSnapBars },
  ]);
  const outputItems = [
    { value: "split", label: "Split clip", disabled: false },
    { value: "locators", label: "Locators", disabled: false },
    { value: "both", label: "Both", disabled: false },
  ];
  // A double-click on a slider sets it to its default as a drag there would: the same handler, then the release.
  // Sections replaces the boundaries, his hand edits too, so a slider already at its default is left alone, as a drag to
  // where it already is would leave it.
  const resetSections = () => {
    if (Math.abs(granularity - DEFAULT_STRUCTURE_PREFS.granularity) < 1e-9) return;
    ongranularity(DEFAULT_STRUCTURE_PREFS.granularity);
    onrelease();
  };
  const resetLetters = () => {
    ongroupdist(DEFAULT_STRUCTURE_PREFS.groupDist);
    onrelease();
  };
  // The default is the top level; the dialog puts it on the clip's highest real step.
  const resetPatterns = () => {
    onpatterns(DEFAULT_STRUCTURE_PREFS.patternLevel);
    onrelease();
  };
  const SEND_TO_NEW_TRACKS = "Send to new tracks";
  const REANALYSE_TIP = "Runs the analysis again so stems can be played; edits in this dialog are lost";
</script>

<div class="controls" class:busy>
  <div class="group range" inert={busy}>
    <span class="caption">Sections</span>
    <div class="ends" onchange={onrelease} use:dragOnly use:resetOnDoubleClick={resetSections}>
      <span class="end">Fewer</span>
      <Slider label="Sections" orientation="horizontal" min={-1} max={1} step={0.01} value={granularity} disabled={!canGranulate} onValueChange={ongranularity} />
      <span class="end">More</span>
    </div>
  </div>

  <div class="group range" inert={busy}>
    <span class="caption">Letters</span>
    <div class="ends" onchange={onrelease} use:dragOnly use:resetOnDoubleClick={resetLetters}>
      <span class="end">Strict</span>
      <Slider label="Letters" orientation="horizontal" min={GROUP_DIST_MIN} max={GROUP_DIST_MAX} step={0.01} value={groupDist} onValueChange={ongroupdist} />
      <span class="end">Loose</span>
    </div>
  </div>

  <div class="group range" inert={busy}>
    <span class="caption">Patterns</span>
    <div class="ends" onchange={onrelease} use:dragOnly use:resetOnDoubleClick={resetPatterns}>
      <span class="end">Fewer</span>
      <Slider
        label="Patterns"
        orientation="horizontal"
        min={0}
        max={Math.max(0, patternSteps.length - 1)}
        step={1}
        value={stepIndex(patternSteps, patternLevel)}
        disabled={!canPattern}
        onValueChange={(i) => onpatterns(patternSteps[i] ?? 0)}
      />
      <span class="end">More</span>
    </div>
  </div>

  <div class="group" inert={busy}>
    <span class="caption">Slice by</span>
    <Tabs items={sliceItems} value={sliceBy} onValueChange={(v) => onslice(v as SliceBy)} />
  </div>

  <div class="group" inert={busy}>
    <span class="caption">Colors</span>
    <Tabs items={colorItems} value={colorMode} onValueChange={(v) => oncolormode(v as StructureColorMode)} />
  </div>

  {#if view === "arrangement"}
    <div class="group" inert={busy}>
      <span class="caption">Output</span>
      <Tabs items={outputItems} value={output} onValueChange={(v) => onoutput(v as ArrangementOutput)} />
    </div>
  {/if}

  {#if canSnap}
    <div class="toggle-row snap" inert={busy}>
      <Toggle label="Snap" checked={snap} onCheckedChange={onsnap} />
      <span class="caption">Snap to</span>
      <Tabs items={targetItems} value={snapTarget} onValueChange={(v) => onsnaptarget(v as SnapTarget)} />
    </div>
  {/if}

  <div class="toggle-row stems" inert={busy}>
    <Toggle label="Show stems" checked={showStems} onCheckedChange={onshowstems} />
    <span class="caption">Show stems</span>
    {#if onreanalyse}
      <span class="reanalyse" title={REANALYSE_TIP}>
        <TextButton labels={{ off: "Re-analyze", on: "Re-analyze" }} appearance="subtle" onValueChange={() => onreanalyse?.()} />
      </span>
    {/if}
  </div>

  <span class="count" inert={busy}>{count} {count === 1 ? "section" : "sections"}{#if snapMerged > 0}{` (${snapMerged} merged by snap)`}{/if}</span>

  <div class="actions">
    <TextButton labels={{ off: "Cancel", on: "Cancel" }} appearance="subtle" onValueChange={oncancel} />
    {#if onsendall}
      <TextButton labels={{ off: SEND_TO_NEW_TRACKS, on: SEND_TO_NEW_TRACKS }} appearance="primary" disabled={busy} onValueChange={() => onsendall?.()} />
    {/if}
    <TextButton labels={{ off: "Apply", on: "Apply" }} appearance="primary" disabled={busy} onValueChange={onapply} />
  </div>
</div>

<style>
  .controls {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap; /* the 1000 px dialog is narrower than all the controls side by side */
    gap: 10px 16px;
  }
  .group {
    display: grid;
    gap: 7px;
  }
  /* The sliders sit in the row of Tabs: same caption above, same 20px control height. */
  .range :global(.field__label) {
    display: none;
  }
  .range :global(.slider) {
    --slider-length: 104px; /* 120 px until fb2: the sixth Slice by tab (Other) needs the room in the first row */
    --slider-thickness: 20px;
  }
  .ends {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .end {
    color: var(--muted-text-color);
    font-size: 11px;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 0;
  }
  /* Match the 20px height of the Tabs next to it. */
  .toggle-row :global(.toggle) {
    inline-size: 20px;
    block-size: 20px;
  }
  .toggle-row :global(.toggle span) {
    inline-size: 20px;
    block-size: 20px;
  }
  /* A small text button: Patchbay's is 104 px wide at least, which would push the row over. */
  .reanalyse :global(.text-button) {
    min-inline-size: 0;
    min-block-size: 20px;
    padding: 0 8px;
    font-size: 11px;
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
