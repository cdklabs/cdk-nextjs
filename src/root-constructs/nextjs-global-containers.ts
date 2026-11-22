import {
  Distribution,
  FunctionCode,
  IKeyValueStore,
} from "aws-cdk-lib/aws-cloudfront";
import { ICluster } from "aws-cdk-lib/aws-ecs";
import { IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import {
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";
import { OptionalNextjsContainersProps } from "../generated-structs/OptionalNextjsContainersProps";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
  NextjsDynamicBehavior,
} from "../nextjs-distribution";
import { NextjsPostDeploy } from "../nextjs-post-deploy";
import { joinPath } from "../utils/base-path";

export interface NextjsGlobalContainersConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsContainersProps?: OptionalNextjsContainersProps;
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
}

/**
 * Overrides for `NextjsGlobalContainers`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalContainersOverrides extends NextjsBaseOverrides {
  readonly nextjsGlobalContainers?: NextjsGlobalContainersConstructOverrides;
  readonly nextjsContainers?: NextjsContainersOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
}

export interface NextjsGlobalContainersProps extends NextjsBaseProps {
  /**
   * Bring your own Application Load Balancer. When provided, it is passed
   * directly to `ApplicationLoadBalancedFargateService`. If the ALB already
   * has a listener on port 80, call `removeAutoCreatedListener()` after
   * construction to avoid deployment failures.
   */
  readonly alb?: IApplicationLoadBalancer;
  /**
   * Bring your own distribution. Can be used with `basePath` to host multiple
   * apps on the same CloudFront distribution.
   */
  readonly distribution?: Distribution;
  /**
   * Bring your own ECS cluster. When provided, cdk-nextjs will skip creating
   * a new cluster and VPC gateway endpoints.
   */
  readonly ecsCluster?: ICluster;
  /**
   * Path to API Route Handler that returns HTTP 200 to ensure compute health.
   * Used by the ALB target group and the ECS container health check, both of
   * which have to be able to tell a running task from a wedged one.
   *
   * Give the path as your app routes it, without your app's `basePath` —
   * cdk-nextjs adds that prefix, since both checks hit the app directly.
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
   * Behaviors of your own that send a path to the Next.js server like the
   * default behavior, with some of its options changed: a shorter cache for
   * `detail/*`, say. Patterns are relative to the app, prefixed with the
   * `basePath` if there is one.
   * @see NextjsDistributionProps.dynamicBehaviors
   * @default - none
   */
  readonly dynamicBehaviors?: NextjsDynamicBehavior[];
  /**
   * Whether on-demand revalidation (`revalidateTag`, `revalidatePath` and the
   * Pages Router's `res.revalidate()`) creates CloudFront invalidations for
   * the pages it touches.
   *
   * Set to `false` when pages change too often to purge one by one: thousands
   * a day run past CloudFront's free 1,000 paths a month and its 15 wildcard
   * paths in progress, and a rejected invalidation is retried as `/*`. Cap
   * those pages' edge TTL instead (a short `s-maxage`, or a behavior with a
   * low `maxTtl`), so the edge picks up the revalidated page when its copy
   * expires. Revalidation still reaches every instance's origin cache, and
   * the invalidation after each deploy still runs.
   * @default true
   */
  readonly invalidateCdnOnRevalidate?: boolean;
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsGlobalContainersOverrides;
  /**
   * CloudFront Function code run first on every viewer request, static assets
   * included — HTTP Basic auth on a pre-launch site, say. It must define
   * `viewerRequest(event)`, as a function or a `var`/`let`/`const`.
   * @see NextjsDistributionProps.viewerRequestFunctionCode
   * @default - none
   */
  readonly viewerRequestFunctionCode?: FunctionCode;
  /**
   * A CloudFront KeyValueStore `viewerRequestFunctionCode` can read with
   * `cf.kvs()`, so credentials stay out of the template.
   * @see NextjsDistributionProps.viewerRequestKeyValueStore
   * @default - none
   */
  readonly viewerRequestKeyValueStore?: IKeyValueStore;
}

/**
 * Deploy Next.js globally distributed with containers. Uses [CloudFront
 * Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html)
 * as Content Delivery Network (CDN) for global distribution and [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
 * for containers.
 */
export class NextjsGlobalContainers extends NextjsBaseConstruct {
  nextjsContainers: NextjsContainers;
  nextjsDistribution: NextjsDistribution;
  nextjsPostDeploy: NextjsPostDeploy;
  /**
   * Public URL of the app, including `basePath` — the app only answers under
   * that prefix, and it's derived from the app's own `basePath` when the prop is
   * left unset, so it's there whether or not you asked for it.
   */
  get url(): string {
    return joinPath(
      `https://${this.nextjsDistribution.distribution.domainName}`,
      this.resolvedBasePath,
    );
  }

  private props: NextjsGlobalContainersProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsGlobalContainersProps,
  ) {
    super(scope, id, props, NextjsType.GLOBAL_CONTAINERS);
    this.props = props;

    this.nextjsContainers = this.createNextjsContainers();
    this.nextjsDistribution = this.createNextjsDistribution();
    const { taskDefinition } = this.nextjsContainers.albFargateService;
    // Lets on-demand revalidation evict stale responses from the CDN edge, not
    // just the origin's cache. The origin is the ALB, which the task doesn't
    // depend on, so naming the distribution here makes no dependency cycle.
    // Without the ID the cache handler skips invalidation altogether.
    const { distribution } = this.nextjsDistribution;
    if (props.invalidateCdnOnRevalidate !== false) {
      distribution.grantCreateInvalidation(taskDefinition.taskRole);
      taskDefinition.defaultContainer?.addEnvironment(
        "CDK_NEXTJS_DISTRIBUTION_ID",
        distribution.distributionId,
      );
    }
    // The ALB is reachable through the distribution's VPC origin alone, so
    // `CloudFront-Forwarded-Proto` is always CloudFront's own; see
    // `viewerHeaders` in src/runtime/http/node-server.ts.
    taskDefinition.defaultContainer?.addEnvironment(
      "CDK_NEXTJS_TRUST_CLOUDFRONT_PROTO",
      "1",
    );
    this.nextjsPostDeploy = this.createNextjsPostDeploy(
      this.nextjsDistribution.distribution,
    );
    this.waitForCacheSeed(this.nextjsContainers.albFargateService.service);
    // Old tasks still need their cache while the ECS service is rolling out.
    this.nextjsPostDeploy.customResource.node.addDependency(
      this.nextjsContainers.albFargateService.service,
    );
  }

  private createNextjsContainers(): NextjsContainers {
    // Create containers with local build output
    return new NextjsContainers(this, "NextjsContainers", {
      ...this.computeBaseProps(),
      alb: this.props.alb,
      buildDirectory: this.props.buildDirectory,
      ecsCluster: this.props.ecsCluster,
      healthCheckPath: this.resolvedHealthCheckPath(this.props.healthCheckPath),
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      relativeProjectDir: this.nextjsBuild.relativeProjectDir,
      overrides: {
        ...this.props.overrides?.nextjsContainers,
        ecsClusterProps: {
          ...this.props.overrides?.nextjsContainers?.ecsClusterProps,
          // Conditional for the same reason as the Functions' `vpc`: assigned
          // unconditionally, an unset `vpc` prop would erase the override's.
          ...(this.baseProps.vpc ? { vpc: this.baseProps.vpc } : {}),
        },
      },
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsContainersProps,
    });
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      assetPrefix: this.nextjsBuild.nextConfigAssetPrefixPath,
      basePath: this.resolvedBasePath,
      certificate: this.nextjsContainers.albFargateService.certificate,
      distribution: this.props.distribution,
      dynamicBehaviors: this.props.dynamicBehaviors,
      loadBalancer: this.nextjsContainers.albFargateService.loadBalancer,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      serviceWorkerAllowed: this.serviceWorkerAllowed,
      viewerRequestFunctionCode: this.props.viewerRequestFunctionCode,
      viewerRequestKeyValueStore: this.props.viewerRequestKeyValueStore,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsDistributionProps,
    });
  }
}
