/* eslint-disable import/no-extraneous-dependencies */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { App, Duration, Size, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType } from "aws-cdk-lib/aws-dynamodb";
import {
  measureDirectory,
  NextjsCache,
  NextjsCacheProps,
} from "./nextjs-cache";

describe("NextjsCache", () => {
  let app: App;
  let stack: Stack;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, "TestStack");
  });

  describe("Basic Construction", () => {
    it("creates no seeder without an init cache", () => {
      const cache = new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
        initCacheDir: "/tmp/does-not-exist-cdk-nextjs-init-cache",
      });

      expect(cache.cacheSeed).toBeUndefined();
      expect(cache.cacheSeedFunction).toBeUndefined();
      Template.fromStack(stack).resourceCountIs(
        "Custom::CDKBucketDeployment",
        0,
      );
    });

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

    it("denies requests to the cache bucket below TLS 1.2", () => {
      new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
        initCacheDir: "/tmp/test-cache",
      });
      Template.fromStack(stack).hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Action: "s3:*",
              Condition: { NumericLessThan: { "s3:TlsVersion": 1.2 } },
            }),
          ]),
        },
      });
    });

    // The 'use cache' revalidation log's rows expire through `ttl`.
    it("expires revalidation log rows through a TTL attribute", () => {
      new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
        initCacheDir: "/tmp/test-cache",
      });
      Template.fromStack(stack).hasResourceProperties(
        "AWS::DynamoDB::GlobalTable",
        {
          TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        },
      );
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
            timeToLiveAttribute: "expiresAt",
          },
        },
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: "custom-cache-bucket",
      });

      template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
        TableName: "custom-revalidation-table",
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      });
    });
  });

  describe("Init cache seed", () => {
    let initCacheDir: string;
    let outdir: string;

    beforeEach(() => {
      initCacheDir = mkdtempSync(join(tmpdir(), "init-cache-src-"));
      mkdirSync(join(initCacheDir, "server", "app"), { recursive: true });
      writeFileSync(join(initCacheDir, "server", "app", "index.json"), "{}");
      outdir = mkdtempSync(join(tmpdir(), "init-cache-out-"));
    });

    afterEach(() => {
      rmSync(initCacheDir, { recursive: true, force: true });
      rmSync(outdir, { recursive: true, force: true });
    });

    function synth(buildId: string, overrides?: NextjsCacheProps["overrides"]) {
      const ownApp = new App({ outdir: mkdtempSync(join(outdir, "app-")) });
      const ownStack = new Stack(ownApp, "TestStack");
      const cache = new NextjsCache(ownStack, "TestCache", {
        buildId,
        initCacheDir,
        overrides,
      });
      return { app: ownApp, cache, template: Template.fromStack(ownStack) };
    }

    function seedResource(template: Template) {
      const seeds = template.findResources("Custom::CDKBucketDeployment");
      expect(Object.keys(seeds)).toHaveLength(1);
      return Object.values(seeds)[0];
    }

    /** The seeder's resources of `type`, not the bucket's auto-delete ones. */
    function seedResources(template: Template, type: string, id: string) {
      return Object.entries(template.findResources(type))
        .filter(([logicalId]) => logicalId.startsWith(`TestCache${id}`))
        .map(([logicalId, resource]) => ({
          logicalId,
          Properties: resource.Properties,
        }));
    }

    function seedFunction(template: Template) {
      const functions = seedResources(
        template,
        "AWS::Lambda::Function",
        "CacheSeedFn",
      );
      expect(functions).toHaveLength(1);
      return functions[0].Properties;
    }

    function seedPolicy(template: Template) {
      const policies = template.findResources("AWS::IAM::Policy");
      expect(Object.keys(policies)).toHaveLength(1);
      return Object.values(policies)[0].Properties.PolicyDocument;
    }

    it("creates no seeder for an init cache without a file", () => {
      // What a build with nothing to prerender leaves.
      rmSync(join(initCacheDir, "server", "app", "index.json"));

      const { cache, template } = synth("build-abc123");

      expect(cache.cacheSeed).toBeUndefined();
      template.resourceCountIs("Custom::CDKBucketDeployment", 0);
      expect(
        seedResources(template, "AWS::Lambda::Function", "CacheSeedFn"),
      ).toEqual([]);
    });

    // `cdk deploy --hotswap` runs a custom resource only of this type: it picks
    // it out by the type string alone and invokes the ServiceToken Lambda
    // directly (`HOTSWAP_RESPONSE_URL`). Any other type, `Custom::NextjsCacheSeed`
    // included, is skipped, and a hotswapped stack then serves unseeded.
    it("is a Custom::CDKBucketDeployment, so a hotswap runs it", () => {
      const { cache, template } = synth("build-abc123");

      const seed = seedResource(template);
      expect(seed.Type).toBe("Custom::CDKBucketDeployment");
      // The Lambda itself, not a Provider framework's, which the hotswap's
      // CloudFormation-shaped event would not get through.
      const [fn] = seedResources(
        template,
        "AWS::Lambda::Function",
        "CacheSeedFn",
      );
      expect(seed.Properties.ServiceToken).toEqual({
        "Fn::GetAtt": [fn.logicalId, "Arn"],
      });
      expect(cache.cacheSeed).toBeDefined();
      expect(cache.cacheSeedFunction).toBeDefined();
    });

    it("seeds the build from the init cache asset", () => {
      const { app: ownApp, template } = synth("build-abc123");

      const { Properties } = seedResource(template);
      expect(Properties).toMatchObject({
        BuildId: "build-abc123",
        DestinationBucketName: {
          Ref: expect.stringMatching(/^TestCacheBucket/),
        },
        SourceBucketName: expect.anything(),
        SourceObjectKey: expect.stringMatching(/^[0-9a-f]{64}\.zip$/),
      });
      // No `BucketDeployment` writing into the live prefix any more: a rollback
      // re-ran it and overwrote what the app had regenerated
      // (cdklabs/cdk-nextjs#343).
      const python = template.findResources("AWS::Lambda::Function", {
        Properties: { Runtime: Match.stringLikeRegexp("^python") },
      });
      expect(python).toEqual({});

      // The asset is the init cache itself, keys relative to `<buildId>/`.
      const assembly = ownApp.synth();
      const key = Properties.SourceObjectKey.replace(/\.zip$/, "");
      expect(
        readdirSync(join(assembly.directory, `asset.${key}`), {
          recursive: true,
        }).sort(),
      ).toEqual(["server", "server/app", "server/app/index.json"]);
    });

    it("never lets the seeder delete, nor use a managed policy", () => {
      const { template } = synth("build-abc123");

      const actions = seedPolicy(template).Statement.flatMap(
        (statement: { Action: string | string[] }) => [statement.Action].flat(),
      );
      expect(actions).toEqual(
        expect.arrayContaining(["s3:GetObject", "s3:PutObject"]),
      );
      expect(actions.filter((a: string) => /Delete/.test(a))).toEqual([]);
      // No AWSLambdaBasicExecutionRole: cdk-nag's AwsSolutions-IAM4.
      const [role] = seedResources(template, "AWS::IAM::Role", "CacheSeedRole");
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 30,
      });
    });

    // A hotswap skips, rather than applies, a change to the policy of a role
    // that only `Custom::CDKBucketDeployment` Lambdas use. A grant on this
    // build's asset key or prefix would then deny the invoke that follows.
    it("grants the same whatever the build and its init cache", () => {
      const first = seedPolicy(synth("build-abc123").template);
      writeFileSync(join(initCacheDir, "server", "app", "other.json"), "{}");
      const second = seedPolicy(synth("build-def456").template);

      expect(second).toEqual(first);
    });

    it("applies the seeder overrides", () => {
      const { template } = synth("build-abc123", {
        cacheSeed: {
          functionProps: {
            memorySize: 2048,
            ephemeralStorageSize: Size.gibibytes(4),
          },
          customResourceProps: { serviceTimeout: Duration.minutes(20) },
        },
      });

      expect(seedResource(template).Properties.ServiceTimeout).toBe("1200");
      expect(seedFunction(template)).toMatchObject({
        MemorySize: 2048,
        EphemeralStorage: { Size: 4096 },
      });
    });

    it("never tags the cache bucket as a deployment's", () => {
      // `BucketDeployment` tagged its destination bucket, which cost a full
      // deployment whenever the tag changed: `Tags` aren't hotswappable.
      const buckets =
        synth("build-abc123").template.findResources("AWS::S3::Bucket");
      const tags = Object.values(buckets).flatMap(
        (bucket) => bucket.Properties?.Tags ?? [],
      );
      expect(
        tags.filter((tag: { Key: string }) =>
          tag.Key.startsWith("aws-cdk:cr-owned"),
        ),
      ).toEqual([]);
    });

    it("leaves a small init cache on the smallest sizing", () => {
      const properties = seedFunction(synth("build-abc123").template);

      expect(properties.EphemeralStorage).toEqual({ Size: 512 });
      expect(properties.MemorySize).toBe(512);
    });

    it("scales /tmp and memory to a large init cache", () => {
      // A sparse file: `statSync` reports 400 MiB, the filesystem stores almost
      // nothing, and the zip of a 400 MiB hole costs no real work.
      const big = join(initCacheDir, "server", "app", "big.json");
      writeFileSync(big, "");
      truncateSync(big, 400 * 1024 * 1024);

      const properties = seedFunction(synth("build-abc123").template);

      // 401 MiB of cache, plus 128 MiB of headroom for the zip: 529 MiB,
      // rounded up to the next step.
      expect(properties.EphemeralStorage).toEqual({ Size: 1024 });
      expect(properties.MemorySize).toBe(1024);
    });

    it("sizes an init cache holding a link loop", () => {
      // `readdirSync({ recursive: true })` follows the link on Node 24 and
      // never returns; the files are counted once, the link not at all.
      symlinkSync("..", join(initCacheDir, "server", "loop"), "dir");
      writeFileSync(join(initCacheDir, "server", "data.json"), "12345");

      expect(measureDirectory(initCacheDir)).toEqual({
        files: 2,
        bytes: "{}".length + 5,
      });
    });
  });
});
