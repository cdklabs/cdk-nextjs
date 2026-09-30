# Bring Your Own Resources

Demonstrates sharing infrastructure (VPC, ECS cluster, ALB) across multiple Next.js branch deployments using `NextjsRegionalContainers`.

## Architecture

```
SharedInfra stack (deploy once)
├── VPC + Gateway Endpoints (S3, DynamoDB)
├── ECS Cluster
├── ALB + HTTP Listener (default 404)
└── SSM Parameters (resource IDs)

branch-<name> stack (deploy per branch)
├── NextjsRegionalContainers
│   ├── Fargate service
│   ├── S3 Cache Bucket
│   ├── S3 Static Assets Bucket
│   └── DynamoDB Revalidation Table
└── ALB Listener Rule (host-header routing → target group)
```

Each branch gets its own Fargate service, ALB listener rule, cache bucket,
revalidation table, and static assets bucket. The cache bucket and revalidation
table can't be shared between deployments: each deploy prunes everything in them
that isn't from its own current build. Every branch serves the same build at
the root, so they'd also overwrite and prune each other's static assets in one
bucket. The ALB routes
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

### Upgrading from 0.6.x

Deploy every branch stack first, then shared infrastructure. The new
`SharedInfra` deletes the shared cache bucket, static assets bucket,
revalidation table and their SSM parameters, which branch stacks still on 0.6.x
serve from and read at deploy. See
[breaking changes](../../docs/breaking-changes.md#sharing-a-cachebucket-or-revalidationtable-between-deployments-is-not-supported).

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

1. `SharedInfraStack` creates the long-lived shared resources (VPC, ECS cluster,
   ALB and listener) and writes their IDs to SSM Parameter Store under
   `/cdk-nextjs/bring-your-own/*`.
2. `BranchStack` reads those SSM parameters at synth time, imports the resources
   via `fromLookup` / `fromClusterAttributes`, and passes them to
   `NextjsRegionalContainers`, which creates the branch's own buckets and table
   (removed when the branch stack is destroyed).
3. `removeAutoCreatedListener()` prevents the Fargate service from creating a
   duplicate listener on the shared ALB.
4. A host-header listener rule routes `<branch>.app.example.com` to the branch's
   target group with a deterministic priority derived from the branch name.
