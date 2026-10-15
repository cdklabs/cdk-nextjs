import { runInNewContext } from "node:vm";
import { App, Duration, Lazy, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import {
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  KeyValueStore,
  ResponseHeadersPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  Code,
  Function as LambdaFunction,
  FunctionUrl,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { pathPatternsFor } from "./adapter/function-groups";
import { NextjsType } from "./constants";
import {
  NextjsDistribution,
  NextjsDistributionFunctionGroup,
  NextjsDistributionOverrides,
} from "./nextjs-distribution";

/**
 * `functionGroups` routing at the edge. `NextjsBuild` is deliberately not
 * involved: which behaviors a group gets, and in what order, is the adapter's
 * decision (`function-groups.test.ts`), so these pass the behaviors in directly
 * and assert on what the distribution does with them.
 */
describe("NextjsDistribution function group behaviors", () => {
  const setup = (
    groupNames: string[],
    props: {
      routesFor?: (name: string) => string[];
      publicDirEntries?: string[];
      basePath?: string;
      trailingSlash?: boolean;
    } = {},
  ) => {
    const stack = new Stack(new App(), "TestStack");
    const functionGroups: NextjsDistributionFunctionGroup[] = groupNames.map(
      (name) => {
        const fn = new LambdaFunction(stack, `Fn${name}`, {
          code: Code.fromInline("exports.handler = () => {};"),
          handler: "index.handler",
          runtime: Runtime.NODEJS_22_X,
        });
        return {
          name,
          functionUrl: new FunctionUrl(stack, `Url${name}`, {
            function: fn,
            authType: FunctionUrlAuthType.AWS_IAM,
          }),
        };
      },
    );
    // In the order given: the build's list is already most specific first.
    const functionGroupBehaviors = groupNames.flatMap((group) =>
      (props.routesFor?.(group) ?? [`/${group}/**`]).flatMap((route) =>
        pathPatternsFor(route, {
          hasDataRoutes: false,
          trailingSlash: props.trailingSlash,
        }).map((pattern) => ({ group, route, pattern })),
      ),
    );
    const defaultFn = new LambdaFunction(stack, "FnDefault", {
      code: Code.fromInline("exports.handler = () => {};"),
      handler: "index.handler",
      runtime: Runtime.NODEJS_22_X,
    });
    return {
      stack,
      functionGroups,
      functionGroupBehaviors,
      distributionProps: {
        assetsBucket: new Bucket(stack, "Assets"),
        basePath: props.basePath,
        functionUrl: new FunctionUrl(stack, "UrlDefault", {
          function: defaultFn,
          authType: FunctionUrlAuthType.AWS_IAM,
        }),
        nextjsType: NextjsType.GLOBAL_FUNCTIONS,
        publicDirEntries: (props.publicDirEntries ?? []).map((name) => ({
          name,
          isDirectory: false,
        })),
      },
    };
  };

  const pathPatterns = (stack: Stack) => {
    const distributions = Template.fromStack(stack).findResources(
      "AWS::CloudFront::Distribution",
    );
    const config =
      Object.values(distributions)[0].Properties.DistributionConfig;
    return (config.CacheBehaviors as Array<{ PathPattern: string }>).map(
      (behavior) => behavior.PathPattern,
    );
  };

  it("adds nothing extra when there are no groups", () => {
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", distributionProps);
    expect(pathPatterns(stack)).toEqual(["_next/static*", "_next/image*"]);
  });

  describe("service workers", () => {
    const serviceWorkerPolicy = (stack: Stack) => {
      const config = Object.values(
        Template.fromStack(stack).findResources(
          "AWS::CloudFront::Distribution",
        ),
      )[0].Properties.DistributionConfig;
      const behavior = (
        config.CacheBehaviors as Array<{
          PathPattern: string;
          ResponseHeadersPolicyId: { Ref: string };
        }>
      ).find(({ PathPattern }) => PathPattern.includes("service-worker"))!;
      const policies = Template.fromStack(stack).findResources(
        "AWS::CloudFront::ResponseHeadersPolicy",
      );
      return policies[behavior.ResponseHeadersPolicyId.Ref].Properties
        .ResponseHeadersPolicyConfig;
    };

    it("sends Service-Worker-Allowed from a behavior ahead of _next/static*", () => {
      // CloudFront stops at the first match, so after `_next/static*` it would
      // never be reached.
      const { stack, distributionProps } = setup([]);
      new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        serviceWorkerAllowed: "/",
      });
      expect(pathPatterns(stack)).toEqual([
        "_next/static/service-worker/*",
        "_next/static*",
        "_next/image*",
      ]);
      const policy = serviceWorkerPolicy(stack);
      expect(policy.CustomHeadersConfig.Items).toEqual([
        { Header: "Service-Worker-Allowed", Value: "/", Override: true },
      ]);
      // The security headers the other static behaviors send.
      expect(
        policy.SecurityHeadersConfig.StrictTransportSecurity,
      ).toBeDefined();
    });

    it("prefixes the pattern with basePath", () => {
      const { stack, distributionProps } = setup([], { basePath: "/base" });
      new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        serviceWorkerAllowed: "/base",
      });
      expect(pathPatterns(stack)[0]).toBe(
        "/base/_next/static/service-worker/*",
      );
      expect(serviceWorkerPolicy(stack).CustomHeadersConfig.Items).toEqual([
        { Header: "Service-Worker-Allowed", Value: "/base", Override: true },
      ]);
    });

    it("adds no behavior without service workers", () => {
      const { stack, distributionProps } = setup([]);
      new NextjsDistribution(stack, "Distribution", distributionProps);
      expect(pathPatterns(stack)).not.toContain(
        "_next/static/service-worker/*",
      );
    });

    it("keeps staticResponseHeadersPolicyProps, its custom headers included", () => {
      const { stack, distributionProps } = setup([]);
      new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        serviceWorkerAllowed: "/",
        overrides: {
          staticResponseHeadersPolicyProps: {
            responseHeadersPolicyName: "static",
            customHeadersBehavior: {
              customHeaders: [{ header: "X-Team", value: "a", override: true }],
            },
          },
        },
      });
      const policy = serviceWorkerPolicy(stack);
      // Names are unique per account, so it can't share the static policy's.
      expect(policy.Name).toBe("static-sw");
      expect(policy.CustomHeadersConfig.Items).toEqual([
        { Header: "X-Team", Value: "a", Override: true },
        { Header: "Service-Worker-Allowed", Value: "/", Override: true },
      ]);
    });

    it("keeps a Service-Worker-Allowed the static override sets", () => {
      const { stack, distributionProps } = setup([]);
      new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        serviceWorkerAllowed: "/",
        overrides: {
          staticResponseHeadersPolicyProps: {
            customHeadersBehavior: {
              customHeaders: [
                {
                  header: "service-worker-allowed",
                  value: "/app",
                  override: true,
                },
              ],
            },
          },
        },
      });
      expect(serviceWorkerPolicy(stack).CustomHeadersConfig.Items).toEqual([
        { Header: "service-worker-allowed", Value: "/app", Override: true },
      ]);
    });

    it("warns and uses a replaced static policy as it is", () => {
      const { stack, distributionProps } = setup([]);
      const distribution = new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        serviceWorkerAllowed: "/",
        overrides: {
          staticBehaviorOptions: {
            responseHeadersPolicy:
              ResponseHeadersPolicy.fromResponseHeadersPolicyId(
                stack,
                "Custom",
                "custom-policy",
              ),
          },
        },
      });
      Annotations.fromStack(stack).hasWarning(
        `/${distribution.node.path}`,
        Match.stringLikeRegexp("Service-Worker-Allowed"),
      );
      const config = Object.values(
        Template.fromStack(stack).findResources(
          "AWS::CloudFront::Distribution",
        ),
      )[0].Properties.DistributionConfig;
      expect(config.CacheBehaviors[0]).toMatchObject({
        PathPattern: "_next/static/service-worker/*",
        ResponseHeadersPolicyId: "custom-policy",
      });
    });

    it("counts its behavior against the budget", () => {
      const { stack, distributionProps } = setup([], {
        publicDirEntries: Array.from({ length: 72 }, (_, i) => `f${i}`),
      });
      // 3 fixed + 72 public = 75 fits; the service worker behavior makes 76.
      expect(
        () =>
          new NextjsDistribution(stack, "Distribution", {
            ...distributionProps,
            serviceWorkerAllowed: "/",
          }),
      ).toThrow(/needs 76 CloudFront cache behaviors/);
    });
  });

  it("lets the OAC principal list the bucket so a missing asset is a 404", () => {
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", distributionProps);
    Template.fromStack(stack).hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["s3:GetObject", "s3:ListBucket"],
            Principal: { Service: "cloudfront.amazonaws.com" },
          }),
        ]),
      },
    });
  });

  it("adds group behaviors in the build's order, after the image behavior", () => {
    // CloudFront stops at the first matching behavior, so `api/*` ahead of
    // `api/reports/*` would send every report request to the wrong function.
    // The build sorted them when it checked them; re-sorting here could only
    // disagree with that.
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["reports", "api"], {
        routesFor: (name) =>
          name === "api" ? ["/api/**"] : ["/api/reports/**"],
      });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      functionGroupBehaviors,
    });
    expect(pathPatterns(stack)).toEqual([
      "_next/static*",
      "_next/image*",
      "api/reports/*",
      "api/*",
    ]);
  });

  it("keeps the two slash variants distinct under a basePath", () => {
    // `getPathPattern` used to join through a helper that strips trailing
    // slashes, so `pricing` and `pricing/` both became `/base/pricing`: two
    // behaviors with the same path pattern, which CloudFront rejects at deploy
    // with no hint that `trailingSlash` is what produced the duplicate.
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["mkt"], {
        routesFor: () => ["/pricing"],
        basePath: "/base",
        trailingSlash: true,
      });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      functionGroupBehaviors,
    });
    const patterns = pathPatterns(stack);
    expect(patterns).toContain("/base/pricing");
    expect(patterns).toContain("/base/pricing/");
  });

  it("counts the basePath behaviors against the budget", () => {
    const { stack, distributionProps } = setup([], {
      basePath: "/base",
      publicDirEntries: Array.from({ length: 21 }, (_, i) => `file${i}.txt`),
    });
    // 3 fixed + the 2 a basePath adds to stand in for the default behavior + 21
    // public = 26. Counting only the 3 reported 24 and let the synth through, so
    // the limit arrived as a CloudFront deploy failure.
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          maxCacheBehaviors: 25,
        }),
    ).toThrow(/26 CloudFront cache behaviors.*5 used by cdk-nextjs itself/s);
  });

  it("defaults the budget to CloudFront's quota of 75", () => {
    // The hard-coded 25 predated the quota's increase to 75.
    const { stack, distributionProps } = setup([], {
      publicDirEntries: Array.from({ length: 72 }, (_, i) => `file${i}.txt`),
    });
    expect(
      () => new NextjsDistribution(stack, "Distribution", distributionProps),
    ).not.toThrow();
    const { stack: over, distributionProps: overProps } = setup([], {
      publicDirEntries: Array.from({ length: 73 }, (_, i) => `file${i}.txt`),
    });
    expect(
      () => new NextjsDistribution(over, "Distribution", overProps),
    ).toThrow(
      /76 CloudFront cache behaviors, over the limit of 75.*set `maxCacheBehaviors`/s,
    );
  });

  it("honors a raised maxCacheBehaviors", () => {
    const { stack, distributionProps } = setup([], {
      publicDirEntries: Array.from({ length: 97 }, (_, i) => `file${i}.txt`),
    });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          maxCacheBehaviors: 100,
        }),
    ).not.toThrow();
  });

  it("does not count basePath behaviors for a basePath of /", () => {
    // `basePath: "/"` normalizes to no basePath and adds no behaviors, so
    // counting 2 for it could reject an app that is under the limit.
    const { stack, distributionProps } = setup([], {
      basePath: "/",
      publicDirEntries: Array.from({ length: 22 }, (_, i) => `file${i}.txt`),
    });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          maxCacheBehaviors: 25,
        }),
    ).not.toThrow();
  });

  it("rejects a behavior for a group it was not given", () => {
    const { stack, functionGroupBehaviors, distributionProps } = setup(["api"]);
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          functionGroupBehaviors,
        }),
    ).toThrow(
      /routes to function group "api", which is not in `functionGroups`/,
    );
  });

  it("points each group's behaviors at that group's own origin", () => {
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["api"], {
        routesFor: () => ["/api/**", "/health"],
      });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      functionGroupBehaviors,
    });
    const distributions = Template.fromStack(stack).findResources(
      "AWS::CloudFront::Distribution",
    );
    const config =
      Object.values(distributions)[0].Properties.DistributionConfig;
    const behaviors = config.CacheBehaviors as Array<{
      PathPattern: string;
      TargetOriginId: string;
    }>;
    const groupOrigins = new Set(
      behaviors
        .filter((behavior) =>
          ["api/*", "health"].includes(behavior.PathPattern),
        )
        .map((behavior) => behavior.TargetOriginId),
    );
    // One origin, shared by both of the group's patterns, and not the default's.
    expect(groupOrigins.size).toBe(1);
    expect(groupOrigins).not.toContain(
      config.DefaultCacheBehavior.TargetOriginId,
    );
  });

  it("prefixes group patterns with basePath", () => {
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["api"], {
        routesFor: () => ["/api/**"],
        basePath: "/base",
      });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      functionGroupBehaviors,
    });
    expect(pathPatterns(stack)).toContain("/base/api/*");
  });

  it("names every claim on the behavior budget when it is exceeded", () => {
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["api"], {
        routesFor: () => ["/api/**"],
        publicDirEntries: Array.from({ length: 22 }, (_, i) => `file${i}.txt`),
      });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          functionGroups,
          functionGroupBehaviors,
          maxCacheBehaviors: 25,
        }),
    ).toThrow(
      /26 CloudFront cache behaviors.*1 for `functionGroups` patterns/s,
    );
  });

  it("rejects a group pattern that duplicates a public/ directory's", () => {
    // `public/docs/` and `/docs/**` both deploy as `docs/*`: the synth
    // succeeded and CloudFront rejected the deploy.
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["docs"]);
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          functionGroups,
          functionGroupBehaviors,
          publicDirEntries: [{ name: "docs", isDirectory: true }],
        }),
    ).toThrow(
      /pattern "\/docs\/\*\*" \(group "docs"\) deploys as the path pattern "docs\/\*", which a top-level public\/ entry already uses/,
    );
  });

  it("rejects a group pattern a public/ directory's behavior would shadow", () => {
    // `docs/*` is added first, so `docs/guide/*` never matches.
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["guide"], {
        routesFor: () => ["/docs/guide/**"],
      });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          functionGroups,
          functionGroupBehaviors,
          publicDirEntries: [{ name: "docs", isDirectory: true }],
        }),
    ).toThrow(/public\/ entry behind "docs\/\*" is matched first/);
  });

  it("rejects an exact group pattern equal to a public/ file's, basePath included", () => {
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["mkt"], {
        routesFor: () => ["/robots.txt"],
        basePath: "/base",
      });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          functionGroups,
          functionGroupBehaviors,
          publicDirEntries: [{ name: "robots.txt", isDirectory: false }],
        }),
    ).toThrow(/deploys as the path pattern "\/base\/robots\.txt"/);
  });

  it("allows a group pattern beside a public/ entry it does not overlap", () => {
    // `/docs` exact is not under `docs/*`, and `docs/*` does not match `/docs`.
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["docs"], {
        routesFor: () => ["/docs"],
      });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      functionGroupBehaviors,
      publicDirEntries: [{ name: "docs", isDirectory: true }],
    });
    expect(pathPatterns(stack)).toEqual(
      expect.arrayContaining(["docs/*", "docs"]),
    );
  });

  it("serves bundles under a path-style assetPrefix, rewriting the prefix away", () => {
    // Next.js emits `<assetPrefix>/_next/static/...` for every bundle while the
    // objects keep their unprefixed S3 keys, so without a behavior of its own the
    // request falls through to the compute origin and 404s — the deployment
    // package carries no `.next/static`. Measured against
    // `test/e2e/app-dir/asset-prefix`, where 2 of 7 cases failed on exactly that.
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      assetPrefix: "/custom-asset-prefix",
    });
    // Ahead of the bare `_next/static*` in nothing but list position; the two
    // patterns cannot both match one request, so order does not matter here.
    expect(pathPatterns(stack)).toEqual([
      "_next/static*",
      "/custom-asset-prefix/_next/static*",
      "_next/image*",
    ]);
    const fns = Template.fromStack(stack).findResources(
      "AWS::CloudFront::Function",
    );
    const code = Object.values(fns)
      .map((fn) => fn.Properties.FunctionCode as string)
      .find((it) => it.includes("request.uri.slice"));
    // `"/custom-asset-prefix".length`, so `/custom-asset-prefix/_next/static/x`
    // reaches S3 as `_next/static/x`.
    expect(code).toContain('"" + request.uri.slice(20)');
  });

  it("refuses an assetPrefix when an override already claims VIEWER_REQUEST", () => {
    // CloudFront permits one function per event type per behavior, so the
    // rewrite and the override cannot coexist: the stack synthed cleanly and was
    // rejected at deploy, naming neither the override nor `assetPrefix`.
    const { stack, distributionProps } = setup([]);
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          assetPrefix: "/cdn",
          overrides: {
            staticBehaviorOptions: {
              functionAssociations: [
                {
                  eventType: FunctionEventType.VIEWER_REQUEST,
                  function: new CloudFrontFunction(stack, "UserFn", {
                    code: FunctionCode.fromInline(
                      "function handler(event) { return event.request; }",
                    ),
                  }),
                },
              ],
            },
          },
        }),
    ).toThrow(
      /associates a CloudFront function with viewer-request, but serving `assetPrefix`/,
    );
  });

  const userFn = (stack: Stack, eventType: FunctionEventType) => ({
    eventType,
    function: new CloudFrontFunction(stack, `UserFn${eventType}`, {
      code: FunctionCode.fromInline(
        "function handler(event) { return event.request || event.response; }",
      ),
    }),
  });

  it.each(["dynamicBehaviorOptions", "imageBehaviorOptions"] as const)(
    "refuses a %s override that would replace the x-forwarded-host function",
    (overrideName) => {
      // The runtime trusts `x-forwarded-host` on Function URL events because
      // this function overwrites it; replaced, a viewer's own header reaches it.
      const { stack, distributionProps } = setup([]);
      expect(
        () =>
          new NextjsDistribution(stack, "Distribution", {
            ...distributionProps,
            overrides: {
              [overrideName]: {
                functionAssociations: [
                  userFn(stack, FunctionEventType.VIEWER_REQUEST),
                ],
              },
            },
          }),
      ).toThrow(
        new RegExp(`overrides\\.${overrideName}\\.functionAssociations`),
      );
    },
  );

  it("keeps the x-forwarded-host function next to an override's other associations", () => {
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      overrides: {
        dynamicBehaviorOptions: {
          functionAssociations: [
            userFn(stack, FunctionEventType.VIEWER_RESPONSE),
          ],
        },
      },
    });
    const config = Object.values(
      Template.fromStack(stack).findResources("AWS::CloudFront::Distribution"),
    )[0].Properties.DistributionConfig;
    const eventTypes = (
      config.DefaultCacheBehavior.FunctionAssociations as Array<{
        EventType: string;
      }>
    ).map((association) => association.EventType);
    expect(eventTypes.sort()).toEqual(["viewer-request", "viewer-response"]);
  });

  it("rewrites an assetPrefix back onto the basePath S3 keys", () => {
    const { stack, distributionProps } = setup([], { basePath: "/base" });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      assetPrefix: "/cdn",
    });
    expect(pathPatterns(stack)).toContain("/cdn/_next/static*");
    const fns = Template.fromStack(stack).findResources(
      "AWS::CloudFront::Function",
    );
    const code = Object.values(fns)
      .map((fn) => fn.Properties.FunctionCode as string)
      .find((it) => it.includes("request.uri.slice"));
    // The objects are at `base/_next/static/...`: `assetPrefix` replaces the
    // `basePath` prefix in the URL, so the rewrite has to put it back.
    expect(code).toContain('"/base" + request.uri.slice(4)');
  });

  it("serves bundles under the path an absolute assetPrefix carries", () => {
    // `next build` compiles a `/custom-asset-prefix/_next/:path+ → /_next/:path+`
    // rewrite of its own for an absolute prefix with a path, so `next start` serves
    // every bundle under that path as well. A CDN fronting this distribution there
    // gets the same request, and without a behavior it reaches the compute origin
    // and 404s. Measured against `test/e2e/app-dir/asset-prefix-absolute`, whose
    // one case failed on exactly that.
    for (const assetPrefix of [
      "https://example.vercel.sh/custom-asset-prefix",
      "//example.vercel.sh/custom-asset-prefix/",
    ]) {
      const { stack, distributionProps } = setup([]);
      new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        assetPrefix,
      });
      expect(pathPatterns(stack)).toContain(
        "/custom-asset-prefix/_next/static*",
      );
      const code = Object.values(
        Template.fromStack(stack).findResources("AWS::CloudFront::Function"),
      )
        .map((fn) => fn.Properties.FunctionCode as string)
        .find((it) => it.includes("request.uri.slice"));
      expect(code).toContain('"" + request.uri.slice(20)');
    }
  });

  it("adds no behavior for an assetPrefix that needs none", () => {
    // An absolute prefix with no path of its own names an origin this distribution
    // does not serve, and a prefix equal to the basePath one is what Next.js
    // defaults to when `basePath` is set — `_next/static*` already resolves under
    // it, and a duplicate pattern would make CloudFront reject the distribution.
    for (const [assetPrefix, basePath] of [
      ["https://cdn.example.com", undefined],
      ["https://cdn.example.com/", undefined],
      ["//cdn.example.com", undefined],
      ["/base", "/base"],
      ["https://cdn.example.com/base", "/base"],
      ["", undefined],
    ] as const) {
      const { stack, distributionProps } = setup([], { basePath });
      new NextjsDistribution(stack, "Distribution", {
        ...distributionProps,
        assetPrefix,
      });
      const patterns = pathPatterns(stack);
      expect(patterns.filter((p) => p.includes("_next/static"))).toHaveLength(
        1,
      );
      // The x-forwarded-host function is always there on function compute; the
      // rewrite one should not be.
      const codes = Object.values(
        Template.fromStack(stack).findResources("AWS::CloudFront::Function"),
      ).map((fn) => fn.Properties.FunctionCode as string);
      expect(codes.some((it) => it.includes("request.uri.slice"))).toBe(false);
    }
  });

  it("counts the assetPrefix behavior against the budget", () => {
    const { stack, distributionProps } = setup([], {
      publicDirEntries: Array.from({ length: 22 }, (_, i) => `file${i}.txt`),
    });
    // 3 fixed + 22 public = 25, exactly the limit; the assetPrefix one is the
    // 26th, and a limit error that did not count it would come as a deploy
    // failure instead.
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          assetPrefix: "/cdn",
          maxCacheBehaviors: 25,
        }),
    ).toThrow(/26 CloudFront cache behaviors.*4 used by cdk-nextjs itself/s);
  });

  it("does not cache a dynamic response that sends no Cache-Control", () => {
    // CDK's `CachePolicy` default is a day, which cached every route handler
    // without a `Cache-Control` - `/api/echo` in app-playground - for 24 hours.
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", distributionProps);
    Template.fromStack(stack).hasResourceProperties(
      "AWS::CloudFront::CachePolicy",
      {
        CachePolicyConfig: Match.objectLike({
          Comment: Match.stringLikeRegexp("Dynamic"),
          DefaultTTL: 0,
          MinTTL: 0,
        }),
      },
    );
  });

  it("wildcards a public/ name CloudFront cannot spell", () => {
    // `public/hello world.jpg` is a valid Next.js asset, but a space cannot appear
    // in a path pattern, so cdk-nextjs threw at synth and the app could not be
    // deployed at all. CloudFront matches the *decoded* path, and `?` matches one
    // byte of it, so one `?` per UTF-8 byte is the narrowest pattern that
    // matches. Not one per percent-encoded character: `hello???world.jpg`
    // deploys and then never matches, which is a 404 rather than a synth error.
    const { stack, distributionProps } = setup([], {
      publicDirEntries: ["hello world.jpg", "äöüščří.png", "favicon.ico"],
    });
    new NextjsDistribution(stack, "Distribution", distributionProps);
    expect(pathPatterns(stack)).toEqual(
      expect.arrayContaining([
        "hello?world.jpg",
        // 7 characters, 2 UTF-8 bytes each.
        `${"?".repeat(14)}.png`,
        "favicon.ico",
      ]),
    );
  });

  it("wildcards a public/ directory name the same way", () => {
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      publicDirEntries: [{ name: "my images", isDirectory: true }],
    });
    expect(pathPatterns(stack)).toContain("my?images/*");
  });

  it("rejects a public/ name too long to express as a path pattern", () => {
    const { stack, distributionProps } = setup([], {
      publicDirEntries: [`${"ä".repeat(130)}.png`],
    });
    expect(
      () => new NextjsDistribution(stack, "Distribution", distributionProps),
    ).toThrow(/needs a 264-character CloudFront path pattern/);
  });

  it("skips a public/ entry whose pattern would be wildcards alone", () => {
    // `фото/` is `????????/*`, which matches any 8-byte first segment. Public
    // behaviors are added ahead of the compute ones, so `/products/42` would go
    // to S3 and 403. The entry gets no behavior and a warning instead.
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      publicDirEntries: [
        { name: "фото", isDirectory: true },
        { name: "图", isDirectory: false },
        { name: "фото-1", isDirectory: true },
      ],
    });
    const patterns = pathPatterns(stack);
    expect(patterns).not.toContain(`${"?".repeat(8)}/*`);
    expect(patterns).not.toContain("???");
    // One literal character keeps a pattern narrow enough to keep.
    expect(patterns).toContain(`${"?".repeat(8)}-1/*`);
    Annotations.fromStack(stack).hasWarning(
      "*",
      Match.stringLikeRegexp('"фото", "图"'),
    );
  });

  it("does not count a skipped public/ entry against the budget", () => {
    const { stack, distributionProps } = setup([], {
      publicDirEntries: [
        ...Array.from({ length: 22 }, (_, i) => `file${i}.txt`),
        "图",
      ],
    });
    // 3 fixed + 22 = 25, exactly the limit; the skipped entry adds nothing.
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          maxCacheBehaviors: 25,
        }),
    ).not.toThrow();
  });

  it("checks the length of the final pattern, basePath and /* included", () => {
    // 83 three-byte characters + ".pdf" is a 253-character pattern on its own,
    // under the limit; `/docs/` in front takes it to 259, which CloudFront
    // rejects at deploy.
    const name = `${"图".repeat(83)}.pdf`;
    const { stack, distributionProps } = setup([], {
      publicDirEntries: [name],
    });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          basePath: "/docs",
        }),
    ).toThrow(/needs a 259-character CloudFront path pattern/);

    const { stack: dirStack, distributionProps: dirProps } = setup([]);
    expect(
      () =>
        new NextjsDistribution(dirStack, "Distribution", {
          ...dirProps,
          // 254 characters, under the limit until the `/*`.
          publicDirEntries: [
            { name: `ab${"图".repeat(84)}`, isDirectory: true },
          ],
        }),
    ).toThrow(/needs a 256-character/);
  });

  it("drops the cache key when an override disables dynamic caching", () => {
    // CloudFront rejects a policy that caches nothing but keys on headers. CDK
    // used to raise `maxTtl: 0` to the day-long default, so the override
    // deployed; with a default of 0 it is honored, and must stay deployable.
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      overrides: {
        dynamicCachePolicyProps: { maxTtl: Duration.seconds(0) },
      },
    });
    Template.fromStack(stack).hasResourceProperties(
      "AWS::CloudFront::CachePolicy",
      {
        CachePolicyConfig: Match.objectLike({
          Comment: Match.stringLikeRegexp("Dynamic"),
          DefaultTTL: 0,
          MaxTTL: 0,
          MinTTL: 0,
          ParametersInCacheKeyAndForwardedToOrigin: {
            CookiesConfig: { CookieBehavior: "none" },
            EnableAcceptEncodingBrotli: false,
            EnableAcceptEncodingGzip: false,
            HeadersConfig: { HeaderBehavior: "none" },
            QueryStringsConfig: { QueryStringBehavior: "none" },
          },
        }),
      },
    );
  });

  it("keeps the cache key when a zero maxTtl is raised by another TTL", () => {
    // CDK raises `maxTtl` to `defaultTtl`, so this policy caches for an hour.
    // Dropping the key for it would serve one viewer's page to every viewer.
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      overrides: {
        dynamicCachePolicyProps: {
          maxTtl: Duration.seconds(0),
          defaultTtl: Duration.hours(1),
        },
      },
    });
    Template.fromStack(stack).hasResourceProperties(
      "AWS::CloudFront::CachePolicy",
      {
        CachePolicyConfig: Match.objectLike({
          Comment: Match.stringLikeRegexp("Dynamic"),
          MaxTTL: 3600,
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            CookiesConfig: { CookieBehavior: "all" },
            QueryStringsConfig: { QueryStringBehavior: "all" },
          }),
        }),
      },
    );
  });

  it("keys the dynamic cache only on headers the origin reads", () => {
    // `x-matched-path` is stripped by the runtime and `x-next-cache-tags` is
    // never sent by viewers: keying on either spends a header slot and lets a
    // client fragment the cache for nothing.
    const { stack, distributionProps } = setup([]);
    new NextjsDistribution(stack, "Distribution", distributionProps);
    const policies = Template.fromStack(stack).findResources(
      "AWS::CloudFront::CachePolicy",
      {
        Properties: {
          CachePolicyConfig: { Comment: Match.stringLikeRegexp("Dynamic") },
        },
      },
    );
    const [policy] = Object.values(policies);
    const headers: string[] =
      policy.Properties.CachePolicyConfig
        .ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers;
    expect(headers).not.toContain("x-matched-path");
    expect(headers).not.toContain("x-next-cache-tags");
    expect(headers).toContain("rsc");
  });

  it("rejects splitting on a deployment type that cannot route it", () => {
    const { stack, functionGroups, functionGroupBehaviors, distributionProps } =
      setup(["api"]);
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          nextjsType: NextjsType.GLOBAL_CONTAINERS,
          loadBalancer: undefined,
          functionGroups,
          functionGroupBehaviors,
        }),
    ).toThrow(/only supported by NextjsGlobalFunctions/);
  });
});

/**
 * The viewer-request function, run as CloudFront would run it.
 *
 * It is authored as a string inside a TypeScript template literal, so every
 * backslash in it is escaped twice - and a regex that collapses slashes is nothing
 * but backslashes. Asserting on behavior rather than on the text is what catches an
 * escaping mistake, which a snapshot would happily record.
 */
describe("the viewer-request CloudFront Function", () => {
  interface QueryValue {
    value: string;
    multiValue?: Array<{ value: string }>;
  }
  interface FunctionRequest {
    uri: string;
    querystring: Record<string, QueryValue>;
    headers: Record<string, { value: string }>;
  }
  type FunctionResult =
    | FunctionRequest
    | { statusCode: number; headers: Record<string, { value: string }> };

  const handler = (() => {
    const stack = new Stack(new App(), "FnStack");
    const fn = new LambdaFunction(stack, "Fn", {
      code: Code.fromInline("exports.handler = () => {};"),
      handler: "index.handler",
      runtime: Runtime.NODEJS_22_X,
    });
    new NextjsDistribution(stack, "Distribution", {
      assetsBucket: new Bucket(stack, "Assets"),
      functionUrl: new FunctionUrl(stack, "Url", {
        function: fn,
        authType: FunctionUrlAuthType.AWS_IAM,
      }),
      nextjsType: NextjsType.GLOBAL_FUNCTIONS,
      publicDirEntries: [],
    });
    const functions = Template.fromStack(stack).findResources(
      "AWS::CloudFront::Function",
    );
    const code = Object.values(functions)[0].Properties.FunctionCode as string;
    return runInNewContext(`${code}\nhandler`) as (event: {
      request: FunctionRequest;
    }) => Promise<FunctionResult>;
  })();

  const send = (
    uri: string,
    querystring: Record<string, QueryValue> = {},
  ): Promise<FunctionResult> =>
    handler({
      request: { uri, querystring, headers: { host: { value: "a.test" } } },
    });

  const redirect = (result: FunctionResult) => ({
    statusCode: (result as { statusCode: number }).statusCode,
    location: result.headers.location?.value,
  });

  it.each([
    ["//", "/"],
    ["///", "/"],
    ["/foo//bar", "/foo/bar"],
    ["/basepath//to-sv", "/basepath/to-sv"],
    ["/a\\b", "/a/b"],
  ])("redirects %s to %s with a 308", async (uri, location) => {
    expect(redirect(await send(uri))).toEqual({ statusCode: 308, location });
  });

  it("keeps the query on the redirect, including repeated keys", async () => {
    // CloudFront's shape for a repeated key: `multiValue` holds every value,
    // the first included, and `value` repeats that first one.
    const result = await send("/x//y", {
      json: { value: "true" },
      a: { value: "1", multiValue: [{ value: "1" }, { value: "2" }] },
      flag: { value: "" },
    });
    expect(redirect(result).location).toBe("/x/y?json=true&a=1&a=2&flag");
  });

  it("passes percent-encoded query values through without re-encoding", async () => {
    // CloudFront hands the function the values still encoded, as sent.
    const result = await send("/x//y", {
      a: { value: "%20b%26c" },
      p: { value: "1+2" },
    });
    expect(redirect(result).location).toBe("/x/y?a=%20b%26c&p=1+2");
  });

  it("passes an ordinary path through with x-forwarded-host set", async () => {
    const result = (await send("/a/b")) as FunctionRequest;
    expect(result.uri).toBe("/a/b");
    // CloudFront rewrites `host` to the origin domain, so the app would otherwise
    // build every absolute URL against the Function URL's hostname.
    expect(result.headers["x-forwarded-host"].value).toBe("a.test");
  });

  it("overwrites a client-supplied x-forwarded-host", async () => {
    // The runtime trusts this header behind the Function URL, so a viewer's
    // own value must not survive to build redirects or origin checks.
    const result = (await handler({
      request: {
        uri: "/a",
        querystring: {},
        headers: {
          host: { value: "a.test" },
          "x-forwarded-host": { value: "evil.test" },
        },
      },
    })) as FunctionRequest;
    expect(result.headers["x-forwarded-host"].value).toBe("a.test");
  });
});

/**
 * `viewerRequestFunctionCode`, run as CloudFront would run it on each behavior,
 * for the same reason as the suite above.
 */
describe("viewerRequestFunctionCode", () => {
  const BASIC_AUTH = `
    function viewerRequest(event) {
      var auth = event.request.headers.authorization;
      if (auth && auth.value === "Basic dXNlcjpwYXNz") return;
      return {
        statusCode: 401,
        statusDescription: "Unauthorized",
        headers: { "www-authenticate": { value: 'Basic realm="preview"' } },
      };
    }
  `;
  const AUTHORIZED = { authorization: "Basic dXNlcjpwYXNz" };

  interface FunctionRequest {
    uri: string;
    querystring: Record<string, { value: string }>;
    headers: Record<string, { value: string }>;
  }
  type FunctionResult =
    | FunctionRequest
    | { statusCode: number; headers: Record<string, { value: string }> };
  type Handler = (event: {
    request: FunctionRequest;
  }) => Promise<FunctionResult>;
  /** What `viewerRequestKeyValueStore` holds, as `cf.kvs()` would read it. */
  const fakeCloudFrontModule = (values: Record<string, string>) => ({
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in values)) throw new Error(`key not found: ${key}`);
        return values[key];
      },
    }),
  });
  interface Behavior {
    PathPattern: string;
    FunctionAssociations?: Array<{
      EventType: string;
      FunctionARN: { "Fn::GetAtt": [string, string] };
    }>;
  }

  const synth = (
    props: {
      code?: string;
      nextjsType?: NextjsType;
      assetPrefix?: string;
      basePath?: string;
      keyValueStore?: boolean;
      overrides?: (stack: Stack) => NextjsDistributionOverrides;
    } = {},
  ) => {
    const stack = new Stack(new App(), "TestStack");
    const keyValueStore = props.keyValueStore
      ? new KeyValueStore(stack, "Kvs")
      : undefined;
    const compute =
      props.nextjsType === NextjsType.GLOBAL_CONTAINERS
        ? {
            loadBalancer: new ApplicationLoadBalancer(stack, "Alb", {
              vpc: new Vpc(stack, "Vpc"),
            }),
          }
        : {
            functionUrl: new FunctionUrl(stack, "Url", {
              function: new LambdaFunction(stack, "Fn", {
                code: Code.fromInline("exports.handler = () => {};"),
                handler: "index.handler",
                runtime: Runtime.NODEJS_22_X,
              }),
              authType: FunctionUrlAuthType.AWS_IAM,
            }),
          };
    new NextjsDistribution(stack, "Distribution", {
      ...compute,
      assetsBucket: new Bucket(stack, "Assets"),
      assetPrefix: props.assetPrefix,
      basePath: props.basePath,
      nextjsType: props.nextjsType ?? NextjsType.GLOBAL_FUNCTIONS,
      overrides: props.overrides?.(stack),
      publicDirEntries: [{ name: "favicon.ico", isDirectory: false }],
      viewerRequestFunctionCode:
        props.code === undefined
          ? undefined
          : FunctionCode.fromInline(props.code),
      viewerRequestKeyValueStore: keyValueStore,
    });
    const template = Template.fromStack(stack);
    const functions = template.findResources("AWS::CloudFront::Function");
    const config = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )[0].Properties.DistributionConfig;
    const behaviors: Behavior[] = [
      { PathPattern: "*", ...config.DefaultCacheBehavior },
      ...config.CacheBehaviors,
    ];
    /** The viewer-request function on the behavior for `pathPattern`. */
    const functionFor = (pathPattern: string) => {
      const behavior = behaviors.find((it) => it.PathPattern === pathPattern)!;
      const association = behavior.FunctionAssociations!.find(
        (it) => it.EventType === "viewer-request",
      )!;
      return functions[association.FunctionARN["Fn::GetAtt"][0]].Properties;
    };
    /**
     * That function's handler, runnable. `node:vm` scripts can't `import`, so
     * the `cloudfront` module is handed in as the binding the import makes.
     */
    const handlerFor = (
      pathPattern: string,
      kvsValues: Record<string, string> = {},
    ): Handler => {
      const code = (functionFor(pathPattern).FunctionCode as string).replace(
        /^\s*import cf from "cloudfront";/,
        "",
      );
      return runInNewContext(`${code}\nhandler`, {
        cf: fakeCloudFrontModule(kvsValues),
      }) as Handler;
    };
    return { behaviors, functions, functionFor, handlerFor, stack };
  };

  const request = (uri: string, headers: Record<string, string> = {}) => ({
    request: {
      uri,
      querystring: {},
      headers: Object.fromEntries(
        Object.entries({ host: "a.test", ...headers }).map(([name, value]) => [
          name,
          { value },
        ]),
      ),
    },
  });
  const status = (result: FunctionResult) =>
    (result as { statusCode?: number }).statusCode;

  it.each([NextjsType.GLOBAL_FUNCTIONS, NextjsType.GLOBAL_CONTAINERS])(
    "gates every behavior on %s, static assets included",
    async (nextjsType) => {
      const { behaviors, handlerFor } = synth({ code: BASIC_AUTH, nextjsType });
      expect(behaviors.map((it) => it.PathPattern).sort()).toEqual([
        "*",
        "_next/image*",
        "_next/static*",
        "favicon.ico",
      ]);
      for (const { PathPattern } of behaviors) {
        const handler = handlerFor(PathPattern);
        expect(status(await handler(request("/x")))).toBe(401);
        const passed = (await handler(
          request("/x", AUTHORIZED),
        )) as FunctionRequest;
        expect(passed.uri).toBe("/x");
      }
    },
  );

  it("shares one pass-through function between dynamic and static on Global Containers", () => {
    const { behaviors, functions } = synth({
      code: BASIC_AUTH,
      nextjsType: NextjsType.GLOBAL_CONTAINERS,
    });
    const [logicalId, ...rest] = Object.keys(functions);
    expect(rest).toHaveLength(0);
    expect(behaviors.map((it) => it.PathPattern).sort()).toEqual([
      "*",
      "_next/image*",
      "_next/static*",
      "favicon.ico",
    ]);
    for (const { FunctionAssociations } of behaviors) {
      expect(FunctionAssociations).toEqual([
        {
          EventType: "viewer-request",
          FunctionARN: { "Fn::GetAtt": [logicalId, "FunctionARN"] },
        },
      ]);
    }
  });

  it("accepts viewerRequest declared after another variable", async () => {
    const handler = synth({
      code: `var x = 1, viewerRequest = (event) => ({ statusCode: 401 });`,
    }).handlerFor("_next/static*");
    expect(status(await handler(request("/x")))).toBe(401);
  });

  it("accepts viewerRequest defined as a const arrow function", async () => {
    const handler = synth({
      code: `const viewerRequest = async (event) => ({ statusCode: 401 });`,
    }).handlerFor("_next/static*");
    expect(status(await handler(request("/x")))).toBe(401);
  });

  it("runs before the repeated-slash redirect", async () => {
    // Otherwise `/a//b` would answer 308 to a viewer who never authenticated.
    const handler = synth({ code: BASIC_AUTH }).handlerFor("*");
    expect(status(await handler(request("/a//b")))).toBe(401);
    expect(status(await handler(request("/a//b", AUTHORIZED)))).toBe(308);
  });

  it("associates the store with every function it runs in", () => {
    const { behaviors, functionFor, functions } = synth({
      code: BASIC_AUTH,
      keyValueStore: true,
      assetPrefix: "/cdn",
    });
    expect(Object.keys(functions)).toHaveLength(3);
    for (const { PathPattern } of behaviors) {
      const { FunctionConfig } = functionFor(PathPattern);
      expect(FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
      expect(FunctionConfig.KeyValueStoreAssociations).toEqual([
        { KeyValueStoreARN: { "Fn::GetAtt": [expect.any(String), "Arn"] } },
      ]);
    }
  });

  it("reads credentials from the KeyValueStore", async () => {
    const handler = synth({
      keyValueStore: true,
      code: `import cf from "cloudfront";
        const kvs = cf.kvs();
        async function viewerRequest(event) {
          const auth = event.request.headers.authorization;
          if (auth && auth.value === "Basic " + (await kvs.get("basic-auth"))) {
            return;
          }
          return { statusCode: 401, statusDescription: "Unauthorized" };
        }
      `,
    }).handlerFor("_next/static*", { "basic-auth": "dXNlcjpwYXNz" });
    expect(status(await handler(request("/x")))).toBe(401);
    expect(
      ((await handler(request("/x", AUTHORIZED))) as FunctionRequest).uri,
    ).toBe("/x");
  });

  it("refuses a KeyValueStore without code to read it", () => {
    expect(() => synth({ keyValueStore: true })).toThrow(
      /`viewerRequestKeyValueStore` .* needs `viewerRequestFunctionCode`/,
    );
  });

  it("can't keep a viewer's x-forwarded-host past cdk-nextjs's overwrite", async () => {
    const handler = synth({
      code: `
        function viewerRequest(event) {
          event.request.headers["x-forwarded-host"] = { value: "evil.test" };
          return event.request;
        }
      `,
    }).handlerFor("*");
    const result = (await handler(request("/x"))) as FunctionRequest;
    expect(result.headers["x-forwarded-host"].value).toBe("a.test");
  });

  it("carries on with a request it returns as a new object", async () => {
    const handler = synth({
      code: `
        function viewerRequest(event) {
          return { uri: "/y", querystring: {}, headers: event.request.headers };
        }
      `,
    }).handlerFor("_next/static*");
    expect(((await handler(request("/x"))) as FunctionRequest).uri).toBe("/y");
  });

  it("runs inside the assetPrefix rewrite, in place of the static function", async () => {
    const { behaviors, handlerFor } = synth({
      code: BASIC_AUTH,
      assetPrefix: "/cdn",
    });
    const prefixed = behaviors.find(
      (it) => it.PathPattern === "/cdn/_next/static*",
    )!;
    // One viewer-request function per behavior, or CloudFront rejects it.
    expect(
      prefixed.FunctionAssociations!.filter(
        (it) => it.EventType === "viewer-request",
      ),
    ).toHaveLength(1);
    const handler = handlerFor("/cdn/_next/static*");
    expect(status(await handler(request("/cdn/_next/static/a.js")))).toBe(401);
    const passed = (await handler(
      request("/cdn/_next/static/a.js", AUTHORIZED),
    )) as FunctionRequest;
    expect(passed.uri).toBe("/_next/static/a.js");
  });

  it("adds no functions when unset", () => {
    const { behaviors, functions } = synth();
    const staticBehavior = behaviors.find(
      (it) => it.PathPattern === "_next/static*",
    )!;
    expect(staticBehavior.FunctionAssociations).toBeUndefined();
    const [fn, ...rest] = Object.values(functions).map((it) => it.Properties);
    expect(rest).toHaveLength(0);
    // The marker is dropped, not left in the deployed function.
    expect(fn.FunctionCode).toMatch(
      /^\s*async function handler\(event\) \{\n\s*const request/,
    );
    expect(fn.FunctionConfig.KeyValueStoreAssociations).toBeUndefined();
  });

  it.each([false, true])(
    "runs every cdk-nextjs function on cloudfront-js-2.0 (hook set: %s)",
    (hooked) => {
      const { functions } = synth({
        code: hooked ? BASIC_AUTH : undefined,
        assetPrefix: "/cdn",
      });
      const runtimes = Object.values(functions).map(
        (it) => it.Properties.FunctionConfig.Runtime,
      );
      expect(runtimes).toHaveLength(hooked ? 3 : 2);
      expect(new Set(runtimes)).toEqual(new Set(["cloudfront-js-2.0"]));
    },
  );

  it.each(["dynamicBehaviorOptions", "imageBehaviorOptions"] as const)(
    "refuses a %s override that claims viewer-request on Global Containers",
    (overrideName) => {
      expect(() =>
        synth({
          code: BASIC_AUTH,
          nextjsType: NextjsType.GLOBAL_CONTAINERS,
          overrides: (stack) => ({
            [overrideName]: {
              functionAssociations: [
                {
                  eventType: FunctionEventType.VIEWER_REQUEST,
                  function: new CloudFrontFunction(stack, "UserFn", {
                    code: FunctionCode.fromInline(
                      "function handler(event) { return event.request; }",
                    ),
                  }),
                },
              ],
            },
          }),
        }),
      ).toThrow(
        new RegExp(
          `overrides\\.${overrideName}\\.functionAssociations.*viewerRequestFunctionCode`,
        ),
      );
    },
  );

  it("refuses a distributionProps.defaultBehavior override", () => {
    expect(() =>
      synth({
        code: BASIC_AUTH,
        overrides: () => ({
          distributionProps: {
            defaultBehavior: {
              origin: new HttpOrigin("example.com"),
            },
          },
        }),
      }),
    ).toThrow(/overrides\.distributionProps\.defaultBehavior/);
  });

  it("lets a basePath app replace the default behavior", () => {
    expect(() =>
      synth({
        code: BASIC_AUTH,
        basePath: "/app",
        overrides: () => ({
          distributionProps: {
            defaultBehavior: { origin: new HttpOrigin("example.com") },
          },
        }),
      }),
    ).not.toThrow();
  });

  it("keeps cdk-nextjs's code out of the deployed indentation", () => {
    const { functionFor } = synth({ code: BASIC_AUTH });
    const code = functionFor("*").FunctionCode as string;
    const own = code.slice(code.indexOf("async function handler"));
    expect(own).not.toMatch(/^[ \t]/m);
  });

  it("warns, rather than measures, when the code contains a token", () => {
    const { stack } = synth({
      code: `function viewerRequest(event) { return ${Lazy.string({ produce: () => '"x"' })}; }`,
    });
    Annotations.fromStack(stack).hasWarning(
      "*",
      Match.stringLikeRegexp("contains a CDK token"),
    );
  });

  it("refuses a static override that already claims viewer-request", () => {
    expect(() =>
      synth({
        code: BASIC_AUTH,
        overrides: (stack) => ({
          staticBehaviorOptions: {
            functionAssociations: [
              {
                eventType: FunctionEventType.VIEWER_REQUEST,
                function: new CloudFrontFunction(stack, "UserFn", {
                  code: FunctionCode.fromInline(
                    "function handler(event) { return event.request; }",
                  ),
                }),
              },
            ],
          },
        }),
      }),
    ).toThrow(/overrides\.staticBehaviorOptions\.functionAssociations/);
  });

  it.each([
    ["no viewerRequest", "var x = 1;", /must define `viewerRequest\(event\)`/],
    ...[
      "function handler(event) {}",
      "function* handler(event) {}",
      "const handler = (event) => event.request;",
      "let a = 1, handler = 2;",
      "var handler = (event) => event.request;",
      "var { handler } = { handler: (event) => event.request };",
      'globalThis["handler"] = (event) => event.request;',
      "var cdkNextjsHandler; handler = cdkNextjsHandler;",
    ].map((declaration): [string, string, RegExp] => [
      `handler in \`${declaration}\``,
      `${declaration}\nfunction viewerRequest(event) {}`,
      /uses the name `handler`/,
    ]),
    [
      "viewerRequest only compared, never declared",
      'const ok = typeof viewerRequest === "function";',
      /must define `viewerRequest\(event\)`/,
    ],
    [
      "viewerRequest only assigned as a property",
      "const cfg = {}; cfg.viewerRequest = function (event) {};",
      /must define `viewerRequest\(event\)`/,
    ],
    [
      "more than fits in a CloudFront Function",
      `function viewerRequest(event) {} /* ${"x".repeat(10 * 1024)} */`,
      /over CloudFront's limit of 10240/,
    ],
  ])("refuses code with %s", (_name, code, error) => {
    expect(() => synth({ code })).toThrow(error);
  });
});
