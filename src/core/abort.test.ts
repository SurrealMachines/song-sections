import { describe, expect, it } from "vitest";
import { abortError, throwIfAborted, yieldToHost } from "./abort.js";

describe("abortError", () => {
  it("is an Error named AbortError", () => {
    const e = abortError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AbortError");
  });
  it("throwIfAborted throws only when aborted", async () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted({ aborted: false })).not.toThrow();
    expect(() => throwIfAborted({ aborted: true })).toThrow(expect.objectContaining({ name: "AbortError" }));
    await yieldToHost();
  });
});
