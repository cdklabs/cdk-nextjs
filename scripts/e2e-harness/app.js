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
const { NextjsGlobalFunctions, NextjsRegionalFunctions } = require("../../lib");

const appDir = required("HARNESS_APP_DIR");
const stackName = required("HARNESS_STACK_NAME");
// `global-functions` (the default) or `regional-functions`; see common.sh's
// `harness_nextjs_type`, which validates it and keeps the two stack names apart.
const nextjsType = process.env["HARNESS_NEXTJS_TYPE"] || "global-functions";

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

/**
 * Pins the post-deploy custom resource's properties so it is never what stops a
 * deploy from hotswapping. Shared by both types.
 *
 * Both defaults change on every synth - `buildId` is the real build ID, and
 * `createInvalidationCommandInput` carries a `new Date().toISOString()` caller
 * reference - and a changed custom-resource property is not hotswappable, so
 * either one alone would guarantee a CloudFormation deployment for every test
 * file.
 *
 * What that gives up is the post-deploy pass itself: no cache-bucket pruning of
 * superseded build IDs, and no invalidation between test files. Neither is
 * missed. Cache isolation between files comes from `CDK_NEXTJS_BUILD_ID`
 * (src/adapter/s3-cache-handler.ts), which *is* hotswappable, and
 * `scripts/e2e-deploy.sh` invalidates the distribution itself - it has to, since
 * a hotswap never runs CloudFormation and so never runs a custom resource at all.
 */
const PINNED_POST_DEPLOY = {
  customResourceProperties: {
    buildId: "harness",
    // Dropped, not pinned to a fixed caller reference: CDK strips undefined
    // properties, and `post-deploy.lambda.ts` guards on this being absent (it
    // already is for the Regional types, which have no distribution).
    createInvalidationCommandInput: undefined,
  },
};

const COMMON_PROPS = {
  buildDirectory: appDir,
  // `scripts/e2e-deploy.sh` already ran `next build`: the harness's own `build`
  // script chains a `post-build` that prints the BUILD_ID / DEPLOYMENT_ID /
  // NEXT_SUPPORTS_IMMUTABLE_ASSETS markers the harness parses, so the build has
  // to happen there rather than in this synth.
  skipBuild: true,
};

/**
 * `NextjsRegionalFunctions`: API Gateway REST + Lambda, no CloudFront.
 *
 * Its URL always carries the stage, which the harness would discard, so
 * `e2e-deploy.sh` does not report `HarnessUrl` to the suite directly: it puts
 * `stage-proxy.mjs` in front of it and reports that. See there. The fixture is
 * deployed exactly as built - no `basePath` injected - because the stage never
 * reaches the app: API Gateway strips it, and the proxy re-adds it on the way in.
 */
/**
 * The app's resolved `basePath` from the build's `required-server-files.json`,
 * the same file `NextjsBuild` reads it from.
 */
function fixtureBasePath(dir) {
  const file = require("node:path").join(dir, ".next", "required-server-files.json");
  const { config } = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  return config.basePath || undefined;
}

class RegionalHarnessStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const nextjs = new NextjsRegionalFunctions(this, "Nextjs", {
      ...COMMON_PROPS,
      // The fixture's own `basePath`, as the prop. `resolveBasePath` would derive
      // the same value - a fixture's `basePath` never starts with the stage, so
      // all of it is a resource path - but it would also warn on every deploy
      // that the app's links miss the stage. They do not here: the proxy plays
      // the root-mapped custom domain synth cannot see. Setting the prop to the
      // app's own value is the documented way to say so.
      basePath: fixtureBasePath(appDir),
      overrides: {
        nextjsApi: {
          restApiProps: {
            // One `AWS::ApiGateway::Account` per region, and it is not ours to
            // own from a test stack.
            cloudWatchRole: false,
          },
        },
        nextjsPostDeploy: PINNED_POST_DEPLOY,
      },
    });
    new CfnOutput(this, "HarnessUrl", {
      key: "HarnessUrl",
      // The stage URL alone - not `nextjs.url`, which appends the `basePath`
      // prop set above, while the fixture's requests already carry it.
      // `stage-proxy.mjs` appends each request's own absolute path, and trims
      // the trailing slash `RestApi.url` ends with.
      value: nextjs.nextjsApi.api.url,
    });
    new CfnOutput(this, "ServerFunctionName", {
      key: "ServerFunctionName",
      value: nextjs.nextjsFunctions.function.functionName,
    });
  }
}

class HarnessStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // `NextjsGlobalFunctions` is the default, because its front door is a
    // CloudFront distribution served at the origin root. The harness builds
    // every request URL as `new URL(path, deployUrl)` (`getFullUrl` in
    // `test/lib/next-test-utils.ts` assigns `pathname`), so any prefix in the
    // deployment URL is discarded - which is why `RegionalHarnessStack` above
    // needs `stage-proxy.mjs` and this one needs nothing.
    //
    // It is also the front door the suite expects. `NEXT_TEST_MODE=deploy` is
    // the mode Vercel validates edge-fronted deployments with, so its tests are
    // written to tolerate a CDN, and the ones that cannot are already gated out
    // of deploy mode upstream. Serving from CloudFront means `_next/static` and
    // `public/` are answered by the `NextjsStaticAssets` bucket exactly as in
    // production, rather than by some harness-only arrangement.
    const nextjs = new NextjsGlobalFunctions(this, "Nextjs", {
      ...COMMON_PROPS,
      overrides: { nextjsPostDeploy: PINNED_POST_DEPLOY },
    });

    new CfnOutput(this, "HarnessUrl", {
      key: "HarnessUrl",
      // The distribution's own origin, deliberately not `nextjs.url`: that
      // property appends the app's `basePath` (see NextjsGlobalFunctions#url),
      // and next.js's tests expect a deployment URL without one. They build
      // request URLs both ways - `new URL(path, next.url)`, which discards a
      // prefix, and `` `${next.url}${path}` `` with `path` already carrying the
      // basePath, which doubles it (`/base//base/refresh`). Vercel's deployment
      // URL is the bare origin, so that is what a basePath fixture is written
      // against.
      //
      // No trailing slash either, for the same reason: `vercel deploy` prints a
      // bare origin, so `${next.url}${path}` is what the fixtures are written
      // against. `new URL(path, next.url)` is unaffected - `path` is absolute.
      value: `https://${nextjs.nextjsDistribution.distribution.domainName}`,
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
const StackClass =
  nextjsType === "regional-functions" ? RegionalHarnessStack : HarnessStack;
new StackClass(app, stackName, {
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
