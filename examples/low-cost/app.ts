import { IAspect, Stack, StackProps } from "aws-cdk-lib";
import { Construct, IConstruct } from "constructs";
import { NextjsGlobalFunctions } from "cdk-nextjs";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  suppressCommonNags,
  suppressGlobalNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { FckNatInstanceProvider } from "cdk-fck-nat";
import { PriceClass } from "aws-cdk-lib/aws-cloudfront";
import { CfnLogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
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
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import { getBuilderImageExcludeDirectories } from "../shared/get-builder-image-exclude-directories";

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

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const vpc = this.#createVpc();
    const hostedZone = this.#getHostedZone();
    const certificate = this.#getCertificate(hostedZone);
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: join(import.meta.dirname, ".."),
      overrides: {
        nextjsDistribution: {
          distributionProps: {
            certificate,
            domainNames: [this.#distributionDomainName],
            priceClass: PriceClass.PRICE_CLASS_100,
          },
        },
        nextjsGlobalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: getBuilderImageExcludeDirectories(),
            },
          },
          nextjsVpcProps: {
            vpc,
          },
        },
      },
      relativePathToPackage: "./app-playground",
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
    const natGatewayProvider = new FckNatInstanceProvider({
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
    });
    const vpcName = this.stackName + "FckNatVpc";
    const vpc = new Vpc(this, vpcName, {
      natGatewayProvider,
      vpcName,
    });
    natGatewayProvider.securityGroup.addIngressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.allTraffic(),
    );
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

export const stack = new LowCostStack(app, getStackName("low-cost"));
suppressCommonNags(stack);
suppressGlobalNags(stack);
suppressLambdaNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

class LogGroupRetentionAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnLogGroup) {
      node.retentionInDays = RetentionDays.ONE_MONTH;
    }
  }
}

Aspects.of(app).add(new LogGroupRetentionAspect());
