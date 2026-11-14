import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABOUT_LINKS, aboutLinkUrl, VERSION } from "./about.js";

describe("About", () => {
  it("shows the version in manifest.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync("manifest.json", "utf8")).version);
  });

  it("names only its own https links, and nothing for any other key", () => {
    for (const url of Object.values(ABOUT_LINKS)) expect(url).toMatch(/^https:\/\//);
    expect(aboutLinkUrl("feedback")).toBe(ABOUT_LINKS.feedback);
    for (const key of ["", "toString", "__proto__", "constructor", "https://example.com", "../feedback"]) expect(aboutLinkUrl(key)).toBeNull();
  });
});
