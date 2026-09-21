/* eslint-disable import/no-extraneous-dependencies */
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { NextjsApi } from "./nextjs-api";

describe("NextjsApi", () => {
  let stack: Stack;

  beforeEach(() => {
    stack = new Stack(new App(), "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
  });

  function createApi(staticAssetsKeyPrefix?: string) {
    return new NextjsApi(stack, "NextjsApi", {
      staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
      staticAssetsKeyPrefix,
      serverFunction: new LambdaFunction(stack, "ServerFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => {};"),
      }),
      publicDirEntries: [
        { name: "favicon.ico", isDirectory: false },
        { name: "images", isDirectory: true },
      ],
    });
  }

  /**
   * The S3 integrations address objects by key, so the uploaded key prefix has
   * to appear in the integration URI or every static request 404s.
   */
  function s3IntegrationKeys(): string[] {
    const methods = Template.fromStack(stack).findResources(
      "AWS::ApiGateway::Method",
    );
    const marker = "s3:path/my-bucket/";
    return Object.values(methods)
      .flatMap((method) => method.Properties.Integration.Uri["Fn::Join"][1])
      .filter(
        (part: unknown): part is string =>
          typeof part === "string" && part.includes(marker),
      )
      .map((part) => part.split(marker)[1]);
  }

  it("addresses objects at the bucket root when no key prefix is set", () => {
    createApi();

    expect(s3IntegrationKeys().sort()).toEqual([
      "_next/static/{key}",
      "favicon.ico",
      "images/{key}",
    ]);
  });

  it("prefixes every S3 integration key with the static assets key prefix", () => {
    createApi("branch-x");

    expect(s3IntegrationKeys().sort()).toEqual([
      "branch-x/_next/static/{key}",
      "branch-x/favicon.ico",
      "branch-x/images/{key}",
    ]);
  });

  it("normalizes surrounding slashes on the key prefix", () => {
    createApi("/branch-x/");

    expect(s3IntegrationKeys()).toContain("branch-x/_next/static/{key}");
  });

  it("keeps the key prefix independent of basePath, which is the URL prefix", () => {
    // A NextjsRegionalFunctions app whose `basePath` matches the API Gateway
    // stage still has its assets at the bucket root.
    new NextjsApi(stack, "NextjsApi", {
      staticAssetsBucket: Bucket.fromBucketName(stack, "Bucket", "my-bucket"),
      basePath: "/prod",
      serverFunction: new LambdaFunction(stack, "ServerFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => {};"),
      }),
      publicDirEntries: [],
    });

    expect(s3IntegrationKeys()).toEqual(["_next/static/{key}"]);
    // ...served under the stage-matching URL prefix.
    Template.fromStack(stack).hasResourceProperties(
      "AWS::ApiGateway::Resource",
      { PathPart: "prod" },
    );
  });
});
