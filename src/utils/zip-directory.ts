// Zip headers are bit fields.
/* eslint-disable no-bitwise */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

/** `zlib.crc32` only exists from Node 20.15, and synth runs on the user's Node. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Zip `dir` with its symlinks stored *as* symlinks, which Lambda extracts as
 * such. `Code.fromAsset(dir)` can't be used for a deployment root because
 * `cdk-assets` dereferences them when it zips, and under pnpm that
 * materializes a store package at its logical path while the siblings it
 * resolves its own dependencies through stay behind in the store. Preserved,
 * the links resolve the way they do in the workspace, and the way they do in
 * a Containers image (`COPY` preserves them too).
 *
 * Deterministic — entries sorted, timestamps fixed, modes normalized — so the
 * asset hash only changes when the contents do.
 */
export function zipDirectory(dir: string): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  const add = (name: string, mode: number, content: Buffer) => {
    // Links stay stored: some extractors read a deflated link's target as-is.
    const deflate = content.length > 0 && (mode & 0o170000) === 0o100000;
    const data = deflate ? deflateRawSync(content) : content;
    const nameBytes = Buffer.from(name, "utf8");
    // Version 2.0; UTF-8 names; 1980-01-01 00:00; no extra fields.
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt16LE(0x0800, 2);
    fields.writeUInt16LE(deflate ? 8 : 0, 4);
    fields.writeUInt16LE(0, 6);
    fields.writeUInt16LE(0x21, 8);
    fields.writeUInt32LE(crc32(content), 10);
    fields.writeUInt32LE(data.length, 14);
    fields.writeUInt32LE(content.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);

    const local = Buffer.alloc(4);
    local.writeUInt32LE(0x04034b50);
    chunks.push(local, fields, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    // Made by Unix, so extractors honor the mode in the external attributes.
    entry.writeUInt16LE(0x0314, 4);
    fields.copy(entry, 6);
    entry.writeUInt32LE(
      ((mode << 16) | (name.endsWith("/") ? 0x10 : 0)) >>> 0,
      38,
    );
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + data.length;
    count++;
  };

  const walk = (relative: string) => {
    // Code-unit order rather than `localeCompare`, which varies by locale.
    const names = readdirSync(join(dir, relative)).sort();
    for (const name of names) {
      const path = join(dir, relative, name);
      const key = relative ? `${relative}/${name}` : name;
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        add(key, 0o120777, Buffer.from(readlinkSync(path), "utf8"));
      } else if (stats.isDirectory()) {
        add(`${key}/`, 0o40755, Buffer.alloc(0));
        walk(key);
      } else {
        add(key, stats.mode & 0o111 ? 0o100755 : 0o100644, readFileSync(path));
      }
    }
  };
  walk("");

  // Zip64 only for the entry count: a pnpm root reaches 65,535 files,
  // directories and links well inside Lambda's 250 MB unzipped cap, but that
  // cap keeps every size and offset inside 32 bits.
  if (offset > 0xffffffff) {
    throw new Error(
      `${dir} zips to ${offset} bytes, over the 4 GiB a zip without Zip64 offsets can hold.`,
    );
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const zip64: Buffer[] = [];
  if (count > 0xffff) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(44), 4);
    record.writeUInt16LE(0x032d, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    zip64.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // 0xffff defers to the Zip64 record.
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, ...zip64, end]);
}
