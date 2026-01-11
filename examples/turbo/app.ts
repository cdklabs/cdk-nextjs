import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsGlobalFunctions } from "cdk-nextjs";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressCommonNags,
  suppressGlobalNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import { Bucket, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const app = new App();

class TurborepoStack extends Stack {
  #workspaceRootPath = join(import.meta.dirname, "..", "app-playground");
  #builderDockerfile = "builder.Dockerfile";

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const prunedOutDirPath = this.#createPrunedOutDir();
    this.#createNextjs(prunedOutDirPath);
  }

  /**
   * @see https://turbo.build/repo/docs/guides/tools/docker
   */
  #createPrunedOutDir() {
    const packageName = this.#getPackageName();
    const outDirPath = join(this.#workspaceRootPath, "pruned", packageName);
    // prevent stale files being in pruned folder
    rmSync(outDirPath, { recursive: true, force: true });
    //  --out-dir pruned/... results in pruned directory at root of monorepo
    execSync(
      `pnpm turbo prune ${packageName} --docker --out-dir pruned/${packageName}`,
      { stdio: "inherit" },
    );
    cpSync(
      join(import.meta.dirname, this.#builderDockerfile),
      join(outDirPath, this.#builderDockerfile),
    );
    return outDirPath;
  }

  #getPackageName(): string {
    const packageJsonPath = join(
      this.#workspaceRootPath,
      "app-playground", // make this a variable passed in via construct if you want this to be reusable
      "package.json",
    );
    const packageJsonStr = readFileSync(packageJsonPath, {
      encoding: "utf-8",
    });
    const packageJsonObj = JSON.parse(packageJsonStr) as { name: string };
    return packageJsonObj.name;
  }

  #createNextjs(buildDirectory: string) {
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildDirectory,
      overrides: {
        nextjsDistribution: {
          distributionProps: {
            logBucket: logsBucket,
            logFilePrefix: "cloudfront-logs",
          },
        },
      },
      relativePathToPackage: "./app-playground",
    });
    new CfnOutput(this, "CdkNextjsUrl", {
      value: "https://" + nextjs.nextjsDistribution.distribution.domainName,
      key: "CdkNextjsUrl",
    });
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

export const stack = new TurborepoStack(app, getStackName("turbo"));
suppressCommonNags(stack);
suppressGlobalNags(stack);
suppressLambdaNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
