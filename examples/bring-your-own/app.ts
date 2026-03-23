/**
 * Bring Your Own Resources — Deployable Example
 *
 * Two stacks:
 *   1. SharedInfra  — VPC, ECS Cluster, ALB + HTTP Listener, S3 buckets,
 *                     DynamoDB table. Deploy once.
 *   2. branch-<name> — NextjsRegionalContainers using the shared resources.
 *                      Deploy per branch. Host-header routing on the ALB
 *                      sends traffic to the correct target group.
 *
 * Resource identifiers flow through SSM Parameter Store so there are no
 * cross-stack CfnOutput dependencies.
 */
import { App, CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Cluster } from "aws-cdk-lib/aws-ecs";
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { NextjsRegionalContainers } from "cdk-nextjs";
import { Construct } from "constructs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SharedInfraStack, SSM_PREFIX } from "./shared-infra";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a git branch name into a DNS-safe subdomain label. */
function branchToSubdomain(branch: string): string {
  return branch
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 63);
}

/**
 * Deterministic ALB listener rule priority (1–50000) derived from the
 * subdomain so each branch gets a stable, unique priority.
 */
function hashToPriority(subdomain: string): number {
  const hash = createHash("sha256").update(subdomain).digest();
  return (hash.readUInt16BE(0) % 50000) + 1;
}

/** Read an SSM parameter at synth time (requires `env` on the stack). */
function ssm(scope: Construct, key: string): string {
  return StringParameter.valueForStringParameter(scope, `${SSM_PREFIX}/${key}`);
}

// ---------------------------------------------------------------------------
// Branch Stack
// ---------------------------------------------------------------------------

interface BranchStackProps extends StackProps {
  branchName: string;
}

class BranchStack extends Stack {
  constructor(scope: Construct, id: string, props: BranchStackProps) {
    super(scope, id, props);

    const subdomain = branchToSubdomain(props.branchName);

    // --- Import shared resources via SSM ---
    const vpc = Vpc.fromLookup(this, "Vpc", {
      vpcId: ssm(this, "VpcId"),
    });

    const ecsCluster = Cluster.fromClusterAttributes(this, "EcsCluster", {
      clusterName: ssm(this, "ClusterName"),
      vpc,
      securityGroups: [],
    });

    const alb = ApplicationLoadBalancer.fromLookup(this, "Alb", {
      loadBalancerArn: ssm(this, "AlbArn"),
    });

    const httpsListener = ApplicationListener.fromLookup(this, "Listener", {
      listenerArn: ssm(this, "ListenerArn"),
    });

    const cacheBucket = Bucket.fromBucketName(
      this,
      "CacheBucket",
      ssm(this, "CacheBucketName"),
    );

    const staticAssetsBucket = Bucket.fromBucketName(
      this,
      "StaticAssetsBucket",
      ssm(this, "StaticAssetsBucketName"),
    );

    const revalidationTable = Table.fromTableName(
      this,
      "RevalidationTable",
      ssm(this, "RevalidationTableName"),
    );

    // --- Deploy Next.js ---
    const nextjs = new NextjsRegionalContainers(this, "Nextjs", {
      buildDirectory: join(import.meta.dirname, "..", "app-playground"),
      healthCheckPath: "/api/health",
      vpc,
      alb,
      ecsCluster,
      cacheBucket,
      revalidationTable,
      staticAssetsBucket,
    });

    // The shared ALB already owns the listener — remove the auto-created one
    // to avoid "listener already exists on this port" deployment failures.
    nextjs.nextjsContainers.removeAutoCreatedListener();

    // --- Host-header routing ---
    // For NextjsGlobalContainers, CloudFront forwards the Host header to the
    // ALB origin, so the ALB handles all branch routing — no CloudFront
    // changes needed per branch.
    const domainName = `${subdomain}.app.example.com`;

    httpsListener.addAction(`${subdomain}-route`, {
      priority: hashToPriority(subdomain),
      conditions: [ListenerCondition.hostHeaders([domainName])],
      action: ListenerAction.forward([
        nextjs.nextjsContainers.albFargateService.targetGroup,
      ]),
    });

    new CfnOutput(this, "BranchUrl", {
      value: `http://${domainName}`,
    });
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new App();
const branchName = app.node.tryGetContext("branchName") ?? "main";

const env = {
  account: process.env["CDK_DEFAULT_ACCOUNT"],
  region: process.env["CDK_DEFAULT_REGION"],
};

new SharedInfraStack(app, "SharedInfra", { env });
new BranchStack(app, `branch-${branchToSubdomain(branchName)}`, {
  env,
  branchName,
});
