import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
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

  it("adds no behavior for an assetPrefix that needs none", () => {
    // An absolute prefix names an origin this distribution does not serve, and a
    // prefix equal to the basePath one is what Next.js defaults to when `basePath`
    // is set — `_next/static*` already resolves under it, and a duplicate pattern
    // would make CloudFront reject the distribution.
    for (const [assetPrefix, basePath] of [
      ["https://cdn.example.com", undefined],
      ["//cdn.example.com", undefined],
      ["/base", "/base"],
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
