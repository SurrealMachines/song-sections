// A minimal zip reader for torch.save archives (fb/hfmodels): the central directory (zip64 too), and each entry's data
// position. torch.save stores every entry uncompressed; deflated entries are inflated with node:zlib, loaded only then.
// CRCs are not checked: the whole file's sha256 is verified before it is read.
import type { FileHandle } from "node:fs/promises";

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  override name = "ZipError";
}

/** Review m1: the most an entry may hold when read into memory (torch.save storages here are a few MB). */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError("unexpected end of file");
    done += bytesRead;
  }
  return buf;
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("zip64 value too large");
  return Number(v);
}

export class ZipReader {
  private constructor(
    private readonly fh: FileHandle,
    readonly entries: Map<string, ZipEntry>,
    private readonly fileSize: number,
  ) {}

  static async open(fh: FileHandle): Promise<ZipReader> {
    const fileSize = (await fh.stat()).size;
    const tailLen = Math.min(fileSize, 22 + 0xffff);
    const tail = await readAt(fh, fileSize - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("not a zip file (no end of central directory)");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) throw new ZipError("zip64 locator missing");
      const z64 = await readAt(fh, u64(tail, loc + 8), 56);
      if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipError("zip64 end of central directory missing");
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    if (cdOffset + cdSize > fileSize) throw new ZipError("central directory out of range");
    if (count * 46 > cdSize) throw new ZipError("central directory too small for its entry count");
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipError("bad central directory entry");
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      // zip64 extra field (0x0001): the 64-bit values of those that read 0xffffffff, in this order.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
          if (compressedSize === 0xffffffff) (compressedSize = u64(cd, q)), (q += 8);
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
        }
        e += 4 + len;
      }
      // Review m1: nothing an entry claims may point past the file, and a stored entry is its own size.
      if (localHeaderOffset + 30 + compressedSize > fileSize) throw new ZipError(`${name}: entry out of range`);
      if (method === 0 && size !== compressedSize) throw new ZipError(`${name}: stored entry with two sizes`);
      entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
      p = extraEnd + commentLen;
    }
    return new ZipReader(fh, entries, fileSize);
  }

  /** The file offset of the entry's data (after its local header). */
  async dataOffset(entry: ZipEntry): Promise<number> {
    const h = await readAt(this.fh, entry.localHeaderOffset, 30);
    if (h.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError(`bad local header for ${entry.name}`);
    const at = entry.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    if (at + entry.compressedSize > this.fileSize) throw new ZipError(`${entry.name}: data out of range`);
    return at;
  }

  /** The entry's whole content. */
  async read(entry: ZipEntry): Promise<Buffer> {
    if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) throw new ZipError(`${entry.name} is too large`);
    const raw = await readAt(this.fh, await this.dataOffset(entry), entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      const { inflateRawSync } = await import("node:zlib");
      // Review m1: never inflate past the declared size (a deflate bomb fails here, not after the allocation).
      let out: Buffer;
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        throw new ZipError(`${entry.name}: does not inflate to its declared ${entry.size} bytes (${(error as Error).message})`);
      }
      if (out.length !== entry.size) throw new ZipError(`${entry.name}: inflated to ${out.length} bytes, expected ${entry.size}`);
      return out;
    }
    throw new ZipError(`${entry.name}: unsupported compression method ${entry.method}`);
  }

  /** Reads `length` bytes at `offset` inside a stored entry, straight from the file. */
  async readStored(entry: ZipEntry, offset: number, length: number): Promise<Buffer> {
    if (entry.method !== 0) throw new ZipError(`${entry.name} is compressed`);
    if (offset < 0 || offset + length > entry.size) throw new ZipError(`${entry.name}: read out of range`);
    return readAt(this.fh, (await this.dataOffset(entry)) + offset, length);
  }
}

export { readAt };
