/* eslint-disable import/no-extraneous-dependencies */
// Only the client is mocked; the command classes stay real so that assertions
// can read `command.input`. `send` is looked up through the holder at call time
// because `prune-s3` constructs its client at module scope, before the mock
// variables here are initialized.
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { pruneS3 } from "./prune-s3";

const holder = { send: jest.fn() };

const BUCKET = "my-static-assets";
const CURRENT_BUILD_ID = "build-2";
const MS_TTL = 1000 * 60 * 60 * 24 * 30;

/**
 * One page of listed objects, all old enough to prune and each carrying a stale
 * build id, so every one of them is a deletion candidate. That isolates the
 * question this suite is about: which keys `pruneS3` was ever shown.
 */
function stubBucketContents(keys: string[], buildId = "build-1"): void {
  const longAgo = new Date(Date.now() - MS_TTL * 2);
  holder.send.mockImplementation((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({
        Contents: keys.map((Key) => ({ Key, LastModified: longAgo })),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      return Promise.resolve({});
    }
    // HeadObject
    return Promise.resolve({ Metadata: { build_id: buildId } });
  });
}

/**
 * Several pages of listed objects, keyed by the continuation token that asks for
 * each one, so the suite can assert how `pruneS3` walks a paginated listing. The
 * last page deliberately carries no NextContinuationToken, as S3 returns it.
 */
function stubPagedBucketContents(pages: string[][]): void {
  const longAgo = new Date(Date.now() - MS_TTL * 2);
  holder.send.mockImplementation((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const token = command.input.ContinuationToken;
      const index = token ? Number(token.replace("page-", "")) : 0;
      return Promise.resolve({
        Contents: (pages[index] ?? []).map((Key) => ({
          Key,
          LastModified: longAgo,
        })),
        NextContinuationToken:
          index + 1 < pages.length ? `page-${index + 1}` : undefined,
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      return Promise.resolve({});
    }
    // HeadObject
    return Promise.resolve({ Metadata: { build_id: "build-1" } });
  });
}

function sentCommands<T>(type: new (...args: any[]) => T): T[] {
  return holder.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof type);
}

function listPrefixes(): (string | undefined)[] {
  return sentCommands(ListObjectsV2Command).map(
    (command) => command.input.Prefix,
  );
}

function deletedKeys(): string[] {
  return sentCommands(DeleteObjectsCommand).flatMap((command) =>
    (command.input.Delete?.Objects ?? []).map((o) => o.Key as string),
  );
}

function prune(keyPrefix?: string) {
  return pruneS3({
    bucketName: BUCKET,
    currentBuildId: CURRENT_BUILD_ID,
    msTtl: MS_TTL,
    keyPrefix,
  });
}

describe("pruneS3", () => {
  beforeEach(() => {
    holder.send.mockReset();
  });

  // Without a Prefix, pruning walks the whole bucket. Two branches sharing one
  // bucket under different basePaths would then delete each other's assets once
  // they aged past msTtl, 404ing the other branch.
  it("scopes the listing to the key prefix", async () => {
    stubBucketContents(["branch-a/_next/static/old.js"]);

    await prune("branch-a");

    expect(listPrefixes()).toEqual(["branch-a/"]);
  });

  // A bare "branch-a" prefix also matches "branch-a-staging/...", which is a
  // different app's objects.
  it("terminates the prefix with a slash", async () => {
    stubBucketContents([]);

    await prune("branch-a");

    // Asserted as an exact value: a bare "branch-a", and an absent prefix, both
    // reach objects belonging to another app.
    expect(listPrefixes()).toEqual(["branch-a/"]);
  });

  it("takes a nested prefix as NextjsStaticAssets resolved it", async () => {
    stubBucketContents([]);

    await prune("team/app");

    expect(listPrefixes()).toEqual(["team/app/"]);
  });

  // The single-app case, and every deployment predating the prefix being
  // threaded through: an unset prefix still prunes the whole bucket.
  it.each([
    ["omitted", undefined],
    ["empty", ""],
  ])("lists the whole bucket when the prefix is %s", async (_label, prefix) => {
    stubBucketContents([]);

    await prune(prefix);

    expect(listPrefixes()).toEqual([undefined]);
  });

  it("still deletes stale objects within the prefix", async () => {
    stubBucketContents([
      "branch-a/_next/static/old.js",
      "branch-a/favicon.ico",
    ]);

    await prune("branch-a");

    expect(deletedKeys().sort()).toEqual([
      "branch-a/_next/static/old.js",
      "branch-a/favicon.ico",
    ]);
  });

  it("keeps objects carrying the current build id", async () => {
    stubBucketContents(["branch-a/current.js"], CURRENT_BUILD_ID);

    await prune("branch-a");

    expect(deletedKeys()).toEqual([]);
  });

  // Asserted on the literal key rather than through a shared constant: the name
  // is a contract with CDK, which lowercases the `metadata: { BUILD_ID }` that
  // `NextjsStaticAssets` passes `BucketDeployment`. Reading any other name — this
  // file read "next-build-id" for a long time — makes `objectBuildId` always
  // `undefined`, and a guard that never fires cannot be told from one that has
  // nothing to keep.
  it("reads the build id from the metadata key BucketDeployment writes", async () => {
    const longAgo = new Date(Date.now() - MS_TTL * 2);
    holder.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({
          Contents: [{ Key: "branch-a/current.js", LastModified: longAgo }],
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({
        Metadata: { build_id: CURRENT_BUILD_ID },
      });
    });

    await prune("branch-a");

    expect(deletedKeys()).toEqual([]);
  });

  // Not this construct's object: `BucketDeployment` stamps every file it uploads,
  // so an unstamped one belongs to something else sharing the bucket. Deleting it
  // 404s whatever serves it, while keeping it only costs storage.
  it("keeps an object that carries no build id at all", async () => {
    const longAgo = new Date(Date.now() - MS_TTL * 2);
    holder.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({
          Contents: [
            { Key: "branch-a/someone-elses.js", LastModified: longAgo },
          ],
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({ Metadata: {} });
    });

    await prune("branch-a");

    expect(deletedKeys()).toEqual([]);
  });

  // The construct always hands over a bare prefix, but
  // `overrides.customResourceProperties.staticAssetsKeyPrefix` reaches this
  // directly. "base/" would build a Prefix of "base//" and "/base" one of
  // "/base/", neither of which matches any key, so pruning would silently stop
  // deleting anything at all.
  it.each([
    ["a trailing slash", "branch-a/"],
    ["a leading slash", "/branch-a"],
    ["both", "/branch-a/"],
  ])("normalizes a prefix given with %s", async (_label, prefix) => {
    stubBucketContents([]);

    await prune(prefix);

    expect(listPrefixes()).toEqual(["branch-a/"]);
  });

  describe("pagination", () => {
    it("follows the continuation token across pages", async () => {
      stubPagedBucketContents([["a/one.js"], ["a/two.js"], ["a/three.js"]]);

      await prune("a");

      expect(
        sentCommands(ListObjectsV2Command).map(
          (command) => command.input.ContinuationToken,
        ),
      ).toEqual([undefined, "page-1", "page-2"]);
      expect(deletedKeys().sort()).toEqual([
        "a/one.js",
        "a/three.js",
        "a/two.js",
      ]);
    });

    // The last page carries no NextContinuationToken. Holding on to the previous
    // page's token re-lists that page until the 100-iteration guard trips,
    // re-HEADing every object on it 100 times over (~100k requests for a full
    // 1000-key page) and pushing duplicate keys into the delete batches — enough
    // to blow the post-deploy Lambda's timeout, which leaves the custom resource
    // waiting on a response that never comes.
    it("stops listing once a page returns no continuation token", async () => {
      stubPagedBucketContents([["a/one.js"], ["a/two.js"]]);

      await prune("a");

      expect(sentCommands(ListObjectsV2Command)).toHaveLength(2);
      expect(deletedKeys()).toEqual(["a/one.js", "a/two.js"]);
    });

    // S3 scans a window of the bucket per request and filters by `Prefix`
    // afterwards, so a page can come back with no `Contents` and still have a
    // continuation token — exactly the shared-bucket case `keyPrefix` exists for.
    // Stopping there left every older asset past that window undeleted, and the
    // bucket grew without bound with nothing in the logs to say so.
    it("keeps listing past a page whose window held no matching key", async () => {
      stubPagedBucketContents([["a/one.js"], [], ["a/three.js"]]);

      await prune("a");

      expect(sentCommands(ListObjectsV2Command)).toHaveLength(3);
      expect(deletedKeys().sort()).toEqual(["a/one.js", "a/three.js"]);
    });
  });
});
