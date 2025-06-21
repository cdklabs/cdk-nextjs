import { Stack } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";

export function suppressCommonNags(stack: Stack) {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsAssetsDeployment/Fn/ServiceRole/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "AWSLambaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole is not overly permissive",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsAssetsDeployment/Fn/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "AssetsDeployment Lambda Custom Resource can read/write any object in StaticAssets Bucket",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsPostDeploy/Fn/ServiceRole/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "AWSLambaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole is not overly permissive",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsPostDeploy/Fn/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "AssetsDeployment Lambda Custom Resource can read/write any object in StaticAssets Bucket",
      },
    ],
  );
  ("/NextjsStaticAssets/Bucket/Resource");
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsStaticAssets/Bucket/Resource`,
    [
      {
        id: "AwsSolutions-S1",
        reason:
          "Static Assets Bucket does not need server access logs as it's serving public assets",
      },
    ],
  );
}

export function suppressLambdaNags(stack: Stack) {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsFunctions/Functions/ServiceRole/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "AWSLambaBasicExecutionRole is not overly permissive",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsFunctions/Functions/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "StringEquals condition enforces access through EFS Access Point so wildcard resource ok",
      },
    ],
  );
}

export function suppressContainerNags(stack: Stack) {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsContainers/AlbFargateService/LB/SecurityGroup/Resource`,
    [
      {
        id: "AwsSolutions-EC23",
        // https://aws.amazon.com/blogs/networking-and-content-delivery/limit-access-to-your-origins-using-the-aws-managed-prefix-list-for-amazon-cloudfront/
        reason:
          "To use CloudFront prefix list to restrict ALB SG requires increasing default quota so for simplicity for example app, not doing this.",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsContainers/AlbFargateService/TaskDef/Resource`,
    [
      {
        id: "AwsSolutions-ECS2",
        reason: "Environment variables do not contain sensitive information",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsContainers/AlbFargateService/TaskDef/ExecutionRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        // TODO: lock down to cdk hnb5 one?
        reason: "ECS Task Execution Role can access any ECR repository",
      },
    ],
  );
}

export function suppressGlobalNags(stack: Stack) {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsDistribution/Distribution/Resource`,
    [
      {
        id: "AwsSolutions-CFR4",
        reason:
          "No TLS Certificate in ACM available for CloudFront Custom Domain",
      },
      {
        id: "AwsSolutions-CFR5",
        reason:
          "No TLS Certificate in ACM available so we must communicate via HTTP to ALB",
      },
    ],
  );
}

export function suppressApiNags(stack: Stack) {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsApi/RestApi/Resource`,
    [
      {
        id: "AwsSolutions-APIG2",
        reason: "Request validation is not required for demo",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    [`/${stack.stackName}/Nextjs/NextjsApi/RestApi/Default`],
    [
      {
        id: "AwsSolutions-APIG4",
        reason: "Authorization is not required for demo",
      },
      {
        id: "AwsSolutions-COG4",
        reason: "Cognito is not required for demo",
      },
    ],
    true,
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsApi/StaticIntegrationRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "API Gateway has permission to read all objects in Static Assets bucket",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsApi/RestApi/DeploymentStage.prod/Resource`,
    [
      {
        id: "AwsSolutions-APIG6",
        reason:
          "Execution logs intentionally disabled b/c of annoying CfnAccount resource which only allows 1 per account-region, only access logs enabled",
      },
    ],
  );
}
