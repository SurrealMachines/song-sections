// The checkpoint readers against tiny torch.save / safetensors fixtures (tools/hfmodels/make_fixtures.py).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { f16ToF32Bits, materialize, openCheckpoint, openPth, openSafetensors, type Checkpoint } from "./checkpoint.js";
import { PickleCall, PickleError, PickleGlobal, TensorRef, unpickle } from "./unpickle.js";
import { ZipError, ZipReader } from "./zip.js";
import { deflateRawSync } from "node:zlib";

const FIX = join(__dirname, "..", "..", "..", "fixtures", "hfmodels");

interface Expected {
  dtype: string;
  shape: number[];
  values: number[];
  transposed?: number[];
}
const expected = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8")) as Record<"state_dict" | "safetensors", Record<string, Expected>>;

const floats = (b: Buffer) => [...new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))];

const opened: Checkpoint[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) await c.close();
});
async function load(name: string): Promise<Checkpoint> {
  const c = await openCheckpoint(join(FIX, name));
  opened.push(c);
  return c;
}

async function expectTensors(c: Checkpoint, want: Record<string, Expected>) {
  expect([...c.tensors.keys()].sort()).toEqual(Object.keys(want).sort());
  for (const [key, e] of Object.entries(want)) {
    const t = c.tensors.get(key)!;
    expect(t.dtype, key).toBe(e.dtype);
    expect(t.shape, key).toEqual(e.shape);
    expect(floats(await materialize(t)), key).toEqual(e.values);
    if (e.transposed) expect(floats(await materialize(t, [1, 0])), key).toEqual(e.transposed);
  }
}

describe("openPth", () => {
  it.each(["lightning.pth", "protocol4.pth", "deflated.pth"])("reads every tensor of %s", async (name) => {
    await expectTensors(await load(name), expected.state_dict);
  });

  it("keeps strides and storage offsets (a transposed tensor, a slice, two views of one storage)", async () => {
    const c = await load("lightning.pth");
    expect(c.tensors.get("dense.weight_t")!.stride).toEqual([1, 4]);
    expect(c.tensors.get("slice")!.stride).toEqual([4, 1]);
    expect(c.tensors.get("slice_view")!.stride).toEqual([4]);
    expect(c.tensors.get("scalar")!.shape).toEqual([]);
  });

  it("reads the config of plain values, and an unknown class as an inert placeholder", async () => {
    const fh = await open(join(FIX, "lightning.pth"), "r");
    try {
      const zip = await ZipReader.open(fh);
      const root = unpickle(await zip.read(zip.entries.get("lightning/data.pkl")!)) as Map<string, unknown>;
      const config = root.get("config") as Map<string, unknown>;
      expect(Object.fromEntries([...config].filter(([k]) => k !== "obj" && k !== "nested"))).toEqual({
        lr: 0.005,
        fps: 100,
        big: 2n ** 70n,
        neg: -123456789,
        name: "fold-ü",
        flag: true,
        off: false,
        none: null,
        list: [1, 2.5, "x"],
        tuple: [1, [2, 3]],
      });
      expect((config.get("nested") as Map<string, Map<string, unknown>>).get("a")!.get("b")).toEqual([null]);
      const obj = config.get("obj");
      expect(obj).toBeInstanceOf(PickleCall);
      expect(((obj as PickleCall).callable as PickleGlobal).qualified).toBe("__main__.Unknown"); // NEWOBJ, then BUILD
      expect((obj as PickleCall).state).toEqual(new Map([["value", 7]]));
    } finally {
      await fh.close();
    }
  });

  it("never runs what a hostile pickle asks for (os.system becomes a placeholder)", async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "hostile-"));
    try {
      process.chdir(dir);
      const c = await openPth(join(FIX, "hostile.pth"));
      await c.close();
      expect(c.tensors.size).toBe(0);
      const fh = await open(join(FIX, "hostile.pth"), "r");
      const zip = await ZipReader.open(fh);
      const root = unpickle(await zip.read(zip.entries.get("hostile/data.pkl")!)) as Map<string, unknown>;
      await fh.close();
      const evil = root.get("evil") as PickleCall;
      expect(evil).toBeInstanceOf(PickleCall);
      expect((evil.callable as PickleGlobal).name).toBe("system");
      expect(evil.args).toEqual(["touch HOSTILE_MARKER"]);
      expect(existsSync(join(dir, "HOSTILE_MARKER"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file that is not a torch.save zip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notzip-"));
    try {
      writeFileSync(join(dir, "x.pth"), "not a zip at all");
      await expect(openPth(join(dir, "x.pth"))).rejects.toThrow(/not a zip file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unpickle", () => {
  it("rejects truncated input and unknown opcodes", () => {
    expect(() => unpickle(Uint8Array.from([0x80, 0x02, 0x4b]))).toThrow(PickleError);
    expect(() => unpickle(Uint8Array.from([0x80, 0x02, 0xff]))).toThrow(/unsupported pickle opcode 0xff/);
    expect(() => unpickle(Uint8Array.from([0x80, 0x02, 0x30, 0x2e]))).toThrow(/underflow/); // POP on an empty stack
  });
  it("reads a small protocol-2 pickle", () => {
    // python3 -c "import pickle; print(pickle.dumps({'a': [1, -2, 3.5]}, protocol=2).hex())"
    const bytes = Buffer.from("80027d710058010000006171015d7102284b014afeffffff47400c00000000000065732e", "hex");
    expect(unpickle(bytes)).toEqual(new Map([["a", [1, -2, 3.5]]]));
  });
});

describe("openSafetensors", () => {
  it("reads float32 and float16 tensors", async () => {
    await expectTensors(await load("tiny.safetensors"), expected.safetensors);
  });

  it("rejects a header length past the end of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "st-"));
    try {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(1000n, 0);
      writeFileSync(join(dir, "bad.safetensors"), b);
      await expect(openSafetensors(join(dir, "bad.safetensors"))).rejects.toThrow(/header length/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("float16 widening", () => {
  it("matches Float16Array for all 65536 bit patterns", () => {
    const h = new Uint16Array(1);
    const f16 = new Float16Array(h.buffer);
    const u = new Uint32Array(1);
    const f32 = new Float32Array(u.buffer);
    for (let bits = 0; bits < 65536; bits++) {
      h[0] = bits;
      u[0] = f16ToF32Bits(bits);
      const want = f16[0];
      if (Number.isNaN(want)) {
        expect(Number.isNaN(f32[0])).toBe(true);
        expect(u[0] & 0x1fff).toBe(0); // the payload is shifted up, as numpy and torch do
      } else if (f32[0] !== want || Object.is(want, -0) !== Object.is(f32[0], -0)) {
        throw new Error(`0x${bits.toString(16)}: ${f32[0]} vs ${want}`);
      }
    }
  });
});

// Review m2: hostile and malformed input, built here from bytes.

/** Protocol-2 pickle opcodes, enough to hand-write a torch.save state dict. */
const P = {
  proto: Buffer.from([0x80, 0x02]),
  global: (module: string, name: string) => Buffer.from(`c${module}\n${name}\n`, "latin1"),
  str: (v: string) => {
    const b = Buffer.from(v, "utf8");
    const h = Buffer.alloc(5);
    h[0] = 0x58; // BINUNICODE
    h.writeUInt32LE(b.length, 1);
    return Buffer.concat([h, b]);
  },
  int: (v: number) => Buffer.from([0x4b, v]), // BININT1
  mark: Buffer.from([0x28]),
  tuple: Buffer.from([0x74]),
  persid: Buffer.from([0x51]),
  reduce: Buffer.from([0x52]),
  emptyDict: Buffer.from([0x7d]),
  setitem: Buffer.from([0x73]),
  stop: Buffer.from([0x2e]),
};
const tup = (...items: Buffer[]) => Buffer.concat([P.mark, ...items, P.tuple]);

/** {"w": _rebuild_tensor_v2(storage "0" of `numel` floats, offset, size, stride)}, pickled. */
function tensorPickle(numel: number, offset: number, size: number[], stride: number[]): Buffer {
  const storage = Buffer.concat([tup(P.str("storage"), P.global("torch", "FloatStorage"), P.str("0"), P.str("cpu"), P.int(numel)), P.persid]);
  const call = Buffer.concat([
    P.global("torch._utils", "_rebuild_tensor_v2"),
    tup(storage, P.int(offset), tup(...size.map(P.int)), tup(...stride.map(P.int))),
    P.reduce,
  ]);
  return Buffer.concat([P.proto, P.emptyDict, P.str("w"), call, P.setitem, P.stop]);
}

/** A zip of `entries`: stored, unless named in `deflate`; `cd` may patch each central directory entry. */
function zipOf(entries: Record<string, Buffer>, opts: { deflate?: string[]; cd?: (name: string, entry: Buffer) => void } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const deflated = opts.deflate?.includes(name) ?? false;
    const data = deflated ? deflateRawSync(content) : content;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(deflated ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    opts.cd?.(name, cd);
    locals.push(local, n, data);
    central.push(cd, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("hostile and malformed input (review m2)", () => {
  let dir: string;
  const write = (name: string, b: Buffer) => {
    const p = join(dir, name);
    writeFileSync(p, b);
    return p;
  };
  const floats16 = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = () => (dir = mkdtempSync(join(tmpdir(), "hostile-m2-")));

  it("a hand-built checkpoint reads (the builders are right)", async () => {
    fresh();
    const c = await openPth(write("ok.pth", zipOf({ "a/data.pkl": tensorPickle(4, 1, [2], [1]), "a/data/0": floats16 })));
    expect(floats(await materialize(c.tensors.get("w")!))).toEqual([2, 3]);
    await c.close();
  });

  it("refuses a view past the end of its storage", async () => {
    fresh();
    const c = await openPth(write("v.pth", zipOf({ "a/data.pkl": tensorPickle(4, 3, [2], [1]), "a/data/0": floats16 })));
    await expect(materialize(c.tensors.get("w")!)).rejects.toThrow(/out of its storage/);
    await c.close();
  });

  it("refuses a storage whose entry is not numel floats", async () => {
    fresh();
    const c = await openPth(write("s.pth", zipOf({ "a/data.pkl": tensorPickle(8, 0, [2], [1]), "a/data/0": floats16 })));
    await expect(materialize(c.tensors.get("w")!)).rejects.toThrow(/wrong size/);
    await c.close();
  });

  it("refuses size and stride of different ranks", async () => {
    fresh();
    await expect(openPth(write("r.pth", zipOf({ "a/data.pkl": tensorPickle(4, 0, [2], [1, 1]), "a/data/0": floats16 })))).rejects.toThrow(
      /differ in rank/,
    );
    expect(() => unpickle(tensorPickle(4, 0, [2, 2], [2]))).toThrow(PickleError);
    expect(unpickle(tensorPickle(4, 0, [2, 2], [2, 1])) instanceof Map).toBe(true);
    expect((unpickle(tensorPickle(4, 0, [2, 2], [2, 1])) as Map<string, unknown>).get("w")).toBeInstanceOf(TensorRef);
  });

  it("refuses a central directory entry that points past the file", async () => {
    fresh();
    const big = zipOf({ "a/data.pkl": tensorPickle(4, 0, [4], [1]), "a/data/0": floats16 }, { cd: (n, e) => n.endsWith("/0") && e.writeUInt32LE(0x7fffffff, 20) });
    await expect(openPth(write("big.pth", big))).rejects.toThrow(ZipError);
    const offset = zipOf({ "a/data.pkl": tensorPickle(4, 0, [4], [1]), "a/data/0": floats16 }, { cd: (n, e) => n.endsWith("/0") && e.writeUInt32LE(0x7ffffff0, 42) });
    await expect(openPth(write("off.pth", offset))).rejects.toThrow(/out of range/);
  });

  it("refuses a truncated archive", async () => {
    fresh();
    const z = zipOf({ "a/data.pkl": tensorPickle(4, 0, [4], [1]), "a/data/0": floats16 });
    await expect(openPth(write("cut.pth", z.subarray(0, z.length - 30)))).rejects.toThrow(ZipError);
  });

  it("stops a deflate bomb at its declared size instead of inflating it", async () => {
    fresh();
    const bomb = Buffer.alloc(8 * 1024 * 1024); // deflates to a few kB
    const z = zipOf({ "a/data.pkl": tensorPickle(4, 0, [4], [1]), "a/data/0": bomb }, { deflate: ["a/data/0"], cd: (n, e) => n.endsWith("/0") && e.writeUInt32LE(16, 24) });
    expect(z.length).toBeLessThan(100_000);
    const c = await openPth(write("bomb.pth", z));
    await expect(materialize(c.tensors.get("w")!)).rejects.toThrow(/does not inflate to its declared 16 bytes/);
    await c.close();
  });

  it("reads self-referencing containers without recursing", () => {
    // python3 -c "import pickle; l = []; l.append(l); print(pickle.dumps(l, protocol=2).hex())"
    const l = unpickle(Buffer.from("80025d71006800612e", "hex")) as unknown[];
    expect(l[0]).toBe(l);
    // d = {}; d["self"] = d
    const d = unpickle(Buffer.from("80027d7100580400000073656c6671016800732e", "hex")) as Map<string, unknown>;
    expect(d.get("self")).toBe(d);
  });

  it("appends 200k items in one APPENDS (no call-stack overflow)", () => {
    const n = 200_000;
    const body = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) (body[2 * i] = 0x4b), (body[2 * i + 1] = i & 0xff);
    const l = unpickle(Buffer.concat([P.proto, Buffer.from([0x5d]), P.mark, body, Buffer.from([0x65]), P.stop])) as number[];
    expect(l).toHaveLength(n);
  });

  it("refuses a safetensors entry with a negative or fractional dim", async () => {
    fresh();
    const header = Buffer.from(JSON.stringify({ w: { dtype: "F32", shape: [-1], data_offsets: [0, 4] } }));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(header.length));
    await expect(openSafetensors(write("neg.safetensors", Buffer.concat([len, header, Buffer.alloc(4)])))).rejects.toThrow(/bad entry/);
  });
});
