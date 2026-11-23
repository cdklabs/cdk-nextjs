import { Stack } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";

/**
 * Helper function to suppress IAM4 for AWSLambdaBasicExecutionRole
 */
function suppressLambdaExecutionRole(
  stack: Stack,
  path: string,
  reason: string = "AWSLambdaBasicExecutionRole is not overly permissive",
) {
  NagSuppressions.addResourceSuppressionsByPath(stack, path, [
    {
      id: "AwsSolutions-IAM4",
      reason,
      appliesTo: [
        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ],
    },
  ]);
}

/**
 * The CDK assets bucket's objects, as cdk-nag renders a grant on them: with the
 * partition, account and region as tokens, or (in a stack with an explicit
 * `env`) the account and region literal and the partition either. Only the
 * bucket's own `/*`, not a deeper prefix.
 */
const CDK_ASSETS_OBJECTS: Array<string | { regex: string }> = [
  {
    regex:
      "/^Resource::arn:(<AWS::Partition>|aws[a-z-]*):s3:::cdk-hnb659fds-assets-[^/]+/\\*$/",
  },
  "Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-<AWS::AccountId>-<AWS::Region>/*",
];

/**
 * Helper function to suppress IAM5 for S3 wildcard permissions commonly needed by compute resources
 */
function suppressS3WildcardPermissions(
  stack: Stack,
  path: string,
  reason: string,
  options: {
    includeStaticAssets?: boolean;
    includeCdkAssets?: boolean;
  } = {},
) {
  const { includeStaticAssets = false, includeCdkAssets = false } = options;

  const actions: string[] = [
    "Action::s3:GetBucket*",
    "Action::s3:GetObject*",
    "Action::s3:List*",
    "Action::s3:Abort*",
    "Action::s3:DeleteObject*",
  ];

  const resources: Array<string | { regex: string }> = [
    {
      regex: "/^Resource::<NextjsNextjsCacheBucket[A-Z0-9]+\\.Arn>/\\*$/",
    },
  ];

  if (includeStaticAssets) {
    resources.push("Resource::<NextjsNextjsStaticAssetsBucketB30C63EE.Arn>/*");
  }

  if (includeCdkAssets) {
    resources.push(...CDK_ASSETS_OBJECTS);
  }

  NagSuppressions.addResourceSuppressionsByPath(stack, path, [
    {
      id: "AwsSolutions-IAM5",
      reason,
      appliesTo: [...actions, ...resources],
    },
  ]);
}

/**
 * Helper function to suppress L1 for Lambda runtime (CDK-managed Lambdas)
 */
function suppressLambdaRuntime(
  stack: Stack,
  path: string,
  reason: string = "Lambda runtime is managed by CDK and updated automatically",
) {
  NagSuppressions.addResourceSuppressionsByPath(stack, path, [
    {
      id: "AwsSolutions-L1",
      reason,
    },
  ]);
}

export function suppressCommonNags(stack: Stack) {
  // Cache bucket suppressions
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsCache/Bucket/Resource`,
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

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsCache/Bucket/Policy/Resource`,
    [
      {
        id: "AwsSolutions-S10",
        reason:
          "Cache bucket policy is configured for internal Lambda access with proper IAM permissions",
      },
    ],
  );

  // Post deploy function suppressions
  suppressLambdaExecutionRole(
    stack,
    `/${stack.stackName}/Nextjs/NextjsPostDeploy/Fn/ServiceRole/Resource`,
    "AWSLambdaBasicExecutionRole is not overly permissive for post-deploy operations",
  );

  suppressS3WildcardPermissions(
    stack,
    `/${stack.stackName}/Nextjs/NextjsPostDeploy/Fn/ServiceRole/DefaultPolicy/Resource`,
    "Post-deploy Lambda needs wildcard S3 permissions to manage cache and static assets",
    { includeStaticAssets: true },
  );

  // Cache seed function suppressions. It only exists when the app has an init
  // cache, and a suppression path that matches nothing throws. Its role has no
  // managed policy (no IAM4), only the log group's grant and these wildcards.
  const cacheSeedPolicy = `${stack.stackName}/Nextjs/NextjsCache/CacheSeedRole/DefaultPolicy/Resource`;
  if (
    stack.node
      .findAll()
      .some((construct) => construct.node.path === cacheSeedPolicy)
  ) {
    // Only the resource wildcards: its actions are exact, so a wildcard
    // action (a delete, say) added later is still reported.
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      `/${cacheSeedPolicy}`,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Cache seed Lambda reads the init cache asset from the CDK assets bucket and writes it under the build's prefix in the cache bucket; whole-bucket grants keep its policy unchanged across builds, which a hotswap needs",
          appliesTo: [
            {
              regex:
                "/^Resource::<NextjsNextjsCacheBucket[A-Z0-9]+\\.Arn>/\\*$/",
            },
            ...CDK_ASSETS_OBJECTS,
          ],
        },
      ],
    );
  }

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
      suppressLambdaExecutionRole(
        stack,
        `/${path}`,
        "CDK BucketDeployment uses AWSLambdaBasicExecutionRole for asset deployment",
      );
    } else if (path.endsWith("/ServiceRole/DefaultPolicy/Resource")) {
      // Suppress CDK Bucket Deployment Default Policies
      suppressS3WildcardPermissions(
        stack,
        `/${path}`,
        "CDK BucketDeployment needs wildcard S3 permissions to deploy static assets",
        { includeStaticAssets: true, includeCdkAssets: true },
      );
    } else if (path.endsWith("/Resource") && !path.includes("/ServiceRole/")) {
      // Suppress CDK Bucket Deployment Lambda Functions
      suppressLambdaRuntime(
        stack,
        `/${path}`,
        "CDK BucketDeployment Lambda runtime is managed by CDK",
      );
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

/**
 * @param functionGroupNames names of any `functionGroups` the stack declares.
 * Each becomes its own Lambda function, at construct id `Functions-<name>`, and
 * needs the same suppressions as the default one.
 */
export function suppressLambdaNags(
  stack: Stack,
  functionGroupNames: string[] = [],
) {
  const constructIds = [
    "Functions",
    ...functionGroupNames.map((name) => `Functions-${name}`),
  ];
  for (const constructId of constructIds) {
    const role = `/${stack.stackName}/Nextjs/NextjsFunctions/${constructId}/ServiceRole`;
    suppressLambdaExecutionRole(stack, `${role}/Resource`);

    suppressS3WildcardPermissions(
      stack,
      `${role}/DefaultPolicy/Resource`,
      "Lambda functions need wildcard S3 permissions to access cache and static assets",
      { includeStaticAssets: true },
    );
  }
}

/**
 * `suppressLambdaNags` for `NextjsGlobalWebFunctions`: each group's Web
 * Function has its execution role at `WebFunction[-<name>]ServiceRole`.
 */
export function suppressWebFunctionNags(
  stack: Stack,
  functionGroupNames: string[] = [],
) {
  const constructIds = [
    "WebFunction",
    ...functionGroupNames.map((name) => `WebFunction-${name}`),
  ];
  for (const constructId of constructIds) {
    const role = `/${stack.stackName}/Nextjs/NextjsWebFunctions/${constructId}ServiceRole`;
    suppressLambdaExecutionRole(stack, `${role}/Resource`);
    // The cache grants, in a policy of their own that the function waits on.
    suppressS3WildcardPermissions(
      stack,
      `/${stack.stackName}/Nextjs/NextjsWebFunctions/${constructId}RuntimePolicy/Resource`,
      "Web Functions need wildcard S3 permissions to access cache and static assets",
      { includeStaticAssets: true },
    );
  }

  // What `WebFunctionCode.fromAssetToManagedBucket` creates per stack: the
  // versioned bucket Lambda reads the code from, and the custom resource that
  // copies the staged asset into it. Paths carry a hash, hence the search.
  for (const construct of stack.node.findAll()) {
    const path = construct.node.path;
    if (path.endsWith("/AWSCDKWebFunctionAssetBucket/Resource")) {
      NagSuppressions.addResourceSuppressionsByPath(stack, `/${path}`, [
        {
          id: "AwsSolutions-S1",
          reason:
            "CDK-managed Web Function code bucket; only CloudFormation writes to it",
        },
      ]);
    } else if (path.includes("/Custom::S3ObjectCopy")) {
      if (path.endsWith("/ServiceRole/Resource")) {
        suppressLambdaExecutionRole(stack, `/${path}`);
      } else if (path.endsWith("/ServiceRole/DefaultPolicy/Resource")) {
        NagSuppressions.addResourceSuppressionsByPath(stack, `/${path}`, [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "CDK's code copy function reads staged assets and writes under the Web Function code bucket's web-function/ prefix",
            appliesTo: [
              "Action::s3:Abort*",
              "Action::s3:DeleteObject*",
              { regex: "/^Resource::<AWSCDKWebFunctionAssetBucket[A-Z0-9]+\\.Arn>/web-function/\\*$/" },
              { regex: "/^Resource::arn:(aws|aws-cn|aws-us-gov|<AWS::Partition>):s3:::cdk-hnb659fds-assets-.+/\\*$/" },
            ],
          },
        ]);
      }
    }
  }
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

  // Only NextjsGlobalContainers reads the static assets bucket, and only it has
  // a distribution: NextjsRegionalContainers carries its assets in the image.
  const includeStaticAssets = !!stack.node
    .tryFindChild("Nextjs")
    ?.node.tryFindChild("NextjsDistribution");
  suppressS3WildcardPermissions(
    stack,
    `/${stack.stackName}/Nextjs/NextjsContainers/AlbFargateService/TaskDef/TaskRole/DefaultPolicy/Resource`,
    includeStaticAssets
      ? "Container task role needs wildcard S3 permissions to access cache and static assets"
      : "Container task role needs wildcard S3 permissions to access the cache",
    { includeStaticAssets },
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
  // Redeploys the stage after each stack update; see `redeployAfterUpdate`.
  suppressLambdaExecutionRole(
    stack,
    `/${stack.stackName}/Nextjs/NextjsApi/RedeployFn/ServiceRole/Resource`,
    "AWSLambdaBasicExecutionRole is not overly permissive for the stage redeploy",
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/Nextjs/NextjsApi/RedeployFn/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Deletes only its own earlier deployments of this REST API; their IDs aren't known in advance",
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
