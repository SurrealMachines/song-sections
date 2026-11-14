// fb2 review M4: on Windows, Defender or the indexer often holds a freshly closed file, so renaming the stem folder
// into place fails for a moment with EPERM or EBUSY. The commit retries, and when it still cannot, it keeps the older
// stems rather than lose both. Here rename is wrapped to fail like that.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STEM_NAMES } from "./contract.js";

const failures = vi.hoisted(() => ({ to: "", left: 0, code: "EPERM", attempts: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (to === failures.to) failures.attempts++;
      if (to === failures.to && failures.left > 0) {
        failures.left--;
        throw Object.assign(new Error(`${failures.code}: operation not permitted, rename '${from}' -> '${to}'`), { code: failures.code });
      }
      return real.rename(from, to);
    },
  };
});

const { createAuditionWriter, RENAME_RETRY_MS } = await import("./audition.js");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  failures.to = "";
  failures.left = 0;
  failures.code = "EPERM";
  failures.attempts = 0;
});

async function written(final: string) {
  const w = createAuditionWriter(final, 0, () => undefined);
  for (const stem of STEM_NAMES) {
    await w.begin(stem, 10);
    await w.write(stem, new Float32Array(10), new Float32Array(10), 0);
  }
  return w;
}

function oldFolder() {
  const root = mkdtempSync(join(tmpdir(), "ss-audition-retry-"));
  temps.push(root);
  const final = join(root, "k");
  mkdirSync(final);
  for (const s of STEM_NAMES) writeFileSync(join(final, `${s}.wav`), "old");
  return { root, final };
}

describe("committing the stem folder while Windows holds a file (fb2 review M4)", () => {
  it("retries a rename that fails for a moment with EPERM or EBUSY", async () => {
    for (const code of ["EPERM", "EBUSY"]) {
      const { root, final } = oldFolder();
      const w = await written(final);
      Object.assign(failures, { to: final, left: 2, code });
      expect(await w.commit()).toBe(true);
      expect(failures.left).toBe(0);
      expect(readFileSync(join(final, "drums.wav")).length).toBe(44 + 40);
      expect(readdirSync(root)).toEqual(["k"]);
    }
  });

  it("when it keeps failing, commits nothing and puts the older stems back", async () => {
    const { root, final } = oldFolder();
    const w = await written(final);
    Object.assign(failures, { to: final, left: RENAME_RETRY_MS.length + 1 });
    expect(await w.commit()).toBe(false);
    expect(failures.attempts).toBe(RENAME_RETRY_MS.length + 2); // every try, then the older folder back
    expect(readFileSync(join(final, "drums.wav"), "utf8")).toBe("old");
    expect(readdirSync(root)).toEqual(["k"]); // no temp or aside folder left
  });

  it("does not retry other errors", async () => {
    const { final } = oldFolder();
    const w = await written(final);
    Object.assign(failures, { to: final, left: 1, code: "ENOSPC" });
    expect(await w.commit()).toBe(false);
    expect(failures.attempts).toBe(2); // the temp folder in, then the older one back
    expect(existsSync(join(final, "drums.wav"))).toBe(true);
  });
});
