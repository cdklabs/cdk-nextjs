import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsGlobalFunctions } from "cdk-nextjs";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressCommonNags,
  suppressGlobalNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import { FlowLogDestination } from "aws-cdk-lib/aws-ec2";
import { Bucket, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { getStackName } from "../shared/get-stack-name";
import { getBuilderImageExcludeDirectories } from "../shared/get-builder-image-exclude-directories";
import { join } from "node:path";

const app = new App();

class GlobalFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: join(import.meta.dirname, ".."),
      overrides: {
        nextjsGlobalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: getBuilderImageExcludeDirectories(),
            },
          },
        },
        nextjsDistribution: {
          distributionProps: {
            logBucket: logsBucket,
            logFilePrefix: "cloudfront-logs",
          },
        },
        nextjsVpc: {
          vpcProps: {
            flowLogs: {
              s3FlowLogs: {
                destination: FlowLogDestination.toS3(
                  logsBucket,
                  "vpc-flow-logs",
                ),
              },
            },
          },
        },
      },
      relativePathToPackage: "./app-playground",
    });
    new CfnOutput(this, "CdkNextjsUrl", {
      value: nextjs.url,
      key: "CdkNextjsUrl",
    });
    // workaround: https://github.com/aws/aws-cdk/issues/18985#issue-1139679112
    nextjs.nextjsVpc.vpc.node
      .findChild("s3FlowLogs")
      .node.findChild("FlowLog")
      .node.addDependency(logsBucket);
  }

  #getLogsBucket() {
    const bucket = new Bucket(this, "LogsBucket", {
      enforceSSL: true,
      lifecycleRules: [
        {
          expiration: Duration.days(30),
        },
      ],
      objectOwnership: ObjectOwnership.OBJECT_WRITER, // required for CloudFront to write logs
      // auto delete and destroy on removal only for example, remove these for prod!
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    NagSuppressions.addResourceSuppressions(bucket, [
      {
        id: "AwsSolutions-S1",
        reason: "Logs bucket doesn't need server access logs",
      },
    ]);
    return bucket;
  }
}

export const stack = new GlobalFunctionsStack(app, getStackName("glbl-fns"));
suppressCommonNags(stack);
suppressGlobalNags(stack);
suppressLambdaNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
