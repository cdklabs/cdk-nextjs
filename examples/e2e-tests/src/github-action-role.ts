import { App, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { GitHubActionRole } from "cdk-pipelines-github";

/** What `.github/workflows/e2e-harness.yml` asks STS for. */
const MAX_SESSION_DURATION = Duration.hours(3);

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
  }
}

const app = new App();
new AwsGitHubActionRole(app, "github-action-role");
app.synth();
