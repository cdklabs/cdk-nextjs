# Bring Your Own Resources

Demonstrates sharing infrastructure across multiple Next.js branch deployments using `NextjsRegionalContainers`.

## Architecture

```
SharedInfra stack (deploy once)
├── VPC + Gateway Endpoints (S3, DynamoDB)
├── ECS Cluster
├── ALB + HTTP Listener (default 404)
├── S3 Cache Bucket
├── S3 Static Assets Bucket
├── DynamoDB Revalidation Table
└── SSM Parameters (resource IDs)

branch-<name> stack (deploy per branch)
├── NextjsRegionalContainers (Fargate service only)
└── ALB Listener Rule (host-header routing → target group)
```

Each branch gets its own Fargate service and ALB listener rule. The ALB routes
traffic based on the `Host` header (`<branch>.app.example.com`).

For `NextjsGlobalContainers`, CloudFront forwards the `Host` header to the ALB
origin, so the ALB handles all branch routing — no CloudFront changes needed per
branch.

## Prerequisites

- AWS CLI configured with credentials
- Docker running (for Next.js container build)
- Create `.env` with `AWS_PROFILE="your-profile"`

## Deploy

```bash
# Install dependencies
pnpm i

# 1. Deploy shared infrastructure (once)
pnpm run deploy:shared

# 2. Deploy a branch (defaults to "main")
pnpm run deploy:branch

# Deploy a specific branch
pnpm run deploy:branch -- -c branchName=feature/my-feature
```

## Destroy

```bash
# Destroy branch stack first
pnpm run destroy:branch

# Then destroy shared infrastructure
pnpm run destroy:shared
```

## DNS Setup

Point `*.app.example.com` to the ALB DNS name (CNAME or Route 53 alias) so
host-header routing works. Each branch is reachable at
`<sanitized-branch>.app.example.com`.

## How It Works

1. `SharedInfraStack` creates all long-lived resources and writes their IDs to
   SSM Parameter Store under `/cdk-nextjs/bring-your-own/*`.
2. `BranchStack` reads those SSM parameters at synth time, imports the resources
   via `fromLookup` / `fromBucketName` / `fromTableName`, and passes them to
   `NextjsRegionalContainers`.
3. `removeAutoCreatedListener()` prevents the Fargate service from creating a
   duplicate listener on the shared ALB.
4. A host-header listener rule routes `<branch>.app.example.com` to the branch's
   target group with a deterministic priority derived from the branch name.
