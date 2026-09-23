/* eslint-disable import/no-extraneous-dependencies */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { App, Size, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType } from "aws-cdk-lib/aws-dynamodb";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Source } from "aws-cdk-lib/aws-s3-deployment";
import { NextjsCache } from "./nextjs-cache";

describe("NextjsCache", () => {
  let app: App;
  let stack: Stack;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, "TestStack");
  });

  describe("Basic Construction", () => {
    it("should create S3 bucket and DynamoDB table", () => {
      const cache = new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
        initCacheDir: "/tmp/test-cache",
      });

      expect(cache.cacheBucket).toBeDefined();
      expect(cache.revalidationTable).toBeDefined();
      expect(cache.buildId).toBe("test-build-123");

      const template = Template.fromStack(stack);

      // Verify S3 bucket is created
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });

      // Verify DynamoDB table is created (TableV2 creates GlobalTable resource)
      template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
        KeySchema: [
          {
            AttributeName: "pk",
            KeyType: "HASH",
          },
          {
            AttributeName: "sk",
            KeyType: "RANGE",
          },
        ],
        AttributeDefinitions: [
          {
            AttributeName: "pk",
            AttributeType: "S",
          },
          {
            AttributeName: "sk",
            AttributeType: "S",
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("should apply custom overrides", () => {
      new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
        initCacheDir: "/tmp/test-cache",
        overrides: {
          cacheBucketProps: {
            bucketName: "custom-cache-bucket",
          },
          revalidationTableProps: {
            tableName: "custom-revalidation-table",
            partitionKey: {
              name: "tag",
              type: AttributeType.STRING,
            },
            sortKey: {
              name: "cacheKey",
              type: AttributeType.STRING,
            },
          },
        },
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: "custom-cache-bucket",
      });

      template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
        TableName: "custom-revalidation-table",
      });
    });
  });

  describe("Init cache deployment", () => {
    let initCacheDir: string;
    let outdir: string;

    beforeEach(() => {
      initCacheDir = mkdtempSync(join(tmpdir(), "init-cache-src-"));
      mkdirSync(join(initCacheDir, "server", "app"), { recursive: true });
      writeFileSync(join(initCacheDir, "server", "app", "index.html"), "<p/>");
      outdir = mkdtempSync(join(tmpdir(), "init-cache-out-"));
    });

    afterEach(() => {
      rmSync(initCacheDir, { recursive: true, force: true });
      rmSync(outdir, { recursive: true, force: true });
    });

    /**
     * The tag `BucketDeployment` stamps on its destination bucket, and the only
     * one that can vary between two builds. `Tags` on an `AWS::S3::Bucket` are
     * not hotswappable, so a tag key that carries the build ID costs a full
     * CloudFormation deployment on every deploy.
     */
    function ownerTags(template: Template): string[] {
      const buckets = template.findResources("AWS::S3::Bucket");
      return Object.values(buckets)
        .flatMap((bucket) => bucket.Properties?.Tags ?? [])
        .map((tag: { Key: string }) => tag.Key)
        .filter((key) => key.startsWith("aws-cdk:cr-owned"));
    }

    function synth(buildId: string) {
      const ownApp = new App({ outdir: mkdtempSync(join(outdir, "app-")) });
      const ownStack = new Stack(ownApp, "TestStack");
      new NextjsCache(ownStack, "TestCache", { buildId, initCacheDir });
      return { app: ownApp, template: Template.fromStack(ownStack) };
    }

    it("keys the objects under the build ID without a destinationKeyPrefix", () => {
      const { app: ownApp, template } = synth("build-abc123");

      // Not `DestinationBucketKeyPrefix: Match.absent()` on its own: that would
      // also pass if the staged tree had lost the build ID, which is what keeps
      // the S3 keys the same as before this moved.
      const deployments = template.findResources("Custom::CDKBucketDeployment");
      expect(Object.keys(deployments)).toHaveLength(1);
      expect(Object.values(deployments)[0].Properties).not.toHaveProperty(
        "DestinationBucketKeyPrefix",
      );

      const assembly = ownApp.synth();
      const stagedUnderBuildId = readdirSync(assembly.directory, {
        withFileTypes: true,
      }).some(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith("asset.") &&
          readdirSync(join(assembly.directory, entry.name)).includes(
            "build-abc123",
          ),
      );
      expect(stagedUnderBuildId).toBe(true);
    });

    it("tags the cache bucket the same way whatever the build ID", () => {
      const first = ownerTags(synth("build-abc123").template);
      const second = ownerTags(synth("build-def456").template);

      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(/^aws-cdk:cr-owned:[0-9a-f]{8}$/);
      expect(second).toEqual(first);
    });

    /**
     * The unzip Lambda holds the asset zip and its extracted contents in `/tmp`
     * at once, so a seed directory bigger than the 512 MiB CDK asks for by
     * default kills it with `[Errno 28] No space left on device` — and under
     * `cdk deploy --hotswap` that failure is invisible, because the CLI hands the
     * custom resource a placeholder response URL and never reads its status.
     */
    function deploymentLambda(template: Template) {
      const functions = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "index.handler",
          Runtime: Match.stringLikeRegexp("^python"),
        },
      });
      expect(Object.keys(functions)).toHaveLength(1);
      return Object.values(functions)[0].Properties;
    }

    it("leaves a small init cache on the default Lambda sizing", () => {
      const properties = deploymentLambda(synth("build-abc123").template);

      // The floor, not a computed value: a handful of bytes still wants 512 MiB
      // because that is the least Lambda will give.
      expect(properties.EphemeralStorage).toEqual({ Size: 512 });
      // Absent, not 128: leaving `memoryLimit` alone keeps the property out of
      // the template, which is Lambda's own 128 MB default.
      expect(properties.MemorySize).toBeUndefined();
    });

    it("scales /tmp and memory to a large init cache", () => {
      // A sparse file: `statSync` reports 300 MiB, the filesystem stores almost
      // nothing, and the zip of a 300 MiB hole costs no real work.
      const big = join(initCacheDir, "server", "app", "big.rsc");
      writeFileSync(big, "");
      truncateSync(big, 300 * 1024 * 1024);

      const properties = deploymentLambda(synth("build-abc123").template);

      // 301 MiB of cache — the 300 MiB hole plus the fixture's own file, rounded
      // up — doubled for the zip that sits beside it, plus headroom.
      expect(properties.EphemeralStorage).toEqual({ Size: 730 });
      expect(properties.MemorySize).toBe(1024);
    });

    it("lets overrides win over the computed sizing", () => {
      const ownApp = new App({ outdir: mkdtempSync(join(outdir, "app-")) });
      const ownStack = new Stack(ownApp, "TestStack");
      new NextjsCache(ownStack, "TestCache", {
        buildId: "build-abc123",
        initCacheDir,
        overrides: {
          bucketDeploymentProps: {
            destinationBucket: Bucket.fromBucketName(
              ownStack,
              "Existing",
              "someone-elses-bucket",
            ),
            sources: [Source.data("marker", "x")],
            ephemeralStorageSize: Size.gibibytes(2),
            memoryLimit: 2048,
          },
        },
      });

      const properties = deploymentLambda(Template.fromStack(ownStack));
      expect(properties.EphemeralStorage).toEqual({ Size: 2048 });
      expect(properties.MemorySize).toBe(2048);
    });
  });
});
