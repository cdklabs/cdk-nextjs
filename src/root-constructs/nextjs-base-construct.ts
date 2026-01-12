import { Construct } from "constructs";
import { NextjsType } from "../constants";
import { OptionalNextjsBuildProps } from "../generated-structs/OptionalNextjsBuildProps";
import { OptionalNextjsCacheProps } from "../generated-structs/OptionalNextjsCacheProps";
import { NextjsBuild } from "../nextjs-build/nextjs-build";
import { NextjsCache, NextjsCacheOverrides } from "../nextjs-cache";
import { NextjsComputeBaseProps } from "../nextjs-compute/nextjs-compute-base-props";
import {
  NextjsStaticAssets,
  NextjsStaticAssetsOverrides,
  NextjsStaticAssetsProps,
} from "../nextjs-static-assets";

/**
 * Base overrides for the props passed to constructs within root/top-level Next.js constructs
 */
export interface NextjsBaseConstructOverrides {
  readonly nextjsBuildProps?: OptionalNextjsBuildProps;
  readonly nextjsCacheProps?: OptionalNextjsCacheProps;
  readonly nextjsStaticAssetsProps?: NextjsStaticAssetsProps;
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
   * Prefix to the URI path the app will be served at.
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
   * Path to API Route Handler that returns HTTP 200 to ensure compute health.
   * @example "/api/health"
   * @example
   * // api/health/route.ts
   * import { NextResponse } from "next/server";
   *
   * export function GET() {
   *   return NextResponse.json("");
   * }
   */
  readonly healthCheckPath: string;
  /**
   * Use this if building in monorepo. This is the relative path from
   * root package to nested package containing Next.js app. It's used to find
   * path to `next build` generated server.js within .next/standalone directory.
   * See example below:
   *
   * Let's say you have a monorepo with the following folder structure:
   * - my-monorepo/
   *   - apps/
   *     - web/
   *       - package.json (nested)
   *   - package.json (root)
   *
   * And your Next.js app directory is the web folder. Then you would set {@link NextjsBaseProps.buildDirectory}
   * to `"/absolute/path/to/nextjs/app"` and {@link NextjsBaseProps.relativePathToPackage}
   * to `"./apps/web"`.
   *
   * @example "./apps/web"
   */
  readonly relativePathToPackage?: string;
  /**
   * Skips running `next build`. If `true`, you are responsible for running
   * `next build` before this construct is synthesized.
   * @defaul false
   */
  readonly skipBuild?: boolean;
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
  protected readonly constructOverrides?: NextjsBaseConstructOverrides;

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
    this.nextjsCache = this.createNextjsCache();
    this.nextjsStaticAssets = this.createNextjsStaticAssets();
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
      | Record<string, unknown>
      | undefined;
    if (overrides && key in overrides) {
      return overrides[key] as NextjsBaseConstructOverrides;
    }
    return;
  }

  /**
   * Get compute base props for both Lambda functions and containers
   */
  protected computeBaseProps(): NextjsComputeBaseProps {
    return {
      healthCheckPath: this.baseProps.healthCheckPath,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      buildId: this.nextjsBuild.buildId,
      buildOutputPath: this.baseProps.buildDirectory,
      nextjsType: this.nextjsType,
      relativePathToPackage: this.baseProps.relativePathToPackage,
    };
  }

  private createNextjsBuild(): NextjsBuild {
    return new NextjsBuild(this, "NextjsBuild", {
      buildCommand: this.baseProps.buildCommand,
      buildDirectory: this.baseProps.buildDirectory,
      nextjsType: this.nextjsType,
      relativePathToPackage: this.baseProps.relativePathToPackage,
      skipBuild: this.baseProps.skipBuild,
      ...this.constructOverrides?.nextjsBuildProps,
    });
  }

  private createNextjsCache(): NextjsCache {
    return new NextjsCache(this, "NextjsCache", {
      buildId: this.nextjsBuild.buildId,
      overrides: this.baseProps.overrides?.nextjsCache,
      ...this.constructOverrides?.nextjsCacheProps,
    });
  }

  private createNextjsStaticAssets(): NextjsStaticAssets {
    return new NextjsStaticAssets(this, "NextjsStaticAssets", {
      buildOutputPath: this.baseProps.buildDirectory,
      buildId: this.nextjsBuild.buildId,
      basePath: this.baseProps.basePath,
      overrides: this.baseProps.overrides?.nextjsStaticAssets,
      ...this.constructOverrides?.nextjsStaticAssetsProps,
    });
  }
}
