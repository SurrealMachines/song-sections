import { Script } from "node:vm";

// Live's extension host runs dist/extension.js inside its own V8 context. There, every lookup of a global
// (`Math`, `Float32Array`, `Infinity`, …) goes through the context's global object, which is much slower than a
// normal global: a DSP loop measured 46x slower (5935 ms vs 128 ms, Live's host node, fresh vm context vs main realm;
// Task 9 report). Binding the builtins as locals once, around the whole bundle, removes that cost. The bindings are
// the sandbox's own objects, so realm behaviour (runtime.ts's hostFloat32 etc.) is unchanged.
//
// Only ECMAScript builtins, which every V8 context has: nothing host-provided (timers, Buffer, process) that a
// host might install late or not at all.
export const SANDBOX_GLOBALS = [
  "Math", "Number", "Object", "Array", "String", "Boolean", "Symbol", "BigInt", "JSON", "Reflect", "Date", "RegExp",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError",
  "ArrayBuffer", "DataView", "Float32Array", "Float64Array", "Int8Array", "Int16Array", "Int32Array",
  "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "BigInt64Array", "BigUint64Array",
  "Infinity", "NaN", "undefined", "isFinite", "isNaN", "parseInt", "parseFloat",
] as const;

/**
 * esbuild banner/footer: SANDBOX_GLOBALS are bound as constants in an outer strict function, and the bundle runs in
 * an inner one. The bundle's own top-level declarations live in the inner scope, so one named like a bound builtin
 * (an old `function isNaN` polyfill, `var undefined`) shadows it exactly as it would shadow the global without the
 * wrap, instead of being a redeclaration SyntaxError that stops the extension loading (Task 9 review M1).
 * Closure-slot lookups from the inner function are as fast as locals.
 */
export function wrapBundle(): { banner: string; footer: string } {
  return {
    banner: `(function () {\n"use strict";\nconst { ${SANDBOX_GLOBALS.join(", ")} } = globalThis;\n(function () {`,
    footer: "})();\n})();",
  };
}

/** build.ts: compiles the finished bundle once, so anything that would fail to load in Live fails the build instead. */
export function assertBundleCompiles(code: string, filename: string): void {
  try {
    new Script(code, { filename });
  } catch (error) {
    throw new Error(`${filename} does not compile, so Live could not load it: ${(error as Error).message}`, { cause: error });
  }
}
