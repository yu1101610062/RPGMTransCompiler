import fs from "node:fs";
import path from "node:path";

export interface RgssArchiveEntry {
  name: string;
  offset: number;
  size: number;
  magic: number;
}

export interface RgssArchiveInfo {
  version: 1 | 2 | 3;
  entries: RgssArchiveEntry[];
}

export function readRgssArchiveVersion(file: string): 1 | 2 | 3 | undefined {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    if (header.subarray(0, 6).toString("ascii") !== "RGSSAD") return undefined;
    const version = header[7];
    return version === 1 || version === 2 || version === 3 ? version : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

export class RgssArchive {
  private fd: number;
  readonly info: RgssArchiveInfo;

  constructor(public readonly file: string) {
    this.fd = fs.openSync(file, "r");
    this.info = this.readInfo();
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  extractTo(outDir: string, options: { filter?: RegExp; onEntry?: (entry: RgssArchiveEntry) => void } = {}): number {
    let count = 0;
    fs.mkdirSync(outDir, { recursive: true });
    for (const entry of this.info.entries) {
      if (options.filter && !options.filter.test(entry.name)) continue;
      options.onEntry?.(entry);
      const output = path.join(outDir, ...entry.name.split("/"));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, this.readEntry(entry));
      count++;
    }
    return count;
  }

  readEntry(entry: RgssArchiveEntry): Buffer {
    const encrypted = Buffer.alloc(entry.size);
    fs.readSync(this.fd, encrypted, 0, entry.size, entry.offset);
    return decryptBuffer(encrypted, entry.magic);
  }

  private readInfo(): RgssArchiveInfo {
    const header = Buffer.alloc(8);
    fs.readSync(this.fd, header, 0, 8, 0);
    if (header.subarray(0, 6).toString("ascii") !== "RGSSAD") {
      throw new Error(`Invalid RGSSAD header: ${this.file}`);
    }
    const version = header[7] as 1 | 2 | 3;
    if (version === 3) return { version, entries: this.readVersion3() };
    if (version === 1 || version === 2) return { version, entries: this.readVersion1Or2() };
    throw new Error(`Unsupported RGSSAD version ${version}: ${this.file}`);
  }

  private readVersion3(): RgssArchiveEntry[] {
    let cursor = 8;
    const seed = this.readU32(cursor);
    cursor += 4;
    const magic = Math.imul(seed, 9) + 3 >>> 0;
    const entries: RgssArchiveEntry[] = [];

    while (cursor + 16 <= this.size()) {
      const offset = (this.readU32(cursor) ^ magic) >>> 0;
      cursor += 4;
      if (offset === 0) break;
      const size = (this.readU32(cursor) ^ magic) >>> 0;
      cursor += 4;
      const fileMagic = (this.readU32(cursor) ^ magic) >>> 0;
      cursor += 4;
      const nameLen = (this.readU32(cursor) ^ magic) >>> 0;
      cursor += 4;
      if (nameLen > 4096 || cursor + nameLen > this.size()) {
        throw new Error(`Invalid RGSSAD v3 name length ${nameLen} at ${cursor}: ${this.file}`);
      }
      const nameBuf = Buffer.alloc(nameLen);
      fs.readSync(this.fd, nameBuf, 0, nameLen, cursor);
      cursor += nameLen;
      for (let i = 0; i < nameBuf.length; i++) {
        nameBuf[i] ^= (magic >>> ((i % 4) * 8)) & 0xff;
      }
      const name = nameBuf.toString("utf8").replace(/\\/g, "/");
      entries.push({ name, offset, size, magic: fileMagic });
    }

    return entries;
  }

  private readVersion1Or2(): RgssArchiveEntry[] {
    let cursor = 8;
    let magic = 0xdeadcafe >>> 0;
    const entries: RgssArchiveEntry[] = [];
    while (cursor + 4 <= this.size()) {
      const encryptedLen = this.readU32(cursor);
      cursor += 4;
      const len = (encryptedLen ^ magic) >>> 0;
      magic = advanceMagic(magic);
      if (len === 0 || len > 4096 || cursor + len > this.size()) break;
      const nameBuf = Buffer.alloc(len);
      fs.readSync(this.fd, nameBuf, 0, len, cursor);
      cursor += len;
      for (let i = 0; i < nameBuf.length; i++) {
        nameBuf[i] ^= magic & 0xff;
        magic = advanceMagic(magic);
      }
      const encryptedSize = this.readU32(cursor);
      cursor += 4;
      const size = (encryptedSize ^ magic) >>> 0;
      magic = advanceMagic(magic);
      const offset = cursor;
      entries.push({
        name: nameBuf.toString("utf8").replace(/\\/g, "/"),
        offset,
        size,
        magic
      });
      cursor += size;
    }
    return entries;
  }

  private readU32(offset: number): number {
    const buf = Buffer.alloc(4);
    fs.readSync(this.fd, buf, 0, 4, offset);
    return buf.readUInt32LE(0);
  }

  private size(): number {
    return fs.fstatSync(this.fd).size;
  }
}

export function decryptBuffer(input: Buffer, initialMagic: number): Buffer {
  const output = Buffer.from(input);
  let magic = initialMagic >>> 0;
  let offset = 0;
  while (offset + 4 <= output.length) {
    const oldMagic = magic;
    magic = advanceMagic(magic);
    const value = (output.readUInt32LE(offset) ^ oldMagic) >>> 0;
    output.writeUInt32LE(value, offset);
    offset += 4;
  }
  for (let i = 0; offset + i < output.length; i++) {
    output[offset + i] ^= (magic >>> ((i % 4) * 8)) & 0xff;
  }
  return output;
}

function advanceMagic(magic: number): number {
  return Math.imul(magic, 7) + 3 >>> 0;
}
