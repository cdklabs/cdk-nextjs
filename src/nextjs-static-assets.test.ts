/* eslint-disable import/no-extraneous-dependencies */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, AssetStaging, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BucketDeployment, CacheControl } from "aws-cdk-lib/aws-s3-deployment";
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

    /** The deployment resources' properties, by construct ID. */
    function deployments(): Record<string, any> {
      const resources = Template.fromStack(stack).findResources(
        "Custom::CDKBucketDeployment",
      );
      return Object.fromEntries(
        Object.entries(resources).map(([logicalId, resource]) => [
          logicalId.match(/NextjsStaticAssets(\w+?)CustomResource/)![1],
          resource.Properties,
        ]),
      );
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
      const { Deployment: staticUpload, PublicDeployment: publicUpload } =
        deployments();
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

      const { Deployment: staticUpload, PublicDeployment: publicUpload } =
        deployments();
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
      const uploads = deployments();
      expect(Object.keys(uploads)).toEqual(["Deployment"]);
      expect(uploads.Deployment.DestinationBucketKeyPrefix).toBe("base");
    });

    /** The directory a deployment uploads, for checking what was staged. */
    function stagedDir(deployment: BucketDeployment): string {
      // The deployment's own source asset, not the AWS CLI layer's.
      return deployment.node
        .findAll()
        .filter((c): c is AssetStaging => c instanceof AssetStaging)
        .map((c) => c.sourcePath)
        .find((path) => path.includes("nextjs-assets-"))!;
    }

    // `next start` serves the built file over a public/ one at the same path,
    // and the public/ one everywhere else.
    it("leaves out only the public/_next/static files a built file shadows", () => {
      writePublicFile();
      const shadowDir = join(buildDirectory, "public", "_next", "static");
      mkdirSync(shadowDir, { recursive: true });
      writeFileSync(join(shadowDir, "chunk.js"), "// shadowed");
      writeFileSync(join(shadowDir, "legacy.js"), "// public only");
      const staticAssets = createStaticAssets({});

      const staged = stagedDir(staticAssets.publicDeployment!);
      expect(existsSync(join(staged, "logo.png"))).toBe(true);
      expect(existsSync(join(staged, "_next", "static", "chunk.js"))).toBe(
        false,
      );
      expect(existsSync(join(staged, "_next", "static", "legacy.js"))).toBe(
        true,
      );
    });

    // Next.js and S3 keys are case-sensitive, even where the filesystem isn't.
    it("doesn't treat a public/_next/static file as shadowed by another case", () => {
      const shadowDir = join(buildDirectory, "public", "_next", "static");
      mkdirSync(shadowDir, { recursive: true });
      writeFileSync(join(shadowDir, "Chunk.js"), "// public only");
      const staticAssets = createStaticAssets({});

      const staged = stagedDir(staticAssets.publicDeployment!);
      expect(readdirSync(join(staged, "_next", "static"))).toEqual([
        "Chunk.js",
      ]);
    });

    it("uploads a public/ made only of symlinks", () => {
      const target = join(buildDirectory, "logo.png");
      writeFileSync(target, "png");
      mkdirSync(join(buildDirectory, "public"));
      symlinkSync(target, join(buildDirectory, "public", "logo.png"));
      const staticAssets = createStaticAssets({});

      expect(staticAssets.publicDeployment).toBeDefined();
    });

    // A service worker keeps its URL across builds, so Next.js serves it
    // revalidated rather than immutable.
    it("uploads service workers with max-age=0, must-revalidate", () => {
      const swDir = join(buildDirectory, ".next", "static", "service-worker");
      mkdirSync(swDir, { recursive: true });
      writeFileSync(join(swDir, "sw.js"), "// sw");
      const staticAssets = createStaticAssets({});

      const { Deployment: staticUpload, ServiceWorkerDeployment: swUpload } =
        deployments();
      expect(swUpload.SystemMetadata).toEqual({
        "cache-control": "public, max-age=0, must-revalidate",
      });
      expect(staticUpload.SystemMetadata).toEqual({
        "cache-control": IMMUTABLE,
      });
      const swStaged = stagedDir(staticAssets.serviceWorkerDeployment!);
      expect(
        existsSync(
          join(swStaged, "_next", "static", "service-worker", "sw.js"),
        ),
      ).toBe(true);
      const staticStaged = stagedDir(staticAssets.staticDeployment!);
      expect(
        existsSync(join(staticStaged, "_next", "static", "chunk.js")),
      ).toBe(true);
      expect(
        existsSync(join(staticStaged, "_next", "static", "service-worker")),
      ).toBe(false);
    });

    it("falls back to the public/ upload for a build without .next/static", () => {
      rmSync(join(buildDirectory, ".next"), { recursive: true, force: true });
      writePublicFile();
      const staticAssets = createStaticAssets({});

      expect(staticAssets.staticDeployment).toBeUndefined();
      expect(staticAssets.deployment).toBe(staticAssets.publicDeployment);
      expect(Object.keys(deployments())).toEqual(["PublicDeployment"]);
    });
  });
});
