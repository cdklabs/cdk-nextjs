/**
 * The CDK app `scripts/e2e-deploy.sh` deploys: one long-lived stack wrapping
 * whichever temporary app the Next.js compatibility harness most recently built.
 *
 * Plain CommonJS on purpose. It runs straight from `lib/` after `pnpm compile`,
 * with no tsx, no tsconfig and no place in the jsii assembly - it is test
 * infrastructure, not part of the published library.
 *
 * @see scripts/e2e-harness/README.md
 */
const { App, CfnOutput, Stack } = require("aws-cdk-lib");
const { NextjsGlobalFunctions } = require("../../lib");

const appDir = required("HARNESS_APP_DIR");
const stackName = required("HARNESS_STACK_NAME");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. This app is deployed by scripts/e2e-deploy.sh, ` +
        `which sets it; see scripts/e2e-harness/README.md to run it by hand.`,
    );
  }
  return value;
}

class HarnessStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // `NextjsGlobalFunctions` and not one of the Regional types, for one
    // reason: its front door is a CloudFront distribution served at the origin
    // root. The harness builds every request URL as `new URL(path, deployUrl)`
    // (`getFullUrl` in `test/lib/next-test-utils.ts` assigns `pathname`), so any
    // prefix in the deployment URL is discarded - and a Regional API Gateway
    // REST URL is always `https://<id>.execute-api.<region>.amazonaws.com/
    // <stage>`, whose stage every absolute path would then miss.
    //
    // It is also the front door the suite expects. `NEXT_TEST_MODE=deploy` is
    // the mode Vercel validates edge-fronted deployments with, so its tests are
    // written to tolerate a CDN, and the ones that cannot are already gated out
    // of deploy mode upstream. Serving from CloudFront means `_next/static` and
    // `public/` are answered by the `NextjsStaticAssets` bucket exactly as in
    // production, rather than by some harness-only arrangement.
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      buildDirectory: appDir,
      // `scripts/e2e-deploy.sh` already ran `next build`: the harness's own
      // `build` script chains a `post-build` that prints the BUILD_ID /
      // DEPLOYMENT_ID / NEXT_SUPPORTS_IMMUTABLE_ASSETS markers the harness
      // parses, so the build has to happen there rather than in this synth.
      skipBuild: true,
      // Required by `NextjsBaseProps` even though only the Containers types wire
      // a health check, and the harness's fixtures have no health route anyway.
      healthCheckPath: "/",
      overrides: {
        nextjsPostDeploy: {
          // Pinned so that this custom resource is never what stops a deploy
          // from hotswapping. Both defaults change on every synth - `buildId` is
          // the real build ID, and `createInvalidationCommandInput` carries a
          // `new Date().toISOString()` caller reference - and a changed
          // custom-resource property is not hotswappable, so either one alone
          // would guarantee a CloudFormation deployment for every test file.
          //
          // What that gives up is the post-deploy pass itself: no cache-bucket
          // pruning of superseded build IDs, and no invalidation between test
          // files. Neither is missed. Cache isolation between files comes from
          // `CDK_NEXTJS_BUILD_ID` (src/adapter/s3-cache-handler.ts), which *is*
          // hotswappable, and `scripts/e2e-deploy.sh` invalidates the
          // distribution itself - it has to, since a hotswap never runs
          // CloudFormation and so never runs a custom resource at all.
          customResourceProperties: {
            buildId: "harness",
            // Dropped, not pinned to a fixed caller reference: CDK strips
            // undefined properties, and `post-deploy.lambda.ts` guards on this
            // being absent (it already is for the Regional types, which have no
            // distribution).
            createInvalidationCommandInput: undefined,
          },
        },
      },
    });

    new CfnOutput(this, "HarnessUrl", {
      key: "HarnessUrl",
      // Trailing slash: the harness treats this as a base for `new URL()`.
      value: nextjs.url + "/",
    });
    // Read by `scripts/e2e-deploy.sh` to invalidate between test files, and by
    // `scripts/e2e-logs.sh`.
    new CfnOutput(this, "DistributionId", {
      key: "DistributionId",
      value: nextjs.nextjsDistribution.distribution.distributionId,
    });
    new CfnOutput(this, "ServerFunctionName", {
      key: "ServerFunctionName",
      value: nextjs.nextjsFunctions.function.functionName,
    });
  }
}

const app = new App();
new HarnessStack(app, stackName, {
  stackName,
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
  // A stack tag, so an orphaned stack is identifiable from CloudFormation alone
  // long after the temporary app directory is gone. `e2e-cleanup.sh` and
  // `e2e-sweep.sh` both refuse to delete a stack without it. Deliberately a
  // constant: a tag whose value changed per deploy (a timestamp, say) would be
  // a stack-level diff on every run and so a CloudFormation update, which is
  // the one thing the hotswap path is trying to avoid. The sweeper ages stacks
  // off CloudFormation's own `CreationTime` instead.
  tags: { "cdk-nextjs:harness": "1" },
});
