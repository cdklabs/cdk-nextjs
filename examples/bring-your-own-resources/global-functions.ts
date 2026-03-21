/**
 * Bring Your Own Resources — NextjsGlobalFunctions
 *
 * Demonstrates importing existing shared infrastructure into a per-branch
 * Next.js deployment. In production, the shared resources (Distribution,
 * S3 buckets, DynamoDB table) live in a separate CDK app / stack. Each
 * branch stack imports them via fromLookup / fromAttributes.
 *
 * Architecture:
 *   Separate CDK App   → Distribution, S3 buckets, DynamoDB table
 *   This CDK App       → NextjsGlobalFunctions (compute only)
 */
import { App, CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { NextjsGlobalFunctions } from "cdk-nextjs";
import { Construct } from "constructs";
import { join } from "node:path";

const app = new App();
const branchName = app.node.tryGetContext("branchName") ?? "main";

class BranchStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const basePath = `/${branchName}`;

    // Import shared resources created by a separate CDK app / stack.
    // Replace the IDs and ARNs with your actual values (or resolve from
    // SSM Parameter Store, CDK context, etc.).
    const distribution = Distribution.fromDistributionAttributes(
      this,
      "Distribution",
      {
        distributionId: "EXXXXXXXXX",
        domainName: "dxxxxxxxxx.cloudfront.net",
      },
    );

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

    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      buildDirectory: join(import.meta.dirname, "..", "app-playground"),
      healthCheckPath: "/api/health",
      basePath,
      // Bring your own resources
      distribution,
      cacheBucket,
      revalidationTable,
      staticAssetsBucket,
    });

    new CfnOutput(this, "BranchUrl", {
      value: `${nextjs.url}${basePath}`,
    });
  }
}

new BranchStack(app, `branch-${branchName}`);
