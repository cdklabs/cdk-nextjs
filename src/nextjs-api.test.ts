/* eslint-disable import/no-extraneous-dependencies */
import { App, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { NextjsApi, NextjsApiProps } from "./nextjs-api";

describe("NextjsApi", () => {
  let stack: Stack;

  beforeEach(() => {
    stack = new Stack(new App(), "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
  });

  function createApi(staticAssetsKeyPrefix?: string) {
    return new NextjsApi(stack, "NextjsApi", {
      staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
      staticAssetsKeyPrefix,
      serverFunction: new LambdaFunction(stack, "ServerFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => {};"),
      }),
      publicDirEntries: [
        { name: "favicon.ico", isDirectory: false },
        { name: "images", isDirectory: true },
      ],
    });
  }

  /**
   * The S3 integrations address objects by key, so the uploaded key prefix has
   * to appear in the integration URI or every static request 404s.
   */
  function s3IntegrationKeys(): string[] {
    const methods = Template.fromStack(stack).findResources(
      "AWS::ApiGateway::Method",
    );
    const marker = "s3:path/my-bucket/";
    return Object.values(methods)
      .flatMap((method) => method.Properties.Integration.Uri["Fn::Join"][1])
      .filter(
        (part: unknown): part is string =>
          typeof part === "string" && part.includes(marker),
      )
      .map((part) => part.split(marker)[1]);
  }

  it("addresses objects at the bucket root when no key prefix is set", () => {
    createApi();

    expect(s3IntegrationKeys().sort()).toEqual([
      "_next/static/{key}",
      "favicon.ico",
      "images/{key}",
    ]);
  });

  it("prefixes every S3 integration key with the static assets key prefix", () => {
    createApi("branch-x");

    expect(s3IntegrationKeys().sort()).toEqual([
      "branch-x/_next/static/{key}",
      "branch-x/favicon.ico",
      "branch-x/images/{key}",
    ]);
  });

  it("normalizes surrounding slashes on the key prefix", () => {
    createApi("/branch-x/");

    expect(s3IntegrationKeys()).toContain("branch-x/_next/static/{key}");
  });

  it("keeps the key prefix independent of basePath, which is the URL prefix", () => {
    // A NextjsRegionalFunctions app whose `basePath` matches the API Gateway
    // stage still has its assets at the bucket root.
    new NextjsApi(stack, "NextjsApi", {
      staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
      basePath: "/prod",
      serverFunction: new LambdaFunction(stack, "ServerFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => {};"),
      }),
      publicDirEntries: [],
    });

    expect(s3IntegrationKeys()).toEqual(["_next/static/{key}"]);
    // ...served under the stage-matching URL prefix.
    Template.fromStack(stack).hasResourceProperties(
      "AWS::ApiGateway::Resource",
      { PathPart: "prod" },
    );
  });

  // API Gateway path parts can't contain "/", so a nested basePath passed whole
  // to `addResource` fails CDK's `validateResourcePathPart` at synth. It's
  // reachable: `resolveBasePath` accepts a nested prop for REGIONAL_FUNCTIONS as
  // long as the app's basePath ends with it.
  describe("nested basePath", () => {
    function pathParts(): string[] {
      const resources = Template.fromStack(stack).findResources(
        "AWS::ApiGateway::Resource",
      );
      return Object.values(resources).map(
        (resource) => resource.Properties.PathPart,
      );
    }

    function createApiWithBasePath(basePath: string) {
      return new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        basePath,
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
      });
    }

    it("creates one resource per segment", () => {
      expect(() => createApiWithBasePath("/team/app")).not.toThrow();

      expect(pathParts()).toEqual(
        expect.arrayContaining(["team", "app", "_next", "{proxy+}"]),
      );
      // Not the unsplit value, which API Gateway would reject.
      expect(pathParts()).not.toContain("team/app");
    });

    it("nests the segments so the app is reachable under the full path", () => {
      createApiWithBasePath("/team/app");

      const resources = Template.fromStack(stack).findResources(
        "AWS::ApiGateway::Resource",
      );
      const byPathPart = Object.fromEntries(
        Object.entries(resources).map(([logicalId, resource]) => [
          resource.Properties.PathPart,
          { logicalId, parentId: resource.Properties.ParentId },
        ]),
      );
      // "app" hangs off "team", not off the API root.
      expect(byPathPart.app.parentId).toEqual({
        Ref: byPathPart.team.logicalId,
      });
      expect(byPathPart.team.parentId).toHaveProperty("Fn::GetAtt");
    });

    it("still creates a single resource for a flat basePath", () => {
      createApiWithBasePath("/base");

      expect(pathParts()).toContain("base");
    });
  });

  describe("url", () => {
    function createApiWithOverrides(
      props: Partial<NextjsApiProps> = {},
    ): NextjsApi {
      return new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...props,
      });
    }

    function domainName(basePath?: string) {
      return {
        domainName: "app.example.com",
        certificate: Certificate.fromCertificateArn(
          stack,
          "Cert",
          "arn:aws:acm:us-east-1:123456789012:certificate/abc",
        ),
        basePath,
      };
    }

    /**
     * The REST API id, the stage name and the domain name are all tokens that
     * only resolve at deploy time, so flatten the resolved `Fn::Join` and stand
     * each reference in for the resource it points at (minus CDK's logical id
     * hash suffix). That keeps the assertions about *which* resource supplies
     * each part of the URL, which is the whole question here.
     */
    function resolveUrl(api: NextjsApi): string {
      const resolved = stack.resolve(api.url);
      if (typeof resolved === "string") {
        return resolved;
      }
      return resolved["Fn::Join"][1]
        .map((part: unknown) =>
          typeof part === "string"
            ? part
            : `{${(part as { Ref: string }).Ref.replace(/[0-9A-F]{8}$/, "")}}`,
        )
        .join("");
    }

    it("reports the execute-api endpoint with the stage appended when there's no custom domain", () => {
      // The stage is in the path only here, which is the whole reason the
      // regional-functions example sets an app basePath of "/prod".
      expect(resolveUrl(createApiWithOverrides())).toBe(
        "https://{NextjsApiRestApi}.execute-api.us-east-1.amazonaws.com/{NextjsApiRestApiDeploymentStageprod}",
      );
    });

    it("appends basePath, which nests every resource a level down", () => {
      expect(
        resolveUrl(createApiWithOverrides({ basePath: "/my-base-path" })),
      ).toBe(
        "https://{NextjsApiRestApi}.execute-api.us-east-1.amazonaws.com/{NextjsApiRestApiDeploymentStageprod}/my-base-path",
      );
    });

    it("prefers a custom domain and drops the stage from the path", () => {
      // A domain mapped at the root is the cleanest Regional setup: no stage in
      // the URL means no basePath and no stage workarounds anywhere. The stage is
      // reached through the domain's base path mapping instead.
      expect(
        resolveUrl(
          createApiWithOverrides({
            overrides: { restApiProps: { domainName: domainName() } },
          }),
        ),
      ).toBe("https://{NextjsApiRestApiCustomDomain}");
    });

    it("includes a custom domain's base path mapping", () => {
      // CDK rejects surrounding slashes on a mapping, so it's always a bare
      // segment by the time it gets here.
      expect(
        resolveUrl(
          createApiWithOverrides({
            overrides: { restApiProps: { domainName: domainName("team-a") } },
          }),
        ),
      ).toBe("https://{NextjsApiRestApiCustomDomain}/team-a");
    });
  });

  describe("functionGroups under trailingSlash", () => {
    function fn(id: string): LambdaFunction {
      return new LambdaFunction(stack, id, {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => {};"),
      });
    }

    function createApiWithGroups(
      routes: string[],
      trailingSlash?: boolean,
    ): NextjsApi {
      return new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: fn("ServerFn"),
        publicDirEntries: [],
        trailingSlash,
        functionGroups: [{ name: "reports", routes, function: fn("GroupFn") }],
      });
    }

    function warnings(api: NextjsApi): string[] {
      return Annotations.fromStack(stack)
        .findWarning(`/${api.node.path}`, Match.anyValue())
        .map((warning) => warning.entry.data as string);
    }

    it("warns that an exact route's canonical URL cannot be routed", () => {
      // `trailingSlash: true` links to "/pricing/", and no API Gateway resource
      // matches a trailing slash: the request reaches the root `{proxy+}` and so
      // the default function, which does not have the route packaged. The warning
      // is the fix here, because the resource tree cannot express it.
      const api = createApiWithGroups(["/pricing", "/reports/**"], true);

      const message = warnings(api).join("\n");
      expect(message).toContain('"/pricing" (group "reports")');
      // The subtree pattern is named only as the suggested fix, never as an
      // affected route.
      expect(message).not.toContain('"/reports/**" (group');
    });

    it("does not warn about subtree patterns, which `{proxy+}` already covers", () => {
      const api = createApiWithGroups(["/reports/**"], true);

      expect(warnings(api)).toEqual([]);
    });

    it("says nothing without trailingSlash", () => {
      const api = createApiWithGroups(["/pricing"]);

      expect(warnings(api)).toEqual([]);
    });
  });

  describe("a public/ entry API Gateway cannot address", () => {
    it("warns and skips it instead of failing the synth", () => {
      // `public/hello world.jpg` is a valid Next.js asset that `addResource`
      // rejects outright, taking the whole app's synth with it. The Global types
      // serve it with a wildcard path pattern; here the honest outcome is one
      // 404ing asset and a warning that names it.
      const api = new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [
          { name: "hello world.jpg", isDirectory: false },
          { name: "äöüščří.png", isDirectory: false },
          { name: "favicon.ico", isDirectory: false },
        ],
      });

      const message = Annotations.fromStack(stack)
        .findWarning(`/${api.node.path}`, Match.anyValue())
        .map((warning) => warning.entry.data as string)
        .join("\n");
      expect(message).toContain('"hello world.jpg"');
      expect(message).toContain('"äöüščří.png"');
      expect(message).not.toContain('"favicon.ico"');
      // The expressible one is still served.
      expect(s3IntegrationKeys()).toContain("favicon.ico");
    });
  });
});
