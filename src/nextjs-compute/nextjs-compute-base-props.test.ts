/* eslint-disable import/no-extraneous-dependencies */
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { AccountRootPrincipal, Role } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  grantRuntimeAccess,
  runtimeEnvironment,
} from "./nextjs-compute-base-props";
import { NextjsType } from "../constants";

describe("the static assets bucket", () => {
  function synth(nextjsType: NextjsType) {
    const stack = new Stack(new App(), "TestStack");
    const props = {
      cacheBucket: new Bucket(stack, "Cache"),
      revalidationTable: new TableV2(stack, "Table", {
        partitionKey: { name: "pk", type: AttributeType.STRING },
      }),
      staticAssetsBucket: new Bucket(stack, "Assets"),
      buildId: "build",
      nextjsType,
    };
    grantRuntimeAccess(
      props,
      new Role(stack, "Role", { assumedBy: new AccountRootPrincipal() }),
    );
    const policies = JSON.stringify(
      Template.fromStack(stack).findResources("AWS::IAM::Policy"),
    );
    return {
      env: Object.keys(runtimeEnvironment(props)),
      readsAssets: policies.includes("Assets"),
    };
  }

  it("is read by every type that serves assets from S3", () => {
    const { env, readsAssets } = synth(NextjsType.GLOBAL_CONTAINERS);

    expect(env).toContain("CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME");
    expect(env).toContain("CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX");
    expect(readsAssets).toBe(true);
  });

  // Its image carries `public/` and `.next/static`.
  it("is not reachable from NextjsRegionalContainers", () => {
    const { env, readsAssets } = synth(NextjsType.REGIONAL_CONTAINERS);

    expect(env).not.toContain("CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME");
    expect(env).not.toContain("CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX");
    expect(readsAssets).toBe(false);
  });
});
