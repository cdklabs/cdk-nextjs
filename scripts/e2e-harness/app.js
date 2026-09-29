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
const { App, CfnOutput, Duration, Stack } = require("aws-cdk-lib");
const { Vpc } = require("aws-cdk-lib/aws-ec2");
const {
  NextjsGlobalContainers,
  NextjsGlobalFunctions,
  NextjsRegionalContainers,
  NextjsRegionalFunctions,
} = require("../../lib");

const appDir = required("HARNESS_APP_DIR");
const stackName = required("HARNESS_STACK_NAME");
// One of the four `NextjsType`s, `global-functions` by default; see common.sh's
// `harness_nextjs_type`, which validates it and keeps the stack names apart.
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
 * Pins every post-deploy custom resource property that can differ between two
 * fixtures, so the resource never changes and never does anything. Shared by
 * every type.
 *
 * - `buildId` is the real build ID and `createInvalidationCommandInput` carries
 *   a `new Date().toISOString()` caller reference, so either one alone would
 *   make every synth a non-hotswappable change, and every test file a
 *   CloudFormation deployment.
 * - `staticAssetsKeyPrefix` follows the fixture's `basePath`, so switching
 *   between a basePath fixture and one without would still force an Update -
 *   and an Update with the bucket and table names set prunes every
 *   `<buildId>/` prefix but `"harness"`, i.e. the cache the fixture just
 *   seeded. Dropping the names turns off every prune branch in
 *   `post-deploy.lambda.ts`, so the Create and any Update are both no-ops.
 *
 * What that gives up is the post-deploy pass itself: no pruning and no
 * invalidation. Neither is missed. Cache isolation between files comes from
 * `CDK_NEXTJS_BUILD_ID` (src/adapter/s3-cache-handler.ts), which *is*
 * hotswappable, and `scripts/e2e-deploy.sh` invalidates the distribution itself
 * - it has to, since a hotswap never runs a custom resource at all. The stack
 * is deleted after every run, so nothing accumulates.
 *
 * `undefined` rather than fixed values: CDK strips undefined properties, and the
 * handler guards on each being absent.
 */
const PINNED_POST_DEPLOY = {
  customResourceProperties: {
    buildId: "harness",
    createInvalidationCommandInput: undefined,
    cacheBucketName: undefined,
    revalidationTableName: undefined,
    staticAssetsBucketName: undefined,
    staticAssetsKeyPrefix: undefined,
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

/**
 * A path no fixture routes, for the container health checks.
 *
 * Both container types require a `healthCheckPath` that answers 200, and the
 * harness's fixtures - written for Vercel - have no such route. Adding one to
 * every fixture would change the app under test (a pages-only fixture would grow
 * an `app/` directory), so instead both checks are pointed at a path the app
 * 404s and told that any answer means the server is up. They exist to tell a
 * running task from one that is not listening, and a 404 tells them that.
 *
 * Under `/_next/static/`, which both this runtime and `next start` answer from
 * the build's static files alone: a missing file there is a plain 404 before
 * any app route is tried. Anywhere else a fixture's dynamic route can catch it.
 * The top-level `/__cdk-nextjs-harness-health` was taken by
 * `use-cache-metadata-route-handler`'s `/[slug]` page, which threw on it (a 500,
 * past the ALB's 200-499 range, so the task under test kept being replaced);
 * `/_next/__cdk-nextjs-harness-health` was taken by `sub-shell-generation`'s
 * `/[lang]/[slug]` as `lang: "_next"`, and the health check's renders left
 * `/es/*` served a runtime root layout instead of the build-time shell.
 */
const HEALTH_CHECK_PATH = "/_next/static/__cdk-nextjs-harness-health";

/**
 * The container types' own VPC, with one NAT gateway rather than the default of
 * one per AZ. A sharded run creates a stack per shard, and every NAT gateway
 * holds an Elastic IP out of a per-region quota the account's other stacks share.
 */
function harnessVpc(scope) {
  return new Vpc(scope, "Vpc", { maxAzs: 2, natGateways: 1 });
}

/**
 * Loosens both container health checks to "the server answered" (see
 * HEALTH_CHECK_PATH), keeping the construct's timings.
 */
function acceptAnyAnswer(nextjsContainers, basePath) {
  const path = `${basePath || ""}${HEALTH_CHECK_PATH}`;
  const { albFargateService } = nextjsContainers;
  // `configureHealthCheck` replaces the whole health check, so the construct's
  // timings are restated (src/nextjs-compute/nextjs-containers.ts).
  albFargateService.targetGroup.configureHealthCheck({
    path,
    healthyHttpCodes: "200-499",
    healthyThresholdCount: 2,
    interval: Duration.seconds(10),
    timeout: Duration.seconds(5),
  });
  // The construct sets this the same way, through the container's props; there
  // is no public setter. `wget --spider` fails on a 404, so ask node instead,
  // which resolves `fetch` for any HTTP answer and rejects only when nothing is
  // listening.
  albFargateService.taskDefinition.defaultContainer.props.healthCheck = {
    command: [
      "CMD-SHELL",
      `node -e "fetch('http://localhost:3000${path}').then(() => process.exit(0), () => process.exit(1))"`,
    ],
  };
}

/**
 * Keeps the harness's own files out of the image's build context, which is the
 * fixture directory. `.adapter-cdk-out` is where this very synth writes its
 * assembly - left in, the asset would try to stage a copy of itself - and
 * `node_modules` and `.next/cache` are large and unused: the Dockerfile copies
 * only the staged deployment root, `.next/static` and `public`.
 */
const CONTAINER_OVERRIDES = {
  dockerImageAssetProps: {
    exclude: ["cdk.out", ".adapter-*", "node_modules", ".next/cache"],
  },
};

function containerOutputs(scope, nextjsContainers) {
  const { albFargateService } = nextjsContainers;
  new CfnOutput(scope, "EcsClusterName", {
    key: "EcsClusterName",
    value: albFargateService.cluster.clusterName,
  });
  new CfnOutput(scope, "EcsServiceName", {
    key: "EcsServiceName",
    value: albFargateService.service.serviceName,
  });
  // Read by `e2e-deploy.sh`, which waits on it: a hotswap into ECS returns once
  // the task is RUNNING, which is before the load balancer will route to it.
  new CfnOutput(scope, "TargetGroupArn", {
    key: "TargetGroupArn",
    value: albFargateService.targetGroup.targetGroupArn,
  });
  const logDriver = albFargateService.taskDefinition.defaultContainer.logDriverConfig;
  new CfnOutput(scope, "ServerLogGroupName", {
    key: "ServerLogGroupName",
    value: logDriver.options["awslogs-group"],
  });
}

/**
 * `NextjsGlobalContainers`: CloudFront + ALB + Fargate. Served at the
 * distribution's origin root, like `HarnessStack`, and invalidated the same way
 * by `e2e-deploy.sh`.
 */
class GlobalContainersHarnessStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const nextjs = new NextjsGlobalContainers(this, "Nextjs", {
      ...COMMON_PROPS,
      healthCheckPath: HEALTH_CHECK_PATH,
      vpc: harnessVpc(this),
      overrides: {
        nextjsContainers: CONTAINER_OVERRIDES,
        nextjsPostDeploy: PINNED_POST_DEPLOY,
      },
    });
    acceptAnyAnswer(nextjs.nextjsContainers, fixtureBasePath(appDir));
    new CfnOutput(this, "HarnessUrl", {
      key: "HarnessUrl",
      // The bare origin, for the reasons given in `HarnessStack`.
      value: `https://${nextjs.nextjsDistribution.distribution.domainName}`,
    });
    new CfnOutput(this, "DistributionId", {
      key: "DistributionId",
      value: nextjs.nextjsDistribution.distribution.distributionId,
    });
    containerOutputs(this, nextjs.nextjsContainers);
  }
}

/**
 * `NextjsRegionalContainers`: a public ALB + Fargate, no CloudFront. The ALB
 * forwards every path unchanged, so - unlike `NextjsRegionalFunctions` - its URL
 * has no stage and needs no proxy. Plain HTTP, which is what the construct
 * deploys without a certificate.
 */
class RegionalContainersHarnessStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const nextjs = new NextjsRegionalContainers(this, "Nextjs", {
      ...COMMON_PROPS,
      healthCheckPath: HEALTH_CHECK_PATH,
      vpc: harnessVpc(this),
      overrides: {
        nextjsContainers: CONTAINER_OVERRIDES,
        nextjsPostDeploy: PINNED_POST_DEPLOY,
      },
    });
    acceptAnyAnswer(nextjs.nextjsContainers, fixtureBasePath(appDir));
    new CfnOutput(this, "HarnessUrl", {
      key: "HarnessUrl",
      // The ALB's bare origin - not `nextjs.url`, which appends the fixture's
      // `basePath`, for the reasons given in `HarnessStack`.
      value: nextjs.nextjsContainers.url,
    });
    containerOutputs(this, nextjs.nextjsContainers);
  }
}

const STACK_CLASSES = {
  "global-functions": HarnessStack,
  "regional-functions": RegionalHarnessStack,
  "global-containers": GlobalContainersHarnessStack,
  "regional-containers": RegionalContainersHarnessStack,
};

const app = new App();
new STACK_CLASSES[nextjsType](app, stackName, {
  stackName,
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
  // A stack tag, so an orphaned stack is identifiable from CloudFormation alone
  // long after the temporary app directory is gone. `e2e-sweep.sh` refuses to
  // delete a stack without it. The key and value come from common.sh, which
  // exports them, so the tag written here and the tag checked there cannot
  // drift. Deliberately a constant: a tag whose value changed per deploy (a
  // timestamp, say) would be a stack-level diff on every run and so a
  // CloudFormation update, which is the one thing the hotswap path is trying to
  // avoid. The sweeper ages stacks off their server function's (or ECS
  // service's) last hotswap instead.
  tags: { [required("HARNESS_TAG_KEY")]: required("HARNESS_TAG_VALUE") },
});
