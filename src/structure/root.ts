import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The extension's install root: the nearest directory at or above `__dirname` that holds `manifest.json`
 * (the repo root under vitest and tsx, where `__dirname` is `src/structure`; the folder beside `dist/` in the
 * bundle). When `__dirname` is unavailable it starts from the working directory; when no manifest is found it
 * falls back to `__dirname/..`, the layout of the bundled `dist/extension.js`.
 */
export function extensionRoot(): string {
  const start = typeof __dirname === "string" ? __dirname : process.cwd();
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "manifest.json"))) return dir;
    if (dirname(dir) === dir) break;
  }
  return typeof __dirname === "string" ? resolve(__dirname, "..") : process.cwd();
}
