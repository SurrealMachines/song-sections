// Controller ruling on fb2 review I3 (int3): an ok answer from the host within HOST_FRESH_MS stands in for `alive`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALIVE_TIMEOUT_MS, HOST_FRESH_MS, deliver, hostFetchBytes, pollStructure, resetHostAnswer } from "./bridge.js";

const ORIGIN = "http://127.0.0.1:4321";

/** A page served by a host whose `alive` never answers (busy in one ORT run, or gone) and whose other routes do. */
function host(opts: { structure?: "ok" | 404 } = {}) {
  const urls: string[] = [];
  const sent: unknown[] = [];
  vi.stubGlobal("location", { protocol: "http:", href: `${ORIGIN}/tok/`, origin: ORIGIN });
  vi.stubGlobal("window", { webkit: { messageHandlers: { live: { postMessage: (m: { params: string[] }) => sent.push(JSON.parse(m.params[0])) } } } });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      urls.push(url);
      if (url === "alive")
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      if (url === "structure" && opts.structure === 404) return Promise.resolve({ ok: false, status: 404 });
      if (url === "structure") return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "done", percent: 100 }) });
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    }),
  );
  const alives = () => urls.filter((u) => u === "alive").length;
  return { urls, sent, alives };
}

const apply = () => ({ action: "cancel" }) as const; // any result: what deliver sends is not under test here

beforeEach(() => {
  vi.useFakeTimers();
  resetHostAnswer();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("deliver with a recent answer from the host (controller ruling, int3)", () => {
  it("a structure poll answered within HOST_FRESH_MS: sends at once, with no alive request", async () => {
    const h = host();
    pollStructure(() => {}, 100);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HOST_FRESH_MS - 100);
    await expect(deliver(apply)).resolves.toBe(true);
    expect(h.alives()).toBe(0);
    expect(h.sent).toEqual([{ action: "cancel" }]);
  });

  it("an audio or stem fetch counts too, when its body arrives as well as when its answer does", async () => {
    const h = host();
    const r = await hostFetchBytes("audio.wav");
    await vi.advanceTimersByTimeAsync(HOST_FRESH_MS + 500);
    await r.arrayBuffer(); // the body finishing is the host answering then
    await vi.advanceTimersByTimeAsync(HOST_FRESH_MS - 100);
    await expect(deliver(apply)).resolves.toBe(true);
    expect(h.alives()).toBe(0);
  });

  it("an answer older than HOST_FRESH_MS: asks alive as before, and a host that never answers is lost after the timeout", async () => {
    const h = host();
    pollStructure(() => {}, 100);
    await vi.advanceTimersByTimeAsync(HOST_FRESH_MS + 1);
    const result = deliver(apply);
    await vi.advanceTimersByTimeAsync(ALIVE_TIMEOUT_MS - 1000);
    expect(h.alives()).toBe(1);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("no answer yet, a not-ok answer, or an answer from another server (a data: URL) is no shortcut", async () => {
    const h = host({ structure: 404 });
    pollStructure(() => {}, 100);
    await (await hostFetchBytes("data:audio/wav;base64,AAAA")).arrayBuffer();
    await (await hostFetchBytes("http://example.test/a.wav")).arrayBuffer();
    await vi.advanceTimersByTimeAsync(10);
    const result = deliver(apply);
    await vi.advanceTimersByTimeAsync(ALIVE_TIMEOUT_MS);
    await expect(result).resolves.toBe(false);
    expect(h.alives()).toBe(1);
    expect(h.sent).toEqual([]);
  });
});
