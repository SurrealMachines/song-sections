<script lang="ts">
  import "@patchbayhq/svelte/styles.css";
  import "./liveTheme.css";
  import CueView from "./CueView.svelte";
  import StructureView from "./StructureView.svelte";
  import type { DialogPayload } from "./protocol.js";

  let { payload }: { payload: DialogPayload } = $props();
</script>

{#if payload.mode === "cue"}
  <CueView {payload} />
{:else}
  <StructureView {payload} />
{/if}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
    background: var(--live-surface);
    color: var(--text-color);
    font-family: var(--control-font);
    overflow: hidden;
  }
</style>
