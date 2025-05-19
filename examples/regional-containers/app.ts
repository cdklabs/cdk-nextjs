import {
  Aspects,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsRegionalContainers } from "cdk-nextjs";
import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressCommonNags,
  suppressContainerNags,
} from "../shared/suppress-nags";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { FlowLogDestination } from "aws-cdk-lib/aws-ec2";
import {
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import { getBuilderImageExcludeDirectories } from "../shared/get-builder-image-exclude-directories";

const app = new App();

export class RegionalContainersStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const logsBucket = this.#getLogsBucket();
    const nextjs = new NextjsRegionalContainers(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: join(import.meta.dirname, ".."),
      overrides: {
        nextjsRegionalContainers: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: getBuilderImageExcludeDirectories("regional-containers"),
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
      relativePathToWorkspace: "./app-playground",
    });
    new CfnOutput(this, "CdkNextjsUrl", {
      value:
        "http://" +
        nextjs.nextjsContainers.albFargateService.loadBalancer
          .loadBalancerDnsName,
      key: "CdkNextjsUrl",
    });
    this.#requireCookie(nextjs);

    // workaround: https://github.com/aws/aws-cdk/issues/18985#issue-1139679112
    nextjs.nextjsVpc.vpc.node
      .findChild("s3FlowLogs")
      .node.findChild("FlowLog")
      .node.addDependency(logsBucket);
    nextjs.nextjsContainers.albFargateService.loadBalancer.logAccessLogs(
      logsBucket,
      "alb-logs",
    );
  }

  /**
   * Basic auth only for demo app. For real app, use `AuthenticateCognitoAction` or another
   * more secure authentication method.
   */
  #requireCookie(nextjs: NextjsRegionalContainers) {
    const requiredCookie = "cdk-nextjs=1";
    const listener = nextjs.nextjsContainers.albFargateService.listener;
    // override default action
    listener.addAction("DefaultDeny", {
      // don't add priority so added to default action
      action: ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: `Access denied. Must set cookie: ${requiredCookie}`,
      }),
    });
    // Add the listener rule to check for cookie
    listener.addAction("CookieCheck", {
      priority: 10, // Lower number = higher priority
      conditions: [ListenerCondition.httpHeader("cookie", [requiredCookie])],
      action: ListenerAction.forward([
        nextjs.nextjsContainers.albFargateService.targetGroup,
      ]),
    });
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

const stack = new RegionalContainersStack(app, getStackName("rgnl-cntnrs"), {
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
});

suppressCommonNags(stack);
suppressContainerNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
