/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { ZipFile } from "yazl";
import { openZipSeed } from "./zip-seed";

const holder = { send: jest.fn() };

/**
 * A zip of `files`, written the way CDK's archiver writes one: sizes after
 * each entry's data (`yazl` does that for streamed entries), directory entries
 * included.
 */
async function zipOf(path: string, files: Record<string, string>) {
  const zip = new ZipFile();
  zip.addEmptyDirectory("dir/");
  for (const [name, body] of Object.entries(files)) {
    zip.addReadStreamLazy(name, (callback) => {
      callback(null, Readable.from([Buffer.from(body)]));
    });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  await writeFile(path, Buffer.concat(chunks));
}

describe("openZipSeed", () => {
  let dir: string;
  let downloads: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zip-seed-src-"));
    downloads = mkdtempSync(join(tmpdir(), "zip-seed-tmp-"));
    holder.send.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  });

  function serve(zipPath: string) {
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return { Body: createReadStream(zipPath) };
      }
      throw new Error(`unexpected command ${String(command)}`);
    });
  }

  it("reads every file from the downloaded asset, and deletes it on close", async () => {
    const zipPath = join(dir, "asset.zip");
    await zipOf(zipPath, {
      "index.json": "I",
      "dir/a b+c.json": "A",
      "_use-cache/1.json": "U",
    });
    serve(zipPath);

    const seed = await openZipSeed({
      bucketName: "assets",
      key: "abc.zip",
      dir: downloads,
    });

    expect(holder.send.mock.calls[0][0].input).toEqual({
      Bucket: "assets",
      Key: "abc.zip",
    });
    // The directory entry is left out.
    expect(seed.entries.map((entry) => entry.key).sort()).toEqual([
      "_use-cache/1.json",
      "dir/a b+c.json",
      "index.json",
    ]);
    const bodies = await Promise.all(
      seed.entries.map(async (entry) => [
        entry.key,
        String(await entry.read()),
      ]),
    );
    expect(Object.fromEntries(bodies)).toEqual({
      "index.json": "I",
      "dir/a b+c.json": "A",
      "_use-cache/1.json": "U",
    });
    expect(readdirSync(downloads)).toHaveLength(1);

    await seed.close();

    expect(readdirSync(downloads)).toEqual([]);
  });

  it("deletes the download when it isn't a zip", async () => {
    const notZip = join(dir, "asset.zip");
    await writeFile(notZip, "not a zip");
    serve(notZip);

    await expect(
      openZipSeed({ bucketName: "assets", key: "abc.zip", dir: downloads }),
    ).rejects.toThrow();
    expect(readdirSync(downloads)).toEqual([]);
  });

  it("rejects an entry that would leave the build prefix", async () => {
    const zipPath = join(dir, "asset.zip");
    // yazl refuses to write a `..` name, so patch one in: same length, so the
    // offsets in the zip stay right.
    await zipOf(zipPath, { "xx/a.json": "A" });
    const bytes = readFileSync(zipPath);
    writeFileSync(
      zipPath,
      Buffer.from(
        bytes.toString("latin1").split("xx/a.json").join("../a.json"),
        "latin1",
      ),
    );
    serve(zipPath);

    await expect(
      openZipSeed({ bucketName: "assets", key: "abc.zip", dir: downloads }),
    ).rejects.toThrow(/relative path/);
    expect(readdirSync(downloads)).toEqual([]);
  });
});
