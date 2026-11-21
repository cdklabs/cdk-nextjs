/* eslint-disable import/no-extraneous-dependencies */
// Only the client is mocked, as in `prune-cache-bucket.test.ts`: `seed-cache`
// constructs its client at module scope, before the mock variables exist.
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Seed, seedCache, SeedCacheProps } from "./seed-cache";

const holder = { send: jest.fn() };

const BUCKET = "cache-bucket";

function s3Error(status: number, name: string): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

/**
 * A fake bucket holding `objects` (key → body). HeadObject 404s on a missing
 * key; PutObject honours `IfNoneMatch: "*"` with a 412, as S3 does. `onPut`
 * runs before each entry's put lands, to simulate a concurrent write.
 */
function stubBucket(
  objects: Map<string, string>,
  options: { onPut?: (key: string) => void } = {},
) {
  const { onPut } = options;
  holder.send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(command.input.Key!)) throw s3Error(404, "NotFound");
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const { Key, IfNoneMatch } = command.input;
      if (!Key!.endsWith("/.seeded")) onPut?.(Key!);
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

/** The puts of entries, not the marker's. */
function entryPuts(): PutObjectCommand[] {
  return sent(PutObjectCommand).filter(
    (put) => !put.input.Key!.endsWith("/.seeded"),
  );
}

/** An init cache of `files` (key → body), counting its opens and closes. */
function seedOf(files: Record<string, string>) {
  const state = { opened: 0, closed: 0 };
  const openSeed = async (): Promise<Seed> => {
    state.opened++;
    return {
      entries: Object.entries(files).map(([key, body]) => ({
        key,
        size: Buffer.byteLength(body),
        read: async () => Buffer.from(body),
      })),
      close: async () => {
        state.closed++;
      },
    };
  };
  return { openSeed, state };
}

function seed(
  files: Record<string, string>,
  props: Partial<SeedCacheProps> = {},
) {
  return seedCache({
    bucketName: BUCKET,
    buildId: "b1",
    openSeed: seedOf(files).openSeed,
    ...props,
  });
}

/** Fail every entry put S3 would otherwise accept with `status`. */
function failPuts(status: number, name: string, key?: string) {
  const fake = holder.send.getMockImplementation()!;
  let puts = 0;
  holder.send.mockImplementation(async (command: unknown) => {
    if (
      command instanceof PutObjectCommand &&
      !command.input.Key!.endsWith("/.seeded") &&
      (!key || command.input.Key === key)
    ) {
      puts++;
      throw s3Error(status, name);
    }
    return fake(command);
  });
  return { puts: () => puts };
}

/** Fail the first put to `key` with `status`, as a racing write would. */
function failPutsOnce(status: number, key: string) {
  const fake = holder.send.getMockImplementation()!;
  let failed = false;
  holder.send.mockImplementation(async (command: unknown) => {
    if (
      !failed &&
      command instanceof PutObjectCommand &&
      command.input.Key === key
    ) {
      failed = true;
      throw s3Error(status, "ConditionalRequestConflict");
    }
    return fake(command);
  });
}

describe("seedCache", () => {
  beforeEach(() => {
    holder.send.mockReset();
  });

  it("writes every entry into the build prefix, then the marker", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    const { openSeed, state } = seedOf({
      "a.json": "A",
      "b.json": "B",
      "_use-cache/1.json": "U",
    });

    const result = await seedCache({
      bucketName: BUCKET,
      buildId: "b1",
      openSeed,
    });

    expect(result).toEqual({ status: "seeded", written: 3, skipped: 0 });
    expect(objects.get("b1/a.json")).toBe("A");
    expect(objects.get("b1/b.json")).toBe("B");
    expect(objects.get("b1/_use-cache/1.json")).toBe("U");
    expect(objects.has("b1/.seeded")).toBe(true);
    for (const put of entryPuts()) {
      expect(put.input).toMatchObject({
        Bucket: BUCKET,
        IfNoneMatch: "*",
        ContentType: "application/json",
      });
    }
    // The marker is the last write.
    expect(sent(PutObjectCommand).at(-1)!.input.Key).toBe("b1/.seeded");
    expect(state).toEqual({ opened: 1, closed: 1 });
  });

  // seed A → runtime update B → failed deployment → rollback → still B, and
  // the same for a re-deploy of the same build.
  it("writes nothing once the build is marked seeded", async () => {
    const objects = new Map([
      ["b1/a.json", "B (regenerated at runtime)"],
      ["b1/.seeded", "2026-11-19T00:00:00.000Z"],
    ]);
    stubBucket(objects);
    const { openSeed, state } = seedOf({ "a.json": "A" });

    const result = await seedCache({
      bucketName: BUCKET,
      buildId: "b1",
      openSeed,
    });

    expect(result).toEqual({
      status: "already-seeded",
      written: 0,
      skipped: 0,
    });
    expect(objects.get("b1/a.json")).toBe("B (regenerated at runtime)");
    expect(sent(PutObjectCommand)).toHaveLength(0);
    // Not even downloaded.
    expect(state.opened).toBe(0);
  });

  it("does not bring back an entry the app deleted after seeding", async () => {
    const objects = new Map([["b1/.seeded", "2026-11-19T00:00:00.000Z"]]);
    stubBucket(objects);

    await seed({ "a.json": "A" });

    expect(objects.has("b1/a.json")).toBe(false);
  });

  // A partially completed seed followed by a retry.
  it("skips what an earlier attempt or the app already wrote", async () => {
    const objects = new Map([["b1/a.json", "A (written by the app)"]]);
    stubBucket(objects);

    const result = await seed({ "a.json": "A", "b.json": "B" });

    expect(result).toEqual({ status: "seeded", written: 1, skipped: 1 });
    expect(objects.get("b1/a.json")).toBe("A (written by the app)");
    expect(objects.get("b1/b.json")).toBe("B");
  });

  // Regeneration happening while the seed runs.
  it("lets a write racing the put win", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects, {
      onPut: (key) => objects.set(key, "A (regenerated mid-seed)"),
    });

    const result = await seed({ "a.json": "A" });

    expect(result.skipped).toBe(1);
    expect(objects.get("b1/a.json")).toBe("A (regenerated mid-seed)");
  });

  it("only writes under its own build", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);

    await seed({ "a.json": "A" }, { buildId: "b10" });

    expect([...objects.keys()].sort()).toEqual(["b10/.seeded", "b10/a.json"]);
  });

  it("retries a 409 conditional conflict until the racing write lands", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    holder.send.mockImplementation(async (command: unknown) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key === "b1/a.json" &&
        !objects.has("b1/a.json")
      ) {
        // The racing write lands once this one has been told about it.
        objects.set("b1/a.json", "A (app)");
        throw s3Error(409, "ConditionalRequestConflict");
      }
      return fake(command);
    });

    const result = await seed({ "a.json": "A", "b.json": "B" });

    expect(result).toEqual({ status: "seeded", written: 1, skipped: 1 });
    expect(objects.get("b1/a.json")).toBe("A (app)");
  });

  it("writes a key once a 409 conflict's racing write has failed", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    let conflicts = 1;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand && conflicts-- > 0) {
        throw s3Error(409, "ConditionalRequestConflict");
      }
      return fake(command);
    });

    const result = await seed({ "a.json": "A" });

    expect(result).toEqual({ status: "seeded", written: 1, skipped: 0 });
    expect(objects.get("b1/a.json")).toBe("A");
  });

  it("writes no marker when a 409 conflict persists", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    failPuts(409, "ConditionalRequestConflict");

    await expect(seed({ "a.json": "A" })).rejects.toThrow(
      "ConditionalRequestConflict",
    );
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("stops retrying a 409 conflict at the deadline", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    const { puts } = failPuts(409, "ConditionalRequestConflict");

    // A frozen clock, so the deadline check doesn't depend on how fast the
    // runner is: each backoff is judged against the same "now".
    const start = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(start);
    try {
      await expect(
        seed({ "a.json": "A" }, { deadline: start + 250 }),
      ).rejects.toThrow(
        "ran out of time retrying a conflicting write to b1/a.json",
      );
    } finally {
      now.mockRestore();
    }
    // Backoffs of 100 and 200 ms fit before the deadline, 400 ms doesn't:
    // three attempts, not five.
    expect(puts()).toBe(3);
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("starts no put after one has failed, and still closes the seed", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}.json`, String(i)]),
    );
    const objects = new Map<string, string>();
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    let puts = 0;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        puts++;
        if (command.input.Key === "b1/k0.json") throw s3Error(500, "Internal");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return fake(command);
    });
    const { openSeed, state } = seedOf(files);

    await expect(
      seedCache({ bucketName: BUCKET, buildId: "b1", openSeed }),
    ).rejects.toThrow("Internal");
    // Long enough for the 68 queued puts to start, were nothing stopping them.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Exactly the first put of each of the 32 workers, already in flight
    // when the first failed.
    expect(puts).toBe(32);
    expect(state.closed).toBe(1);
  });

  it("closes the seed only once the puts in flight have settled", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    let settled = 0;
    holder.send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        if (command.input.Key === "b1/k0.json") throw s3Error(500, "Internal");
        await new Promise((resolve) => setTimeout(resolve, 20));
        settled++;
      }
      return fake(command);
    });
    let settledAtClose = -1;

    await expect(
      seedCache({
        bucketName: BUCKET,
        buildId: "b1",
        openSeed: async () => ({
          entries: ["k0", "k1", "k2"].map((name) => ({
            key: `${name}.json`,
            size: 1,
            read: async () => Buffer.from(name),
          })),
          close: async () => {
            settledAtClose = settled;
          },
        }),
      }),
    ).rejects.toThrow("Internal");
    // k1 and k2 were in flight when k0 failed: closing the zip under them
    // would fail their reads, and reporting FAILED would race their puts.
    expect(settledAtClose).toBe(2);
  });

  it("holds back entries past 128 MiB in flight, but still puts a bigger one", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    const fake = holder.send.getMockImplementation()!;
    let inFlight = 0;
    let peak = 0;
    holder.send.mockImplementation(async (command: unknown) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key !== "b1/.seeded"
      ) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      }
      return fake(command);
    });
    const MIB = 1024 ** 2;

    const result = await seedCache({
      bucketName: BUCKET,
      buildId: "b1",
      openSeed: async () => ({
        entries: [
          // Bigger than the budget on its own: put, alone.
          {
            key: "huge.json",
            size: 200 * MIB,
            read: async () => Buffer.from("H"),
          },
          ...Array.from({ length: 6 }, (_, i) => ({
            key: `big${i}.json`,
            size: 50 * MIB,
            read: async () => Buffer.from(String(i)),
          })),
        ],
        close: async () => {},
      }),
    });

    expect(result).toEqual({ status: "seeded", written: 7, skipped: 0 });
    // Two 50 MiB entries fit in 128 MiB, a third doesn't.
    expect(peak).toBe(2);
  });

  it("retries the marker's 409 like an entry's", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    failPutsOnce(409, "b1/.seeded");

    const result = await seed({ "a.json": "A" });

    expect(result.status).toBe("seeded");
    expect(objects.has("b1/.seeded")).toBe(true);
  });

  it("takes a marker another seed of the build wrote first", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects, {
      onPut: () => objects.set("b1/.seeded", "the other seed's"),
    });

    const result = await seed({ "a.json": "A" });

    expect(result.status).toBe("seeded");
    expect(objects.get("b1/.seeded")).toBe("the other seed's");
  });

  it("writes no marker when a put fails, so the next attempt seeds", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);
    failPuts(503, "SlowDown", "b1/b.json");

    await expect(seed({ "a.json": "A", "b.json": "B" })).rejects.toThrow(
      "SlowDown",
    );
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("writes no marker when reading an entry fails", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);

    await expect(
      seedCache({
        bucketName: BUCKET,
        buildId: "b1",
        openSeed: async () => ({
          entries: [
            {
              key: "a.json",
              size: 1,
              read: async () => {
                throw new Error("invalid zip");
              },
            },
          ],
          close: async () => {},
        }),
      }),
    ).rejects.toThrow("invalid zip");
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("writes no marker when there is nothing to seed", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);

    const result = await seed({});

    expect(result).toEqual({ status: "no-seed", written: 0, skipped: 0 });
    expect(objects.has("b1/.seeded")).toBe(false);
  });

  it("fails without a marker once past its deadline", async () => {
    const objects = new Map<string, string>();
    stubBucket(objects);

    await expect(seed({ "a.json": "A" }, { deadline: 0 })).rejects.toThrow(
      "ran out of time",
    );
    expect(objects.has("b1/.seeded")).toBe(false);
  });
});
