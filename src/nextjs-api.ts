import { join } from "node:path";
import { Annotations, Duration, Size, Stack } from "aws-cdk-lib";
import {
  RestApi,
  LambdaIntegration,
  AwsIntegration,
  MethodOptions,
  IResource,
  EndpointType,
  RestApiProps,
  AwsIntegrationProps,
  LambdaIntegrationOptions,
  PassthroughBehavior,
  ResponseTransferMode,
} from "aws-cdk-lib/aws-apigateway";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaFunctionTarget } from "aws-cdk-lib/aws-events-targets";
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  IRole,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  IFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import {
  NextjsFunctionGroupBehavior,
  PublicDirEntry,
} from "./nextjs-build/nextjs-build";
import { staticAssetsObjectsPattern } from "./nextjs-static-assets";
import {
  API_PATH_PART,
  apiGroupRoutePaths,
  apiParentPaths,
} from "./utils/api-resource-paths";
import { joinPath, normalizeBasePath } from "./utils/base-path";

export interface NextjsApiOverrides {
  readonly restApiProps?: RestApiProps;
  readonly staticIntegrationProps?: AwsIntegrationProps;
  readonly s3MethodOptions?: MethodOptions;
  readonly dynamicIntegrationProps?: LambdaIntegrationOptions;
  /**
   * Props for the function that deploys the stage again after each stack
   * update.
   * @see NextjsApiProps.redeployAfterUpdate
   */
  readonly redeployFunctionProps?: OptionalFunctionProps;
}

export interface NextjsApiProps {
  /**
   * Optional base path for the application
   */
  readonly basePath?: string;
  /**
   * Override props for every construct.
   */
  readonly overrides?: NextjsApiOverrides;
  /**
   * Path to directory of Next.js app's public directory. Used to add resources
   * to API Gateway REST API for public directory to go directly to S3.
   */
  readonly publicDirEntries: PublicDirEntry[];
  /**
   * Required if `NextjsRegionalFunctions`. The Lambda function for server-side rendering
   */
  readonly serverFunction?: IFunction;
  /**
   * The S3 bucket containing static assets
   */
  readonly staticAssetsBucket: IBucket;
  /**
   * S3 key prefix the static assets were uploaded under, i.e.
   * `NextjsStaticAssets.keyPrefix`, which namespaces a shared bucket.
   *
   * Independent of `basePath` above: that one is the URL prefix the REST API
   * serves the app at (commonly the API Gateway stage), while this one is where
   * the objects live in the bucket. `_next/static` and public directory
   * requests are mapped to S3 keys directly, so they 404 unless this prefix is
   * applied.
   */
  readonly staticAssetsKeyPrefix?: string;
  /**
   * The `Service-Worker-Allowed` header for `_next/static/service-worker/*`,
   * which Next.js sends so a compiled service worker can register at a scope
   * wider than its own directory, such as `/`. S3 can't send an arbitrary
   * header, so setting this adds a resource for those files whose integration
   * response does. Next.js uses the app's `basePath`, or `/` for none.
   * @default - no resource; the build has no service worker
   */
  readonly serviceWorkerAllowed?: string;
  /**
   * [Future] Required if `NextjsRegionalContainers`. VPC to create VPC Link and ECS Service Discovery
   */
  readonly vpc?: IVpc;
  /**
   * The non-`default` function groups, the Lambdas
   * {@link functionGroupBehaviors} route to.
   * @default - no splitting; `{proxy+}` serves every dynamic route
   */
  readonly functionGroups?: NextjsApiFunctionGroup[];
  /**
   * `NextjsBuild.functionGroupBehaviors`: each distinct `route` becomes a
   * resource subtree integrated with its group, so the routes each group was
   * packaged with reach it rather than {@link serverFunction}.
   * @default - none
   */
  readonly functionGroupBehaviors?: NextjsFunctionGroupBehavior[];
  /**
   * Deploy the stage again once each stack update has finished, so it serves
   * the API as it is after the update.
   *
   * CloudFormation snapshots the API into a new deployment while resources
   * removed from the template still exist — it deletes them only during
   * cleanup — so the stage keeps serving them. After removing a function
   * group, its routes then point at a deleted Lambda and answer 500 until the
   * next deployment. An EventBridge rule on this stack's `UPDATE_COMPLETE`
   * (and `UPDATE_ROLLBACK_COMPLETE`) invokes a small function that deploys the
   * stage from the live API and deletes the deployments its earlier runs made.
   *
   * Ignored when `overrides.restApiProps.deploy` is `false`: there is no stage.
   * @default true
   */
  readonly redeployAfterUpdate?: boolean;
}

/** A non-default function group and the Lambda its routes must reach. */
export interface NextjsApiFunctionGroup {
  readonly name: string;
  readonly function: IFunction;
}

/**
 * Creates an API Gateway REST API for Next.js applications
 */
export class NextjsApi extends Construct {
  /**
   * The API Gateway REST API
   */
  public readonly api: RestApi;

  /**
   * Public URL of the app, including every path segment the API nests it under.
   * Prefers a custom domain configured through `overrides.restApiProps.domainName`
   * over the execute-api endpoint.
   *
   * A domain attached after this construct is created (`api.addDomainName()`) is
   * still used for the host, but CDK keeps its base path mappings private, so a
   * mapping added that way won't show up here.
   */
  get url(): string {
    const customDomain = this.api.domainName;
    // A custom domain reaches the stage through a base path mapping, so the
    // stage name isn't in the path there; the mapping may be, when set.
    const [origin, prefix] = customDomain
      ? [
          `https://${customDomain.domainName}`,
          this.props.overrides?.restApiProps?.domainName?.basePath,
        ]
      : [
          `https://${this.api.restApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          this.api.deploymentStage.stageName,
        ];
    return joinPath(origin, prefix, this.props.basePath);
  }

  /**
   * Deploys the stage again after each stack update.
   * @see NextjsApiProps.redeployAfterUpdate
   */
  public readonly redeployFunction?: LambdaFunction;
  /**
   * Matches this stack's `UPDATE_COMPLETE` and `UPDATE_ROLLBACK_COMPLETE` and
   * invokes {@link redeployFunction}.
   */
  public readonly redeployRule?: Rule;

  private readonly baseResource: IResource;
  private readonly nextResource: IResource;
  /**
   * Resources created only as parents of a group route that no group's subtree
   * covers, left to the default function. API Gateway answers a request for a
   * resource with no method itself — 403 "Missing Authentication Token" —
   * rather than falling back to a `{proxy+}` higher up, so each needs one.
   * Without it a `/api/reports/**` group turned `/api/reports` and `/api` into
   * 403s.
   */
  private readonly groupParentResources: IResource[] = [];
  private readonly props: NextjsApiProps;
  private staticIntegrationRole: IRole;

  constructor(scope: Construct, id: string, props: NextjsApiProps) {
    super(scope, id);
    this.props = props;

    this.validateProps(props);
    this.api = this.createRestApi();
    this.baseResource = this.createBaseResource(props.basePath);
    this.nextResource = this.baseResource.addResource("_next");
    this.staticIntegrationRole = this.createStaticIntegrationRole();
    this.createStaticIntegrations();
    if (props.serverFunction) {
      // Group resources before the catch-all, so `addResource` sees a clean tree
      // and a group can claim a path the catch-all would otherwise serve.
      this.createFunctionGroupIntegrations();
      // `_next/image` has no resource of its own: it falls through to the
      // `{proxy+}` catch-all, and the server function optimizes in-process.
      this.createDynamicIntegration(props.serverFunction);
    } else if (props.vpc) {
      // [Future] create integration with ECS via VPC Link and ECS Service Discovery
    }
    if (
      props.redeployAfterUpdate !== false &&
      props.overrides?.restApiProps?.deploy !== false
    ) {
      [this.redeployFunction, this.redeployRule] = this.createRedeploy();
    }
  }

  /** @see NextjsApiProps.redeployAfterUpdate */
  private createRedeploy(): [LambdaFunction, Rule] {
    const stack = Stack.of(this);
    const { restApiId } = this.api;
    const { stageName } = this.api.deploymentStage;
    const fn = new LambdaFunction(this, "RedeployFn", {
      // Plain bundled JS with no native dependencies: always arm64.
      architecture: Architecture.ARM_64,
      code: Code.fromAsset(
        join(
          __dirname,
          "../assets/lambdas/redeploy-stage/redeploy-stage.lambda",
        ),
      ),
      handler: "index.handler",
      memorySize: 256,
      runtime: new Runtime("nodejs24.x", RuntimeFamily.NODEJS),
      timeout: Duration.minutes(1),
      ...this.props.overrides?.redeployFunctionProps,
      environment: {
        ...this.props.overrides?.redeployFunctionProps?.environment,
        REST_API_ID: restApiId,
        STAGE_NAME: stageName,
      },
    });
    // API Gateway authorizes its management API by HTTP verb on the resource
    // path; these are the four calls `redeployStage` makes, on this API only.
    const restApi = `arn:${stack.partition}:apigateway:${stack.region}::/restapis/${restApiId}`;
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["apigateway:POST"],
        resources: [`${restApi}/deployments`],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["apigateway:GET"],
        resources: [`${restApi}/deployments`, `${restApi}/stages`],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["apigateway:DELETE"],
        resources: [`${restApi}/deployments/*`],
      }),
    );
    // CloudFormation sends every stack status change to the default event bus
    // ("Monitoring CloudFormation ... events with EventBridge" in the
    // CloudFormation User Guide). `UPDATE_COMPLETE` comes after
    // `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`, so removed resources are gone by
    // then. A rollback restores the stage to the pre-update deployment, which
    // can carry the same staleness from an earlier update, so it redeploys too.
    const rule = new Rule(this, "RedeployRule", {
      description: `Redeploys ${stack.stackName}'s REST API stage after a stack update`,
      eventPattern: {
        source: ["aws.cloudformation"],
        detailType: ["CloudFormation Stack Status Change"],
        detail: {
          "stack-id": [stack.stackId],
          "status-details": {
            status: ["UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"],
          },
        },
      },
      targets: [new LambdaFunctionTarget(fn, { retryAttempts: 2 })],
    });
    return [fn, rule];
  }

  private validateProps(props: NextjsApiProps) {
    if (!props.serverFunction && !props.vpc) {
      throw new Error("serverFunction or vpc must be set in NextjsApiProps");
    }
  }

  private createRestApi(): RestApi {
    return new RestApi(this, "RestApi", {
      binaryMediaTypes: ["*/*"],
      description: `cdk-nextjs REST API for ${Stack.of(this).stackName}`,
      endpointTypes: [EndpointType.REGIONAL],
      // Inert for the dynamic routes: API Gateway does not compress a response it
      // streams (`ResponseTransferMode.STREAM`), which every Lambda integration
      // here uses, so the runtime gzips those itself. Kept because it still
      // applies to the buffered S3 static integrations, and because a consumer
      // who overrides an integration to BUFFERED gets compression back.
      minCompressionSize: Size.bytes(0),
      ...this.props.overrides?.restApiProps,
    });
  }

  /**
   * Create base resource path if needed. Important if `basePath` is set.
   *
   * A nested `basePath` ("/team/app") has to become one resource per segment:
   * API Gateway path parts can't contain "/", so passing the whole thing to a
   * single `addResource` fails validation at synth. `resolveBasePath` accepts
   * nested values, so this is reachable.
   */
  private createBaseResource(basePath?: string): IResource {
    // Create base resource path if needed
    const normalized = normalizeBasePath(basePath);
    if (!normalized) {
      return this.api.root;
    }
    return normalized
      .split("/")
      .reduce<IResource>(
        (parent, segment) => parent.addResource(segment),
        this.api.root,
      );
  }

  private createStaticIntegrationRole() {
    // Create S3 integration role
    const staticIntegrationRole = new Role(this, "StaticIntegrationRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
    });

    // Only this app's own objects: a shared bucket holds other apps' assets
    // under their own prefixes. `s3:ListBucket` makes a missing key a 404 (the
    // only error the integration maps) rather than a 403. It stays unconditioned:
    // S3 checks it during a GetObject, where no `s3:prefix` is present, so a
    // prefix condition would turn every missing key back into a 403.
    staticIntegrationRole.addToPolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          `${this.props.staticAssetsBucket.bucketArn}/${staticAssetsObjectsPattern(this.props.staticAssetsKeyPrefix)}`,
        ],
      }),
    );
    staticIntegrationRole.addToPolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [this.props.staticAssetsBucket.bucketArn],
      }),
    );
    return staticIntegrationRole;
  }

  private createStaticIntegrations() {
    const staticResource = this.nextResource.addResource("static");
    staticResource
      .addResource("{proxy+}")
      .addMethod(
        "GET",
        this.createS3Integration({ key: this.s3Key("_next/static/{key}") }),
        this.getStaticMethodOptions({ proxy: true }),
      );
    const { serviceWorkerAllowed } = this.props;
    if (serviceWorkerAllowed !== undefined) {
      // A literal segment beats `{proxy+}`, so service workers get the one
      // header S3 can't send, and the rest of `_next/static` is unaffected.
      const headers = { "Service-Worker-Allowed": serviceWorkerAllowed };
      staticResource
        .addResource("service-worker")
        .addResource("{proxy+}")
        .addMethod(
          "GET",
          this.createS3Integration({
            key: this.s3Key("_next/static/service-worker/{key}"),
            headers,
          }),
          this.getStaticMethodOptions({ proxy: true, headers }),
        );
    }
    // add public directory files/directories that exist at top level but need to go to S3.
    const unroutable: string[] = [];
    for (const publicDirEntry of this.props.publicDirEntries) {
      // A space or a non-ASCII character is legal in `public/` and illegal in an
      // API Gateway resource path part, and `addResource` throws — which took the
      // whole synth down for an app that deploys fine on the Global types
      // (`next-image-legacy/unicode`, whose `public/` holds "hello world.jpg").
      // Warn and skip the one entry instead: that asset 404s, the app deploys.
      if (!API_PATH_PART.test(publicDirEntry.name)) {
        unroutable.push(`"${publicDirEntry.name}"`);
        continue;
      }
      if (publicDirEntry.isDirectory) {
        this.baseResource
          .addResource(publicDirEntry.name)
          .addResource("{proxy+}")
          .addMethod(
            "GET",
            this.createS3Integration({
              key: this.s3Key(`${publicDirEntry.name}/{key}`),
            }),
            this.getStaticMethodOptions({ proxy: true }),
          );
      } else {
        this.baseResource
          .addResource(publicDirEntry.name)
          .addMethod(
            "GET",
            this.createS3Integration({ key: this.s3Key(publicDirEntry.name) }),
            this.getStaticMethodOptions(),
          );
      }
    }
    if (unroutable.length > 0) {
      Annotations.of(this).addWarning(
        `${LOG_PREFIX} An API Gateway resource path part only allows ` +
          "[a-zA-Z0-9:._-$], so these top-level public/ entries get no resource of " +
          "their own; their requests reach the server function, which reads them " +
          `from S3 instead: ${unroutable.join(", ")}. To serve them directly, rename them, move them into a ` +
          "public/ subdirectory whose own name is expressible, or use " +
          "NextjsGlobalFunctions or NextjsGlobalContainers, whose CloudFront " +
          "behaviors can match them.",
      );
    }
  }

  /**
   * Prefixes a request path with the key prefix the assets were uploaded under,
   * since the S3 integrations address objects by key rather than by URL.
   */
  private s3Key(key: string): string {
    return joinPath(this.props.staticAssetsKeyPrefix, key);
  }

  /**
   * Maps API request to S3 request.
   * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-parameter-mapping-sources.html
   * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/integrating-api-with-aws-services-s3.html#api-items-in-folder-as-s3-objects-in-bucket
   * @param headers fixed response headers, sent with a 200 and a 304
   */
  private createS3Integration({
    key,
    headers = {},
  }: {
    key: string;
    headers?: Record<string, string>;
  }) {
    // A static value is a single-quoted literal in a mapping expression.
    const fixedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        `method.response.header.${name}`,
        `'${value}'`,
      ]),
    );
    const props: AwsIntegrationProps = {
      service: "s3",
      integrationHttpMethod: "GET",
      path: `${this.props.staticAssetsBucket.bucketName}/${key}`,
      options: {
        credentialsRole: this.staticIntegrationRole,
        passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES, // recommended
        requestParameters: {
          // Without this S3 never sees the conditional request, so every
          // revalidation of an immutable `_next/static` chunk re-downloads it
          // with a 200 instead of getting a 304.
          "integration.request.header.If-None-Match":
            "method.request.header.If-None-Match",
          "integration.request.header.If-Modified-Since":
            "method.request.header.If-Modified-Since",
          ...(key.includes("{key}")
            ? {
                "integration.request.path.key": "method.request.path.proxy",
              }
            : {}),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Content-Type":
                "integration.response.header.Content-Type",
              "method.response.header.Content-Length":
                "integration.response.header.Content-Length",
              "method.response.header.Cache-Control":
                "integration.response.header.Cache-Control",
              "method.response.header.ETag": "integration.response.header.ETag",
              "method.response.header.Last-Modified":
                "integration.response.header.Last-Modified",
            },
          },
          {
            // A 304 carries no body, and `ETag` is the header a client needs
            // back to keep revalidating.
            statusCode: "304",
            selectionPattern: "304",
            responseParameters: {
              "method.response.header.Cache-Control":
                "integration.response.header.Cache-Control",
              "method.response.header.ETag": "integration.response.header.ETag",
              "method.response.header.Last-Modified":
                "integration.response.header.Last-Modified",
            },
          },
          {
            statusCode: "404",
            selectionPattern: "404",
          },
        ],
      },
      ...this.props.overrides?.staticIntegrationProps,
    };
    // Added after the override, which replaces `options` whole, so the
    // headers survive one that sets its own integration responses.
    return new AwsIntegration({
      ...props,
      options: props.options && {
        ...props.options,
        integrationResponses: withFixedHeaders(
          props.options.integrationResponses,
          fixedHeaders,
        ),
      },
    });
  }

  /** @param headers the fixed headers `createS3Integration` was given */
  private getStaticMethodOptions({
    proxy = false,
    headers = {},
  }: {
    proxy?: boolean;
    headers?: Record<string, string>;
  } = {}): MethodOptions {
    const fixedHeaders = Object.fromEntries(
      Object.keys(headers).map((name) => [
        `method.response.header.${name}`,
        true,
      ]),
    );
    const options: MethodOptions = {
      requestParameters: {
        // Declared optional (`false`): a plain GET carries neither, and
        // requiring them would 400 it.
        "method.request.header.If-None-Match": false,
        "method.request.header.If-Modified-Since": false,
        ...(proxy ? { "method.request.path.proxy": true } : {}),
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Content-Type": true,
            "method.response.header.Content-Length": true,
            "method.response.header.Cache-Control": true,
            "method.response.header.ETag": true,
            "method.response.header.Last-Modified": true,
          },
        },
        {
          statusCode: "304",
          responseParameters: {
            "method.response.header.Cache-Control": true,
            "method.response.header.ETag": true,
            "method.response.header.Last-Modified": true,
          },
        },
        {
          statusCode: "404",
        },
      ],
      ...this.props.overrides?.s3MethodOptions,
    };
    // After the override, as in `createS3Integration`: API Gateway rejects an
    // integration response mapping a header its method response doesn't
    // declare, so the two have to survive an override together.
    return {
      ...options,
      methodResponses: withFixedHeaders(options.methodResponses, fixedHeaders),
    };
  }

  /**
   * One resource subtree per function group pattern.
   *
   * Unlike CloudFront this needs no ordering: API Gateway matches on a resource
   * *tree*, so `/api/reports/{proxy+}` beats `/api/{proxy+}` beats `/{proxy+}`
   * structurally, and "longest pattern wins" comes for free. What does need care
   * is not creating the same path twice — two groups under `/api` share the `api`
   * resource — so every segment goes through {@link resourceFor}.
   */
  private createFunctionGroupIntegrations() {
    const groups = this.props.functionGroups ?? [];
    const routePaths = apiGroupRoutePaths(
      groups,
      this.props.functionGroupBehaviors ?? [],
      this.props.publicDirEntries,
    );
    // A parent that already exists (`_next`, a `public/` entry's) keeps the
    // methods it has: only the ones created for group routes need one.
    const parentPaths = apiParentPaths(routePaths).filter(
      ({ path }) => !this.hasResource(path),
    );
    const integrations = new Map(
      groups.map((group) => [
        group.name,
        new LambdaIntegration(group.function, {
          responseTransferMode: ResponseTransferMode.STREAM,
          // One API-wide permission per function; see `createDynamicIntegration`.
          scopePermissionToMethod: false,
          ...this.props.overrides?.dynamicIntegrationProps,
        }),
      ]),
    );
    for (const { path, owner } of routePaths) {
      this.resourceFor(path).addMethod("ANY", integrations.get(owner)!);
    }
    for (const { path, owner } of parentPaths) {
      const resource = this.resourceFor(path);
      if (owner === undefined) {
        this.groupParentResources.push(resource);
      } else {
        resource.addMethod("ANY", integrations.get(owner)!);
      }
    }
  }

  /** Whether a resource path already exists. */
  private hasResource(segments: string[]): boolean {
    let resource: IResource | undefined = this.baseResource;
    for (const segment of segments) {
      resource = resource.getResource(segment);
      if (!resource) {
        return false;
      }
    }
    return true;
  }

  /** Walk or create a resource path, reusing whatever already exists. */
  private resourceFor(segments: string[]): IResource {
    return segments.reduce<IResource>(
      (parent, segment) =>
        parent.getResource(segment) ?? parent.addResource(segment),
      this.baseResource,
    );
  }

  /**
   * Create Lambda Proxy integration for all other routes
   */
  private createDynamicIntegration(serverFunction: IFunction) {
    // All other routes use streaming for better performance.
    //
    // `scopePermissionToMethod: false` grants the function one permission for
    // this API's execute-api ARN (`<api>/*/*/*`) instead of two per method (the
    // method and its console test-invoke). Every group adds resources that the
    // default function still answers for its parents and data routes, and at
    // ~350 bytes a statement the per-method policy outgrows Lambda's 20 KB
    // resource-policy cap after a few dozen `ANY` methods, failing the deploy.
    const streamingIntegration = new LambdaIntegration(serverFunction, {
      responseTransferMode: ResponseTransferMode.STREAM,
      scopePermissionToMethod: false,
      ...this.props.overrides?.dynamicIntegrationProps,
    });

    // Add catch-all routes with streaming integration for server-side rendering
    this.baseResource.addMethod("ANY", streamingIntegration);
    for (const resource of this.groupParentResources) {
      resource.addMethod("ANY", streamingIntegration);
    }
    const proxyResource = this.baseResource.addResource("{proxy+}");
    proxyResource.addMethod("ANY", streamingIntegration);
  }
}

/**
 * `responses` with `parameters` added to the 200 and the 304, the responses a
 * fixed header goes out with.
 */
function withFixedHeaders<
  T extends {
    readonly statusCode: string;
    readonly responseParameters?: { [key: string]: V };
  },
  V,
>(
  responses: T[] | undefined,
  parameters: { [key: string]: V },
): T[] | undefined {
  if (!Object.keys(parameters).length) {
    return responses;
  }
  return responses?.map((response) =>
    ["200", "304"].includes(response.statusCode)
      ? {
          ...response,
          responseParameters: { ...response.responseParameters, ...parameters },
        }
      : response,
  );
}
