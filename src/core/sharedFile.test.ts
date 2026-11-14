import { describe, expect, it, vi } from "vitest";
import { sharedFile } from "./sharedFile.js";

describe("sharedFile", () => {
  it("removes the file only when the last reference is let go, whichever ends first", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const remove = vi.fn(async () => undefined);
      const file = sharedFile("/var/render.aif", remove);
      const refs = [file.retain(), file.retain()];
      await refs[order[0]]();
      expect(remove).not.toHaveBeenCalled();
      await refs[order[1]]();
      expect(remove.mock.calls).toEqual([["/var/render.aif"]]);
    }
  });

  it("letting the same reference go twice counts once", async () => {
    const remove = vi.fn(async () => undefined);
    const file = sharedFile("/f", remove);
    const a = file.retain();
    const b = file.retain();
    await a();
    await a();
    expect(remove).not.toHaveBeenCalled();
    await b();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("refuses a new reference once the file is gone", async () => {
    const file = sharedFile("/f", async () => undefined);
    await file.retain()();
    expect(() => file.retain()).toThrow(/already removed/);
  });
});
