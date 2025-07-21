import { Aspects, CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsRegionalContainers } from "cdk-nextjs";
import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import {
  suppressCommonNags,
  suppressContainerNags,
} from "../shared/suppress-nags";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import { getBuilderImageExcludeDirectories } from "../shared/get-builder-image-exclude-directories";
import {
  AmazonLinuxCpuType,
  BastionHostLinux,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  MachineImage,
  Port,
} from "aws-cdk-lib/aws-ec2";
import { ManagedPolicy } from "aws-cdk-lib/aws-iam";

const app = new App();

export class PrivateContainersStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const nextjs = new NextjsRegionalContainers(this, "Nextjs", {
      healthCheckPath: "/api/health",
      buildContext: join(import.meta.dirname, ".."),
      overrides: {
        nextjsRegionalContainers: {
          nextjsBuildProps: {
            builderImageProps: {
              exclude: getBuilderImageExcludeDirectories(),
            },
          },
        },
        nextjsContainers: {
          albFargateServiceProps: {
            publicLoadBalancer: false,
          },
        },
      },
      relativePathToPackage: "./app-playground",
    });
    NagSuppressions.addResourceSuppressions(nextjs.nextjsVpc.vpc, [
      {
        id: "AwsSolutions-VPC7",
        reason: "Flow logs not needed for this example",
      },
    ]);
    NagSuppressions.addResourceSuppressions(
      nextjs.nextjsContainers.albFargateService.loadBalancer,
      [
        {
          id: "AwsSolutions-ELB2",
          reason: "Access logs not needed for demo",
        },
      ],
    );
    new CfnOutput(this, "CdkNextjsUrl", {
      value: nextjs.url,
      key: "CdkNextjsUrl",
    });
    const bastion = this.#createBastionHost(nextjs.nextjsVpc.vpc);
    nextjs.nextjsContainers.albFargateService.loadBalancer.connections.allowFrom(
      bastion.connections,
      Port.HTTP,
    );
  }

  #createBastionHost(vpc: IVpc) {
    const bastion = new BastionHostLinux(this, "SSMBastionHost", {
      vpc,
      instanceName: `prvt-cntnrs-ssm-bastion`,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
      machineImage: MachineImage.latestAmazonLinux2023({
        cachedInContext: true, // prevents newest image from being used on each deploy
        cpuType: AmazonLinuxCpuType.ARM_64,
      }),
    });
    new CfnOutput(this, "BastionId", { value: bastion.instanceId });
    const ssmManagedInstanceCorePolicy = ManagedPolicy.fromAwsManagedPolicyName(
      "AmazonSSMManagedInstanceCore",
    );
    bastion.role.addManagedPolicy(ssmManagedInstanceCorePolicy);
    NagSuppressions.addResourceSuppressions(
      bastion.role.node.findChild("DefaultPolicy"),
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Bastion host can have wildcard policies",
        },
      ],
    );
    NagSuppressions.addResourceSuppressions(bastion.instance, [
      {
        id: "AwsSolutions-EC26",
        reason: "Bastion host's volumes don't need to be encrypted",
      },
      {
        id: "AwsSolutions-EC28",
        reason:
          "Bastion host's autoscaling launch config doesn't need detailed monitoring",
      },
      {
        id: "AwsSolutions-EC29",
        reason: "Bastion host's ASG doesn't need termination protection",
      },
    ]);
    return bastion;
  }
}

const stack = new PrivateContainersStack(app, getStackName("prvt-cntnrs"), {
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
});

suppressCommonNags(stack);
suppressContainerNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
