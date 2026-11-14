// Feedback round 2: holding Cmd (Mac) or Ctrl (Windows) while dragging a handle or double-clicking to add one skips
// snapping for that edit only, as Live's grid does. The Snap toggle stays the global setting. No Node imports.

/** True on macOS (Live's web view is WebKit there; WebView2 on Windows). */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The platform's snap-bypass key, as the hint names it. */
export const BYPASS_KEY = MAC ? "⌘" : "Ctrl";

/** True when the event's modifiers say: do not snap this edit. */
export function bypassesSnap(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return MAC ? e.metaKey : e.ctrlKey;
}

/** Text fields keep Delete/Backspace and the arrows; range inputs (the sliders) do not. */
export function isTextEntry(t: EventTarget | null): boolean {
  return (
    (t instanceof HTMLInputElement && t.type !== "range") ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}
