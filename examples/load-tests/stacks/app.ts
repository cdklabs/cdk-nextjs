import { App, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import {
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  NextjsGlobalContainers,
  NextjsGlobalFunctions,
  NextjsRegionalContainers,
  NextjsRegionalFunctions,
} from "cdk-nextjs";
import { Construct } from "constructs";
import { join } from "node:path";

/**
 * The stacks the load tests run against: each root construct, deploying
 * examples/bench-app with its defaults, except where a default would measure
 * something no production deployment runs:
 *   - Containers scale on CPU, from PERF_MIN_TASKS (2) to PERF_MAX_TASKS (10)
 *     tasks. The default is one task and no scaling.
 *   - No DEBUG logging, which would log on every request.
 *
 * One construct per synth, chosen with CONSTRUCT, since each synth builds the
 * bench app: `CONSTRUCT=global-functions pnpm stack:deploy`.
 */
const CONSTRUCTS = {
  "global-functions": "glbl-fns",
  "global-containers": "glbl-cntnrs",
  "regional-containers": "rgnl-cntnrs",
  "regional-functions": "rgnl-fns",
} as const;
type ConstructName = keyof typeof CONSTRUCTS;

const buildDirectory = join(import.meta.dirname, "..", "..", "bench-app");
const healthCheckPath = "/api/health";
/** Sent by the load tests as COOKIE; see `requireCookie` */
const REQUIRED_COOKIE = "cdk-nextjs=1";

class LoadTestStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    construct: ConstructName,
    props?: StackProps,
  ) {
    super(scope, id, props);
    let url: string;
    switch (construct) {
      case "global-functions": {
        url = new NextjsGlobalFunctions(this, "Nextjs", { buildDirectory }).url;
        break;
      }
      case "global-containers": {
        const nextjs = new NextjsGlobalContainers(this, "Nextjs", {
          buildDirectory,
          healthCheckPath,
        });
        scaleOnCpu(nextjs.nextjsContainers.albFargateService);
        url = nextjs.url;
        break;
      }
      case "regional-containers": {
        const nextjs = new NextjsRegionalContainers(this, "Nextjs", {
          buildDirectory,
          healthCheckPath,
        });
        scaleOnCpu(nextjs.nextjsContainers.albFargateService);
        requireCookie(nextjs.nextjsContainers.albFargateService);
        url = nextjs.url;
        break;
      }
      case "regional-functions": {
        // the default API Gateway stage name, which the app must serve under
        process.env["NEXTJS_BASE_PATH"] = "/prod";
        url = new NextjsRegionalFunctions(this, "Nextjs", {
          buildDirectory,
          overrides: {
            nextjsApi: {
              // one CfnAccount per AWS environment, so not per stack
              restApiProps: { cloudWatchRole: false },
            },
          },
        }).url;
        break;
      }
    }
    new CfnOutput(this, "CdkNextjsUrl", { value: url, key: "CdkNextjsUrl" });
  }
}

function scaleOnCpu(service: ApplicationLoadBalancedFargateService): void {
  service.service
    .autoScaleTaskCount({
      minCapacity: Number(process.env["PERF_MIN_TASKS"] ?? 2),
      maxCapacity: Number(process.env["PERF_MAX_TASKS"] ?? 10),
    })
    .scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
      scaleOutCooldown: Duration.minutes(1),
      scaleInCooldown: Duration.minutes(5),
    });
}

/**
 * The NextjsRegionalContainers ALB is public. Forward only requests carrying
 * a cookie, so the stack isn't an open endpoint while it's up.
 */
function requireCookie(service: ApplicationLoadBalancedFargateService): void {
  service.listener.addAction("DefaultDeny", {
    action: ListenerAction.fixedResponse(403, {
      contentType: "text/plain",
      messageBody: `Access denied. Must set cookie: ${REQUIRED_COOKIE}`,
    }),
  });
  service.listener.addAction("CookieCheck", {
    priority: 10,
    conditions: [ListenerCondition.httpHeader("cookie", [REQUIRED_COOKIE])],
    action: ListenerAction.forward([service.targetGroup]),
  });
}

const construct = process.env["CONSTRUCT"] as ConstructName | undefined;
if (!construct || !CONSTRUCTS[construct]) {
  throw new Error(
    `Set CONSTRUCT to one of ${Object.keys(CONSTRUCTS).join(", ")}`,
  );
}
const app = new App();
new LoadTestStack(app, `perf-${CONSTRUCTS[construct]}`, construct);
