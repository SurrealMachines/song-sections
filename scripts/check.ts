// svelte-check over src/dialog with a bundler-resolution tsconfig (tsconfig.check.json), which is how esbuild resolves it.
// The Patchbay packages ship .ts with extensionless re-exports that "nodenext" cannot resolve; under nodenext their prop
// types silently become `any` and a bad prop passes. With bundler resolution they resolve, so nothing is filtered:
// any diagnostic at all, including inside node_modules, fails the check. src/dialog/typeCanary.svelte guards the strictness.
// Usage: npm run check
import { spawnSync } from "node:child_process";

const run = spawnSync("npx", ["svelte-check", "--tsconfig", "./tsconfig.check.json", "--output", "machine"], {
  encoding: "utf8",
  shell: process.platform === "win32", // npx is npx.cmd on Windows
});
if (run.error) throw run.error;

let errors = 0;
let warnings = 0;
for (const line of run.stdout.split("\n")) {
  const m = line.match(/^\d+ (ERROR|WARNING) "([^"]*)" (\d+:\d+) (.*)$/);
  if (!m) continue;
  const [, level, file, pos, msg] = m;
  console.log(`${level} ${file}:${pos} ${msg}`);
  if (level === "ERROR") errors++;
  else warnings++;
}
const done = run.stdout.match(/COMPLETED \d+ FILES (\d+) ERRORS (\d+) WARNINGS/);
if (!done || Number(done[1]) !== errors || Number(done[2]) !== warnings) {
  // svelte-check crashed or printed something we did not parse: do not report a clean pass.
  console.error(run.stdout + run.stderr);
  process.exit(run.status || 1);
}
console.log(`svelte-check: ${errors} errors, ${warnings} warnings`);
process.exit(errors > 0 ? 1 : 0);
