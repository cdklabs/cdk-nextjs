/**
 * Bring Your Own Resources — NextjsRegionalContainers
 *
 * Demonstrates importing existing shared infrastructure into a per-branch
 * Next.js deployment. In production, the shared resources (VPC, ECS Cluster,
 * ALB, S3 buckets, DynamoDB table) live in a separate CDK app / stack. Each
 * branch stack imports them via fromLookup / fromAttributes and creates only
 * its Fargate service.
 *
 * Because the shared ALB already has a listener on port 80, we call
 * `removeAutoCreatedListener()` to surgically remove the duplicate listener
 * that `ApplicationLoadBalancedFargateService` always creates.
 *
 * Architecture:
 *   Separate CDK App   → VPC, ECS Cluster, ALB, S3 buckets, DynamoDB table
 *   This CDK App       → NextjsRegionalContainers (Fargate service only)
 */
import { App, CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Cluster } from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { NextjsRegionalContainers } from "cdk-nextjs";
import { Construct } from "constructs";
import { join } from "node:path";

const app = new App();
const branchName = app.node.tryGetContext("branchName") ?? "main";

class BranchStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const basePath = `/${branchName}`;

    // Import shared resources created by a separate CDK app / stack.
    // Replace the IDs, ARNs, and names with your actual values (or
    // resolve from SSM Parameter Store, CDK context, etc.).
    const vpc = Vpc.fromLookup(this, "Vpc", {
      vpcId: "vpc-xxxxxxxxxxxxxxxxx",
    });

    const ecsCluster = Cluster.fromClusterAttributes(this, "EcsCluster", {
      clusterName: "my-shared-cluster",
      vpc,
      securityGroups: [],
    });

    // fromLookup returns IApplicationLoadBalancer which is what the
    // alb prop accepts.
    const alb = ApplicationLoadBalancer.fromLookup(this, "Alb", {
      loadBalancerArn:
        "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-shared-alb/1234567890abcdef",
    });

    const cacheBucket = Bucket.fromBucketName(
      this,
      "CacheBucket",
      "my-shared-cache-bucket",
    );

    const revalidationTable = Table.fromTableName(
      this,
      "RevalidationTable",
      "my-shared-revalidation-table",
    );

    const staticAssetsBucket = Bucket.fromBucketName(
      this,
      "StaticAssetsBucket",
      "my-shared-static-assets-bucket",
    );

    const nextjs = new NextjsRegionalContainers(this, "Nextjs", {
      buildDirectory: join(import.meta.dirname, "..", "app-playground"),
      healthCheckPath: "/api/health",
      basePath,
      vpc,
      // Bring your own resources
      alb,
      ecsCluster,
      cacheBucket,
      revalidationTable,
      staticAssetsBucket,
    });

    // The shared ALB already has a listener on port 80. Remove the
    // auto-created one from ApplicationLoadBalancedFargateService to
    // avoid "listener already exists on this port" deployment failures.
    nextjs.nextjsContainers.removeAutoCreatedListener();

    new CfnOutput(this, "BranchUrl", {
      value: `${nextjs.url}${basePath}`,
    });
  }
}

new BranchStack(app, `branch-${branchName}`);
