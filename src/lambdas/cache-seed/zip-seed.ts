import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// eslint-disable-next-line import/no-extraneous-dependencies
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
// eslint-disable-next-line import/no-extraneous-dependencies
import * as yauzl from "yauzl";
import type { Seed, SeedEntry } from "./seed-cache";

const s3Client = new S3Client();

export interface OpenZipSeedProps {
  /** Bucket and key of the init cache's CDK file asset, a zip. */
  readonly bucketName: string;
  readonly key: string;
  /** @default the system temp directory: `/tmp` in Lambda */
  readonly dir?: string;
}

/**
 * Download the init cache asset to `/tmp` and open it, reading each entry only
 * when it is put.
 *
 * Read from disk through the zip's central directory, rather than unzipped as
 * it streams in: CDK's archiver writes sizes after each entry's data, which a
 * streaming reader can't always find the end of. `close` deletes the download,
 * which a warm Lambda would otherwise keep in `/tmp` for its next invoke.
 */
export async function openZipSeed(props: OpenZipSeedProps): Promise<Seed> {
  const path = join(props.dir ?? tmpdir(), `init-cache-${randomUUID()}.zip`);
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: props.bucketName, Key: props.key }),
    );
    await pipeline(object.Body as Readable, createWriteStream(path));
    // `autoClose: false`: entries are read after the listing has ended.
    // yauzl rejects absolute and `..` entry names by itself; `strictFileNames`
    // makes it reject a backslash too, rather than turn it into a `/` and seed
    // a key the cache handler never reads.
    const zipfile = await yauzl.openPromise(path, {
      autoClose: false,
      strictFileNames: true,
    });
    const entries: SeedEntry[] = [];
    try {
      for await (const entry of zipfile.eachEntry()) {
        // Entries for directories themselves are optional, and carry nothing.
        if (entry.fileName.endsWith("/")) continue;
        entries.push({
          key: entry.fileName,
          size: entry.uncompressedSize,
          read: async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of await zipfile.openReadStreamPromise(
              entry,
            )) {
              chunks.push(chunk as Buffer);
            }
            return Buffer.concat(chunks);
          },
        });
      }
    } catch (error) {
      zipfile.close();
      throw error;
    }
    return {
      entries,
      close: async () => {
        zipfile.close();
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}
