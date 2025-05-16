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
}

export function suppressFunctionsNags(stack: Stack) {
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
    `/${stack.stackName}/Nextjs/NextjsStaticAssets/Bucket/Resource`,
    [
      {
        id: "AwsSolutions-S1",
        reason:
          "Server access logs are not required for Next.js Static Assets because they're public web assets",
      },
    ],
  );
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
  // AWS679f53fac002430cb0da5b7982bd2287 is for CloudFront Invalidation function
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason: "AWSLambdaBasicExecutionRole is not overly permissive",
      },
    ],
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    [
      {
        id: "AwsSolutions-L1",
        reason:
          "AWS CDK Team manages runtime for AwsSdkCall Custom Resource and will update when necessary",
      },
    ],
  );
}
