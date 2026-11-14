import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInContext, createContext, runInThisContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertBundleCompiles, SANDBOX_GLOBALS, wrapBundle } from "./sandboxGlobals.js";

const hot = `
  const n = 300000; const a = new Float32Array(n); let s = 0;
  for (let r = 0; r < 5; r++) for (let i = 0; i < n; i++) { a[i] = Math.fround(Math.exp(-i * 1e-6)); s += Math.max(a[i], -Infinity); }
  module.exports.sum = s;`;

describe("wrapBundle (Live's host runs the extension in its own vm context)", () => {
  it("binds the hot builtins locally and keeps module.exports, require and strict mode working", () => {
    const { banner, footer } = wrapBundle();
    const module = { exports: {} as Record<string, unknown> };
    const ctx = createContext({ module, require: () => 42, setTimeout, clearTimeout, console, process, Buffer });
    runInContext(`${banner}\nmodule.exports.req = require("x"); module.exports.strict = (function () { return this; })() === undefined; module.exports.same = Math === globalThis.Math && Float32Array === globalThis.Float32Array;\n${footer}`, ctx);
    expect(module.exports).toEqual({ req: 42, strict: true, same: true });
  });

  it("a bundle that declares a bound name at its top level still loads, and its own declaration wins (review M1)", () => {
    const { banner, footer } = wrapBundle();
    const module = { exports: {} as Record<string, unknown> };
    const code = `${banner}\nfunction isNaN() { return "polyfill"; }\nvar undefined;\nconst NaN = 7;\nlet Date = "d";\nmodule.exports.v = [isNaN(), NaN, Date, Math.max(1, 2)];\n${footer}`;
    assertBundleCompiles(code, "bundle.js");
    runInContext(code, createContext({ module }));
    expect(module.exports.v).toEqual(["polyfill", 7, "d", 2]);
  });

  it("assertBundleCompiles fails the build on a bundle that would not load, naming the file", () => {
    const { banner, footer } = wrapBundle();
    expect(() => assertBundleCompiles(`${banner}\nlet a = 1;\nlet a = 2;\n${footer}`, "dist/extension.js")).toThrow(/dist\/extension\.js.*already been declared/s);
  });

  it("lists only builtins the host sandbox has (no DOMException, setImmediate, queueMicrotask, performance)", () => {
    for (const name of ["DOMException", "setImmediate", "queueMicrotask", "performance", "structuredClone", "TextDecoder", "URL", "AbortSignal"]) {
      expect(SANDBOX_GLOBALS).not.toContain(name);
    }
    for (const name of ["Math", "Float32Array", "Float64Array", "Int16Array", "Uint8Array", "Infinity", "NaN"]) expect(SANDBOX_GLOBALS).toContain(name);
  });

  // Measured with Live's host node: 5935 ms in a fresh context vs 128 ms in the main realm for the same loop.
  it.skipIf(!process.env.SONG_SECTIONS_PERF)("makes a hot loop in a fresh vm context run at main-realm speed", () => {
    const { banner, footer } = wrapBundle();
    const time = (run: () => void) => {
      const t = Date.now();
      run();
      return Date.now() - t;
    };
    const main = time(() => runInThisContext(`(function (module) {${hot}})({ exports: {} })`));
    const bare = time(() => runInContext(hot, createContext({ module: { exports: {} } })));
    const wrapped = time(() => runInContext(`${banner}\n${hot}\n${footer}`, createContext({ module: { exports: {} } })));
    console.log(`hot loop: main ${main} ms, fresh context ${bare} ms, wrapped ${wrapped} ms`);
    expect(bare).toBeGreaterThan(5 * wrapped);
    expect(wrapped).toBeLessThan(3 * main + 20);
  });
});

// The host-path guard. Live's host lacks globals that Node has (docs/structure-engine-findings.md, "Missing globals",
// and btoa/atob, b9c698c), but the tests run in Node, so a use of one passes every test and fails only in Live ("btoa
// is not defined"). This reads the source of everything src/extension.ts reaches (what dist/extension.js is bundled
// from) and flags a free use of them. `Buffer` is present in the host (the findings doc), so it is not forbidden; the
// unit tests below use it to check that an imported name (from "node:buffer") counts as a module, not a global.
const SRC = dirname(fileURLToPath(import.meta.url));

/** Every .ts file of src/ that `entry` imports, directly or not (type imports included: they cost nothing to follow). */
function reachableSources(entry: string): string[] {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
      if (target.endsWith(".ts") && existsSync(target)) todo.push(target);
    }
  }
  return [...seen].sort();
}

/** Free uses (not declared, not imported, not a property name, not a type) of any of `names` in `file`, as "path:line name". */
function globalUses(file: string, names: ReadonlySet<string>, text = readFileSync(file, "utf8")): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imported = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) imported.add(c.name.text);
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) imported.add(c.namedBindings.name.text);
        else for (const e of c.namedBindings.elements) imported.add(e.name.text);
      }
    }
  }
  const found: string[] = [];
  const report = (node: ts.Node, name: string) => found.push(`${relative(join(SRC, ".."), file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && !imported.has(node.text)) {
      const p = node.parent;
      const isName =
        ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (ts.isQualifiedName(p) ? p.right : p.name) === node) ||
        ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) && p.name === node) ||
        ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p)) && p.name === node);
      if (!isName && !ts.isTypeNode(p)) report(node, node.text);
    }
    // globalThis.btoa / globalThis["btoa"] are the same global.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "globalThis" && names.has(node.name.text)) report(node, `globalThis.${node.name.text}`);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      names.has(node.argumentExpression.text)
    ) {
      report(node, `globalThis["${node.argumentExpression.text}"]`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("host path uses no global that Live's host lacks", () => {
  const files = reachableSources(join(SRC, "extension.ts"));
  /** docs/structure-engine-findings.md, "Missing globals" (checked in Live's host with `typeof`), and btoa/atob. */
  const FORBIDDEN = new Set([
    "performance",
    "AbortSignal",
    "DOMException",
    "structuredClone",
    "setImmediate",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "queueMicrotask",
    "Worker",
    "btoa",
    "atob",
  ]);

  it("finds the host path (so a passing guard means something)", () => {
    const rel = files.map((f) => relative(SRC, f).replaceAll("\\", "/"));
    for (const f of ["extension.ts", "flow.ts", "patterns/host.ts", "patterns/contract.ts", "patterns/base64.ts", "patterns/features.ts"]) expect(rel).toContain(f);
    expect(files.length).toBeGreaterThan(40);
    expect(rel.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it("the scanner flags a free btoa/atob/Buffer and ignores look-alikes", () => {
    const names = new Set([...FORBIDDEN, "Buffer"]);
    const uses = (code: string) => globalUses(join(SRC, "probe.ts"), names, code).map((u) => u.split(" ").slice(1).join(" "));
    expect(uses("const a = btoa(x); const b = atob(y); const c = Buffer.from(z);")).toEqual(["btoa", "atob", "Buffer"]);
    expect(uses("const a = globalThis.btoa(x);")).toEqual(["globalThis.btoa"]);
    expect(uses('const a = globalThis["atob"](x); const b = globalThis[\'btoa\'];')).toEqual(['globalThis["atob"]', 'globalThis["btoa"]']);
    expect(uses('const a = globalThis["fetch"]; const b = other["btoa"]; const c = globalThis[name];')).toEqual([]);
    expect(uses('import { Buffer } from "node:buffer"; const c = Buffer.byteLength(z);')).toEqual([]);
    expect(uses("const o = { btoa: 1 }; o.btoa; x.Buffer; type T = Buffer; // btoa(x)\nconst s = 'atob(x)';")).toEqual([]);
  });

  it("the scanner flags every global the findings doc lists as missing, and an imported one only as a module", () => {
    const uses = (code: string) => globalUses(join(SRC, "probe.ts"), FORBIDDEN, code).map((u) => u.split(" ").slice(1).join(" "));
    const free = [...FORBIDDEN].map((n) => `void ${n};`).join(" ");
    expect(uses(free)).toEqual([...FORBIDDEN]);
    expect(uses("const t = performance.now(); const e = new DOMException(m, \"AbortError\"); queueMicrotask(f); const s = AbortSignal.timeout(5);")).toEqual([
      "performance",
      "DOMException",
      "queueMicrotask",
      "AbortSignal",
    ]);
    expect(uses('const u = globalThis["URL"]; const c = globalThis.structuredClone;')).toEqual(['globalThis["URL"]', "globalThis.structuredClone"]);
    expect(uses('import { performance } from "node:perf_hooks"; const t = performance.now(); function f(s: AbortSignal): URL { return s as never; }')).toEqual([]);
  });

  it("none of them appears in it (use patterns/base64.ts, core/abort.ts, node:perf_hooks, Buffer for text)", () => {
    expect(files.flatMap((f) => globalUses(f, FORBIDDEN))).toEqual([]);
  });
});

describe("host code and Live's extension context", () => {
  // Live's extension host runs dist/extension.js in a vm context holding only these host globals (read from Live
  // 12.4.25b1's ExtensionHostNodeModule.node), next to the ECMAScript builtins every context has. Anything else that
  // Node normally provides as a global, such as URL or URLSearchParams, is undefined there and must be imported from
  // its node: module. 1.0.7's About links used the URLSearchParams global, which crashed the host on the first click.
  const LIVE_HOST_GLOBALS = [
    "require", "module", "__dirname", "__filename", "console", "setInterval", "clearInterval", "setTimeout",
    "clearTimeout", "process", "fetch", "performance", "AbortController", "AbortSignal", "Buffer", "FormData",
    "Headers", "Request", "Response",
  ];
  const NODE_ONLY_GLOBALS = [
    "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "setImmediate", "clearImmediate", "queueMicrotask",
    "structuredClone", "atob", "btoa", "Blob", "File", "crypto", "navigator", "EventTarget", "Event",
    "MessageChannel", "BroadcastChannel", "WebSocket", "global",
  ];

  function hostSources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "dialog" || e.name === "test" ? [] : hostSources(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
    });
  }

  /** The code without comments and string contents, so only identifiers are left to match. */
  function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, " ");
  }

  it("uses none of the Node globals that the context lacks, unless the file imports it", () => {
    expect(NODE_ONLY_GLOBALS.filter((g) => LIVE_HOST_GLOBALS.includes(g))).toEqual([]);
    const srcDir = join(dirname(fileURLToPath(import.meta.url)));
    const found: string[] = [];
    for (const file of hostSources(srcDir)) {
      const src = readFileSync(file, "utf8");
      const code = codeOnly(src);
      for (const g of NODE_ONLY_GLOBALS) {
        if (!new RegExp(`(?<![.\\w$])${g}(?![\\w$])(?!\\s*:)`).test(code)) continue;
        if (new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${g}\\b[^}]*\\}\\s*from`).test(src)) continue;
        found.push(`${relative(srcDir, file)}: ${g}`);
      }
    }
    expect(found).toEqual([]);
  });
});
