/* eslint-disable import/no-extraneous-dependencies */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CacheControl } from "aws-cdk-lib/aws-s3-deployment";
import { NextjsStaticAssets } from "./nextjs-static-assets";

describe("NextjsStaticAssets", () => {
  let stack: Stack;
  let buildDirectory: string;

  beforeEach(() => {
    stack = new Stack(new App(), "TestStack");
    buildDirectory = mkdtempSync(join(tmpdir(), "nextjs-static-assets-"));
    const staticDir = join(buildDirectory, ".next", "static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "chunk.js"), "// chunk");
  });

  afterEach(() => {
    rmSync(buildDirectory, { recursive: true, force: true });
  });

  function createStaticAssets(props: {
    basePath?: string;
    destinationKeyPrefix?: string;
  }) {
    return new NextjsStaticAssets(stack, "NextjsStaticAssets", {
      buildDirectory,
      buildId: "test-build-id",
      basePath: props.basePath,
      overrides:
        props.destinationKeyPrefix === undefined
          ? undefined
          : {
              bucketDeploymentProps: {
                destinationKeyPrefix: props.destinationKeyPrefix,
              } as any,
            },
    });
  }

  describe("keyPrefix", () => {
    it("is empty when no basePath is set", () => {
      expect(createStaticAssets({}).keyPrefix).toBe("");
    });

    it("strips surrounding slashes from basePath", () => {
      expect(createStaticAssets({ basePath: "/base/" }).keyPrefix).toBe("base");
    });

    // The override is spread last into BucketDeployment, so it decides where
    // the objects actually land. Consumers reading assets back out of the
    // bucket have to see that, not the basePath prop.
    it("reflects a destinationKeyPrefix override rather than basePath", () => {
      expect(
        createStaticAssets({
          basePath: "/base",
          destinationKeyPrefix: "branch-x",
        }).keyPrefix,
      ).toBe("branch-x");
    });

    it("is empty when an override clears the prefix", () => {
      expect(
        createStaticAssets({ basePath: "/base", destinationKeyPrefix: "" })
          .keyPrefix,
      ).toBe("");
    });

    // A JSII language binding, or a programmatically built props object, can
    // materialize an unset optional field as an explicit `undefined`. Treating
    // that as an intentional "move the assets to the bucket root" override would
    // upload them there while CloudFront still requested them under basePath,
    // failing synth with a key prefix mismatch that names neither the override
    // nor the cause.
    it("falls back to basePath when the override key is present but undefined", () => {
      const staticAssets = new NextjsStaticAssets(stack, "NextjsStaticAssets", {
        buildDirectory,
        buildId: "test-build-id",
        basePath: "/base",
        overrides: {
          bucketDeploymentProps: {
            destinationKeyPrefix: undefined,
          } as any,
        },
      });

      expect(staticAssets.keyPrefix).toBe("base");
    });
  });

  describe("Cache-Control", () => {
    const IMMUTABLE = "public, max-age=31536000, immutable";

    function deployments() {
      return Object.values(
        Template.fromStack(stack).findResources("Custom::CDKBucketDeployment"),
      ).map((resource) => resource.Properties);
    }

    function writePublicFile() {
      const publicDir = join(buildDirectory, "public");
      mkdirSync(publicDir, { recursive: true });
      writeFileSync(join(publicDir, "logo.png"), "png");
    }

    // CloudFront and API Gateway serve these straight from S3, so the
    // object's metadata is the only Cache-Control a browser gets.
    it("uploads _next/static immutable and public/ without a header", () => {
      writePublicFile();
      const staticAssets = createStaticAssets({});

      expect(staticAssets.staticDeployment).toBeDefined();
      expect(staticAssets.publicDeployment).toBeDefined();
      const [staticUpload, publicUpload] = deployments();
      expect(staticUpload.SystemMetadata).toEqual({
        "cache-control": IMMUTABLE,
      });
      expect(publicUpload.SystemMetadata).toBeUndefined();
      for (const upload of [staticUpload, publicUpload]) {
        expect(upload.UserMetadata).toEqual({ build_id: "test-build-id" });
      }
    });

    it("applies an overridden cacheControl to public/ files only", () => {
      writePublicFile();
      new NextjsStaticAssets(stack, "NextjsStaticAssets", {
        buildDirectory,
        buildId: "test-build-id",
        overrides: {
          bucketDeploymentProps: {
            cacheControl: [CacheControl.fromString("public, max-age=3600")],
          } as any,
        },
      });

      const [staticUpload, publicUpload] = deployments();
      expect(staticUpload.SystemMetadata).toEqual({
        "cache-control": IMMUTABLE,
      });
      expect(publicUpload.SystemMetadata).toEqual({
        "cache-control": "public, max-age=3600",
      });
    });

    it("creates only the _next/static upload without a public/ directory", () => {
      const staticAssets = createStaticAssets({ basePath: "/base" });

      expect(staticAssets.publicDeployment).toBeUndefined();
      expect(staticAssets.deployment).toBe(staticAssets.staticDeployment);
      expect(deployments()).toHaveLength(1);
      expect(deployments()[0].DestinationBucketKeyPrefix).toBe("base");
    });
  });
});
