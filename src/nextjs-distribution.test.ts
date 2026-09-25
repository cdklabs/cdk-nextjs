import { runInNewContext } from "node:vm";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
} from "aws-cdk-lib/aws-cloudfront";
import {
  Code,
  Function as LambdaFunction,
  FunctionUrl,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { NextjsType } from "./constants";
import {
  NextjsDistribution,
  NextjsDistributionFunctionGroup,
} from "./nextjs-distribution";

/**
 * `functionGroups` routing at the edge. `NextjsBuild` is deliberately not
 * involved: these assertions are about behavior *order*, which is the one thing
 * CloudFront gets silently wrong, and constructing the distribution directly
 * avoids running a real `next build`.
 */
describe("NextjsDistribution function group behaviors", () => {
  const setup = (
    groupNames: string[],
    props: {
      routesFor?: (name: string) => string[];
      publicDirEntries?: string[];
      basePath?: string;
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
          routes: props.routesFor?.(name) ?? [`/${name}/**`],
          functionUrl: new FunctionUrl(stack, `Url${name}`, {
            function: fn,
            authType: FunctionUrlAuthType.AWS_IAM,
          }),
        };
      },
    );
    const defaultFn = new LambdaFunction(stack, "FnDefault", {
      code: Code.fromInline("exports.handler = () => {};"),
      handler: "index.handler",
      runtime: Runtime.NODEJS_22_X,
    });
    return {
      stack,
      functionGroups,
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

  it("orders overlapping group patterns most specific first", () => {
    // CloudFront stops at the first matching behavior, so `api/*` ahead of
    // `api/reports/*` would send every report request to the wrong function.
    const { stack, functionGroups, distributionProps } = setup(
      ["api", "reports"],
      {
        routesFor: (name) =>
          name === "api" ? ["/api/**"] : ["/api/reports/**"],
      },
    );
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
    });
    expect(pathPatterns(stack)).toEqual([
      "_next/static*",
      "_next/image*",
      "api/reports/*",
      "api/*",
    ]);
  });

  it("ranks by segment count before string length", () => {
    const { stack, functionGroups, distributionProps } = setup(["a", "b"], {
      routesFor: (name) =>
        name === "a" ? ["/a/b/**"] : ["/averyverylongsegment/**"],
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
    });
    expect(pathPatterns(stack).slice(2)).toEqual([
      "a/b/*",
      "averyverylongsegment/*",
    ]);
  });

  it("puts an exact pattern ahead of a wildcard of the same depth", () => {
    // `a/*` and `a/b` are the same length and the same segment count, so ranking
    // on those alone left the order up to the sort's stability — and `a/*` first
    // swallows `a/b`, sending group b's only route to group a's function. The
    // literal prefix is what decides it: `a/b` matches strictly less.
    const { stack, functionGroups, distributionProps } = setup(["a", "b"], {
      routesFor: (name) => (name === "a" ? ["/a/**"] : ["/a/b"]),
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
    });
    expect(pathPatterns(stack).slice(2)).toEqual(["a/b", "a/*"]);
  });

  it("orders data-route patterns by their literal prefix too", () => {
    // Every `_next/data` pattern starts with the same two literal segments and a
    // wildcard for the build id, so the part that distinguishes them comes after
    // a `*`. `_next/data/*/docs/*` would otherwise be ordered by length against
    // `_next/data/*/pricing.json` and could claim `/docs/x.json` for the wrong
    // group.
    const { stack, functionGroups, distributionProps } = setup(
      ["docs", "mkt"],
      {
        routesFor: (name) => (name === "docs" ? ["/docs/**"] : ["/pricing"]),
      },
    );
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      hasDataRoutes: true,
    });
    const patterns = pathPatterns(stack).slice(2);
    expect(patterns.indexOf("_next/data/*/docs/*")).toBeLessThan(
      patterns.indexOf("_next/data/*/pricing.json"),
    );
  });

  it("adds the trailing-slash form of an exact pattern for a trailingSlash app", () => {
    // With `trailingSlash: true` the app links to `/pricing/`, which `pricing`
    // does not match: the canonical URL fell through to the default function,
    // which does not have the route packaged.
    const { stack, functionGroups, distributionProps } = setup(["mkt"], {
      routesFor: () => ["/pricing"],
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      trailingSlash: true,
    });
    expect(pathPatterns(stack).slice(2).sort()).toEqual([
      "pricing",
      "pricing/",
    ]);
  });

  it("keeps the two slash variants distinct under a basePath", () => {
    // `getPathPattern` used to join through a helper that strips trailing
    // slashes, so `pricing` and `pricing/` both became `/base/pricing`: two
    // behaviors with the same path pattern, which CloudFront rejects at deploy
    // with no hint that `trailingSlash` is what produced the duplicate.
    const { stack, functionGroups, distributionProps } = setup(["mkt"], {
      routesFor: () => ["/pricing"],
      basePath: "/base",
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      trailingSlash: true,
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
      () => new NextjsDistribution(stack, "Distribution", distributionProps),
    ).toThrow(/26 CloudFront cache behaviors.*5 used by cdk-nextjs itself/s);
  });

  it("does not count basePath behaviors for a basePath of /", () => {
    // `basePath: "/"` normalizes to no basePath and adds no behaviors, so
    // counting 2 for it could reject an app that is under the limit.
    const { stack, distributionProps } = setup([], {
      basePath: "/",
      publicDirEntries: Array.from({ length: 22 }, (_, i) => `file${i}.txt`),
    });
    expect(
      () => new NextjsDistribution(stack, "Distribution", distributionProps),
    ).not.toThrow();
  });

  it("routes a group's Pages Router data URLs alongside its HTML", () => {
    const { stack, functionGroups, distributionProps } = setup(["blog"], {
      routesFor: () => ["/blog/**", "/pricing"],
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
      hasDataRoutes: true,
    });
    expect(pathPatterns(stack).slice(2).sort()).toEqual([
      "_next/data/*/blog/*",
      "_next/data/*/pricing.json",
      "blog/*",
      "pricing",
    ]);
  });

  it("points each group's behaviors at that group's own origin", () => {
    const { stack, functionGroups, distributionProps } = setup(["api"], {
      routesFor: () => ["/api/**", "/health"],
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
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
    const { stack, functionGroups, distributionProps } = setup(["api"], {
      routesFor: () => ["/api/**"],
      basePath: "/base",
    });
    new NextjsDistribution(stack, "Distribution", {
      ...distributionProps,
      functionGroups,
    });
    expect(pathPatterns(stack)).toContain("/base/api/*");
  });

  it("names every claim on the behavior budget when it is exceeded", () => {
    const { stack, functionGroups, distributionProps } = setup(["api"], {
      routesFor: () => ["/api/**"],
      publicDirEntries: Array.from({ length: 22 }, (_, i) => `file${i}.txt`),
    });
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          functionGroups,
        }),
    ).toThrow(
      /26 CloudFront cache behaviors.*1 for `functionGroups` patterns/s,
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
    ).toThrow(/already associates a CloudFront function with viewer-request/);
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
        }),
    ).toThrow(/26 CloudFront cache behaviors.*4 used by cdk-nextjs itself/s);
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

  it("rejects splitting on a deployment type that cannot route it", () => {
    const { stack, functionGroups, distributionProps } = setup(["api"]);
    expect(
      () =>
        new NextjsDistribution(stack, "Distribution", {
          ...distributionProps,
          nextjsType: NextjsType.GLOBAL_CONTAINERS,
          loadBalancer: undefined,
          functionGroups,
        }),
    ).toThrow(/NextjsDistributionProps.loadBalancer/);
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
    }) => FunctionResult;
  })();

  const send = (
    uri: string,
    querystring: Record<string, QueryValue> = {},
  ): FunctionResult =>
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
  ])("redirects %s to %s with a 308", (uri, location) => {
    expect(redirect(send(uri))).toEqual({ statusCode: 308, location });
  });

  it("keeps the query on the redirect, including repeated keys", () => {
    const result = send("/x//y", {
      json: { value: "true" },
      a: { value: "1", multiValue: [{ value: "2" }] },
      flag: { value: "" },
    });
    expect(redirect(result).location).toBe("/x/y?json=true&a=1&a=2&flag");
  });

  it("passes an ordinary path through with x-forwarded-host set", () => {
    const result = send("/a/b") as FunctionRequest;
    expect(result.uri).toBe("/a/b");
    // CloudFront rewrites `host` to the origin domain, so the app would otherwise
    // build every absolute URL against the Function URL's hostname.
    expect(result.headers["x-forwarded-host"].value).toBe("a.test");
  });
});
