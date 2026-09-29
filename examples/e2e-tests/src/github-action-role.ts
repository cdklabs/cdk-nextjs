import { App, ArnFormat, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnRole, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { GitHubActionRole } from "cdk-pipelines-github";

/** What `.github/workflows/e2e-harness.yml` asks STS for. */
const MAX_SESSION_DURATION = Duration.hours(3);

/** Mirrors scripts/e2e-harness/common.sh. */
const HARNESS_STACK_PREFIX = "hrns-";
const HARNESS_TAG_KEY = "cdk-nextjs:harness";
const HARNESS_TAG_VALUE = "1";

/**
 * Used to deploy IAM Role in AWS account to run e2e tests. See README.md
 * @see https://github.com/cdklabs/cdk-pipelines-github?tab=readme-ov-file#githubactionrole-construct
 */
class AwsGitHubActionRole extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const { role } = new GitHubActionRole(this, "github-action-role", {
      repos: ["cdklabs/cdk-nextjs"],
    });

    // `GitHubActionRoleProps` has no prop for this, so reach the L1. A harness
    // shard deploys, tests and tears down up to 50 next.js fixtures in one job,
    // which outlives the 1h `MaxSessionDuration` an `iam.Role` defaults to - and
    // STS rejects a `role-duration-seconds` larger than the role allows, so the
    // workflow cannot raise it alone. Deploy this stack before the harness runs
    // with a duration it does not yet permit.
    (role.node.defaultChild as CfnRole).maxSessionDuration =
      MAX_SESSION_DURATION.toSeconds();

    // `GitHubActionRole` only grants `sts:AssumeRole` on the CDK bootstrap roles,
    // which covers `cdk deploy`. The harness scripts (scripts/e2e-*.sh,
    // scripts/e2e-harness/common.sh) also call the AWS CLI directly, as this role,
    // to read stack outputs, invalidate the distribution, read the server
    // function's `LastModified`, tail its logs, hotswap and delete orphaned
    // stacks. Each statement below is one of those, scoped to the harness's
    // `hrns-` names; DeleteStack and CreateInvalidation are also scoped to its
    // `cdk-nextjs:harness=1` tag, while the Lambda and ECS hotswap grants rely on
    // the name prefix alone. Keep in step with HARNESS_STACK_PREFIX /
    // HARNESS_TAG_* in common.sh.
    const stackArn = this.formatArn({
      service: "cloudformation",
      resource: "stack",
      resourceName: `${HARNESS_STACK_PREFIX}*/*`,
    });
    const harnessTag = {
      StringEquals: {
        [`aws:ResourceTag/${HARNESS_TAG_KEY}`]: HARNESS_TAG_VALUE,
      },
    };
    // The workflow logs in to ECR Public before a Containers run, so the image
    // builds pull `public.ecr.aws/docker/library/node` authenticated rather than
    // hitting the anonymous rate limit. Neither action can be scoped to a resource.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "ecr-public:GetAuthorizationToken",
          "sts:GetServiceBearerToken",
        ],
        resources: ["*"],
      }),
    );
    // `e2e-sweep.sh` lists every stack to find orphans. DescribeStacks with no
    // stack name cannot be scoped to a resource, and IAM authorizes it as
    // `cloudformation:ListStacks` too - without that, the workflow's `sweep` job
    // failed on AccessDenied. Read-only.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["cloudformation:DescribeStacks", "cloudformation:ListStacks"],
        resources: ["*"],
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["cloudformation:DescribeStackEvents"],
        resources: [stackArn],
      }),
    );
    // The scripts re-check the tag themselves before deleting
    // (`harness_stack_is_ours`); this makes IAM refuse an untagged stack too.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["cloudformation:DeleteStack"],
        resources: [stackArn],
        conditions: harnessTag,
      }),
    );
    // A harness stack is deployed through the bootstrap's CloudFormation
    // execution role, and CloudFormation deletes it with that role, which it
    // checks the caller may pass.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          this.formatArn({
            service: "iam",
            region: "",
            resource: "role",
            resourceName: "cdk-*-cfn-exec-role-*",
          }),
        ],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "cloudformation.amazonaws.com",
          },
        },
      }),
    );
    // `e2e-deploy.sh` invalidates after a hotswap, which never runs the
    // post-deploy custom resource. The distribution inherits the stack's tags.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
        ],
        resources: [
          this.formatArn({
            service: "cloudfront",
            region: "",
            resource: "distribution",
            resourceName: "*",
          }),
        ],
        conditions: harnessTag,
      }),
    );
    // `cdk deploy --hotswap-fallback`, which every harness file after the first
    // takes. Unlike a CloudFormation deployment, a hotswap makes its SDK calls
    // with the CLI's own credentials - this role - rather than the bootstrap
    // deploy role (`hotswapDeployment` in aws-cdk: `sdkProvider.forEnvironment(
    // env, ForWriting)`). Without these, every deploy after `e2e-warm.sh`'s create
    // failed on AccessDenied (`cloudformation:GetTemplate`). CloudFormation names
    // every physical resource `<stack name>-...`, so `hrns-*` scopes each one.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "cloudformation:GetTemplate",
          "cloudformation:ListStackResources",
        ],
        resources: [stackArn],
      }),
    );
    // Resolving `Fn::ImportValue` while evaluating the template. Read-only, and
    // cannot be scoped to a resource.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["cloudformation:ListExports"],
        resources: ["*"],
      }),
    );
    // Function code and environment, and the BucketDeployment provider that
    // hotswapping a `Custom::CDKBucketDeployment` invokes.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:UpdateAlias",
          "lambda:InvokeFunction",
        ],
        resources: [
          this.formatArn({
            service: "lambda",
            resource: "function",
            resourceName: `${HARNESS_STACK_PREFIX}*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // `UpdateFunctionCode` with an S3 location reads the object as the caller,
    // and the code is in the bootstrap's assets bucket. Measured: without it,
    // every Lambda hotswap failed with "Your access has been denied by S3".
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          `arn:${this.partition}:s3:::cdk-*-assets-${this.account}-${this.region}/*`,
        ],
      }),
    );
    // The Containers types: a new task definition, then the service pointed at
    // it. `RegisterTaskDefinition` has no resource-level scoping.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["ecs:RegisterTaskDefinition"],
        resources: ["*"],
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["ecs:UpdateService", "ecs:DescribeServices"],
        resources: [
          this.formatArn({
            service: "ecs",
            resource: "service",
            resourceName: `${HARNESS_STACK_PREFIX}*/${HARNESS_STACK_PREFIX}*`,
          }),
        ],
      }),
    );
    // A task definition names its task and execution roles, and registering one
    // checks the caller may pass them.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          this.formatArn({
            service: "iam",
            region: "",
            resource: "role",
            resourceName: `${HARNESS_STACK_PREFIX}*`,
          }),
        ],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );
    // `e2e-deploy.sh` waits for the new task to be the target group's only
    // healthy target. Read-only, and cannot be scoped to a resource.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["elasticloadbalancing:DescribeTargetHealth"],
        resources: ["*"],
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["logs:FilterLogEvents", "logs:DescribeLogGroups"],
        resources: [
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `/aws/lambda/${HARNESS_STACK_PREFIX}*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `/aws/lambda/${HARNESS_STACK_PREFIX}*:*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
          // The Containers types' task log groups, named after the stack.
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `${HARNESS_STACK_PREFIX}*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `${HARNESS_STACK_PREFIX}*:*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
  }
}

const app = new App();
new AwsGitHubActionRole(app, "github-action-role");
app.synth();
