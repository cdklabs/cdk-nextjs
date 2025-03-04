import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
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
import { FlowLogDestination } from "aws-cdk-lib/aws-ec2";
import { Bucket, ObjectOwnership } from "aws-cdk-lib/aws-s3";

const app = new App();

class GlobalFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: fileURLToPath(new URL("..", import.meta.url)),
      overrides: {
        nextjsGlobalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: [
                "**/node_modules",
                "**/.next",
                "global-containers",
                "global-functions",
                "regional-containers",
                "low-cost",
                "shared",
                "*.md",
              ],
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
      relativePathToWorkspace: "./app-playground",
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

export const stack = new GlobalFunctionsStack(app, "glbl-fns", {
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
