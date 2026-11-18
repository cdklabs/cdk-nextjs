import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsGlobalWebFunctions } from "cdk-nextjs";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressCommonNags,
  suppressGlobalNags,
  suppressWebFunctionNags,
} from "../shared/suppress-nags";
import { Bucket, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";

const app = new App();

// Not needed by this app - it fits in one Web Function. Declared so the split
// is exercised, as in `global-functions`.
const functionGroups = [{ name: "api", routes: ["/api/**"] }];

class GlobalWebFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsGlobalWebFunctions(this, "Nextjs", {
      buildDirectory: join(import.meta.dirname, "..", "app-playground"),
      // skipBuild: true,
      functionGroups,
      overrides: {
        nextjsWebFunctions: {
          webFunctionProps: {
            environment: {
              DEBUG: "cdk-nextjs:*",
            },
          },
        },
        nextjsDistribution: {
          distributionProps: {
            logBucket: logsBucket,
            logFilePrefix: "cloudfront-logs",
          },
        },
      },
    });
    new CfnOutput(this, "CdkNextjsUrl", {
      value: nextjs.url,
      key: "CdkNextjsUrl",
    });
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

export const stack = new GlobalWebFunctionsStack(
  app,
  getStackName("glbl-web-fns"),
  {
    // Web Functions are only in some Regions, which synth checks, so the
    // stack's Region has to be known.
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  },
);
suppressCommonNags(stack);
suppressGlobalNags(stack);
suppressWebFunctionNags(
  stack,
  functionGroups.map((group) => group.name),
);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
