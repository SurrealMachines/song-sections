// Matt, 2026-11-12: the band menu's color swatches in headless Chrome at the real dialog size. The menu, now taller,
// stays inside the dialog, its swatch rows fit its width, and a real click on a swatch colors every band of that
// name and closes the menu. SONG_SECTIONS_SCREENSHOT=<path.png> also saves a screenshot of it.
import { describe, expect, it } from "vitest";
import { CHROME, CHROME_TEST_TIMEOUT, silentWav, useChromeDialog } from "../test/chromeDialog.js";
import { STEM_NAMES, type StemName } from "../structure/contract.js";
import { cannedStructurePayload } from "./fixture.js";
import { DIALOG_SIZE } from "./protocol.js";
import { createStructureState } from "./structureState.js";

const chrome = useChromeDialog();

/** Polls `expr` until it is true (or 3 s pass): a fixed wait was too short under a full parallel run. */
async function until(page: { eval<T>(e: string): Promise<T>; settle(ms?: number): Promise<void> }, expr: string): Promise<void> {
  for (let t = 0; t < 3000; t += 50) {
    if (await page.eval<boolean>(expr)) return;
    await page.settle(50);
  }
  throw new Error(`timed out waiting for ${expr}`);
}
const MENU_OPEN = `document.querySelector(".send-menu") !== null`;
const MENU_CLOSED = `document.querySelector(".send-menu") === null`;

interface Probe {
  innerWidth: number;
  innerHeight: number;
  menu: { left: number; right: number; top: number; bottom: number };
  rows: { scrollWidth: number; clientWidth: number }[];
  bands: string[];
  pressed: number;
}

const PROBE = `(function () {
  var m = document.querySelector(".send-menu").getBoundingClientRect();
  return {
    innerWidth: innerWidth, innerHeight: innerHeight,
    menu: { left: m.left, right: m.right, top: m.top, bottom: m.bottom },
    rows: [].map.call(document.querySelectorAll(".send-menu .swatch-row"), function (r) { return { scrollWidth: r.scrollWidth, clientWidth: r.clientWidth }; }),
    bands: [].map.call(document.querySelectorAll(".band"), function (b) { return getComputedStyle(b).backgroundColor; }),
    pressed: document.querySelectorAll(".send-menu .swatch[aria-pressed=true]").length
  };
})()`;

describe.skipIf(!CHROME)("the band menu's color swatches at the real dialog size (Matt, 2026-11-12; headless Chrome)", () => {
  it("opens inside the dialog on the last band, and a swatch colors every band of its name", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const p = cannedStructurePayload({ snap: false, colorMode: "soft", audioUrl: silentWav() });
    const labels = createStructureState(p).sections().map((x) => x.label);
    const i = labels.findIndex((l, k) => labels.indexOf(l) !== k); // a band whose name another band shares
    const same = labels.flatMap((l, k) => (l === labels[i] ? [k] : []));
    const page = await chrome.get(ctx).open(p, ...DIALOG_SIZE.structure);
    const last = labels.length - 1;
    // A right-click: the page opens its menu on the band's contextmenu event, at the pointer.
    const open = async (k: number) => {
      const c = await page.centre(".band", k);
      await page.eval(
        `document.querySelectorAll(".band")[${k}].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${c.x}, clientY: ${c.y} }))`,
      );
      await until(page, MENU_OPEN);
    };
    await open(last);
    const atEdge = await page.eval<Probe>(PROBE);
    expect(atEdge.menu.right).toBeLessThanOrEqual(atEdge.innerWidth);
    expect(atEdge.menu.bottom).toBeLessThanOrEqual(atEdge.innerHeight);
    expect(atEdge.menu.top).toBeGreaterThanOrEqual(0);
    for (const r of atEdge.rows) expect(r.scrollWidth).toBeLessThanOrEqual(r.clientWidth);
    await page.key("Escape");
    await until(page, MENU_CLOSED);

    await open(i);
    const before = (await page.eval<Probe>(PROBE)).bands;
    const pick = await page.centre(".send-menu .others .swatch", 6);
    await page.click(pick.x, pick.y);
    await until(page, MENU_CLOSED);
    const after = { bands: await page.eval<string[]>(`[].map.call(document.querySelectorAll(".band"), function (b) { return getComputedStyle(b).backgroundColor; })`) };
    const picked = after.bands[i];
    expect(picked).not.toBe(before[i]);
    for (const k of same) expect(after.bands[k], labels[k]).toBe(picked);
    after.bands.forEach((b, k) => same.includes(k) || expect(b, labels[k]).toBe(before[k]));
    if (process.env.SONG_SECTIONS_SCREENSHOT) await page.screenshot(process.env.SONG_SECTIONS_SCREENSHOT);
    await page.close();
  });

  it("a pattern cell's menu at the bottom right stays inside the dialog, and a pick colors that pattern's cells", { timeout: CHROME_TEST_TIMEOUT }, async (ctx) => {
    const urls = Object.fromEntries(STEM_NAMES.map((s) => [s, `stems/${s}.wav`])) as Record<StemName, string>;
    const p = cannedStructurePayload({ snap: false, colorMode: "soft", audioUrl: silentWav(), stemUrls: urls });
    const s = createStructureState(p);
    const src = s.patternSources.at(-1)!;
    const cells = s.patternLanes()[src]!;
    const k = cells.findLastIndex((c) => !c.rest);
    const same = cells.flatMap((c, i) => (!c.rest && c.label === cells[k].label ? [i] : []));
    const page = await chrome.get(ctx).open(p, ...DIALOG_SIZE.structure);
    const sel = `.lane[data-source=${src}] .cell`;
    const c = await page.centre(sel, k);
    await page.eval(
      `document.querySelectorAll("${sel}")[${k}].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${c.x}, clientY: ${c.y} }))`,
    );
    await until(page, MENU_OPEN);
    const m = await page.eval<Probe>(PROBE);
    expect(m.menu.right).toBeLessThanOrEqual(m.innerWidth);
    expect(m.menu.bottom).toBeLessThanOrEqual(m.innerHeight);
    expect(m.menu.top).toBeGreaterThanOrEqual(0);
    const read = () => page.eval<string[]>(`[].map.call(document.querySelectorAll("${sel}"), function (e) { return getComputedStyle(e).backgroundColor; })`);
    const before = await read();
    const pick = await page.centre(".send-menu .others .swatch", 4); // lime: no pattern's automatic color
    await page.click(pick.x, pick.y);
    await until(page, MENU_CLOSED);
    const colors = await read();
    expect(colors[k]).not.toBe(before[k]);
    colors.forEach((col, i) => expect(col, `${src} ${i}`).toBe(same.includes(i) ? colors[k] : before[i]));
    if (process.env.SONG_SECTIONS_SCREENSHOT_LANE) await page.screenshot(process.env.SONG_SECTIONS_SCREENSHOT_LANE);
    await page.close();
  });
});
