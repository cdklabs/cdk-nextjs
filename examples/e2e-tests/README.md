# cdk-nextjs E2E Tests

1. Follow [README](../README.md)
2. `cd examples/e2e-tests && pnpm install-browser`
3. Update .env with `E2E_BASE_URL="https://..."` replacing with your cdk-nextjs app playground's url (must include https://)
4. `pnpm run test` or `pnpm run test:ui`

## Connect AWS Account

This steps are only needed if you want to connect cdk-nextjs GitHub Repo to an AWS Account to run e2e tests triggered by AWS account

1. Create IAM Policy with name: `cdk-nextjs-cfn-exec-policy` and description: `CloudFormation Execution Policy to deploy cdk-nextjs from GitHub Actions for e2e tests`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CfnExecCdkNextjs",
      "Effect": "Allow",
      "Action": [
        "application-autoscaling:*",
        "cloudformation:*",
        "cloudfront:*",
        "cloudwatch:*",
        "ecs:*",
        "ec2:*",
        "elasticfilesystem:*",
        "elasticloadbalancing:*",
        "iam:*",
        "lambda:*",
        "logs:*",
        "sqs:*",
        "s3:*",
        "ssm:*"
      ],
      "Resource": ["*"]
    }
  ]
}
```

2. Bootstrap AWS Account with `pnpm dotenv -- pnpm dlx cdk bootstrap aws://<AWS_ACCOUNT>/us-east-1 --cloudformation-execution-policies "arn:aws:iam::<AWS_ACCOUNT>:policy/cdk-nextjs-cfn-exec-policy"`
3. Create IAM Role by running `pnpm deploy-iam-role`

Re-run step 3 on an account whose role predates the 3h `MaxSessionDuration`
`src/github-action-role.ts` now sets: `.github/workflows/e2e-harness.yml` asks
STS for a 3h session, and STS rejects the request outright if the role still
allows only the 1h default.
