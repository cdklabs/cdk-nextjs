import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { NextjsPostDeploy } from "./nextjs-post-deploy";

/** The paths the deploy's CloudFront invalidation names. */
function invalidatedPaths(basePath?: string): unknown {
  const stack = new Stack(new App(), "Stack");
  new NextjsPostDeploy(stack, "PostDeploy", {
    basePath,
    buildId: "build",
    distribution: Distribution.fromDistributionAttributes(stack, "Dist", {
      distributionId: "DIST",
      domainName: "d.cloudfront.net",
    }),
  });
  const [resource] = Object.values(
    Template.fromStack(stack).findResources("Custom::NextjsPostDeploy"),
  );
  return resource.Properties.createInvalidationCommandInput.invalidationBatch
    .paths;
}

describe("NextjsPostDeploy", () => {
  it("invalidates the whole distribution without a basePath", () => {
    expect(invalidatedPaths()).toEqual({ quantity: 1, items: ["/*"] });
  });

  it("invalidates only the app's URIs under a basePath", () => {
    // `/*` would flush every other app on a shared distribution too.
    expect(invalidatedPaths("/docs")).toEqual({
      quantity: 3,
      items: ["/docs", "/docs?*", "/docs/*"],
    });
  });
});
