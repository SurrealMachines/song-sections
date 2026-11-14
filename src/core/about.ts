// What the dialog's About panel shows, and the only links it can ask the extension to open (no Node imports: the dialog
// bundles this file). The extension opens a link by its key alone, so a page can never make it open any other URL.

/** The extension's version. about.test.ts checks it against manifest.json, so a release that bumps one bumps both. */
export const VERSION = "1.0.7";

export const ABOUT_LINKS = {
  feedback: "https://docs.google.com/forms/d/e/1FAIpQLScd59zbcMcl8Dl9BZDT43lXCc9pzAbiyHYqAKSDAzRwxMbHxg/viewform",
  page: "https://www.surrealmachines.com/song-sections/",
  source: "https://github.com/SurrealMachines/song-sections",
  labs: "https://www.surrealmachines.com/labs/",
} as const;

export type AboutLink = keyof typeof ABOUT_LINKS;

/** The URL for `key`, or null when it names no About link. */
export function aboutLinkUrl(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(ABOUT_LINKS, key) ? ABOUT_LINKS[key as AboutLink] : null;
}

/** The dialog server's route for opening an About link, next to the page: `open?to=<key>`. */
export const OPEN_LINK_ROUTE = "open";
