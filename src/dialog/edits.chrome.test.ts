// Feedback round 2, item 1 ("I did a lot of edits and then hit Apply but the edits weren't in the output"): drives the
// built Structure dialog in headless Chrome with trusted mouse and key events, the way a user does (so focus, blur and
// the Patchbay controls behave as they do in Live's web view), then clicks Apply and reads the DialogResult the page
// posts. Each case checks that what the dialog showed just before Apply is what it sent.
import { describe, expect, it, type TestContext } from "vitest";
import type { Section } from "../core/types.js";
import { CHROME, CHROME_TEST_TIMEOUT, silentWav, useChromeDialog, type ChromePage } from "../test/chromeDialog.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE, type DialogResult, type StructurePayload } from "./protocol.js";
import { createStructureState } from "./structureState.js";
import { ALIVE_TIMEOUT_MS, CHECKING_CONNECTION, HOST_FRESH_MS, LOST_CONNECTION } from "./bridge.js";
import { createServer, type Server } from "node:http";
import { serveDialog } from "../live/dialogServer.js";
import { cannedPayload } from "./fixture.js";

const chrome = useChromeDialog();
type Apply = Extract<DialogResult, { action: "apply" }>;
const BARS = Array.from({ length: 90 }, (_, i) => 1 + 2 * i); // off the fake's downbeats (2, 4, 6, ...)

interface Shown {
  labels: string[];
  boundaries: number[];
}

function driver(page: ChromePage) {
  const d = {
    page,
    /** The band labels (their tooltips: the full text) and the handle times the dialog shows now. */
    shown: () =>
      page.eval<Shown>(`({
        labels: [].map.call(document.querySelectorAll(".band"), function (b) { return b.title.split("\\n")[0]; }), // fb3: a narrow band's length is the tooltip's 2nd line
        boundaries: [].map.call(document.querySelectorAll("[role=slider]"), function (h) { return Number(h.getAttribute("aria-valuenow")); })
      })`),
    /** Bands wide enough to double-click clear of the 11 px boundary handles at their edges. */
    wide: () =>
      page.eval<number[]>(
        `[].map.call(document.querySelectorAll(".band"), function (b, i) { return b.getBoundingClientRect().width > 40 ? i : -1; }).filter(function (i) { return i >= 0; })`,
      ),
    widest: () =>
      page.eval<number>(
        `(function () { var w = [].map.call(document.querySelectorAll(".band"), function (b) { return b.getBoundingClientRect().width; }); return w.indexOf(Math.max.apply(null, w)); })()`,
      ),
    async band(i: number) {
      return page.centre(".band", i);
    },
    /** Double-clicks band i, selects its text and types `text`; leaves the field open (focused). */
    async startRename(i: number, text: string) {
      const c = await d.band(i);
      await page.dblclick(c.x, c.y);
      await page.selectAll();
      await page.type(text);
    },
    async rename(i: number, text: string) {
      await d.startRename(i, text);
      await page.key("Enter");
    },
    async handle(i: number) {
      return page.centre("[role=slider]", i);
    },
    async dragHandle(i: number, dx: number, modifiers = 0) {
      const h = await d.handle(i);
      await page.drag(h.x, h.y, h.x + dx, h.y, 8, modifiers);
    },
    async removeHandle(i: number) {
      const h = await d.handle(i);
      await page.dblclick(h.x, h.y);
    },
    /** Double-clicks the waveform at time t. */
    async addAt(t: number, duration: number, modifiers = 0) {
      const r = await page.eval<{ left: number; width: number; top: number; height: number }>(
        `(function () { var r = document.querySelector(".waveform canvas").getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, height: r.height }; })()`,
      );
      await page.dblclick(r.left + (t / duration) * r.width, r.top + r.height * 0.8, modifiers);
    },
    async tab(label: string) {
      const i = await page.eval<number>(
        `[].findIndex.call(document.querySelectorAll("[role=tab]"), function (b) { return b.textContent.trim() === ${JSON.stringify(label)}; })`,
      );
      expect(i, label).toBeGreaterThanOrEqual(0);
      const c = await page.centre("[role=tab]", i);
      await page.click(c.x, c.y);
    },
    async toggleSnap() {
      const c = await page.centre(".snap .toggle");
      await page.click(c.x, c.y);
    },
    /** Drags the named slider's thumb by `fraction` of its travel. */
    async slide(label: "Sections" | "Letters", fraction: number) {
      const r = await page.eval<{ left: number; width: number; y: number; value: number; min: number; max: number }>(`(function () {
        var input = document.querySelector('input[type=range][aria-label=${JSON.stringify(label)}]');
        var r = input.closest(".slider").getBoundingClientRect();
        return { left: r.left, width: r.width, y: r.top + r.height / 2, value: +input.value, min: +input.min, max: +input.max };
      })()`);
      const x0 = r.left + 6 + ((r.value - r.min) / (r.max - r.min)) * (r.width - 12);
      await page.drag(x0, r.y, x0 + fraction * (r.width - 12), r.y);
    },
    async apply(): Promise<Apply> {
      const c = await page.centre(".actions button", 1);
      await page.click(c.x, c.y);
      await page.settle(100);
      const sent = await page.sent<DialogResult>();
      expect(sent).toHaveLength(1);
      expect(sent[0].action).toBe("apply");
      return sent[0] as Apply;
    },
  };
  return d;
}

async function open(ctx: TestContext, p: StructurePayload) {
  return driver(await chrome.get(ctx).open({ ...p, audioUrl: silentWav() }, ...DIALOG_SIZE.structure));
}

const starts = (s: Section[]) => s.slice(1).map((x) => x.start);
/** The dialog showed exactly what it sent. */
function sentWhatItShowed(r: Apply, shown: Shown) {
  expect(r.sections.map((s) => s.label)).toEqual(shown.labels);
  expect(starts(r.sections)).toEqual(shown.boundaries);
}

describe.skipIf(!CHROME)("edits reach the DialogResult (feedback round 2, item 1; headless Chrome)", () => {
  const T = { timeout: CHROME_TEST_TIMEOUT };

  it("a rename committed with Enter", T, async (ctx) => {
    const d = await open(ctx, cannedStructurePayload({ snap: false }));
    await d.rename(3, "Hook");
    const shown = await d.shown();
    expect(shown.labels[3]).toBe("Hook");
    const r = await d.apply();
    sentWhatItShowed(r, shown);
    await d.page.close();
  });

  it("a rename whose field still has focus when Apply is clicked", T, async (ctx) => {
    const d = await open(ctx, cannedStructurePayload({ snap: false }));
    await d.startRename(4, "Drop");
    const r = await d.apply();
    expect(r.sections[4].label).toBe("Drop");
    await d.page.close();
  });

  it("several renames", T, async (ctx) => {
    const d = await open(ctx, cannedStructurePayload({ snap: false }));
    await d.rename(2, "Verse one");
    await d.rename(3, "Hook");
    await d.rename(5, "Hook");
    await d.startRename(7, "Last hook");
    const r = await d.apply();
    const labels = r.sections.map((s) => s.label);
    expect([labels[2], labels[3], labels[5], labels[7]]).toEqual(["Verse one", "Hook", "Hook", "Last hook"]);
    await d.page.close();
  });

  it("a drag, an add and a remove, then a rename after the drag", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: false });
    const d = await open(ctx, p);
    const before = await d.shown();
    await d.dragHandle(3, 25);
    const dragged = await d.shown();
    expect(dragged.boundaries[3]).not.toBe(before.boundaries[3]);
    // A gap between two boundaries, far from both.
    const b = dragged.boundaries;
    const gap = b.findIndex((x, i) => i > 0 && x - b[i - 1] > 12);
    await d.addAt((b[gap - 1] + b[gap]) / 2, p.durationSec);
    expect((await d.shown()).boundaries).toHaveLength(b.length + 1);
    await d.removeHandle(1);
    expect((await d.shown()).boundaries).toHaveLength(b.length);
    await d.rename(3, "After the drag");
    const shown = await d.shown();
    const r = await d.apply();
    sentWhatItShowed(r, shown);
    expect(r.sections[3].label).toBe("After the drag");
    await d.page.close();
  });

  it.for([
    ["Colors", (d: ReturnType<typeof driver>) => d.tab("Soft")],
    ["Letters", (d: ReturnType<typeof driver>) => d.slide("Letters", -0.3)],
  ] as const)("edits followed by a %s change", T, async ([, change], ctx) => {
    const d = await open(ctx, cannedStructurePayload({ snap: false }));
    await d.dragHandle(4, -20);
    await d.rename(2, "Mine");
    await d.rename(6, "Also mine");
    const edited = await d.shown();
    await change(d);
    const shown = await d.shown();
    expect(shown.boundaries).toEqual(edited.boundaries);
    expect(shown.labels[2]).toBe("Mine");
    expect(shown.labels[6]).toBe("Also mine");
    sentWhatItShowed(await d.apply(), shown);
    await d.page.close();
  });

  it("edits followed by a Snap toggle and a target switch, with the Sections slider at 0", T, async (ctx) => {
    const d = await open(ctx, cannedStructurePayload({ snap: false, barGrid: BARS }));
    await d.rename(3, "Mine");
    await d.dragHandle(5, 17);
    await d.toggleSnap(); // on: re-snaps to the downbeats
    await d.tab("Bars");
    const shown = await d.shown();
    expect(shown.labels[3]).toBe("Mine");
    for (const t of shown.boundaries) expect(BARS).toContain(t);
    sentWhatItShowed(await d.apply(), shown);
    await d.page.close();
  });

  it("renames alone count as hand edits: a Snap toggle with the Sections slider up keeps them (review I1)", T, async (ctx) => {
    const p = cannedStructurePayload({ snap: true, granularity: 0.6, barGrid: BARS });
    const d = await open(ctx, p);
    const [a, b] = await d.wide();
    await d.rename(a, "Mine");
    await d.rename(b, "Also mine");
    await d.toggleSnap();
    await d.toggleSnap();
    await d.tab("Bars");
    const shown = await d.shown();
    expect(shown.labels[a]).toBe("Mine");
    expect(shown.labels[b]).toBe("Also mine");
    sentWhatItShowed(await d.apply(), shown);
    await d.page.close();
  });

  it("a double-click on a narrow band renames it; it does not remove the boundary under it (and the next band's name)", T, async (ctx) => {
    // The fake's 2 s "end" section is ~11 px wide: the 11 px boundary handle used to cover all of it, so a double-click
    // meant to rename it removed its boundary instead, and with it the rename of the section after (shiftForRemove).
    const d = await open(ctx, cannedStructurePayload({ snap: false }));
    const before = await d.shown();
    const n = before.labels.length;
    await d.rename(n - 2, "Outro mine");
    const narrow = await d.band(n - 1);
    expect((await d.page.eval<number>(`document.querySelectorAll(".band")[${n - 1}].getBoundingClientRect().width`)) < 16).toBe(true);
    await d.page.dblclick(narrow.x, narrow.y);
    await d.page.selectAll();
    await d.page.type("Tail");
    await d.page.key("Enter");
    const shown = await d.shown();
    expect(shown.boundaries).toEqual(before.boundaries);
    expect(shown.labels.slice(-2)).toEqual(["Outro mine", "Tail"]);
    sentWhatItShowed(await d.apply(), shown);
    await d.page.close();
  });

  it("letters that wait for the slider's release: Apply right after a Letters drag on a long mix sends fresh letters", T, async (ctx) => {
    // 30 minutes: a recompute takes longer than the 30 ms budget, so after the first step the letters wait for release.
    const D = 1800;
    const { fakeStructureAnalysis } = await import("../structure/fake.js");
    const p = cannedStructurePayload({ durationSec: D, analysis: fakeStructureAnalysis(D), snap: false });
    const d = await open(ctx, p);
    const k = await d.widest();
    await d.rename(k, "Mine");
    await d.slide("Letters", 0.4);
    const r = await d.apply();
    expect(r.sections[k].label).toBe("Mine");
    // The letters sent are the ones for the slider's final value, whatever the bands showed.
    const s = createStructureState(p);
    s.setGroupDist(r.prefs!.groupDist);
    s.rename(k, "Mine");
    expect(r.sections.map((x) => x.label)).toEqual(s.sections().map((x) => x.label));
    await d.page.close();
  });
});

describe.skipIf(!CHROME)("Apply after the extension host has gone (feedback round 2, item 1; headless Chrome)", () => {
  const T = { timeout: CHROME_TEST_TIMEOUT };
  // The page is served by the real dialog server, as in Live. Closing it is what a host restart does to an open dialog.
  async function served(ctx: TestContext, p: StructurePayload | ReturnType<typeof cannedPayload>) {
    const harness = chrome.get(ctx);
    const payload = { ...p, audioUrl: silentWav() };
    const server = await serveDialog({ html: harness.html(payload), audioPath: "/nope.wav" });
    const page = await harness.open(payload, ...DIALOG_SIZE[p.mode], { url: server.url });
    return { d: driver(page), server };
  }
  const note = (d: ReturnType<typeof driver>) => d.page.eval<string | null>(`(document.querySelector("[role=alert]") || {}).textContent || null`);

  it("with the host there, Apply sends the result", T, async (ctx) => {
    const { d, server } = await served(ctx, cannedStructurePayload({ snap: false }));
    await d.rename(3, "Hook");
    const r = await d.apply();
    expect(r.sections[3].label).toBe("Hook");
    expect(await note(d)).toBeNull();
    await server.close();
    await d.page.close();
  });

  it.for([
    ["Structure", () => cannedStructurePayload({ snap: false })],
    ["Cue", () => cannedPayload()],
  ] as const)("%s: Apply keeps the dialog open and says the edits were not applied; Cancel still closes it", T, async ([, make], ctx) => {
    const { d, server } = await served(ctx, make());
    await d.rename(2, "Hook");
    await server.close(); // the host restarts under the open dialog
    const c = await d.page.centre(".actions button", 1);
    await d.page.click(c.x, c.y);
    await d.page.settle(300);
    expect(await d.page.sent()).toEqual([]);
    expect(await note(d)).toBe(LOST_CONNECTION);
    expect((await d.shown()).labels[2]).toBe("Hook"); // the edits are still on screen
    const x = await d.page.centre(".actions button", 0);
    await d.page.click(x.x, x.y);
    await d.page.settle(100);
    expect(await d.page.sent()).toEqual([{ action: "cancel" }]);
    await d.page.close();
  });
});

describe.skipIf(!CHROME)("Apply while the host is slow to answer (fb2 review I3; headless Chrome)", () => {
  // A stand-in for the dialog server whose `alive` answers after `delay` ms, or never (null) until `answer` is set.
  // Its `structure` progress answers at once while `structure` is true (an analysis running), and never after.
  async function slowHost(html: string, delay: number | null) {
    const host = { delay, alives: 0, structure: true, structures: 0 };
    const server: Server = createServer((req, res) => {
      if (req.url?.endsWith("/alive")) {
        host.alives++;
        if (host.delay !== null) setTimeout(() => res.writeHead(204).end(), host.delay);
        return; // a hung host: never answers (the page's timeout gives up)
      }
      if (req.url?.endsWith("/structure")) {
        if (!host.structure) return; // gone quiet
        host.structures++;
        const body = JSON.stringify({ state: "running", percent: 40 });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return {
      host,
      url: `http://127.0.0.1:${port}/t/`,
      close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
    };
  }
  const status = (d: ReturnType<typeof driver>) => d.page.eval<string | null>(`(document.querySelector("[role=status]") || {}).textContent || null`);
  const alert = (d: ReturnType<typeof driver>) => d.page.eval<string | null>(`(document.querySelector("[role=alert]") || {}).textContent || null`);
  const applyDisabled = (d: ReturnType<typeof driver>) => d.page.eval<boolean>(`document.querySelectorAll(".actions button")[1].disabled`);
  async function served(ctx: TestContext, p: StructurePayload | ReturnType<typeof cannedPayload>, delay: number | null) {
    const harness = chrome.get(ctx);
    const payload = { ...p, audioUrl: silentWav() };
    const server = await slowHost(harness.html(payload), delay);
    const page = await harness.open(payload, ...DIALOG_SIZE[p.mode], { url: server.url });
    return { d: driver(page), server };
  }
  /** Tries to edit the frozen dialog: a rename, a drag, a Delete on the selected handle, a tab. */
  async function tryToEdit(d: ReturnType<typeof driver>) {
    const c = await d.band(5);
    await d.page.dblclick(c.x, c.y);
    expect(await d.page.eval<boolean>(`!!document.querySelector(".rename")`)).toBe(false);
    await d.dragHandle(1, 40);
    await d.page.key("Delete");
    // An enabled tab: Structure's Soft colour (Slice by's tabs are disabled without patterns, so an index would hit one); Cue's second tab.
    const i = await d.page.eval<number>(
      `(function () { var t = [].slice.call(document.querySelectorAll("[role=tab]")); var s = t.findIndex(function (b) { return b.textContent.trim() === "Soft"; }); return t.length ? (s >= 0 ? s : 1) : -1; })()`,
    );
    if (i >= 0) {
      const c = await d.page.centre("[role=tab]", i);
      await d.page.click(c.x, c.y);
    }
  }

  it.for([
    ["Structure", () => cannedStructurePayload({ snap: false })],
    ["Cue", () => cannedPayload()],
  ] as const)("%s: a 5 s answer: the dialog is frozen meanwhile, says so, and sends what it showed, the edit just before Apply included", { timeout: CHROME_TEST_TIMEOUT }, async ([, make], ctx) => {
    const { d, server } = await served(ctx, make(), 5000);
    await d.rename(2, "Mine");
    await d.dragHandle(3, 25); // the edit just before Apply (it also selects handle 3)
    const shown = await d.shown();
    const c = await d.page.centre(".actions button", 1);
    await d.page.click(c.x, c.y);
    await d.page.settle(200);
    expect(await status(d)).toBe(CHECKING_CONNECTION);
    expect(await applyDisabled(d)).toBe(true);
    await tryToEdit(d);
    await d.page.click(c.x, c.y); // a second Apply is ignored
    expect(await d.shown()).toEqual(shown);
    expect(await d.page.sent()).toEqual([]);
    await d.page.settle(5500);
    const sent = await d.page.sent<DialogResult>();
    expect(sent).toHaveLength(1);
    expect(sent[0].action).toBe("apply");
    sentWhatItShowed(sent[0] as Apply, shown);
    expect((sent[0] as Apply).sections[2].label).toBe("Mine");
    expect(server.host.alives).toBe(1);
    await server.close();
    await d.page.close();
  });

  it("a host that never answers: after the timeout, the lost note; the dialog unfreezes with the edits, and Apply works once it answers", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const { d, server } = await served(ctx, cannedStructurePayload({ snap: false }), null);
    await d.rename(2, "Mine");
    const shown = await d.shown();
    const c = await d.page.centre(".actions button", 1);
    await d.page.click(c.x, c.y);
    await d.page.settle(ALIVE_TIMEOUT_MS - 2000);
    expect(await status(d)).toBe(CHECKING_CONNECTION);
    expect(await alert(d)).toBeNull();
    await d.page.settle(2500);
    expect(await status(d)).toBeNull();
    expect(await alert(d)).toBe(LOST_CONNECTION);
    expect(await applyDisabled(d)).toBe(false);
    expect(await d.page.sent()).toEqual([]);
    expect(await d.shown()).toEqual(shown); // the edits are still there
    await d.rename(4, "Also mine"); // and the dialog is editable again
    const after = await d.shown();
    expect(after.labels[4]).toBe("Also mine");
    server.host.delay = 0; // the host is back
    sentWhatItShowed(await d.apply(), after);
    await server.close();
    await d.page.close();
  });

  it("controller ruling (int3): an answer within HOST_FRESH_MS is the check, so Apply goes at once; once the answers have stopped for longer, Apply asks alive again", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    // The Cue page polls the background analysis's progress every 500 ms; alive would hang (one long ORT run).
    const background = () => {
      const p = cannedPayload();
      return cannedPayload({ modes: { structure: { ...p.modes.structure, background: true } } });
    };
    const fresh = await served(ctx, background(), null);
    await fresh.d.page.settle(1200);
    expect(fresh.server.host.structures).toBeGreaterThan(0);
    let c = await fresh.d.page.centre(".actions button", 1);
    await fresh.d.page.click(c.x, c.y);
    await fresh.d.page.settle(200);
    const sent = await fresh.d.page.sent<DialogResult>();
    expect(sent.map((r) => r.action)).toEqual(["apply"]);
    expect(fresh.server.host.alives).toBe(0);
    await fresh.server.close();
    await fresh.d.page.close();

    const stale = await served(ctx, background(), null);
    await stale.d.page.settle(1200);
    expect(stale.server.host.structures).toBeGreaterThan(0);
    stale.server.host.structure = false; // the host stops answering (gone, or stuck)
    await stale.d.page.settle(HOST_FRESH_MS + 1000);
    c = await stale.d.page.centre(".actions button", 1);
    await stale.d.page.click(c.x, c.y);
    await stale.d.page.settle(200);
    expect(await status(stale.d)).toBe(CHECKING_CONNECTION);
    expect(stale.server.host.alives).toBe(1);
    expect(await stale.d.page.sent()).toEqual([]);
    await stale.server.close();
    await stale.d.page.close();
  });

  it("Cancel still closes at once while the host is being asked", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const { d, server } = await served(ctx, cannedStructurePayload({ snap: false }), null);
    const c = await d.page.centre(".actions button", 1);
    await d.page.click(c.x, c.y);
    await d.page.settle(100);
    expect(await status(d)).toBe(CHECKING_CONNECTION);
    const x = await d.page.centre(".actions button", 0);
    await d.page.click(x.x, x.y);
    await d.page.settle(100);
    expect(await d.page.sent()).toEqual([{ action: "cancel" }]);
    await server.close();
    await d.page.close();
  });
});

describe.skipIf(!CHROME)("Cmd (Mac) / Ctrl (Windows) skips snapping for one edit (feedback round 2; headless Chrome)", () => {
  // Headless Chrome reports the platform it runs on, so the key is the one Live's web view would use there.
  const MOD = process.platform === "darwin" ? 4 : 2; // CDP modifiers: Meta 4, Ctrl 2
  const onGrid = (t: number) => Math.abs(t / 2 - Math.round(t / 2)) < 1e-6; // the fake's downbeats are every 2 s

  it("a drag or an add with the key held lands off the grid; without it, on the grid; Snap stays on", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const p = cannedStructurePayload({ snap: true });
    const d = await open(ctx, p);
    const snapBox = () => d.page.eval<boolean>(`document.querySelector(".snap input").checked`);
    expect(await snapBox()).toBe(true);
    await d.dragHandle(3, 23.3, MOD);
    const free = (await d.shown()).boundaries[3];
    expect(onGrid(free)).toBe(false);
    await d.dragHandle(5, 17.7);
    expect(onGrid((await d.shown()).boundaries[5])).toBe(true);
    const b = (await d.shown()).boundaries;
    const gap = b.findIndex((x, i) => i > 0 && x - b[i - 1] > 12);
    const t = (b[gap - 1] + b[gap]) / 2 + 0.7;
    await d.addAt(t, p.durationSec, MOD);
    const added = (await d.shown()).boundaries.find((x) => !b.includes(x))!;
    expect(onGrid(added)).toBe(false);
    expect(await snapBox()).toBe(true);
    const shown = await d.shown();
    sentWhatItShowed(await d.apply(), shown);
    await d.page.close();
  });
});
