import {
  Aspects,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsRegionalFunctions } from "cdk-nextjs";
import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  suppressApiNags,
  suppressCommonNags,
  suppressLambdaNags,
} from "../shared/suppress-nags";
import { getStackName } from "../shared/get-stack-name";
import { join } from "node:path";
import {
  AccessLogFormat,
  AuthorizationType,
  IdentitySource,
  LogGroupLogDestination,
  RequestAuthorizer,
  ResponseType,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { Architecture, Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();

// Not needed by this app - it fits in one Lambda. Declared so CI exercises the
// split behind API Gateway too: the `function-groups` e2e asserts `/api/**` and
// `/` are served by different functions. See `E2E_FUNCTION_GROUPS` in
// `.github/workflows/e2e-tests.yml`.
const functionGroups = [{ name: "api", routes: ["/api/**"] }];

/** Checked by `cookie-authorizer`; the e2e tests send it on every request */
const REQUIRED_COOKIE = "cdk-nextjs=1";

export class RegionalFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    process.env["NEXTJS_BASE_PATH"] = "/prod"; // default API Gateway stage name
    process.env["NEXT_PUBLIC_IMAGE_SRC_PREFIX"] = "/prod"; // prefix image paths for API Gateway deployments
    const authorizer = this.#createCookieAuthorizer();
    const nextjs = new NextjsRegionalFunctions(this, "Nextjs", {
      buildDirectory: join(import.meta.dirname, "..", "app-playground"),
      functionGroups,
      overrides: {
        nextjsApi: {
          restApiProps: {
            // there can only be a single apigateway.CfnAccount per AWS environment
            // so cloud watch role should be created independently of each REST API
            // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway-readme.html#deployments
            cloudWatchRole: false, // recommended
            // inherited by every method, the S3 static routes included
            defaultMethodOptions: {
              authorizer,
              authorizationType: AuthorizationType.CUSTOM,
            },
            deployOptions: {
              accessLogDestination: new LogGroupLogDestination(
                new LogGroup(this, "ApiAccessLogs", {
                  retention: RetentionDays.ONE_WEEK,
                  removalPolicy: RemovalPolicy.DESTROY,
                }),
              ),
              accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
              metricsEnabled: true,
            },
          },
        },
        nextjsFunctions: {
          functionProps: {
            // Its e2e job (rgnl-fns) runs on x86, so this deploy covers staging
            // `sharp` for an architecture other than the build host's.
            architecture: Architecture.ARM_64,
            environment: {
              DEBUG: "cdk-nextjs:*",
            },
          },
        },
      },
    });
    new CfnOutput(this, "CdkNextjsUrl", {
      // trailing slash is critical for e2e tests to pass to preserve stage name in path
      value: nextjs.url + "/",
      key: "CdkNextjsUrl",
    });
    this.#explainDenial(nextjs.nextjsApi.api);
  }

  /**
   * Basic auth only for demo app, the API Gateway twin of the regional-containers
   * example's ALB cookie check: security scanners flag a REST API that answers
   * anonymous requests. For real app, use a Cognito authorizer, `AWS_IAM`, or
   * another more secure authentication method.
   */
  #createCookieAuthorizer() {
    const handler = new Function(this, "CookieAuthorizerFn", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "cookie-authorizer")),
      environment: { REQUIRED_COOKIE },
    });
    return new RequestAuthorizer(this, "CookieAuthorizer", {
      handler,
      // a request with no `Cookie` header gets a 401 before the Lambda runs
      identitySources: [IdentitySource.header("Cookie")],
    });
  }

  /** Same message as the regional-containers example's ALB 403 */
  #explainDenial(api: RestApi) {
    api.addGatewayResponse("Unauthorized", {
      type: ResponseType.UNAUTHORIZED,
      statusCode: "401",
      responseHeaders: {
        "WWW-Authenticate": `'Cookie name="cdk-nextjs"'`,
      },
      templates: {
        "application/json": JSON.stringify({
          message: `Access denied. Must set cookie: ${REQUIRED_COOKIE}`,
        }),
      },
    });
  }
}

const stack = new RegionalFunctionsStack(app, getStackName("rgnl-fns"), {
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
});

suppressCommonNags(stack);
suppressLambdaNags(
  stack,
  functionGroups.map((group) => group.name),
);
suppressApiNags(stack);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
