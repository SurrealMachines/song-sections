// Feedback round 2, item 3 ("editing names on small sections is tough because the text field is often truncated"):
// the rename popover laid out in headless Chrome at the real dialog size, opened on a 1-bar band at the right edge.
// SONG_SECTIONS_SCREENSHOT=<path.png> also saves a screenshot of it.
import { describe, expect, it } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, silentWav, useChromeDialog } from "../test/chromeDialog.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE } from "./protocol.js";

const chrome = useChromeDialog();

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
interface Popover {
  innerWidth: number;
  innerHeight: number;
  band: Box;
  popover: Box;
  field: Box & { value: string; selection: [number, number]; focused: boolean };
  rows: { text: string; box: Box; clipped: boolean }[];
}

const PROBE = `(function () {
  var box = function (e) { var r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
  var bands = document.querySelectorAll(".band");
  var input = document.querySelector(".rename input");
  var f = box(input);
  f.value = input.value; f.selection = [input.selectionStart, input.selectionEnd]; f.focused = document.activeElement === input;
  var list = document.querySelector(".rename [role=listbox]");
  var lr = list.getBoundingClientRect();
  return {
    innerWidth: innerWidth, innerHeight: innerHeight,
    band: box(bands[bands.length - 1]),
    popover: box(document.querySelector(".rename")),
    field: f,
    rows: [].map.call(document.querySelectorAll(".rename [role=option]"), function (o) {
      var r = o.getBoundingClientRect();
      return { text: o.textContent.trim(), box: box(o), clipped: r.bottom > lr.bottom + 0.5 && r.top < lr.bottom };
    })
  };
})()`;

describe.skipIf(!CHROME)("the rename popover at the real dialog size (feedback round 2, item 3; headless Chrome)", () => {
  it("opens on a 1-bar band at the right edge, wide enough and inside the dialog, over the labels in use", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const bars = Array.from({ length: 91 }, (_, i) => 2 * i); // 120 BPM in 4/4: a bar is 2 s
    const p = cannedStructurePayload({ snap: true, snapTarget: "bars", barGrid: bars, audioUrl: silentWav() });
    const page = await chrome.get(ctx).open(p, ...DIALOG_SIZE.structure);
    const bandCount = await page.eval<number>(`document.querySelectorAll(".band").length`);
    // Two renames first, so the list shows renamed labels beside the computed ones.
    for (const [i, name] of [
      [2, "Verse - first"],
      [6, "Bridge"],
    ] as const) {
      const c = await page.centre(".band", i);
      await page.dblclick(c.x, c.y);
      await page.selectAll();
      await page.type(name);
      await page.key("Enter");
    }
    const last = await page.centre(".band", bandCount - 1);
    await page.dblclick(last.x, last.y);
    await page.settle(100);
    const m = await page.eval<Popover>(PROBE);
    if (process.env.SONG_SECTIONS_SCREENSHOT) await page.screenshot(process.env.SONG_SECTIONS_SCREENSHOT);
    await page.close();

    // The band: one bar (2 s of 180 s) at the right edge, far narrower than its label.
    expect(m.band.width).toBeLessThan(16);
    expect(m.band.right).toBeGreaterThan(m.innerWidth - 40);
    // The popover: inside the dialog's edges, with a field of at least 220 px, prefilled, selected and focused.
    expect(m.popover.left).toBeGreaterThanOrEqual(0);
    expect(m.popover.right).toBeLessThanOrEqual(m.innerWidth);
    expect(m.popover.top).toBeGreaterThanOrEqual(0);
    expect(m.popover.bottom).toBeLessThanOrEqual(m.innerHeight);
    expect(m.field.width).toBeGreaterThanOrEqual(220);
    expect(m.field.value).toMatch(/^[A-Z]+′? - end$/);
    expect(m.field.selection).toEqual([0, m.field.value.length]);
    expect(m.field.focused).toBe(true);
    // Anchored to the band: right above it, overlapping it horizontally.
    expect(m.popover.bottom).toBeLessThanOrEqual(m.band.top);
    expect(m.band.top - m.popover.bottom).toBeLessThan(12);
    expect(m.popover.left).toBeLessThan(m.band.right);
    expect(m.popover.right).toBeGreaterThan(m.band.left);
    // The list: the distinct labels, renamed ones included, in order of first appearance.
    const texts = m.rows.map((r) => r.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.indexOf("Verse - first")).toBeLessThan(texts.indexOf("Bridge"));
    expect(texts).toContain(m.field.value);
    for (const r of m.rows) {
      expect(r.box.left).toBeGreaterThanOrEqual(m.popover.left);
      expect(r.box.right).toBeLessThanOrEqual(m.popover.right);
    }
  });
  it("a row the pointer hovers is only highlighted: Enter and Apply take the typed text (review I1)", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const p = cannedStructurePayload({ snap: false, audioUrl: silentWav() });
    const page = await chrome.get(ctx).open(p, ...DIALOG_SIZE.structure);
    const label = (i: number) => page.eval<string>(`document.querySelectorAll(".band")[${i}].title.split("\\n")[0]`);
    const rowCount = () => page.eval<number>(`document.querySelectorAll(".rename [role=option]").length`);
    const open = async (i: number) => {
      const c = await page.centre(".band", i);
      await page.dblclick(c.x, c.y);
      await page.selectAll();
    };
    // Type, then the pointer comes to rest on a row: Enter commits the text.
    await open(2);
    await page.type("chorus"); // lists every chorus label without being one
    expect(await rowCount()).toBeGreaterThan(0);
    const row = await page.centre(".rename [role=option]", 0);
    await page.move(row.x, row.y);
    expect(await page.eval<boolean>(`document.querySelector(".rename [role=option]").matches(":hover")`)).toBe(true);
    await page.key("Enter");
    expect(await label(2)).toBe("chorus");
    // Hover a row first, then type: Enter commits the text.
    await open(3);
    const first = await page.centre(".rename [role=option]", 0);
    await page.move(first.x, first.y);
    await page.type("verse");
    const again = await page.centre(".rename [role=option]", 0);
    await page.move(again.x, again.y);
    await page.key("Enter");
    expect(await label(3)).toBe("verse");
    // Scenario 2 of the review: type, then cross the list on the way to Apply.
    await open(5);
    await page.type("chorus");
    const over = await page.centre(".rename [role=option]", 0);
    await page.move(over.x, over.y);
    const apply = await page.centre(".actions button", 1);
    await page.click(apply.x, apply.y);
    await page.settle(100);
    const sent = await page.sent<{ action: string; sections: { label: string }[] }>();
    await page.close();
    expect(sent).toHaveLength(1);
    expect(sent[0].sections.map((s) => s.label).slice(2, 6)).toEqual(["chorus", "verse", expect.any(String), "chorus"]);
  });

  it("a pattern cell named after another pattern joins it alone, in that one's colour; the rest stay (Matt, 2026-11-12)", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const page = await chrome.get(ctx).open(cannedStructurePayload({ audioUrl: silentWav() }), ...DIALOG_SIZE.structure);
    const cells = () =>
      page.eval<{ title: string; background: string }[]>(
        `[].map.call(document.querySelectorAll(".lane[data-source=bass] .cell"), function (c) { return { title: c.title.split("\\n")[0], background: getComputedStyle(c).backgroundColor }; })`,
      );
    const rename = async (i: number, name: string) => {
      await page.eval(`(function () {
        var c = document.querySelectorAll(".lane[data-source=bass] .cell")[${i}], r = c.getBoundingClientRect();
        c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2 }));
      })()`);
      await page.settle(50);
      const at = await page.centre(".send-menu button.title", 0); // the menu's title renames
      await page.click(at.x, at.y);
      await page.settle(50);
      await page.selectAll();
      await page.type(name);
      await page.key("Enter");
      await page.settle(50);
    };
    const before = await cells();
    const one = before.find((c) => c.title === "bass: 1")!;
    const two = before.findIndex((c) => c.title === "bass: 2");
    const three = before.findIndex((c) => c.title === "bass: 3");
    expect(one.background).not.toBe(before[two].background);
    await rename(two, "1");
    const after = await cells();
    await page.close();

    expect(after[two].title).toBe("bass: 1");
    expect(after[two].background).toBe(one.background);
    // A name in use reassigns just that cell (it renamed the whole pattern until 2026-11-12): 3 keeps its number and colour.
    expect(after[three].title).toBe("bass: 3");
    expect(after[three].background).toBe(before[three].background);
  });
});
