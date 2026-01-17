/* eslint-disable import/no-extraneous-dependencies */
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType } from "aws-cdk-lib/aws-dynamodb";
import { NextjsCache } from "./nextjs-cache";

describe("NextjsCache", () => {
  let app: App;
  let stack: Stack;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, "TestStack");
  });

  describe("Basic Construction", () => {
    it("should create S3 bucket and DynamoDB table", () => {
      const cache = new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
      });

      expect(cache.cacheBucket).toBeDefined();
      expect(cache.revalidationTable).toBeDefined();
      expect(cache.buildId).toBe("test-build-123");

      const template = Template.fromStack(stack);

      // Verify S3 bucket is created
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });

      // Verify DynamoDB table is created (TableV2 creates GlobalTable resource)
      template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
        KeySchema: [
          {
            AttributeName: "pk",
            KeyType: "HASH",
          },
          {
            AttributeName: "sk",
            KeyType: "RANGE",
          },
        ],
        AttributeDefinitions: [
          {
            AttributeName: "pk",
            AttributeType: "S",
          },
          {
            AttributeName: "sk",
            AttributeType: "S",
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("should apply custom overrides", () => {
      new NextjsCache(stack, "TestCache", {
        buildId: "test-build-123",
        overrides: {
          cacheBucketProps: {
            bucketName: "custom-cache-bucket",
          },
          revalidationTableProps: {
            tableName: "custom-revalidation-table",
            partitionKey: {
              name: "tag",
              type: AttributeType.STRING,
            },
            sortKey: {
              name: "cacheKey",
              type: AttributeType.STRING,
            },
          },
        },
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: "custom-cache-bucket",
      });

      template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
        TableName: "custom-revalidation-table",
      });
    });
  });
});
