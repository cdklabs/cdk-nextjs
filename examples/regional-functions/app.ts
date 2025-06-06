import {
  Aspects,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsRegionalFunctions } from "cdk-nextjs";
import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressApiNags,
  suppressCommonNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { FlowLogDestination } from "aws-cdk-lib/aws-ec2";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import { getBuilderImageExcludeDirectories } from "../shared/get-builder-image-exclude-directories";
import {
  AccessLogFormat,
  LogGroupLogDestination,
  MethodLoggingLevel,
} from "aws-cdk-lib/aws-apigateway";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();

export class RegionalFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsRegionalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: join(import.meta.dirname, ".."),
      overrides: {
        nextjsRegionalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: getBuilderImageExcludeDirectories(),
            },
          },
        },
        nextjsApi: {
          restApiProps: {
            deployOptions: {
              accessLogDestination: new LogGroupLogDestination(
                new LogGroup(this, "ApiAccessLogs", {
                  retention: RetentionDays.ONE_WEEK,
                  removalPolicy: RemovalPolicy.DESTROY,
                }),
              ),
              accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
              loggingLevel: MethodLoggingLevel.INFO,
              metricsEnabled: true,
            },
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

const stack = new RegionalFunctionsStack(app, getStackName("rgnl-fns"), {
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
});

suppressCommonNags(stack);
suppressLambdaNags(stack);
suppressApiNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
