/**
 * The CDK app `scripts/e2e-deploy.sh` deploys: one stack per Next.js
 * compatibility-harness test file, wrapping the temporary app the harness built.
 *
 * Plain CommonJS on purpose. It runs straight from `lib/` after `pnpm compile`,
 * with no tsx, no tsconfig and no place in the jsii assembly - it is test
 * infrastructure, not part of the published library.
 *
 * @see scripts/e2e-harness/README.md
 */
const { App, CfnOutput, Stack } = require("aws-cdk-lib");
const {
  FunctionUrlAuthType,
  InvokeMode,
} = require("aws-cdk-lib/aws-lambda");
const { NextjsRegionalFunctions } = require("../../lib");

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

    const nextjs = new NextjsRegionalFunctions(this, "Nextjs", {
      buildDirectory: appDir,
      // `scripts/e2e-deploy.sh` already ran `next build`: the harness's own
      // `build` script chains a `post-build` that prints the BUILD_ID /
      // DEPLOYMENT_ID / NEXT_SUPPORTS_IMMUTABLE_ASSETS markers the harness
      // parses, so the build has to happen there rather than in this synth.
      skipBuild: true,
      // Unused by this type (only the Containers types wire a health check),
      // and the harness's fixtures have no health route of their own.
      healthCheckPath: "/",
    });

    // The harness builds every request URL as `new URL(path, deploymentUrl)`
    // (`test/lib/next-test-utils.ts`'s `getFullUrl` assigns `pathname`), which
    // discards any prefix the deployment URL carries. An API Gateway REST API
    // URL is always `https://<id>.execute-api.<region>.amazonaws.com/<stage>`,
    // so every absolute path the harness requests would miss the stage and 404.
    // A Function URL is served at the origin root, so it is the only front door
    // for this type the harness can address - and it reaches the same Lambda,
    // running the same adapter output and the same `src/runtime` entrypoint,
    // that API Gateway would have.
    //
    // What this does not cover: API Gateway's own S3 integrations for
    // `_next/static` and `public/`. Nothing routes those to the bucket here, and
    // the adapter does not stage either directory into the deployment package
    // (`src/runtime/static-files.ts`), so `scripts/e2e-harness/stage-static.js`
    // copies them in and the function serves them off disk.
    // `examples/e2e-tests` stays the gate on the API Gateway path.
    const functionUrl = nextjs.nextjsFunctions.function.addFunctionUrl({
      // A public endpoint, like the CloudFront distributions the examples
      // deploy. It lives for the length of one test file and is torn down by
      // `scripts/e2e-cleanup.sh`.
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.RESPONSE_STREAM,
    });

    new CfnOutput(this, "HarnessUrl", {
      key: "HarnessUrl",
      value: functionUrl.url,
    });
    // Read by `scripts/e2e-logs.sh` to tail the function's CloudWatch logs when
    // a test fails.
    new CfnOutput(this, "ServerFunctionName", {
      key: "ServerFunctionName",
      value: nextjs.nextjsFunctions.function.functionName,
    });
    // Not used by the harness; printed so a failing run can be inspected by
    // hand against the front door the examples use.
    new CfnOutput(this, "ApiUrl", { key: "ApiUrl", value: nextjs.url + "/" });
  }
}

const app = new App();
new HarnessStack(app, stackName, {
  stackName,
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
  // Stack tags, so an orphaned stack is identifiable from CloudFormation alone
  // long after the temporary app directory is gone. `e2e-cleanup.sh` and
  // `e2e-sweep.sh` both refuse to delete a stack without them.
  tags: {
    "cdk-nextjs:harness": "1",
    "cdk-nextjs:harness-created": new Date().toISOString(),
  },
});
