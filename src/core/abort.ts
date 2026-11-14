/**
 * Live's extension host has no DOMException, so cancellation rejects with a plain Error named "AbortError".
 * Callers test `error.name === "AbortError"`.
 */
export function abortError(message = "Aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

/** Throws abortError() when the signal is aborted. Reads only `signal.aborted` (no AbortSignal APIs in the host). */
export function throwIfAborted(signal: { aborted: boolean } | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Yield to the event loop (the host has no setImmediate or queueMicrotask). */
export function yieldToHost(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
