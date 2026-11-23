import { Annotations, Stack, Token } from "aws-cdk-lib";
import {
  Distribution,
  FunctionCode,
  IKeyValueStore,
} from "aws-cdk-lib/aws-cloudfront";
import { SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  NetworkConnector,
  NetworkConnectorComputeType,
  NetworkConnectorConfiguration,
} from "aws-cdk-lib/aws-lambda";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { DEFAULT_FUNCTION_GROUP } from "../adapter/function-groups";
import { LOG_PREFIX, NextjsType } from "../constants";
import {
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import {
  NextjsWebFunctionGroup,
  NextjsWebFunctions,
  NextjsWebFunctionsOverrides,
} from "../nextjs-compute/nextjs-web-functions";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
} from "../nextjs-distribution";
import { NextjsPostDeploy } from "../nextjs-post-deploy";
import { joinPath } from "../utils/base-path";

/**
 * The Regions Lambda Web Functions are available in.
 * @see https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/
 */
const WEB_FUNCTIONS_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "eu-west-1",
];

export interface NextjsGlobalWebFunctionsConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
}

/**
 * Overrides for `NextjsGlobalWebFunctions`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalWebFunctionsOverrides extends NextjsBaseOverrides {
  readonly nextjsGlobalWebFunctions?: NextjsGlobalWebFunctionsConstructOverrides;
  readonly nextjsWebFunctions?: NextjsWebFunctionsOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
}

export interface NextjsGlobalWebFunctionsProps extends NextjsBaseProps {
  /**
   * Bring your own distribution. Can be used with `basePath` to host multiple
   * apps on the same CloudFront distribution. It must be in this construct's
   * stack: its ARN scopes the Web Functions' resource-based policy, and it
   * reads their endpoints' domains, so another stack would be a cycle.
   */
  readonly distribution?: Distribution;
  /**
   * Package sets of routes into separate Web Functions, each fronted by its
   * own CloudFront behaviors.
   *
   * A Web Function's package can be 512 MB unzipped, so this is rarely
   * needed for size; cdk-nextjs throws at synth with the measured size when a
   * function is over it.
   *
   * @see NextjsWebFunctionGroup for the pattern grammar and its limits.
   * @default - one function serves every route
   */
  readonly functionGroups?: NextjsWebFunctionGroup[];
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
  readonly overrides?: NextjsGlobalWebFunctionsOverrides;
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
 * Deploy Next.js globally distributed with Lambda Web Functions. Uses
 * [CloudFront Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html)
 * as Content Delivery Network (CDN) for global distribution and
 * [AWS Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
 * for compute: a Node.js HTTP server per execution environment, serving many
 * requests at once and billed for the CPU they actively use.
 *
 * Web Functions are available in fewer Regions than Event Functions, with
 * fixed 2 GB memory on Arm64; synth fails in an unsupported Region. Use
 * `NextjsGlobalFunctions` where these don't fit.
 */
export class NextjsGlobalWebFunctions extends NextjsBaseConstruct {
  nextjsWebFunctions: NextjsWebFunctions;
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

  private props: NextjsGlobalWebFunctionsProps;
  /** See {@link NextjsGlobalWebFunctionsProps.invalidateCdnOnRevalidate}. */
  private get invalidatesCdn(): boolean {
    return this.props.invalidateCdnOnRevalidate !== false;
  }
  /** See {@link wireCloudFrontInvalidation}. */
  private distributionIdParameterName: string;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsGlobalWebFunctionsProps,
  ) {
    assertWebFunctionsRegion(scope);
    super(scope, id, props, NextjsType.GLOBAL_WEB_FUNCTIONS);
    if (props.distribution && Stack.of(props.distribution) !== Stack.of(this)) {
      throw new Error(
        `${LOG_PREFIX} NextjsGlobalWebFunctions' \`distribution\` must be in ` +
          `its stack (${Stack.of(this).node.path}), not ` +
          `${Stack.of(props.distribution).node.path}: the Web Functions' ` +
          `resource-based policy names the distribution, which reads their ` +
          `endpoints' domains, so across stacks it's a dependency cycle.`,
      );
    }
    this.props = props;
    this.distributionIdParameterName = `cdk-nextjs-distribution-id-${this.node.addr}`;

    this.nextjsWebFunctions = this.createNextjsWebFunctions();
    this.nextjsDistribution = this.createNextjsDistribution();
    // Without the parameter name the cache handler skips invalidation
    // altogether.
    if (this.invalidatesCdn) {
      this.wireCloudFrontInvalidation();
    }
    this.nextjsPostDeploy = this.createNextjsPostDeploy(
      this.nextjsDistribution.distribution,
    );
  }

  private createNextjsWebFunctions() {
    const overrides = this.props.overrides?.nextjsWebFunctions;
    const webFunctionProps = overrides?.webFunctionProps;
    const nextjsWebFunctions = new NextjsWebFunctions(
      this,
      "NextjsWebFunctions",
      {
        ...this.computeBaseProps(),
        deploymentRoots: this.nextjsBuild.deploymentRoots,
        functionGroups: this.props.functionGroups,
        overrides: {
          ...overrides,
          webFunctionProps: {
            ...webFunctionProps,
            // A Web Function has no `addEnvironment`, so the name goes in up
            // front; see `wireCloudFrontInvalidation`.
            environment: {
              ...(this.invalidatesCdn
                ? {
                    CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME:
                      this.distributionIdParameterName,
                  }
                : {}),
              ...webFunctionProps?.environment,
            },
            // Conditionally, so an override's connector isn't overwritten with
            // `undefined`.
            ...(this.props.vpc && !webFunctionProps?.egressNetworkConnector
              ? { egressNetworkConnector: this.createNetworkConnector() }
              : {}),
          },
        },
      },
    );
    this.waitForCacheSeed(
      ...nextjsWebFunctions.functionGroups.map((group) => group.webFunction),
    );
    return nextjsWebFunctions;
  }

  /**
   * The `vpc` prop, as Web Functions take it: through a network connector,
   * which owns the network interfaces in the VPC's private subnets. One for
   * every function group; its security group allows all egress and no
   * ingress, and a Web Function receives nothing through it.
   */
  private createNetworkConnector() {
    const vpc = this.props.vpc!;
    return new NetworkConnector(this, "NetworkConnector", {
      configuration: NetworkConnectorConfiguration.vpcEgress({
        computeType: NetworkConnectorComputeType.WEB_FUNCTION,
        vpc,
        securityGroups: [
          new SecurityGroup(this, "NetworkConnectorSecurityGroup", {
            vpc,
            description: "cdk-nextjs Web Functions egress",
          }),
        ],
      }),
    });
  }

  /**
   * Lets every function invalidate the distribution, so on-demand
   * revalidation (revalidateTag/revalidatePath) can evict stale responses from
   * the CDN edge cache, not just the origin's S3/DynamoDB cache.
   *
   * The distribution's origins are the functions' endpoints, so a function
   * naming the distribution back would be a circular CloudFormation
   * dependency. So the ID is published to an SSM Parameter whose *name* is
   * static, and the grants go in a separate policy that depends on the
   * distribution while no function depends on it. As on
   * `NextjsGlobalFunctions`.
   */
  private wireCloudFrontInvalidation() {
    const { distribution } = this.nextjsDistribution;
    const parameterName = this.distributionIdParameterName;
    new StringParameter(this, "DistributionIdParameter", {
      parameterName,
      stringValue: distribution.distributionId,
    });
    new Policy(this, "InvalidationPolicy", {
      roles: this.nextjsWebFunctions.functionGroups.map((group) => group.role),
      statements: [
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            Stack.of(this).formatArn({
              service: "ssm",
              resource: "parameter",
              resourceName: parameterName,
            }),
          ],
        }),
        new PolicyStatement({
          actions: ["cloudfront:CreateInvalidation"],
          resources: [distribution.distributionArn],
        }),
      ],
    });
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      assetPrefix: this.nextjsBuild.nextConfigAssetPrefixPath,
      basePath: this.resolvedBasePath,
      distribution: this.props.distribution,
      webFunctionEndpoint: this.nextjsWebFunctions.endpoint,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      serviceWorkerAllowed: this.serviceWorkerAllowed,
      // The default group backs the default behavior, so only the rest need
      // behaviors of their own.
      functionGroups: this.nextjsWebFunctions.functionGroups
        .filter((group) => group.name !== DEFAULT_FUNCTION_GROUP)
        .map((group) => ({
          name: group.name,
          webFunctionEndpoint: group.endpoint,
        })),
      functionGroupBehaviors: this.nextjsBuild.functionGroupBehaviors,
      viewerRequestFunctionCode: this.props.viewerRequestFunctionCode,
      viewerRequestKeyValueStore: this.props.viewerRequestKeyValueStore,
      ...this.props.overrides?.nextjsGlobalWebFunctions
        ?.nextjsDistributionProps,
    });
  }
}

/**
 * Fails at synth in a Region without Web Functions, where the deploy would
 * otherwise fail on the first `AWS::Lambda::WebFunction`. An environment-
 * agnostic stack can't be checked, so it gets a warning instead.
 */
function assertWebFunctionsRegion(scope: Construct) {
  const { region } = Stack.of(scope);
  if (Token.isUnresolved(region)) {
    Annotations.of(scope).addWarningV2(
      "cdk-nextjs:webFunctionsRegionUnknown",
      `${LOG_PREFIX} NextjsGlobalWebFunctions can only deploy to a Region ` +
        `with Lambda Web Functions (${WEB_FUNCTIONS_REGIONS.join(", ")}), and ` +
        `this stack's Region isn't known at synth. Set the stack's \`env\` ` +
        `to have it checked.`,
    );
    return;
  }
  if (!WEB_FUNCTIONS_REGIONS.includes(region)) {
    throw new Error(
      `${LOG_PREFIX} NextjsGlobalWebFunctions can't deploy to ${region}: ` +
        `Lambda Web Functions are only available in ` +
        `${WEB_FUNCTIONS_REGIONS.join(", ")}. Deploy the stack to one of ` +
        `those, or use NextjsGlobalFunctions.`,
    );
  }
}
