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
    // function's `LastModified`, tail its logs and delete orphaned stacks. Each
    // statement below is one of those, scoped to the harness's `hrns-` names and,
    // wherever something is changed, to its `cdk-nextjs:harness=1` tag. Keep in
    // step with HARNESS_STACK_PREFIX / HARNESS_TAG_* in common.sh.
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
    // `e2e-sweep.sh` lists every stack to find orphans, and DescribeStacks with no
    // stack name cannot be scoped to a resource. Read-only.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
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
    // CloudFormation names a function `<stack name>-<logical id>-<suffix>`, so
    // the prefix scopes it to harness stacks.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["lambda:GetFunctionConfiguration"],
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
        ],
      }),
    );
  }
}

const app = new App();
new AwsGitHubActionRole(app, "github-action-role");
app.synth();
