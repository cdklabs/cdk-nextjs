import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsGlobalFunctions } from "cdk-nextjs";
import { fileURLToPath } from "node:url";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressCommonNags,
  suppressGlobalNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { FckNatInstanceProvider } from "cdk-fck-nat";
import { PriceClass } from "aws-cdk-lib/aws-cloudfront";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import {
  AaaaRecord,
  ARecord,
  HostedZone,
  IHostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";

const app = new App();

/**
 * Example demonstrates how to deploy cdk-nextjs with low cost. In order to
 * achieve lower cost, we sacrafice security. This is not recommended by AWS
 * but we understand low cost may be more important to customers for certain
 * use cases such as personal blogs. This example also demonstrates how to
 * setup DNS.
 *
 * Low Cost Feature Summary:
 * - NAT Instance instead of NAT Gateway
 * - Lowest CloudFront Distribution Price Class
 * - Logs expire after 1 month to reduce CloudWatch costs
 */
class LowCostStack extends Stack {
  #hostedZoneDomainName = "example.com";
  #distributionDomainName = `blog.${this.#hostedZoneDomainName}`;
  #logGroupRetention = RetentionDays.ONE_MONTH;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const vpc = this.#createVpc();
    const hostedZone = this.#getHostedZone();
    const certificate = this.#getCertificate(hostedZone);
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: fileURLToPath(new URL("..", import.meta.url)),
      overrides: {
        nextjsDistribution: {
          distributionProps: {
            certificate,
            domainNames: [this.#distributionDomainName],
            priceClass: PriceClass.PRICE_CLASS_100,
          },
          edgeFunctionProps: {
            logGroup: new LogGroup(this, "NextjsDistributionEdgeFnLogGroup", {
              retention: this.#logGroupRetention,
            }),
          },
        },
        nextjsAssetsDeployment: {
          dockerImageFunctionProps: {
            logGroup: new LogGroup(this, "NextjsAssetDeploymentLogGroup", {
              retention: this.#logGroupRetention,
            }),
          },
        },
        nextjsFunctions: {
          dockerImageFunctionProps: {
            logGroup: new LogGroup(this, "NextjsFunctionLogGroup", {
              retention: this.#logGroupRetention,
            }),
          },
        },
        nextjsInvalidation: {
          awsCustomResourceProps: {
            logGroup: new LogGroup(this, "NextjsInvalidationLogGroup", {
              retention: this.#logGroupRetention,
            }),
          },
        },
        nextjsRevalidation: {
          functionProps: {
            logGroup: new LogGroup(this, "NextjsRevalidationLogGroup", {
              retention: this.#logGroupRetention,
            }),
          },
        },
        nextjsGlobalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: [
                "**/node_modules",
                "**/.next",
                "global-containers",
                "global-functions",
                "regional-containers",
                "shared",
                "*.md",
              ],
            },
          },
          nextjsVpcProps: {
            vpc,
          },
        },
      },
      relativePathToWorkspace: "./app-playground",
    });
    this.#createDnsRecords(nextjs, hostedZone);
  }

  #getHostedZone() {
    return HostedZone.fromLookup(this, "HostedZone", {
      domainName: this.#hostedZoneDomainName,
    });
  }
  #getCertificate(hostedZone: IHostedZone) {
    return new Certificate(this, "Certificate", {
      domainName: this.#distributionDomainName,
      validation: CertificateValidation.fromDns(hostedZone),
    });
  }
  #createVpc() {
    // To reduce NAT costs, using fck-nat rather than the AWS Managed NAT which is far more expensive.
    const natGatewayProvider = new FckNatInstanceProvider({
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
    });
    const vpcName = this.stackName + "FckNatVpc";
    const vpc = new Vpc(this, vpcName, {
      natGatewayProvider,
      vpcName,
    });
    return vpc;
  }
  #createDnsRecords(nextjs: NextjsGlobalFunctions, hostedZone: IHostedZone) {
    new ARecord(this, "ARecord", {
      recordName: this.#distributionDomainName,
      target: RecordTarget.fromAlias(
        new CloudFrontTarget(nextjs.nextjsDistribution.distribution),
      ),
      zone: hostedZone,
    });
    new AaaaRecord(this, "AAAARecord", {
      recordName: this.#distributionDomainName,
      target: RecordTarget.fromAlias(
        new CloudFrontTarget(nextjs.nextjsDistribution.distribution),
      ),
      zone: hostedZone,
    });
  }
}

export const stack = new LowCostStack(app, "low-cost", {
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
});
suppressCommonNags(stack);
suppressGlobalNags(stack);
suppressLambdaNags(stack);
NagSuppressions.addResourceSuppressionsByPath(
  stack,
  `/${stack.stackName}/Nextjs/NextjsRevalidation/Queue/Resource`,
  [
    {
      id: "AwsSolutions-SQS3",
      reason: "DLQ not required for example app",
    },
  ],
);
NagSuppressions.addResourceSuppressionsByPath(
  stack,
  `/${stack.stackName}/Nextjs/NextjsRevalidation/Fn/ServiceRole/Resource`,
  [
    {
      id: "AwsSolutions-IAM4",
      reason: "AWSLambdaBasicExecutionRole is not overly permissive",
    },
  ],
);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
