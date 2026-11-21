/* eslint-disable import/no-extraneous-dependencies */
// Only the client is mocked, as in `prune-cache-bucket.test.ts`: `seed-cache`
// constructs its client at module scope, before the mock variables exist.
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { seedCache } from "./seed-cache";

const holder = { send: jest.fn() };

const BUCKET = "cache-bucket";

function s3Error(status: number, name: string): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

/**
 * A fake bucket holding `objects` (key → body). ListObjectsV2 honours `Prefix`
 * and pages `pageSize` keys at a time; HeadObject 404s on a missing key;
 * CopyObject and PutObject honour `IfNoneMatch: "*"` with a 412, as S3 does.
 * `onCopy` runs before each copy lands, to simulate a concurrent write.
 */
function stubBucket(
  objects: Map<string, string>,
  options: { pageSize?: number; onCopy?: (key: string) => void } = {},
) {
  const { pageSize = 2, onCopy } = options;
  holder.send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const { Prefix = "", ContinuationToken } = command.input;
      const keys = [...objects.keys()].filter((k) => k.startsWith(Prefix));
      const offset = Number(ContinuationToken ?? 0);
      return {
        Contents: keys.slice(offset, offset + pageSize).map((Key) => ({ Key })),
        NextContinuationToken:
          offset + pageSize < keys.length
            ? String(offset + pageSize)
            : undefined,
      };
    }
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(command.input.Key!)) throw s3Error(404, "NotFound");
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const { Key, CopySource, IfNoneMatch } = command.input;
      onCopy?.(Key!);
      if (IfNoneMatch === "*" && objects.has(Key!)) {
        throw s3Error(412, "PreconditionFailed");
      }
      const source = decodeURIComponent(CopySource!.slice(`${BUCKET}/`.length));
      objects.set(Key!, objects.get(source)!);
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const { Key, IfNoneMatch } = command.input;
      if (IfNoneMatch === "*" && objects.has(Key!)) {
        throw s3Error(412, "PreconditionFailed");
      }
      objects.set(Key!, String(command.input.Body));
      return {};
    }
    throw new Error(`unexpected command ${String(command)}`);
  });
}

function sent<T>(type: new (...args: any[]) => T): T[] {
  return holder.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof type);
}

function seedOf(buildId: string, entries: Record<string, string>) {
  return new Map(
    Object.entries(entries).map(([key, body]) => [
      `_seed/${buildId}/${key}`,
      body,
    ]),
  );
}

describe("seedCache", () => {
  beforeEach(() => {
    holder.send.mockReset();
  });

  it("copies every seed object into the build prefix, then writes the marker", async () => {
    const objects = seedOf("b1", {
      "a.json": "A",
      "b.json": "B",
      "_use-cache/1.entry": "U",
    });
    stubBucket(objects);

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result).toEqual({ status: "seeded", copied: 3, skipped: 0 });
    expect(objects.get("b1/a.json")).toBe("A");
    expect(objects.get("b1/b.json")).toBe("B");
    expect(objects.get("b1/_use-cache/1.entry")).toBe("U");
    expect(objects.has("b1/.seeded")).toBe(true);
    for (const copy of sent(CopyObjectCommand)) {
      expect(copy.input.IfNoneMatch).toBe("*");
    }
    // The marker is the last write.
    const writes = holder.send.mock.calls
      .map(([command]) => command)
      .filter(
        (c) => c instanceof CopyObjectCommand || c instanceof PutObjectCommand,
      );
    expect(writes.at(-1)).toBeInstanceOf(PutObjectCommand);
    expect((writes.at(-1) as PutObjectCommand).input.Key).toBe("b1/.seeded");
  });

  // seed A → runtime update B → failed deployment → rollback → still B, and
  // the same for a re-deploy of the same build.
  it("copies nothing once the build is marked seeded", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    objects.set("b1/a.json", "B (regenerated at runtime)");
    objects.set("b1/.seeded", "2026-11-19T00:00:00.000Z");
    stubBucket(objects);

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result).toEqual({ status: "already-seeded", copied: 0, skipped: 0 });
    expect(objects.get("b1/a.json")).toBe("B (regenerated at runtime)");
    expect(sent(CopyObjectCommand)).toHaveLength(0);
    expect(sent(ListObjectsV2Command)).toHaveLength(0);
  });

  it("does not bring back an entry the app deleted after seeding", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    objects.set("b1/.seeded", "2026-11-19T00:00:00.000Z");
    stubBucket(objects);

    await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(objects.has("b1/a.json")).toBe(false);
  });

  // A partially completed seed followed by a retry.
  it("skips what an earlier attempt or the app already wrote", async () => {
    const objects = seedOf("b1", { "a.json": "A", "b.json": "B" });
    objects.set("b1/a.json", "A (written by the app)");
    stubBucket(objects);

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result).toEqual({ status: "seeded", copied: 1, skipped: 1 });
    expect(objects.get("b1/a.json")).toBe("A (written by the app)");
    expect(objects.get("b1/b.json")).toBe("B");
  });

  // Regeneration happening while the seed runs.
  it("lets a write racing the copy win", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    stubBucket(objects, {
      onCopy: (key) => objects.set(key, "A (regenerated mid-seed)"),
    });

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result.skipped).toBe(1);
    expect(objects.get("b1/a.json")).toBe("A (regenerated mid-seed)");
  });

  it("retries a 409 conditional conflict until the racing write lands", async () => {
    const objects = seedOf("b1", { "a.json": "A", "b.json": "B" });
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    holder.send.mockImplementation(async (command: unknown) => {
      if (
        command instanceof CopyObjectCommand &&
        command.input.Key === "b1/a.json" &&
        !objects.has("b1/a.json")
      ) {
        // The racing write lands once this one has been told about it.
        objects.set("b1/a.json", "A (app)");
        throw s3Error(409, "ConditionalRequestConflict");
      }
      return fake(command);
    });

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result).toEqual({ status: "seeded", copied: 1, skipped: 1 });
    expect(objects.get("b1/a.json")).toBe("A (app)");
  });

  it("copies a key once a 409 conflict's racing write has failed", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    let conflicts = 1;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand && conflicts-- > 0) {
        throw s3Error(409, "ConditionalRequestConflict");
      }
      return fake(command);
    });

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result).toEqual({ status: "seeded", copied: 1, skipped: 0 });
    expect(objects.get("b1/a.json")).toBe("A");
  });

  it("writes no marker when a 409 conflict persists", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) {
        throw s3Error(409, "ConditionalRequestConflict");
      }
      return fake(command);
    });

    await expect(
      seedCache({ bucketName: BUCKET, buildId: "b1" }),
    ).rejects.toThrow("ConditionalRequestConflict");
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("stops retrying a 409 conflict at the deadline", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    let copies = 0;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) {
        copies++;
        throw s3Error(409, "ConditionalRequestConflict");
      }
      return fake(command);
    });

    const start = Date.now();
    await expect(
      seedCache({ bucketName: BUCKET, buildId: "b1", deadline: start + 250 }),
    ).rejects.toThrow("ConditionalRequestConflict");
    // 100 ms then 200 ms would end past the deadline: two attempts, not five.
    expect(copies).toBe(2);
    expect(Date.now() - start).toBeLessThan(400);
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("starts no copy after one has failed", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}.json`, String(i)]),
    );
    const objects = seedOf("b1", files);
    stubBucket(objects, { pageSize: 1000 });
    const fake = holder.send.getMockImplementation()!;
    let copies = 0;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) {
        copies++;
        if (command.input.Key === "b1/k0.json") throw s3Error(500, "Internal");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return fake(command);
    });

    await expect(
      seedCache({ bucketName: BUCKET, buildId: "b1" }),
    ).rejects.toThrow("Internal");
    // Long enough for the 68 queued copies to start, were nothing stopping them.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Exactly the first copy of each of the 32 workers, already in flight
    // when the first failed.
    expect(copies).toBe(32);
  });

  it("writes no marker when a copy fails, so the next attempt seeds", async () => {
    const objects = seedOf("b1", { "a.json": "A", "b.json": "B" });
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    holder.send.mockImplementation(async (command: unknown) => {
      if (
        command instanceof CopyObjectCommand &&
        command.input.Key === "b1/b.json"
      ) {
        throw s3Error(503, "SlowDown");
      }
      return fake(command);
    });

    await expect(
      seedCache({ bucketName: BUCKET, buildId: "b1" }),
    ).rejects.toThrow("SlowDown");
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("writes no marker when there is no seed to copy", async () => {
    const objects = seedOf("other", { "a.json": "A" });
    stubBucket(objects);

    const result = await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(result).toEqual({ status: "no-seed", copied: 0, skipped: 0 });
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("only reads its own build's seed", async () => {
    const objects = new Map([
      ...seedOf("b1", { "a.json": "A1" }),
      ...seedOf("b10", { "a.json": "A10" }),
    ]);
    stubBucket(objects);

    await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(objects.get("b1/a.json")).toBe("A1");
    expect(objects.has("b10/a.json")).toBe(false);
  });

  it("encodes the copy source key", async () => {
    const objects = seedOf("b1", { "dir/a b+c.json": "A" });
    stubBucket(objects);

    await seedCache({ bucketName: BUCKET, buildId: "b1" });

    expect(sent(CopyObjectCommand)[0].input.CopySource).toBe(
      `${BUCKET}/_seed/b1/dir/a%20b%2Bc.json`,
    );
  });

  it("fails without a marker once past its deadline", async () => {
    const objects = seedOf("b1", { "a.json": "A" });
    stubBucket(objects);

    await expect(
      seedCache({ bucketName: BUCKET, buildId: "b1", deadline: 0 }),
    ).rejects.toThrow("ran out of time");
    expect(objects.has("b1/.seeded")).toBe(false);
  });
});
