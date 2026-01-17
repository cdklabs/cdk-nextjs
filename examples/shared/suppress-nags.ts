import { Stack } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";

export function suppressCommonNags(stack: Stack) {
  // Cache bucket suppressions
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsCache/CacheBucket/Resource`,
    [
      {
        id: "AwsSolutions-S1",
        reason:
          "Cache bucket does not need server access logs as it's used for internal caching",
      },
      {
        id: "AwsSolutions-S10",
        reason:
          "Cache bucket is accessed internally by Lambda functions with proper IAM permissions",
      },
    ],
  );

  // Cache bucket policy suppressions
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsCache/CacheBucket/Policy/Resource`,
    [
      {
        id: "AwsSolutions-S10",
        reason:
          "Cache bucket policy is configured for internal Lambda access with proper IAM permissions",
      },
    ],
  );

  // Post deploy function suppressions
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsPostDeploy/Fn/ServiceRole/Resource`,
    [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "AWSLambdaBasicExecutionRole is not overly permissive for post-deploy operations",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
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
          "Post-deploy Lambda needs wildcard S3 permissions to manage cache and static assets",
        appliesTo: [
          "Action::s3:Abort*",
          "Action::s3:DeleteObject*",
          "Action::s3:GetBucket*",
          "Action::s3:GetObject*",
          "Action::s3:List*",
          "Resource::<NextjsNextjsCacheCacheBucket365965B9.Arn>/*",
          "Resource::<NextjsNextjsStaticAssetsBucketB30C63EE.Arn>/*",
        ],
      },
    ],
  );

  // CDK Bucket Deployment suppressions (using regex patterns to match dynamic hashes)
  // Note: We suppress these using a post-synthesis approach since the exact resource names
  // contain dynamic hashes that change between deployments

  // Find all CDK Bucket Deployment resources and suppress them individually in a single loop
  for (const construct of stack.node.findAll()) {
    if (!construct.node.path.includes("Custom::CDKBucketDeployment")) {
      continue;
    }

    const path = construct.node.path;

    if (path.endsWith("/ServiceRole/Resource")) {
      // Suppress CDK Bucket Deployment Service Roles
      NagSuppressions.addResourceSuppressionsByPath(stack, `/${path}`, [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "CDK BucketDeployment uses AWSLambdaBasicExecutionRole for asset deployment",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
      ]);
    } else if (path.endsWith("/ServiceRole/DefaultPolicy/Resource")) {
      // Suppress CDK Bucket Deployment Default Policies
      NagSuppressions.addResourceSuppressionsByPath(stack, `/${path}`, [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "CDK BucketDeployment needs wildcard S3 permissions to deploy static assets",
          appliesTo: [
            "Action::s3:Abort*",
            "Action::s3:DeleteObject*",
            "Action::s3:GetBucket*",
            "Action::s3:GetObject*",
            "Action::s3:List*",
            {
              regex:
                "/^Resource::arn:(aws|aws-cn|aws-us-gov):s3:::cdk-hnb659fds-assets-.+/\\*$/",
            },
            "Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-<AWS::AccountId>-<AWS::Region>/*",
            "Resource::<NextjsNextjsStaticAssetsBucketB30C63EE.Arn>/*",
            {
              regex:
                "/^Resource::<NextjsNextjsCacheCacheBucket[A-Z0-9]+\\.Arn>/\\*$/",
            },
          ],
        },
      ]);
    } else if (path.endsWith("/Resource") && !path.includes("/ServiceRole/")) {
      // Suppress CDK Bucket Deployment Lambda Functions
      NagSuppressions.addResourceSuppressionsByPath(stack, `/${path}`, [
        {
          id: "AwsSolutions-L1",
          reason:
            "CDK BucketDeployment Lambda runtime is managed by CDK and updated automatically",
        },
      ]);
    }
  }

  // Static assets bucket suppressions
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
          "Lambda functions need wildcard S3 permissions to access cache and static assets",
        appliesTo: [
          "Action::s3:Abort*",
          "Action::s3:DeleteObject*",
          "Action::s3:GetBucket*",
          "Action::s3:GetObject*",
          "Action::s3:List*",
          "Resource::<NextjsNextjsCacheCacheBucket365965B9.Arn>/*",
        ],
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
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsContainers/AlbFargateService/TaskDef/TaskRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Container task role needs wildcard S3 permissions to access cache and static assets",
        appliesTo: [
          "Action::s3:Abort*",
          "Action::s3:DeleteObject*",
          "Action::s3:GetBucket*",
          "Action::s3:GetObject*",
          "Action::s3:List*",
          "Resource::<NextjsNextjsCacheCacheBucket365965B9.Arn>/*",
        ],
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
