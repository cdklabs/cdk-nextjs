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
