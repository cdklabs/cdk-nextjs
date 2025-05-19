import { App, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { GitHubActionRole } from "cdk-pipelines-github";

/**
 * Used to deploy IAM Role in AWS account to run e2e tests. See README.md
 * @see https://github.com/cdklabs/cdk-pipelines-github?tab=readme-ov-file#githubactionrole-construct
 */
class AwsGitHubActionRole extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    new GitHubActionRole(this, "github-action-role", {
      repos: ["cdklabs/cdk-nextjs"],
    });
  }
}

const app = new App();
new AwsGitHubActionRole(app, "github-action-role");
app.synth();
