// Matt (Live, 4 Nov): "Double clicking slider resets them." Patchbay's Slider has no reset of its own, so this watches
// the element holding it. A double-click on the slider (its track or thumb; not the Fewer / More words beside it) calls
// `reset`, which the owner makes do what moving the slider there by hand does. A disabled slider is left alone.
import { tick } from "svelte";

/** Svelte action: `use:resetOnDoubleClick={() => ongranularity(DEFAULT)}` on an element holding one Slider. */
export function resetOnDoubleClick(node: HTMLElement, reset: () => void) {
  let current = reset;
  const dbl = (e: MouseEvent) => {
    const onSlider = (e.target as Element | null)?.closest?.(".slider");
    const input = node.querySelector<HTMLInputElement>('input[type="range"]');
    if (!onSlider || !input || input.disabled) return;
    e.stopPropagation(); // not a double-click on whatever lies behind it
    current();
    // Matt (Live, 12 Nov): the value reset but the thumb stayed put. Patchbay draws the thumb from the input's value when
    // the input fires, or when its own update runs, which is before Svelte writes the new value into the input. So once
    // the update is in, the input says it changed. Not bubbling, so only the input's own listeners hear it (Patchbay's
    // redraw, and Svelte's binding, which reads back the value it just wrote), not an owner's onchange.
    void tick().then(() => input.dispatchEvent(new Event("change")));
  };
  node.addEventListener("dblclick", dbl);
  return {
    update(next: () => void) {
      current = next;
    },
    destroy() {
      node.removeEventListener("dblclick", dbl);
    },
  };
}
