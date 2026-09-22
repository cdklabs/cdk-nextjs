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
    return Promise.resolve({ Metadata: { "next-build-id": buildId } });
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
});
