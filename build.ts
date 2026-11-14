import * as esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertBundleCompiles, wrapBundle } from "./src/sandboxGlobals.js";
import { isShippedNativeFile } from "./src/structure/nativeFiles.js";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

// Pass 1: bundle the Svelte dialog and inline it into a single HTML file.
const dialog = await esbuild.build({
  entryPoints: ["src/dialog/main.ts"],
  outdir: "build",
  write: false,
  bundle: true,
  format: "iife",
  platform: "browser",
  plugins: [sveltePlugin()],
  conditions: ["svelte", "browser"],
  logLevel: "info",
  minify: production,
  define: { __DEV__: String(!production) },
});

const js = dialog.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
const css = dialog.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
// Function replacers avoid "$&"-style patterns in the bundle being interpreted.
const html = fs
  .readFileSync("src/dialog/index.html", "utf8")
  .replace("<!--STYLE-->", () => css)
  .replace("<!--BUNDLE-->", () => js.replace(/<\/script/gi, "<\\/script"));
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/dialog.html", html);

// Pass 2: the extension itself, with the dialog HTML importable as text.
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  define: { __DEV__: String(!production) },
  // The host's own V8 context makes global lookups slow; bind the builtins locally (src/sandboxGlobals.ts).
  banner: { js: wrapBundle().banner },
  footer: { js: wrapBundle().footer },
});
// The wrap makes the bundle one function body: a stray redeclaration would only show up when Live loads it.
assertBundleCompiles(fs.readFileSync(manifest.entry, "utf8"), manifest.entry);

// Pass 3: ONNX Runtime for Node, copied next to dist/ because the host does not resolve node_modules
// at runtime (src/structure/runtime.ts copies native/ into the storage directory on first use and loads it
// from there). One package for Mac and Windows: the binaries for every target ship (default: Apple Silicon and
// Windows x64; override with --ort-target=<platform>-<arch>[,<platform>-<arch>...]), onnxruntime-node picks this
// machine's at load, and runtime.ts copies only that one into storage. Only CPU files (src/structure/nativeFiles.ts).
// onnxruntime-node ships no darwin-x64 binary: that target fails here.
const ortTargets = (process.argv.find((a) => a.startsWith("--ort-target="))?.slice("--ort-target=".length) ??
  "darwin-arm64,win32-x64").split(",");
const binDirs = ortTargets.map((t) => {
  const [targetPlatform, targetArch] = t.split("-");
  const binDir = path.join("bin", "napi-v6", targetPlatform, targetArch);
  if (!fs.existsSync(path.join("node_modules", "onnxruntime-node", binDir))) {
    throw new Error(`onnxruntime-node ships no binary for ${targetPlatform}-${targetArch} (${binDir})`);
  }
  return binDir;
});
// Build next to the final place and swap, so a failed copy never leaves a partial native/.
const staging = "native.tmp";
const nativeModules = path.join(staging, "node_modules");
fs.rmSync(staging, { recursive: true, force: true });
const copy = (from: string, to: string) => fs.cpSync(from, to, { recursive: true, filter: isShippedNativeFile });
for (const pkg of ["onnxruntime-node", "onnxruntime-common"]) {
  const from = path.join("node_modules", pkg);
  const to = path.join(nativeModules, pkg);
  for (const entry of ["package.json", "dist", "lib"]) copy(path.join(from, entry), path.join(to, entry));
}
for (const binDir of binDirs) {
  copy(path.join("node_modules", "onnxruntime-node", binDir), path.join(nativeModules, "onnxruntime-node", binDir));
}
fs.writeFileSync(path.join(staging, "package.json"), '{"private":true}\n');
fs.rmSync("native", { recursive: true, force: true });
fs.renameSync(staging, "native");
