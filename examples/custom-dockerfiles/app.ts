import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
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
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const app = new App();

class CustomDockerfilesStack extends Stack {
  #workspaceRootPath = join(import.meta.dirname, "..");
  #relativePathToWorkspace = "app-playground";

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const prunedOutDirPath = this.#createPrunedOutDir();
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: prunedOutDirPath,
      overrides: {
        nextjsBuild: {
          nextjsFunctionsAssetImageCodeProps: {
            file: join(
              import.meta.dirname,
              "custom-global-functions.Dockerfile",
            ),
          },
        },
        nextjsGlobalFunctions: {
          nextjsBuildProps: {
            builderImageProps: {
              customDockerfilePath: join(
                import.meta.dirname,
                "custom-builder.Dockerfile",
              ),
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

  /**
   * @see https://turbo.build/repo/docs/guides/tools/docker
   */
  #createPrunedOutDir() {
    // unlike dos function, we assume there will only be one container per
    // workspace for Nextjs apps so we don't need to create a custom `outDirName`
    const workspacePackageName = this.#getWorkspacePackageName();
    const outDirPath = join(
      this.#workspaceRootPath,
      "pruned",
      workspacePackageName,
    );
    // prevent stale files being in pruned folder
    rmSync(outDirPath, { recursive: true, force: true });
    //  --out-dir pruned/... results in pruned directory at root of monorepo
    execSync(
      `pnpm turbo prune ${workspacePackageName} --docker --out-dir pruned/${workspacePackageName}`,
      { stdio: "inherit" },
    );
    return outDirPath;
  }

  #getWorkspacePackageName(): string {
    const packageJsonPath = join(
      this.#workspaceRootPath,
      this.#relativePathToWorkspace,
      "package.json",
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const packageJsonStr = readFileSync(packageJsonPath, {
      encoding: "utf-8",
    });
    const packageJsonObj = JSON.parse(packageJsonStr) as { name: string };
    return packageJsonObj.name;
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

export const stack = new CustomDockerfilesStack(app, "cstm-dckrfls", {
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
