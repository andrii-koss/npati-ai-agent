import { inflateRawSync } from "node:zlib";
import { safeProjectPath } from "./project-workspace";

export class ProjectImportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export interface ImportedTextFile { path: string; content: string; }

export interface ZipImportLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxCompressionRatio: number;
}

export const defaultZipImportLimits: ZipImportLimits = {
  maxArchiveBytes: Number.POSITIVE_INFINITY,
  maxExpandedBytes: Number.POSITIVE_INFINITY,
  maxFiles: Number.POSITIVE_INFINITY,
  maxFileBytes: Number.POSITIVE_INFINITY,
  maxCompressionRatio: 100,
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const read16 = (data: Buffer, offset: number) => data.readUInt16LE(offset);
const read32 = (data: Buffer, offset: number) => data.readUInt32LE(offset);

export function extractProjectZip(data: Buffer, overrides: Partial<ZipImportLimits> = {}): ImportedTextFile[] {
  const limits = { ...defaultZipImportLimits, ...overrides };
  if (!Buffer.isBuffer(data) || data.length < 22 || data.length > limits.maxArchiveBytes) {
    throw new ProjectImportError("zip_size_limit", "ZIP upload exceeds the allowed size", 413);
  }
  let end = -1;
  for (let cursor = data.length - 22; cursor >= Math.max(0, data.length - 65_557); cursor--) {
    if (read32(data, cursor) === 0x06054b50 && cursor + 22 + read16(data, cursor + 20) === data.length) {
      end = cursor;
      break;
    }
  }
  if (end < 0 || read16(data, end + 4) !== 0 || read16(data, end + 6) !== 0) {
    throw new ProjectImportError("invalid_zip", "Invalid or multi-disk ZIP archive");
  }
  const count = read16(data, end + 10);
  const directoryBytes = read32(data, end + 12);
  const directoryOffset = read32(data, end + 16);
  if (count > limits.maxFiles || count === 0 || directoryOffset + directoryBytes > end) {
    throw new ProjectImportError("zip_limit", "ZIP file count or directory exceeds limits", 413);
  }
  const entries: ImportedTextFile[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || read32(data, cursor) !== 0x02014b50) {
      throw new ProjectImportError("invalid_zip", "Corrupt ZIP directory");
    }
    const flags = read16(data, cursor + 8);
    const method = read16(data, cursor + 10);
    const compressed = read32(data, cursor + 20);
    const uncompressed = read32(data, cursor + 24);
    const nameBytes = read16(data, cursor + 28);
    const extraBytes = read16(data, cursor + 30);
    const commentBytes = read16(data, cursor + 32);
    const mode = read32(data, cursor + 38) >>> 16;
    const localOffset = read32(data, cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (next > end || localOffset + 30 > data.length || compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new ProjectImportError("invalid_zip", "Corrupt or unsupported ZIP archive");
    }
    if ((flags & 1) !== 0 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000) {
      throw new ProjectImportError("unsupported_zip", "Encrypted files, links, and unsupported compression are not allowed");
    }
    let name: string;
    try { name = decoder.decode(data.subarray(cursor + 46, cursor + 46 + nameBytes)); }
    catch { throw new ProjectImportError("invalid_zip", "ZIP filenames must be UTF-8"); }
    cursor = next;
    if (name.endsWith("/")) continue;
    let safe: string;
    try { safe = safeProjectPath(name); }
    catch { throw new ProjectImportError("unsafe_zip_path", "ZIP contains a protected or unsafe path", 400); }
    if (seen.has(safe.toLowerCase())) throw new ProjectImportError("duplicate_zip_path", "ZIP contains duplicate paths");
    seen.add(safe.toLowerCase());
    expanded += uncompressed;
    if (entries.length >= limits.maxFiles || uncompressed > limits.maxFileBytes || expanded > limits.maxExpandedBytes
      || (compressed === 0 && uncompressed > 0) || uncompressed > compressed * limits.maxCompressionRatio) {
      throw new ProjectImportError("zip_bomb", "ZIP decompression limits exceeded", 413);
    }
    if (read32(data, localOffset) !== 0x04034b50) throw new ProjectImportError("invalid_zip", "Corrupt ZIP file header");
    const localNameBytes = read16(data, localOffset + 26);
    const localExtraBytes = read16(data, localOffset + 28);
    const start = localOffset + 30 + localNameBytes + localExtraBytes;
    if (start + compressed > data.length) throw new ProjectImportError("invalid_zip", "Truncated ZIP file");
    const source = data.subarray(start, start + compressed);
    let content: Buffer;
    try { content = method === 0 ? source : inflateRawSync(source, { maxOutputLength: Math.min(uncompressed + 1, limits.maxFileBytes + 1) }); }
    catch { throw new ProjectImportError("zip_bomb", "ZIP decompression failed or exceeded limits", 413); }
    if (content.length !== uncompressed) throw new ProjectImportError("invalid_zip", "ZIP file length mismatch");
    let text: string;
    try { text = decoder.decode(content); }
    catch { throw new ProjectImportError("unsupported_binary_file", "Project ZIP contains a binary file", 422); }
    if (text.includes("\0")) throw new ProjectImportError("unsupported_binary_file", "Project ZIP contains a binary file", 422);
    entries.push({ path: safe, content: text });
  }
  if (cursor !== directoryOffset + directoryBytes || entries.length === 0) {
    throw new ProjectImportError("invalid_zip", "ZIP has no importable files or a corrupt directory");
  }
  const firstParts = entries.map((entry) => entry.path.split("/"));
  const commonRoot = firstParts[0]?.[0];
  if (commonRoot && firstParts.every((parts) => parts.length > 1 && parts[0] === commonRoot)) {
    return entries.map((entry) => ({ ...entry, path: safeProjectPath(entry.path.slice(commonRoot.length + 1)) }));
  }
  return entries;
}
