/* eslint-disable import/no-extraneous-dependencies */
import { App, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  Code,
  Function as LambdaFunction,
  IFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { pathPatternsFor } from "./adapter/function-groups";
import { NextjsApi, NextjsApiProps } from "./nextjs-api";

/**
 * `functionGroups` and the `functionGroupBehaviors` the build would record for
 * them: `routes` as routed (an optional catch-all's parent listed by hand),
 * with data-URL behaviors for a group that owns a Pages Router page.
 */
function grouped(
  groups: {
    name: string;
    routes: string[];
    hasDataRoutes?: boolean;
    trailingSlash?: boolean;
    function: IFunction;
  }[],
): Pick<NextjsApiProps, "functionGroups" | "functionGroupBehaviors"> {
  return {
    functionGroups: groups.map(({ name, function: fn }) => ({
      name,
      function: fn,
    })),
    functionGroupBehaviors: groups.flatMap((group) =>
      group.routes.flatMap((route) =>
        pathPatternsFor(route, {
          hasDataRoutes: group.hasDataRoutes ?? false,
          trailingSlash: group.trailingSlash,
          buildId: "abc123",
        }).map((pattern) => ({ group: group.name, route, pattern })),
      ),
    ),
  };
}

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

  /** The statements of the API Gateway → S3 integration role's policy. */
  function staticIntegrationStatements() {
    const policies = Template.fromStack(stack).findResources(
      "AWS::IAM::Policy",
      {
        Properties: {
          Roles: [{ Ref: Match.stringLikeRegexp("StaticIntegrationRole") }],
        },
      },
    );
    return Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
  }

  it("scopes the S3 integration role to the static assets key prefix", () => {
    // A shared bucket holds other apps' assets under their own prefixes.
    createApi("/branch-x/");

    const bucketArn = {
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":s3:::my-bucket"]],
    };
    expect(staticIntegrationStatements()).toEqual([
      {
        Action: "s3:GetObject",
        Effect: "Allow",
        Resource: {
          "Fn::Join": [
            "",
            ["arn:", { Ref: "AWS::Partition" }, ":s3:::my-bucket/branch-x/*"],
          ],
        },
      },
      {
        // Unconditioned: S3 checks it during a GetObject, with no `s3:prefix`.
        Action: "s3:ListBucket",
        Effect: "Allow",
        Resource: bucketArn,
      },
    ]);
  });

  it("lets the S3 integration role read the whole bucket without a key prefix", () => {
    createApi();

    const statements = staticIntegrationStatements();
    expect(statements).toHaveLength(2);
    expect(statements[0].Resource["Fn::Join"][1]).toContain(
      ":s3:::my-bucket/*",
    );
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

  describe("functionGroups resource tree", () => {
    /** Lambda functions that `ANY` on the resource at `pathPart` invokes. */
    function anyTargets(pathPart: string): string[] {
      const template = Template.fromStack(stack);
      const resources = template.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: pathPart },
      });
      const ids = Object.keys(resources);
      expect(ids).toHaveLength(1);
      const methods = template.findResources("AWS::ApiGateway::Method", {
        Properties: { HttpMethod: "ANY", ResourceId: { Ref: ids[0] } },
      });
      return Object.values(methods).map(
        (method) =>
          JSON.stringify(method.Properties.Integration.Uri).match(
            /(ServerFn|GroupFn|ReportsFn)[A-F0-9]+/,
          )![1],
      );
    }

    it("sends a group's parent paths to the default function", () => {
      // API Gateway answers a methodless resource with 403 rather than falling
      // back to the root `{proxy+}`, so `/api` and `/api/reports` need one.
      new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...grouped([
          {
            name: "reports",
            routes: ["/api/reports/**", "/api/export"],
            function: new LambdaFunction(stack, "GroupFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
        ]),
      });

      expect(anyTargets("api")).toEqual(["ServerFn"]);
      expect(anyTargets("reports")).toEqual(["ServerFn"]);
      expect(anyTargets("export")).toEqual(["GroupFn"]);
    });

    it("sends a parent under another group's subtree to that group", () => {
      // `assignRoutesToGroups` packages `/api/reports` into `api`, and
      // CloudFront's `api/*` sends it there; so must API Gateway.
      new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...grouped([
          {
            name: "api",
            routes: ["/api/**"],
            hasDataRoutes: true,
            function: new LambdaFunction(stack, "GroupFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
          {
            name: "reports",
            routes: ["/api/reports/q1/**"],
            hasDataRoutes: true,
            function: new LambdaFunction(stack, "ReportsFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
        ]),
      });

      // Each path part below appears twice, under `/` and under the data
      // prefix, so check the tree by path.
      const targets = anyTargetsByPath();
      expect(targets["/api"]).toEqual(["ServerFn"]);
      expect(targets["/api/reports"]).toEqual(["GroupFn"]);
      expect(targets["/api/reports/q1"]).toEqual(["GroupFn"]);
      expect(targets["/api/reports/q1/{proxy+}"]).toEqual(["ReportsFn"]);
      expect(targets["/_next/data/{buildId}/api/reports"]).toEqual(["GroupFn"]);
      expect(targets["/_next/data/{buildId}"]).toEqual(["ServerFn"]);
    });

    function createGroupedApi(hasDataRoutes: boolean) {
      new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...grouped([
          {
            name: "reports",
            routes: ["/reports/**", "/docs/intro"],
            hasDataRoutes,
            function: new LambdaFunction(stack, "GroupFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
        ]),
      });
    }

    /** Every resource path in the API, e.g. `/_next/data/{buildId}/x.json`. */
    function resourcePaths(): string[] {
      const resources = Template.fromStack(stack).findResources(
        "AWS::ApiGateway::Resource",
      );
      const pathOf = (id: string): string => {
        const { ParentId, PathPart } = resources[id].Properties;
        const parent = ParentId.Ref;
        return parent && resources[parent]
          ? `${pathOf(parent)}/${PathPart}`
          : `/${PathPart}`;
      };
      return Object.keys(resources).map(pathOf).sort();
    }

    /** Resource path → the Lambda functions `ANY` on it invokes. */
    function anyTargetsByPath(): Record<string, string[]> {
      const template = Template.fromStack(stack);
      const resources = template.findResources("AWS::ApiGateway::Resource");
      const pathOf = (id: string): string => {
        const { ParentId, PathPart } = resources[id].Properties;
        const parent = ParentId.Ref;
        return parent && resources[parent]
          ? `${pathOf(parent)}/${PathPart}`
          : `/${PathPart}`;
      };
      const methods = template.findResources("AWS::ApiGateway::Method", {
        Properties: { HttpMethod: "ANY" },
      });
      const targets: Record<string, string[]> = {};
      for (const method of Object.values(methods)) {
        const id = method.Properties.ResourceId?.Ref;
        if (!id || !resources[id]) continue;
        (targets[pathOf(id)] ??= []).push(
          JSON.stringify(method.Properties.Integration.Uri).match(
            /(ServerFn|GroupFn|ReportsFn)[A-F0-9]+/,
          )![1],
        );
      }
      return targets;
    }

    it("routes a group's Pages Router data URLs to it too", () => {
      createGroupedApi(true);

      const paths = resourcePaths();
      expect(paths).toContain("/_next/data/{buildId}/reports/{proxy+}");
      expect(paths).toContain("/_next/data/{buildId}/docs/intro.json");
      expect(anyTargets("intro.json")).toEqual(["GroupFn"]);
      // A methodless parent answers 403, so the data prefix needs the default.
      expect(anyTargets("{buildId}")).toEqual(["ServerFn"]);
    });

    it("keeps each group's data URLs to its own subtree (A)", () => {
      // `{buildId}` is one path segment, where CloudFront's `*` crossed `/`:
      // `/_next/data/<id>/docs/blog/x.json` has no way into blog's resource.
      new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...grouped([
          {
            name: "blog",
            routes: ["/blog/**"],
            hasDataRoutes: true,
            function: new LambdaFunction(stack, "GroupFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
        ]),
      });
      expect(
        resourcePaths().filter((path) => path.startsWith("/_next/data")),
      ).toEqual([
        "/_next/data",
        "/_next/data/{buildId}",
        "/_next/data/{buildId}/blog",
        "/_next/data/{buildId}/blog/{proxy+}",
      ]);
    });

    it("routes an optional catch-all's parent to the group when it is listed (B)", () => {
      // The build routes `/shop` alongside `/shop/**` when the group owns
      // `shop/[[...slug]]` (see `routedPatterns`): `{proxy+}` does not match
      // the parent, which would otherwise reach the default function.
      new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...grouped([
          {
            name: "shop",
            routes: ["/shop/**", "/shop"],
            function: new LambdaFunction(stack, "GroupFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
        ]),
      });
      expect(anyTargets("shop")).toEqual(["GroupFn"]);
    });

    it.each([
      [{ name: "docs", isDirectory: true }, "/docs/**", "directory"],
      [{ name: "docs", isDirectory: true }, "/docs/guide/**", "directory"],
      [{ name: "robots.txt", isDirectory: false }, "/robots.txt", "file"],
    ])(
      "rejects a group route on a public/ entry's resource: %p with %p (E)",
      (entry, route, kind) => {
        expect(
          () =>
            new NextjsApi(stack, "NextjsApi", {
              staticAssetsBucket: Bucket.fromBucketName(
                stack,
                "Bucket",
                "my-bucket",
              ),
              serverFunction: new LambdaFunction(stack, "ServerFn", {
                runtime: Runtime.NODEJS_22_X,
                handler: "index.handler",
                code: Code.fromInline("exports.handler = async () => {};"),
              }),
              publicDirEntries: [entry],
              ...grouped([
                {
                  name: "g",
                  routes: [route],
                  function: new LambdaFunction(stack, "GroupFn", {
                    runtime: Runtime.NODEJS_22_X,
                    handler: "index.handler",
                    code: Code.fromInline("exports.handler = async () => {};"),
                  }),
                },
              ]),
            }),
        ).toThrow(`overlaps the top-level public/ ${kind} "${entry.name}"`);
      },
    );

    it("allows an exact route named like a public/ directory, which is not under it", () => {
      expect(
        () =>
          new NextjsApi(stack, "NextjsApi", {
            staticAssetsBucket: Bucket.fromBucketName(
              stack,
              "Bucket",
              "my-bucket",
            ),
            serverFunction: new LambdaFunction(stack, "ServerFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
            publicDirEntries: [{ name: "docs", isDirectory: true }],
            ...grouped([
              {
                name: "g",
                routes: ["/docs"],
                function: new LambdaFunction(stack, "GroupFn", {
                  runtime: Runtime.NODEJS_22_X,
                  handler: "index.handler",
                  code: Code.fromInline("exports.handler = async () => {};"),
                }),
              },
            ]),
          }),
      ).not.toThrow();
    });

    it("routes an exact route's trailingSlash form through its one resource", () => {
      // CloudFront needs `pricing/` as a behavior of its own; API Gateway
      // matches `/pricing/` on the `pricing` resource, so the variant adds
      // nothing here and must not add the resource twice.
      new NextjsApi(stack, "NextjsApi", {
        staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
        serverFunction: new LambdaFunction(stack, "ServerFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => {};"),
        }),
        publicDirEntries: [],
        ...grouped([
          {
            name: "pricing",
            routes: ["/pricing"],
            trailingSlash: true,
            function: new LambdaFunction(stack, "GroupFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
          },
        ]),
      });
      expect(
        resourcePaths().filter((path) => !path.startsWith("/_next/static")),
      ).toEqual(["/_next", "/pricing", "/{proxy+}"]);
      expect(anyTargetsByPath()).toEqual({
        "/pricing": ["GroupFn"],
        "/{proxy+}": ["ServerFn"],
      });
    });

    it("rejects a behavior for a group it was not given", () => {
      const { functionGroupBehaviors } = grouped([
        {
          name: "api",
          routes: ["/api/**"],
          function: new LambdaFunction(stack, "GroupFn", {
            runtime: Runtime.NODEJS_22_X,
            handler: "index.handler",
            code: Code.fromInline("exports.handler = async () => {};"),
          }),
        },
      ]);
      expect(
        () =>
          new NextjsApi(stack, "NextjsApi", {
            staticAssetsBucket: Bucket.fromBucketName(
              stack,
              "Bucket",
              "my-bucket",
            ),
            serverFunction: new LambdaFunction(stack, "ServerFn", {
              runtime: Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: Code.fromInline("exports.handler = async () => {};"),
            }),
            publicDirEntries: [],
            functionGroupBehaviors,
          }),
      ).toThrow(/routes to function group "api", which is not in/);
    });

    it("adds no data routes for an app without Pages Router routes", () => {
      createGroupedApi(false);

      expect(
        resourcePaths().filter((path) => path.startsWith("/_next/data")),
      ).toEqual([]);
    });

    it("grants each function one API-scoped permission, not two per method", () => {
      // Per-method permissions put two statements in the function's resource
      // policy for every `ANY`, which outgrows Lambda's 20 KB cap.
      createGroupedApi(true);

      const permissions = Object.values(
        Template.fromStack(stack).findResources("AWS::Lambda::Permission", {
          Properties: { Principal: "apigateway.amazonaws.com" },
        }),
      );
      expect(permissions).toHaveLength(2);
      for (const permission of permissions) {
        const sourceArn = JSON.stringify(permission.Properties.SourceArn);
        expect(sourceArn).toContain(":execute-api:");
        expect(sourceArn).toContain("/*/*/*");
      }
    });
  });

  it("names the group and pattern API Gateway cannot route", () => {
    expect(
      () =>
        new NextjsApi(stack, "NextjsApi", {
          staticAssetsBucket: Bucket.fromBucketName(
            stack,
            "Bucket",
            "my-bucket",
          ),
          serverFunction: new LambdaFunction(stack, "ServerFn", {
            runtime: Runtime.NODEJS_22_X,
            handler: "index.handler",
            code: Code.fromInline("exports.handler = async () => {};"),
          }),
          publicDirEntries: [],
          ...grouped([
            {
              name: "about",
              routes: ["/about~us"],
              function: new LambdaFunction(stack, "GroupFn", {
                runtime: Runtime.NODEJS_22_X,
                handler: "index.handler",
                code: Code.fromInline("exports.handler = async () => {};"),
              }),
            },
          ]),
        }),
    ).toThrow(/pattern "\/about~us" \(group "about"\) has a segment/);
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

describe("NextjsApi redeploy after update", () => {
  function synth(props: Partial<NextjsApiProps> = {}) {
    const stack = new Stack(new App(), "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsApi(stack, "NextjsApi", {
      staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
      serverFunction: new LambdaFunction(stack, "ServerFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => {};"),
      }),
      publicDirEntries: [],
      ...props,
    });
    return Template.fromStack(stack);
  }

  /** The `Fn::Join` parts of every resource the redeploy role is granted. */
  function grantedResources(template: Template) {
    const [policy] = Object.values(
      template.findResources("AWS::IAM::Policy", {
        Properties: {
          PolicyName: Match.stringLikeRegexp("RedeployFn"),
        },
      }),
    );
    return policy.Properties.PolicyDocument.Statement.map(
      (statement: { Action: string; Resource: unknown }) => ({
        action: statement.Action,
        resources: JSON.stringify(statement.Resource),
      }),
    );
  }

  it("redeploys the stage on this stack's UPDATE_COMPLETE", () => {
    const template = synth();

    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["aws.cloudformation"],
        "detail-type": ["CloudFormation Stack Status Change"],
        detail: {
          "stack-id": [{ Ref: "AWS::StackId" }],
          "status-details": {
            status: ["UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"],
          },
        },
      },
      Targets: [
        Match.objectLike({
          Arn: { "Fn::GetAtt": [Match.stringLikeRegexp("RedeployFn"), "Arn"] },
        }),
      ],
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Environment: {
        Variables: {
          REST_API_ID: { Ref: Match.stringLikeRegexp("RestApi") },
          STAGE_NAME: { Ref: Match.stringLikeRegexp("DeploymentStage") },
        },
      },
    });
  });

  it("scopes its API Gateway access to this REST API", () => {
    const statements = grantedResources(synth());

    expect(statements.map((s: { action: string }) => s.action)).toEqual([
      "apigateway:POST",
      "apigateway:GET",
      "apigateway:DELETE",
    ]);
    for (const { resources } of statements) {
      expect(resources).toContain("/restapis/");
      expect(resources).toMatch(/"Ref":"NextjsApiRestApi[0-9A-F]+"/);
      expect(resources).not.toMatch(/restapis\/\*/);
    }
    expect(statements[0].resources).toContain("/deployments");
    expect(statements[2].resources).toContain("/deployments/*");
  });

  it("is off when redeployAfterUpdate is false", () => {
    const template = synth({ redeployAfterUpdate: false });

    template.resourceCountIs("AWS::Events::Rule", 0);
  });

  it("is off when the API deploys no stage", () => {
    const template = synth({
      overrides: { restApiProps: { deploy: false } },
    });

    template.resourceCountIs("AWS::Events::Rule", 0);
  });

  it("takes function overrides", () => {
    const template = synth({
      overrides: { redeployFunctionProps: { memorySize: 512 } },
    });

    template.hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: 512,
      Environment: {
        Variables: { REST_API_ID: Match.anyValue() },
      },
    });
  });
});
