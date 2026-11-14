<script lang="ts">
  // Canary for `npm run check`, never imported or bundled. Patchbay's prop types must stay strict: if a dependency
  // bump or a resolution change degrades them to `any`, the @ts-expect-error below goes unused and the check fails.
  import type { ComponentProps } from "svelte";
  import { TextButton } from "@patchbayhq/svelte";

  // @ts-expect-error "bogus" is not a ControlAppearance
  const bad: ComponentProps<typeof TextButton>["appearance"] = "bogus";
  void bad;
</script>
