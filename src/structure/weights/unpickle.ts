// A minimal pickle reader for torch.save checkpoints (fb/hfmodels). It never executes anything: GLOBAL only names a
// callable, and REDUCE / NEWOBJ / BUILD on it produce inert values. Three callables are understood, because torch.save
// emits them for a state dict: collections.OrderedDict (a dict), torch._utils._rebuild_tensor_v2 (a tensor
// descriptor) and torch._utils._rebuild_parameter (its tensor). Every other call becomes a PickleCall placeholder.
// Persistent IDs ("storage", <storage type>, <key>, <location>, <numel>) become StorageRef descriptors.
import { Buffer } from "node:buffer";

/** A module-level name the pickle refers to. Never resolved to anything. */
export class PickleGlobal {
  constructor(
    readonly module: string,
    readonly name: string,
  ) {}
  get qualified(): string {
    return `${this.module}.${this.name}`;
  }
}

/** The result of calling a callable this reader does not know: kept as data, never run. */
export class PickleCall {
  state: unknown = undefined;
  constructor(
    readonly callable: unknown,
    readonly args: unknown[],
  ) {}
}

/** One storage of the checkpoint: the zip entry `<archive>/data/<key>`. */
export class StorageRef {
  constructor(
    /** The storage class's name, e.g. "FloatStorage" or "HalfStorage". */
    readonly storageType: string,
    readonly key: string,
    readonly location: string,
    /** Elements in the storage. */
    readonly numel: number,
  ) {}
}

/** torch._utils._rebuild_tensor_v2(storage, storage_offset, size, stride, ...): a view into a storage, in elements. */
export class TensorRef {
  constructor(
    readonly storage: StorageRef,
    readonly storageOffset: number,
    readonly shape: number[],
    readonly stride: number[],
  ) {}
}

export class PickleError extends Error {
  override name = "PickleError";
}

const MAX_DEPTH_GUARD = 1_000_000;
/** Review m1: the highest tensor rank accepted (torch's own limit is 64; checkpoints here use at most 4). */
export const MAX_RANK = 16; // stack entries; a sane checkpoint pickle has a few thousand

/** A mark on the stack (MARK opcode). */
const MARK = Symbol("mark");

function asInt(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "bigint" && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  throw new PickleError(`${what}: expected an integer`);
}

function asIntTuple(v: unknown, what: string): number[] {
  if (!Array.isArray(v)) throw new PickleError(`${what}: expected a tuple`);
  return v.map((x, i) => asInt(x, `${what}[${i}]`));
}

function call(callable: unknown, args: unknown[]): unknown {
  if (callable instanceof PickleGlobal) {
    switch (callable.qualified) {
      case "collections.OrderedDict":
        if (args.length === 0) return new Map<unknown, unknown>();
        break;
      case "torch._utils._rebuild_tensor_v2": {
        const [storage, offset, size, stride] = args;
        if (!(storage instanceof StorageRef)) throw new PickleError("_rebuild_tensor_v2: no storage");
        const shape = asIntTuple(size, "size");
        const strides = asIntTuple(stride, "stride");
        // Review m1: a rank torch can make, one stride per dim, nothing negative.
        if (shape.length !== strides.length) throw new PickleError("_rebuild_tensor_v2: size and stride differ in rank");
        if (shape.length > MAX_RANK) throw new PickleError("_rebuild_tensor_v2: rank too high");
        const at = asInt(offset, "storage_offset");
        if (at < 0 || shape.some((d) => d < 0) || strides.some((d) => d < 0)) throw new PickleError("_rebuild_tensor_v2: negative size, stride or offset");
        return new TensorRef(storage, at, shape, strides);
      }
      case "torch._utils._rebuild_parameter":
        if (args[0] instanceof TensorRef) return args[0];
        break;
    }
  }
  return new PickleCall(callable, args);
}

function persistent(pid: unknown): unknown {
  if (Array.isArray(pid) && pid[0] === "storage" && pid.length >= 5) {
    const [, type, key, location, numel] = pid;
    const typeName = type instanceof PickleGlobal ? type.name : typeof type === "string" ? type : "";
    if (typeof key !== "string") throw new PickleError("storage persistent id: key is not a string");
    const n = asInt(numel, "storage numel");
    if (n < 0) throw new PickleError("storage numel is negative");
    return new StorageRef(typeName, key, typeof location === "string" ? location : "", n);
  }
  return new PickleCall(new PickleGlobal("<persistent>", "id"), [pid]);
}

/**
 * Reads one pickle (protocols 2 to 5) from `data`. Dicts become Maps (keys as unpickled), lists and tuples arrays,
 * strings strings, ints numbers (bigint beyond 2^53), floats numbers, bytes Uint8Arrays.
 */
export function unpickle(data: Uint8Array): unknown {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Buffer, not TextDecoder: Live's host provides Node's builtins (models.ts uses Buffer too).
  const decode = (b: Uint8Array, encoding: "utf8" | "latin1") => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString(encoding);
  const text = { decode: (b: Uint8Array) => decode(b, "utf8") };
  let pos = 0;
  const stack: unknown[] = [];
  const marks: number[] = [];
  const memo = new Map<number, unknown>();

  const need = (n: number) => {
    if (pos + n > data.length) throw new PickleError("truncated pickle");
  };
  const u8 = () => (need(1), data[pos++]);
  const u16 = () => (need(2), (pos += 2), view.getUint16(pos - 2, true));
  const u32 = () => (need(4), (pos += 4), view.getUint32(pos - 4, true));
  const i32 = () => (need(4), (pos += 4), view.getInt32(pos - 4, true));
  const u64 = () => {
    need(8);
    const v = view.getBigUint64(pos, true);
    pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PickleError("length too large");
    return Number(v);
  };
  const bytes = (n: number) => {
    need(n);
    pos += n;
    return data.subarray(pos - n, pos);
  };
  const line = () => {
    const end = data.indexOf(0x0a, pos);
    if (end < 0) throw new PickleError("truncated pickle");
    const s = text.decode(data.subarray(pos, end));
    pos = end + 1;
    return s;
  };
  const push = (v: unknown) => {
    if (stack.length >= MAX_DEPTH_GUARD) throw new PickleError("pickle stack too deep");
    stack.push(v);
  };
  const pop = () => {
    if (stack.length === 0 || (marks.length > 0 && stack.length <= marks[marks.length - 1])) throw new PickleError("stack underflow");
    return stack.pop();
  };
  const top = () => {
    if (stack.length === 0) throw new PickleError("stack underflow");
    return stack[stack.length - 1];
  };
  const popMark = (): unknown[] => {
    const m = marks.pop();
    if (m === undefined) throw new PickleError("no MARK");
    return stack.splice(m);
  };
  const signedLE = (b: Uint8Array): number | bigint => {
    if (b.length === 0) return 0;
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    if (b[b.length - 1] & 0x80) v -= 1n << BigInt(8 * b.length);
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  };
  const setItems = (target: unknown, items: unknown[]) => {
    if (!(target instanceof Map)) throw new PickleError("SETITEM(S) on a non-dict");
    if (items.length % 2) throw new PickleError("odd SETITEMS");
    for (let i = 0; i < items.length; i += 2) target.set(items[i], items[i + 1]);
  };
  const appendItems = (target: unknown, items: unknown[]) => {
    if (!Array.isArray(target)) throw new PickleError("APPEND(S) on a non-list");
    for (const item of items) target.push(item); // not push(...items): that overflows the call stack past ~120k items
  };

  for (;;) {
    const op = u8();
    switch (op) {
      case 0x80: // PROTO
        if (u8() > 5) throw new PickleError("unsupported pickle protocol");
        break;
      case 0x95: // FRAME
        u64();
        break;
      case 0x2e: // STOP
        if (stack.length !== 1 || marks.length) throw new PickleError("malformed pickle at STOP");
        return stack[0];
      case 0x28: // MARK
        marks.push(stack.length);
        break;
      case 0x30: // POP
        if (marks.length && stack.length === marks[marks.length - 1]) marks.pop();
        else pop();
        break;
      case 0x31: // POP_MARK
        popMark();
        break;
      case 0x32: // DUP
        push(top());
        break;
      case 0x4e: // NONE
        push(null);
        break;
      case 0x88: // NEWTRUE
        push(true);
        break;
      case 0x89: // NEWFALSE
        push(false);
        break;
      case 0x4a: // BININT
        push(i32());
        break;
      case 0x4b: // BININT1
        push(u8());
        break;
      case 0x4d: // BININT2
        push(u16());
        break;
      case 0x8a: // LONG1
        push(signedLE(bytes(u8())));
        break;
      case 0x8b: // LONG4
        push(signedLE(bytes(u32())));
        break;
      case 0x47: // BINFLOAT (big-endian double)
        need(8);
        push(view.getFloat64(pos, false));
        pos += 8;
        break;
      case 0x58: // BINUNICODE
        push(text.decode(bytes(u32())));
        break;
      case 0x8c: // SHORT_BINUNICODE
        push(text.decode(bytes(u8())));
        break;
      case 0x8d: // BINUNICODE8
        push(text.decode(bytes(u64())));
        break;
      case 0x54: // BINSTRING
        push(decode(bytes(u32()), "latin1"));
        break;
      case 0x55: // SHORT_BINSTRING
        push(decode(bytes(u8()), "latin1"));
        break;
      case 0x42: // BINBYTES
        push(bytes(u32()).slice());
        break;
      case 0x43: // SHORT_BINBYTES
        push(bytes(u8()).slice());
        break;
      case 0x8e: // BINBYTES8
        push(bytes(u64()).slice());
        break;
      case 0x7d: // EMPTY_DICT
        push(new Map<unknown, unknown>());
        break;
      case 0x5d: // EMPTY_LIST
        push([]);
        break;
      case 0x29: // EMPTY_TUPLE
        push([]);
        break;
      case 0x8f: // EMPTY_SET
        push(new PickleCall(new PickleGlobal("builtins", "set"), [[]]));
        break;
      case 0x64: {
        // DICT
        const items = popMark();
        const d = new Map<unknown, unknown>();
        setItems(d, items);
        push(d);
        break;
      }
      case 0x6c: // LIST
        push(popMark());
        break;
      case 0x74: // TUPLE
        push(popMark());
        break;
      case 0x85: // TUPLE1
        push([pop()]);
        break;
      case 0x86: {
        // TUPLE2
        const b = pop();
        push([pop(), b]);
        break;
      }
      case 0x87: {
        // TUPLE3
        const c = pop();
        const b = pop();
        push([pop(), b, c]);
        break;
      }
      case 0x73: {
        // SETITEM
        const v = pop();
        const k = pop();
        setItems(top(), [k, v]);
        break;
      }
      case 0x75: {
        // SETITEMS
        const items = popMark();
        setItems(top(), items);
        break;
      }
      case 0x61: {
        // APPEND
        const v = pop();
        appendItems(top(), [v]);
        break;
      }
      case 0x65: {
        // APPENDS
        const items = popMark();
        appendItems(top(), items);
        break;
      }
      case 0x90: {
        // ADDITEMS (sets are kept inert)
        popMark();
        break;
      }
      case 0x71: // BINPUT
        memo.set(u8(), top());
        break;
      case 0x72: // LONG_BINPUT
        memo.set(u32(), top());
        break;
      case 0x94: // MEMOIZE
        memo.set(memo.size, top());
        break;
      case 0x68: // BINGET
      case 0x6a: {
        // LONG_BINGET
        const i = op === 0x68 ? u8() : u32();
        if (!memo.has(i)) throw new PickleError(`memo ${i} missing`);
        push(memo.get(i));
        break;
      }
      case 0x63: {
        // GLOBAL "module\nname\n"
        const module = line();
        push(new PickleGlobal(module, line()));
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop();
        const module = pop();
        if (typeof module !== "string" || typeof name !== "string") throw new PickleError("STACK_GLOBAL needs two strings");
        push(new PickleGlobal(module, name));
        break;
      }
      case 0x52: {
        // REDUCE
        const args = pop();
        const callable = pop();
        if (!Array.isArray(args)) throw new PickleError("REDUCE needs an argument tuple");
        push(call(callable, args));
        break;
      }
      case 0x81: {
        // NEWOBJ
        const args = pop();
        const cls = pop();
        push(new PickleCall(cls, Array.isArray(args) ? args : [args]));
        break;
      }
      case 0x62: {
        // BUILD: set state on the object below; dicts and tensors ignore it (OrderedDict's _metadata, for example)
        const state = pop();
        const obj = top();
        if (obj instanceof PickleCall) obj.state = state;
        break;
      }
      case 0x51: // BINPERSID
        push(persistent(pop()));
        break;
      default:
        throw new PickleError(`unsupported pickle opcode 0x${op.toString(16)} at ${pos - 1}`);
    }
  }
}
