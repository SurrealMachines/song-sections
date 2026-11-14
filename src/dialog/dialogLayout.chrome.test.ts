// Task 13 Live fixes 3 and 4, laid out in headless Chrome at the real dialog sizes (jsdom has no layout):
// - the hint line wraps instead of being cut off, and a narrow band still shows its whole letter;
// - no empty area is left under the lanes: the controls sit right under the content, inside the dialog.
import { describe, expect, it, type TestContext } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, useChromeDialog } from "../test/chromeDialog.js";
import { cannedPayload, cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE, type DialogPayload, type StructurePayload } from "./protocol.js";

interface Band {
  title: string;
  text: string;
  left: number;
  right: number;
  letter: { text: string; left: number; right: number; clipped: boolean } | null;
}
interface Layout {
  innerHeight: number;
  scrollHeight: number;
  hint: { clipped: boolean; right: number };
  gap: number;
  footerBottom: number;
  waveformHeight: number;
  bands: Band[];
}

const PROBE = `(function () {
  var r = function (e) { return e.getBoundingClientRect(); };
  var hint = document.querySelector("header .hint");
  var footer = document.querySelector(".footer");
  return {
    innerHeight: innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    hint: { clipped: hint.scrollWidth > hint.clientWidth + 1 || hint.scrollHeight > hint.clientHeight + 1, right: r(hint).right },
    gap: r(footer).top - r(footer.previousElementSibling).bottom,
    footerBottom: r(footer).bottom,
    waveformHeight: r(document.querySelector(".waveform")).height,
    bands: [].map.call(document.querySelectorAll(".band"), function (b) {
      var l = b.querySelector(".letter");
      return {
        title: b.title, text: b.textContent.trim(), left: r(b).left, right: r(b).right,
        letter: l && { text: l.textContent, left: r(l).left, right: r(l).right, clipped: l.scrollWidth > l.clientWidth + 0.5 }
      };
    })
  };
})()`;

const chrome = useChromeDialog();
const layout = (ctx: TestContext, p: DialogPayload) => chrome.get(ctx).measure<Layout>(p, ...DIALOG_SIZE[p.mode], PROBE);

describe.skipIf(!CHROME)("dialog layout at the real sizes (headless Chrome)", () => {
  const cases: [string, () => DialogPayload][] = [
    ["Cue", () => cannedPayload()],
    ["Structure", () => cannedStructurePayload({ snap: false })],
    ["Cue in Session with the warp note", () => cannedPayload({ view: "session", warpNote: true })],
    ["Structure in Session with the warp note", () => cannedStructurePayload({ view: "session", warpNote: true, snap: false })],
    // Feedback round 1: Show stems grows the four lanes; the dialog must still fit with the waveform first in line.
    ["Structure with Show stems", () => cannedStructurePayload({ snap: false, showStems: true })],
    ["Structure in Session with the warp note and Show stems", () => cannedStructurePayload({ view: "session", warpNote: true, showStems: true })],
  ];

  it("Plan 6: the Structure dialog with its four stem lanes (no mix row) fits 1000 x 680, the footer inside it", async (ctx) => {
    const probe = `({ lanes: document.querySelectorAll(".lane").length, innerHeight: innerHeight, scrollHeight: document.documentElement.scrollHeight,
      footerBottom: document.querySelector(".footer").getBoundingClientRect().bottom })`;
    for (const showStems of [false, true]) {
      const m = await chrome.get(ctx).measure<{ lanes: number; innerHeight: number; scrollHeight: number; footerBottom: number }>(
        cannedStructurePayload({ showStems }),
        ...DIALOG_SIZE.structure,
        probe,
      );
      expect(m.lanes).toBe(4);
      expect(m.innerHeight).toBe(680);
      expect(m.scrollHeight).toBeLessThanOrEqual(m.innerHeight);
      expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight);
    }
  }, CHROME_TEST_TIMEOUT);

  it.for(cases)("%s: the hint wraps instead of being cut off", { timeout: CHROME_TEST_TIMEOUT }, async ([, make], ctx) => {
    const m = await layout(ctx, make());
    expect(m.hint.clipped).toBe(false);
    expect(m.hint.right).toBeLessThanOrEqual(1000 - 16 + 0.5);
  });

  it.for(cases)("%s: the controls follow the content with no empty area, inside the dialog", { timeout: CHROME_TEST_TIMEOUT }, async ([, make], ctx) => {
    const m = await layout(ctx, make());
    expect(m.gap).toBeLessThanOrEqual(16); // the column gap, not a dark void
    expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight);
    expect(m.scrollHeight).toBeLessThanOrEqual(m.innerHeight);
    expect(m.waveformHeight).toBeGreaterThanOrEqual(180); // the spare height goes to the waveform
  });

  it("shows a narrow band's whole letter, and the full label in its tooltip", async (ctx) => {
    const m = await layout(ctx, cannedStructurePayload({ snap: false })); // the fake's 2 s "start" and "end" are ~11 px wide
    const narrow = [m.bands[0], m.bands.at(-1)!];
    for (const b of narrow) {
      expect(b.right - b.left).toBeLessThan(16);
      // fb3, item 3: too narrow for its length on the band, so the length is the tooltip's second line. fb4, item 1:
      // with snap off too, in bars and beats on allin1's grid.
      expect(b.title).toMatch(/^[A-Z]+′? - (start|end)\n(\d+ bars?|\d+\.\d(\.\d)?)$/);
      expect(b.text).toBe(b.title.split("\n")[0]);
      expect(b.letter!.text).toBe(b.title.split(" - ")[0]);
      expect(b.letter!.clipped).toBe(false);
      expect(b.letter!.left).toBeGreaterThanOrEqual(b.left - 0.5);
      expect(b.letter!.right).toBeLessThanOrEqual(b.right + 0.5);
    }
    for (const b of m.bands) expect(b.title.split("\n")[0]).toBe(b.text);
  }, CHROME_TEST_TIMEOUT);

  // Feedback round 1: the Structure controls row (two sliders, three Tabs, two toggles, the count and the buttons)
  // wraps inside the 1000 px dialog. Nothing may be cut off or overlap, with the longest Output row (Arrangement).
  const CONTROLS = `(function () {
    var box = function (e) { var r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    var row = document.querySelector(".controls");
    var items = [].map.call(row.children, function (c) {
      var b = box(c);
      b.name = c.className.split(" ").filter(function (k) { return k.indexOf("svelte-") !== 0; }).join(" ") + ":" + c.textContent.trim().slice(0, 30);
      return b;
    });
    var texts = [].map.call(row.querySelectorAll(".caption, .end, .count, button, [role=tab]"), function (e) {
      return { text: e.textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1, right: box(e).right, width: box(e).right - box(e).left };
    });
    var sliders = [].map.call(row.querySelectorAll(".slider"), function (e) { return box(e).right - box(e).left; });
    return { innerWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth, items: items, texts: texts, sliders: sliders };
  })()`;
  interface Controls {
    innerWidth: number;
    scrollWidth: number;
    items: { name: string; left: number; right: number; top: number; bottom: number }[];
    texts: { text: string; clipped: boolean; right: number; width: number }[];
    sliders: number[];
  }

  it.for([
    ["Arrangement", cannedStructurePayload({ barGrid: [1, 3, 5] })],
    ["Session with Show stems", cannedStructurePayload({ view: "session", showStems: true })],
  ] as const)("%s: the Structure controls wrap with nothing cut off or overlapping", { timeout: CHROME_TEST_TIMEOUT }, async ([, p], ctx) => {
    const m = await chrome.get(ctx).measure<Controls>(p, ...DIALOG_SIZE.structure, CONTROLS);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
    const names = m.items.map((i) => i.name).join(" | ");
    for (const want of ["Sections", "Letters", "Patterns", "Slice by", "Colors", "Snap to", "Show stems", "Apply"]) expect(names).toContain(want);
    for (const i of m.items) {
      expect(i.left, i.name).toBeGreaterThanOrEqual(16 - 0.5);
      expect(i.right, i.name).toBeLessThanOrEqual(m.innerWidth - 16 + 0.5);
    }
    for (let a = 0; a < m.items.length; a++) {
      for (let b = a + 1; b < m.items.length; b++) {
        const [x, y] = [m.items[a], m.items[b]];
        const overlap = x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5;
        expect(overlap, `${x.name} overlaps ${y.name}`).toBe(false);
      }
    }
    for (const t of m.texts) {
      expect(t.clipped, t.text).toBe(false);
      expect(t.width, t.text).toBeGreaterThan(0);
    }
    expect(m.sliders).toHaveLength(3); // Sections, Letters and Patterns (Plan 6)
    for (const w of m.sliders) expect(w).toBeGreaterThanOrEqual(100);
  });

  it("Show stems grows the four stem lanes and draws each stem's waveform; off, all are thin", async (ctx) => {
    const probe = `(function () {
      var lanes = [].map.call(document.querySelectorAll(".lane"), function (l) {
        var c = l.querySelector("canvas.wave");
        var inked = 0;
        if (c && c.width) {
          var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          for (var i = 3; i < d.length; i += 4) if (d[i] > 0) inked++;
        }
        return { source: l.dataset.source, height: l.getBoundingClientRect().height, canvas: !!c, inked: inked, area: c ? c.width * c.height : 0 };
      });
      return { lanes: lanes, waveformHeight: document.querySelector(".waveform").getBoundingClientRect().height };
    })()`;
    type Lanes = { lanes: { source: string; height: number; canvas: boolean; inked: number; area: number }[]; waveformHeight: number };
    const on = await chrome.get(ctx).measure<Lanes>(cannedStructurePayload({ showStems: true }), ...DIALOG_SIZE.structure, probe);
    const off = await chrome.get(ctx).measure<Lanes>(cannedStructurePayload({ showStems: false }), ...DIALOG_SIZE.structure, probe);
    expect(on.lanes.map((l) => l.source)).toEqual(["drums", "bass", "vocals", "other"]);
    for (const l of on.lanes) {
      expect(l.height).toBe(40);
      expect(l.canvas).toBe(true);
      expect(l.inked / l.area).toBeGreaterThan(0.05); // something is drawn
      expect(l.inked).toBeLessThan(l.area); // and it is not a solid block
    }
    for (const l of off.lanes) {
      expect(l.height).toBe(16);
      expect(l.canvas).toBe(false);
    }
    expect(off.waveformHeight - on.waveformHeight).toBeCloseTo(4 * 24, -1); // the lanes' growth comes out of the waveform
    expect(on.waveformHeight).toBeGreaterThanOrEqual(180); // 288 px at 1000 x 680 when written
  }, CHROME_TEST_TIMEOUT);

  /** A 1.8 s sliver whose edges both snap to the 156 s downbeat, so the count reads "10 sections (1 merged by snap)". */
  const mergedPayload = (over: Partial<StructurePayload> = {}) => {
    const base = cannedStructurePayload();
    const segs = base.analysis.segments.map((g) => ({ ...g }));
    segs[7] = { ...segs[7], end: 155.1 };
    segs[8] = { ...segs[8], start: 156.9 };
    segs.splice(8, 0, { start: 155.1, end: 156.9, label: "break" });
    return cannedStructurePayload({ analysis: { ...base.analysis, segments: segs }, barGrid: [1, 3, 5], ...over });
  };
  const ROWS_PROBE = `(function () {
    // Bottoms: the row aligns its items to the bottom (flex-end), so items in one row share it.
    var top = function (sel) { return Math.round(document.querySelector(sel).getBoundingClientRect().bottom); };
    return {
      count: document.querySelector(".count").textContent.trim(),
      rows: [top(".range"), top(".toggle-row.stems"), top(".actions")],
      reanalyse: !!document.querySelector(".toggle-row.stems .reanalyse"),
      footerBottom: document.querySelector(".footer").getBoundingClientRect().bottom,
      innerHeight: innerHeight,
      scrollHeight: document.documentElement.scrollHeight
    };
  })()`;
  type Rows = { count: string; rows: number[]; reanalyse: boolean; footerBottom: number; innerHeight: number; scrollHeight: number };
  const STEMS = { drums: "stems/drums.wav", bass: "stems/bass.wav", vocals: "stems/vocals.wav", other: "stems/other.wav" };

  // Plan 6: the Patterns slider joins Sections and Letters in the first row, which pushes Colors to the second, so
  // Cancel and Apply take a row of their own at the end (they shared the Show stems row before). Still inside the dialog.
  it("keeps Cancel and Apply after the Show stems row, inside the dialog, with the snap-merge note in the count", async (ctx) => {
    const m = await chrome.get(ctx).measure<Rows>(mergedPayload({ stemUrls: STEMS }), ...DIALOG_SIZE.structure, ROWS_PROBE);
    expect(m.count).toBe("10 sections (1 merged by snap)");
    expect(m.count).not.toContain("·");
    expect(m.reanalyse).toBe(false);
    expect(m.rows[1]).toBeGreaterThan(m.rows[0]); // Show stems is on the second row
    expect(m.rows[2]).toBeGreaterThan(m.rows[1]); // and the buttons on the third
    expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight);
    expect(m.scrollHeight).toBeLessThanOrEqual(m.innerHeight);
  }, CHROME_TEST_TIMEOUT);

  // Matt (Live, 3 Nov): Send to new tracks sits beside Apply, as big as it, with no extra row; checked with the
  // longest rows (Arrangement's Output, the snap-merge note) and in Session with Show stems.
  it("Send to new tracks (stems kept) shares Apply's row, its height and more than its width, and the footer still fits", async (ctx) => {
    const probe = `(function () {
      var box = function (e) { var r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      var buttons = [].map.call(document.querySelectorAll(".actions button"), function (b) {
        var o = box(b); o.text = b.textContent.trim(); o.clipped = b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1; return o;
      });
      var bottoms = [].map.call(document.querySelector(".controls").children, function (c) { return Math.round(box(c).bottom); });
      return {
        buttons: buttons,
        rows: bottoms.filter(function (b, i) { return bottoms.indexOf(b) === i; }).length,
        footerBottom: box(document.querySelector(".footer")).bottom,
        innerWidth: innerWidth, innerHeight: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight
      };
    })()`;
    type Button = { text: string; left: number; right: number; top: number; bottom: number; width: number; height: number; clipped: boolean };
    type Probe = { buttons: Button[]; rows: number; footerBottom: number; innerWidth: number; innerHeight: number; scrollWidth: number; scrollHeight: number };
    for (const p of [mergedPayload({ stemUrls: STEMS }), cannedStructurePayload({ view: "session", showStems: true, stemUrls: STEMS })]) {
      const m = await chrome.get(ctx).measure<Probe>(p, ...DIALOG_SIZE.structure, probe);
      expect(m.buttons.map((b) => b.text)).toEqual(["Cancel", "Send to new tracks", "Apply"]);
      const [, send, apply] = m.buttons;
      expect(send.top).toBeCloseTo(apply.top, 0);
      expect(send.height).toBeCloseTo(apply.height, 0);
      expect(send.width).toBeGreaterThanOrEqual(apply.width - 0.5);
      expect(send.right).toBeLessThanOrEqual(apply.left);
      expect(apply.right).toBeLessThanOrEqual(m.innerWidth - 16 + 0.5);
      for (const b of m.buttons) expect(b.clipped, b.text).toBe(false);
      expect(m.rows).toBe(3); // the controls' three rows, as without the button
      expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
      expect(m.scrollHeight).toBeLessThanOrEqual(m.innerHeight);
    }
  }, CHROME_TEST_TIMEOUT);

  it("Re-analyze (no stems kept) sits on the Show stems row; with the snap-merge note too, the buttons still fit", async (ctx) => {
    // fb2 ruling: the button sits next to Show stems.
    for (const p of [cannedStructurePayload({ stemUrls: null }), mergedPayload({ stemUrls: null })]) {
      const m = await chrome.get(ctx).measure<Rows>(p, ...DIALOG_SIZE.structure, ROWS_PROBE);
      expect(m.reanalyse).toBe(true);
      expect(m.rows[1]).toBeGreaterThan(m.rows[0]);
      expect(m.rows[2]).toBeGreaterThan(m.rows[1]);
      expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight);
      expect(m.scrollHeight).toBeLessThanOrEqual(m.innerHeight);
    }
  }, CHROME_TEST_TIMEOUT);

  it("a lane's name never overlaps a cell's letter (fb2: \"drums\" over a narrow first cell read \"drAums\")", async (ctx) => {
    // A first section of 7 s (about 39 px): its centred letter would sit on the lane name.
    const base = cannedStructurePayload();
    const segs = base.analysis.segments.map((g) => ({ ...g }));
    segs[1] = { ...segs[1], end: 7 };
    segs[2] = { ...segs[2], start: 7 };
    const analysis = { ...base.analysis, segments: segs, boundaryCandidates: [...base.analysis.boundaryCandidates, { time: 7, strength: 0.5 }].sort((a, b) => a.time - b.time) };
    const probe = `(function () {
      var box = function (e) { var r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, text: e.textContent }; };
      return [].map.call(document.querySelectorAll(".lane"), function (lane) {
        return {
          name: box(lane.querySelector(".name")),
          letters: [].map.call(lane.querySelectorAll(".cell .label, .tag"), box),
          first: lane.querySelector(".cell").getBoundingClientRect().right,
        };
      });
    })()`;
    type Box = { l: number; r: number; t: number; b: number; text: string };
    for (const showStems of [false, true]) {
      const lanes = await chrome
        .get(ctx)
        .measure<{ name: Box; letters: Box[]; first: number }[]>(cannedStructurePayload({ analysis, showStems, snap: false }), ...DIALOG_SIZE.structure, probe);
      expect(lanes).toHaveLength(4); // the four stems (Plan 6)
      expect(lanes[0].first).toBeLessThan(60); // the narrow first cell is there (its centre is under the name)
      for (const lane of lanes) {
        expect(lane.letters.length).toBeGreaterThan(3);
        for (const x of lane.letters) {
          const overlap = x.l < lane.name.r && x.r > lane.name.l && x.t < lane.name.b && x.b > lane.name.t;
          expect(overlap, `${lane.name.text} over "${x.text}" (show stems ${showStems})`).toBe(false);
        }
      }
    }
  }, CHROME_TEST_TIMEOUT);
});
