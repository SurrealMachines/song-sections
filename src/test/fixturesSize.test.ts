import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures", "structure");

function total(dir: string): number {
  let sum = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    sum += e.isDirectory() ? total(p) : statSync(p).size;
  }
  return sum;
}

describe("committed structure fixtures", () => {
  it("total at most 2 MB (R1)", () => {
    expect(total(root)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
