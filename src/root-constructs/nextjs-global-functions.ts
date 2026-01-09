import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import {
  NextjsFunctions,
  NextjsFunctionsOverrides,
  NextjsFunctionsProps,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
} from "../nextjs-distribution";
import {
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";

export interface NextjsGlobalFunctionsConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsFunctionsProps?: NextjsFunctionsProps;
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
}

/**
 * Overrides for `NextjsGlobalFunctions`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalFunctionsOverrides extends NextjsBaseOverrides {
  readonly nextjsGlobalFunctions?: NextjsGlobalFunctionsConstructOverrides;
  readonly nextjsFunctions?: NextjsFunctionsOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
}

export interface NextjsGlobalFunctionsProps extends NextjsBaseProps {
  /**
   * Bring your own distribution. Can be used with `basePath` to host multiple
   * apps on the same CloudFront distribution.
   */
  readonly distribution?: Distribution;
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsGlobalFunctionsOverrides;
}

/**
 * Deploy Next.js globally distributed with functions. Uses [CloudFront
 * Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html)
 * as Content Delivery Network (CDN) for global distribution and [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
 * for functions.
 */
export class NextjsGlobalFunctions extends NextjsBaseConstruct {
  nextjsFunctions: NextjsFunctions;
  nextjsDistribution: NextjsDistribution;
  get url() {
    return `https://${this.nextjsDistribution.distribution.domainName}`;
  }

  private props: NextjsGlobalFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsGlobalFunctionsProps) {
    super(scope, id, props, NextjsType.GLOBAL_FUNCTIONS);
    this.props = props;
    this.nextjsFunctions = this.createNextjsFunctions();
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsFunctions.function.connections,
      role: this.nextjsFunctions.function.role!,
    });
    this.nextjsDistribution = this.createNextjsDistribution();
  }

  private createNextjsFunctions() {
    if (!this.nextjsBuild.imageForNextjsFunctions) {
      throw new Error("nextjsBuild.dockerImageCode is undefined");
    }
    return new NextjsFunctions(this, "NextjsFunctions", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      dockerImageCode: this.nextjsBuild.imageForNextjsFunctions,
      healthCheckPath: this.baseProps.healthCheckPath,
      nextjsType: this.nextjsType,
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFunctions,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsFunctionsProps,
    });
  }
  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      basePath: this.baseProps.basePath,
      functionUrl: this.nextjsFunctions.functionUrl,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsDistributionProps,
    });
  }
}
