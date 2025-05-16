import { Aspects, Stack, StackProps, Stage, StageProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import { GlobalFunctionsStack } from "../global-functions/app";
import {
  suppressCommonNags,
  suppressGlobalNags,
  suppressFunctionsNags,
} from "../shared/suppress-nags";

const app = new App();

const env = {
  account: process.env["CDK_DEFAULT_ACCOUNT"],
  region: process.env["CDK_DEFAULT_REGION"],
};

class MyStage extends Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);
    const stack = new GlobalFunctionsStack(this, "glbl-fns", {
      env,
    });
    suppressCommonNags(stack);
    suppressGlobalNags(stack);
    suppressFunctionsNags(stack);
  }
}

class CdkPipelinesStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const pipeline = new CodePipeline(this, "Pipeline", {
      synth: new ShellStep("ShellStep", {
        installCommands: ["cd examples", "pnpm i"],
        commands: ["cd examples/cdk-pipelines", "pnpm cdk synth"],
        // NOTE: you must manually create this in AWS Console.
        input: CodePipelineSource.connection("cdk-labs/cdk-nextjs", "main", {
          connectionArn: this.formatArn({
            service: "codestar-connections",
            resource: "connection",
            resourceName: process.env["CODESTAR_CONNECTION_ID"],
          }),
        }),
        primaryOutputDirectory: "examples/cdk-pipelines/cdk.out",
      }),
    });
    pipeline.addStage(new MyStage(this, "prod", { env }));
  }
}

export const stack = new CdkPipelinesStack(app, "cdk-pplns", {
  env,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
