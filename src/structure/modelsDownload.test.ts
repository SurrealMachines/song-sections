// ensureModels downloads only from a local http server on 127.0.0.1 started inside each test (or a fake fetch). No
// other network. Each test gets a miniature package: a weight map over two real checkpoints (a 300 kB safetensors made
// here and the lightning.pth fixture), two graphs (arbitrary bytes) and the .weights checksums.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnsureModels, ModelsPhase } from "./contract.js";
import {
  ModelChecksumError,
  ModelsDiskSpaceError,
  ModelsUnavailableError,
  ensureModels,
  modelDir,
  modelsInstalled,
  sourcesDir,
  type DownloadOptions,
  type ModelFile,
  type SourceFile,
} from "./models.js";
import type { WeightMap } from "./weights/weightMap.js";

const FIX = join(__dirname, "..", "..", "fixtures", "hfmodels");
const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

interface ServeOptions {
  /** Answer /<repo>/resolve/<rev>/<file> with a 302 to /cdn/<file> (as huggingface.co does). Default true. */
  redirect?: boolean;
  /** Honour `Range: bytes=N-` with 206; otherwise always 200 with the whole file. */
  range?: boolean;
  /** Per file: how many of the first responses carry one flipped byte. */
  corrupt?: Record<string, number>;
  /** Per file: send this many bytes, then hold the connection open until the client goes away. */
  stallAfter?: Record<string, number>;
  /** Per file: HTTP status to answer with instead of the file. */
  status?: Record<string, number>;
  /** Per file: append this many extra bytes. */
  extra?: Record<string, number>;
  /** Redirect to this base URL's /cdn/ (another server: another origin, as huggingface.co to its CDN). */
  redirectTo?: string;
}

interface Local {
  baseUrl: string;
  /** The requests that reached the file (after any redirect). */
  requests: { name: string; headers: IncomingHttpHeaders }[];
  redirects: number;
  server: Server;
}

let root: string;
let storage: string;
let pkg: string;
let sources: SourceFile[];
let files: ModelFile[];
let blobs: Map<string, Buffer>;
let weightsTotal: number;
let local: Local | undefined;
/** Other servers a test starts (a CDN on another origin); closed after each test. */
const others: Local[] = [];

function serve(opts: ServeOptions = {}): Promise<Local> {
  const local: Local = { baseUrl: "", requests: [], redirects: 0, server: undefined as unknown as Server };
  const served = new Map<string, number>();
  local.server = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? "/");
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]+)\/(.+)$/.exec(path);
    if (resolve && opts.redirect !== false) {
      local.redirects++;
      res.writeHead(302, { location: `${opts.redirectTo ?? "/"}cdn/${encodeURIComponent(resolve[3])}?sig=x` }).end();
      return;
    }
    const name = resolve ? resolve[3] : (/^\/cdn\/([^?]+)/.exec(path)?.[1] ?? "");
    local.requests.push({ name, headers: req.headers });
    const status = opts.status?.[name];
    const blob = blobs.get(name);
    if (status !== undefined || !blob) {
      res.writeHead(status ?? 404).end("no");
      return;
    }
    const n = (served.get(name) ?? 0) + 1;
    served.set(name, n);
    let body = blob;
    if (n <= (opts.corrupt?.[name] ?? 0)) {
      body = Buffer.from(blob);
      body[Math.floor(body.length / 2)] ^= 0xff;
    }
    if (opts.extra?.[name]) body = Buffer.concat([body, Buffer.alloc(opts.extra[name])]);
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
    if (opts.range && m) start = Number(m[1]);
    const part = body.subarray(start);
    const headers: Record<string, string | number> = { "content-length": part.length, "content-type": "application/octet-stream" };
    if (start > 0) headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
    res.writeHead(start > 0 ? 206 : 200, headers);
    const stall = opts.stallAfter?.[name];
    if (stall !== undefined && stall < part.length) {
      res.write(part.subarray(0, stall)); // then never finish
      return;
    }
    res.end(part);
  });
  return new Promise((resolve) =>
    local.server.listen(0, "127.0.0.1", () => {
      const { port } = local.server.address() as AddressInfo;
      local.baseUrl = `http://127.0.0.1:${port}/`;
      resolve(local);
    }),
  );
}

async function restart(opts: ServeOptions = {}) {
  local!.server.closeAllConnections();
  await new Promise((r) => local!.server.close(r));
  local = await serve(opts);
}

/** A safetensors file of one float32 tensor "w" of `n` random values. */
function safetensors(n: number): { file: Buffer; data: Buffer } {
  const values = new Float32Array(n);
  const rnd = randomBytes(n * 2);
  for (let i = 0; i < n; i++) values[i] = (rnd.readUInt16LE(i * 2) - 32768) / 1024;
  const data = Buffer.from(values.buffer);
  const header = Buffer.from(JSON.stringify({ w: { dtype: "F32", shape: [n], data_offsets: [0, data.length] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return { file: Buffer.concat([len, header, data]), data };
}

const f32 = (values: number[]) => Buffer.from(new Float32Array(values).buffer);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "models-dl-"));
  storage = join(root, "storage");
  pkg = join(root, "pkg");
  mkdirSync(pkg);
  const big = safetensors(75_000);
  const pth = readFileSync(join(FIX, "lightning.pth"));
  const expected = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8")).state_dict as Record<string, { values: number[] }>;
  blobs = new Map([
    ["lightning.pth", pth],
    ["big.safetensors", big.file],
  ]);
  sources = [...blobs].map(([file, b], i) => ({ file, repo: `test/repo${i}`, revision: "ab".repeat(20), bytes: b.length, sha256: sha(b) }));
  // one.weights: big "w" at 0, then conv.bias at the next 64-byte boundary. two.weights: the float16 "half" widened.
  const bias = f32(expected["conv.bias"].values);
  const biasAt = Math.ceil(big.data.length / 64) * 64;
  const one = Buffer.concat([big.data, Buffer.alloc(biasAt - big.data.length), bias]);
  const two = f32(expected.half.values);
  const graphs = { "one.onnx": randomBytes(1000), "two.onnx": randomBytes(700) };
  for (const [n, b] of Object.entries(graphs)) writeFileSync(join(pkg, n), b);
  const map: WeightMap = {
    modelSet: "test",
    align: 64,
    sources,
    models: [
      {
        name: "one.onnx",
        v1: { bytes: 0, sha256: "0".repeat(64) },
        graph: { bytes: 1000, sha256: sha(graphs["one.onnx"]) },
        weights: { name: "one.weights", bytes: one.length, sha256: sha(one) },
        tensors: [
          { name: "w", dims: [75_000], offset: 0, length: big.data.length, source: 1, key: "w", dtype: "float32", shape: [75_000] },
          { name: "b", dims: [2], offset: biasAt, length: 8, source: 0, key: "conv.bias", dtype: "float32", shape: [2] },
        ],
      },
      {
        name: "two.onnx",
        v1: { bytes: 0, sha256: "0".repeat(64) },
        graph: { bytes: 700, sha256: sha(graphs["two.onnx"]) },
        weights: { name: "two.weights", bytes: two.length, sha256: sha(two) },
        tensors: [{ name: "h", dims: [6], offset: 0, length: 24, source: 0, key: "half", dtype: "float16", shape: [2, 3] }],
      },
    ],
  };
  writeFileSync(join(pkg, "weightmap.json"), JSON.stringify(map));
  files = map.models.flatMap((m) => [{ name: m.name, ...m.graph }, { ...m.weights }]);
  weightsTotal = one.length + two.length;
});
afterEach(async () => {
  for (const o of others.splice(0)) {
    o.server.closeAllConnections();
    await new Promise((r) => o.server.close(r));
  }
  if (local) {
    local.server.closeAllConnections();
    await new Promise((r) => local!.server.close(r));
    local = undefined;
  }
  rmSync(root, { recursive: true, force: true });
});

const never = new AbortController().signal;
const noop = () => {};
const DOWNLOAD = () => sources.reduce((s, f) => s + f.bytes, 0);

/** The test store, served by `local` (through its redirect unless the server is told otherwise). */
function opts(extra: Partial<DownloadOptions> = {}): DownloadOptions {
  return { sources, files, packagedDir: pkg, urlFor: (s) => `${local!.baseUrl}${s.repo}/resolve/${s.revision}/${s.file}`, ...extra };
}

function installedRight(): boolean {
  return files.every((f) => existsSync(join(modelDir(storage), f.name)) && sha(readFileSync(join(modelDir(storage), f.name))) === f.sha256);
}

describe("ensureModels", () => {
  it("fits the EnsureModels contract", () => {
    const contract: EnsureModels = ensureModels;
    expect(typeof contract).toBe("function");
  });

  it("downloads through the redirect, builds graphs and weights, and deletes the sources", async () => {
    local = await serve();
    const seen: [number, number, ModelsPhase | undefined][] = [];
    const dir = await ensureModels({ storageDir: storage, signal: never, onProgress: (d, t, p) => seen.push([d, t, p]), ...opts() });
    expect(dir).toBe(modelDir(storage));
    expect(installedRight()).toBe(true);
    expect(await modelsInstalled(storage, files)).toBe(true);
    expect(existsSync(sourcesDir(storage))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["installed.json", "one.onnx", "one.weights", "two.onnx", "two.weights"]);
    expect(local.redirects).toBe(2);
    expect(local.requests.map((r) => r.name)).toEqual(["lightning.pth", "big.safetensors"]);

    const download = seen.filter(([, , p]) => p === "download");
    const build = seen.filter(([, , p]) => p === "build");
    expect(seen.map(([, , p]) => p)).toEqual([...download.map(() => "download"), ...build.map(() => "build")]);
    expect(download.every(([, t]) => t === DOWNLOAD())).toBe(true);
    const done = download.map(([d]) => d);
    expect(done).toEqual([...done].sort((x, y) => x - y));
    expect(done.at(-1)).toBe(DOWNLOAD());
    expect(download.length).toBeGreaterThan(2);
    expect(download.length).toBeLessThanOrEqual(103);
    for (let i = 1; i < done.length - 1; i++) expect(done[i] - done[i - 1]).toBeGreaterThanOrEqual(DOWNLOAD() / 100);
    expect(build.at(-1)).toEqual([weightsTotal, weightsTotal, "build"]);
  });

  it("resolves at once when already installed, without fetching", async () => {
    local = await serve();
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() });
    const fetchNever = (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch;
    const seen: [number, number, ModelsPhase | undefined][] = [];
    const dir = await ensureModels({ storageDir: storage, signal: never, onProgress: (d, t, p) => seen.push([d, t, p]), ...opts({ fetch: fetchNever }) });
    expect(dir).toBe(modelDir(storage));
    expect(seen).toEqual([[DOWNLOAD(), DOWNLOAD(), "download"]]);
  });

  it("keeps the .part on abort and resumes with a Range request that survives the redirect", async () => {
    local = await serve({ range: true, stallAfter: { "big.safetensors": 100_000 } });
    const ac = new AbortController();
    const small = blobs.get("lightning.pth")!.length;
    const p = ensureModels({ storageDir: storage, signal: ac.signal, onProgress: (d) => d >= small + 50_000 && ac.abort(), ...opts() });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const part = join(sourcesDir(storage), "big.safetensors.part");
    const kept = statSync(part).size;
    expect(kept).toBeGreaterThanOrEqual(50_000);
    expect(kept).toBeLessThanOrEqual(100_000);
    expect(await modelsInstalled(storage, files)).toBe(false);

    // Review m8: the resume goes through a redirect to another origin (another port), as huggingface.co's to its CDN.
    const cdn = await serve({ range: true });
    others.push(cdn);
    await restart({ range: true, redirectTo: cdn.baseUrl });
    expect(new URL(cdn.baseUrl).origin).not.toBe(new URL(local!.baseUrl).origin);
    const seen: number[] = [];
    await ensureModels({ storageDir: storage, signal: never, onProgress: (d, _t, p) => p === "download" && seen.push(d), ...opts() });
    expect(local!.requests).toHaveLength(0); // the origin only redirects
    expect(local!.redirects).toBe(1); // lightning.pth was already downloaded
    expect(cdn.requests).toHaveLength(1);
    expect(cdn.requests[0].name).toBe("big.safetensors");
    expect(cdn.requests[0].headers.range).toBe(`bytes=${kept}-`);
    expect(installedRight()).toBe(true);
    expect(seen[0]).toBe(small + kept); // the downloaded file and the kept part count from the start
    expect(seen.at(-1)).toBe(DOWNLOAD());
  });

  it("restarts from zero when the server ignores Range (200)", async () => {
    mkdirSync(sourcesDir(storage), { recursive: true });
    writeFileSync(join(sourcesDir(storage), "big.safetensors.part"), blobs.get("big.safetensors")!.subarray(0, 1234));
    local = await serve({ range: false });
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() });
    expect(local.requests.find((r) => r.name === "big.safetensors")!.headers.range).toBe("bytes=1234-");
    // Review m3: once, so the 200 overwrote the part (an append would be a mismatch, and its retry a second request).
    expect(local.requests.filter((r) => r.name === "big.safetensors")).toHaveLength(1);
    expect(installedRight()).toBe(true);
  });

  it("retries a corrupt download once from zero and succeeds", async () => {
    local = await serve({ range: true, corrupt: { "big.safetensors": 1 } });
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() });
    expect(installedRight()).toBe(true);
    const b = local.requests.filter((r) => r.name === "big.safetensors");
    expect(b).toHaveLength(2);
    expect(b[1].headers.range).toBeUndefined();
  });

  it("throws ModelChecksumError when the download is corrupt twice, leaving no .part and building nothing", async () => {
    local = await serve({ corrupt: { "big.safetensors": 2 } });
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).rejects.toBeInstanceOf(ModelChecksumError);
    expect(readdirSync(sourcesDir(storage))).toEqual(["lightning.pth"]); // verified, kept for the retry
    expect(readdirSync(modelDir(storage))).toEqual(["sources"]);
  });

  it("treats a longer response than the file's size as a mismatch", async () => {
    local = await serve({ extra: { "lightning.pth": 10 } });
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).rejects.toBeInstanceOf(ModelChecksumError);
    expect(existsSync(join(sourcesDir(storage), "lightning.pth.part"))).toBe(false);
  });

  it("throws on a 404", async () => {
    local = await serve({ status: { "big.safetensors": 404 } });
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).rejects.toThrow(
      "Model download failed: 404 big.safetensors",
    );
  });

  it("rejects AbortError before any request when already aborted", async () => {
    local = await serve();
    const ac = new AbortController();
    ac.abort();
    await expect(ensureModels({ storageDir: storage, signal: ac.signal, onProgress: noop, ...opts() })).rejects.toMatchObject({ name: "AbortError" });
    expect(local.requests).toHaveLength(0);
  });

  it("fb2 review m5: an abort at the first progress report fetches nothing, and does not rename a full .part", async () => {
    const fetchCount = { n: 0 };
    const fetchNever = (async () => {
      fetchCount.n++;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    mkdirSync(sourcesDir(storage), { recursive: true });
    writeFileSync(join(sourcesDir(storage), "lightning.pth.part"), blobs.get("lightning.pth")!);
    const ac = new AbortController();
    await expect(
      ensureModels({ storageDir: storage, signal: ac.signal, onProgress: () => ac.abort(), ...opts({ fetch: fetchNever, urlFor: () => "http://127.0.0.1:9/" }) }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchCount.n).toBe(0);
    expect(existsSync(join(sourcesDir(storage), "lightning.pth"))).toBe(false);
    expect(existsSync(join(sourcesDir(storage), "lightning.pth.part"))).toBe(true);
  });

  it("gives up on a stalled connection after the idle timeout, keeping the .part", async () => {
    local = await serve({ range: true, stallAfter: { "big.safetensors": 50_000 } });
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ idleTimeoutMs: 200 }) })).rejects.toThrow(
      "Model download stalled: big.safetensors",
    );
    expect(statSync(join(sourcesDir(storage), "big.safetensors.part")).size).toBe(50_000);
  });

  it("an abort while building keeps the downloaded sources; the next call builds without fetching", async () => {
    local = await serve();
    const ac = new AbortController();
    await expect(
      ensureModels({ storageDir: storage, signal: ac.signal, onProgress: (_d, _t, p) => p === "build" && ac.abort(), ...opts() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(readdirSync(sourcesDir(storage)).sort()).toEqual(["big.safetensors", "lightning.pth"]);
    const fetchNever = (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch;
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ fetch: fetchNever }) });
    expect(installedRight()).toBe(true);
    expect(existsSync(sourcesDir(storage))).toBe(false);
  });

  it("throws ModelsUnavailableError when the package misses a graph, or has no weight map", async () => {
    local = await serve();
    rmSync(join(pkg, "two.onnx"));
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).rejects.toBeInstanceOf(ModelsUnavailableError);
    expect(await modelsInstalled(storage, files.slice(0, 2))).toBe(true); // one.onnx and one.weights were built
    rmSync(join(pkg, "weightmap.json"));
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).rejects.toBeInstanceOf(ModelsUnavailableError);
  });

  it("refuses a weight map that does not match the model list, before fetching", async () => {
    local = await serve();
    const changed = sources.map((s, i) => (i === 0 ? { ...s, sha256: "f".repeat(64) } : s));
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ sources: changed }) })).rejects.toThrow(
      /does not match this build's model list/,
    );
    expect(local.requests).toHaveLength(0);
  });

  it("accepts body chunks from another realm (the host's fetch), via a fake fetch", async () => {
    // Live's extension runs in its own V8 context; the host's fetch yields typed arrays that fail instanceof here.
    const foreign = (b: Buffer): Uint8Array => {
      const u = runInNewContext(`new Uint8Array(${b.length})`) as Uint8Array;
      for (let i = 0; i < b.length; i++) u[i] = b[i];
      return u;
    };
    const fakeFetch = (async (url: string) => {
      const blob = blobs.get(url.slice("fake://m/".length))!;
      const chunks = [foreign(blob.subarray(0, 1000)), foreign(blob.subarray(1000))];
      expect(chunks[0] instanceof Uint8Array).toBe(false);
      return {
        status: 200,
        headers: new Headers(),
        body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }), cancel: async () => {} }), cancel: async () => {} },
      };
    }) as unknown as typeof fetch;
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ fetch: fakeFetch, urlFor: (s) => `fake://m/${s.file}` }) });
    expect(installedRight()).toBe(true);
  });

  it("uses the pinned Hugging Face URL by default", async () => {
    const urls: string[] = [];
    const fetchSpy = (async (url: string) => {
      urls.push(url);
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, sources, files, packagedDir: pkg, fetch: fetchSpy })).rejects.toThrow(
      "offline",
    );
    expect(urls).toEqual([`https://huggingface.co/test/repo0/resolve/${"ab".repeat(20)}/lightning.pth`]);
  });
});

describe("ensureModels review fixes", () => {
  /** Rewrites the package's weight map (and the store's file list to match). */
  const editMap = (edit: (w: WeightMap) => void) => {
    const w = JSON.parse(readFileSync(join(pkg, "weightmap.json"), "utf8")) as WeightMap;
    edit(w);
    writeFileSync(join(pkg, "weightmap.json"), JSON.stringify(w));
    files = w.models.flatMap((m) => [{ name: m.name, ...m.graph }, { ...m.weights }]);
  };
  const listed = () =>
    (JSON.parse(readFileSync(join(modelDir(storage), "installed.json"), "utf8")) as { files: ModelFile[] }).files.map((f) => f.name);

  it("m5: a build that fails from verified sources lists nothing for that model, deletes the downloads, and Retry fetches them again", async () => {
    local = await serve();
    const right = JSON.parse(readFileSync(join(pkg, "weightmap.json"), "utf8")) as WeightMap;
    editMap((w) => (w.models[1].weights.sha256 = "e".repeat(64)));
    await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).rejects.toMatchObject({
      name: "ModelChecksumError",
      message: expect.stringContaining("Building the models failed"),
    });
    expect(listed()).toEqual(["one.onnx", "one.weights"]); // built before the failure; two's pair is not listed
    expect(existsSync(join(modelDir(storage), "two.weights"))).toBe(false);
    expect(existsSync(sourcesDir(storage))).toBe(false);
    expect(local.requests).toHaveLength(2);

    editMap((w) => Object.assign(w, right)); // a fixed package: Retry downloads again and installs
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() });
    expect(local.requests).toHaveLength(4);
    expect(installedRight()).toBe(true);
  });

  it("m5: a downloaded source damaged after its check is downloaded again before the build", async () => {
    local = await serve();
    const ac = new AbortController();
    await expect(
      ensureModels({ storageDir: storage, signal: ac.signal, onProgress: (_d, _t, p) => p === "build" && ac.abort(), ...opts() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const path = join(sourcesDir(storage), "big.safetensors");
    const b = readFileSync(path);
    b[b.length - 1] ^= 0xff; // same size: only a hash finds it
    writeFileSync(path, b);
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() });
    expect(local.requests.map((r) => r.name)).toEqual(["lightning.pth", "big.safetensors", "big.safetensors"]);
    expect(installedRight()).toBe(true);
  });

  // Windows ignores the folder mode, so chmod cannot make the delete fail there.
  it.skipIf(process.platform === "win32")("m5: failing to delete the downloads after a complete install is not a failure", async () => {
    local = await serve();
    const locked = join(sourcesDir(storage), "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "x"), "x");
    chmodSync(locked, 0o500); // its file cannot be deleted
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() })).resolves.toBe(modelDir(storage));
      expect(await modelsInstalled(storage, files)).toBe(true);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("could not delete"), expect.anything());
    } finally {
      errors.mockRestore();
      chmodSync(locked, 0o700);
    }
  });

  it("m4: refuses to start when the volume lacks room for the rest, before any request, and says how much", async () => {
    local = await serve();
    const need = DOWNLOAD() + files.reduce((s, f) => s + f.bytes, 0);
    const err = await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ freeBytes: async () => need }) }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelsDiskSpaceError);
    expect((err as ModelsDiskSpaceError).neededBytes).toBe(need + 16_000_000);
    expect((err as Error).message).toBe(
      `There is not enough disk space for the analysis models. They need about ${Math.ceil((need + 16_000_000) / 1e6)} MB free. Free some space, then try again.`,
    );
    expect(local.requests).toHaveLength(0);
    // Enough room (or an unknown amount): it goes ahead.
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ freeBytes: async () => null }) });
    expect(installedRight()).toBe(true);
  });

  it("m4: the real volume check runs (statfs) and passes on the test machine", async () => {
    local = await serve();
    await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts() });
    expect(installedRight()).toBe(true);
  });

  it("m4: an ENOSPC on the way becomes ModelsDiskSpaceError, keeping what was downloaded", async () => {
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const fakeFetch = (async (url: string) => {
      const blob = blobs.get(url.slice("fake://m/".length))!;
      if (url.endsWith("big.safetensors")) {
        return { status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => Promise.reject(full), cancel: async () => {} }) } };
      }
      const chunks = [new Uint8Array(blob)];
      return { status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }), cancel: async () => {} }) } };
    }) as unknown as typeof fetch;
    const err = await ensureModels({ storageDir: storage, signal: never, onProgress: noop, ...opts({ fetch: fakeFetch, urlFor: (s) => `fake://m/${s.file}` }) }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelsDiskSpaceError);
    expect(readdirSync(sourcesDir(storage))).toContain("lightning.pth");
  });
});
