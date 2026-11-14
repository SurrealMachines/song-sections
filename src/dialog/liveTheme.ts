/** A liveTheme.css colour as seen from `el`, for what CSS cannot paint: the canvases. */
export const liveColor = (el: Element, name: string): string => getComputedStyle(el).getPropertyValue(name).trim();

/** Calls `onchange` whenever the system switches light or dark; returns the unsubscribe. Nothing to watch in jsdom. */
export function onSchemeChange(onchange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onchange);
  return () => query.removeEventListener("change", onchange);
}
