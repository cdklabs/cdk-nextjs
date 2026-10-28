import { App, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import {
  AuthorizationType,
  IdentitySource,
  MethodOptions,
  RequestAuthorizer,
  ResponseType,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import {
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import {
  NextjsGlobalContainers,
  NextjsGlobalFunctions,
  NextjsRegionalContainers,
  NextjsCache,
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
/** Sent by the load tests as COOKIE; see `requireCookie` and `cookieGatedMethodOptions` */
const REQUIRED_COOKIE = "cdk-nextjs=1";

class LoadTestStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    construct: ConstructName,
    props?: StackProps,
  ) {
    super(scope, id, props);
    let nextjs: { url: string; nextjsCache: NextjsCache };
    switch (construct) {
      case "global-functions": {
        nextjs = new NextjsGlobalFunctions(this, "Nextjs", { buildDirectory });
        break;
      }
      case "global-containers": {
        const containers = new NextjsGlobalContainers(this, "Nextjs", {
          buildDirectory,
          healthCheckPath,
        });
        scaleOnCpu(containers.nextjsContainers.albFargateService);
        nextjs = containers;
        break;
      }
      case "regional-containers": {
        const containers = new NextjsRegionalContainers(this, "Nextjs", {
          buildDirectory,
          healthCheckPath,
        });
        scaleOnCpu(containers.nextjsContainers.albFargateService);
        requireCookie(containers.nextjsContainers.albFargateService);
        nextjs = containers;
        break;
      }
      case "regional-functions": {
        // the default API Gateway stage name, which the app must serve under
        process.env["NEXTJS_BASE_PATH"] = "/prod";
        const functions = new NextjsRegionalFunctions(this, "Nextjs", {
          buildDirectory,
          overrides: {
            nextjsApi: {
              restApiProps: {
                // one CfnAccount per AWS environment, so not per stack
                cloudWatchRole: false,
                defaultMethodOptions: cookieGatedMethodOptions(this),
              },
            },
          },
        });
        explainDenial(functions.nextjsApi.api);
        nextjs = functions;
        break;
      }
    }
    new CfnOutput(this, "CdkNextjsUrl", {
      value: nextjs.url,
      key: "CdkNextjsUrl",
    });
    // For the `use-cache` script's DynamoDB read and throttle metrics.
    new CfnOutput(this, "RevalidationTableName", {
      value: nextjs.nextjsCache.revalidationTable.tableName,
      key: "RevalidationTableName",
    });
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

/**
 * The NextjsRegionalFunctions REST API is public too, and security scanners
 * flag one that answers anonymous requests. Same gate, as a Lambda authorizer
 * on every method: the regional-functions example's, which caches its answer
 * per `Cookie` header, so a load test sending one cookie rarely invokes it.
 */
function cookieGatedMethodOptions(scope: Construct): MethodOptions {
  const handler = new LambdaFunction(scope, "CookieAuthorizerFn", {
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    handler: "index.handler",
    code: Code.fromAsset(
      join(
        import.meta.dirname,
        "..",
        "..",
        "regional-functions",
        "cookie-authorizer",
      ),
    ),
    environment: { REQUIRED_COOKIE },
  });
  const authorizer = new RequestAuthorizer(scope, "CookieAuthorizer", {
    handler,
    // a request with no `Cookie` header gets a 401 before the Lambda runs
    identitySources: [IdentitySource.header("Cookie")],
  });
  return { authorizer, authorizationType: AuthorizationType.CUSTOM };
}

function explainDenial(api: RestApi): void {
  api.addGatewayResponse("Unauthorized", {
    type: ResponseType.UNAUTHORIZED,
    statusCode: "401",
    responseHeaders: { "WWW-Authenticate": `'Cookie name="cdk-nextjs"'` },
    templates: {
      "application/json": JSON.stringify({
        message: `Access denied. Must set cookie: ${REQUIRED_COOKIE}`,
      }),
    },
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
