// Test-only: just enough of the protobuf wire format to read an ONNX model's initializers (fb/hfmodels equivalence
// tests). ModelProto.graph = field 7; GraphProto.initializer = field 5; TensorProto: dims 1, data_type 2, name 8,
// raw_data 9, external_data 13 (StringStringEntryProto: key 1, value 2), data_location 14.

export interface Field {
  field: number;
  wire: number;
  /** varint value (wire 0), or the payload (wire 1, 2, 5). */
  value: number | Uint8Array;
  /** Byte range of the whole field (tag included) in the parent message. */
  start: number;
  end: number;
}

function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (let i = at; i < b.length; i++) {
    v += (b[i] & 0x7f) * mul;
    if ((b[i] & 0x80) === 0) return [v, i + 1];
    mul *= 128;
  }
  throw new Error("truncated varint");
}

export function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < b.length) {
    const start = at;
    const [tag, p] = varint(b, at);
    at = p;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    let value: number | Uint8Array;
    if (wire === 0) [value, at] = varint(b, at);
    else if (wire === 1) (value = b.subarray(at, at + 8)), (at += 8);
    else if (wire === 5) (value = b.subarray(at, at + 4)), (at += 4);
    else if (wire === 2) {
      const [len, q] = varint(b, at);
      value = b.subarray(q, q + len);
      at = q + len;
    } else throw new Error(`wire type ${wire}`);
    out.push({ field, wire, value, start, end: at });
  }
  return out;
}

export interface Initializer {
  name: string;
  dims: number[];
  dataType: number;
  raw: Uint8Array | null;
  external: Record<string, string> | null;
}

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

function tensor(b: Uint8Array): Initializer {
  const t: Initializer = { name: "", dims: [], dataType: 0, raw: null, external: null };
  for (const f of fields(b)) {
    if (f.field === 1 && f.wire === 0) t.dims.push(f.value as number);
    else if (f.field === 1 && f.wire === 2) {
      const p = f.value as Uint8Array;
      for (let at = 0; at < p.length; ) {
        const [v, q] = varint(p, at);
        t.dims.push(v);
        at = q;
      }
    } else if (f.field === 2) t.dataType = f.value as number;
    else if (f.field === 8) t.name = text(f.value as Uint8Array);
    else if (f.field === 9) t.raw = f.value as Uint8Array;
    else if (f.field === 13) {
      const kv = fields(f.value as Uint8Array);
      const key = text(kv.find((x) => x.field === 1)!.value as Uint8Array);
      const value = text(kv.find((x) => x.field === 2)!.value as Uint8Array);
      (t.external ??= {})[key] = value;
    }
  }
  return t;
}

/** The model's graph initializers, in order, and the graph's other fields' bytes concatenated (nodes, inputs, ...). */
export function readModel(bytes: Uint8Array): { initializers: Initializer[]; graphRest: Buffer; modelRest: Buffer } {
  const top = fields(bytes);
  const graph = top.find((f) => f.field === 7 && f.wire === 2);
  if (!graph) throw new Error("no graph");
  const g = graph.value as Uint8Array;
  const gf = fields(g);
  return {
    initializers: gf.filter((f) => f.field === 5).map((f) => tensor(f.value as Uint8Array)),
    graphRest: Buffer.concat(gf.filter((f) => f.field !== 5).map((f) => g.subarray(f.start, f.end))),
    modelRest: Buffer.concat(top.filter((f) => f !== graph).map((f) => bytes.subarray(f.start, f.end))),
  };
}
