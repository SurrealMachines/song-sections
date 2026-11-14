// A press on a range input's track that does not drag leaves its value alone (dev-H, fb/dialog: a press 2 px off the
// Sections thumb moved the slider, and any Sections move replaces the boundaries). Only a drag, or the keyboard, moves it.

/** How far, in px, the pointer must travel from the press before the slider follows it. */
export const DRAG_PX = 3;

/**
 * Svelte action for an element holding range inputs. A browser jumps a range input to the pressed point at once and
 * fires `input`; while a press has not yet moved DRAG_PX, this puts the input back and stops that event before the
 * slider's own handler (capture phase on the ancestor). Arrow keys fire `input` with no press, so they pass.
 */
export function dragOnly(node: HTMLElement) {
  let press: { x: number; y: number; input: HTMLInputElement; value: string; moved: boolean } | null = null;

  const down = (e: PointerEvent) => {
    const input = (e.target as Element | null)?.closest?.('input[type="range"]') as HTMLInputElement | null;
    press = input && node.contains(input) ? { x: e.clientX, y: e.clientY, input, value: input.value, moved: false } : null;
  };
  const move = (e: PointerEvent) => {
    if (press && !press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_PX) press.moved = true;
  };
  const up = () => {
    press = null;
  };
  const hold = (e: Event) => {
    if (!press || press.moved || e.target !== press.input) return;
    e.stopPropagation();
    press.input.value = press.value;
  };

  node.addEventListener("pointerdown", down, true);
  node.addEventListener("pointermove", move, true);
  node.addEventListener("input", hold, true);
  node.addEventListener("change", hold, true);
  const win = node.ownerDocument.defaultView;
  win?.addEventListener("pointerup", up, true);
  win?.addEventListener("pointercancel", up, true);
  return {
    destroy() {
      node.removeEventListener("pointerdown", down, true);
      node.removeEventListener("pointermove", move, true);
      node.removeEventListener("input", hold, true);
      node.removeEventListener("change", hold, true);
      win?.removeEventListener("pointerup", up, true);
      win?.removeEventListener("pointercancel", up, true);
    },
  };
}
