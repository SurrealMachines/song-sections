<script lang="ts">
  // Test support: StemLanes with props a test can change after mounting (stemLanes.dom.test.ts).
  import StemLanes from "../dialog/StemLanes.svelte";

  let { init, expose }: { init: Record<string, unknown>; expose: (set: (patch: Record<string, unknown>) => void) => void } = $props();
  // svelte-ignore state_referenced_locally
  const p = $state.raw(init);
  let cur = $state.raw({ ...p });
  // svelte-ignore state_referenced_locally
  expose((patch) => (cur = { ...cur, ...patch }));
</script>

<StemLanes {...(cur as never)} />
