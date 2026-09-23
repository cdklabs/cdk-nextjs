import { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { LOG_PREFIX, NextjsType } from "../constants";
import { OptionalNextjsBuildProps } from "../generated-structs/OptionalNextjsBuildProps";
import { OptionalNextjsCacheProps } from "../generated-structs/OptionalNextjsCacheProps";
import { NextjsBuild } from "../nextjs-build/nextjs-build";
import { NextjsCache, NextjsCacheOverrides } from "../nextjs-cache";
import { NextjsComputeBaseProps } from "../nextjs-compute/nextjs-compute-base-props";
import {
  NextjsFunctionGroup,
  NextjsFunctions,
  NextjsFunctionsOverrides,
  NextjsFunctionsProps,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsStaticAssets,
  NextjsStaticAssetsOverrides,
  NextjsStaticAssetsProps,
} from "../nextjs-static-assets";
import { prefixWithBasePath, resolveBasePath } from "../utils/base-path";

/**
 * Base overrides for the props passed to constructs within root/top-level Next.js constructs
 */
export interface NextjsBaseConstructOverrides {
  readonly nextjsBuildProps?: OptionalNextjsBuildProps;
  readonly nextjsCacheProps?: OptionalNextjsCacheProps;
  readonly nextjsStaticAssetsProps?: NextjsStaticAssetsProps;
}

/**
 * Adds the overrides that only apply to the two Functions `NextjsType`s. The
 * Containers types have no Lambda functions to configure, so they would silently
 * ignore these.
 */
export interface NextjsFunctionsConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsFunctionsProps?: NextjsFunctionsProps;
}

/**
 * Base overrides for constructs shared between all root/top-level Next.js constructs.
 */
export interface NextjsBaseOverrides {
  readonly nextjsCache?: NextjsCacheOverrides;
  readonly nextjsStaticAssets?: NextjsStaticAssetsOverrides;
}

export interface NextjsBaseProps {
  /**
   * Prefix to the URI path the app will be served at. Also namespaces the
   * static assets in S3, so it doubles as a way to host multiple apps or
   * branches out of one bucket.
   *
   * How this relates to the `basePath` in your app's `next.config.js` depends
   * on the construct, and synth fails on a combination that can't serve the
   * app:
   *
   * - `NextjsGlobalFunctions`/`NextjsGlobalContainers`: leave this unset and it
   *   follows your app's `basePath`, which is what you want — CloudFront serves
   *   static assets from S3 using the request path as the object key, so the two
   *   have to be identical and a mismatch 404s all of them. Setting a different
   *   value throws.
   * - `NextjsRegionalFunctions`: if you set this, the app's `basePath` must end
   *   with it — either equal to it, or prefixed by the stage or base path
   *   mapping API Gateway strips before matching resources (`basePath:
   *   "/prod/base"` with this set to `"/base"`). Leaving it unset while the app
   *   sets one is correct and common — an app served at the default `prod` stage
   *   sets `basePath: "/prod"` and leaves this alone.
   * - `NextjsRegionalContainers`: only namespaces the S3 bucket. The ALB sends
   *   every path to the container, which serves its own static assets, so this
   *   is unconstrained.
   * @example "/my-base-path"
   */
  readonly basePath?: string;
  /**
   * Command to generate optimized version of your Next.js app in container;
   * @default "npm run build"
   */
  readonly buildCommand?: string;
  /**
   * Directory where the Next.js application is located for local builds.
   * This should contain the package.json and Next.js application files.
   * This is where {@link NextjsBaseProps.buildCommand} is run.
   * @example join(import.meta.dirname, "..", "web") or "/path/to/nextjs/app"
   */
  readonly buildDirectory: string;
  /**
   * Bring your own S3 bucket for cache storage. When provided, cdk-nextjs
   * will use this bucket instead of creating a new one. Cache objects are
   * prefixed with `buildId` so multiple deployments can safely share one bucket.
   */
  readonly cacheBucket?: IBucket;
  /**
   * Bring your own DynamoDB table for revalidation metadata. When provided,
   * cdk-nextjs will use this table instead of creating a new one. The table
   * must have `pk` (String) as partition key and `sk` (String) as sort key.
   * Entries are partitioned by `buildId` so multiple deployments can safely
   * share one table.
   */
  readonly revalidationTable?: ITableV2;
  /**
   * Skips running `next build`. If `true`, you are responsible for running
   * `next build` before this construct is synthesized.
   * @default false
   */
  readonly skipBuild?: boolean;
  /**
   * Bring your own S3 bucket for static assets. When provided, cdk-nextjs
   * will deploy static assets to this bucket instead of creating a new one.
   * Use with `basePath` to isolate assets per branch when sharing a bucket.
   */
  readonly staticAssetsBucket?: IBucket;
  /**
   * Bring your own VPC.
   * If provided, will be passed via overrides to the ECS Cluster (for container-based constructs)
   * or to the Lambda function (for function-based constructs).
   * If not provided, ECS Cluster will create a VPC automatically for containers,
   * and Lambda functions will run outside a VPC.
   */
  readonly vpc?: IVpc;
}

/**
 * Required because if we add `overrides` onto `NextjsBaseProps` we get jsii
 * error: `Interface ... re-declares member "overrides"`
 */
export interface NextjsBaseConstructProps extends NextjsBaseProps {
  readonly overrides?: NextjsBaseOverrides;
}

/**
 * Base class for all Next.js root constructs
 */
export abstract class NextjsBaseConstruct extends Construct {
  nextjsBuild: NextjsBuild;
  nextjsStaticAssets: NextjsStaticAssets;
  nextjsCache: NextjsCache;

  abstract get url(): string;

  protected readonly nextjsType: NextjsType;
  // use baseProps instead of props so that child classes can use props
  protected readonly baseProps: NextjsBaseConstructProps;
  // Widest shape of the per-`NextjsType` overrides. The public interface each
  // root construct accepts is what actually gates which keys are settable.
  protected readonly constructOverrides?: NextjsFunctionsConstructOverrides;
  /**
   * The `basePath` everything downstream is built from: the `basePath` prop when
   * set, otherwise the app's own `basePath` for the `NextjsType`s where the two
   * are necessarily the same. Normalized to a bare path segment, `undefined` for
   * no `basePath`. Use this instead of `baseProps.basePath`.
   */
  protected readonly resolvedBasePath?: string;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsBaseConstructProps,
    nextjsType: NextjsType,
  ) {
    super(scope, id);
    this.baseProps = props;
    this.nextjsType = nextjsType;
    this.constructOverrides = this.getConstructOverrides(nextjsType);

    this.nextjsBuild = this.createNextjsBuild();
    // A basePath that doesn't line up with the app's own deploys cleanly and
    // then 404s static assets, so reconcile the two up front and fail at synth
    // on a combination that can't work.
    this.resolvedBasePath = resolveBasePath(
      nextjsType,
      props.basePath,
      this.nextjsBuild.nextConfigBasePath,
    );
    this.nextjsCache = this.createNextjsCache();
    this.nextjsStaticAssets = this.createNextjsStaticAssets();
    this.validateStaticAssetsKeyPrefix();
  }

  /**
   * For the Global `NextjsType`s the key prefix isn't a free choice: it has to be
   * `basePath` (see `resolveBasePath`). A `destinationKeyPrefix` override that
   * moves the objects elsewhere has no way to tell the distribution about it —
   * unlike the image Lambda and `NextjsApi`, which read
   * `NextjsStaticAssets.keyPrefix` — so fail at synth rather than 404 every
   * static request.
   */
  private validateStaticAssetsKeyPrefix(): void {
    if (
      this.nextjsType !== NextjsType.GLOBAL_FUNCTIONS &&
      this.nextjsType !== NextjsType.GLOBAL_CONTAINERS
    ) {
      return;
    }
    const expected = this.resolvedBasePath ?? "";
    const actual = this.nextjsStaticAssets.keyPrefix;
    if (actual !== expected) {
      throw new Error(
        `${LOG_PREFIX} static assets key prefix mismatch for NextjsType.${this.nextjsType}: ` +
          `the assets are uploaded under ${actual ? `"${actual}"` : "the bucket root"} ` +
          `but CloudFront will request them under ${expected ? `"${expected}"` : "the bucket root"}, ` +
          "using the request path as the S3 object key, so every `_next/static` and `public/` request would 404. " +
          "Drop the `destinationKeyPrefix` override, or set it to the same value as `basePath`. " +
          "To namespace a shared bucket, use `basePath` — it prefixes the keys and the URLs together.",
      );
    }
  }

  /**
   * Finds construct overrides (if present) on props for any `NextjsType`
   */
  private getConstructOverrides(nextjsType: NextjsType) {
    const nextjsTypeToKey: Record<NextjsType, string> = {
      [NextjsType.GLOBAL_CONTAINERS]: "nextjsGlobalContainers",
      [NextjsType.GLOBAL_FUNCTIONS]: "nextjsGlobalFunctions",
      [NextjsType.REGIONAL_CONTAINERS]: "nextjsRegionalContainers",
      [NextjsType.REGIONAL_FUNCTIONS]: "nextjsRegionalFunctions",
    };
    const key = nextjsTypeToKey[nextjsType];
    const overrides = this.baseProps.overrides as
      Record<string, unknown> | undefined;
    if (overrides && key in overrides) {
      return overrides[key] as NextjsFunctionsConstructOverrides;
    }
    return;
  }

  /**
   * `functionGroups`, which only the two Functions root constructs accept —
   * Containers deploy one task definition and have no 250 MB package limit to
   * split around.
   *
   * Read off `baseProps` with a cast for the same reason as
   * {@link getConstructOverrides}: `createNextjsBuild` and
   * `createNextjsFunctions` are shared here, but the prop is declared on the
   * subclasses, so nothing weaker than a cast can see it. Adding it to
   * `NextjsBaseProps` would offer it to Containers, where it does nothing.
   */
  protected get functionGroups(): NextjsFunctionGroup[] | undefined {
    const props = this.baseProps as { functionGroups?: NextjsFunctionGroup[] };
    return props.functionGroups;
  }

  /**
   * The health check path as the running app actually serves it.
   *
   * Both consumers of this hit the app directly — the ALB target group forwards
   * the path to the container unchanged, and the container's `wget` probe targets
   * the local server — so the prefix that matters is the app's own `basePath`,
   * not `resolvedBasePath` (which for `REGIONAL_CONTAINERS` is only an S3
   * namespace). Left unprefixed, an app with a `basePath` 404s every health
   * check, so the target never turns healthy and the deployment rolls back.
   * `healthCheckPath` is therefore the path as the app routes it, without
   * `basePath`; one that carries the prefix already gets it twice, which is the
   * 0.6.2 breaking change for anyone who prefixed by hand to work around this.
   *
   * Takes the path as an argument rather than reading it off `baseProps`: only
   * the two Containers root constructs declare `healthCheckPath`, since they're
   * the only ones with something to health-check.
   */
  protected resolvedHealthCheckPath(healthCheckPath: string): string {
    return prefixWithBasePath(
      this.nextjsBuild.nextConfigBasePath,
      healthCheckPath,
    );
  }

  /**
   * Get compute base props for both Lambda functions and containers
   */
  protected computeBaseProps(): NextjsComputeBaseProps {
    return {
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      buildId: this.nextjsBuild.buildId,
      buildDirectory: this.baseProps.buildDirectory,
      nextjsType: this.nextjsType,
      deploymentRootPath: this.nextjsBuild.deploymentRootPath,
      relativeProjectDir: this.nextjsBuild.relativeProjectDir,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      staticAssetsKeyPrefix: this.nextjsStaticAssets.keyPrefix,
    };
  }

  /**
   * Run the post-deploy custom resource after the init cache upload.
   *
   * It reads the tag manifest that upload puts in the cache bucket, and
   * invalidating the CDN before the new cache is in place would only re-cache
   * the responses the invalidation was meant to drop. CloudFormation infers no
   * ordering between the two custom resources on its own.
   */
  protected orderAfterInitCache(postDeploy: Construct): void {
    const initCacheDeployment = this.nextjsCache.bucketDeployment;
    if (initCacheDeployment) {
      postDeploy.node.addDependency(initCacheDeployment);
    }
  }

  private createNextjsBuild(): NextjsBuild {
    return new NextjsBuild(this, "NextjsBuild", {
      buildCommand: this.baseProps.buildCommand,
      buildDirectory: this.baseProps.buildDirectory,
      nextjsType: this.nextjsType,
      skipBuild: this.baseProps.skipBuild,
      // The build resolves the split, since only it knows the route templates;
      // the constructs read the result back off the manifest.
      functionGroups: this.functionGroups,
      ...this.constructOverrides?.nextjsBuildProps,
    });
  }

  private createNextjsCache(): NextjsCache {
    return new NextjsCache(this, "NextjsCache", {
      buildId: this.nextjsBuild.buildId,
      cacheBucket: this.baseProps.cacheBucket,
      initCacheDir: this.nextjsBuild.initCacheDir,
      overrides: this.baseProps.overrides?.nextjsCache,
      revalidationTable: this.baseProps.revalidationTable,
      ...this.constructOverrides?.nextjsCacheProps,
    });
  }

  private createNextjsStaticAssets(): NextjsStaticAssets {
    return new NextjsStaticAssets(this, "NextjsStaticAssets", {
      bucket: this.baseProps.staticAssetsBucket,
      buildDirectory: this.baseProps.buildDirectory,
      buildId: this.nextjsBuild.buildId,
      basePath: this.resolvedBasePath,
      overrides: this.baseProps.overrides?.nextjsStaticAssets,
      ...this.constructOverrides?.nextjsStaticAssetsProps,
    });
  }

  /**
   * Shared by `NextjsGlobalFunctions` and `NextjsRegionalFunctions`.
   */
  protected createNextjsFunctions(
    overrides?: NextjsFunctionsOverrides,
  ): NextjsFunctions {
    return new NextjsFunctions(this, "NextjsFunctions", {
      ...this.computeBaseProps(),
      deploymentRoots: this.nextjsBuild.deploymentRoots,
      functionGroups: this.functionGroups,
      overrides: {
        ...overrides,
        functionProps: {
          ...overrides?.functionProps,
          vpc: this.baseProps.vpc,
        },
      },
      ...this.constructOverrides?.nextjsFunctionsProps,
    });
  }
}
