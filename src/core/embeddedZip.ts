import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { normalizePath } from "./paths.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 0xffff + 22;

export interface EmbeddedZipEntry {
  archive: string;
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
}

interface EntryMeta extends EmbeddedZipEntry {
  localHeaderOffset: number;
  archiveBase: number;
  crc32: number;
  generalPurposeFlag: number;
}

interface ZipInfo {
  archive: string;
  archiveBase: number;
  eocdOffset: number;
  centralDirectorySize: number;
  centralDirectoryPhysicalOffset: number;
  entries: EntryMeta[];
}

interface CentralDirectoryEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  crc32: number;
  generalPurposeFlag: number;
}

export interface EmbeddedZipUpdate {
  name: string;
  data: string | Buffer;
  compressionMethod?: 0 | 8;
}

export function makeEmbeddedZipPath(archive: string, entry: string): string {
  return `zip://${normalizePath(archive)}!/${normalizeEntryName(entry)}`;
}

export function isEmbeddedZipPath(input: string): boolean {
  return input.startsWith("zip://") && input.includes("!/");
}

export function parseEmbeddedZipPath(input: string): { archive: string; entry: string } | undefined {
  if (!isEmbeddedZipPath(input)) return undefined;
  const body = input.slice("zip://".length);
  const marker = body.indexOf("!/");
  if (marker < 0) return undefined;
  return {
    archive: body.slice(0, marker),
    entry: normalizeEntryName(body.slice(marker + 2))
  };
}

export function listEmbeddedZipEntries(archive: string, pattern?: RegExp): EmbeddedZipEntry[] {
  const buffer = fs.readFileSync(archive);
  return (readZipInfo(buffer, normalizePath(archive))?.entries ?? [])
    .filter(entry => !pattern || pattern.test(entry.name))
    .map(({ localHeaderOffset: _localHeaderOffset, archiveBase: _archiveBase, crc32: _crc32, generalPurposeFlag: _generalPurposeFlag, ...entry }) => entry);
}

export function readEmbeddedZipText(virtualPath: string, encoding: BufferEncoding = "utf8"): string {
  const parsed = parseEmbeddedZipPath(virtualPath);
  if (!parsed) throw new Error(`Invalid embedded zip path: ${virtualPath}`);
  const buffer = fs.readFileSync(parsed.archive);
  const entry = readZipInfo(buffer, normalizePath(parsed.archive))?.entries.find(item => item.name === parsed.entry);
  if (!entry) throw new Error(`Embedded zip entry not found: ${parsed.entry}`);
  return readEntryBuffer(buffer, entry).toString(encoding);
}

export function updateEmbeddedZipEntries(archive: string, updates: EmbeddedZipUpdate[]): void {
  if (!updates.length) return;
  const archivePath = normalizePath(archive);
  const buffer = fs.readFileSync(archivePath);
  const info = readZipInfo(buffer, archivePath);
  if (!info) throw new Error(`Embedded ZIP package was not found: ${archivePath}`);

  const pending = new Map<string, Buffer>();
  const methods = new Map<string, 0 | 8>();
  for (const update of updates) {
    const name = normalizeEntryName(update.name);
    pending.set(name, Buffer.isBuffer(update.data) ? update.data : Buffer.from(update.data, "utf8"));
    methods.set(name, update.compressionMethod ?? 8);
  }

  const newLocalParts: Buffer[] = [];
  const centralEntries: CentralDirectoryEntry[] = [];
  let cursor = info.eocdOffset;
  for (const entry of info.entries) {
    const updated = pending.get(entry.name);
    if (updated) {
      const written = makeLocalRecord(entry.name, updated, cursor - info.archiveBase, methods.get(entry.name) ?? 8);
      newLocalParts.push(written.local);
      centralEntries.push(written.central);
      cursor += written.local.length;
      pending.delete(entry.name);
      continue;
    }
    centralEntries.push({
      name: entry.name,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      compressionMethod: entry.compressionMethod,
      localHeaderOffset: entry.localHeaderOffset,
      crc32: entry.crc32,
      generalPurposeFlag: entry.generalPurposeFlag
    });
  }

  for (const [name, data] of pending) {
    const written = makeLocalRecord(name, data, cursor - info.archiveBase, methods.get(name) ?? 8);
    newLocalParts.push(written.local);
    centralEntries.push(written.central);
    cursor += written.local.length;
  }

  const centralDirectoryOffset = cursor - info.archiveBase;
  const centralParts = centralEntries.map(makeCentralDirectoryRecord);
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = makeEocd(centralEntries.length, centralDirectorySize, centralDirectoryOffset);
  fs.writeFileSync(archivePath, Buffer.concat([
    buffer.subarray(0, info.eocdOffset),
    ...newLocalParts,
    ...centralParts,
    eocd
  ]));
}

export function findEmbeddedTyranoPackage(root: string): { archive: string; scenarioFiles: string[]; detectedBy: string[] } | undefined {
  if (!fs.existsSync(root)) return undefined;
  const exeFiles = fs.readdirSync(root)
    .filter(name => name.toLowerCase().endsWith(".exe"))
    .map(name => path.join(root, name))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  for (const exe of exeFiles) {
    let entries: EmbeddedZipEntry[];
    try {
      entries = listEmbeddedZipEntries(exe);
    } catch {
      continue;
    }
    const names = new Set(entries.map(entry => entry.name));
    const scenarioFiles = entries
      .filter(entry => /^data\/scenario\/.+\.ks$/i.test(entry.name))
      .map(entry => makeEmbeddedZipPath(exe, entry.name))
      .sort();
    const hasTyranoRuntime = names.has("tyrano/plugins/kag/kag.js") || names.has("tyrano/tyrano.js");
    if (!scenarioFiles.length || !hasTyranoRuntime) continue;
    const relArchive = path.relative(root, exe).replace(/\\/g, "/");
    const detectedBy = [
      `${relArchive}!/data/scenario/`,
      names.has("tyrano/plugins/kag/kag.js") ? `${relArchive}!/tyrano/plugins/kag/kag.js` : `${relArchive}!/tyrano/tyrano.js`
    ];
    return { archive: normalizePath(exe), scenarioFiles, detectedBy };
  }
  return undefined;
}

function readZipInfo(buffer: Buffer, archive: string): ZipInfo | undefined {
  const eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) return undefined;
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryPhysicalOffset = eocdOffset - centralDirectorySize;
  const archiveBase = centralDirectoryPhysicalOffset - centralDirectoryOffset;
  if (centralDirectoryPhysicalOffset < 0 || archiveBase < 0) return undefined;

  const entries: EntryMeta[] = [];
  let cursor = centralDirectoryPhysicalOffset;
  const end = centralDirectoryPhysicalOffset + centralDirectorySize;
  while (cursor + 46 <= end && buffer.readUInt32LE(cursor) === CENTRAL_DIRECTORY_SIGNATURE) {
    const generalPurposeFlag = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > end) break;
    const name = normalizeEntryName(buffer.toString("utf8", nameStart, nameEnd));
    if (name && !name.endsWith("/")) {
      entries.push({
        archive,
        name,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        localHeaderOffset,
        archiveBase,
        crc32,
        generalPurposeFlag
      });
    }
    cursor = nameEnd + extraLength + commentLength;
  }
  return {
    archive,
    archiveBase,
    eocdOffset,
    centralDirectorySize,
    centralDirectoryPhysicalOffset,
    entries
  };
}

function readEntryBuffer(buffer: Buffer, entry: EntryMeta): Buffer {
  const localHeader = entry.archiveBase + entry.localHeaderOffset;
  if (localHeader < 0 || localHeader + 30 > buffer.length || buffer.readUInt32LE(localHeader) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid embedded zip local header: ${entry.name}`);
  }
  const fileNameLength = buffer.readUInt16LE(localHeader + 26);
  const extraLength = buffer.readUInt16LE(localHeader + 28);
  const dataStart = localHeader + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) throw new Error(`Invalid embedded zip entry bounds: ${entry.name}`);
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported embedded zip compression method ${entry.compressionMethod}: ${entry.name}`);
}

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let cursor = buffer.length - 22; cursor >= start; cursor--) {
    if (buffer.readUInt32LE(cursor) === EOCD_SIGNATURE) return cursor;
  }
  return -1;
}

function normalizeEntryName(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

function makeLocalRecord(nameInput: string, data: Buffer, localHeaderOffset: number, method: 0 | 8): { local: Buffer; central: CentralDirectoryEntry } {
  const name = normalizeEntryName(nameInput);
  const nameBytes = Buffer.from(name, "utf8");
  const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return {
    local: Buffer.concat([header, nameBytes, compressed]),
    central: {
      name,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      compressionMethod: method,
      localHeaderOffset,
      crc32: crc,
      generalPurposeFlag: 0x0800
    }
  };
}

function makeCentralDirectoryRecord(entry: CentralDirectoryEntry): Buffer {
  const nameBytes = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.generalPurposeFlag, 8);
  header.writeUInt16LE(entry.compressionMethod, 10);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  return Buffer.concat([header, nameBytes]);
}

function makeEocd(entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number): Buffer {
  if (entryCount > 0xffff) throw new Error(`Embedded ZIP has too many entries: ${entryCount}`);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  return eocd;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table.push(value >>> 0);
  }
  return table;
})();
