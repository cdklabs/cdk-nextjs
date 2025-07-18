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
import { AwsSolutionsChecks } from "cdk-nag";
import {
  suppressApiNags,
  suppressCommonNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import { getBuilderImageExcludeDirectories } from "../shared/get-builder-image-exclude-directories";
import {
  AccessLogFormat,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigateway";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();

export class RegionalFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    process.env["NEXTJS_BASE_PATH"] = "/prod"; // default API Gateway stage name
    const nextjs = new NextjsRegionalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: join(import.meta.dirname, ".."),
      overrides: {
        nextjsRegionalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: getBuilderImageExcludeDirectories(),
              envVarNames: ["NEXTJS_BASE_PATH"],
            },
          },
        },
        nextjsApi: {
          restApiProps: {
            // there can only be a single apigateway.CfnAccount per AWS environment
            // so cloud watch role should be created independently of each REST API
            // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway-readme.html#deployments
            cloudWatchRole: false, // recommended
            deployOptions: {
              accessLogDestination: new LogGroupLogDestination(
                new LogGroup(this, "ApiAccessLogs", {
                  retention: RetentionDays.ONE_WEEK,
                  removalPolicy: RemovalPolicy.DESTROY,
                }),
              ),
              accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
              metricsEnabled: true,
            },
          },
        },
      },
      relativePathToPackage: "./app-playground",
    });
    // workaround b/c not using custom domain. see examples/app-playground/middleware.ts
    nextjs.nextjsFunctions.function.addEnvironment("PREPEND_APIGW_STAGE", "1");
    new CfnOutput(this, "CdkNextjsUrl", {
      // trailing slash is critical for e2e tests to pass to preserve stage name in path
      value: nextjs.url + "/",
      key: "CdkNextjsUrl",
    });
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
